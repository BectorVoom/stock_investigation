import type { Article } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { DateText, SafeLink } from "@research/ui-registry";
import { For, type JSX, Show } from "solid-js";
import { sourcesMessages } from "../sources/sources.messages.tsx";

export function ArticleList(props: {
	readonly articles: readonly Article[];
	readonly label: string;
}): JSX.Element {
	const m = useMessages(sourcesMessages);
	return (
		<ul aria-label={props.label} class="mt-1 space-y-1.5 text-sm">
			<For each={props.articles}>
				{(article) => (
					<li data-article-id={article.articleId}>
						<SafeLink url={article.canonicalUrl}>{article.title}</SafeLink>
						<span class="block text-xs text-slate-700">
							{article.publisher}; {m().published}{" "}
							<DateText iso={article.publishedAt} missing={m().dateNotStated} />; {m().retrieved}{" "}
							<DateText iso={article.retrievedAt} missing={m().dateNotStated} />
						</span>
						<Show when={article.excerpt}>
							{(excerpt) => <span class="block text-xs text-slate-800">{excerpt()}</span>}
						</Show>
					</li>
				)}
			</For>
		</ul>
	);
}
