import type { BarChartProps } from "@research/contracts";
import { createMemo, type JSX, Show } from "solid-js";
import { BarPlot } from "../charts/BarPlot.tsx";
import { buildBarModel } from "../charts/barModel.ts";
import { ChartShell } from "../charts/ChartFrame.tsx";
import { presentedSeriesLabels } from "../charts/chartMath.ts";
import { resolveDataset } from "../datasetGuard.ts";
import type { RendererProps } from "../registry.tsx";

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
		return current === undefined
			? null
			: buildBarModel(current, {
					categoryKey: props.props.categoryKey,
					series: props.props.series,
					yUnit: props.props.yUnit,
				});
	});

	return (
		<ChartShell
			title={props.props.title}
			datasetRef={props.props.datasetRef}
			data={data()}
			sourceIds={props.props.sourceIds}
			sources={props.context.sources}
			citationScopeKey={props.componentId}
			plottedCount={model()?.plottedCount ?? 0}
			unavailableCount={model()?.unavailableCount ?? 0}
			missingColumns={model()?.missingColumns ?? []}
			withheldSeries={model()?.withheldSeries ?? []}
			tableColumnKeys={[props.props.categoryKey, ...props.props.series.map((series) => series.key)]}
			valueColumnKeys={props.props.series.map((series) => series.key)}
		>
			<Show when={model()}>
				{(current) => (
					<BarPlot
						model={current()}
						xLabel={props.props.xLabel}
						yLabel={props.props.yLabel}
						yUnit={props.props.yUnit}
						title={props.props.title}
					/>
				)}
			</Show>
		</ChartShell>
	);
}
