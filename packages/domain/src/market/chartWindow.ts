import { err, ok, type Result } from "../result.ts";

/**
 * Day-window arithmetic for the detailed chart viewer (ADR-0025).
 *
 * Dates cross this module as integer day numbers (days since 1970-01-01, UTC
 * civil calendar) so window math never touches time zones or the clock. The
 * day-number conversion reuses the same `Date.UTC` validation as
 * `packages/domain/src/market/changes.ts` (`isoToDays` there delegates here),
 * and month stepping uses the same clamp-the-day rule as `subtractMonths`.
 * Fallible entry points return `Result` (ARCH-010); pure window placement is
 * total with documented clamping instead.
 */

export type ChartInterval = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
export type ChartPreset = "1w" | "1m" | "3m" | "6m" | "ytd" | "1y" | "3y" | "5y" | "max";
/** Native provider frequency (`MarketSeries.frequency` in contracts, restated here so domain stays dependency-free). */
export type ChartNativeFrequency =
	| "daily"
	| "weekly"
	| "monthly"
	| "quarterly"
	| "annual"
	| "unknown";

/** One observation as the viewer receives it (same wire shape as `MarketPoint`, restated to avoid a domain-internal import cycle). */
export interface ChartPoint {
	readonly observedOn: string;
	readonly value: number;
}

export interface ChartBar {
	readonly observedOn: string;
	/** Integer day number of `observedOn`. */
	readonly day: number;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
	/** How many observations the bucket holds (1 for daily bars). */
	readonly count: number;
}

/** Inclusive integer-day window. Callers may pass `from > to`; placement normalises it. */
export interface DayWindow {
	readonly from: number;
	readonly to: number;
}

export interface ChartStatPoint {
	readonly value: number;
	readonly observedOn: string;
	readonly day: number;
}

export interface ChartStats {
	readonly open: number;
	readonly close: number;
	readonly change: number;
	/** Null for a zero base (a percent of zero is undefined, never 0 or infinity). */
	readonly percentChange: number | null;
	readonly high: ChartStatPoint;
	readonly low: ChartStatPoint;
	readonly average: number;
	/** Percent; null when any running peak is ≤ 0 (a drawdown off a non-positive peak is meaningless). */
	readonly maxDrawdown: number | null;
	readonly bars: number;
}

export type DayNumberError = "INVALID_DATE" | "INVALID_DAY";
export type MovingAverageError = "INVALID_PERIOD" | "NON_FINITE";
export type WindowStatsError = "EMPTY_WINDOW" | "NON_FINITE";

