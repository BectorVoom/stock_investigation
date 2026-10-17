import { type ChartBar, type DayWindow, movingAverage, visibleSlice } from "@research/domain";
import { formatAxisTick } from "../format.ts";
import { linearScale, niceTicks, type PlotArea, thinnedIndexes } from "./chartMath.ts";

/**
 * Pure render model for the detailed chart viewer (ADR-0025, phase 2).
 *
 * The domain package owns the algorithms (`resampleSeries`, window math,
 * `movingAverage`, `windowStats`); this module owns only the mapping from
 * resampled bars to SVG geometry. Nothing here touches the DOM, so the
 * decimation, log ticks and label thinning are unit-tested against
 * hand-computed fixtures. The Solid viewer memoizes this per window change;
 * resampling and moving averages are memoized one level up, per
 * (series, interval).
 */

export type DetailScale = "linear" | "log";
export type DetailValueMode = "value" | "percent";

export interface DetailSeriesInput {
	readonly key: string;
	readonly label: string;
	readonly color: string;
	/** Full resampled bars at the chosen interval (all held data, ascending). */
	readonly bars: readonly ChartBar[];
}

export interface DetailMaOverlayInput {
	readonly seriesKey: string;
	readonly color: string;
	readonly period: number;
	readonly label: string;
	/** Raw moving-average values aligned 1:1 with the series' full bars (`null` for the warm-up). */
	readonly days: readonly number[];
	readonly values: readonly (number | null)[];
}

export interface BuildDetailChartInput {
	readonly series: readonly DetailSeriesInput[];
	readonly window: DayWindow;
	/** Plot size in px (the SVG viewBox follows the container, so text never scales). */
	readonly plotWidth: number;
	readonly plotHeight: number;
	readonly scale: DetailScale;
	readonly mode: DetailValueMode;
	/** Simple-moving-average periods to overlay (only passed for one series). */
	readonly maPeriods: readonly number[];
	/**
	 * Precomputed moving averages, one entry per (series, interval, period).
	 * The viewer memoizes these outside the window-dependent model (ADR-0025
	 * performance), so a window change only re-slices; direct callers that
	 * omit this fall back to `maPeriods` computed over all held bars.
	 */
	readonly maOverlays?: readonly DetailMaOverlayInput[];
}

export interface DetailSeriesPath {
	readonly key: string;
	readonly label: string;
	readonly color: string;
	readonly d: string;
	/** Visible bars with a finite display value. */
	readonly plottedCount: number;
}

export interface DetailMaPath {
	readonly seriesKey: string;
	readonly period: number;
	readonly label: string;
	readonly color: string;
	readonly d: string;
}

export interface DetailXTick {
	readonly x: number;
	readonly label: string;
	/**
	 * Integer day number of the calendar boundary the tick marks (a day for
	 * day steps, a Monday for weekly, a month/quarter/year start above that).
	 * The tick sits at this day's time-proportional x, never snapped to a bar.
	 */
	readonly day: number;
}

export interface DetailLastMarker {
	readonly seriesKey: string;
	readonly label: string;
	readonly color: string;
	readonly displayValue: number;
	readonly day: number;
	readonly y: number;
}

/**
 * A last-value tag on the value axis (ADR-0025 fix round 4): the financial
 * platforms draw the last value as a small filled tag in the series colour
 * with light text, instead of plain text over the tick labels. `y` is the
 * de-overlapped centre, `x`/`width`/`height` the tag box in viewBox units.
 */
