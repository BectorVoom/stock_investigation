import type { WidgetCore } from "@research/contracts";
import {
	BarPlot,
	buildBarModel,
	buildLineModel,
	ChartShell,
	chartWidgetSeries,
	chartWidgetSources,
	chartWidgetToGuardedDataset,
	chartWidgetXAxisTitle,
	LinePlot,
} from "@research/ui-registry";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";

type ChartWidget = Extract<WidgetCore, { readonly type: "chart" }>;

/**
 * A `chart` widget drawn exactly as a Chat chart is: the registry's
 * `ChartShell` (notices, basis note, data table with markers and citations,
 * Sources list) around the shared `LinePlot` / `BarPlot`, from a dataset
 * rebuilt out of the widget's points and their provenance (ADR-0026). Only
 * the heading is hidden (ADR-0024). The same plot renders at every size; the
 * frame scrolls when content is taller.
 */
export function ChartWidget(props: { readonly widget: ChartWidget }): JSX.Element {
	const data = createMemo(() => chartWidgetToGuardedDataset(props.widget));
	const series = createMemo(() => chartWidgetSeries(props.widget));
	const sources = createMemo(() => chartWidgetSources(props.widget));
	const valueKeys = createMemo(() => series().map((entry) => entry.key));
	const yLabel = () => props.widget.yLabel?.trim() ?? "";

	const model = createMemo(() => {
		const current = data();
		if (props.widget.chartType === "bar") {
			return {
				kind: "bar" as const,
				model: buildBarModel(current, {
					categoryKey: "x",
					series: series(),
					yUnit: props.widget.unit,
				}),
			};
		}
		return {
			kind: "line" as const,
			model: buildLineModel(current, { xKey: "x", series: series() }),
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

	return (
		<div data-widget-body="chart">
			<ChartShell
				title={props.widget.title}
				datasetRef={props.widget.widgetId}
				data={data()}
				sourceIds={props.widget.sourceIds ?? []}
				sources={sources()}
				citationScopeKey={props.widget.widgetId}
				plottedCount={model().model.plottedCount}
				unavailableCount={model().model.unavailableCount}
				missingColumns={model().model.missingColumns}
				withheldSeries={model().model.withheldSeries}
				tableColumnKeys={["x", ...valueKeys()]}
				valueColumnKeys={valueKeys()}
				headingHidden
			>
				<Show
					when={barModel()}
					fallback={
						<Show when={lineModel()}>
							{(line) => (
								<LinePlot
									model={line()}
									xLabel={chartWidgetXAxisTitle(props.widget)}
									yLabel={yLabel()}
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
							yLabel={yLabel()}
							yUnit={props.widget.unit}
							title={props.widget.title}
						/>
					)}
				</Show>
			</ChartShell>
		</div>
	);
}
