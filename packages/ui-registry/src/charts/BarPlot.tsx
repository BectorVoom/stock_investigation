import { useMessages } from "@research/i18n/solid";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { formatNumber } from "../format.ts";
import type { BarModel } from "./barModel.ts";
import { axesPhrase, ChartFrame, ChartLegend } from "./ChartFrame.tsx";
import { chartMessages } from "./charts.messages.ts";

/**
 * The shared bar plot: ChartFrame + marks + legend + hover readout.
 * The registry `BarChart` renderer uses this inside `ChartShell`; the
 * Notebook `chart` widget renders it directly, so the same data gives the
 * same picture on both pages. The caller builds `model` once (in a
 * `createMemo`) and passes it in, so each render builds it exactly once.
 */
export function BarPlot(props: {
	readonly model: BarModel;
	readonly xLabel: string;
	readonly yLabel: string;
	readonly yUnit: string;
	readonly title: string;
}): JSX.Element {
	const m = useMessages(chartMessages);
	const [hoveredRow, setHoveredRow] = createSignal<number | null>(null);
	const yAxisTitle = () => {
		const yLabel = props.yLabel.trim();
		const yUnit = props.yUnit.trim();
		if (yLabel.length > 0 && yUnit.length > 0) return `${yLabel} (${yUnit})`;
		return yLabel.length > 0 ? yLabel : yUnit;
	};
	const readout = createMemo((): string | null => {
		const current = props.model;
		const rowIndex = hoveredRow();
		if (rowIndex === null) return null;
		const values = current.valuesByRow.get(rowIndex) ?? [];
		const parts = current.legend.map((series, seriesIndex) => {
			const value = values[seriesIndex];
			return `${series.label}: ${value === null || value === undefined ? m().unavailable : `${formatNumber(value)} ${props.yUnit}`}`;
		});
		return `${[props.xLabel, current.rowLabels[rowIndex] ?? m().unavailable].filter((part) => part.length > 0).join(" ")} — ${parts.join(" · ")}`;
	});

	return (
		<>
			<ChartFrame
				ariaLabel={m().barChartLabel(
					props.title,
					axesPhrase(yAxisTitle(), props.xLabel, m()),
					props.model.legend.map((series) => series.label),
				)}
				plot={props.model.plot}
				xAxisTitle={props.xLabel}
				yAxisTitle={yAxisTitle()}
				yTicks={props.model.yTicks}
				yScale={props.model.yScale}
				xTicks={props.model.xTicks}
				rowXs={props.model.rowXs}
				hoveredRow={hoveredRow()}
				onHoverRow={setHoveredRow}
			>
				<For each={props.model.bars}>
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
			<Show when={props.model.legend.length > 1}>
				<ChartLegend mark="block" items={props.model.legend} />
			</Show>
			<p data-chart-part="readout" class="mt-1 min-h-4 text-xs text-slate-700">
				{readout() ?? m().readoutHint}
			</p>
		</>
	);
}
