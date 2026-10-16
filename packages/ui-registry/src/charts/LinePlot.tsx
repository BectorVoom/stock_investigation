import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { GuardedDataset } from "../datasetGuard.ts";
import { formatNumber, truncateLabel } from "../format.ts";
import { ChartFrame, ChartLegend } from "./ChartFrame.tsx";
import type { SeriesSpec } from "./chartMath.ts";
import { CHART_INK } from "./chartMath.ts";
import { buildLineModel } from "./lineModel.ts";

/**
 * The shared line plot: ChartFrame + marks + legend + hover readout.
 * The registry `LineChart` renderer uses this inside `ChartShell`; the
 * Notebook `chart` widget renders it directly, so the same data gives the
 * same picture on both pages.
 */
export function LinePlot(props: {
	readonly data: GuardedDataset;
	readonly xKey: string;
	readonly series: readonly SeriesSpec[];
	readonly xLabel: string;
	readonly yLabel: string;
	readonly yUnit: string;
	readonly title: string;
}): JSX.Element {
	const model = createMemo(() =>
		buildLineModel(props.data, { xKey: props.xKey, series: props.series }),
	);
	const [hoveredRow, setHoveredRow] = createSignal<number | null>(null);
	const yAxisTitle = () => {
		const yLabel = props.yLabel.trim();
		const yUnit = props.yUnit.trim();
		if (yLabel.length > 0 && yUnit.length > 0) return `${yLabel} (${yUnit})`;
		return yLabel.length > 0 ? yLabel : yUnit;
	};
	const readout = createMemo((): string | null => {
		const current = model();
		const rowIndex = hoveredRow();
		if (rowIndex === null) return null;
		const values = current.series.map((series) => {
			const value = series.valueByRow.get(rowIndex);
			return `${series.label}: ${value === undefined ? "unavailable" : `${formatNumber(value)} ${props.yUnit}`}`;
		});
		return `${props.xLabel} ${current.rowLabels[rowIndex] ?? "unavailable"} — ${values.join(" · ")}`;
	});

	return (
		<>
			<ChartFrame
				ariaLabel={`Line chart: ${props.title}. ${yAxisTitle()} by ${props.xLabel}. Series: ${model()
					.series.map((series) => series.label)
					.join(", ")}.`}
				plot={model().plot}
				xAxisTitle={props.xLabel}
				yAxisTitle={yAxisTitle()}
				yTicks={model().yTicks}
				yScale={model().yScale}
				xTicks={model().xTicks}
				rowXs={model().rowXs}
				hoveredRow={hoveredRow()}
				onHoverRow={setHoveredRow}
			>
				<For each={model().series}>
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
							<Show when={model().showEndLabels ? series.end : null}>
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
			<Show when={model().series.length > 1}>
				<ChartLegend
					mark="line"
					items={model().series.map((series) => ({
						label: series.label,
						color: series.color,
					}))}
				/>
			</Show>
			<p data-chart-part="readout" class="mt-1 min-h-4 text-xs text-slate-700">
				{readout() ?? "Point at the chart to read values; the data table below lists every value."}
			</p>
		</>
	);
}
