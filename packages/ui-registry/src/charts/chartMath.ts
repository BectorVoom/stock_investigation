import type { Dataset, DatasetCell } from "@research/contracts";
import type { PresentedLabels } from "../datasetGuard.ts";
import { formatIsoDate, truncateLabel } from "../format.ts";

/**
 * Pure chart geometry. Nothing here touches the DOM, so the plotted/unavailable
 * accounting can be tested against hand-computed fixtures.
 */

export interface PlotArea {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

export const VIEW_WIDTH = 640;
export const VIEW_HEIGHT = 320;
/** Chart text size in viewBox units; the SVG scales with its container. */
export const FONT_SIZE = 13;
/** Rough advance width of one character at FONT_SIZE, used to keep tick labels apart. */
const APPROX_CHAR_WIDTH = 7.5;
const TICK_LABEL_GAP = 14;
export const DEFAULT_PLOT: PlotArea = { left: 64, right: 624, top: 14, bottom: 262 };
/** Plot area that leaves a right-hand gutter for direct end-of-line labels. */
export const LABELLED_PLOT: PlotArea = { ...DEFAULT_PLOT, right: 520 };

/** Smallest type an axis title may shrink to before it is shortened instead. */
const MIN_AXIS_TITLE_FONT_SIZE = 10;

export interface FittedAxisTitle {
	readonly text: string;
	readonly fontSize: number;
	/** True when `text` is shortened; the full title then goes in a tooltip. */
	readonly truncated: boolean;
}

/**
 * Fits an axis title along `available` viewBox units (the rotated y title
 * runs along the plot height): first at `FONT_SIZE`, then in smaller type
 * down to `MIN_AXIS_TITLE_FONT_SIZE`, and only then shortened with an
 * ellipsis — never drawn past the plot, where it would be cut by the chart
 * edge.
 */
export function fitAxisTitle(title: string, available: number): FittedAxisTitle {
	const widthAt = (fontSize: number, chars: number) =>
		chars * APPROX_CHAR_WIDTH * (fontSize / FONT_SIZE);
	if (widthAt(FONT_SIZE, title.length) <= available) {
		return { text: title, fontSize: FONT_SIZE, truncated: false };
	}
	const shrunk = Math.floor((available / widthAt(FONT_SIZE, title.length)) * FONT_SIZE);
	if (shrunk >= MIN_AXIS_TITLE_FONT_SIZE) {
		return { text: title, fontSize: shrunk, truncated: false };
	}
	const maxChars = Math.max(1, Math.floor(available / widthAt(MIN_AXIS_TITLE_FONT_SIZE, 1)));
	return {
		text: truncateLabel(title, maxChars),
		fontSize: MIN_AXIS_TITLE_FONT_SIZE,
		truncated: true,
	};
}

/**
 * Categorical series colors in fixed slot order (never cycled; the props schema
 * caps a chart at 8 series). Validated for adjacent-pair CVD separation on the
 * light chart surface; three slots are below 3:1 contrast, which is why every
 * chart also ships a legend and a data-table twin.
 */
export const SERIES_COLORS = [
	"#2a78d6",
	"#eb6834",
	"#1baf7a",
	"#eda100",
	"#e87ba4",
	"#008300",
	"#6250d6",
	"#e34948",
] as const;

export const CHART_INK = {
	surface: "#fcfcfb",
	primary: "#0b0b0b",
	secondary: "#52514e",
	/**
	 * Recessive but visible: the grid is 1.5:1 against the surface (as a
	 * slate-300 hairline on white) and the zero line / x-axis baseline 2.3:1,
	 * one clear step above the grid and still well below text.
	 */
	grid: "#d3d2ca",
	axis: "#a9a89e",
	/**
	 * Inverse text on a series-colour value tag (ADR-0025 fix round 4): the
	 * last-value tags use the series colour as their fill, so the label has
	 * to be light. White on the darker series colours clears 4.5:1; on the
	 * two lightest slots it is still the financial-platform convention and
	 * is always paired with the marker dot and the readout line.
	 */
	tagText: "#ffffff",
} as const;

export function seriesColor(seriesIndex: number): string {
	return SERIES_COLORS[seriesIndex] ?? CHART_INK.secondary;
}

/** A plottable number: finite numeric cells only. Text and null are never coerced (DATA-011). */
export function numericCell(cell: DatasetCell | undefined): number | null {
	return cell !== undefined && typeof cell.v === "number" && Number.isFinite(cell.v)
		? cell.v
		: null;
}

export function cellText(cell: DatasetCell | undefined): string | null {
	if (cell === undefined || cell.v === null) return null;
	return typeof cell.v === "number" ? String(cell.v) : cell.v;
}

/** Upper bound on axis ticks; `niceTicks` never returns more, whatever the data. */
export const MAX_TICKS = 12;

/** 1, 2 or 5 times a power of ten at or above `rawStep`; 0 or Infinity when that is not representable. */
function niceStep(rawStep: number): number {
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	const normalized = rawStep / magnitude;
	const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	return nice * magnitude;
}

/**
 * Tick values covering [min, max]; the first and last tick bound the axis
 * domain. Total for every pair of finite numbers: it always returns between 1
 * and MAX_TICKS finite, strictly ascending values, and never loops on a value
 * derived from the data. Where round ticks cannot be represented (denormal or
 * near-overflow ranges, or a span below the numbers' own precision) it falls
 * back to the bounds themselves, or to a single tick for a flat domain.
 */
export function niceTicks(min: number, max: number, targetCount = 5): readonly number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
	let low = Math.min(min, max);
	let high = Math.max(min, max);
	if (low === high) {
		// Pad a flat series so its line sits mid-axis. The padding can underflow to nothing
		// (denormals) or overflow (near MAX_VALUE): then the axis is the single value.
		const pad = low === 0 ? 1 : Math.abs(low) * 0.1;
		const paddedLow = low - pad;
		const paddedHigh = high + pad;
		if (!Number.isFinite(paddedLow) || !Number.isFinite(paddedHigh) || paddedLow >= paddedHigh) {
			return [low];
		}
		low = paddedLow;
		high = paddedHigh;
	}
	const bounds = [low, high];
	const span = high - low;
	if (!Number.isFinite(span) || span <= 0) return bounds;
	const intervals = Math.min(MAX_TICKS - 2, Math.max(1, Math.floor(targetCount)));
	const step = niceStep(span / (Number.isFinite(intervals) ? intervals : 5));
	if (!Number.isFinite(step) || step <= 0) return bounds;
	// toPrecision removes binary floating-point noise such as 0.30000000000000004.
	const tickAt = (index: number) => Number((index * step).toPrecision(12));
	let first = Math.floor(low / step);
	let last = Math.ceil(high / step);
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return bounds;
	// A bound one rounding error away from a tick gets one more tick rather than being cut off.
	if (tickAt(first) > low) first -= 1;
	if (tickAt(last) < high) last += 1;
	const count = last - first + 1;
	if (!Number.isSafeInteger(count) || count < 2 || count > MAX_TICKS) return bounds;

