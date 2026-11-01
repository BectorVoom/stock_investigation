/**
 * Server-side synchronisation schedule of market and earnings data
 * (ADR-0051). Pure: instants are epoch ms passed in.
 *
 * The API decides, each time a runner asks for work, whether to queue a
 * `market-refresh` or `earnings-refresh` job (`decideSync`); no page asks for
 * a refresh. The rule, in order:
 *
 * 1. Nothing while a job of the kind is active or nothing is tracked.
 * 2. **Everything** once the oldest refresh stamp is at least `intervalMs`
 *    old and the last job of the kind that covered everything was created
 *    at least `intervalMs` ago (`retryMs` after one that did not complete),
 *    and the last job of any scope at least `minGapMs` ago. Jobs for new
 *    items therefore never postpone the full sync.
 * 3. **New items** (never refreshed: a widget, list or stock just added) at
 *    once — at least `minGapMs` after the last job, `retryMs` after one that
 *    did not complete, so a job that cannot stamp them never loops.
 * 4. **Failed items** (refreshed, but the fetch failed in a way that may
 *    succeed now) `retryMs` after the last job.
 *
 * Measuring from a job's creation, not its end, keeps two full syncs at
 * least `intervalMs` apart even when a run outlasts the interval; every
 * queue is at least `minGapMs` after the job before it.
 */

/** A full market sync's base interval. */
export const MARKET_SYNC_INTERVAL_MS = 30 * 60_000;
/** A full earnings-date sync's interval. */
export const EARNINGS_SYNC_INTERVAL_MS = 24 * 60 * 60_000;
/** After a job that did not complete, and for items whose fetch failed. */
export const SYNC_RETRY_MS = 30 * 60_000;
/** The least time between two jobs of a kind queued for new items. */
export const SYNC_MIN_GAP_MS = 15_000;
/**
 * Twelve Data requests a day the schedule plans for: three quarters of the
 * free plan's 800, leaving room for a revision's second request (ADR-0044)
 * and the research tools.
 */
export const TWELVE_DATA_SYNC_REQUESTS_PER_DAY = 600;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The full market sync interval: `MARKET_SYNC_INTERVAL_MS`, stretched so
 * one request per Twelve Data series per sync stays within
 * `TWELVE_DATA_SYNC_REQUESTS_PER_DAY` (`count × day ≤ budget × interval`).
 * FRED has no daily limit and does not stretch it.
 */
export function marketSyncIntervalMs(twelveDataSeries: number): number {
	const count = Math.max(0, Math.trunc(twelveDataSeries));
	return Math.max(
		MARKET_SYNC_INTERVAL_MS,
		Math.ceil((DAY_MS * count) / TWELVE_DATA_SYNC_REQUESTS_PER_DAY),
	);
}

export interface SyncCadence {
	readonly intervalMs: number;
	readonly retryMs: number;
	readonly minGapMs: number;
}

/** The stored state the decision reads, for one kind of one owner. */
export interface SyncState {
	readonly activeJob: boolean;
	/** Items a refresh of everything would fetch. */
	readonly items: number;
	/** Items never refreshed. */
	readonly neverRefreshed: number;
	/** Items refreshed whose last fetch failed and may succeed now. */
	readonly retryable: number;
	/** The oldest refresh stamp among the refreshed items; null when none was refreshed. */
	readonly oldestRefreshMs: number | null;
	/** The newest job of the kind, any scope and state; null when there was none. */
	readonly lastJob: SyncJob | null;
	/** The newest job of the kind that covered everything, any state; null when there was none. */
	readonly lastFullJob: SyncJob | null;
}

export interface SyncJob {
	readonly createdAtMs: number;
	/** Whether it ended `completed`; a job still active counts as not completed. */
	readonly completed: boolean;
}

export type SyncReason = "stale" | "new-items" | "retry";

export type SyncDecision =
	| { readonly kind: "idle" }
	| { readonly kind: "queue"; readonly scope: "all" | "unrefreshed"; readonly reason: SyncReason };

const IDLE: SyncDecision = { kind: "idle" };

function sinceMs(job: SyncJob | null, nowMs: number): number {
	return job === null ? Number.POSITIVE_INFINITY : nowMs - job.createdAtMs;
}

export function decideSync(state: SyncState, cadence: SyncCadence, nowMs: number): SyncDecision {
	if (state.activeJob || state.items <= 0) return IDLE;
	const since = sinceMs(state.lastJob, nowMs);
	const failed = state.lastJob !== null && !state.lastJob.completed;
	const sinceFull = sinceMs(state.lastFullJob, nowMs);
	const fullFailed = state.lastFullJob !== null && !state.lastFullJob.completed;
	const stale =
		state.oldestRefreshMs !== null && nowMs - state.oldestRefreshMs >= cadence.intervalMs;
	if (
		stale &&
		since >= cadence.minGapMs &&
		sinceFull >= (fullFailed ? cadence.retryMs : cadence.intervalMs)
	) {
		return { kind: "queue", scope: "all", reason: "stale" };
	}
	if (state.neverRefreshed > 0 && since >= (failed ? cadence.retryMs : cadence.minGapMs)) {
		return { kind: "queue", scope: "unrefreshed", reason: "new-items" };
	}
	if (state.retryable > 0 && since >= cadence.retryMs) {
		return { kind: "queue", scope: "unrefreshed", reason: "retry" };
	}
	return IDLE;
}
