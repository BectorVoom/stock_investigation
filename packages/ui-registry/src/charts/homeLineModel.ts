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

/**
 * Sparkline of the trailing points: a single path scaled into the box, the
 * midline when flat, an empty string when fewer than 2 points. `aria-hidden`
 * in the widget: the same numbers are in the text.
 */
export function sparklinePath(
	points: readonly MarketPoint[],
	width: number,
	height: number,
): string {
	if (points.length < 2) return "";
	const values = points.map((point) => point.value);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const yOf = (value: number): number => {
		if (max === min) return height / 2;
		return height - ((value - min) / (max - min)) * height;
	};
	return points
		.map((point, index) => {
			const x = points.length === 1 ? 0 : (index / (points.length - 1)) * width;
			return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${yOf(point.value).toFixed(2)}`;
		})
		.join(" ");
}
