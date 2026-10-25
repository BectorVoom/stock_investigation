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
import { useMessages } from "@research/i18n/solid";
import { DateText, SafeLink } from "@research/ui-registry";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { UpstreamStatusAside } from "../components/UpstreamStatusAside.tsx";
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
import { commonMessages } from "../i18n/common.messages.ts";
import { formatInstant } from "../lib/format.ts";
import { createRemote } from "../lib/remote.ts";
import { sourcesMessages } from "./sources.messages.tsx";

type LicensePolicy = RegisterSourceRequest["licensePolicy"];
type TrustClassification = RegisterSourceRequest["trustClassification"];

const LICENSE_POLICIES = licensePolicySchema.options;
const TRUST_CLASSIFICATIONS = trustClassificationSchema.options;

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
	const m = useMessages(sourcesMessages);
	const licenseId = createUniqueId();
	const trustId = createUniqueId();
	const preview = () => props.pending.preview;
	return (
		<section
			aria-label={m().previewRegion}
			class="mt-3 rounded border border-slate-300 bg-slate-50 p-3"
		>
			<h4 class={HEADING}>
				{m().previewHeading(preview().title === "" ? m().untitledFeed : preview().title)}
			</h4>
			<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
				<dt class="text-slate-600">{m().feedUrl}</dt>
				<dd>
					<SafeLink url={preview().canonicalUrl}>{preview().canonicalUrl}</SafeLink>
				</dd>
				<dt class="text-slate-600">{m().type}</dt>
				<dd>{preview().sourceType}</dd>
				<dt class="text-slate-600">{m().site}</dt>
				<dd>
					<Show
						when={preview().siteLink}
						fallback={<span class="italic">{m().siteNotStated}</span>}
					>
						{(siteLink) => <SafeLink url={siteLink()}>{siteLink()}</SafeLink>}
					</Show>
				</dd>
				<dt class="text-slate-600">{m().suggestedPublisher}</dt>
				<dd>
					{preview().suggestedPublisher === "" ? m().notStated : preview().suggestedPublisher}
				</dd>
				<dt class="text-slate-600">{m().itemsFound}</dt>
				<dd data-field="item-count">{preview().itemCount}</dd>
				<dt class="text-slate-600">{m().itemsRejected}</dt>
				<dd data-field="rejected-count">{m().rejectedCount(preview().rejectedItemCount)}</dd>
			</dl>
			<h5 class="mt-2 text-xs font-semibold text-slate-700">{m().sampleItems}</h5>
			<Show when={preview().sampleItems.length > 0} fallback={<Empty>{m().noUsableItems}</Empty>}>
				<ul aria-label={m().sampleItems} class="list-disc pl-5 text-xs">
					<For each={preview().sampleItems}>
						{(item) => (
							<li>
								<SafeLink url={item.canonicalUrl}>{item.title}</SafeLink> — {m().published}{" "}
								<DateText iso={item.publishedAt} missing={m().dateNotStated} />
							</li>
						)}
					</For>
				</ul>
			</Show>

			<Show when={preview().alreadySubscribed}>
				<output class="mt-2 block text-xs text-amber-900">{m().alreadySubscribed}</output>
			</Show>
			<div class="mt-2 grid grid-cols-2 gap-2">
				<div>
					<label for={licenseId} class={LABEL}>
						{m().licensePolicy}
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
									{m().license(policy)}
								</option>
							)}
						</For>
					</Select>
				</div>
				<div>
					<label for={trustId} class={LABEL}>
						{m().trustClassification}
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
									{m().trust(trust)}
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
					{m().subscribeToThisSource}
				</button>
				<button type="button" class={BUTTON} onClick={() => props.onDiscard()}>
					{m().discardPreview}
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
	const m = useMessages(sourcesMessages);
	const common = useMessages(commonMessages);
	const source = () => props.source;
	return (
		<tr class="border-b border-slate-200 align-top" data-source-id={source().sourceId}>
			<th scope="row" class="py-1 pr-2 font-medium">
				<SafeLink url={source().canonicalUrl}>{source().title}</SafeLink>
				<span class="block font-normal text-slate-600">{source().publisher}</span>
			</th>
			<td class="py-1 pr-2">
				{source().sourceType}; {m().license(source().licensePolicy)};{" "}
				{m().trust(source().trustClassification)}
			</td>
			<td class="py-1 pr-2" data-field="feed-status">
				<span class="font-semibold">{m().feedStatus(source().feedStatus)}</span>
				<span class="block text-slate-700">
					{(() => {
						const lastFetchedAt = source().lastFetchedAt;
						return m().lastFetch(
							lastFetchedAt === null ? m().neverFetched : formatInstant(lastFetchedAt),
						);
					})()}
				</span>
				<Show when={source().lastErrorCode}>
					{(code) => (
						<span class="block text-red-900">
							{m().lastError} <span class="font-mono">{code()}</span>
							<UpstreamStatusAside
								status={source().lastErrorUpstreamStatus}
								field="last-error-upstream-status"
							/>
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
								aria-label={m().pauseNamed(source().title)}
								disabled={props.busy}
								onClick={() => props.onSetPaused(source(), true)}
							>
								{m().pause}
							</button>
						}
					>
						<button
							type="button"
							class={BUTTON}
							aria-label={m().resumeNamed(source().title)}
							disabled={props.busy}
							onClick={() => props.onSetPaused(source(), false)}
						>
							{m().resume}
						</button>
					</Show>
					<button
						type="button"
						class={BUTTON_DANGER}
						aria-label={m().removeNamed(source().title)}
						disabled={props.busy}
						onClick={() => props.onRemove(source())}
					>
						{common().remove}
					</button>
				</div>
			</td>
		</tr>
	);
}

