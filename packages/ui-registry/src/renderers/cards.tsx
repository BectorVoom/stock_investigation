import type {
	CompanyProfileProps,
	ImageGalleryProps,
	NewsCardProps,
	SourceListProps,
} from "@research/contracts";
import { createMemo, For, type JSX, Show } from "solid-js";
import { resolveDataset } from "../datasetGuard.ts";
import { safeHttpsUrl } from "../format.ts";
import { cellSourceIdsInOrder, DatasetTable } from "../parts/DatasetTable.tsx";
import {
	citationGroupFocusOut,
	CitationScope,
	ComponentCitation,
	SourceList,
	useCitationScope,
} from "../parts/citations.tsx";
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

type GalleryImage = ImageGalleryProps["images"][number];

function GalleryFigure(props: {
	readonly image: GalleryImage;
	readonly groupKey: string;
	readonly context: RendererProps<ImageGalleryProps>["context"];
}): JSX.Element {
	// Only owner-approved assets are displayed, and only from a URL that is still https.
	const approved = createMemo(() => {
		const asset = props.context.assets.get(props.image.assetRef);
		if (asset === undefined) return null;
		const src = safeHttpsUrl(asset.imageUrl);
		return src === null ? null : { asset, src };
	});
	const scope = useCitationScope();
	const hoverEnd = () => scope?.hoverEnd();
	const figureGroupKey = `${props.groupKey}::${props.image.assetRef}`;
	return (
		<figure
			class="relative m-0 rounded border border-slate-200 p-2"
			data-citation-group={figureGroupKey}
			onMouseLeave={hoverEnd}
			onFocusOut={(event) => citationGroupFocusOut(event, hoverEnd)}
		>
			<Show
				when={approved()}
				fallback={
					<div
						role="img"
						aria-label={`Image unavailable: asset ${props.image.assetRef} is not approved`}
						data-image-placeholder={props.image.assetRef}
						class="flex h-32 items-center justify-center bg-slate-100 px-2 text-center text-xs text-slate-600"
					>
						Image unavailable — asset "{props.image.assetRef}" is not an approved image.
					</div>
				}
			>
				{(current) => (
					<>
						<img
							src={current().src}
							alt={current().asset.altText}
							loading="lazy"
							decoding="async"
							referrerpolicy="no-referrer"
							class="max-h-64 w-full object-contain"
						/>
						<p class="mt-1 text-2xs text-slate-600">
							Permission: {current().asset.permissionBasis}
						</p>
					</>
				)}
			</Show>
			<Show when={props.image.caption}>
				{(caption) => <figcaption class="mt-1 text-xs text-slate-800">{caption()}</figcaption>}
			</Show>
			<Show when={approved()?.asset.sourceEvidenceId}>
				{(sourceId) => (
					<p class="mt-1 flex flex-wrap items-center gap-1 text-2xs">
						<ComponentCitation
							sourceId={sourceId()}
							chipKey={`${figureGroupKey}::${sourceId()}`}
							sources={props.context.sources}
						/>
					</p>
				)}
			</Show>
		</figure>
	);
}

function ImageGalleryBody(props: RendererProps<ImageGalleryProps>): JSX.Element {
	const groupKey = `${props.componentId}::gallery`;
	return (
		<div class="min-w-0">
			<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
			<div class="mt-1 grid grid-cols-2 gap-2">
				<For each={props.props.images}>
					{(image) => <GalleryFigure image={image} groupKey={groupKey} context={props.context} />}
				</For>
			</div>
		</div>
	);
}

export function ImageGallery(props: RendererProps<ImageGalleryProps>): JSX.Element {
	// Figures render in order; the same source keeps one number across them.
	const sourceIdsInOrder = createMemo(() =>
		props.props.images.flatMap((image) => {
			const evidenceId = props.context.assets.get(image.assetRef)?.sourceEvidenceId ?? null;
			return evidenceId === null ? [] : [evidenceId];
		}),
	);
	return (
		<CitationScope sourceIdsInOrder={sourceIdsInOrder()}>
			<ImageGalleryBody {...props} />
		</CitationScope>
	);
}
