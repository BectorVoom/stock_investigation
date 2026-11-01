import {
	DEFAULT_HOME_DASHBOARD,
	EARNINGS_LIMITS,
	type HomeDashboard,
	type JobKind,
	type MarketUnavailableCode,
	type RefreshScope,
	STOCK_DIRECTORY_LIMITS,
	type WatchMarket,
} from "@research/contracts";
import {
	decideSync,
	EARNINGS_SYNC_INTERVAL_MS,
	EMPTY_USAGE,
	marketSyncIntervalMs,
	SYNC_MIN_GAP_MS,
	SYNC_RETRY_MS,
	type SyncCadence,
	type SyncDecision,
	type SyncJob,
	type SyncState,
} from "@research/domain";
import { assembleDesiredEvents, googleFingerprint } from "./googleCalendar.ts";
import { type OwnerSeries, type OwnerSeriesDeps, ownerSeries } from "./pageSeries.ts";
import type {
	AuditLog,
	Clock,
	EarningsRepository,
	GoogleCalendarRepository,
	Hasher,
	HomeDashboardRepository,
	IdGenerator,
	JobKindScope,
	JobRecord,
	JobRepository,
	LatestJobOfKind,
	MarketRepository,
	MarketSeriesRefreshState,
	SourceRepository,
	StockDirectoryRepository,
	StockPriceRepository,
	StoredWatchlistStock,
	WatchlistRepository,
} from "./ports.ts";
import {
	earningsStockNeedsRefresh,
	refreshFingerprint,
	refreshScopeRequest,
	type ScopedRefreshKind,
} from "./refreshScope.ts";
import { JOB_ADMISSION, MAX_JOB_ATTEMPTS } from "./researchRuns.ts";
import { planHasWork, planStockPrices, STOCK_PRICE_MARKETS } from "./stockPrices.ts";

/**
 * Server-side synchronisation (ADR-0051, ADR-0054, ADR-0058): market data,
 * earnings dates, the market stock lists, every directory stock's daily
 * prices, the Google Calendar and the news feeds.
 *
 * No page asks for a sync. Each time a runner asks for work, the claim
 * calls `materializeDue` before it scans for jobs: for each kind it reads
 * the stored stamps and the last jobs, lets the pure `decideSync`
 * (Lean-verified, `formal/ResearchFormal/SyncSchedule.lean`) decide, and
 * queues at most one job of the kind (one per market for the stock lists
 * and the stock prices)
 * — which the same claim can hand out. The claim, the runner and the
 * completions are unchanged: each job is the one the removed owner
 * endpoints queued. The financial statements have their own claim-time
 * scheduler (`equitySync.ts`).
 */

/**
 * Stored answers that mean the provider will not serve the series on the
 * configured plan (a Japanese listing on Twelve Data's free plan): such a
 * series is not retried by a narrow job (ADR-0040 §4); a full sync still
 * asks.
 */
const PROVIDER_REFUSED_CODES: ReadonlySet<MarketUnavailableCode> = new Set([
	"SERIES_NOT_FOUND",
	"PLAN_NOT_ENTITLED",
]);

/** A series never refreshed. */
function seriesNeverRefreshed(series: MarketSeriesRefreshState | undefined): boolean {
	return series === undefined || series.lastRefreshedAt === null;
}

/** A refreshed series that holds no data although the provider may serve it. */
function seriesRetryable(series: MarketSeriesRefreshState | undefined): boolean {
	return (
		series !== undefined &&
		series.lastRefreshedAt !== null &&
		series.latestObservedOn === null &&
		!(series.unavailableCode !== null && PROVIDER_REFUSED_CODES.has(series.unavailableCode))
	);
}

/**
 * Whether a narrow (`"unrefreshed"`) market job fetches the series: never
 * refreshed, or refreshed without data the provider may still serve
 * (ADR-0039). The claim and the schedule share this one rule.
 */
export function marketSeriesNeedsRefresh(series: MarketSeriesRefreshState | undefined): boolean {
	return seriesNeverRefreshed(series) || seriesRetryable(series);
}

