import type { BarChartProps } from "@research/contracts";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { ChartFrame, ChartLegend, ChartShell } from "../charts/ChartFrame.tsx";
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
	presentedSeriesLabels,
	type Scale,
	seriesColor,
	valueExtent,
	type WithheldSeries,
	type XTick,
} from "../charts/chartMath.ts";
import { type GuardedDataset, resolveDataset } from "../datasetGuard.ts";
import { formatNumber } from "../format.ts";
import type { RendererProps } from "../registry.tsx";

const MAX_BAR_WIDTH = 24;
const BAR_GAP = 2;

interface Bar {
	readonly path: string;
	readonly color: string;
	readonly rowIndex: number;
	readonly tooltip: string;
}

interface BarModel {
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

function buildBarModel(data: GuardedDataset, props: BarChartProps): BarModel {
	const { dataset } = data;
	const planned = planSeries(props.series, data.withheldColumns);
	const slotOf = (seriesIndex: number) => planned.plotted[seriesIndex]?.slot ?? seriesIndex;
	const plot = DEFAULT_PLOT;
	const rowLabels = dataset.rows.map((row) => cellText(row[props.categoryKey]));
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
				tooltip: `${rowLabels[point.rowIndex] ?? ""} — ${series.label}: ${formatNumber(point.value)} ${props.yUnit}`,
			};
		}),
	);

	const valuesByRow = new Map(
		dataset.rows.map((_, rowIndex) => [
			rowIndex,
			extracted.map(
				(series) => series.points.find((point) => point.rowIndex === rowIndex)?.value ?? null,
			),
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
		missingColumns: [props.categoryKey, ...props.series.map((series) => series.key)].filter(
			(key) => !hasColumn(dataset, key),
		),
		withheldSeries: planned.withheld,
	};
}

export function BarChart(props: RendererProps<BarChartProps>): JSX.Element {
	const data = createMemo(() =>
		resolveDataset(
			props.context,
			props.props.datasetRef,
			presentedSeriesLabels(props.props.series),
		),
	);
	const model = createMemo(() => {
		const current = data();
		return current === undefined ? null : buildBarModel(current, props.props);
	});
	const [hoveredRow, setHoveredRow] = createSignal<number | null>(null);
	const yAxisTitle = () => `${props.props.yLabel} (${props.props.yUnit})`;
	const readout = createMemo((): string | null => {
		const current = model();
		const rowIndex = hoveredRow();
		if (current === null || rowIndex === null) return null;
		const values = current.valuesByRow.get(rowIndex) ?? [];
		const parts = current.legend.map((series, seriesIndex) => {
			const value = values[seriesIndex];
			return `${series.label}: ${value === null || value === undefined ? "unavailable" : `${formatNumber(value)} ${props.props.yUnit}`}`;
		});
		return `${props.props.xLabel} ${current.rowLabels[rowIndex] ?? "unavailable"} — ${parts.join(" · ")}`;
	});

	return (
		<ChartShell
			title={props.props.title}
			datasetRef={props.props.datasetRef}
			data={data()}
			sourceIds={props.props.sourceIds}
			sources={props.context.sources}
			plottedCount={model()?.plottedCount ?? 0}
			unavailableCount={model()?.unavailableCount ?? 0}
			missingColumns={model()?.missingColumns ?? []}
			withheldSeries={model()?.withheldSeries ?? []}
			tableColumnKeys={[props.props.categoryKey, ...props.props.series.map((series) => series.key)]}
			valueColumnKeys={props.props.series.map((series) => series.key)}
			readout={readout()}
			legend={
				<Show when={(model()?.legend.length ?? 0) > 1}>
					<ChartLegend mark="block" items={model()?.legend ?? []} />
				</Show>
			}
		>
			<Show when={model()}>
				{(current) => (
					<ChartFrame
						ariaLabel={`Bar chart: ${props.props.title}. ${yAxisTitle()} by ${props.props.xLabel}. Series: ${current()
							.legend.map((series) => series.label)
							.join(", ")}.`}
						plot={current().plot}
						xAxisTitle={props.props.xLabel}
						yAxisTitle={yAxisTitle()}
						yTicks={current().yTicks}
						yScale={current().yScale}
						xTicks={current().xTicks}
						rowXs={current().rowXs}
						hoveredRow={hoveredRow()}
						onHoverRow={setHoveredRow}
					>
						<For each={current().bars}>
							{(bar) => (
								<path
									data-bar="true"
									d={bar.path}
									fill={bar.color}
									fill-opacity={hoveredRow() === null || hoveredRow() === bar.rowIndex ? 1 : 0.55}
								>
									<title>{bar.tooltip}</title>
								</path>
							)}
						</For>
					</ChartFrame>
				)}
			</Show>
		</ChartShell>
	);
}
