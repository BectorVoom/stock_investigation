import {
	type Article,
	licensePolicySchema,
	type NewsSource,
	type RecommendedSource,
	type RegisterSourceRequest,
	type ResearchRun,
	type SourcePreview,
	trustClassificationSchema,
} from "@research/contracts";
import { DateText, SafeLink } from "@research/ui-registry";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	Empty,
	ErrorNotice,
	HEADING,
	INPUT,
	LABEL,
	Loading,
	Notice,
	RemoteView,
	Section,
	Select,
} from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createRemote } from "../lib/remote.ts";

type LicensePolicy = RegisterSourceRequest["licensePolicy"];
type TrustClassification = RegisterSourceRequest["trustClassification"];

const LICENSE_POLICIES = licensePolicySchema.options;
const TRUST_CLASSIFICATIONS = trustClassificationSchema.options;

const LICENSE_TEXT: { readonly [P in LicensePolicy]: string } = {
	"headline-and-link-only": "Headline and link only (no excerpt stored)",
	"short-excerpt-permitted": "Short excerpt permitted",
};

/** A preview awaiting the owner's explicit decision; nothing is subscribed until they click. */
interface PendingPreview {
	readonly requestedUrl: string;
	readonly preview: SourcePreview;
	readonly licensePolicy: LicensePolicy;
	readonly trustClassification: TrustClassification;
}

function PreviewPanel(props: {
	readonly pending: PendingPreview;
	readonly busy: boolean;
	readonly onChange: (pending: PendingPreview) => void;
	readonly onSubscribe: () => void;
	readonly onDiscard: () => void;
}): JSX.Element {
	const licenseId = createUniqueId();
	const trustId = createUniqueId();
	const preview = () => props.pending.preview;
	return (
		<section
			aria-label="Source preview"
			class="mt-3 rounded border border-slate-300 bg-slate-50 p-3"
		>
			<h4 class={HEADING}>
				Preview: {preview().title === "" ? "(untitled feed)" : preview().title}
			</h4>
			<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
				<dt class="text-slate-600">Feed URL</dt>
				<dd>
					<SafeLink url={preview().canonicalUrl}>{preview().canonicalUrl}</SafeLink>
				</dd>
				<dt class="text-slate-600">Type</dt>
				<dd>{preview().sourceType}</dd>
				<dt class="text-slate-600">Site</dt>
				<dd>
					<Show
						when={preview().siteLink}
						fallback={<span class="italic">not stated by the feed</span>}
					>
						{(siteLink) => <SafeLink url={siteLink()}>{siteLink()}</SafeLink>}
					</Show>
				</dd>
				<dt class="text-slate-600">Publisher (suggested)</dt>
				<dd>{preview().suggestedPublisher === "" ? "not stated" : preview().suggestedPublisher}</dd>
				<dt class="text-slate-600">Items found</dt>
				<dd data-field="item-count">{preview().itemCount}</dd>
				<dt class="text-slate-600">Items rejected</dt>
				<dd data-field="rejected-count">
					{preview().rejectedItemCount} (unsafe or malformed links are never stored)
				</dd>
			</dl>
			<h5 class="mt-2 text-xs font-semibold text-slate-700">Sample items</h5>
			<Show
				when={preview().sampleItems.length > 0}
				fallback={<Empty>The feed returned no usable items.</Empty>}
			>
				<ul aria-label="Sample items" class="list-disc pl-5 text-xs">
					<For each={preview().sampleItems}>
						{(item) => (
							<li>
								<SafeLink url={item.canonicalUrl}>{item.title}</SafeLink> — published{" "}
								<DateText iso={item.publishedAt} missing="date not stated" />
							</li>
						)}
					</For>
				</ul>
			</Show>

			<Show when={preview().alreadySubscribed}>
				<output class="mt-2 block text-xs text-amber-900">
					You already subscribe to this feed.
				</output>
			</Show>
			<div class="mt-2 grid grid-cols-2 gap-2">
				<div>
					<label for={licenseId} class={LABEL}>
						License policy
					</label>
					<Select
						id={licenseId}
						onChange={(event) => {
							const licensePolicy = LICENSE_POLICIES.find(
								(policy) => policy === event.currentTarget.value,
							);
							if (licensePolicy !== undefined) props.onChange({ ...props.pending, licensePolicy });
						}}
					>
						<For each={LICENSE_POLICIES}>
							{(policy) => (
								<option value={policy} selected={props.pending.licensePolicy === policy}>
									{LICENSE_TEXT[policy]}
								</option>
							)}
						</For>
					</Select>
				</div>
				<div>
					<label for={trustId} class={LABEL}>
						Trust classification
					</label>
					<Select
						id={trustId}
						onChange={(event) => {
							const trustClassification = TRUST_CLASSIFICATIONS.find(
								(trust) => trust === event.currentTarget.value,
							);
							if (trustClassification !== undefined) {
								props.onChange({ ...props.pending, trustClassification });
							}
						}}
					>
						<For each={TRUST_CLASSIFICATIONS}>
							{(trust) => (
								<option value={trust} selected={props.pending.trustClassification === trust}>
									{trust}
								</option>
							)}
						</For>
					</Select>
				</div>
			</div>
			<div class="mt-2 flex gap-2">
				<button
					type="button"
					class={BUTTON_PRIMARY}
					disabled={props.busy || preview().alreadySubscribed}
					onClick={() => props.onSubscribe()}
				>
					Subscribe to this source
				</button>
				<button type="button" class={BUTTON} onClick={() => props.onDiscard()}>
					Discard preview
				</button>
			</div>
		</section>
	);
}

