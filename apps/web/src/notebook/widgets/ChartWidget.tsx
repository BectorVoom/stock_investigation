import type { WidgetCore } from "@research/contracts";
import {
	BarPlot,
	buildBarModel,
	buildLineModel,
	EmptyState,
	LinePlot,
} from "@research/ui-registry";
import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import {
	chartWidgetAxisTitles,
	chartWidgetSeries,
	chartWidgetToGuardedDataset,
} from "../chartDataset.ts";

type ChartWidget = Extract<WidgetCore, { readonly type: "chart" }>;

/**
 * A `chart` widget drawn through the same plot code as a Chat chart preview
 * (`LinePlot` / `BarPlot` from `@research/ui-registry`), so the same data
 * gives the same picture: viewBox, plot area, ticks, axis titles, marks,
 * colours, legend and hover readout. The same plot renders at every size;
 * the frame scrolls when content is taller. No visible title in the body.
 */
export function ChartWidget(props: { readonly widget: ChartWidget }): JSX.Element {
	const data = createMemo(() => chartWidgetToGuardedDataset(props.widget));
	const series = createMemo(() => chartWidgetSeries(props.widget));
	const titles = createMemo(() => chartWidgetAxisTitles(props.widget));

	const counts = createMemo(() => {
		const current = data();
		const specs = series();
		if (props.widget.chartType === "bar") {
			const model = buildBarModel(current, {
				categoryKey: "x",
				series: specs,
				yUnit: props.widget.unit,
			});
			return {
				plottedCount: model.plottedCount,
				unavailableCount: model.unavailableCount,
				missingColumns: model.missingColumns,
				withheldSeries: model.withheldSeries,
			};
		}
		const model = buildLineModel(current, { xKey: "x", series: specs });
		return {
			plottedCount: model.plottedCount,
			unavailableCount: model.unavailableCount,
			missingColumns: model.missingColumns,
			withheldSeries: model.withheldSeries,
		};
	});

	/** Union of x labels in first-seen order, for the data-table twin. */
	const tableRows = createMemo(() => {
		const labels: string[] = [];
		const seen = new Set<string>();
		for (const entry of props.widget.series) {
			for (const point of entry.points) {
				if (!seen.has(point.x)) {
					seen.add(point.x);
					labels.push(point.x);
				}
			}
		}
		const bySeries = props.widget.series.map((entry) => {
			const byLabel = new Map<string, number>();
			for (const point of entry.points) {
				if (!byLabel.has(point.x)) byLabel.set(point.x, point.y);
			}
			return byLabel;
		});
		return labels.map((label) => ({
			label,
			values: bySeries.map((byLabel) => byLabel.get(label) ?? null),
		}));
	});

	return (
		<div data-widget-body="chart" class="space-y-1">
			<For each={counts().withheldSeries}>
				{(entry) => (
					<p data-withheld-series={entry.label} class="text-xs text-amber-900">
						Series "{entry.label}" — {entry.reason}.
					</p>
				)}
			</For>
			<Show when={counts().missingColumns.length > 0}>
				<output data-state="missing-columns" class="block text-xs text-amber-900">
					Not in the dataset, so not plotted: {counts().missingColumns.join(", ")}.
				</output>
			</Show>
			<Show
				when={counts().plottedCount > 0}
				fallback={
					<EmptyState>
						{data().dataset.rows.length === 0
							? "No data — this dataset has no rows."
							: "No plottable data — every requested value is unavailable."}
					</EmptyState>
				}
			>
				<Show
					when={props.widget.chartType === "bar"}
					fallback={
						<LinePlot
							data={data()}
							xKey="x"
							series={series()}
							xLabel={titles().xAxisTitle}
							yLabel={props.widget.yLabel?.trim() ?? ""}
							yUnit={props.widget.unit}
							title={props.widget.title}
						/>
					}
				>
					<BarPlot
						data={data()}
						categoryKey="x"
						series={series()}
						xLabel={titles().xAxisTitle}
						yLabel={props.widget.yLabel?.trim() ?? ""}
						yUnit={props.widget.unit}
						title={props.widget.title}
					/>
				</Show>
			</Show>
			<Show when={counts().unavailableCount > 0}>
				<p data-unavailable-count={counts().unavailableCount} class="mt-1 text-xs text-amber-900">
					{counts().unavailableCount} {counts().unavailableCount === 1 ? "point" : "points"}{" "}
					unavailable — not plotted (never drawn as 0). See the data table for the reasons.
				</p>
			</Show>
			<details class="text-xs">
				<summary class="cursor-pointer text-slate-700">Data table: {props.widget.title}</summary>
				<table class="mt-1 w-full border-collapse text-xs text-slate-900">
					<caption class="text-left text-2xs text-slate-600">{`Values plotted in "${props.widget.title}"`}</caption>
					<thead>
						<tr>
							<th scope="col" class="border border-slate-200 px-2 py-1 text-left">
								Label
							</th>
							<For each={props.widget.series}>
								{(entry) => (
									<th scope="col" class="border border-slate-200 px-2 py-1 text-right">
										{entry.name}
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={tableRows()}>
							{(row) => (
								<tr>
									<th scope="row" class="border border-slate-200 px-2 py-1 text-left font-normal">
										{row.label}
									</th>
									<For each={row.values}>
										{(value) => (
											<td class="border border-slate-200 px-2 py-1 text-right tabular-nums">
												{value ?? "—"}
											</td>
										)}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</details>
		</div>
	);
}
