import {
	formatStockId,
	STOCK_DIRECTORY_SOURCES,
	type StockDirectoryEntry,
	type StockDirectoryMarketStatus,
	type StockDirectoryRefreshRequest,
	type StockDirectoryRefreshResponse,
	type StockDirectorySearchQuery,
	type StockDirectorySearchResponse,
	type StockDirectoryStatusResponse,
	type WatchMarket,
} from "@research/contracts";
import { EMPTY_USAGE, ok, stockSearchHaystack, stockSearchKeys } from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AuditLog,
	Clock,
	IdGenerator,
	JobRecord,
	JobRepository,
	RateLimiter,
	StockDirectoryMeta,
	StockDirectoryRepository,
	StockDirectoryRow,
	WatchlistRepository,
} from "./ports.ts";
import { JOB_ADMISSION, MAX_JOB_ATTEMPTS } from "./researchRuns.ts";

/** The job kind that downloads one market's list (ADR-0033). */
const KIND = "stock-directory-refresh";

/** Status is reported US first, then JP (`stockDirectoryStatusResponseSchema`). */
const MARKETS: readonly WatchMarket[] = ["US", "JP"];

/**
 * The rows a `stock-directory-refreshed` completion stores: each entry with
 * its folded search keys, computed here — in TypeScript, with the domain's
 * own fold — so the SQL ranking compares exactly the keys
 * `rankStockSearch` computes (ADR-0033 section 6).
 */
export function stockDirectoryRows(
	market: WatchMarket,
	entries: readonly StockDirectoryEntry[],
): StockDirectoryRow[] {
	return entries.map((entry) => {
		const row = {
			market,
			symbol: entry.symbol,
			name: entry.name,
			localName: entry.localName ?? null,
			listing: entry.listing,
		};
		const keys = stockSearchKeys(row);
		return { ...row, ...keys, searchKey: stockSearchHaystack(keys) };
	});
}

/**
 * The per-market idempotency key of one refresh request. One request queues
 * up to one job per market while the jobs table holds one key per job, so
 * each market's job is stored under the request key plus its market. The
 * separator is outside the key alphabet (`[A-Za-z0-9_-]`), so a derived key
 * can never equal a key a client sent.
 */
function marketIdempotencyKey(idempotencyKey: string, market: WatchMarket): string {
	return `${idempotencyKey}:${market}`;
}

/**
 * The fingerprint names the whole requested market set, order-free: the same
 * key sent again with a different set is a reused key, not a replay.
 */
function refreshFingerprint(markets: readonly WatchMarket[]): string {
	return `${KIND}:${[...markets].sort().join(",")}`;
}

export interface StockDirectoryServiceDeps {
	readonly stockDirectory: StockDirectoryRepository;
	readonly watchlist: Pick<WatchlistRepository, "listStocks">;
	readonly jobs: JobRepository;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly rateLimiter: RateLimiter;
	readonly audit: AuditLog;
}

