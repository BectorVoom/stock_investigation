import type { WidgetCore } from "@research/contracts";
import {
	BarPlot,
	buildBarModel,
	buildLineModel,
	ChartNotices,
	cellDisplay,
	chartWidgetSeries,
	chartWidgetToGuardedDataset,
	chartWidgetXAxisTitle,
	LinePlot,
} from "@research/ui-registry";
import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";

type ChartWidget = Extract<WidgetCore, { readonly type: "chart" }>;

/**
 * A `chart` widget drawn through the same plot code as a Chat chart preview
 * (`LinePlot` / `BarPlot` from `@research/ui-registry`), so the same data
 * gives the same picture: viewBox, plot area, ticks, axis titles, marks,
 * colours, legend and hover readout. The same plot renders at every size;
 * the frame scrolls when content is taller. No visible title in the body.
 *
 * The data-table twin reads the GUARDED dataset, so a withheld value never
 * appears as a number — its reason is shown instead.
 */
export function ChartWidget(props: { readonly widget: ChartWidget }): JSX.Element {
	const data = createMemo(() => chartWidgetToGuardedDataset(props.widget));
	const series = createMemo(() => chartWidgetSeries(props.widget));

	const model = createMemo(() => {
		const current = data();
		const specs = series();
		if (props.widget.chartType === "bar") {
			return {
				kind: "bar" as const,
				model: buildBarModel(current, {
					categoryKey: "x",
					series: specs,
					yUnit: props.widget.unit,
				}),
			};
		}
		return {
			kind: "line" as const,
			model: buildLineModel(current, { xKey: "x", series: specs }),
		};
	});

	const barModel = createMemo(() => {
		const current = model();
		return current.kind === "bar" ? current.model : null;
	});
	const lineModel = createMemo(() => {
		const current = model();
		return current.kind === "line" ? current.model : null;
	});
	const tableColumns = createMemo(() => data().dataset.columns);
	const tableRows = createMemo(() => data().dataset.rows);

	return (
		<div data-widget-body="chart" class="space-y-1">
			<ChartNotices
				withheldSeries={model().model.withheldSeries}
				missingColumns={model().model.missingColumns}
				plottedCount={model().model.plottedCount}
				unavailableCount={model().model.unavailableCount}
				emptyMessage={
					data().dataset.rows.length === 0
						? "No data — this dataset has no rows."
						: "No plottable data — every requested value is unavailable."
				}
			>
				<Show
					when={barModel()}
					fallback={
						<Show when={lineModel()} fallback={null}>
							{(line) => (
								<LinePlot
									model={line()}
									xLabel={chartWidgetXAxisTitle(props.widget)}
									yLabel={props.widget.yLabel?.trim() ?? ""}
									yUnit={props.widget.unit}
									title={props.widget.title}
								/>
							)}
						</Show>
					}
				>
					{(bar) => (
						<BarPlot
							model={bar()}
							xLabel={chartWidgetXAxisTitle(props.widget)}
							yLabel={props.widget.yLabel?.trim() ?? ""}
							yUnit={props.widget.unit}
							title={props.widget.title}
						/>
					)}
				</Show>
			</ChartNotices>
			<details class="text-xs">
				<summary class="cursor-pointer text-slate-700">Data table: {props.widget.title}</summary>
				<table class="mt-1 w-full border-collapse text-xs text-slate-900">
					<caption class="text-left text-2xs text-slate-600">{`Values plotted in "${props.widget.title}"`}</caption>
					<thead>
						<tr>
							<For each={tableColumns()}>
								{(column, index) => (
									<th
										scope="col"
										class={`border border-slate-200 px-2 py-1 ${index() === 0 ? "text-left" : "text-right"}`}
									>
										{column.label}
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={tableRows()}>
							{(row) => (
								<tr>
									<For each={tableColumns()}>
										{(column, columnIndex) => {
											const text = () => {
												const display = cellDisplay(row[column.key], column);
												return display.available ? display.text : display.reason;
											};
											return (
												<Show
													when={columnIndex() === 0}
													fallback={
														<td class="border border-slate-200 px-2 py-1 text-right tabular-nums">
															{text()}
														</td>
													}
												>
													<th
														scope="row"
														class="border border-slate-200 px-2 py-1 text-left font-normal"
													>
														{text()}
													</th>
												</Show>
											);
										}}
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