function SourceRow(props: {
	readonly source: NewsSource;
	readonly busy: boolean;
	readonly onSetPaused: (source: NewsSource, paused: boolean) => void;
	readonly onRemove: (source: NewsSource) => void;
}): JSX.Element {
	const source = () => props.source;
	return (
		<tr class="border-b border-slate-200 align-top" data-source-id={source().sourceId}>
			<th scope="row" class="py-1 pr-2 font-medium">
				<SafeLink url={source().canonicalUrl}>{source().title}</SafeLink>
				<span class="block font-normal text-slate-600">{source().publisher}</span>
			</th>
			<td class="py-1 pr-2">
				{source().sourceType}; {LICENSE_TEXT[source().licensePolicy]};{" "}
				{source().trustClassification}
			</td>
			<td class="py-1 pr-2" data-field="feed-status">
				<span class="font-semibold">{source().feedStatus}</span>
				<span class="block text-slate-700">
					Last fetch: {(() => {
						const lastFetchedAt = source().lastFetchedAt;
						return lastFetchedAt === null ? "never fetched" : formatInstant(lastFetchedAt);
					})()}
				</span>
				<Show when={source().lastErrorCode}>
					{(code) => (
						<span class="block text-red-900">
							Last error: <span class="font-mono">{code()}</span>
						</span>
					)}
				</Show>
			</td>
			<td class="py-1">
				<div class="flex flex-wrap gap-1">
					<Show
						when={source().feedStatus === "paused"}
						fallback={
							<button
								type="button"
								class={BUTTON}
								aria-label={`Pause ${source().title}`}
								disabled={props.busy}
								onClick={() => props.onSetPaused(source(), true)}
							>
								Pause
							</button>
						}
					>
						<button
							type="button"
							class={BUTTON}
							aria-label={`Resume ${source().title}`}
							disabled={props.busy}
							onClick={() => props.onSetPaused(source(), false)}
						>
							Resume
						</button>
					</Show>
					<button
						type="button"
						class={BUTTON_DANGER}
						aria-label={`Remove ${source().title}`}
						disabled={props.busy}
						onClick={() => props.onRemove(source())}
					>
						Remove
					</button>
				</div>
			</td>
		</tr>
	);
}

function ArticleList(props: { readonly api: ApiClient }): JSX.Element {
	const [articles, setArticles] = createSignal<readonly Article[]>([]);
	const [nextCursor, setNextCursor] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);

	// Only the most recently requested page may be applied, so an earlier answer can never
	// be appended after (or replace) a later one.
	let latestRequest = 0;
	const loadPage = async (cursor: string | undefined) => {
		latestRequest += 1;
		const request = latestRequest;
		setLoading(true);
		setFailure(null);
		const result = await props.api.listArticles(cursor === undefined ? {} : { cursor });
		if (request !== latestRequest) return;
		setLoading(false);
		if (!result.ok) {
			setFailure(result.error);
			return;
		}
		setArticles((current) =>
			cursor === undefined ? result.value.articles : [...current, ...result.value.articles],
		);
		setNextCursor(result.value.nextCursor);
	};
	void loadPage(undefined);

	return (
		<Section
			title="Recent articles"
			actions={
				<button
					type="button"
					class={BUTTON}
					disabled={loading()}
					onClick={() => void loadPage(undefined)}
				>
					Reload articles
				</button>
			}
		>
			<Show when={failure()}>
				{(error) => <ErrorNotice failure={error()} title="Could not load articles." />}
			</Show>
			<Show
				when={articles().length > 0}
				fallback={
					<Show when={!loading() && failure() === null}>
						<Empty>
							No articles ingested yet. Subscribe to a source and choose “Refresh news now”.
						</Empty>
					</Show>
				}
			>
				<ul aria-label="Articles" class="mt-1 space-y-1.5 text-sm">
					<For each={articles()}>
						{(article) => (
							<li data-article-id={article.articleId}>
								<SafeLink url={article.canonicalUrl}>{article.title}</SafeLink>
								<span class="block text-xs text-slate-700">
									{article.publisher}; published{" "}
									<DateText iso={article.publishedAt} missing="date not stated" />; retrieved{" "}
									<DateText iso={article.retrievedAt} missing="date not stated" />
								</span>
								<Show when={article.excerpt}>
									{(excerpt) => <span class="block text-xs text-slate-800">{excerpt()}</span>}
								</Show>
							</li>
						)}
					</For>
				</ul>
			</Show>
			<Show when={loading()}>
				<Loading label="articles" />
			</Show>
			<Show when={nextCursor()}>
				{(cursor) => (
					<button
						type="button"
						class={`${BUTTON} mt-2`}
						disabled={loading()}
						onClick={() => void loadPage(cursor())}
					>
						Load more articles
					</button>
				)}
			</Show>
		</Section>
	);
}