/** Imported materials are served by the database and never fetched (ADR-0042). */
export function fetchedSeriesIds(tracked: readonly string[]): string[] {
	return tracked.filter((seriesId) => !seriesId.startsWith("materials:"));
}

export interface OwnerTrackedSeriesDeps extends OwnerSeriesDeps {
	readonly homeDashboard: Pick<HomeDashboardRepository, "get">;
	readonly stockPrices: Pick<StockPriceRepository, "usDirectorySeriesIds">;
}

/** A Japanese listing's price series (`twelve-data:<code>:JPX`): J-Quants', never Twelve Data's. */
function isJpStockSeries(seriesId: string): boolean {
	return seriesId.startsWith("twelve-data:") && seriesId.endsWith(":JPX");
}

/**
 * Every series the owner's pages track (Home first, then the notebooks),
 * without the directory stocks' price series — a `:JPX` id, or a US
 * symbol of the US directory (one batched lookup): their bars come from
 * `stock-prices-sync`, so Twelve Data no longer fetches them (ADR-0058 §2).
 * `tracked` is what a market-refresh claim fetches; `keep` is unchanged.
 * An unreadable stored dashboard tracks the defaults (like an absent one):
 * the sync keeps working while the app shows the error state with its reset
 * way out (V2). It is never silently replaced here.
 */
export async function ownerTrackedSeries(
	deps: OwnerTrackedSeriesDeps,
	ownerId: string,
): Promise<OwnerSeries> {
	const stored = await deps.homeDashboard.get(ownerId);
	const dashboard: HomeDashboard =
		stored === null || stored === "unreadable" ? DEFAULT_HOME_DASHBOARD : stored.dashboard;
	const series = await ownerSeries(deps, ownerId, dashboard.widgets);
	const pageStocks = series.tracked.filter((seriesId) => !isJpStockSeries(seriesId));
	const usDirectory = await deps.stockPrices.usDirectorySeriesIds(ownerId, pageStocks);
	return {
		tracked: pageStocks.filter((seriesId) => !usDirectory.has(seriesId)),
		keep: series.keep,
	};
}

/** How often one owner's sync state is read at most; claims in between skip it. */
export const SYNC_CHECK_PERIOD_MS = 5_000;
/** After a job the cap on unfinished runs refused: look again this much later. */
const REFUSED_RETRY_MS = 60_000;

const HOUR_MS = 60 * 60_000;
/** A stock list is downloaded again once it is this old (ADR-0034, ADR-0054 §2). */
export const DIRECTORY_SYNC_INTERVAL_MS = STOCK_DIRECTORY_LIMITS.staleAfterDays * 24 * HOUR_MS;
/**
 * After a stock-list download that did not complete (a configuration error
 * fails the same way until the owner edits `apps/runner/.env`): try again
 * this much later, never at every check.
 */
export const DIRECTORY_SYNC_RETRY_MS = HOUR_MS;
/** The news feeds are fetched again once the oldest fetch is this old (ADR-0054 §4). */
export const NEWS_SYNC_INTERVAL_MS = 30 * 60_000;
/** Never: the Google Calendar has no full re-sync on a timer, only on a change. */
const NEVER_MS = Number.POSITIVE_INFINITY;
/**
 * After a check that found no stock-price work for a market (every day of
 * the window answered, every directory stock stored): look again this much
 * later, not at every claim — the plan reads the window's day rows and
 * walks the directory (ADR-0058 §2). A new day, a retry time that came or
 * a newly listed stock waits at most this long.
 */
export const STOCK_PRICES_IDLE_RECHECK_MS = 30 * 60_000;

/** The markets whose stock lists the schedule keeps, US first. */
const DIRECTORY_MARKETS: readonly WatchMarket[] = ["US", "JP"];

