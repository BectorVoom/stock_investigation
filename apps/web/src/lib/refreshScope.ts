import type { RefreshScope } from "@research/contracts";

/**
 * The one rule Home and the Watchlist use to choose an automatic refresh
 * (ADR-0039 decision 2), over the `lastRefreshedAt` stamps of the items on
 * screen. Pure: `nowMs` is passed in, never read here.
 *
 * Staleness is judged by the OLDEST stamp: refreshes may now cover only some
 * items, so one fresh stamp no longer says the others are fresh. A stale (or
 * unparsable) stamp means `"all"`, and it beats a missing one, since a
 * refresh of everything also covers the never-refreshed items. When NO item
 * has a stamp yet, the answer is `"all"` too: it fetches the same items, and
 * only a refresh of everything sets the "last successful refresh" line
 * (narrow runs never count there). A missing stamp with the others present
 * and fresh means `"unrefreshed"`. Otherwise, and for an empty list, nothing
 * is queued (null).
 */
export function autoRefreshScope(
	lastRefreshedAts: readonly (string | null)[],
	staleAfterMs: number,
	nowMs: number,
): RefreshScope | null {
	if (hasStaleStamp(lastRefreshedAts, staleAfterMs, nowMs)) return "all";
	const missing = lastRefreshedAts.filter((at) => at === null).length;
	if (missing === 0) return null;
	return missing === lastRefreshedAts.length ? "all" : "unrefreshed";
}

/** True when a present stamp is older than `staleAfterMs` or unparsable; missing stamps are not stale. */
export function hasStaleStamp(
	lastRefreshedAts: readonly (string | null)[],
	staleAfterMs: number,
	nowMs: number,
): boolean {
	return lastRefreshedAts.some((at) => {
		if (at === null) return false;
		const ms = Date.parse(at);
		return !Number.isFinite(ms) || nowMs - ms > staleAfterMs;
	});
}

/**
 * The refresh queued right after the owner added an item without data (a
 * widget, a stock): the rule above over every tracked item's stamp, the new
 * one included, and `"unrefreshed"` when the rule finds nothing to do (the
 * new item is stamped but has no data, as after a failed fetch).
 */
export function addedItemRefreshScope(
	lastRefreshedAts: readonly (string | null)[],
	staleAfterMs: number,
	nowMs: number,
): RefreshScope {
	return autoRefreshScope(lastRefreshedAts, staleAfterMs, nowMs) ?? "unrefreshed";
}

/**
 * The follow-up after a run ended: queued only while an item is still never
 * refreshed (the run did not cover it), with the scope the rule above
 * chooses. Stale stamps alone never cause a follow-up, so a run that failed
 * is not repeated by itself.
 */
export function followUpRefreshScope(
	lastRefreshedAts: readonly (string | null)[],
	staleAfterMs: number,
	nowMs: number,
): RefreshScope | null {
	return lastRefreshedAts.includes(null)
		? autoRefreshScope(lastRefreshedAts, staleAfterMs, nowMs)
		: null;
}

/** One page item's stamp for the re-check below: its id and its `lastRefreshedAt`. */
export interface RefreshStamp {
	readonly id: string;
	readonly lastRefreshedAt: string | null;
}

/**
 * The stamps that motivate an automatic refresh: the missing ones and the
 * stale (or unparsable) ones — the same test `autoRefreshScope` applies.
 * Fresh stamps never motivate anything, so they never take part in the
 * guard below.
 */
export function motivatingStamps(
	stamps: readonly RefreshStamp[],
	staleAfterMs: number,
	nowMs: number,
): RefreshStamp[] {
	return stamps.filter(
		(stamp) =>
			stamp.lastRefreshedAt === null || hasStaleStamp([stamp.lastRefreshedAt], staleAfterMs, nowMs),
	);
}

/** One stamp's identity: the item with its stamp (NUL never occurs in an id or an ISO stamp). */
export function stampKey(stamp: RefreshStamp): string {
	return `${stamp.id}\u0000${stamp.lastRefreshedAt ?? ""}`;
}