const MS_PER_DAY = 86_400_000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` to integer day number. Rejects malformed text and impossible
 * dates (2026-02-30) instead of wrapping them.
 */
export function isoToDayNumber(iso: string): Result<number, "INVALID_DATE"> {
	const match = ISO_DATE_PATTERN.exec(iso);
	if (match === null) return err("INVALID_DATE");
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const ms = Date.UTC(year, month - 1, day);
	const check = new Date(ms);
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day
	) {
		return err("INVALID_DATE");
	}
	return ok(Math.floor(ms / MS_PER_DAY));
}

/**
 * Integer day number back to `YYYY-MM-DD`. Only days whose civil date fits
 * the four-digit ISO form are accepted, so absurd magnitudes fail instead of
 * producing unparseable text.
 */
export function dayNumberToIso(day: number): Result<string, "INVALID_DAY"> {
	if (!Number.isInteger(day)) return err("INVALID_DAY");
	const date = new Date(day * MS_PER_DAY);
	if (Number.isNaN(date.getTime())) return err("INVALID_DAY");
	const year = String(date.getUTCFullYear()).padStart(4, "0");
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dayOfMonth = String(date.getUTCDate()).padStart(2, "0");
	const iso = `${year}-${month}-${dayOfMonth}`;
	// Round-trip: years outside 0000–9999 (or Date overflow) cannot re-parse.
	const back = isoToDayNumber(iso);
	if (!back.ok || back.value !== day) return err("INVALID_DAY");
	return ok(iso);
}

/** Weekday with 0 = Sunday; 1970-01-01 (day 0) was a Thursday. */
function weekdaySundayZero(day: number): number {
	return (((day + 4) % 7) + 7) % 7;
}

function civilParts(day: number): {
	readonly year: number;
	readonly month: number;
	readonly day: number;
} {
	const date = new Date(day * MS_PER_DAY);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
	};
}

function daysInMonth(year: number, monthOneBased: number): number {
	return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
}

/**
 * Bucket key for a day number: the identity for daily bars, the bucket's
 * Monday (absolute day) for ISO weeks, and a monotone month/quarter/year
 * index otherwise. Weeks are keyed by their Monday date rather than the ISO
 * week-numbering year, so 2024-12-30 (ISO week 1 of 2025) still buckets with
 * its own Monday instead of merging with January dates.
 */
function bucketKey(day: number, interval: ChartInterval): number {
	if (interval === "daily") return day;
	if (interval === "weekly") {
		const mondayOffset = (weekdaySundayZero(day) + 6) % 7;
		return day - mondayOffset;
	}
	const parts = civilParts(day);
	if (interval === "monthly") return parts.year * 12 + (parts.month - 1);
	if (interval === "quarterly") return parts.year * 4 + Math.floor((parts.month - 1) / 3);
	return parts.year;
}

interface BucketEntry {
	readonly day: number;
	readonly key: number;
	readonly value: number;
	readonly observedOn: string;
	readonly index: number;
}

/**
 * Buckets ascending points by calendar period (weeks start Monday; quarters
 * are Jan–Mar etc.). One bar per non-empty bucket: `observedOn` is the
 * bucket's last date, `close` its last value, `open` its first value,
 * `high`/`low` the extremes, `count` the bucket size. `daily` is the
 * identity (one bar per point). Output days ascend.
 *
 * Total: points with an invalid date or a non-finite value are dropped (the
 * viewer only holds validated observations, so this is defensive), and the
 * input order never matters — entries are stably sorted by day first, which
 * is what makes the binary search in `visibleSlice` sound.
 */
export function resampleSeries(points: readonly ChartPoint[], interval: ChartInterval): ChartBar[] {
	const entries: BucketEntry[] = [];
	for (let index = 0; index < points.length; index += 1) {
		const point = points[index];
		if (point === undefined) continue;
		const day = isoToDayNumber(point.observedOn);
		if (!day.ok || !Number.isFinite(point.value)) continue;
		entries.push({
			day: day.value,
			key: interval === "daily" ? day.value : bucketKey(day.value, interval),
			value: point.value,
			observedOn: point.observedOn,
			index,
		});
	}
	entries.sort((a, b) => (a.day === b.day ? a.index - b.index : a.day - b.day));
	// Daily is the identity: one bar per point, even when two points share a
	// date (held series have unique dates; merging would invent a bucket the
	// source never reported).
	if (interval === "daily") {
		return entries.map((entry) => ({
			observedOn: entry.observedOn,
			day: entry.day,
			open: entry.value,
			high: entry.value,
			low: entry.value,
			close: entry.value,
			count: 1,
		}));
	}
	const bars: ChartBar[] = [];
	let openKey: number | null = null;
	for (const entry of entries) {
		const current = bars[bars.length - 1];
		if (current !== undefined && openKey === entry.key) {
			bars[bars.length - 1] = {
				observedOn: entry.observedOn,
				day: entry.day,
				open: current.open,
				high: Math.max(current.high, entry.value),
				low: Math.min(current.low, entry.value),
				close: entry.value,
				count: current.count + 1,
			};
			continue;
		}
		openKey = entry.key;
		bars.push({
			observedOn: entry.observedOn,
			day: entry.day,
			open: entry.value,
			high: entry.value,
			low: entry.value,
			close: entry.value,
			count: 1,
		});
	}
	return bars;
}

const INTERVAL_ORDER: readonly ChartInterval[] = [
	"daily",
	"weekly",
	"monthly",
	"quarterly",
	"yearly",
];

function nativeRank(frequency: ChartNativeFrequency): number {
	switch (frequency) {
		case "daily":
			return 0;
		case "weekly":
			return 1;
		case "monthly":
			return 2;
		case "quarterly":
			return 3;
		case "annual":
			return 4;
		case "unknown":
			return 0;
	}
}

/** Ceiling of the expected bar count for `spanDays` of data at an interval (trading-day factor for daily-native data). */
function estimatedBars(spanDays: number, interval: ChartInterval): number {
	const span = Number.isFinite(spanDays) ? Math.max(0, spanDays) : Number.POSITIVE_INFINITY;
	switch (interval) {
		case "daily":
			return Math.ceil((span * 5) / 7);
		case "weekly":
			return Math.ceil(span / 7);
		case "monthly":
			return Math.ceil(span / 30.44);
		case "quarterly":
			return Math.ceil(span / 91.31);
		case "yearly":
			return Math.ceil(span / 365.25);
	}
}

/**
 * Finest interval at or coarser than the native frequency whose estimated
 * bar count over `spanDays` fits `maxBars`; `yearly` when nothing fits.
 * Total: a non-positive `maxBars` behaves as 1, a negative span as 0.
 */
export function autoInterval(
	spanDays: number,
	nativeFrequency: ChartNativeFrequency,
	maxBars: number,
): ChartInterval {
	const cap = Number.isFinite(maxBars) ? Math.max(1, Math.floor(maxBars)) : 1;
	const floor = nativeRank(nativeFrequency);
	for (let rank = floor; rank < INTERVAL_ORDER.length; rank += 1) {
		const candidate = INTERVAL_ORDER[rank];
		if (candidate === undefined) continue;
		if (estimatedBars(spanDays, candidate) <= cap) return candidate;
	}
	return "yearly";
}

/** `day` back `months` calendar months with the day clamped (Mar 31 − 1 month = Feb 29 in a leap year). */
function subtractMonthsDay(day: number, months: number): number | null {
	const parts = civilParts(day);
	const totalMonths = parts.year * 12 + (parts.month - 1) - months;
	const targetYear = Math.floor(totalMonths / 12);
	const targetMonth = totalMonths - targetYear * 12 + 1;
	const clampedDay = Math.min(parts.day, daysInMonth(targetYear, targetMonth));
	const ms = Date.UTC(targetYear, targetMonth - 1, clampedDay);
	if (!Number.isFinite(ms)) return null;
	return Math.floor(ms / MS_PER_DAY);
}

/**
 * Preset button to window: `to` is always the last held day; `from` counts
 * back calendar months/years (1W is 7 days, YTD is 1 January of the last
 * date's year) and is clamped into the held `[firstDay, lastDay]` extent, so
 * short histories still show from their first observation. Total: fractional
 * days are truncated, a flipped extent is normalised.
 */
export function presetWindow(preset: ChartPreset, firstDay: number, lastDay: number): DayWindow {
	const lo = Math.min(Math.trunc(firstDay), Math.trunc(lastDay));
	const hi = Math.max(Math.trunc(firstDay), Math.trunc(lastDay));
	if (preset === "max") return { from: lo, to: hi };
	let start: number | null;
	if (preset === "1w") {
		start = hi - 7;
	} else if (preset === "ytd") {
		start = Math.floor(Date.UTC(civilParts(hi).year, 0, 1) / MS_PER_DAY);
	} else {
		const months =
			preset === "1m"
				? 1
				: preset === "3m"
					? 3
					: preset === "6m"
						? 6
						: preset === "1y"
							? 12
							: preset === "3y"
								? 36
								: 60;
		start = subtractMonthsDay(hi, months);
	}
	if (start === null || !Number.isFinite(start)) start = lo;
	return { from: Math.min(Math.max(start, lo), hi), to: hi };
}

function normaliseEnds(window: DayWindow): { readonly a: number; readonly b: number } {
	return {
		a: Math.min(Math.trunc(window.from), Math.trunc(window.to)),
		b: Math.max(Math.trunc(window.from), Math.trunc(window.to)),
	};
}

/** Fits `[a, b]` (span kept) into `[lo, hi]`; the whole extent when the span cannot fit. */
function fitSpan(a: number, span: number, lo: number, hi: number): DayWindow {
	if (span >= hi - lo) return { from: lo, to: hi };
	const from = Math.min(Math.max(a, lo), hi - span);
	return { from, to: from + span };
}

/**
 * Clamps a window into the held extent with `from ≤ to` and at least
 * `minSpan` days (a negative `minSpan` behaves as 0; a `minSpan` wider than
 * the extent yields the whole extent).
 */
export function clampWindow(window: DayWindow, extent: DayWindow, minSpan: number): DayWindow {
	const { a, b } = normaliseEnds(window);
	const lo = Math.min(Math.trunc(extent.from), Math.trunc(extent.to));
	const hi = Math.max(Math.trunc(extent.from), Math.trunc(extent.to));
	const floor = Number.isFinite(minSpan) ? Math.max(0, Math.floor(minSpan)) : 0;
	return fitSpan(a, Math.max(b - a, floor), lo, hi);
}

/**
 * Shifts a window by `deltaDays` (fractional deltas are truncated), keeping
 * its span; clamps into the extent, or the whole extent when the span cannot
 * fit.
 */
export function panWindow(window: DayWindow, deltaDays: number, extent: DayWindow): DayWindow {
	const { a, b } = normaliseEnds(window);
	const lo = Math.min(Math.trunc(extent.from), Math.trunc(extent.to));
	const hi = Math.max(Math.trunc(extent.from), Math.trunc(extent.to));
	const shift = Number.isFinite(deltaDays) ? Math.trunc(deltaDays) : 0;
	return fitSpan(a + shift, b - a, lo, hi);
}

/**
 * Zooms around `anchorDay` by `factor` (> 1 out, < 1 in): the anchor keeps
 * its relative position, the span rounds to whole days within
 * `[minSpan, extent length]`, and the result is fitted into the extent — so
 * the (extent-clamped) anchor always stays inside. A non-positive or
 * non-finite factor cannot express a zoom and falls back to clamping the
 * input window.
 */
export function zoomWindow(
	window: DayWindow,
	anchorDay: number,
	factor: number,
	extent: DayWindow,
	minSpan: number,
): DayWindow {
	const { a, b } = normaliseEnds(window);
	const lo = Math.min(Math.trunc(extent.from), Math.trunc(extent.to));
	const hi = Math.max(Math.trunc(extent.from), Math.trunc(extent.to));
	if (!Number.isFinite(factor) || factor <= 0) return fitSpan(a, b - a, lo, hi);
	const span = b - a;
	const floor = Number.isFinite(minSpan) ? Math.max(0, Math.floor(minSpan)) : 0;
	let next = Math.round(span * factor);
	if (!Number.isFinite(next)) next = floor;
	next = Math.min(Math.max(next, floor), Math.max(hi - lo, 0));
	// Extent-clamped anchor at a clamped relative position; the integer shift
	// below is truncated (floor), which keeps the bound provable in Lean.
	const anchor = Math.min(Math.max(Math.trunc(anchorDay), lo), hi);
	const offset = Math.min(Math.max(anchor - a, 0), span);
	const shift =
		span > 0 ? Math.min(next, Math.floor((offset * next) / span)) : Math.floor(next / 2);
	const start = anchor - shift;
	if (next >= hi - lo) return { from: lo, to: hi };
	const from = Math.min(Math.max(start, lo), hi - next);
	return { from, to: from + next };
}

/** First index with `bars[index].day >= day` (ascending days). */
function lowerBound(bars: readonly ChartBar[], day: number): number {
	let lo = 0;
	let hi = bars.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const bar = bars[mid];
		if (bar !== undefined && bar.day < day) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** First index with `bars[index].day > day` (ascending days). */
function upperBound(bars: readonly ChartBar[], day: number): number {
	let lo = 0;
	let hi = bars.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const bar = bars[mid];
		if (bar !== undefined && bar.day <= day) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export interface BarSlice {
	readonly start: number;
	readonly end: number;
}

/**
 * Indices `[start, end)` of the bars whose days lie in the window — binary
 * search on the ascending days, never a filter over all bars (O(log n)).
 * The bars slice `bars.slice(start, end)` is exactly the in-window bars.
 */
export function visibleSlice(bars: readonly ChartBar[], window: DayWindow): BarSlice {
	const lo = Math.min(Math.trunc(window.from), Math.trunc(window.to));
	const hi = Math.max(Math.trunc(window.from), Math.trunc(window.to));
	return { start: lowerBound(bars, lo), end: upperBound(bars, hi) };
}

/**
 * Simple moving average over the values: same length, `null` for the first
 * `period − 1` entries. One pass with a running sum (O(n)).
 */
export function movingAverage(
	values: readonly number[],
	period: number,
): Result<readonly (number | null)[], MovingAverageError> {
	if (!Number.isInteger(period) || period < 1) return err("INVALID_PERIOD");
	const out: (number | null)[] = [];
	let sum = 0;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value === undefined || !Number.isFinite(value)) return err("NON_FINITE");
		sum += value;
		if (index >= period) {
			const dropped = values[index - period];
			if (dropped === undefined || !Number.isFinite(dropped)) return err("NON_FINITE");
			sum -= dropped;
		}
		out.push(index >= period - 1 ? sum / period : null);
	}
	return ok(out);
}

/**
 * Statistics over the visible bars. Single pass (O(n)): open is the first
 * bar's open, close the last bar's close, high/low the extremes with their
 * dates (first occurrence wins ties), average the mean of closes, max
 * drawdown the worst peak-to-trough fall in percent.
 */
export function windowStats(bars: readonly ChartBar[]): Result<ChartStats, WindowStatsError> {
	const first = bars[0];
	if (first === undefined) return err("EMPTY_WINDOW");
	const last = bars[bars.length - 1];
	if (last === undefined) return err("EMPTY_WINDOW");
	let high: ChartStatPoint = { value: first.high, observedOn: first.observedOn, day: first.day };
	let low: ChartStatPoint = { value: first.low, observedOn: first.observedOn, day: first.day };
	let sum = 0;
	let peak = Number.NEGATIVE_INFINITY;
	let maxDrawdown = 0;
	let sawNonPositivePeak = false;
	for (const bar of bars) {
		if (
			!Number.isFinite(bar.open) ||
			!Number.isFinite(bar.high) ||
			!Number.isFinite(bar.low) ||
			!Number.isFinite(bar.close)
		) {
			return err("NON_FINITE");
		}
		if (bar.high > high.value) high = { value: bar.high, observedOn: bar.observedOn, day: bar.day };
		if (bar.low < low.value) low = { value: bar.low, observedOn: bar.observedOn, day: bar.day };
		sum += bar.close;
		if (bar.close > peak) peak = bar.close;
		if (!(peak > 0)) {
			sawNonPositivePeak = true;
		} else {
			const drawdown = ((peak - bar.close) / peak) * 100;
			if (drawdown > maxDrawdown) maxDrawdown = drawdown;
		}
	}
	const open = first.open;
	const close = last.close;
	const change = close - open;
	if (!Number.isFinite(change)) return err("NON_FINITE");
	const average = sum / bars.length;
	if (!Number.isFinite(average)) return err("NON_FINITE");
	return ok({
		open,
		close,
		change,
		percentChange: open === 0 ? null : (change / Math.abs(open)) * 100,
		high,
		low,
		average,
		maxDrawdown: sawNonPositivePeak ? null : maxDrawdown,
		bars: bars.length,
	});
}

/**
 * Rebase values to percent change from `base`: 0 % at the base, `null`
 * everywhere for a zero or non-finite base, `null` per non-finite value.
 * Total — the viewer renders a zero base as "unavailable (zero base)".
 */
export function rebasePercent(values: readonly number[], base: number): readonly (number | null)[] {
	if (!Number.isFinite(base) || base === 0) return values.map(() => null);
	const scale = Math.abs(base);
	return values.map((value) => {
		if (!Number.isFinite(value)) return null;
		const percent = ((value - base) / scale) * 100;
		return Number.isFinite(percent) ? percent : null;
	});
}
