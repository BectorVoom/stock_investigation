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
 * are total: a non-finite input gives NaN, never a throw.
 */

/** Index of the last axis day ≤ `day` (−1 when `day` precedes them all): binary search, O(log n). */
export function axisSegment(days: readonly number[], day: number): number {
	let low = 0;
	let high = days.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const value = days[mid];
		if (value !== undefined && value <= day) low = mid + 1;
		else high = mid;
	}
	return low - 1;
}

/** The calendar gap of the segment that starts at index `index` (clamped to the known gaps). */
function gapAt(
	days: readonly number[],
	index: number,
): { readonly start: number; readonly gap: number; readonly at: number } | null {
	const n = days.length;
	if (n < 2) return null;
	const at = Math.min(Math.max(index, 0), n - 2);
	const start = days[at];
	const end = days[at + 1];
	if (start === undefined || end === undefined || !(end > start)) return null;
	return { start, gap: end - start, at };
}

/** A day's position on the trading-day axis. */
export function axisPosition(days: readonly number[], day: number): number {
	if (!Number.isFinite(day)) return Number.NaN;
	const first = days[0];
	if (first === undefined) return day;
	if (days.length === 1) return day - first;
	const segment = gapAt(days, axisSegment(days, day));
	if (segment === null) return day - first;
	return segment.at + (day - segment.start) / segment.gap;
}

/** The (possibly fractional) day at a position: the exact inverse of `axisPosition`. */
export function axisDay(days: readonly number[], position: number): number {
	if (!Number.isFinite(position)) return Number.NaN;
	const first = days[0];
	if (first === undefined) return position;
	if (days.length === 1) return first + position;
	const segment = gapAt(days, Math.floor(position));
	if (segment === null) return first + position;
	return segment.start + (position - segment.at) * segment.gap;
}
