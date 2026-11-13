import type { Article } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, Empty, ErrorNotice, Loading, Section } from "../components/ui.tsx";
import { sourcesMessages } from "../sources/sources.messages.tsx";
import { ArticleList } from "./ArticleList.tsx";
import { newsMessages } from "./news.messages.ts";
import { TaskNews } from "./TaskNews.tsx";

export function NewsView(props: { readonly api: ApiClient }): JSX.Element {
	const m = useMessages(sourcesMessages);
	const news = useMessages(newsMessages);
	const [articles, setArticles] = createSignal<readonly Article[]>([]);
	const [nextCursor, setNextCursor] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);
	const consumedCursors = new Set<string>();
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);

	// Only the most recently requested page may be applied, so an earlier answer can never
	// be appended after (or replace) a later one.
	let latestRequest = 0;
	let retryCursor: string | undefined;
	onCleanup(() => {
		latestRequest += 1;
	});
	const loadPage = async (cursor: string | undefined) => {
		if (loading() && latestRequest > 0) return false;
		latestRequest += 1;
		const request = latestRequest;
		retryCursor = cursor;
		setLoading(true);
		setFailure(null);
		const result = await props.api.listArticles(cursor === undefined ? {} : { cursor });
		if (request !== latestRequest) return false;
		setLoading(false);
		if (!result.ok) {
			setFailure(result.error);
			return false;
		}

		if (cursor === undefined) consumedCursors.clear();
		else consumedCursors.add(cursor);
		// Feed re-ingestion or concurrent insertions must not duplicate a lead.
		setArticles((current) => {
			const combined =
				cursor === undefined ? result.value.articles : [...current, ...result.value.articles];
			const seen = new Set<string>();
			return combined.filter((article) => {
				if (seen.has(article.canonicalUrl)) return false;
				seen.add(article.canonicalUrl);
				return true;
			});
		});
		const next = result.value.nextCursor;
		if (next !== null && consumedCursors.has(next)) {
			setNextCursor(null);
			setFailure({
				kind: "invalid-response",
				code: "INVALID_RESPONSE",
				status: null,
				message: news().scanStalled,
				detail: null,
				issues: [],
			});
			retryCursor = undefined;
			return false;
		}
		setNextCursor(next);
		return true;
	};
	void loadPage(undefined);

	return (
		<div class="space-y-3">
			<TaskNews api={props.api} />
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
				<p class="mb-3 text-sm">
					<a class="inline-flex min-h-11 items-center text-blue-800 underline" href="#/sources">
						{news().manageSources}
					</a>
				</p>
				<Show when={failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().articlesLoadFailed}
							onRetry={() => void loadPage(retryCursor)}
						/>
					)}
				</Show>
				<Show
					when={articles().length > 0}
					fallback={
						<Show when={!loading() && failure() === null}>
							<Empty>{m().noArticles}</Empty>
						</Show>
					}
				>
					<ArticleList articles={articles()} label={m().articles} />
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
		</div>
	);
}