export interface DetailValueTag {
	readonly seriesKey: string;
	readonly text: string;
	readonly color: string;
	readonly value: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Vertical footprint of one value-axis label in px (12 px text plus tag
 * padding). Two labels closer than this overlap and unreadably collide —
 * the same threshold hides a tick label behind a tag and separates tags
 * from each other.
 */
export const VALUE_LABEL_HEIGHT = 16;
/** Horizontal padding inside a value tag, each side. */
const VALUE_TAG_PAD_X = 4;

export interface DetailSeriesValues {
	readonly key: string;
	/** Display values aligned with `dayAt` (null where the series has no bar, or the base is zero). */
	readonly values: readonly (number | null)[];
}

export interface DetailChartModel {
	readonly plot: PlotArea;
	/** Value mode the display values were computed in (readouts pair raw values with rebased percents). */
	readonly mode: DetailValueMode;
	readonly yTicks: readonly number[];
	readonly yTickLabels: readonly string[];
	/** Display value to pixel y. */
	readonly yFor: (value: number) => number;
	/** Day number to pixel x (time-proportional, so mixed dates align). */
	readonly xForDay: (day: number) => number;
	readonly xTicks: readonly DetailXTick[];
	readonly seriesPaths: readonly DetailSeriesPath[];
	readonly maPaths: readonly DetailMaPath[];
	readonly lastMarkers: readonly DetailLastMarker[];
	/** De-overlapped last-value tags on the value axis, sorted by y. */
	readonly lastValueTags: readonly DetailValueTag[];
	/** Series keys whose percent base is zero (rendered as "unavailable (zero base)"). */
	readonly zeroBaseKeys: readonly string[];
	/** Union of visible days across series, ascending. */
	readonly dayAt: readonly number[];
	readonly isoAt: readonly string[];
	readonly seriesValues: readonly DetailSeriesValues[];
	/** Raw closes aligned with `dayAt` (null where the series has no bar): readouts and the data table show these with the series unit, plus the rebased percent in percent mode. */
	readonly rawValues: readonly DetailSeriesValues[];
	/** Visible-relative union-day index nearest pixel x, or null when empty. */
	nearestBar(x: number): number | null;
}

export interface NavigatorInput {
	/** Ascending union days of all held bars (full data, not just visible). */
	readonly days: readonly number[];
	/** One value per day for the overview line (e.g. the longest series' closes). */
	readonly values: readonly number[];
	readonly window: DayWindow;
	readonly width: number;
	readonly height: number;
}

export interface NavigatorModel {
	readonly d: string;
	readonly windowLeft: number;
	readonly windowWidth: number;
	/** Day number to pixel x. */
	readonly xForDay: (day: number) => number;
}

/** Gutters around the plot: the value axis sits on the right, dates below. */
const PLOT_MARGIN = 8;
const AXIS_GUTTER_RIGHT = 64;
const AXIS_GUTTER_BOTTOM = 26;
/** Rough advance width of one tick character plus the gap that keeps labels apart. */
const TICK_CHAR_WIDTH = 7.5;
const TICK_MIN_GAP = 8;

function plotForSize(plotWidth: number, plotHeight: number): PlotArea {
	const width = Number.isFinite(plotWidth) ? Math.max(0, plotWidth) : 0;
	const height = Number.isFinite(plotHeight) ? Math.max(0, plotHeight) : 0;
	const left = PLOT_MARGIN;
	const top = PLOT_MARGIN;
	const right = Math.max(left + 10, width - AXIS_GUTTER_RIGHT);
	const bottom = Math.max(top + 10, height - AXIS_GUTTER_BOTTOM);
	return { left, right, top, bottom };
}

/**
 * Drawable plot width for a container width: the same gutters the render
 * model subtracts, so interval budgets (Auto's one-bar-per-3px rule) and the
 * rendered paths agree on the available pixels.
 */
export function plotWidthForSize(containerWidth: number): number {
	const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
	return Math.max(10, width - PLOT_MARGIN - AXIS_GUTTER_RIGHT);
}

/** First index with `days[index] >= day` (ascending days). */
function lowerBoundDay(days: readonly number[], day: number): number {
	let low = 0;
	let high = days.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const value = days[mid];
		if (value !== undefined && value < day) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** First index with `days[index] > day` (ascending days). */
function upperBoundDay(days: readonly number[], day: number): number {
	let low = 0;
	let high = days.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const value = days[mid];
		if (value !== undefined && value <= day) low = mid + 1;
		else high = mid;
	}
	return low;
}

export interface LogGateInput {
	readonly series: readonly DetailSeriesInput[];
	readonly window: DayWindow;
	readonly mode: DetailValueMode;
}

/**
 * True when a log scale cannot show the effective display values (after the
 * window and the value mode): any visible display value ≤ 0. Percent mode
 * always qualifies while a bar is visible, because the rebase puts 0 % at
 * the first visible bar. The viewer gates the Log option on this and switches
 * an already selected Log back to Linear with a status line.
 */
export function logScaleBlocked(input: LogGateInput): boolean {
	const from = Math.min(Math.trunc(input.window.from), Math.trunc(input.window.to));
	const to = Math.max(Math.trunc(input.window.from), Math.trunc(input.window.to));
	let sawBar = false;
	for (const entry of input.series) {
		const slice = visibleSlice(entry.bars, { from, to });
		if (slice.end > slice.start) sawBar = true;
		if (input.mode === "percent") continue;
		for (let index = slice.start; index < slice.end; index += 1) {
			const bar = entry.bars[index];
			if (bar !== undefined && !(bar.close > 0)) return true;
		}
	}
	if (!sawBar) return false;
	return input.mode === "percent";
}

/**
 * Ascending distinct bar days across every series: a merge of the already
 * ascending per-series day runs, O(total bars × series) with no sort. The
 * viewer memoizes this once per (series, interval), so window changes only
 * binary-search it (ADR-0025 performance).
 */
export function unionBarDays(barsList: readonly (readonly ChartBar[])[]): readonly number[] {
	let union: number[] = [];
	for (const bars of barsList) {
		const merged: number[] = [];
		let left = 0;
		let right = 0;
		const push = (day: number): void => {
			if (!Number.isFinite(day)) return;
			const last = merged[merged.length - 1];
			if (last === undefined || day > last) merged.push(day);
		};
		while (left < union.length || right < bars.length) {
			const a = union[left];
			const b = bars[right]?.day;
			if (b === undefined || (a !== undefined && a <= b)) {
				if (a !== undefined) push(a);
				left += 1;
			} else {
				push(b);
				right += 1;
			}
		}
		union = merged;
	}
	return union;
}

/**
 * Widens a window until it holds at least two bars of the current interval
 * (ADR-0025 interaction: the window is never narrower than two bars), judged
 * against real bar positions — a day-count minimum admits bar-less weekends.
 * `union` is the ascending distinct bar days of every series
 * (`unionBarDays`, memoized per interval), so one call is O(log bars). A
 * window overlapping exactly one bar grows to its nearest neighbour; a window
 * with no bars takes the nearest pair around it; data shorter than two bars
 * yields the whole extent. Total: invalid coordinates fall back to the
 * extent-clamped window.
 */
export function ensureTwoBarWindow(
	window: DayWindow,
	union: readonly number[],
	extent: DayWindow,
): DayWindow {
	const lo = Math.min(Math.trunc(extent.from), Math.trunc(extent.to));
	const hi = Math.max(Math.trunc(extent.from), Math.trunc(extent.to));
	if (
		!Number.isFinite(window.from) ||
		!Number.isFinite(window.to) ||
		!Number.isFinite(lo) ||
		!Number.isFinite(hi) ||
		hi < lo
	) {
		return { from: lo, to: hi };
	}
	const a = Math.min(Math.max(Math.trunc(window.from), lo), hi);
	const b = Math.min(Math.max(Math.trunc(window.to), lo), hi);
	const ordered = a <= b ? { from: a, to: b } : { from: b, to: a };
	if (union.length < 2) return { from: lo, to: hi };
	if (upperBoundDay(union, ordered.to) - lowerBoundDay(union, ordered.from) >= 2) return ordered;
	const insertion = lowerBoundDay(union, ordered.from);
	let first: number;
	let second: number;
	const inside = union[insertion];
	if (inside !== undefined && inside <= ordered.to) {
		// Exactly one bar inside: take its neighbour, preferring the next.
		if (insertion + 1 < union.length) {
			first = inside;
			second = union[insertion + 1] ?? inside;
		} else {
			first = union[insertion - 1] ?? inside;
			second = inside;
		}
	} else if (insertion <= 0) {
		first = union[0] ?? lo;
		second = union[1] ?? hi;
	} else if (insertion >= union.length) {
		first = union[union.length - 2] ?? lo;
		second = union[union.length - 1] ?? hi;
	} else {
		first = union[insertion - 1] ?? lo;
		second = union[insertion] ?? hi;
	}
	return { from: Math.min(first, second), to: Math.max(first, second) };
}

/**
 * Overview line for the navigator over the complete held-data extent: the
 * union of every series' bar days (ascending) with the longest series' closes
 * aligned onto it (`NaN` where the longest series has no bar that day, which
 * the navigator skips). Using only the longest series' own days would drop
 * held dates outside it and collapse older windows against the edge.
 */
export function unionOverview(barsList: readonly (readonly ChartBar[])[]): {
	readonly days: readonly number[];
	readonly values: readonly number[];
} {
	let longest: readonly ChartBar[] = [];
	for (const bars of barsList) {
		if (bars.length > longest.length) longest = bars;
	}
	const days = unionBarDays(barsList);
	const closeByDay = new Map<number, number>();
	for (const bar of longest) {
		if (!closeByDay.has(bar.day)) closeByDay.set(bar.day, bar.close);
	}
	return { days, values: days.map((day) => closeByDay.get(day) ?? Number.NaN) };
}

const MONTH_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/** Display value of a raw close: identity, or percent off the visible base. */
function displayOf(close: number, mode: DetailValueMode, base: number | null): number | null {
	if (!Number.isFinite(close)) return null;
	if (mode === "value") return close;
	if (base === null || !Number.isFinite(base) || base === 0) return null;
	const percent = ((close - base) / Math.abs(base)) * 100;
	return Number.isFinite(percent) ? percent : null;
}

/**
 * Ticks at nice values in log space: 1/2/5 × 10^n within the data range, so
 * the axis reads as round decades (10, 20, 50, 100) rather than fractional
 * powers. Over very wide ranges (more than twelve such ticks) it degrades to
 * powers of ten, thinned evenly.
 */
function logTicks(minValue: number, maxValue: number): readonly number[] {
	const low = Math.min(minValue, maxValue);
	const high = Math.max(minValue, maxValue);
	if (!(low > 0) || !Number.isFinite(high)) return [];
	if (low === high) return [low * 0.9, high * 1.1].filter((tick) => tick > 0);
	const firstExp = Math.floor(Math.log10(low));
	const lastExp = Math.ceil(Math.log10(high));
	if (!Number.isFinite(firstExp) || !Number.isFinite(lastExp)) return [low, high];
	if (lastExp - firstExp > 30) return [low, high];
	const generated: number[] = [];
	for (let exponent = firstExp - 1; exponent <= lastExp + 1; exponent += 1) {
		for (const mantissa of [1, 2, 5, 10]) {
			const tick = mantissa * 10 ** exponent;
			if (Number.isFinite(tick) && tick > 0) generated.push(tick);
		}
	}
	const ordered = [...new Set(generated)].sort((a, b) => a - b);
	// The run from the last nice tick at or below the data to the first at
	// or above it, so the ticks bound the axis like `niceTicks` does.
	let start = ordered.findIndex((tick) => tick >= low);
	if (start < 0) return [low, high];
	if (start > 0 && (ordered[start] ?? low) > low) start -= 1;
	const end = ordered.findIndex((tick) => tick >= high);
	if (end < 0) return [low, high];
	const run = ordered.slice(start, end + 1);
	if (run.length >= 2 && run.length <= 12) return run;
	const powers = ordered.filter((tick) => {
		const exponent = Math.log10(tick);
		return Number.isInteger(exponent);
	});
	if (powers.length >= 2 && powers.length <= 12) return powers;
	if (powers.length > 12) {
		const picked = thinnedIndexes(powers.length, 12).map((index) => powers[index]);
		const ticks: number[] = [];
		for (const tick of picked) if (tick !== undefined) ticks.push(tick);
		if (ticks.length >= 2) return ticks;
	}
	return [low, high];
}

interface DecimPoint {
	readonly x: number;
	readonly y: number;
}

/**
 * Min/max-per-pixel-column decimation: with more points than pixel columns,
 * each column keeps only its extreme values, so spikes are always drawn and
 * the path stays O(plot width). Fewer points than columns pass through
 * unchanged (never invents points).
 */
export function decimateToWidth(
	points: readonly DecimPoint[],
	plotLeft: number,
	plotWidth: number,
): readonly DecimPoint[] {
	const columns = Math.max(1, Math.floor(plotWidth));
	if (points.length <= columns || plotWidth <= 0) return points;
	const buckets = new Map<number, DecimPoint[]>();
	for (const point of points) {
		const column = Math.min(
			columns - 1,
			Math.max(0, Math.floor(((point.x - plotLeft) / plotWidth) * columns)),
		);
		const bucket = buckets.get(column);
		if (bucket === undefined) buckets.set(column, [point]);
		else bucket.push(point);
	}
	const kept: DecimPoint[] = [];
	for (const column of [...buckets.keys()].sort((a, b) => a - b)) {
		const bucket = buckets.get(column);
		if (bucket === undefined || bucket.length === 0) continue;
		if (bucket.length <= 2) {
			kept.push(...[...bucket].sort((a, b) => a.x - b.x));
			continue;
		}
		let lowest = bucket[0];
		let highest = bucket[0];
		for (const point of bucket) {
			const low = lowest;
			const high = highest;
			if (low !== undefined && point.y < low.y) lowest = point;
			if (high !== undefined && point.y > high.y) highest = point;
		}
		const low = lowest;
		const high = highest;
		if (low === undefined || high === undefined) continue;
		if (low.x === high.x && low.y === high.y) kept.push(low);
		else if (low.x <= high.x) kept.push(low, high);
		else kept.push(high, low);
	}
	return kept.sort((a, b) => a.x - b.x);
}

function pathOf(points: readonly DecimPoint[]): string {
	return points
		.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
		.join(" ");
}

/** True when no two labels touch (each pair keeps half both widths plus a gap). */
function labelsOverlap(ticks: readonly DetailXTick[]): boolean {
	const ordered = [...ticks].sort((a, b) => a.x - b.x);
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (previous === undefined || current === undefined) continue;
		const need =
			((previous.label.length + current.label.length) / 2) * TICK_CHAR_WIDTH + TICK_MIN_GAP;
		if (current.x - previous.x < need) return true;
	}
	return false;
}