/** A refresh the re-check queues, with the keys of the stamps that motivated it. */
export interface StaleRecheck {
	readonly scope: RefreshScope;
	readonly keys: readonly string[];
	/**
	 * True when a stale stamp drives it (not only never-refreshed ones): once
	 * queued, the caller records the time as the page's last staleness queue,
	 * which spaces the next one (`lastStaleQueueAt`).
	 */
	readonly stale: boolean;
}

/**
 * The stale or missing stamps a page's queued refreshes were asked for:
 * each stamp's key with the time (ms) it was asked. A page keeps one per
 * visit, records into it only once a refresh was queued, and prunes it
 * after every decision.
 */
export type AskedStamps = Map<string, number>;

/**
 * True while `at` lies within `staleAfterMs` before `nowMs`. A time after
 * `nowMs` (a clock step back) counts as recent too.
 */
function isRecent(at: number | null | undefined, staleAfterMs: number, nowMs: number): boolean {
	return at !== null && at !== undefined && nowMs - at <= staleAfterMs;
}

/**
 * The staleness decision a page takes while it stays open (ADR-0044 §4):
 * `scope` is the page's own rule over `stamps` (null: nothing to do). Never
 * while a refresh is active, and three limits, so no refresh loop can form
 * whatever the runner does:
 *
 * - At most once per stale (or missing) stamp per `staleAfterMs`: a
 *   decision whose motivating stamps were all asked for recently (`asked`)
 *   queues nothing. Only the motivating stamps count — a series the refresh
 *   does stamp moves on, but one it never stamps (past the claim's series
 *   limit, or a job that failed as a whole) keeps its old stale stamp, so
 *   it can cause another refresh only once its last ask is `staleAfterMs`
 *   old: a failed job never leaves the page on old data for the visit.
 * - Staleness-driven queues at least `staleAfterMs` apart, measured from
 *   the page's last one that was queued (`lastStaleQueueAt`): a run that
 *   outlasts the limit writes stamps already stale — each a new stamp — and
 *   must not be followed by another run at once.
 * - Never-refreshed series are not held back by that spacing: while it
 *   holds, a missing stamp still asks at once, narrowly (`"unrefreshed"`),
 *   so a widget just added fills in.
 *
 * The caller records `keys` (`recordAsked`) — and, for a `stale` decision,
 * the time — only once the refresh was actually queued, so a refresh that
 * could not be queued is asked for again at the next check.
 */
export function recheckDecision(input: {
	readonly scope: RefreshScope | null;
	readonly stamps: readonly RefreshStamp[];
	readonly staleAfterMs: number;
	readonly nowMs: number;
	readonly refreshActive: boolean;
	readonly asked: ReadonlyMap<string, number>;
	readonly lastStaleQueueAt: number | null;
}): StaleRecheck | null {
	if (input.refreshActive || input.scope === null) return null;
	const motivating = motivatingStamps(input.stamps, input.staleAfterMs, input.nowMs);
	const unasked = motivating.filter(
		(stamp) => !isRecent(input.asked.get(stampKey(stamp)), input.staleAfterMs, input.nowMs),
	);
	if (unasked.length === 0) return null;
	const stale = motivating.some((stamp) => stamp.lastRefreshedAt !== null);
	if (!stale || !isRecent(input.lastStaleQueueAt, input.staleAfterMs, input.nowMs)) {
		return { scope: input.scope, keys: motivating.map(stampKey), stale };
	}
	// Spaced out: only the never-refreshed series may still ask, narrowly.
	const missing = unasked.filter((stamp) => stamp.lastRefreshedAt === null);
	return missing.length === 0
		? null
		: { scope: "unrefreshed", keys: missing.map(stampKey), stale: false };
}

/** Records that a queued refresh asked for these stamps at `nowMs`. */
export function recordAsked(asked: AskedStamps, keys: readonly string[], nowMs: number): void {
	for (const key of keys) asked.set(key, nowMs);
}

/**
 * Drops the asks whose stamp the page no longer shows: stamps only move
 * forward (a refresh replaces them, a removed widget drops them), so an ask
 * for any other stamp can never match again and the record stays as small
 * as the page.
 */
export function pruneAsked(asked: AskedStamps, stamps: readonly RefreshStamp[]): void {
	if (asked.size === 0) return;
	const current = new Set(stamps.map(stampKey));
	for (const key of asked.keys()) {
		if (!current.has(key)) asked.delete(key);
	}
}
