/**
 * Incremental refresh of a stored market history (ADR-0044). Pure: dates are
 * `YYYY-MM-DD` strings (they order as text), instants are epoch ms passed in.
 *
 * A refresh fetches only the newest part of a series — the window that
 * starts at the **anchor**, the `HISTORY_OVERLAP_OBSERVATIONS`-th newest
 * stored observation — and the anchor proves the older stored history still
 * matches the provider: when the window's answer holds the anchor's date with
 * the same value, everything older than the anchor is kept as stored. When it
 * does not (a stock split re-adjusted every older close, a statistics agency
 * revised a year back, the window was cut short), the runner fetches the
 * full history instead and the stored series is replaced.
 *
 * Every `HISTORY_FULL_CHECK_DAYS` a series is fetched in full even when its
 * anchor would hold, so revisions older than the window (an annual benchmark
 * revision) reach the database too. A full fetch costs the same number of
 * provider requests as a window fetch; only the answer is longer.
 *
 * The API decides the request (`historyRefreshRequest`), the runner the
 * fetches and the write (`firstHistoryFetch`, `historyOutcome`), and the
 * database applies the write; `mergeHistory` is that write's reference
 * semantics, which the SQL must match.
 */

/** Stored observations a window refresh re-reads (the anchor included). */
export const HISTORY_OVERLAP_OBSERVATIONS = 32;
/** Days after which a series is fetched in full again although its anchor holds. */
export const HISTORY_FULL_CHECK_DAYS = 7;

const DAY_MS = 86_400_000;

export interface HistoryPoint {
	readonly observedOn: string;
	readonly value: number;
}

/** What a market-refresh claim tells the runner about one series. */
export interface HistoryRefreshRequest {
	/** The stored observation the window must reproduce; null when nothing usable is stored. */
	readonly anchor: HistoryPoint | null;
	/** True when the series is due a full fetch although it has an anchor. */
	readonly fullCheck: boolean;
}

/**
 * How the fetched points are stored. `replaceFrom` is the first date whose
 * stored rows the answer replaces (rows on or after it that the answer does
 * not hold are deleted; older rows are kept); null replaces every stored row
 * of the series. A `"window"` write always has a date (its anchor).
 */
export type HistoryWrite =
	| { readonly mode: "window"; readonly replaceFrom: string }
	| { readonly mode: "full"; readonly replaceFrom: string | null };

/** The provider request the runner sends first: from the anchor's date, or everything. */
export type HistoryFetch =
	| { readonly kind: "window"; readonly from: string }
	| { readonly kind: "full" };

/** After a fetch: store the points (with how), or fetch the full history and decide again. */
export type HistoryOutcome =
	| { readonly kind: "store"; readonly write: HistoryWrite | null }
	| { readonly kind: "refetch-full" };

/**
 * The claim's request for one series (API side). `anchor` is the
 * `HISTORY_OVERLAP_OBSERVATIONS`-th newest stored observation (the oldest
 * stored one when fewer are stored), or null when none is stored.
 * `historyCheckedAtMs` is when the series was last fetched in full (null:
 * never, or the stamp did not parse); a full check is due when that is null
 * or at least `HISTORY_FULL_CHECK_DAYS` old. A stamp in the future (a clock
 * step back) is not due.
 */
export function historyRefreshRequest(
	anchor: HistoryPoint | null,
	historyCheckedAtMs: number | null,
	nowMs: number,
): HistoryRefreshRequest {
	if (anchor === null) return { anchor: null, fullCheck: false };
	const due =
		historyCheckedAtMs === null ||
		!Number.isFinite(historyCheckedAtMs) ||
		nowMs - historyCheckedAtMs >= HISTORY_FULL_CHECK_DAYS * DAY_MS;
	return { anchor, fullCheck: due };
}

/** The first provider request for a claimed series (runner side). */
export function firstHistoryFetch(request: HistoryRefreshRequest): HistoryFetch {
	return request.anchor === null || request.fullCheck
		? { kind: "full" }
		: { kind: "window", from: request.anchor.observedOn };
}

/**
 * True when ascending, date-unique `points` hold the anchor's date with
 * exactly the anchor's value. Binary search: O(log n).
 */
export function anchorConfirmed(anchor: HistoryPoint, points: readonly HistoryPoint[]): boolean {
	let lo = 0;
	let hi = points.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const point = points[mid];
		if (point === undefined) return false;
		// `===`: 0 and -0 are the same stored number (SQLite keeps no sign of zero).
		if (point.observedOn === anchor.observedOn) return point.value === anchor.value;
		if (point.observedOn < anchor.observedOn) lo = mid + 1;
		else hi = mid - 1;
	}
	return false;
}

/**
 * What to do with the ascending, date-unique `points` one fetch returned
 * (runner side):
 *
 * - window fetch, anchor reproduced → store, replacing from the anchor's date;
 * - window fetch, anchor missing or changed → fetch the full history;
 * - full fetch, nothing stored (no anchor) → store, replacing everything;
 * - full fetch, anchor reproduced → store, replacing from the oldest fetched
 *   date (older stored rows predate the answer and stay);
 * - full fetch, anchor missing or changed → store, replacing everything (the
 *   older stored rows belong to a superseded version of the series).
 *
 * An empty answer replaces nothing (`write` null: plain merge), so a provider
 * that answers with no points never empties the stored history.
 */
export function historyOutcome(
	request: HistoryRefreshRequest,
	fetched: HistoryFetch,
	points: readonly HistoryPoint[],
): HistoryOutcome {
	const first = points[0];
	if (fetched.kind === "window") {
		const anchor = request.anchor;
		if (anchor !== null && anchorConfirmed(anchor, points)) {
			return { kind: "store", write: { mode: "window", replaceFrom: anchor.observedOn } };
		}
		return { kind: "refetch-full" };
	}
	if (first === undefined) return { kind: "store", write: null };
	const anchor = request.anchor;
	if (anchor !== null && anchorConfirmed(anchor, points)) {
		return { kind: "store", write: { mode: "full", replaceFrom: first.observedOn } };
	}
	return { kind: "store", write: { mode: "full", replaceFrom: null } };
}

/**
 * The reference semantics of storing fetched points (what the SQL does):
 * stored rows the write replaces are dropped unless the answer holds their
 * date, every fetched point is stored with its fetched value, and the result
 * is ascending by date with one row per date, cut to the newest
 * `maxStored`. `write` null merges (no stored row is dropped). Inputs are
 * ascending and date-unique.
 */
export function mergeHistory(
	stored: readonly HistoryPoint[],
	fetched: readonly HistoryPoint[],
	write: HistoryWrite | null,
	maxStored: number,
): HistoryPoint[] {
	const fetchedDates = new Set(fetched.map((point) => point.observedOn));
	const replaceFrom = write === null ? undefined : write.replaceFrom;
	const kept = stored.filter((point) => {
		if (fetchedDates.has(point.observedOn)) return false;
		if (replaceFrom === undefined) return true;
		if (replaceFrom === null) return false;
		return point.observedOn < replaceFrom;
	});
	const merged: HistoryPoint[] = [];
	let i = 0;
	let j = 0;
	while (i < kept.length || j < fetched.length) {
		const a = kept[i];
		const b = fetched[j];
		if (b === undefined || (a !== undefined && a.observedOn < b.observedOn)) {
			if (a !== undefined) merged.push(a);
			i += 1;
		} else {
			merged.push(b);
			j += 1;
		}
	}
	const limit = Math.max(0, Math.trunc(maxStored));
	return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