/**
 * Date-axis steps from finest to coarsest (fix rounds 5 and 6): every N
 * days, then ISO-week Mondays, then month, quarter and half-year starts,
 * then year starts every 1, 2, 5, 10, 20, 50, … years (aligned to multiples
 * of N, so a decade axis reads 1970, 1980, …). The picker tries them in this
 * order and keeps the first whose labels are distinct and do not overlap at
 * the measured width — the financial-platform convention of ticks on
 * calendar boundaries instead of evenly thinned bars. The multi-year steps
 * keep decades of monthly data on a readable axis instead of collapsing to
 * one year-less label.
 */
export type DateAxisStep =
	| "day-1"
	| "day-2"
	| "day-5"
	| "weekly"
	| "day-10"
	| "monthly"
	| "quarterly"
	| "semiannual"
	| "yearly"
	| "year-2"
	| "year-5"
	| "year-10"
	| "year-20"
	| "year-50"
	| "year-100"
	| "year-200"
	| "year-500"
	| "year-1000";

const DATE_AXIS_STEPS: readonly DateAxisStep[] = [
	"day-1",
	"day-2",
	"day-5",
	"weekly",
	"day-10",
	"monthly",
	"quarterly",
	"semiannual",
	"yearly",
	"year-2",
	"year-5",
	"year-10",
	"year-20",
	"year-50",
	"year-100",
	"year-200",
	"year-500",
	"year-1000",
];

