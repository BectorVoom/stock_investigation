import type { GuardedDataset } from "../datasetGuard.ts";
import {
	buildXTicks,
	contiguousRuns,
	DEFAULT_PLOT,
	extractSeries,
	hasColumn,
	LABELLED_PLOT,
	linearScale,
	niceTicks,
	type PlotArea,
	planSeries,
	type Scale,
	type SeriesSpec,
	seriesColor,
	valueExtent,
	type WithheldSeries,
	type XTick,
	xAxisModel,
} from "./chartMath.ts";

export interface Marker {
	readonly x: number;
	readonly y: number;
	readonly rowIndex: number;
}

export interface LineSeriesModel {
	readonly label: string;
	readonly color: string;
	readonly paths: readonly string[];
	readonly markers: readonly Marker[];
	readonly valueByRow: ReadonlyMap<number, number>;
	readonly end: { readonly x: number; readonly y: number } | null;
}

export interface LineModel {
	readonly plot: PlotArea;
	readonly yTicks: readonly number[];
	readonly yScale: Scale;
	readonly xTicks: readonly XTick[];
	readonly rowXs: readonly (number | null)[];
	readonly rowLabels: readonly (string | null)[];
	readonly series: readonly LineSeriesModel[];
	readonly showEndLabels: boolean;
	readonly plottedCount: number;
	readonly unavailableCount: number;
	readonly missingColumns: readonly string[];
	readonly withheldSeries: readonly WithheldSeries[];
}

export interface LineChartSpec {
	readonly xKey: string;
	readonly series: readonly SeriesSpec[];
}

const MAX_DIRECT_LABELS = 4;
const MIN_LABEL_SEPARATION = 15;
const X_INSET = 10;

export function buildLineModel(data: GuardedDataset, spec: LineChartSpec): LineModel {
	const { dataset } = data;
	const planned = planSeries(spec.series, data.withheldColumns);
	const xAxis = xAxisModel(dataset, spec.xKey);
	const extracted = extractSeries(
		dataset,
		planned.plotted,
		(rowIndex) => xAxis.positions[rowIndex] !== null && xAxis.positions[rowIndex] !== undefined,
	);
	const extent = valueExtent(extracted.flatMap((series) => series.points.map((p) => p.value)));
	const yTicks = extent === null ? [] : niceTicks(extent.min, extent.max);
	const wantsEndLabels = planned.plotted.length >= 2 && planned.plotted.length <= MAX_DIRECT_LABELS;
	const plot = wantsEndLabels ? LABELLED_PLOT : DEFAULT_PLOT;
	const yScale = linearScale(yTicks[0] ?? 0, yTicks[yTicks.length - 1] ?? 1, plot.bottom, plot.top);
	const inset = xAxis.mode === "ordinal" ? 0 : X_INSET;
	const xScale = linearScale(0, 1, plot.left + inset, plot.right - inset);
	const rowXs = xAxis.positions.map((position) => (position === null ? null : xScale(position)));
	const rowOrder = rowXs
		.flatMap((x, rowIndex) => (x === null ? [] : [{ x, rowIndex }]))
		.sort((a, b) => a.x - b.x || a.rowIndex - b.rowIndex)
		.map((entry) => entry.rowIndex);

	const series = extracted.map((entry, seriesIndex): LineSeriesModel => {
		const toMarker = (point: { readonly rowIndex: number; readonly value: number }): Marker => ({
			x: rowXs[point.rowIndex] ?? plot.left,
			y: yScale(point.value),
			rowIndex: point.rowIndex,
		});
		const runs = contiguousRuns(entry.points, rowOrder).map((run) => run.map(toMarker));
		const lastRun = runs[runs.length - 1];
		const lastMarker = lastRun === undefined ? undefined : lastRun[lastRun.length - 1];
		return {
			label: entry.label,
			color: seriesColor(planned.plotted[seriesIndex]?.slot ?? seriesIndex),
			paths: runs
				.filter((run) => run.length > 1)
				.map((run) => run.map((m, index) => `${index === 0 ? "M" : "L"}${m.x},${m.y}`).join(" ")),
			markers: runs.flat(),
			valueByRow: new Map(entry.points.map((point) => [point.rowIndex, point.value] as const)),
			end: lastMarker === undefined ? null : { x: lastMarker.x, y: lastMarker.y },
		};
	});

	const endYs = series
		.flatMap((entry) => (entry.end === null ? [] : [entry.end.y]))
		.sort((a, b) => a - b);
	const labelsCollide = endYs.some(
		(y, index) => index > 0 && y - (endYs[index - 1] ?? y) < MIN_LABEL_SEPARATION,
	);
	const plottedCount = extracted.reduce((sum, entry) => sum + entry.points.length, 0);

	return {
		plot,
		yTicks,
		yScale,
		xTicks: buildXTicks(rowOrder, rowXs, xAxis.labels, plot, { maxLabels: 7, maxChars: 12 }),
		rowXs,
		rowLabels: xAxis.labels,
		series,
		showEndLabels: wantsEndLabels && !labelsCollide,
		plottedCount,
		unavailableCount: extracted.reduce((sum, entry) => sum + entry.unavailableCount, 0),
		missingColumns: [spec.xKey, ...spec.series.map((entry) => entry.key)].filter(
			(key) => !hasColumn(dataset, key),
		),
		withheldSeries: planned.withheld,
	};
}