	const ticks: number[] = [];
	// `count` is an integer of at most MAX_TICKS, so this loop is bounded by construction.
	for (let offset = 0; offset < count; offset += 1) {
		const tick = tickAt(first + offset);
		const previous = ticks[ticks.length - 1];
		if (!Number.isFinite(tick) || (previous !== undefined && tick <= previous)) return bounds;
		ticks.push(tick);
	}
	const firstTick = ticks[0];
	const lastTick = ticks[ticks.length - 1];
	// Rounding to 12 digits may not move a bound inside the data it has to contain.
	if (firstTick === undefined || lastTick === undefined || firstTick > low || lastTick < high) {
		return bounds;
	}
	return ticks;
}

export type Scale = (value: number) => number;

/**
 * Maps [domainMin, domainMax] onto [rangeStart, rangeEnd]. Always returns a
 * finite position for a finite value inside the domain: a flat domain maps to
 * the middle of the range, and a domain too wide to subtract (it would
 * overflow) is scaled from its halves.
 */
export function linearScale(
	domainMin: number,
	domainMax: number,
	rangeStart: number,
	rangeEnd: number,
): Scale {
	const middle = (rangeStart + rangeEnd) / 2;
	const place = (fraction: number) =>
		Number.isFinite(fraction) ? rangeStart + fraction * (rangeEnd - rangeStart) : middle;
	const span = domainMax - domainMin;
	if (Number.isFinite(span)) {
		if (span === 0) return () => middle;
		return (value) => place((value - domainMin) / span);
	}
	const halfSpan = domainMax / 2 - domainMin / 2;
	if (!Number.isFinite(halfSpan) || halfSpan === 0) return () => middle;
	return (value) => place((value / 2 - domainMin / 2) / halfSpan);
}

const MAX_THINNED_LABELS = 64;

/** Evenly spread indexes (always including first and last) so axis labels do not collide. */
export function thinnedIndexes(count: number, maxLabels: number): readonly number[] {
	if (!Number.isSafeInteger(count) || count <= 0) return [];
	if (!Number.isSafeInteger(maxLabels) || maxLabels < 1) return [];
	if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index);
	if (maxLabels === 1) return [0];
	// Capped so the loop is bounded whatever the caller asks for; no axis fits more labels.
	const slots = Math.min(maxLabels, MAX_THINNED_LABELS);
	const picked = new Set<number>();
	for (let slot = 0; slot < slots; slot += 1) {
		picked.add(Math.round((slot * (count - 1)) / (slots - 1)));
	}
	return [...picked].sort((a, b) => a - b);
}