/** Months between boundaries of the month-based steps. */
const MONTH_STEP: { readonly [S in DateAxisStep]?: number } = {
	monthly: 1,
	quarterly: 3,
	semiannual: 6,
};

/** Years between boundaries of the year-based steps. */
const YEAR_STEP: { readonly [S in DateAxisStep]?: number } = {
	yearly: 1,
	"year-2": 2,
	"year-5": 5,
	"year-10": 10,
	"year-20": 20,
	"year-50": 50,
	"year-100": 100,
	"year-200": 200,
	"year-500": 500,
	"year-1000": 1000,
};

/**
 * Longest gap in days between two consecutive boundaries of a step. A
 * window of `span` days holds at least `floor(span / gap)` boundaries, which
 * lets the picker skip a step that cannot fit before enumerating it.
 */
function maxGapDays(step: DateAxisStep): number {
	const months = MONTH_STEP[step];
	if (months !== undefined) return months * 31;
	const years = YEAR_STEP[step];
	if (years !== undefined) return years * 366;
	if (step === "weekly") return 7;
	const every = Number(step.slice("day-".length));
	return Number.isSafeInteger(every) && every >= 1 ? every : 1;
}

/**
 * Narrowest centre distance any two labels can need: the shortest label
 * ("Jan") at the advance width plus the gap. More boundaries than the plot
 * width allows at this distance must overlap, whatever their labels.
 */
const MIN_LABEL_PAIR_PX = 3 * TICK_CHAR_WIDTH + TICK_MIN_GAP;

/**
 * More boundaries than this can never fit a real plot (each label pair needs
 * at least 30 px, so 2,000 ticks would want 60 m of pixels): enumeration stops
 * there and the step is skipped, which also bounds the work per window.
 */
const MAX_BOUNDARY_TICKS = 2000;

const MS_PER_DAY = 86_400_000;

/**
 * Integer day number of a civil date (UTC). `Date.UTC` remaps years 0000–0099
 * to 1900 + year, so those go through an explicit full-year setter — the same
 * repair the domain's day-number conversion applies.
 */
function dayOfCivilDate(year: number, monthOneBased: number, dayOfMonth: number): number {
	const remapped = Date.UTC(year, monthOneBased - 1, dayOfMonth);
	if (year >= 0 && year <= 99) {
		const repaired = new Date(remapped);
		repaired.setUTCFullYear(year);
		return Math.floor(repaired.getTime() / MS_PER_DAY);
	}
	return Math.floor(remapped / MS_PER_DAY);
}

