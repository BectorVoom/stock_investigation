import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { GuardedDataset } from "../datasetGuard.ts";
import { formatNumber } from "../format.ts";
import { buildBarModel } from "./barModel.ts";
import { ChartFrame, ChartLegend } from "./ChartFrame.tsx";
import type { SeriesSpec } from "./chartMath.ts";

/**
 * The shared bar plot: ChartFrame + marks + legend + hover readout.
 * The registry `BarChart` renderer uses this inside `ChartShell`; the
 * Notebook `chart` widget renders it directly, so the same data gives the
 * same picture on both pages.
 */
export function BarPlot(props: {
	readonly data: GuardedDataset;
	readonly categoryKey: string;
	readonly series: readonly SeriesSpec[];
	readonly xLabel: string;
	readonly yLabel: string;
	readonly yUnit: string;
	readonly title: string;
}): JSX.Element {
	const model = createMemo(() =>
		buildBarModel(props.data, {
			categoryKey: props.categoryKey,
			series: props.series,
			yUnit: props.yUnit,
		}),
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
		const values = current.valuesByRow.get(rowIndex) ?? [];
		const parts = current.legend.map((series, seriesIndex) => {
			const value = values[seriesIndex];
			return `${series.label}: ${value === null || value === undefined ? "unavailable" : `${formatNumber(value)} ${props.yUnit}`}`;
		});
		return `${props.xLabel} ${current.rowLabels[rowIndex] ?? "unavailable"} — ${parts.join(" · ")}`;
	});

	return (
		<>
			<ChartFrame
				ariaLabel={`Bar chart: ${props.title}. ${yAxisTitle()} by ${props.xLabel}. Series: ${model()
					.legend.map((series) => series.label)
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
				<For each={model().bars}>
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
			<Show when={model().legend.length > 1}>
				<ChartLegend mark="block" items={model().legend} />
			</Show>
			<p data-chart-part="readout" class="mt-1 min-h-4 text-xs text-slate-700">
				{readout() ?? "Point at the chart to read values; the data table below lists every value."}
			</p>
		</>
	);
}
