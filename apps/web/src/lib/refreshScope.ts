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
	let missing = 0;
	for (const at of lastRefreshedAts) {
		if (at === null) {
			missing += 1;
			continue;
		}
		const ms = Date.parse(at);
		if (!Number.isFinite(ms) || nowMs - ms > staleAfterMs) return "all";
	}
	if (missing === 0) return null;
	return missing === lastRefreshedAts.length ? "all" : "unrefreshed";
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