/** Calendar parts (UTC) of an integer day number. */
function civilPartsOfDay(day: number): {
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

/** ISO weekday with Monday = 1 through Sunday = 7 (day 0, 1970-01-01, was a Thursday). */
function weekdayMondayOne(day: number): number {
	return ((((day + 3) % 7) + 7) % 7) + 1;
}

/**
 * Calendar boundaries of one step inside `[from, to]` (ascending, at most
 * `MAX_BOUNDARY_TICKS + 1` entries): day steps align to the epoch so a pan
 * keeps the ticks still, weeks land on Mondays, month-based steps land on the
 * first day of every 1st/3rd/6th month from January, and year-based steps on
 * 1 January of every year divisible by the step.
 */
function boundaryDays(from: number, to: number, step: DateAxisStep): number[] {
	const days: number[] = [];
	const push = (day: number): boolean => {
		if (day < from || day > to) return true;
		days.push(day);
		return days.length <= MAX_BOUNDARY_TICKS;
	};
	if (step === "weekly") {
		const shift = (8 - weekdayMondayOne(from)) % 7;
		for (let day = from + shift; day <= to; day += 7) {
			if (!push(day)) return days;
		}
		return days;
	}
	const years = YEAR_STEP[step];
	if (years !== undefined) {
		const start = civilPartsOfDay(from).year;
		const end = civilPartsOfDay(to).year;
		const first = Math.ceil(start / years) * years;
		for (let year = first; year <= end; year += years) {
			if (!push(dayOfCivilDate(year, 1, 1))) return days;
		}
		return days;
	}
	const months = MONTH_STEP[step];
	if (months !== undefined) {
		const start = civilPartsOfDay(from);
		const end = civilPartsOfDay(to);
		let year = start.year;
		let month = start.month;
		for (;;) {
			if (year > end.year || (year === end.year && month > end.month)) break;
			// Quarter and half-year starts are the January-aligned month starts.
			if ((month - 1) % months === 0) {
				if (!push(dayOfCivilDate(year, month, 1))) return days;
			}
			month += 1;
			if (month > 12) {
				month = 1;
				year += 1;
			}
		}
		return days;
	}
	const every = Number(step.slice("day-".length));
	if (!Number.isSafeInteger(every) || every < 1) return days;
	const remainder = ((from % every) + every) % every;
	const first = remainder === 0 ? from : from + (every - remainder);
	for (let day = first; day <= to; day += every) {
		if (!push(day)) return days;
	}
	return days;
}

/** "Oct 16", or "Oct 16, 2025" when the year is added. */
function dayTickLabel(day: number, withYear: boolean): string {
	const parts = civilPartsOfDay(day);
	const month = MONTH_SHORT[parts.month - 1] ?? String(parts.month);
	return withYear ? `${month} ${parts.day}, ${parts.year}` : `${month} ${parts.day}`;
}

/**
 * Day and week labels ("Oct 16"; weeks land on Mondays: "Oct 13"). When the
 * window crosses a calendar year, the first tick and the first tick of every
 * new year carry their year ("Oct 19, 2025" … "Jan 4, 2026"), so a 1Y axis is
 * never a run of year-less dates whose two Octobers read alike.
 */
function dayTickLabels(days: readonly number[], multiYear: boolean): string[] {
	let previousYear: number | null = null;
	return days.map((day) => {
		const year = civilPartsOfDay(day).year;
		const withYear = multiYear && year !== previousYear;
		previousYear = year;
		return dayTickLabel(day, withYear);
	});
}

/**
 * Month, quarter and half-year labels: bare month ("Aug") with the year added
 * at January and at the first tick ("Jan 2026"), so a short window stays
 * glanceable. When the window spans years and the short forms would repeat a
 * month, every tick carries its year ("Aug 2025") instead — still distinct,
 * never ambiguous.
 */
function monthTickLabels(days: readonly number[]): string[] {
	const parts = days.map(civilPartsOfDay);
	const short = parts.map((entry, index) => {
		const month = MONTH_SHORT[entry.month - 1] ?? String(entry.month);
		return index === 0 || entry.month === 1 ? `${month} ${entry.year}` : month;
	});
	if (new Set(short).size === short.length) return short;
	return parts.map((entry) => {
		const month = MONTH_SHORT[entry.month - 1] ?? String(entry.month);
		return `${month} ${entry.year}`;
	});
}

/** Year labels read as "2026". */
function yearTickLabel(day: number): string {
	return String(civilPartsOfDay(day).year);
}

function labelsForStep(step: DateAxisStep, days: readonly number[], multiYear: boolean): string[] {
	if (YEAR_STEP[step] !== undefined) return days.map(yearTickLabel);
	if (MONTH_STEP[step] !== undefined) return monthTickLabels(days);
	return dayTickLabels(days, multiYear);
}

/**
 * Ticks on calendar boundaries for the window, finest fitting step first: a
 * step wins when it contributes at least two ticks whose labels are distinct
 * and clear each other at the measured width. A step that is too dense (past
 * `MAX_BOUNDARY_TICKS`, or more boundaries than the plot can separate) or
 * repeats a label never wins — the axis degrades to coarser boundaries (up to
 * millennia) instead of collisions. When no step fits twice (a tiny plot) the
 * finest single boundary stands in; when the window holds no boundary at any
 * step (a sub-day window) the middle day names itself, which is itself a
 * day-step boundary. A window crossing a calendar year always names a year on
 * its first tick, in every branch.
 */
function pickXTicks(
	fromDay: number,
	toDay: number,
	xForDay: (day: number) => number,
	plot: PlotArea,
): readonly DetailXTick[] {
	const from = Math.min(Math.trunc(fromDay), Math.trunc(toDay));
	const to = Math.max(Math.trunc(fromDay), Math.trunc(toDay));
	if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
	const plotWidth = plot.right - plot.left;
	if (!(plotWidth > 0)) return [];
	const multiYear = civilPartsOfDay(from).year !== civilPartsOfDay(to).year;
	// At most this many ticks can clear each other inside the plot.
	const fitCount = Math.floor(plotWidth / MIN_LABEL_PAIR_PX) + 1;
	const nudge = (x: number, label: string): number => {
		const half = (label.length * TICK_CHAR_WIDTH) / 2;
		return Math.min(Math.max(x, plot.left + half), plot.right - half);
	};
	let fallback: DetailXTick[] = [];
	for (const step of DATE_AXIS_STEPS) {
		// Cheap lower bound on the boundary count: skip a step that cannot fit
		// before enumerating up to 2,000 boundaries for it.
		const atLeast = Math.floor((to - from) / maxGapDays(step));
		if (atLeast > fitCount || atLeast > MAX_BOUNDARY_TICKS) continue;
		const days = boundaryDays(from, to, step);
		if (days.length === 0 || days.length > MAX_BOUNDARY_TICKS) continue;
		const labels = labelsForStep(step, days, multiYear);
		if (new Set(labels).size !== labels.length) continue;
		const ticks: DetailXTick[] = [];
		for (let index = 0; index < days.length; index += 1) {
			const day = days[index];
			const label = labels[index];
			if (day === undefined || label === undefined) continue;
			ticks.push({ x: nudge(xForDay(day), label), label, day });
		}
		if (ticks.length !== days.length) continue;
		if (ticks.length < 2) {
			if (fallback.length === 0) fallback = ticks;
			continue;
		}
		if (!labelsOverlap(ticks)) return ticks;
	}
	if (fallback.length > 0) return fallback;
	const middle = Math.round((from + to) / 2);
	const label = dayTickLabel(middle, multiYear);
	return [{ x: nudge(xForDay(middle), label), label, day: middle }];
}

/**
 * True when a y tick label at `tickY` would collide with a last-value tag
 * or — while the crosshair is shown — with the crosshair value label at
 * `crosshairY`. Overlap is a vertical pixel distance below one label
 * height, the same threshold that separates the tags from each other.
 */
export function isValueLabelHidden(
	tickY: number,
	tagYs: readonly number[],
	crosshairY: number | null,
): boolean {
	if (!Number.isFinite(tickY)) return false;
	for (const tagY of tagYs) {
		if (Number.isFinite(tagY) && Math.abs(tickY - tagY) < VALUE_LABEL_HEIGHT) return true;
	}
	if (
		crosshairY !== null &&
		Number.isFinite(crosshairY) &&
		Math.abs(tickY - crosshairY) < VALUE_LABEL_HEIGHT
	) {
		return true;
	}
	return false;
}

/**
 * Nudges sorted tag centres apart so no two overlap, keeping every tag
 * inside the plot. A forward pass enforces one label height of gap, a
 * backward pass pulls the run back inside the bottom edge, and a final
 * clamp holds a taller-than-plot stack at the edges. O(tags); at most one
 * tag per series.
 */
export function layoutTagCenters(sortedYs: readonly number[], plot: PlotArea): readonly number[] {
	const half = VALUE_LABEL_HEIGHT / 2;
	const top = plot.top + half;
	const bottom = plot.bottom - half;
	if (sortedYs.length === 0 || !(top <= bottom)) return [...sortedYs];
	const placed = sortedYs.map((y) =>
		Number.isFinite(y) ? Math.min(Math.max(y, top), bottom) : top,
	);
	for (let index = 1; index < placed.length; index += 1) {
		const previous = placed[index - 1];
		const current = placed[index];
		if (previous === undefined || current === undefined) continue;
		if (current - previous < VALUE_LABEL_HEIGHT) placed[index] = previous + VALUE_LABEL_HEIGHT;
	}
	for (let index = placed.length - 1; index >= 0; index -= 1) {
		const current = placed[index];
		if (current === undefined) continue;
		if (current > bottom) placed[index] = bottom;
		if (index + 1 < placed.length) {
			const next = placed[index + 1];
			if (next !== undefined && next - (placed[index] ?? next) < VALUE_LABEL_HEIGHT) {
				placed[index] = next - VALUE_LABEL_HEIGHT;
			}
		}
	}
	return placed.map((y) => Math.min(Math.max(y, top), bottom));
}

/**
 * Visible-relative union-day index nearest pixel x, by binary search over the
 * ascending pixel positions (O(log n), never a scan over all bars).
 */
function nearestDayIndex(xs: readonly number[], x: number): number | null {
	if (xs.length === 0) return null;
	let low = 0;
	let high = xs.length - 1;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const value = xs[mid];
		if (value === undefined || value < x) low = mid + 1;
		else high = mid;
	}
	const atLow = xs[low];
	if (atLow === undefined) return null;
	if (low > 0) {
		const before = xs[low - 1];
		if (before !== undefined && Math.abs(before - x) <= Math.abs(atLow - x)) return low - 1;
	}
	return low;
}

