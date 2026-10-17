import type { LineChartProps } from "@research/contracts";
import { createMemo, type JSX, Show } from "solid-js";
import { ChartShell } from "../charts/ChartFrame.tsx";
import { presentedSeriesLabels } from "../charts/chartMath.ts";
import { LinePlot } from "../charts/LinePlot.tsx";
import { buildLineModel } from "../charts/lineModel.ts";
import { resolveDataset } from "../datasetGuard.ts";
import type { RendererProps } from "../registry.tsx";

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
		return current === undefined
			? null
			: buildLineModel(current, { xKey: props.props.xKey, series: props.props.series });
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
			tableColumnKeys={[props.props.xKey, ...props.props.series.map((series) => series.key)]}
			valueColumnKeys={props.props.series.map((series) => series.key)}
		>
			<Show when={model()}>
				{(current) => (
					<LinePlot
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