function ArticleList(props: { readonly api: ApiClient }): JSX.Element {
	const m = useMessages(sourcesMessages);
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
			title={m().recentArticles}
			actions={
				<button
					type="button"
					class={BUTTON}
					disabled={loading()}
					onClick={() => void loadPage(undefined)}
				>
					{m().reloadArticles}
				</button>
			}
		>
			<Show when={failure()}>
				{(error) => <ErrorNotice failure={error()} title={m().articlesLoadFailed} />}
			</Show>
			<Show
				when={articles().length > 0}
				fallback={
					<Show when={!loading() && failure() === null}>
						<Empty>{m().noArticles}</Empty>
					</Show>
				}
			>
				<ul aria-label={m().articles} class="mt-1 space-y-1.5 text-sm">
					<For each={articles()}>
						{(article) => (
							<li data-article-id={article.articleId}>
								<SafeLink url={article.canonicalUrl}>{article.title}</SafeLink>
								<span class="block text-xs text-slate-700">
									{article.publisher}; {m().published}{" "}
									<DateText iso={article.publishedAt} missing={m().dateNotStated} />;{" "}
									{m().retrieved} <DateText iso={article.retrievedAt} missing={m().dateNotStated} />
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
				<Loading label={m().articlesThing} />
			</Show>
			<Show when={nextCursor()}>
				{(cursor) => (
					<button
						type="button"
						class={`${BUTTON} mt-2`}
						disabled={loading()}
						onClick={() => void loadPage(cursor())}
					>
						{m().loadMoreArticles}
					</button>
				)}
			</Show>
		</Section>
	);
}

/** Sources: preview-then-subscribe, the recommended catalog, manual refresh and recent articles. */
export function SourcesView(props: { readonly api: ApiClient }): JSX.Element {
	const m = useMessages(sourcesMessages);
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
				setFailure({ title: m().previewFailed, error: result.error });
			}
		});

	const register = (request: RegisterSourceRequest) =>
		runAction(async () => {
			const result = await props.api.registerSource(request);
			if (result.ok) {
				setPending(null);
				setUrl("");
				setStatus(m().subscribedTo(result.value.title));
				await sources.reload();
			} else {
				setFailure({ title: m().notSubscribed, error: result.error });
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
			else setFailure({ title: m().notUpdated, error: result.error });
		});

	const remove = (source: NewsSource) =>
		runAction(async () => {
			const result = await props.api.deleteSource(source.sourceId);
			if (result.ok) {
				setStatus(m().removed(source.title));
				await sources.reload();
			} else {
				setFailure({ title: m().notRemoved, error: result.error });
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
				setFailure({ title: m().refreshNotQueued, error: result.error });
			}
		});

	return (
		<div class="space-y-3">
			<Show when={failure()}>
				{(current) => <ErrorNotice failure={current().error} title={current().title} />}
			</Show>
			<Show when={status()}>{(text) => <Notice tone="success">{text()}</Notice>}</Show>

			<Section title={m().addSourceTitle} label={m().addSourceLabel}>
				<p class="text-xs text-slate-700">{m().addSourceHint}</p>
				<form
					aria-label={m().previewForm}
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
							{m().feedOrSiteUrl}
						</label>
						<input
							id={urlId}
							type="url"
							class={INPUT}
							// i18n-exempt: an example URL, the same in every language
							placeholder="https://example.com/feed.xml"
							maxLength={2048}
							value={url()}
							onInput={(event) => setUrl(event.currentTarget.value)}
						/>
					</div>
					<button type="submit" class={BUTTON_PRIMARY} disabled={busy() || url().trim() === ""}>
						{m().previewSource}
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
				title={m().subscribedSources}
				actions={
					<button type="button" class={BUTTON} disabled={busy()} onClick={() => void refresh()}>
						{m().refreshNewsNow}
					</button>
				}
			>
				<Show when={refreshRun()}>
					{(run) => (
						<output data-refresh-run={run().runId} class="mt-1 block text-xs text-slate-800">
							{m().refreshQueued(<span class="font-mono">{run().runId}</span>, run().state)}
						</output>
					)}
				</Show>
				<RemoteView
					remote={sources.state()}
					label={m().sourcesThing}
					onRetry={() => void sources.reload()}
				>
					{(list) => (
						<Show when={list().length > 0} fallback={<Empty>{m().noSources}</Empty>}>
							<div class="overflow-x-auto">
								<table class="mt-1 w-full border-collapse text-left text-xs">
									<caption class="caption-top text-left text-slate-600">
										{m().sourcesCaption}
									</caption>
									<thead>
										<tr class="border-b border-slate-300">
											<th scope="col" class="pr-2">
												{m().sourceColumn}
											</th>
											<th scope="col" class="pr-2">
												{m().typeLicenseTrustColumn}
											</th>
											<th scope="col" class="pr-2">
												{m().statusColumn}
											</th>
											<th scope="col">{m().actionsColumn}</th>
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

			<Section title={m().recommendedSources}>
				<p class="text-xs text-slate-700">{m().recommendedHint}</p>
				<RemoteView
					remote={recommended.state()}
					label={m().recommendedThing}
					onRetry={() => void recommended.reload()}
				>
					{(entries) => (
						<Show when={entries().length > 0} fallback={<Empty>{m().catalogEmpty}</Empty>}>
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
												{entry.region} · {entry.language} · {m().trust(entry.trustClassification)} ·{" "}
												{m().defaultLicense(m().license(entry.licensePolicy))} ·{" "}
												{m().feedLastChecked}{" "}
												<DateText iso={entry.feedCheckedOn} missing={m().dateNotStated} />
											</p>
											<div class="mt-1 flex gap-2">
												<button
													type="button"
													class={BUTTON}
													aria-label={m().previewNamed(entry.title)}
													disabled={busy()}
													onClick={() =>
														void preview(entry.feedUrl, {
															licensePolicy: entry.licensePolicy,
															trustClassification: entry.trustClassification,
														})
													}
												>
													{m().preview}
												</button>
												<button
													type="button"
													class={BUTTON}
													aria-label={m().subscribeNamed(entry.title)}
													disabled={busy()}
													onClick={() => void subscribeRecommended(entry)}
												>
													{m().subscribe}
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
