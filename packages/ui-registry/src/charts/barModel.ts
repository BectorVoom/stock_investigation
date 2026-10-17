import type { GuardedDataset } from "../datasetGuard.ts";
import { formatNumber } from "../format.ts";
import {
	barPath,
	buildXTicks,
	cellText,
	DEFAULT_PLOT,
	extractSeries,
	hasColumn,
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
} from "./chartMath.ts";

export interface Bar {
	readonly path: string;
	readonly color: string;
	readonly rowIndex: number;
	readonly tooltip: string;
}

export interface BarModel {
	readonly plot: PlotArea;
	readonly yTicks: readonly number[];
	readonly yScale: Scale;
	readonly xTicks: readonly XTick[];
	readonly rowXs: readonly (number | null)[];
	readonly rowLabels: readonly (string | null)[];
	readonly bars: readonly Bar[];
	readonly legend: readonly { readonly label: string; readonly color: string }[];
	readonly valuesByRow: ReadonlyMap<number, readonly (number | null)[]>;
	readonly plottedCount: number;
	readonly unavailableCount: number;
	readonly missingColumns: readonly string[];
	readonly withheldSeries: readonly WithheldSeries[];
}

export interface BarChartSpec {
	readonly categoryKey: string;
	readonly series: readonly SeriesSpec[];
	readonly yUnit: string;
}

const MAX_BAR_WIDTH = 24;
const BAR_GAP = 2;

export function buildBarModel(data: GuardedDataset, spec: BarChartSpec): BarModel {
	const { dataset } = data;
	const planned = planSeries(spec.series, data.withheldColumns);
	const slotOf = (seriesIndex: number) => planned.plotted[seriesIndex]?.slot ?? seriesIndex;
	const plot = DEFAULT_PLOT;
	const rowLabels = dataset.rows.map((row) => cellText(row[spec.categoryKey]));
	const extracted = extractSeries(dataset, planned.plotted, (rowIndex) => {
		const label = rowLabels[rowIndex];
		return label !== null && label !== undefined;
	});
	// Bars encode magnitude by length, so the axis always includes the zero baseline.
	const extent = valueExtent([0, ...extracted.flatMap((s) => s.points.map((p) => p.value))]);
	const yTicks = extent === null ? [] : niceTicks(extent.min, extent.max);
	const yScale = linearScale(yTicks[0] ?? 0, yTicks[yTicks.length - 1] ?? 1, plot.bottom, plot.top);
	const baselineY = yScale(0);

	const rowCount = dataset.rows.length;
	const band = rowCount === 0 ? 0 : (plot.right - plot.left) / rowCount;
	const seriesCount = Math.max(1, extracted.length);
	const barWidth = Math.max(
		1,
		Math.min(MAX_BAR_WIDTH, (band * 0.8 - BAR_GAP * (seriesCount - 1)) / seriesCount),
	);
	const groupWidth = barWidth * seriesCount + BAR_GAP * (seriesCount - 1);
	const rowXs = rowLabels.map((label, rowIndex) =>
		label === null ? null : plot.left + band * (rowIndex + 0.5),
	);

	const bars = extracted.flatMap((series, seriesIndex) =>
		series.points.map((point): Bar => {
			const center = rowXs[point.rowIndex] ?? plot.left;
			const x = center - groupWidth / 2 + seriesIndex * (barWidth + BAR_GAP);
			return {
				path: barPath(x, barWidth, baselineY, yScale(point.value)),
				color: seriesColor(slotOf(seriesIndex)),
				rowIndex: point.rowIndex,
				tooltip: `${rowLabels[point.rowIndex] ?? ""} — ${series.label}: ${formatNumber(point.value)} ${spec.yUnit}`,
			};
		}),
	);

	// One lookup map per series: a per-row `find` is quadratic on a long chart.
	const valueMaps = extracted.map(
		(series) => new Map(series.points.map((point) => [point.rowIndex, point.value] as const)),
	);
	const valuesByRow = new Map(
		dataset.rows.map((_, rowIndex) => [
			rowIndex,
			valueMaps.map((values) => values.get(rowIndex) ?? null),
		]),
	);

	return {
		plot,
		yTicks,
		yScale,
		xTicks: buildXTicks(
			dataset.rows.map((_, rowIndex) => rowIndex),
			rowXs,
			rowLabels,
			plot,
			{ maxLabels: 10, maxChars: 12 },
		),
		rowXs,
		rowLabels,
		bars,
		legend: extracted.map((series, seriesIndex) => ({
			label: series.label,
			color: seriesColor(slotOf(seriesIndex)),
		})),
		valuesByRow,
		plottedCount: bars.length,
		unavailableCount: extracted.reduce((sum, series) => sum + series.unavailableCount, 0),
		missingColumns: [spec.categoryKey, ...spec.series.map((series) => series.key)].filter(
			(key) => !hasColumn(dataset, key),
		),
		withheldSeries: planned.withheld,
	};
}