/**
 * Builds every SVG path for the viewer at one window: visible bars plus one
 * bar either side per series (so lines meet the plot edge instead of stopping
 * short), decimated per pixel column. Null when nothing is plottable (empty
 * window, or no positive value on a log scale).
 */
export function buildDetailChartModel(input: BuildDetailChartInput): DetailChartModel | null {
	const plot = plotForSize(input.plotWidth, input.plotHeight);
	const plotWidth = plot.right - plot.left;
	const from = Math.min(Math.trunc(input.window.from), Math.trunc(input.window.to));
	const to = Math.max(Math.trunc(input.window.from), Math.trunc(input.window.to));

	const usable = (value: number | null | undefined): value is number => {
		if (value === null || value === undefined || !Number.isFinite(value)) return false;
		return input.scale !== "log" || value > 0;
	};

	interface SeriesWork {
		readonly entry: DetailSeriesInput;
		readonly start: number;
		readonly end: number;
		readonly base: number | null;
		readonly zeroBase: boolean;
		/** Display values of the visible bars (extended range handled below). */
		readonly visibleDays: readonly number[];
		readonly visibleValues: readonly (number | null)[];
		/** Raw closes of the visible bars, parallel to `visibleDays`. */
		readonly visibleRaw: readonly number[];
	}
	const works: SeriesWork[] = [];
	for (const entry of input.series) {
		const slice = visibleSlice(entry.bars, { from, to });
		const first = entry.bars[slice.start];
		const base = first === undefined ? null : first.close;
		const zeroBase = input.mode === "percent" && (base === null || base === 0);
		const visibleDays: number[] = [];
		const visibleValues: (number | null)[] = [];
		const visibleRaw: number[] = [];
		for (let index = slice.start; index < slice.end; index += 1) {
			const bar = entry.bars[index];
			if (bar === undefined) continue;
			visibleDays.push(bar.day);
			visibleValues.push(displayOf(bar.close, input.mode, base));
			visibleRaw.push(Number.isFinite(bar.close) ? bar.close : Number.NaN);
		}
		works.push({
			entry,
			start: slice.start,
			end: slice.end,
			base,
			zeroBase,
			visibleDays,
			visibleValues,
			visibleRaw,
		});
	}

	// Union of visible days across series (ascending), with one ISO label each.
	const dayToIso = new Map<number, string>();
	for (const work of works) {
		for (let index = work.start; index < work.end; index += 1) {
			const bar = work.entry.bars[index];
			if (bar !== undefined && !dayToIso.has(bar.day)) dayToIso.set(bar.day, bar.observedOn);
		}
	}
	const dayAt = [...dayToIso.keys()].sort((a, b) => a - b);
	if (dayAt.length === 0) return null;
	const isoAt = dayAt.map((day) => dayToIso.get(day) ?? String(day));
	const dayIndex = new Map(dayAt.map((day, index) => [day, index] as const));

	// Display values per series, aligned with the union days (for the readout).
	const seriesValues: DetailSeriesValues[] = works.map((work) => {
		const values: (number | null)[] = dayAt.map(() => null);
		for (let position = 0; position < work.visibleDays.length; position += 1) {
			const day = work.visibleDays[position];
			const value = work.visibleValues[position];
			if (day === undefined) continue;
			const slot = dayIndex.get(day);
			if (slot === undefined) continue;
			values[slot] = value ?? null;
		}
		return { key: work.entry.key, values };
	});

	// Raw closes per series, aligned with the union days: readouts and the
	// data table show these with the series unit (plus the rebased percent in
	// percent mode), and previous-bar returns come from these, never from the
	// rebased display values.
	const rawValues: DetailSeriesValues[] = works.map((work) => {
		const values: (number | null)[] = dayAt.map(() => null);
		for (let position = 0; position < work.visibleDays.length; position += 1) {
			const day = work.visibleDays[position];
			const raw = work.visibleRaw[position];
			if (day === undefined || raw === undefined) continue;
			const slot = dayIndex.get(day);
			if (slot === undefined) continue;
			values[slot] = Number.isFinite(raw) ? raw : null;
		}
		return { key: work.entry.key, values };
	});

	// Moving averages over all held bars (so the first visible bars already
	// have a value), rebased with the same base in percent mode. The viewer
	// passes precomputed overlays memoized per (series, interval, period), so
	// a window change never recomputes them; direct callers fall back to
	// `maPeriods` computed here. Either way only the series' binary-search
	// slice ±1 is copied and rebased: a window change costs the visible bars,
	// never every held average.
	interface MaWork {
		readonly seriesKey: string;
		readonly color: string;
		readonly period: number;
		readonly label: string;
		/** Days and display values of the visible slice plus one bar either side. */
		readonly days: readonly number[];
		readonly values: readonly (number | null)[];
		/** The visible range inside `days`/`values` (`[start, end)`). */
		readonly start: number;
		readonly end: number;
	}
	const sliceOverlay = (
		work: SeriesWork,
		allDays: readonly number[],
		allValues: readonly (number | null)[],
	): {
		readonly days: number[];
		readonly values: (number | null)[];
		readonly start: number;
		readonly end: number;
	} => {
		const size = Math.min(allDays.length, allValues.length);
		const edgeStart = Math.min(size, Math.max(0, work.start - 1));
		const edgeEnd = Math.min(size, work.end + 1);
		const days: number[] = [];
		const values: (number | null)[] = [];
		for (let index = edgeStart; index < edgeEnd; index += 1) {
			const day = allDays[index];
			if (day === undefined) continue;
			const value = allValues[index];
			days.push(day);
			values.push(
				value === null || value === undefined ? null : displayOf(value, input.mode, work.base),
			);
		}
		const start = Math.min(days.length, Math.max(0, work.start - edgeStart));
		const end = Math.min(days.length, Math.max(start, work.end - edgeStart));
		return { days, values, start, end };
	};
	const workByKey = new Map(works.map((work) => [work.entry.key, work] as const));
	const maWorks: MaWork[] = [];
	const overlays = input.maOverlays;
	if (overlays !== undefined && overlays.length > 0) {
		for (const overlay of overlays) {
			const work = workByKey.get(overlay.seriesKey);
			if (work === undefined) continue;
			maWorks.push({
				seriesKey: overlay.seriesKey,
				color: overlay.color,
				period: overlay.period,
				label: overlay.label,
				...sliceOverlay(work, overlay.days, overlay.values),
			});
		}
	} else {
		for (const work of works) {
			if (input.maPeriods.length === 0) break;
			const closes = work.entry.bars.map((bar) => bar.close);
			const days = work.entry.bars.map((bar) => bar.day);
			for (const period of input.maPeriods) {
				const averaged = movingAverage(closes, period);
				if (!averaged.ok) continue;
				maWorks.push({
					seriesKey: work.entry.key,
					color: work.entry.color,
					period,
					label: `MA ${period}`,
					...sliceOverlay(work, days, averaged.value),
				});
			}
		}
	}
	// Y domain over the visible display values (series plus overlays).
	const domainValues: number[] = [];
	const collectVisible = (days: readonly number[], values: readonly (number | null)[]): void => {
		for (let index = 0; index < values.length; index += 1) {
			const day = days[index];
			const value = values[index];
			if (day === undefined || !usable(value)) continue;
			if (day >= from && day <= to) domainValues.push(value);
		}
	};
	for (const work of works) collectVisible(work.visibleDays, work.visibleValues);
	// Overlays reuse the binary-search slice bounds, never a scan over all held bars.
	for (const ma of maWorks) {
		for (let index = ma.start; index < ma.end; index += 1) {
			const value = ma.values[index];
			if (usable(value)) domainValues.push(value);
		}
	}
	// No plottable value (e.g. every percent base is zero): still return the
	// frame — days, ticks, zero-base flags — so the viewer states the reason
	// instead of a blank area. Log has no axis without a positive value.
	const emptyFrame = domainValues.length === 0;
	if (emptyFrame && input.scale === "log") return null;
	// A loop, not `Math.min(...values)`: spreading tens of thousands of
	// visible values as arguments can overflow the call stack.
	let minValue = emptyFrame ? 0 : Number.POSITIVE_INFINITY;
	let maxValue = emptyFrame ? 1 : Number.NEGATIVE_INFINITY;
	for (const value of domainValues) {
		if (value < minValue) minValue = value;
		if (value > maxValue) maxValue = value;
	}

	const yTicks: readonly number[] =
		input.scale === "log" ? logTicks(minValue, maxValue) : niceTicks(minValue, maxValue, 5);
	if (yTicks.length === 0) return null;
	const tickLow = yTicks[0];
	const tickHigh = yTicks[yTicks.length - 1];
	if (tickLow === undefined || tickHigh === undefined) return null;
	const yFor =
		input.scale === "log"
			? (() => {
					const logLow = Math.log10(Math.max(tickLow, Number.MIN_VALUE));
					const logHigh = Math.log10(Math.max(tickHigh, Number.MIN_VALUE));
					const scale = linearScale(logLow, logHigh, plot.bottom, plot.top);
					return (value: number): number => (value > 0 ? scale(Math.log10(value)) : plot.bottom);
				})()
			: linearScale(tickLow, tickHigh, plot.bottom, plot.top);
	const yTickLabels = yTicks.map((tick) =>
		input.mode === "percent" ? `${formatAxisTick(tick)}%` : formatAxisTick(tick),
	);

	const xForDay = linearScale(from, to, plot.left, plot.right);

	// Paths over the visible bars plus one bar either side per series, so
	// lines meet the plot edge instead of stopping short. Only the
	// binary-searched slice ±1 is ever touched (never a map over all held
	// bars); the visible points are decimated on their own, and the outside
	// neighbours are stitched on afterwards undecimated — folding a neighbour
	// into the boundary pixel column would let it displace a visible extreme.
	const pointsForRange = (
		days: readonly number[],
		values: readonly (number | null)[],
		start: number,
		end: number,
	): DecimPoint[] => {
		const points: DecimPoint[] = [];
		for (let index = start; index < end; index += 1) {
			const day = days[index];
			const value = values[index];
			if (day === undefined || !usable(value)) continue;
			points.push({ x: xForDay(day), y: yFor(value) });
		}
		return points;
	};
	const stitchedPath = (
		days: readonly number[],
		values: readonly (number | null)[],
		start: number,
		end: number,
		size: number,
	): string => {
		const edgeStart = Math.max(0, start - 1);
		const edgeEnd = Math.min(size, end + 1);
		const visibleStart = start - edgeStart;
		const visibleEnd = visibleStart + (end - start);
		const before = pointsForRange(days, values, 0, visibleStart);
		const visible = pointsForRange(days, values, visibleStart, visibleEnd);
		const after = pointsForRange(days, values, visibleEnd, edgeEnd - edgeStart);
		const stitched = [
			...before.slice(-1),
			...decimateToWidth(visible, plot.left, plotWidth),
			...after.slice(0, 1),
		];
		return pathOf(stitched);
	};
	const seriesPaths: DetailSeriesPath[] = works.map((work) => {
		const bars = work.entry.bars;
		const size = bars.length;
		const edgeStart = Math.max(0, work.start - 1);
		const edgeEnd = Math.min(size, work.end + 1);
		const days: number[] = [];
		const values: (number | null)[] = [];
		for (let index = edgeStart; index < edgeEnd; index += 1) {
			const bar = bars[index];
			if (bar === undefined) continue;
			days.push(bar.day);
			values.push(displayOf(bar.close, input.mode, work.base));
		}
		let plottedCount = 0;
		for (const value of work.visibleValues) if (usable(value)) plottedCount += 1;
		return {
			key: work.entry.key,
			label: work.entry.label,
			color: work.entry.color,
			d: stitchedPath(days, values, work.start - edgeStart, work.end - edgeStart, days.length),
			plottedCount,
		};
	});
	const maPaths: DetailMaPath[] = maWorks.map((ma) => ({
		seriesKey: ma.seriesKey,
		period: ma.period,
		label: ma.label,
		color: ma.color,
		d: stitchedPath(ma.days, ma.values, ma.start, ma.end, ma.days.length),
	}));

	const lastMarkers: DetailLastMarker[] = [];
	for (const work of works) {
		for (let index = work.visibleValues.length - 1; index >= 0; index -= 1) {
			const value = work.visibleValues[index];
			const day = work.visibleDays[index];
			if (!usable(value) || day === undefined) continue;
			lastMarkers.push({
				seriesKey: work.entry.key,
				label: work.entry.label,
				color: work.entry.color,
				displayValue: value,
				day,
				y: yFor(value),
			});
			break;
		}
	}

	// Last-value tags, de-overlapped: the raw marker dots stay on the line,
	// while the axis tags nudge apart so no two tags share a label height.
	// Sorted by y so the layout pass and the reading order agree.
	const tagTextOf = (value: number): string =>
		input.mode === "percent" ? `${formatAxisTick(value)}%` : formatAxisTick(value);
	const orderedMarkers = [...lastMarkers].sort((a, b) => a.y - b.y);
	const placedYs = layoutTagCenters(
		orderedMarkers.map((marker) => marker.y),
		plot,
	);
	const lastValueTags: DetailValueTag[] = orderedMarkers.flatMap((marker, index) => {
		const y = placedYs[index];
		if (y === undefined) return [];
		const text = tagTextOf(marker.displayValue);
		const width = text.length * TICK_CHAR_WIDTH + VALUE_TAG_PAD_X * 2;
		return [
			{
				seriesKey: marker.seriesKey,
				text,
				color: marker.color,
				value: marker.displayValue,
				x: plot.right + 2,
				y,
				width,
				height: VALUE_LABEL_HEIGHT,
			},
		];
	});

	const xTicks = pickXTicks(from, to, xForDay, plot);
	const xs = dayAt.map((day) => xForDay(day));

	return {
		plot,
		mode: input.mode,
		yTicks,
		yTickLabels,
		yFor,
		xForDay,
		xTicks,
		seriesPaths,
		maPaths,
		lastMarkers,
		lastValueTags,
		zeroBaseKeys: works.filter((work) => work.zeroBase).map((work) => work.entry.key),
		dayAt,
		isoAt,
		seriesValues,
		rawValues,
		nearestBar: (x: number) => nearestDayIndex(xs, x),
	};
}