/** Sources: preview-then-subscribe, the recommended catalog, manual refresh and recent articles. */
export function SourcesView(props: { readonly api: ApiClient }): JSX.Element {
	const sources = createRemote(() => props.api.listSources());
	const recommended = createRemote(() => props.api.listRecommendedSources());
	const [url, setUrl] = createSignal("");
	const [pending, setPending] = createSignal<PendingPreview | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [failure, setFailure] = createSignal<{ title: string; error: ApiFailure } | null>(null);
	const [status, setStatus] = createSignal<string | null>(null);
	const [refreshRun, setRefreshRun] = createSignal<ResearchRun | null>(null);
	/** Kept until the refresh is accepted, so a repeated click cannot queue two jobs. */
	let refreshKey: string | null = null;
	const urlId = createUniqueId();

	const runAction = async (action: () => Promise<void>) => {
		if (busy()) return;
		setBusy(true);
		setFailure(null);
		setStatus(null);
		await action();
		setBusy(false);
	};

	const preview = (
		targetUrl: string,
		defaults: Pick<PendingPreview, "licensePolicy" | "trustClassification">,
	) =>
		runAction(async () => {
			const result = await props.api.previewSource(targetUrl);
			if (result.ok) {
				setPending({ requestedUrl: targetUrl, preview: result.value, ...defaults });
			} else {
				setPending(null);
				setFailure({ title: "The source could not be previewed.", error: result.error });
			}
		});

	const register = (request: RegisterSourceRequest) =>
		runAction(async () => {
			const result = await props.api.registerSource(request);
			if (result.ok) {
				setPending(null);
				setUrl("");
				setStatus(`Subscribed to “${result.value.title}”.`);
				await sources.reload();
			} else {
				setFailure({ title: "The source was not subscribed.", error: result.error });
			}
		});

	const subscribePending = () => {
		const current = pending();
		if (current === null) return;
		void register({
			url: current.preview.canonicalUrl,
			licensePolicy: current.licensePolicy,
			trustClassification: current.trustClassification,
			...(current.preview.title.trim() === "" ? {} : { title: current.preview.title.trim() }),
			...(current.preview.suggestedPublisher.trim() === ""
				? {}
				: { publisher: current.preview.suggestedPublisher.trim() }),
		});
	};

	const subscribeRecommended = (entry: RecommendedSource) =>
		register({
			url: entry.feedUrl,
			title: entry.title,
			publisher: entry.publisher,
			licensePolicy: entry.licensePolicy,
			trustClassification: entry.trustClassification,
		});

	const setPaused = (source: NewsSource, paused: boolean) =>
		runAction(async () => {
			const result = await props.api.updateSource(source.sourceId, {
				feedStatus: paused ? "paused" : "active",
			});
			if (result.ok) await sources.reload();
			else setFailure({ title: "The source was not updated.", error: result.error });
		});

	const remove = (source: NewsSource) =>
		runAction(async () => {
			const result = await props.api.deleteSource(source.sourceId);
			if (result.ok) {
				setStatus(`Removed “${source.title}”.`);
				await sources.reload();
			} else {
				setFailure({ title: "The source was not removed.", error: result.error });
			}
		});

	const refresh = () =>
		runAction(async () => {
			refreshKey ??= props.api.newIdempotencyKey();
			const result = await props.api.refreshSources(refreshKey);
			if (result.ok) {
				refreshKey = null;
				setRefreshRun(result.value);
			} else {
				setFailure({ title: "The news refresh was not queued.", error: result.error });
			}
		});

	return (
		<div class="space-y-3">
			<Show when={failure()}>
				{(current) => <ErrorNotice failure={current().error} title={current().title} />}
			</Show>
			<Show when={status()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>

			<Section title="Add a news source by URL" label="Add a source">
				<p class="text-xs text-slate-700">
					The URL is checked and previewed first. Nothing is subscribed until you choose “Subscribe
					to this source”.
				</p>
				<form
					aria-label="Preview a source"
					class="mt-2 flex flex-wrap items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (url().trim() === "") return;
						void preview(url().trim(), {
							licensePolicy: "headline-and-link-only",
							trustClassification: "unclassified",
						});
					}}
				>
					<div class="min-w-64 flex-1">
						<label for={urlId} class={LABEL}>
							Feed or site URL
						</label>
						<input
							id={urlId}
							type="url"
							class={INPUT}
							placeholder="https://example.com/feed.xml"
							maxLength={2048}
							value={url()}
							onInput={(event) => setUrl(event.currentTarget.value)}
						/>
					</div>
					<button type="submit" class={BUTTON_PRIMARY} disabled={busy() || url().trim() === ""}>
						Preview source
					</button>
				</form>
				<Show when={pending()}>
					{(current) => (
						<PreviewPanel
							pending={current()}
							busy={busy()}
							onChange={setPending}
							onSubscribe={subscribePending}
							onDiscard={() => setPending(null)}
						/>
					)}
				</Show>
			</Section>

			<Section
				title="Subscribed sources"
				actions={
					<button type="button" class={BUTTON} disabled={busy()} onClick={() => void refresh()}>
						Refresh news now
					</button>
				}
			>
				<Show when={refreshRun()}>
					{(run) => (
						<output data-refresh-run={run().runId} class="mt-1 block text-xs text-slate-800">
							News refresh queued as run <span class="font-mono">{run().runId}</span> (state:{" "}
							{run().state}). It is fetched by the local runner; if the runner is offline it stays
							queued until the runner reconnects.
						</output>
					)}
				</Show>
				<RemoteView remote={sources.state()} label="sources" onRetry={() => void sources.reload()}>
					{(list) => (
						<Show when={list().length > 0} fallback={<Empty>No sources subscribed yet.</Empty>}>
							<div class="overflow-x-auto">
								<table class="mt-1 w-full border-collapse text-left text-xs">
									<caption class="caption-top text-left text-slate-600">
										Sources you subscribe to, with their last fetch status
									</caption>
									<thead>
										<tr class="border-b border-slate-300">
											<th scope="col" class="pr-2">
												Source
											</th>
											<th scope="col" class="pr-2">
												Type, license, trust
											</th>
											<th scope="col" class="pr-2">
												Status
											</th>
											<th scope="col">Actions</th>
										</tr>
									</thead>
									<tbody>
										<For each={list()}>
											{(source) => (
												<SourceRow
													source={source}
													busy={busy()}
													onSetPaused={(target, paused) => void setPaused(target, paused)}
													onRemove={(target) => void remove(target)}
												/>
											)}
										</For>
									</tbody>
								</table>
							</div>
						</Show>
					)}
				</RemoteView>
			</Section>

			<Section title="Recommended sources">
				<p class="text-xs text-slate-700">
					A curated starting list. None of these is subscribed automatically; preview or subscribe
					to each one yourself.
				</p>
				<RemoteView
					remote={recommended.state()}
					label="recommended sources"
					onRetry={() => void recommended.reload()}
				>
					{(entries) => (
						<Show when={entries().length > 0} fallback={<Empty>The catalog is empty.</Empty>}>
							<ul class="mt-1 space-y-2">
								<For each={entries()}>
									{(entry) => (
										<li
											data-catalog-id={entry.catalogId}
											class="rounded border border-slate-200 p-2"
										>
											<p class="text-sm font-medium text-slate-900">
												<SafeLink url={entry.homepageUrl}>{entry.title}</SafeLink>
												<span class="font-normal text-slate-700"> — {entry.publisher}</span>
											</p>
											<p class="text-xs text-slate-800">{entry.rationale}</p>
											<p class="text-xs text-slate-600">
												{entry.region} · {entry.language} · {entry.trustClassification} · default
												license: {LICENSE_TEXT[entry.licensePolicy]} · feed last checked{" "}
												<DateText iso={entry.feedCheckedOn} missing="date not stated" />
											</p>
											<div class="mt-1 flex gap-2">
												<button
													type="button"
													class={BUTTON}
													aria-label={`Preview ${entry.title}`}
													disabled={busy()}
													onClick={() =>
														void preview(entry.feedUrl, {
															licensePolicy: entry.licensePolicy,
															trustClassification: entry.trustClassification,
														})
													}
												>
													Preview
												</button>
												<button
													type="button"
													class={BUTTON}
													aria-label={`Subscribe to ${entry.title}`}
													disabled={busy()}
													onClick={() => void subscribeRecommended(entry)}
												>
													Subscribe
												</button>
											</div>
										</li>
									)}
								</For>
							</ul>
						</Show>
					)}
				</RemoteView>
			</Section>

			<ArticleList api={props.api} />
		</div>
	);
}
