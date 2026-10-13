import type { DataTableProps, FinancialTableProps } from "@research/contracts";
import { createMemo, For, type JSX, Show } from "solid-js";
import { resolveDataset } from "../datasetGuard.ts";
import { CitationScope, SourceList } from "../parts/citations.tsx";
import { cellSourceIdsInOrder, DatasetTable, type RowSelection } from "../parts/DatasetTable.tsx";
import { DataUnavailable } from "../parts/states.tsx";
import { positionLabels, positionMetricsMentioned } from "../positionLabels.ts";
import type { RenderContext, RendererProps } from "../registry.tsx";

function rowSelection(componentId: string, context: RenderContext): RowSelection {
	return {
		selectedKey:
			context.selection !== null && context.selection.componentId === componentId
				? context.selection.itemKey
				: null,
		onSelect: (itemKey) => context.onSelect(componentId, itemKey),
	};
}

export function DataTable(props: RendererProps<DataTableProps>): JSX.Element {
	const data = createMemo(() => resolveDataset(props.context, props.props.datasetRef));
	// Cells render before the sources block, so their ids number first.
	const sourceIdsInOrder = createMemo(() => [
		...cellSourceIdsInOrder(data()),
		...props.props.sourceIds,
	]);
	return (
		<CitationScope sourceIdsInOrder={sourceIdsInOrder()}>
			<div>
				<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
				<Show when={data()} fallback={<DataUnavailable datasetRef={props.props.datasetRef} />}>
					{(current) => (
						<DatasetTable
							data={current()}
							caption={props.props.caption ?? current().dataset.title}
							sources={props.context.sources}
							selection={rowSelection(props.componentId, props.context)}
							citationGroupKey={`${props.componentId}::table`}
						/>
					)}
				</Show>
				<SourceList sourceIds={props.props.sourceIds} sources={props.context.sources} />
			</div>
		</CitationScope>
	);
}

export function FinancialTable(props: RendererProps<FinancialTableProps>): JSX.Element {
	const data = createMemo(() => resolveDataset(props.context, props.props.datasetRef));
	const positionMetrics = createMemo(() =>
		positionMetricsMentioned((data()?.dataset.columns ?? []).map((column) => column.label)),
	);
	const sourceIdsInOrder = createMemo(() => [
		...cellSourceIdsInOrder(data()),
		...props.props.sourceIds,
	]);
	return (
		<CitationScope sourceIdsInOrder={sourceIdsInOrder()}>
			<div>
				<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
				<Show when={data()} fallback={<DataUnavailable datasetRef={props.props.datasetRef} />}>
					{(current) => (
						<DatasetTable
							data={current()}
							caption={current().dataset.title}
							sources={props.context.sources}
							selection={rowSelection(props.componentId, props.context)}
							citationGroupKey={`${props.componentId}::table`}
						/>
					)}
				</Show>
				<p data-methodology-note="true" class="mt-2 text-xs text-slate-700">
					<span class="font-semibold">Methodology: </span>
					{props.props.methodologyNote}
				</p>
				<For each={positionMetrics()}>
					{(metric) => (
						<p data-position-caveat={metric} class="mt-1 text-xs text-slate-700">
							<span class="font-semibold">{positionLabels(metric).heading}: </span>
							{positionLabels(metric).caveat}
						</p>
					)}
				</For>
				<SourceList sourceIds={props.props.sourceIds} sources={props.context.sources} />
			</div>
		</CitationScope>
	);
}