/**
 * The navigator's overview line over all held data (ADR-0025 layout §5):
 * depends only on the held days, values and measured size, so the viewer
 * memoizes it apart from the window — a pan or zoom never rebuilds it.
 */
export interface NavigatorOverview {
	readonly d: string;
	/** First and last held day: the overview's x domain. */
	readonly first: number;
	readonly last: number;
	/** Day number to pixel x. */
	readonly xForDay: (day: number) => number;
}

export interface NavigatorOverviewInput {
	readonly days: readonly number[];
	readonly values: readonly number[];
	readonly width: number;
	readonly height: number;
}

const NAVIGATOR_PAD = 2;

export function buildNavigatorOverview(input: NavigatorOverviewInput): NavigatorOverview | null {
	if (input.days.length === 0 || input.width <= 0 || input.height <= 0) return null;
	const first = input.days[0];
	const last = input.days[input.days.length - 1];
	if (first === undefined || last === undefined) return null;
	const pad = NAVIGATOR_PAD;
	const xForDay = linearScale(first, last, pad, Math.max(pad + 1, input.width - pad));
	let low = Number.POSITIVE_INFINITY;
	let high = Number.NEGATIVE_INFINITY;
	for (const value of input.values) {
		if (!Number.isFinite(value)) continue;
		if (value < low) low = value;
		if (value > high) high = value;
	}
	if (!(low <= high)) return null;
	const yFor = linearScale(low, high, Math.max(pad + 1, input.height - pad), pad);
	const points: DecimPoint[] = [];
	for (let index = 0; index < input.days.length; index += 1) {
		const day = input.days[index];
		const value = input.values[index];
		if (day === undefined || value === undefined || !Number.isFinite(value)) continue;
		points.push({ x: xForDay(day), y: yFor(value) });
	}
	return {
		d: pathOf(decimateToWidth(points, pad, Math.max(1, input.width - pad * 2))),
		first,
		last,
		xForDay,
	};
}