export function createStockDirectoryService(deps: StockDirectoryServiceDeps) {
	async function marketStatus(
		ownerId: string,
		market: WatchMarket,
		meta: StockDirectoryMeta | undefined,
	): Promise<StockDirectoryMarketStatus> {
		const [active, failure] = await Promise.all([
			deps.jobs.findActiveByKind(ownerId, KIND, { market }),
			deps.jobs.findLatestFailureByKind(ownerId, KIND, { market }),
		]);
		const source = STOCK_DIRECTORY_SOURCES[market];
		return {
			market,
			sourceId: source.sourceId,
			publisher: source.publisher,
			sourceUrl: source.sourceUrl,
			entryCount: meta?.entryCount ?? 0,
			asOf: meta?.asOf ?? null,
			retrievedAt: meta?.retrievedAt ?? null,
			activeRunId: active?.runId ?? null,
			activeRunState: active?.state ?? null,
			// Same meaning as the watchlist's refresh line: the newest run
			// that ended without success, with its stable code. A cancelled
			// run carries no code and is not reported as a failure.
			lastFailure:
				failure === null || failure.failureCode === null
					? null
					: { state: failure.state, code: failure.failureCode, at: failure.at },
		};
	}

	function newJob(ownerId: string, market: WatchMarket): JobRecord {
		const now = deps.clock.nowIso();
		return {
			kind: KIND,
			request: { market },
			workspaceId: null,
			retryOfRunId: null,
			contextAnchorSeq: null,
			runId: deps.ids.newId("run"),
			ownerId,
			state: "pending",
			usage: { ...EMPTY_USAGE },
			attempt: 0,
			maxAttempts: MAX_JOB_ATTEMPTS,
			leaseGeneration: 0,
			leaseOwnerId: null,
			leaseExpiresAt: null,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			approvalRequest: null,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 0,
			createdAt: now,
			updatedAt: now,
		};
	}

	const keyReused = (): UseCaseResult<never> =>
		fail(
			"IDEMPOTENCY_KEY_REUSED",
			"This idempotency key was already used for a different request.",
		);

	/**
	 * One market's run: the active run of that market when there is one (no
	 * second job), the stored run of a replayed key, else a new job.
	 */
	async function queueMarket(
		ownerId: string,
		market: WatchMarket,
		idempotencyKey: string,
		requestFingerprint: string,
	): Promise<UseCaseResult<string>> {
		const active = await deps.jobs.findActiveByKind(ownerId, KIND, { market });
		if (active !== null) return ok(active.runId);
		const key = marketIdempotencyKey(idempotencyKey, market);
		// A replay is answered before admission control: it is not a new
		// request, so it neither hits a cap nor spends the hourly allowance.
		const existing = await deps.jobs.findByIdempotencyKey(ownerId, key);
		if (existing !== null) {
			return existing.requestFingerprint === requestFingerprint
				? ok(existing.job.runId)
				: keyReused();
		}
		const allowed = await deps.rateLimiter.consume({
			ownerId,
			bucket: "job-create",
			limit: JOB_ADMISSION.jobsPerHour,
			windowMs: JOB_ADMISSION.windowMs,
			nowMs: deps.clock.nowMs(),
		});
		if (!allowed) return fail("RATE_LIMITED", "Too many runs were started; try again later.");
		const job = newJob(ownerId, market);
		const outcome = await deps.jobs.insert(
			job,
			key,
			requestFingerprint,
			JOB_ADMISSION.maxUnfinishedJobs,
		);
		if (outcome.kind === "at-capacity") {
			return fail(
				"RATE_LIMITED",
				`At most ${JOB_ADMISSION.maxUnfinishedJobs} unfinished runs are allowed.`,
			);
		}
		if (outcome.kind === "no-workspace") return fail("INTERNAL", "Internal error.");
		// The INSERT itself refused a second active run of this market (a
		// concurrent request won the race): answer with the winner's run.
		if (outcome.kind === "kind-active") return ok(outcome.job.runId);
		if (outcome.kind === "existing") {
			return outcome.sameRequest ? ok(outcome.job.runId) : keyReused();
		}
		await deps.audit.record({
			ownerId,
			actor: "owner",
			action: "run.create_stock_directory_refresh",
			resource: job.runId,
			detail: `kind=${KIND} market=${market}`,
			at: job.createdAt,
		});
		return ok(job.runId);
	}

	return {
		/** Each market's stored list and refresh state, US then JP. */
		async getStatus(ownerId: string): Promise<UseCaseResult<StockDirectoryStatusResponse>> {
			const metas = await deps.stockDirectory.listMeta(ownerId);
			const byMarket = new Map(metas.map((meta) => [meta.market, meta]));
			const markets = await Promise.all(
				MARKETS.map((market) => marketStatus(ownerId, market, byMarket.get(market))),
			);
			return ok({ markets });
		},

		/**
		 * Ranked hits (ADR-0033 section 6) from the stored lists; each hit says
		 * whether the stock is already on the owner's watchlist.
		 */
		async search(
			ownerId: string,
			query: StockDirectorySearchQuery,
		): Promise<UseCaseResult<StockDirectorySearchResponse>> {
			const [entries, stocks] = await Promise.all([
				deps.stockDirectory.search(ownerId, {
					text: query.q,
					market: query.market ?? null,
					limit: query.limit,
				}),
				deps.watchlist.listStocks(ownerId),
			]);
			const registered = new Set(stocks.map((stock) => stock.stockId));
			return ok({
				hits: entries.map((entry) => {
					const stockId = formatStockId(entry.market, entry.symbol);
					return {
						stockId,
						market: entry.market,
						symbol: entry.symbol,
						name: entry.name,
						localName: entry.localName,
						listing: entry.listing,
						registered: registered.has(stockId),
					};
				}),
			});
		},

		/**
		 * Queues one `stock-directory-refresh` run per requested market,
		 * reusing a market's already-active run instead of queueing a second.
		 * Markets are queued in the requested order; when one is refused (rate
		 * limit, capacity, reused key) the error is returned and runs already
		 * queued for earlier markets stay queued — a resend with the same key
		 * replays them and retries the rest.
		 */
		async queueRefresh(
			ownerId: string,
			request: StockDirectoryRefreshRequest,
			idempotencyKey: string,
		): Promise<UseCaseResult<StockDirectoryRefreshResponse>> {
			const fingerprint = refreshFingerprint(request.markets);
			const runs: { market: WatchMarket; runId: string }[] = [];
			for (const market of request.markets) {
				const queued = await queueMarket(ownerId, market, idempotencyKey, fingerprint);
				if (!queued.ok) return queued;
				runs.push({ market, runId: queued.value });
			}
			return ok({ runs });
		},
	};
}

export type StockDirectoryService = ReturnType<typeof createStockDirectoryService>;