/** Every kind of job the schedule queues. */
export const DATA_SYNC_KINDS = [
	"market-refresh",
	"earnings-refresh",
	"stock-directory-refresh",
	"stock-prices-sync",
	"google-calendar",
	"news-ingest",
] as const satisfies readonly JobKind[];
export type DataSyncKind = (typeof DATA_SYNC_KINDS)[number];

/**
 * When the claim reads an owner's sync state at all. Runners poll about
 * once a second while idle; the decision only changes on a scale of
 * seconds, so reads are spaced by `SYNC_CHECK_PERIOD_MS` per owner. Lives
 * for an isolate (Worker) or a process: losing it costs one early read,
 * never a wrong decision.
 */
export interface SyncCheckGate {
	/** True when the owner is due a check now; a true answer books the next one. */
	take(ownerId: string, nowMs: number): boolean;
	/** Postpones the owner's next check to at least `untilMs`. */
	defer(ownerId: string, untilMs: number): void;
	/**
	 * The desired-events digest the owner's last automatic Google sync was
	 * queued for (ADR-0054 §3), or null. Losing it costs at most one more
	 * attempt for the same digest.
	 */
	googleAttempt(ownerId: string): string | null;
	rememberGoogleAttempt(ownerId: string, digest: string): void;
	/**
	 * Until when one owner's market has no stock-price work to look for
	 * (ADR-0058 §2), 0 when unknown. Losing it costs one more plan read.
	 */
	stockPricesIdleUntil(ownerId: string, market: WatchMarket): number;
	rememberStockPricesIdle(ownerId: string, market: WatchMarket, untilMs: number): void;
}

/** Bound on remembered owners; the app has one owner, tests a few. */
const GATE_MAX_OWNERS = 1_000;

export function createSyncCheckGate(periodMs: number = SYNC_CHECK_PERIOD_MS): SyncCheckGate {
	const nextAt = new Map<string, number>();
	const googleDigests = new Map<string, string>();
	const stockPricesIdle = new Map<string, number>();
	return {
		stockPricesIdleUntil: (ownerId, market) =>
			stockPricesIdle.get(`${ownerId}\u0000${market}`) ?? 0,
		rememberStockPricesIdle(ownerId, market, untilMs) {
			const key = `${ownerId}\u0000${market}`;
			if (!stockPricesIdle.has(key) && stockPricesIdle.size >= GATE_MAX_OWNERS) {
				stockPricesIdle.clear();
			}
			stockPricesIdle.set(key, untilMs);
		},
		googleAttempt: (ownerId) => googleDigests.get(ownerId) ?? null,
		rememberGoogleAttempt(ownerId, digest) {
			if (!googleDigests.has(ownerId) && googleDigests.size >= GATE_MAX_OWNERS) {
				googleDigests.clear();
			}
			googleDigests.set(ownerId, digest);
		},
		take(ownerId, nowMs) {
			const due = nextAt.get(ownerId);
			if (due !== undefined && nowMs < due) return false;
			if (due === undefined && nextAt.size >= GATE_MAX_OWNERS) nextAt.clear();
			nextAt.set(ownerId, nowMs + periodMs);
			return true;
		},
		defer(ownerId, untilMs) {
			nextAt.set(ownerId, Math.max(nextAt.get(ownerId) ?? 0, untilMs));
		},
	};
}

export interface DataSyncDeps extends OwnerTrackedSeriesDeps {
	readonly jobs: JobRepository;
	readonly market: Pick<MarketRepository, "getRefreshState">;
	readonly watchlist: Pick<WatchlistRepository, "listStocks">;
	readonly stockDirectory: Pick<StockDirectoryRepository, "listMeta">;
	/** The day outcomes and unstored stocks the stock-price plan reads (ADR-0058 §2). */
	readonly stockPrices: Pick<
		StockPriceRepository,
		"listDays" | "getSplitCheckedOn" | "listRefetchSymbols" | "listUnfilledSymbols" | "usDirectorySeriesIds"
	>;
	readonly googleCalendar: Pick<GoogleCalendarRepository, "get">;
	readonly earnings: Pick<EarningsRepository, "getEvents" | "getSources">;
	readonly hasher: Hasher;
	readonly sources: Pick<SourceRepository, "list">;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly audit: AuditLog;
	readonly gate: SyncCheckGate;
	/** False switches the schedule off (`SERVER_DATA_SYNC=off`, API tests). */
	readonly enabled: boolean;
	/**
	 * The kinds the schedule keeps; every kind unless a test narrows it so
	 * one kind's jobs are not mixed with the others'.
	 */
	readonly kinds?: ReadonlySet<DataSyncKind>;
	readonly log: (event: string, fields: Record<string, string>) => void;
}

