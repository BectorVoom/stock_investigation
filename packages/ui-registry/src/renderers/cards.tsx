import type { CompanyProfileProps, NewsCardProps, SourceListProps } from "@research/contracts";
import { createMemo, For, type JSX, Show } from "solid-js";
import { resolveDataset } from "../datasetGuard.ts";
import {
	CitationScope,
	ComponentCitation,
	citationGroupFocusOut,
	SourceList,
	useCitationScope,
} from "../parts/citations.tsx";
import { cellSourceIdsInOrder, DatasetTable } from "../parts/DatasetTable.tsx";
import { DataUnavailable, EmptyState, Unavailable } from "../parts/states.tsx";
import type { RendererProps } from "../registry.tsx";

function NewsCardBody(props: RendererProps<NewsCardProps>): JSX.Element {
	const groupKey = `${props.componentId}::source`;
	const scope = useCitationScope();
	const hoverEnd = () => scope?.hoverEnd();
	return (
		<div class="min-w-0">
			<h3 class="text-sm font-semibold text-slate-900">{props.props.headline}</h3>
			<p class="mt-1 text-sm text-slate-800">
				<Show
					when={props.props.summary !== null && props.props.summary !== ""}
					fallback={<Unavailable reason="no summary stored for this article" />}
				>
					{props.props.summary}
				</Show>
			</p>
			<p
				class="relative mt-2 flex flex-wrap items-center gap-1 text-xs"
				data-news-source="true"
				data-citation-group={groupKey}
				onMouseLeave={hoverEnd}
				onFocusOut={(event) => citationGroupFocusOut(event, hoverEnd)}
			>
				<span class="font-semibold text-slate-700">Source: </span>
				<ComponentCitation
					sourceId={props.props.sourceId}
					chipKey={`${groupKey}::${props.props.sourceId}`}
					sources={props.context.sources}
				/>
			</p>
		</div>
	);
}

export function NewsCard(props: RendererProps<NewsCardProps>): JSX.Element {
	return (
		<CitationScope sourceIdsInOrder={[props.props.sourceId]}>
			<NewsCardBody {...props} />
		</CitationScope>
	);
}

export function SourceListComponent(props: RendererProps<SourceListProps>): JSX.Element {
	return (
		<CitationScope sourceIdsInOrder={[...props.props.sourceIds]}>
			<div>
				<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
				<SourceList sourceIds={props.props.sourceIds} sources={props.context.sources} />
			</div>
		</CitationScope>
	);
}

const COUNTRY_NAMES = { JP: "Japan", US: "United States" } as const;

export function CompanyProfile(props: RendererProps<CompanyProfileProps>): JSX.Element {
	const data = createMemo(() =>
		props.props.datasetRef === undefined
			? undefined
			: resolveDataset(props.context, props.props.datasetRef),
	);
	// Cells render before the sources block, so their ids number first.
	const sourceIdsInOrder = createMemo(() => [
		...cellSourceIdsInOrder(data()),
		...props.props.sourceIds,
	]);
	return (
		<CitationScope sourceIdsInOrder={sourceIdsInOrder()}>
			<div>
				<h3 class="text-sm font-semibold text-slate-900">{props.props.companyName}</h3>
				<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
					<dt class="text-slate-600">Ticker</dt>
					<dd data-field="ticker">{props.props.ticker}</dd>
					<dt class="text-slate-600">Exchange</dt>
					<dd data-field="exchange">{props.props.exchange}</dd>
					<dt class="text-slate-600">Market</dt>
					<dd data-field="country">{COUNTRY_NAMES[props.props.country]}</dd>
				</dl>
				<h4 class="mt-2 text-xs font-semibold text-slate-700">Relevant products and services</h4>
				<Show
					when={props.props.productsOrServices.length > 0}
					fallback={<EmptyState>No products or services recorded.</EmptyState>}
				>
					<ul class="list-disc pl-5 text-sm">
						<For each={props.props.productsOrServices}>{(item) => <li>{item}</li>}</For>
					</ul>
				</Show>
				<h4 class="mt-2 text-xs font-semibold text-slate-700">Business exposure</h4>
				<p class="text-sm text-slate-800">{props.props.businessExposure}</p>
				<Show when={props.props.datasetRef}>
					{(datasetRef) => (
						<div class="mt-2">
							<h4 class="text-xs font-semibold text-slate-700">Metrics</h4>
							<Show when={data()} fallback={<DataUnavailable datasetRef={datasetRef()} />}>
								{(current) => (
									<DatasetTable
										data={current()}
										caption={current().dataset.title}
										sources={props.context.sources}
										citationGroupKey={`${props.componentId}::table`}
									/>
								)}
							</Show>
						</div>
					)}
				</Show>
				<SourceList sourceIds={props.props.sourceIds} sources={props.context.sources} />
			</div>
		</CitationScope>
	);
}
