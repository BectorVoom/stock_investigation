import type { MarketPoint, MarketRange } from "@research/domain";
import { selectRange } from "@research/domain";
import {
	buildXTicks,
	DEFAULT_PLOT,
	linearScale,
	niceTicks,
	seriesColor,
	VIEW_HEIGHT,
	VIEW_WIDTH,
	valueExtent,
	type XTick,
} from "./chartMath.ts";

/**
 * Pure line-chart model for Home widgets (and its bench case): union-date x
 * positions (so mixed frequencies share one axis), one y scale over all
 * plotted values, contiguous runs so gaps are never bridged by a line, and
 * SVG path data per series. No DOM, no Solid — `scripts/bench.ts` imports
 * this file directly, the Home widgets through the package index.
 */

export interface HomeLineSeriesInput {
	readonly key: string;
	readonly label: string;
	readonly points: readonly MarketPoint[];
}

export interface HomeLinePath {
	readonly key: string;
	readonly label: string;
	readonly color: string;
	/** SVG path data for the contiguous runs, plus one circle per plotted point. */
	readonly paths: readonly string[];
	readonly circles: readonly { readonly x: number; readonly y: number }[];
	/** Plotted value by union-date row index (for the hover readout). */
	readonly values: ReadonlyMap<number, number>;
	readonly plottedCount: number;
	readonly unavailableCount: number;
}

export interface HomeLineModel {
	readonly plot: typeof DEFAULT_PLOT;
	readonly yTicks: readonly number[];
	readonly yScale: (value: number) => number;
	readonly xTicks: readonly XTick[];
	readonly rowXs: readonly (number | null)[];
	readonly rowLabels: readonly (string | null)[];
	readonly series: readonly HomeLinePath[];
	readonly plottedCount: number;
	readonly unavailableCount: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Builds every SVG path for a line-chart widget. Null when nothing is
 * plottable. Colours come from the shared palette in slot order (never cycled
 * by the widget).
 */
export function buildHomeLineModel(
	entries: readonly HomeLineSeriesInput[],
	range: MarketRange,
): HomeLineModel | null {
	const ranged = entries.map((entry) => ({
		...entry,
		points: selectRange(entry.points, range),
	}));
	const dateSet = new Set<string>();
	for (const entry of ranged) for (const point of entry.points) dateSet.add(point.observedOn);
	const dates = [...dateSet].sort();
	if (dates.length === 0) return null;
	const dateIndex = new Map(dates.map((date, index) => [date, index] as const));
	const plot = DEFAULT_PLOT;
	const xScale = linearScale(0, Math.max(dates.length - 1, 1), plot.left, plot.right);
	const rowXs: (number | null)[] = dates.map((_, index) =>
		dates.length === 1 ? (plot.left + plot.right) / 2 : xScale(index),
	);
	const allValues = ranged.flatMap((entry) => entry.points.map((point) => point.value));
	const extent = valueExtent(allValues);
	if (extent === null) return null;
	const yTicks = niceTicks(extent.min, extent.max);
	const yScale = linearScale(
		yTicks[0] ?? extent.min,
		yTicks[yTicks.length - 1] ?? extent.max,
		plot.bottom,
		plot.top,
	);
	const rowOrder = dates.map((_, index) => index);
	const xTicks = buildXTicks(rowOrder, rowXs, dates, plot, { maxLabels: 6, maxChars: 10 });

	let plottedCount = 0;
	let unavailableCount = 0;
	const series = ranged.map((entry, slot): HomeLinePath => {
		const rows = entry.points.flatMap((point) => {
			const rowIndex = dateIndex.get(point.observedOn);
			return rowIndex === undefined ? [] : [{ rowIndex, value: point.value } as const];
		});
		const byRow = new Map(rows.map((point) => [point.rowIndex, point] as const));
		// D2: connect each series' own consecutive observations in date order.
		// The union-date axis interleaves faster series between a slower
		// series' points, so row-adjacency runs are always length 1 for the
		// slower series; connecting the series' own sequence draws its line.
		const ordered = [...byRow.values()].sort((a, b) => a.rowIndex - b.rowIndex);
		const paths =
			ordered.length > 1
				? [
						ordered
							.map((point, index) => {
								const x = rowXs[point.rowIndex] ?? plot.left;
								const y = yScale(point.value);
								return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
							})
							.join(" "),
					]
				: [];
		const circles = [...byRow.values()].map(({ rowIndex, value }) => ({
			x: rowXs[rowIndex] ?? plot.left,
			y: yScale(value),
		}));
		plottedCount += byRow.size;
		unavailableCount += dates.length - byRow.size;
		return {
			key: entry.key,
			label: entry.label,
			color: seriesColor(slot),
			paths,
			circles,
			values: new Map(
				[...byRow.entries()].map(([rowIndex, point]) => [rowIndex, point.value] as const),
			),
			plottedCount: byRow.size,
			unavailableCount: dates.length - byRow.size,
		};
	});

	return {
		plot,
		yTicks,
		yScale,
		xTicks,
		rowXs,
		rowLabels: dates,
		series,
		plottedCount,
		unavailableCount,
		width: VIEW_WIDTH,
		height: VIEW_HEIGHT,
	};
}

/** Same keys as the app's change tones: the sparkline wears its range's direction. */
export type SparklineDirection = "up" | "down" | "unchanged";

export interface Sparkline {
	/** SVG path data of the whole range. */
	readonly d: string;
	/** Y of the range's first value: the dotted reference line (Apple Stocks). */
	readonly startY: number;
	/** Last value against the first. */
	readonly direction: SparklineDirection;
}

/**
 * Sparkline of the trailing points: one path scaled into the box (the midline
 * when flat), a reference line at the first value, and the direction from the
 * first value to the last. `inset` keeps the extremes `inset` units inside the
 * top and bottom edges so a thick stroke is never clipped there. Null when
 * fewer than 2 points. `aria-hidden` in the widget: the numbers are in the text.
 */
export function buildSparkline(
	points: readonly MarketPoint[],
	width: number,
	height: number,
	inset = 0,
): Sparkline | null {
	const first = points[0];
	const last = points[points.length - 1];
	if (first === undefined || last === undefined || points.length < 2) return null;
	let min = first.value;
	let max = first.value;
	for (const point of points) {
		if (point.value < min) min = point.value;
		if (point.value > max) max = point.value;
	}
	const span = Math.max(0, height - 2 * inset);
	const yOf = (value: number): number =>
		max === min ? height / 2 : inset + span - ((value - min) / (max - min)) * span;
	const step = width / (points.length - 1);
	const d = points
		.map(
			(point, index) =>
				`${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${yOf(point.value).toFixed(2)}`,
		)
		.join(" ");
	const direction: SparklineDirection =
		last.value > first.value ? "up" : last.value < first.value ? "down" : "unchanged";
	return { d, startY: yOf(first.value), direction };
}
