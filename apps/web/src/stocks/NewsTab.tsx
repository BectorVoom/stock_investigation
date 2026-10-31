import { STOCK_LIMITS, type StockNewsArticle } from "@research/contracts";
import type { Locale } from "@research/i18n";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createEffect, createMemo, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { BUTTON, Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { formatHash } from "../router.ts";
import { stockNewsMessages } from "./stockNews.messages.ts";
import { MAX_MORE_PAGES, stockNewsFor } from "./stockNews.ts";
import type { StockTabProps } from "./stockTabs.ts";

const SOURCES_HASH = formatHash({ view: "sources", workspaceId: null, section: null, stock: null });

const LINK = "inline-flex min-h-6 items-center text-blue-800 underline pointer-coarse:min-h-11";

/** The most articles the list holds: the first page and `MAX_MORE_PAGES` appended ones. */
const MAX_LISTED = (MAX_MORE_PAGES + 1) * STOCK_LIMITS.newsPageSize;

const LOCALE_TAGS: { readonly [L in Locale]: string } = { en: "en-US", ja: "ja-JP" };

/** One date formatter per language (formatters are costly to build). */
const dateFormats = new Map<Locale, Intl.DateTimeFormat>();

/** An instant as a calendar date in the UI language and the viewer's zone ("Oct 1, 2026", "2026年10月1日"). */
function formatArticleDate(iso: string, locale: Locale): string {
	let format = dateFormats.get(locale);
	if (format === undefined) {
		format = new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: "medium" });
		dateFormats.set(locale, format);
	}
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? format.format(ms) : iso;
}

/**
 * The Stocks page's News tab (ADR-0049 §7): the owner's stored articles
 * (Sources feeds) that mention the stock, newest first, 20 a page, through
 * the per-stock store of `stockNews.ts`. The first page is attached only
 * while the tab is shown (ADR-0049 §3 rule 4), so a hidden panel makes no
 * request; Show more appends the next page, and the appended pages stay
 * while the stock stays selected (they are dropped with the panel).
 */
export function NewsTab(props: StockTabProps): JSX.Element {
	const m = useMessages(stockNewsMessages);
	const locale = useLocale();

	const stockId = createMemo(() => props.stock().stockId);
	const store = createMemo(() => stockNewsFor(props.api, stockId()));
	createEffect(() => {
		if (!props.active()) return;
		const current = store();
		onCleanup(current.attach(props.visibility));
	});
	// The panel goes when another stock is chosen: its appended pages go too.
	createEffect(() => {
		const current = store();
		onCleanup(() => current.dropMore());
	});

	const first = () => store().first;
	const page = () => first().value();
	const terms = createMemo(() => page()?.terms ?? []);
	const termsText = () => m().termList(terms().map((term) => term.text));
	const firstTerm = () => terms()[0]?.text ?? props.stock().symbol;
	const stockLabel = () => props.stock().name ?? props.stock().symbol;
	const articles = () => store().articles();
	const canShowMore = () => store().nextCursor() !== null && !store().moreLimitReached();
	const status = () => {
		const added = store().lastAdded();
		return added === null ? "" : m().loaded(added, articles().length);
	};

	return (
		<div class="space-y-3" data-field="stock-news-tab">
			<Show when={first().failure()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title={m().newsFailed}
						onRetry={() => first().refresh()}
					/>
				)}
			</Show>
			<Switch>
				<Match when={page() === undefined}>
					<Show when={first().failure() === null}>
						<Loading label={m().newsThing} />
					</Show>
				</Match>
				<Match when={terms().length === 0}>
					<Empty>
						<span data-field="stock-news-no-terms">{m().noTerms}</span>
					</Empty>
				</Match>
				<Match when={articles().length === 0 && store().nextCursor() === null}>
					<div
						class="rounded border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600"
						data-field="stock-news-none"
					>
						<p>
							{m().none(firstTerm())}{" "}
							<a href={SOURCES_HASH} class={LINK}>
								{m().openSources}
							</a>
						</p>
						<p class="text-xs">{m().searchedFor(termsText())}</p>
					</div>
				</Match>
				<Match when={articles().length === 0}>
					<div class="text-sm text-slate-700" data-field="stock-news-none-yet">
						<p>{m().noneYet(firstTerm())}</p>
						<p class="text-xs text-slate-600">{m().searchedFor(termsText())}</p>
					</div>
				</Match>
				<Match when={articles().length > 0}>
					<p class="text-xs text-slate-600">{m().searchedFor(termsText())}</p>
					<ul aria-label={m().articlesLabel(stockLabel())} class="space-y-2 text-sm">
						<For each={articles()}>
							{(article) => <ArticleItem article={article} locale={locale()} />}
						</For>
					</ul>
				</Match>
			</Switch>
			<Show when={store().moreFailure()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title={m().moreFailed}
						onRetry={() => store().loadMore()}
					/>
				)}
			</Show>
			<Show when={page() !== undefined && terms().length > 0 && canShowMore()}>
				<button
					type="button"
					class={`${BUTTON} pointer-coarse:min-h-11`}
					disabled={store().moreLoading()}
					aria-busy={store().moreLoading()}
					onClick={() => store().loadMore()}
				>
					{m().showMore}
				</button>
			</Show>
			<Show when={store().moreLimitReached()}>
				<p class="text-xs text-slate-600">{m().moreLimit(MAX_LISTED)}</p>
			</Show>
			{/* Always in the document, so a change to its text is announced. */}
			<output aria-live="polite" class="sr-only" data-field="stock-news-status">
				{status()}
			</output>
		</div>
	);
}

/** One stored article: linked title, publisher, date, excerpt (when stored) and the matched term. */
function ArticleItem(props: {
	readonly article: StockNewsArticle;
	readonly locale: Locale;
}): JSX.Element {
	const m = useMessages(stockNewsMessages);
	return (
		<li data-article-id={props.article.articleId}>
			<SafeLink url={props.article.canonicalUrl}>{props.article.title}</SafeLink>
			<span class="block text-xs text-slate-700">
				{props.article.publisher}
				{" · "}
				<Show
					when={props.article.publishedAt}
					fallback={
						<>
							{m().retrieved}{" "}
							<time dateTime={props.article.retrievedAt}>
								{formatArticleDate(props.article.retrievedAt, props.locale)}
							</time>{" "}
							{m().noPublishedDate}
						</>
					}
				>
					{(published) => (
						<>
							{m().published}{" "}
							<time dateTime={published()}>{formatArticleDate(published(), props.locale)}</time>
						</>
					)}
				</Show>
				{" · "}
				<span data-field="stock-news-mention">{m().mentions(props.article.mentions.text)}</span>
			</span>
			<Show when={props.article.excerpt}>
				{(excerpt) => <span class="block text-xs text-slate-800">{excerpt()}</span>}
			</Show>
		</li>
	);
}