export interface XTick {
	readonly x: number;
	readonly label: string;
}

/**
 * Labels for the x axis: as many as fit without touching, evenly thinned,
 * truncated to `maxChars`, and nudged inwards so none is cut off by the edge
 * of the drawing. `rowOrder` lists the plotted rows from left to right.
 */
export function buildXTicks(
	rowOrder: readonly number[],
	rowXs: readonly (number | null)[],
	labels: readonly (string | null)[],
	plot: PlotArea,
	limits: { readonly maxLabels: number; readonly maxChars: number },
): readonly XTick[] {
	const candidates = rowOrder.flatMap((rowIndex) => {
		const x = rowXs[rowIndex];
		const label = labels[rowIndex];
		return x === null || x === undefined || label === null || label === undefined
			? []
			: [{ x, label: truncateLabel(label, limits.maxChars) }];
	});
	const longest = Math.max(1, ...candidates.map((tick) => tick.label.length));
	const slotWidth = longest * APPROX_CHAR_WIDTH + TICK_LABEL_GAP;
	const budget = Math.max(
		2,
		Math.min(limits.maxLabels, Math.floor((plot.right - plot.left) / slotWidth)),
	);
	return thinnedIndexes(candidates.length, budget).flatMap((slot) => {
		const tick = candidates[slot];
		if (tick === undefined) return [];
		const halfWidth = (tick.label.length * APPROX_CHAR_WIDTH) / 2;
		const x = Math.min(Math.max(tick.x, halfWidth + 2), VIEW_WIDTH - halfWidth - 2);
		return [{ x, label: tick.label }];
	});
}

export interface XAxisModel {
	/** How rows are placed: by numeric value, by instant, or evenly in row order. */
	readonly mode: "linear" | "time" | "ordinal";
	/** Position in [0, 1] per row; null when the row has no usable x value. */
	readonly positions: readonly (number | null)[];
	readonly labels: readonly (string | null)[];
}

function findColumn(dataset: Dataset, key: string): Dataset["columns"][number] | undefined {
	return dataset.columns.find((column) => column.key === key);
}

export function hasColumn(dataset: Dataset, key: string): boolean {
	return findColumn(dataset, key) !== undefined;
}

function spreadPositions(values: readonly (number | null)[]): readonly (number | null)[] {
	const present = values.filter((value): value is number => value !== null);
	if (present.length === 0) return values.map(() => null);
	const min = Math.min(...present);
	const max = Math.max(...present);
	const scale = linearScale(min, max, 0, 1);
	return values.map((value) => (value === null ? null : scale(value)));
}

export function xAxisModel(dataset: Dataset, xKey: string): XAxisModel {
	const column = findColumn(dataset, xKey);
	const cells = dataset.rows.map((row) => row[xKey]);
	const texts = cells.map(cellText);
	if (column === undefined) {
		return { mode: "ordinal", positions: cells.map(() => null), labels: texts };
	}
	if (column.kind === "number") {
		const numbers = cells.map(numericCell);
		if (numbers.every((value, index) => value !== null || texts[index] === null)) {
			return { mode: "linear", positions: spreadPositions(numbers), labels: texts };
		}
	}
	if (column.kind === "date") {
		const instants = texts.map((text) => {
			if (text === null) return null;
			const ms = Date.parse(text);
			return Number.isFinite(ms) ? ms : null;
		});
		if (instants.every((value, index) => value !== null || texts[index] === null)) {
			return {
				mode: "time",
				positions: spreadPositions(instants),
				labels: texts.map((text) => (text === null ? null : (formatIsoDate(text) ?? text))),
			};
		}
	}
	const count = cells.length;
	return {
		mode: "ordinal",
		positions: texts.map((text, index) => (text === null ? null : (index + 0.5) / count)),
		labels: texts,
	};
}

export interface PlottedPoint {
	readonly rowIndex: number;
	readonly value: number;
}

export interface SeriesSpec {
	readonly key: string;
	readonly label: string;
}

/** A series that will be drawn. `slot` is its position in the chart props, which fixes its color. */
export interface PlannedSeries extends SeriesSpec {
	readonly slot: number;
}

export interface WithheldSeries {
	readonly label: string;
	readonly reason: string;
}

/** The names a chart presents each column under, for the dataset guard. */
export function presentedSeriesLabels(series: readonly SeriesSpec[]): PresentedLabels {
	const labels = new Map<string, string[]>();
	for (const entry of series) {
		labels.set(entry.key, [...(labels.get(entry.key) ?? []), entry.label]);
	}
	return labels;
}