export type DataSyncOutcome =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly jobKind: DataSyncKind; readonly runId: string }
	| { readonly kind: "refused"; readonly jobKind: DataSyncKind; readonly reason: string };

function epochOrZero(iso: string): number {
	// An unparsable stamp counts as very old: the series is synced in full.
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : 0;
}

/** The oldest of the stamps; null for none. */
function oldestMs(stamps: readonly (string | null)[]): number | null {
	let oldest: number | null = null;
	for (const stamp of stamps) {
		if (stamp === null) continue;
		const ms = epochOrZero(stamp);
		if (oldest === null || ms < oldest) oldest = ms;
	}
	return oldest;
}

/** A read made at most once per check, on first use. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
	let value: Promise<T> | null = null;
	return () => {
		value ??= read();
		return value;
	};
}

type WatchlistRead = Pick<WatchlistRepository, "listStocks">;

/** The Watchlist read once per check: the market, earnings and Google decisions share it. */
function watchlistReadOnce(watchlist: WatchlistRead): WatchlistRead {
	let stocks: Promise<readonly StoredWatchlistStock[]> | null = null;
	return {
		listStocks(ownerId) {
			stocks ??= watchlist.listStocks(ownerId);
			return stocks;
		},
	};
}

function syncJob(job: LatestJobOfKind | null): SyncJob | null {
	return job === null
		? null
		: { createdAtMs: epochOrZero(job.createdAt), completed: job.state === "completed" };
}

/** A pending market or earnings refresh job, as the schedule queues it. */
export function refreshJobRecord(input: {
	readonly ownerId: string;
	readonly kind: ScopedRefreshKind;
	readonly scope: RefreshScope;
	readonly runId: string;
	readonly at: string;
}): JobRecord {
	return scheduledJobRecord({ ...input, request: refreshScopeRequest(input.scope) });
}

/** A pending job the schedule queues: no workspace, the usual retry ceiling. */
export function scheduledJobRecord(input: {
	readonly ownerId: string;
	readonly kind: JobKind;
	readonly request: JobRecord["request"];
	readonly runId: string;
	readonly at: string;
}): JobRecord {
	return {
		kind: input.kind,
		request: input.request,
		workspaceId: null,
		retryOfRunId: null,
		contextAnchorSeq: null,
		runId: input.runId,
		ownerId: input.ownerId,
		state: "pending",
		usage: EMPTY_USAGE,
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
		createdAt: input.at,
		updatedAt: input.at,
	};
}

