/**
 * The chart viewer's trading-day axis (ADR-0057): bars are spaced evenly in
 * the order they were traded, so weekends, holidays and any other day
 * without a bar take no room — the way SBI Securities' charts draw them.
 *
 * `days` are the axis days: the bar days on screen at the current interval,
 * ascending and distinct (the viewer's `unionBarDays`). A day's *position*
 * is its index among them; a day between two bar days lies between their
 * positions in proportion to the calendar days (a Saturday after a Friday at
 * position 4 and before a Monday at 5 is at 4 + 1/3). Before the first and
 * after the last bar day the neighbouring gap's slope continues, so the map
 * is defined, continuous and strictly increasing for every day, and
 * `axisDay` is its exact inverse. With one axis day the slope is one
 * position a day; with none the position is the day itself.
 *
 * Positions and days are numbers (fractional between bars). The functions
 * are total: a non-finite day or position gives NaN, never a throw, and
 * every other input gives a number. The guarantees above assume strictly
 * ascending days — the functions do not re-check that, as they run per bar
 * per frame; on a list that is not (duplicates, out of order), a segment
 * without a positive gap falls back to `day − first` / `first + position`,
 * a number but not a meaningful position.
 *
 * Verified: `formal/ResearchFormal/TradingAxis.lean` proves, over exact
 * rationals, that bar days land on their index, that the position strictly
 * increases with the day, that the two maps are exact inverses and that
 * `axisSegment` finds the last day ≤ the day; `formal/vectors.json` replays
 * the model against this code (tests/formal/tradingAxis.conformance.test.ts).
 */

/** Index of the last axis day ≤ `day` (−1 when `day` precedes them all): binary search, O(log n). */
export function axisSegment(days: readonly number[], day: number): number {
	let low = 0;
	let high = days.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		const value = days[mid];
		if (value !== undefined && value <= day) low = mid + 1;
		else high = mid;
	}
	return low - 1;
}

/** A segment index clamped to the known gaps 0 … n − 2 (n ≥ 2): the outer gaps extend outwards. */
function clampGap(index: number, count: number): number {
	return Math.min(Math.max(index, 0), count - 2);
}

/** A day's position on the trading-day axis. */
export function axisPosition(days: readonly number[], day: number): number {
	if (!Number.isFinite(day)) return Number.NaN;
	const first = days[0];
	if (first === undefined) return day;
	if (days.length === 1) return day - first;
	// No object per call: this runs for every bar, tick and pointer move.
	const at = clampGap(axisSegment(days, day), days.length);
	const start = days[at];
	const end = days[at + 1];
	if (start === undefined || end === undefined || !(end > start)) return day - first;
	return at + (day - start) / (end - start);
}

/** The (possibly fractional) day at a position: the exact inverse of `axisPosition`. */
export function axisDay(days: readonly number[], position: number): number {
	if (!Number.isFinite(position)) return Number.NaN;
	const first = days[0];
	if (first === undefined) return position;
	if (days.length === 1) return first + position;
	const at = clampGap(Math.floor(position), days.length);
	const start = days[at];
	const end = days[at + 1];
	if (start === undefined || end === undefined || !(end > start)) return first + position;
	return start + (position - at) * (end - start);
}