/**
 * Splits the requested series into those that are drawn and those whose column
 * the dataset guard withheld. A survivor keeps its original slot, so removing a
 * series never repaints the others.
 */
export function planSeries(
	series: readonly SeriesSpec[],
	withheldColumns: ReadonlyMap<string, string>,
): { readonly plotted: readonly PlannedSeries[]; readonly withheld: readonly WithheldSeries[] } {
	const plotted: PlannedSeries[] = [];
	const withheld: WithheldSeries[] = [];
	series.forEach((entry, slot) => {
		const reason = withheldColumns.get(entry.key);
		if (reason === undefined) plotted.push({ ...entry, slot });
		else withheld.push({ label: entry.label, reason });
	});
	return { plotted, withheld };
}

export interface PlottedSeries {
	readonly key: string;
	readonly label: string;
	readonly points: readonly PlottedPoint[];
	/** Rows for which this series has no plottable number (null, text, or unplaceable row). */
	readonly unavailableCount: number;
}

export function extractSeries(
	dataset: Dataset,
	series: readonly SeriesSpec[],
	isRowPlaceable: (rowIndex: number) => boolean,
): readonly PlottedSeries[] {
	return series.map(({ key, label }) => {
		const points = dataset.rows.flatMap((row, rowIndex) => {
			const value = isRowPlaceable(rowIndex) ? numericCell(row[key]) : null;
			return value === null ? [] : [{ rowIndex, value }];
		});
		return { key, label, points, unavailableCount: dataset.rows.length - points.length };
	});
}

export function valueExtent(
	values: readonly number[],
): { readonly min: number; readonly max: number } | null {
	if (values.length === 0) return null;
	return { min: Math.min(...values), max: Math.max(...values) };
}

export interface Candle {
	readonly rowIndex: number;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
}

export interface CandleKeys {
	readonly openKey: string;
	readonly highKey: string;
	readonly lowKey: string;
	readonly closeKey: string;
}

/**
 * A candle is plotted only when all four prices are finite and mutually
 * consistent (low <= open/close <= high). Anything else is counted as
 * unavailable instead of drawn from partial data.
 */
export function extractCandles(
	dataset: Dataset,
	keys: CandleKeys,
	isRowPlaceable: (rowIndex: number) => boolean,
): { readonly candles: readonly Candle[]; readonly unavailableCount: number } {
	const candles = dataset.rows.flatMap((row, rowIndex): Candle[] => {
		if (!isRowPlaceable(rowIndex)) return [];
		const open = numericCell(row[keys.openKey]);
		const high = numericCell(row[keys.highKey]);
		const low = numericCell(row[keys.lowKey]);
		const close = numericCell(row[keys.closeKey]);
		if (open === null || high === null || low === null || close === null) return [];
		if (low > Math.min(open, close) || high < Math.max(open, close)) return [];
		return [{ rowIndex, open, high, low, close }];
	});
	return { candles, unavailableCount: dataset.rows.length - candles.length };
}

/** Splits a series into runs of consecutive plotted rows so gaps are never bridged by a line. */
export function contiguousRuns(
	points: readonly PlottedPoint[],
	rowOrder: readonly number[],
): readonly (readonly PlottedPoint[])[] {
	const byRow = new Map(points.map((point) => [point.rowIndex, point] as const));
	const runs: PlottedPoint[][] = [];
	let current: PlottedPoint[] = [];
	for (const rowIndex of rowOrder) {
		const point = byRow.get(rowIndex);
		if (point === undefined) {
			if (current.length > 0) runs.push(current);
			current = [];
		} else {
			current.push(point);
		}
	}
	if (current.length > 0) runs.push(current);
	return runs;
}

/** Bar outline with a 4px rounded data end and a square end on the zero baseline. */
export function barPath(x: number, width: number, baselineY: number, valueY: number): string {
	const height = Math.abs(baselineY - valueY);
	const radius = Math.min(4, width / 2, height);
	const right = x + width;
	const direction = valueY <= baselineY ? 1 : -1;
	const shoulderY = valueY + direction * radius;
	const sweep = direction === 1 ? 1 : 0;
	return [
		`M${x},${baselineY}`,
		`L${x},${shoulderY}`,
		`A${radius},${radius} 0 0 ${sweep} ${x + radius},${valueY}`,
		`L${right - radius},${valueY}`,
		`A${radius},${radius} 0 0 ${sweep} ${right},${shoulderY}`,
		`L${right},${baselineY}`,
		"Z",
	].join(" ");
}

export function nearestIndex(positions: readonly (number | null)[], target: number): number | null {
	let best: number | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const [index, position] of positions.entries()) {
		if (position === null) continue;
		const distance = Math.abs(position - target);
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	}
	return best;
}
