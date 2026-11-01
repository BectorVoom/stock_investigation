import {
	DEFAULT_HOME_DASHBOARD,
	EARNINGS_LIMITS,
	type HomeDashboard,
	type MarketUnavailableCode,
	type RefreshScope,
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
import { type OwnerSeries, type OwnerSeriesDeps, ownerSeries } from "./pageSeries.ts";
import type {
	AuditLog,
	Clock,
	HomeDashboardRepository,
	IdGenerator,
	JobRecord,
	JobRepository,
	LatestJobOfKind,
	MarketRepository,
	MarketSeriesRefreshState,
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

/**
 * Server-side synchronisation of market data and earnings dates (ADR-0051).
 *
 * No page asks for a refresh. Each time a runner asks for work, the claim
 * calls `materializeDue` before it scans for jobs: for each of the two
 * kinds it reads the stored refresh stamps and the last jobs, lets the pure
 * `decideSync` (Lean-verified, `formal/ResearchFormal/SyncSchedule.lean`)
 * decide, and queues one `market-refresh` or `earnings-refresh` job — which
 * the same claim can hand out. The claim, the runner and the completion are
 * unchanged: the job is the same one the removed refresh endpoints queued.
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
}

/**
 * Every series the owner's pages track (Home first, then the notebooks).
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
	return ownerSeries(deps, ownerId, dashboard.widgets);
}

/** How often one owner's sync state is read at most; claims in between skip it. */
export const SYNC_CHECK_PERIOD_MS = 5_000;
/** After a job the cap on unfinished runs refused: look again this much later. */
const REFUSED_RETRY_MS = 60_000;

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
}

/** Bound on remembered owners; the app has one owner, tests a few. */
const GATE_MAX_OWNERS = 1_000;

export function createSyncCheckGate(periodMs: number = SYNC_CHECK_PERIOD_MS): SyncCheckGate {
	const nextAt = new Map<string, number>();
	return {
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
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly audit: AuditLog;
	readonly gate: SyncCheckGate;
	/** False switches the schedule off (`SERVER_DATA_SYNC=off`, API tests). */
	readonly enabled: boolean;
	readonly log: (event: string, fields: Record<string, string>) => void;
}

export type DataSyncOutcome =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly jobKind: ScopedRefreshKind; readonly runId: string }
	| { readonly kind: "refused"; readonly jobKind: ScopedRefreshKind; readonly reason: string };

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
	return {
		kind: input.kind,
		request: refreshScopeRequest(input.scope),
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
	async function jobsOf(
		ownerId: string,
		kind: ScopedRefreshKind,
	): Promise<Pick<SyncState, "activeJob" | "lastJob" | "lastFullJob">> {
		const [active, last, lastFull] = await Promise.all([
			deps.jobs.findActiveByKind(ownerId, kind),
			deps.jobs.findLatestByKind(ownerId, kind, { fullOnly: false }),
			deps.jobs.findLatestByKind(ownerId, kind, { fullOnly: true }),
		]);
		return { activeJob: active !== null, lastJob: syncJob(last), lastFullJob: syncJob(lastFull) };
	}

	async function marketDecision(ownerId: string, nowMs: number): Promise<SyncDecision> {
		const jobs = await jobsOf(ownerId, "market-refresh");
		if (jobs.activeJob) return { kind: "idle" };
		const seriesIds = fetchedSeriesIds((await ownerTrackedSeries(deps, ownerId)).tracked);
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

	async function earningsDecision(ownerId: string, nowMs: number): Promise<SyncDecision> {
		const jobs = await jobsOf(ownerId, "earnings-refresh");
		if (jobs.activeJob) return { kind: "idle" };
		const stocks: readonly StoredWatchlistStock[] = (
			await deps.watchlist.listStocks(ownerId)
		).slice(0, EARNINGS_LIMITS.maxStocks);
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
	 * Queues the job a decision asks for. Outside the owner's hourly
	 * `job-create` allowance (the owner's own questions need it), inside the
	 * cap on unfinished runs. A job of the kind a concurrent claim queued
	 * first (`kind-active`) is that claim's; the cap's refusal looks again a
	 * minute later.
	 */
	async function queue(
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
		const outcome = await deps.jobs.insert(
			job,
			`sync_${job.runId}`.slice(0, 64),
			refreshFingerprint(kind, decision.scope),
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
			action: kind === "market-refresh" ? "run.sync_market" : "run.sync_earnings",
			resource: job.runId,
			detail: `scope=${decision.scope} reason=${decision.reason}`,
			at: job.createdAt,
		});
		return { kind: "queued", jobKind: kind, runId: job.runId };
	}

	return {
		/**
		 * Queues the market and earnings jobs that are due, at most one of
		 * each kind; returns what happened per kind, market first.
		 */
		async materializeDue(ownerId: string): Promise<readonly DataSyncOutcome[]> {
			if (!deps.enabled) return [];
			const nowMs = deps.clock.nowMs();
			if (!deps.gate.take(ownerId, nowMs)) return [];
			const outcomes: DataSyncOutcome[] = [];
			const market = await marketDecision(ownerId, nowMs);
			outcomes.push(
				market.kind === "queue" ? await queue(ownerId, "market-refresh", market) : market,
			);
			const earnings = await earningsDecision(ownerId, nowMs);
			outcomes.push(
				earnings.kind === "queue" ? await queue(ownerId, "earnings-refresh", earnings) : earnings,
			);
			return outcomes;
		},
	};
}

export type DataSyncService = ReturnType<typeof createDataSyncService>;
