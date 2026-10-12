import type { LineChartProps } from "@research/contracts";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { ChartFrame, ChartLegend, ChartShell } from "../charts/ChartFrame.tsx";
import {
	buildXTicks,
	CHART_INK,
	contiguousRuns,
	DEFAULT_PLOT,
	extractSeries,
	hasColumn,
	LABELLED_PLOT,
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
	xAxisModel,
} from "../charts/chartMath.ts";
import { type GuardedDataset, resolveDataset } from "../datasetGuard.ts";
import { formatNumber, truncateLabel } from "../format.ts";
import type { RendererProps } from "../registry.tsx";

const MAX_DIRECT_LABELS = 4;
const MIN_LABEL_SEPARATION = 15;
const X_INSET = 10;

interface Marker {
	readonly x: number;
	readonly y: number;
	readonly rowIndex: number;
}

interface LineSeriesModel {
	readonly label: string;
	readonly color: string;
	readonly paths: readonly string[];
	readonly markers: readonly Marker[];
	readonly valueByRow: ReadonlyMap<number, number>;
	readonly end: { readonly x: number; readonly y: number } | null;
}

interface LineModel {
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

function buildLineModel(data: GuardedDataset, props: LineChartProps): LineModel {
	const { dataset } = data;
	const planned = planSeries(props.series, data.withheldColumns);
	const xAxis = xAxisModel(dataset, props.xKey);
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
		missingColumns: [props.xKey, ...props.series.map((entry) => entry.key)].filter(
			(key) => !hasColumn(dataset, key),
		),
		withheldSeries: planned.withheld,
	};
}

export function LineChart(props: RendererProps<LineChartProps>): JSX.Element {
	const data = createMemo(() =>
		resolveDataset(
			props.context,
			props.props.datasetRef,
			presentedSeriesLabels(props.props.series),
		),
	);
	const model = createMemo(() => {
		const current = data();
		return current === undefined ? null : buildLineModel(current, props.props);
	});
	const [hoveredRow, setHoveredRow] = createSignal<number | null>(null);
	const yAxisTitle = () => `${props.props.yLabel} (${props.props.yUnit})`;
	const readout = createMemo((): string | null => {
		const current = model();
		const rowIndex = hoveredRow();
		if (current === null || rowIndex === null) return null;
		const values = current.series.map((series) => {
			const value = series.valueByRow.get(rowIndex);
			return `${series.label}: ${value === undefined ? "unavailable" : `${formatNumber(value)} ${props.props.yUnit}`}`;
		});
		return `${props.props.xLabel} ${current.rowLabels[rowIndex] ?? "unavailable"} — ${values.join(" · ")}`;
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
			tableColumnKeys={[props.props.xKey, ...props.props.series.map((series) => series.key)]}
			valueColumnKeys={props.props.series.map((series) => series.key)}
			readout={readout()}
			legend={
				<Show when={(model()?.series.length ?? 0) > 1}>
					<ChartLegend
						mark="line"
						items={(model()?.series ?? []).map((series) => ({
							label: series.label,
							color: series.color,
						}))}
					/>
				</Show>
			}
		>
			<Show when={model()}>
				{(current) => (
					<ChartFrame
						ariaLabel={`Line chart: ${props.props.title}. ${yAxisTitle()} by ${props.props.xLabel}. Series: ${current()
							.series.map((series) => series.label)
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
						<For each={current().series}>
							{(series) => (
								<g data-series={series.label}>
									<For each={series.paths}>
										{(path) => (
											<path
												d={path}
												fill="none"
												stroke={series.color}
												stroke-width="2"
												stroke-linejoin="round"
												stroke-linecap="round"
											/>
										)}
									</For>
									<For each={series.markers}>
										{(marker) => (
											<circle
												data-point="true"
												cx={marker.x}
												cy={marker.y}
												r={series.markers.length > 40 ? 2.5 : 4}
												fill={series.color}
												stroke={CHART_INK.surface}
												stroke-width={series.markers.length > 40 ? 1 : 2}
											/>
										)}
									</For>
									<Show when={current().showEndLabels ? series.end : null}>
										{(end) => (
											<text
												x={end().x + 10}
												y={end().y}
												dy="0.32em"
												fill={CHART_INK.primary}
												data-direct-label="true"
											>
												{truncateLabel(series.label, 15)}
											</text>
										)}
									</Show>
								</g>
							)}
						</For>
					</ChartFrame>
				)}
			</Show>
		</ChartShell>
	);
}