export function createDataSyncService(deps: DataSyncDeps) {
	const kinds: ReadonlySet<DataSyncKind> = deps.kinds ?? new Set(DATA_SYNC_KINDS);

	async function jobsOf(
		ownerId: string,
		kind: DataSyncKind,
		scope?: JobKindScope,
	): Promise<Pick<SyncState, "activeJob" | "lastJob" | "lastFullJob">> {
		const [active, last, lastFull] = await Promise.all([
			deps.jobs.findActiveByKind(ownerId, kind, scope),
			deps.jobs.findLatestByKind(ownerId, kind, { fullOnly: false }, scope),
			deps.jobs.findLatestByKind(ownerId, kind, { fullOnly: true }, scope),
		]);
		return { activeJob: active !== null, lastJob: syncJob(last), lastFullJob: syncJob(lastFull) };
	}

	async function marketDecision(
		ownerId: string,
		nowMs: number,
		watchlist: WatchlistRead,
	): Promise<SyncDecision> {
		const jobs = await jobsOf(ownerId, "market-refresh");
		if (jobs.activeJob) return { kind: "idle" };
		const tracked = await ownerTrackedSeries({ ...deps, watchlist }, ownerId);
		const seriesIds = fetchedSeriesIds(tracked.tracked);
		if (seriesIds.length === 0) return { kind: "idle" };
		const state = await deps.market.getRefreshState(ownerId, seriesIds);
		const rows = seriesIds.map((seriesId) => state.get(seriesId));
		const twelveData = seriesIds.filter((seriesId) => seriesId.startsWith("twelve-data:")).length;
		const cadence: SyncCadence = {
			intervalMs: marketSyncIntervalMs(twelveData),
			retryMs: SYNC_RETRY_MS,
			minGapMs: SYNC_MIN_GAP_MS,
		};
		return decideSync(
			{
				...jobs,
				items: seriesIds.length,
				neverRefreshed: rows.filter(seriesNeverRefreshed).length,
				retryable: rows.filter(seriesRetryable).length,
				oldestRefreshMs: oldestMs(rows.map((row) => row?.lastRefreshedAt ?? null)),
			},
			cadence,
			nowMs,
		);
	}

	async function earningsDecision(
		ownerId: string,
		nowMs: number,
		watchlist: WatchlistRead,
	): Promise<SyncDecision> {
		const jobs = await jobsOf(ownerId, "earnings-refresh");
		if (jobs.activeJob) return { kind: "idle" };
		const stocks: readonly StoredWatchlistStock[] = (await watchlist.listStocks(ownerId)).slice(
			0,
			EARNINGS_LIMITS.maxStocks,
		);
		return decideSync(
			{
				...jobs,
				items: stocks.length,
				neverRefreshed: stocks.filter((stock) => stock.lastRefreshedAt === null).length,
				retryable: stocks.filter(
					(stock) => stock.lastRefreshedAt !== null && earningsStockNeedsRefresh(stock),
				).length,
				oldestRefreshMs: oldestMs(stocks.map((stock) => stock.lastRefreshedAt)),
			},
			{ intervalMs: EARNINGS_SYNC_INTERVAL_MS, retryMs: SYNC_RETRY_MS, minGapMs: SYNC_MIN_GAP_MS },
			nowMs,
		);
	}

	/**
	 * One market's stock list (ADR-0054 §2): downloaded at once while the
	 * market has none, again once it is `DIRECTORY_SYNC_INTERVAL_MS` old,
	 * and `DIRECTORY_SYNC_RETRY_MS` after a download that did not complete.
	 */
	async function directoryDecision(
		ownerId: string,
		market: WatchMarket,
		stored: { readonly entryCount: number; readonly retrievedAt: string } | undefined,
		nowMs: number,
	): Promise<SyncDecision> {
		const missing = stored === undefined || stored.entryCount === 0;
		const retrievedMs = missing ? null : epochOrZero(stored.retrievedAt);
		// A fresh list is idle whatever the jobs say (`decideSync` rules 2–4): skip their reads.
		if (retrievedMs !== null && nowMs - retrievedMs < DIRECTORY_SYNC_INTERVAL_MS) {
			return { kind: "idle" };
		}
		const jobs = await jobsOf(ownerId, "stock-directory-refresh", { market });
		return decideSync(
			{
				...jobs,
				items: 1,
				neverRefreshed: missing ? 1 : 0,
				retryable: 0,
				oldestRefreshMs: retrievedMs,
			},
			{
				intervalMs: DIRECTORY_SYNC_INTERVAL_MS,
				retryMs: DIRECTORY_SYNC_RETRY_MS,
				minGapMs: SYNC_MIN_GAP_MS,
			},
			nowMs,
		);
	}

	/**
	 * One market's stock prices (ADR-0058 §2): a `stock-prices-sync` job
	 * while no job of that market is active, the market's stock list is
	 * stored, the last job of the market was created `SYNC_MIN_GAP_MS` ago
	 * (`SYNC_RETRY_MS` after one that did not complete — `decideSync` with
	 * the market's work as one never-refreshed item), and the plan has work:
	 * due days, else directory stocks with no stored series. A market found
	 * without work is not planned again for `STOCK_PRICES_IDLE_RECHECK_MS`.
	 */
	async function stockPricesDecision(
		ownerId: string,
		market: WatchMarket,
		directoryStored: boolean,
		nowMs: number,
	): Promise<
		| { readonly kind: "idle" }
		| { readonly kind: "queue"; readonly days: number; readonly histories: number }
	> {
		const idle = { kind: "idle" } as const;
		if (!directoryStored || nowMs < deps.gate.stockPricesIdleUntil(ownerId, market)) return idle;
		const jobs = await jobsOf(ownerId, "stock-prices-sync", { market });
		const gate = decideSync(
			{ ...jobs, items: 1, neverRefreshed: 1, retryable: 0, oldestRefreshMs: null },
			{ intervalMs: NEVER_MS, retryMs: SYNC_RETRY_MS, minGapMs: SYNC_MIN_GAP_MS },
			nowMs,
		);
		if (gate.kind !== "queue") return idle;
		const plan = await planStockPrices(deps.stockPrices, ownerId, market, nowMs);
		if (!planHasWork(plan)) {
			deps.gate.rememberStockPricesIdle(ownerId, market, nowMs + STOCK_PRICES_IDLE_RECHECK_MS);
			return idle;
		}
		return { kind: "queue", days: plan.days.length, histories: plan.histories.length };
	}

	/**
	 * The Google Calendar (ADR-0054 §3): a `sync` step while the calendar is
	 * connected, no Google step or earnings sync is active (its dates may
	 * change the events), and the stored digest differs from the desired
	 * events' digest. The out-of-sync calendar is a never-refreshed item of
	 * `decideSync`: queued `SYNC_MIN_GAP_MS` after the last Google step,
	 * `SYNC_RETRY_MS` after one that did not complete, after a recorded
	 * failure (no page offers Sync now any more, so the server retries; a
	 * failure that needs the owner's consent leaves the link `needs-reconnect`
	 * and is not looked at), or after a sync already queued for this same
	 * digest — so a step that cannot bring the calendar in line never loops.
	 */
	async function googleDecision(
		ownerId: string,
		nowMs: number,
		watchlist: WatchlistRead,
	): Promise<{ readonly decision: SyncDecision; readonly digest: string | null }> {
		const idle = { decision: { kind: "idle" } as const, digest: null };
		const link = await deps.googleCalendar.get(ownerId);
		if (link === null || link.status !== "connected") return idle;
		const [google, earnings] = await Promise.all([
			deps.jobs.findActiveByKind(ownerId, "google-calendar"),
			deps.jobs.findActiveByKind(ownerId, "earnings-refresh"),
		]);
		if (google !== null || earnings !== null) return idle;
		const desired = await assembleDesiredEvents(
			{ watchlist, earnings: deps.earnings, hasher: deps.hasher },
			ownerId,
		);
		// An undecidable set is not synced: the claim would fail closed too.
		if (!desired.ok || desired.value.digest === link.syncedDigest) return idle;
		const digest = desired.value.digest;
		const last = syncJob(
			await deps.jobs.findLatestByKind(ownerId, "google-calendar", { fullOnly: false }),
		);
		const waitsAsFailed =
			link.lastFailureCode !== null || deps.gate.googleAttempt(ownerId) === digest;
		const lastJob = last === null || !waitsAsFailed ? last : { ...last, completed: false };
		return {
			decision: decideSync(
				{
					activeJob: false,
					items: 1,
					neverRefreshed: 1,
					retryable: 0,
					oldestRefreshMs: null,
					lastJob,
					lastFullJob: lastJob,
				},
				{ intervalMs: NEVER_MS, retryMs: SYNC_RETRY_MS, minGapMs: SYNC_MIN_GAP_MS },
				nowMs,
			),
			digest,
		};
	}

	/**
	 * The news feeds (ADR-0054 §4): every active (not paused) source, at
	 * once when one was never fetched, and all of them once the oldest
	 * fetch is `NEWS_SYNC_INTERVAL_MS` old. A fetch that fails still stamps
	 * its source, so a broken feed is tried again with the others.
	 */
	async function newsDecision(ownerId: string, nowMs: number): Promise<SyncDecision> {
		const sources = (await deps.sources.list(ownerId)).filter(
			(source) => source.feedStatus !== "paused",
		);
		if (sources.length === 0) return { kind: "idle" };
		const neverRefreshed = sources.filter((source) => source.lastFetchedAt === null).length;
		const oldestRefreshMs = oldestMs(sources.map((source) => source.lastFetchedAt));
		// Every source fetched recently is idle whatever the jobs say: skip their reads.
		if (
			neverRefreshed === 0 &&
			oldestRefreshMs !== null &&
			nowMs - oldestRefreshMs < NEWS_SYNC_INTERVAL_MS
		) {
			return { kind: "idle" };
		}
		const jobs = await jobsOf(ownerId, "news-ingest");
		return decideSync(
			{ ...jobs, items: sources.length, neverRefreshed, retryable: 0, oldestRefreshMs },
			{ intervalMs: NEWS_SYNC_INTERVAL_MS, retryMs: SYNC_RETRY_MS, minGapMs: SYNC_MIN_GAP_MS },
			nowMs,
		);
	}

	/**
	 * Queues the job a decision asks for. Outside the owner's hourly
	 * `job-create` allowance (the owner's own questions need it), inside the
	 * cap on unfinished runs. A job of the kind a concurrent claim queued
	 * first (`kind-active`) is that claim's; the cap's refusal looks again a
	 * minute later.
	 */
	async function queue(
		ownerId: string,
		job: JobRecord & { readonly kind: DataSyncKind },
		fingerprint: string,
		audit: { readonly action: string; readonly detail: string },
	): Promise<DataSyncOutcome> {
		const kind = job.kind;
		const outcome = await deps.jobs.insert(
			job,
			`sync_${job.runId}`.slice(0, 64),
			fingerprint,
			JOB_ADMISSION.maxUnfinishedJobs,
		);
		if (outcome.kind !== "inserted") {
			deps.log("data_sync_skipped", { kind, reason: outcome.kind });
			if (outcome.kind === "at-capacity") {
				deps.gate.defer(ownerId, deps.clock.nowMs() + REFUSED_RETRY_MS);
			}
			return { kind: "refused", jobKind: kind, reason: outcome.kind };
		}
		await deps.audit.record({
			ownerId,
			actor: "scheduler",
			action: audit.action,
			resource: job.runId,
			detail: audit.detail,
			at: job.createdAt,
		});
		return { kind: "queued", jobKind: kind, runId: job.runId };
	}

	/** A market or earnings refresh of the decision's scope. */
	function queueRefresh(
		ownerId: string,
		kind: ScopedRefreshKind,
		decision: Extract<SyncDecision, { kind: "queue" }>,
	): Promise<DataSyncOutcome> {
		const job = refreshJobRecord({
			ownerId,
			kind,
			scope: decision.scope,
			runId: deps.ids.newId("run"),
			at: deps.clock.nowIso(),
		});
		return queue(ownerId, { ...job, kind }, refreshFingerprint(kind, decision.scope), {
			action: kind === "market-refresh" ? "run.sync_market" : "run.sync_earnings",
			detail: `scope=${decision.scope} reason=${decision.reason}`,
		});
	}

	/** A job of a kind whose request carries no scope (stock list, Google step, news). */
	function queueJob(
		ownerId: string,
		kind: Exclude<DataSyncKind, ScopedRefreshKind>,
		request: JobRecord["request"],
		fingerprint: string,
		audit: { readonly action: string; readonly detail: string },
	): Promise<DataSyncOutcome> {
		const job = scheduledJobRecord({
			ownerId,
			kind,
			request,
			runId: deps.ids.newId("run"),
			at: deps.clock.nowIso(),
		});
		return queue(ownerId, { ...job, kind }, fingerprint, audit);
	}

	return {
		/**
		 * Queues the jobs that are due, at most one of each kind (one per
		 * market for the stock lists and the stock prices); returns what
		 * happened per kind and market, in the order market, earnings, stock
		 * lists (US, JP), stock prices (US, JP), Google Calendar, news. A
		 * kind a test left out is not looked at.
		 */
		async materializeDue(ownerId: string): Promise<readonly DataSyncOutcome[]> {
			if (!deps.enabled) return [];
			const nowMs = deps.clock.nowMs();
			if (!deps.gate.take(ownerId, nowMs)) return [];
			const outcomes: DataSyncOutcome[] = [];
			const watchlist = watchlistReadOnce(deps.watchlist);
			if (kinds.has("market-refresh")) {
				const market = await marketDecision(ownerId, nowMs, watchlist);
				outcomes.push(
					market.kind === "queue" ? await queueRefresh(ownerId, "market-refresh", market) : market,
				);
			}
			if (kinds.has("earnings-refresh")) {
				const earnings = await earningsDecision(ownerId, nowMs, watchlist);
				outcomes.push(
					earnings.kind === "queue"
						? await queueRefresh(ownerId, "earnings-refresh", earnings)
						: earnings,
				);
			}
			const metasOnce = once(
				async () =>
					new Map((await deps.stockDirectory.listMeta(ownerId)).map((meta) => [meta.market, meta])),
			);
			if (kinds.has("stock-directory-refresh")) {
				const metas = await metasOnce();
				for (const market of DIRECTORY_MARKETS) {
					const decision = await directoryDecision(ownerId, market, metas.get(market), nowMs);
					outcomes.push(
						decision.kind === "queue"
							? await queueJob(
									ownerId,
									"stock-directory-refresh",
									{ market },
									`stock-directory-refresh:${market}`,
									{
										action: "run.sync_stock_directory",
										detail: `market=${market} reason=${decision.reason}`,
									},
								)
							: decision,
					);
				}
			}
			if (kinds.has("stock-prices-sync")) {
				const metas = await metasOnce();
				for (const market of STOCK_PRICE_MARKETS) {
					const stored = (metas.get(market)?.entryCount ?? 0) > 0;
					const decision = await stockPricesDecision(ownerId, market, stored, nowMs);
					outcomes.push(
						decision.kind === "queue"
							? await queueJob(
									ownerId,
									"stock-prices-sync",
									{ market },
									`stock-prices-sync:${market}`,
									{
										action: "run.sync_stock_prices",
										detail: `market=${market} days=${decision.days} histories=${decision.histories} reason=${decision.days > 0 ? "new-days" : "unstored-stocks"}`,
									},
								)
							: decision,
					);
				}
			}
			if (kinds.has("google-calendar")) {
				const google = await googleDecision(ownerId, nowMs, watchlist);
				if (google.decision.kind === "queue" && google.digest !== null) {
					const queued = await queueJob(
						ownerId,
						"google-calendar",
						{ action: "sync" },
						googleFingerprint("sync"),
						{ action: "run.sync_google_calendar", detail: "action=sync reason=changed" },
					);
					if (queued.kind === "queued") deps.gate.rememberGoogleAttempt(ownerId, google.digest);
					outcomes.push(queued);
				} else {
					outcomes.push({ kind: "idle" });
				}
			}
			if (kinds.has("news-ingest")) {
				const news = await newsDecision(ownerId, nowMs);
				outcomes.push(
					news.kind === "queue"
						? await queueJob(ownerId, "news-ingest", null, "news-ingest", {
								action: "run.sync_news",
								detail: `reason=${news.reason}`,
							})
						: news,
				);
			}
			return outcomes;
		},
	};
}

export type DataSyncService = ReturnType<typeof createDataSyncService>;
