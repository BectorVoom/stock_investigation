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
import {
	EMPTY_USAGE,
	ok,
	STOCK_SEARCH_FOLD_VERSION,
	stockSearchHaystack,
	stockSearchKeys,
} from "@research/domain";
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
	StoredStockDirectoryEntry,
	WatchlistRepository,
} from "./ports.ts";
import { JOB_ADMISSION, MAX_JOB_ATTEMPTS } from "./researchRuns.ts";

/** The job kind that downloads one market's list (ADR-0034). */
const KIND = "stock-directory-refresh";

/** Status is reported US first, then JP (`stockDirectoryStatusResponseSchema`). */
const MARKETS: readonly WatchMarket[] = ["US", "JP"];

/**
 * One stored row with its folded search keys, computed here — in
 * TypeScript, with the domain's own fold — so the SQL ranking compares
 * exactly the keys `rankStockSearch` computes (ADR-0034 section 6).
 */
export function keyedStockDirectoryRow(entry: StoredStockDirectoryEntry): StockDirectoryRow {
	const keys = stockSearchKeys(entry);
	return { ...entry, ...keys, searchKey: stockSearchHaystack(keys) };
}

/** The rows a `stock-directory-refreshed` completion stores, keyed. */
export function stockDirectoryRows(
	market: WatchMarket,
	entries: readonly StockDirectoryEntry[],
): StockDirectoryRow[] {
	return entries.map((entry) =>
		keyedStockDirectoryRow({
			market,
			symbol: entry.symbol,
			name: entry.name,
			localName: entry.localName ?? null,
			listing: entry.listing,
		}),
	);
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

/** What one market of a refresh request resolves to before anything is written. */
type MarketPlan =
	| { readonly market: WatchMarket; readonly runId: string }
	| { readonly market: WatchMarket; readonly job: JobRecord };

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
	/**
	 * One market's status. The SERVER decides which failure is current,
	 * from its own job times (`updated_at` of the terminal job write, never
	 * the runner's `fetchedAt`): the newest `failed` run of the market is
	 * reported only when no run of that market completed after it. A
	 * cancelled run is the owner's choice, not a failure — it is never
	 * reported and never hides an older failure.
	 */
	async function marketStatus(
		ownerId: string,
		market: WatchMarket,
		meta: StockDirectoryMeta | undefined,
	): Promise<StockDirectoryMarketStatus> {
		const scope = { market };
		const [active, failed, succeededAt] = await Promise.all([
			deps.jobs.findActiveByKind(ownerId, KIND, scope),
			deps.jobs.findLatestFailedByKind(ownerId, KIND, scope),
			deps.jobs.findLatestSuccessAtByKind(ownerId, KIND, scope),
		]);
		// ISO-8601 UTC strings from one clock order lexically; at an equal
		// instant the success wins (the list on disk is the good one).
		const current =
			failed !== null &&
			failed.failureCode !== null &&
			(succeededAt === null || failed.at > succeededAt)
				? { state: "failed", code: failed.failureCode, at: failed.at }
				: null;
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
			lastFailure: current,
		};
	}

	/**
	 * Re-keys one market whose stored keys were computed with another fold
	 * version: reads its rows, recomputes every key with the current fold
	 * and stores them with the new version, before the search reads them.
	 */
	async function rekey(ownerId: string, meta: StockDirectoryMeta): Promise<void> {
		const entries = await deps.stockDirectory.listEntries(ownerId, meta.market);
		await deps.stockDirectory.storeKeys(ownerId, {
			market: meta.market,
			rows: entries.map(keyedStockDirectoryRow),
			fromVersion: meta.foldVersion,
			toVersion: STOCK_SEARCH_FOLD_VERSION,
		});
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
			failureUpstreamStatus: null,
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

	const rateLimited = (): UseCaseResult<never> =>
		fail("RATE_LIMITED", "Too many runs were started; try again later.");

	const atCapacity = (): UseCaseResult<never> =>
		fail("RATE_LIMITED", `At most ${JOB_ADMISSION.maxUnfinishedJobs} unfinished runs are allowed.`);

	/**
	 * Resolves every requested market without writing: a replayed key
	 * answers its stored run, an active run of the market is reused, and
	 * only the rest need a new job. The key is checked for EVERY market
	 * first — whatever runs are active — so the same key with a different
	 * market set is refused even while a run of one of them is going.
	 */
	async function planRefresh(
		ownerId: string,
		markets: readonly WatchMarket[],
		idempotencyKey: string,
		fingerprint: string,
	): Promise<UseCaseResult<readonly MarketPlan[]>> {
		const stored = await Promise.all(
			MARKETS.map(async (market) => ({
				market,
				existing: await deps.jobs.findByIdempotencyKey(
					ownerId,
					marketIdempotencyKey(idempotencyKey, market),
				),
			})),
		);
		const replayed = new Map<WatchMarket, string>();
		for (const { market, existing } of stored) {
			if (existing === null) continue;
			if (existing.requestFingerprint !== fingerprint) return keyReused();
			replayed.set(market, existing.job.runId);
		}
		const plans: MarketPlan[] = [];
		for (const market of markets) {
			const replay = replayed.get(market);
			if (replay !== undefined) {
				plans.push({ market, runId: replay });
				continue;
			}
			const active = await deps.jobs.findActiveByKind(ownerId, KIND, { market });
			plans.push(
				active !== null
					? { market, runId: active.runId }
					: { market, job: newJob(ownerId, market) },
			);
		}
		return ok(plans);
	}

	/**
	 * Admission for every new job before any is written, so a refused
	 * request queues nothing: the unfinished-run cap must hold all of them,
	 * and the hourly allowance must admit each (a refusal mid-way leaves the
	 * allowance spent by the earlier ones, like any refused request).
	 */
	async function admit(ownerId: string, count: number): Promise<UseCaseResult<void>> {
		if (count === 0) return ok(undefined);
		const unfinished = await deps.jobs.countUnfinished(ownerId);
		if (unfinished + count > JOB_ADMISSION.maxUnfinishedJobs) return atCapacity();
		for (let index = 0; index < count; index += 1) {
			const allowed = await deps.rateLimiter.consume({
				ownerId,
				bucket: "job-create",
				limit: JOB_ADMISSION.jobsPerHour,
				windowMs: JOB_ADMISSION.windowMs,
				nowMs: deps.clock.nowMs(),
			});
			if (!allowed) return rateLimited();
		}
		return ok(undefined);
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
		 * Ranked hits (ADR-0034 section 6) from the stored lists; each hit says
		 * whether the stock is already on the owner's watchlist. A searched
		 * market whose keys were stored under another fold version is
		 * re-keyed first, so a changed fold never searches stale keys.
		 */
		async search(
			ownerId: string,
			query: StockDirectorySearchQuery,
		): Promise<UseCaseResult<StockDirectorySearchResponse>> {
			const metas = await deps.stockDirectory.listMeta(ownerId);
			for (const meta of metas) {
				const searched = query.market === undefined || query.market === meta.market;
				if (searched && meta.foldVersion !== STOCK_SEARCH_FOLD_VERSION) await rekey(ownerId, meta);
			}
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
		 * answering a market's already-active run instead of queueing a
		 * second. ALL OR NOTHING: the key, every market's plan and the
		 * admission for every new job are decided before the first job is
		 * written, so a refused request (reused key, rate limit, unfinished-run
		 * cap) queues no market. The one exception is a concurrent request
		 * that fills the cap between the check and the writes: the atomic
		 * INSERT then refuses, and markets already written stay queued — a
		 * resend with the same key replays them.
		 */
		async queueRefresh(
			ownerId: string,
			request: StockDirectoryRefreshRequest,
			idempotencyKey: string,
		): Promise<UseCaseResult<StockDirectoryRefreshResponse>> {
			const fingerprint = refreshFingerprint(request.markets);
			const planned = await planRefresh(ownerId, request.markets, idempotencyKey, fingerprint);
			if (!planned.ok) return planned;
			const fresh = planned.value.filter((plan) => "job" in plan).length;
			const admitted = await admit(ownerId, fresh);
			if (!admitted.ok) return admitted;
			const runs: { market: WatchMarket; runId: string }[] = [];
			for (const plan of planned.value) {
				if (!("job" in plan)) {
					runs.push({ market: plan.market, runId: plan.runId });
					continue;
				}
				const { job, market } = plan;
				const outcome = await deps.jobs.insert(
					job,
					marketIdempotencyKey(idempotencyKey, market),
					fingerprint,
					JOB_ADMISSION.maxUnfinishedJobs,
				);
				if (outcome.kind === "at-capacity") return atCapacity();
				if (outcome.kind === "no-workspace") return fail("INTERNAL", "Internal error.");
				if (outcome.kind === "existing" && !outcome.sameRequest) return keyReused();
				// A concurrent request won the race (it holds this key, or
				// the market's active run): answer with its run.
				if (outcome.kind === "existing" || outcome.kind === "kind-active") {
					runs.push({ market, runId: outcome.job.runId });
					continue;
				}
				await deps.audit.record({
					ownerId,
					actor: "owner",
					action: "run.create_stock_directory_refresh",
					resource: job.runId,
					detail: `kind=${KIND} market=${market}`,
					at: job.createdAt,
				});
				runs.push({ market, runId: job.runId });
			}
			return ok({ runs });
		},
	};
}

export type StockDirectoryService = ReturnType<typeof createStockDirectoryService>;