/**
 * The visible window as a rectangle over an overview: O(1), the only
 * navigator work a window change does. The window is expressed in the same
 * day numbers the domain clamps, so drags resize through `clampWindow`.
 */
export function navigatorWindowRect(
	overview: NavigatorOverview,
	window: DayWindow,
): { readonly windowLeft: number; readonly windowWidth: number } {
	const from = Math.min(Math.trunc(window.from), Math.trunc(window.to));
	const to = Math.max(Math.trunc(window.from), Math.trunc(window.to));
	const left = overview.xForDay(Math.min(Math.max(from, overview.first), overview.last));
	const right = overview.xForDay(Math.min(Math.max(to, overview.first), overview.last));
	return {
		windowLeft: Math.min(left, right),
		windowWidth: Math.max(4, Math.abs(right - left)),
	};
}

/**
 * Overview model for the navigator: one decimated line over all held data
 * plus the visible window as a rectangle (the composition of
 * `buildNavigatorOverview` and `navigatorWindowRect`).
 */
export function buildNavigatorModel(input: NavigatorInput): NavigatorModel | null {
	const overview = buildNavigatorOverview(input);
	if (overview === null) return null;
	const rect = navigatorWindowRect(overview, input.window);
	return {
		d: overview.d,
		windowLeft: rect.windowLeft,
		windowWidth: rect.windowWidth,
		xForDay: overview.xForDay,
	};
}
