import type {
	CompanyProfileProps,
	ImageGalleryProps,
	NewsCardProps,
	SourceListProps,
} from "@research/contracts";
import { createMemo, For, type JSX, Show } from "solid-js";
import { resolveDataset } from "../datasetGuard.ts";
import { safeHttpsUrl } from "../format.ts";
import { DatasetTable } from "../parts/DatasetTable.tsx";
import { SourceCitation, SourceList } from "../parts/SourceLinks.tsx";
import { DataUnavailable, EmptyState, Unavailable } from "../parts/states.tsx";
import type { RendererProps } from "../registry.tsx";

export function NewsCard(props: RendererProps<NewsCardProps>): JSX.Element {
	return (
		<div>
			<h3 class="text-sm font-semibold text-slate-900">{props.props.headline}</h3>
			<p class="mt-1 text-sm text-slate-800">
				<Show
					when={props.props.summary !== null && props.props.summary !== ""}
					fallback={<Unavailable reason="no summary stored for this article" />}
				>
					{props.props.summary}
				</Show>
			</p>
			<p class="mt-2 text-xs" data-news-source="true">
				<span class="font-semibold text-slate-700">Source: </span>
				<SourceCitation sourceId={props.props.sourceId} sources={props.context.sources} />
			</p>
		</div>
	);
}

export function SourceListComponent(props: RendererProps<SourceListProps>): JSX.Element {
	return (
		<div>
			<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
			<SourceList sourceIds={props.props.sourceIds} sources={props.context.sources} />
		</div>
	);
}

const COUNTRY_NAMES = { JP: "Japan", US: "United States" } as const;

export function CompanyProfile(props: RendererProps<CompanyProfileProps>): JSX.Element {
	const data = createMemo(() =>
		props.props.datasetRef === undefined
			? undefined
			: resolveDataset(props.context, props.props.datasetRef),
	);
	return (
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
								/>
							)}
						</Show>
					</div>
				)}
			</Show>
			<SourceList sourceIds={props.props.sourceIds} sources={props.context.sources} />
		</div>
	);
}

type GalleryImage = ImageGalleryProps["images"][number];

function GalleryFigure(props: {
	readonly image: GalleryImage;
	readonly context: RendererProps<ImageGalleryProps>["context"];
}): JSX.Element {
	// Only owner-approved assets are displayed, and only from a URL that is still https.
	const approved = createMemo(() => {
		const asset = props.context.assets.get(props.image.assetRef);
		if (asset === undefined) return null;
		const src = safeHttpsUrl(asset.imageUrl);
		return src === null ? null : { asset, src };
	});
	return (
		<figure class="m-0 rounded border border-slate-200 p-2">
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
					<p class="mt-1 text-2xs">
						<SourceCitation sourceId={sourceId()} sources={props.context.sources} />
					</p>
				)}
			</Show>
		</figure>
	);
}

export function ImageGallery(props: RendererProps<ImageGalleryProps>): JSX.Element {
	return (
		<div>
			<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
			<div class="mt-1 grid grid-cols-2 gap-2">
				<For each={props.props.images}>
					{(image) => <GalleryFigure image={image} context={props.context} />}
				</For>
			</div>
		</div>
	);
}
