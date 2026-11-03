import type { ThemeSearchResponse } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON_PRIMARY, ErrorNotice, INPUT, LABEL, Loading, Section } from "../components/ui.tsx";
import { STOCKS_HASH, stockHash, themeSearchHash } from "../router.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import { themeSearchMessages } from "./themeSearch.messages.ts";

/** The theme box's DOM id on the Stocks page. */
export const THEME_SEARCH_ID = "stocks-theme-search";

/** The longest words the box takes (the API's `maxQueryChars`). */
const MAX_WORDS_CHARS = 100;

/**
 * "Find stocks by theme" (ADR-0066): a box whose submit opens
 * `#/stocks/themes/<words>`, and — while the URL carries words — the
 * owner's stocks whose shown themes contain them, each linking to its
 * Company tab. Nothing is read until words are submitted or linked to.
 */
export function ThemeSearchArea(props: {
	readonly api: ApiClient;
	/** The words in the URL; null when no theme search is shown. */
	readonly words: string | null;
	readonly onSearch: (words: string) => void;
}): JSX.Element {
	const t = useMessages(themeSearchMessages);
	const [draft, setDraft] = createSignal(props.words ?? "");
	// A theme link or Back changes the words: the box follows them.
	createEffect(
		on(
			() => props.words,
			(words) => setDraft(words ?? ""),
			{ defer: true },
		),
	);
	const submit = (event: SubmitEvent): void => {
		event.preventDefault();
		const words = draft().trim();
		if (words !== "") props.onSearch(words);
	};
	return (
		<Section title={t().title}>
			<p class="text-xs text-slate-700">{t().hint}</p>
			<form class="mt-2 flex max-w-xl items-end gap-2" onSubmit={submit} data-field="theme-search">
				<div class="grow">
					<label for={THEME_SEARCH_ID} class={LABEL}>
						{t().inputLabel}
					</label>
					<input
						id={THEME_SEARCH_ID}
						type="search"
						class={INPUT}
						maxLength={MAX_WORDS_CHARS}
						autocomplete="off"
						value={draft()}
						onInput={(event) => setDraft(event.currentTarget.value)}
					/>
				</div>
				<button type="submit" class={BUTTON_PRIMARY} disabled={draft().trim() === ""}>
					{t().submit}
				</button>
			</form>
			<Show when={props.words} keyed>
				{(words) => <ThemeResults api={props.api} words={words} />}
			</Show>
		</Section>
	);
}

type ResultsState =
	| { readonly kind: "loading" }
	| { readonly kind: "ready"; readonly answer: ThemeSearchResponse }
	| { readonly kind: "failed"; readonly failure: ApiFailure };

/** The stocks whose themes contain `words`, read once per words (and on Retry). */
function ThemeResults(props: { readonly api: ApiClient; readonly words: string }): JSX.Element {
	const t = useMessages(themeSearchMessages);
	const locale = useLocale();
	const [state, setState] = createSignal<ResultsState>({ kind: "loading" });
	const [attempt, setAttempt] = createSignal(0);
	createEffect(
		on([() => props.words, attempt], ([words]) => {
			const controller = new AbortController();
			onCleanup(() => controller.abort());
			setState({ kind: "loading" });
			void props.api.searchThemes(words, controller.signal).then((result) => {
				if (controller.signal.aborted) return;
				setState(
					result.ok
						? { kind: "ready", answer: result.value }
						: { kind: "failed", failure: result.error },
				);
			});
		}),
	);
	const failure = createMemo(() => {
		const current = state();
		return current.kind === "failed" ? current.failure : null;
	});
	const answer = createMemo(() => {
		const current = state();
		return current.kind === "ready" ? current.answer : null;
	});
	const nameOf = (hit: ThemeSearchResponse["hits"][number]): string =>
		(locale() === "ja" ? (hit.localName ?? hit.name) : (hit.name ?? hit.localName)) ?? hit.symbol;
	return (
		<div class="mt-3 space-y-2" data-field="theme-search-results">
			<Switch>
				<Match when={state().kind === "loading"}>
					<Loading label={t().searching} />
				</Match>
				<Match when={failure()}>
					{(failed) => (
						<ErrorNotice
							failure={failed()}
							title={t().failed}
							onRetry={() => setAttempt((count) => count + 1)}
						/>
					)}
				</Match>
				<Match when={answer()}>
					{(answer) => (
						<Switch>
							<Match when={answer().query === null}>
								<p class="text-sm text-slate-700">{t().nothingToMatch}</p>
							</Match>
							<Match when={answer().hits.length === 0}>
								<p class="text-sm text-slate-700" data-field="theme-search-none">
									{t().none(props.words)}
								</p>
							</Match>
							<Match when={answer().hits.length > 0}>
								<div class="overflow-x-auto">
									<table class="w-full border-collapse text-left text-sm">
										<caption class="caption-top pb-1 text-left text-xs text-slate-600">
											{t().resultsCaption(props.words)} · {t().resultCount(answer().hits.length)}
										</caption>
										<thead>
											<tr class="border-b border-slate-200 text-xs text-slate-700">
												<th scope="col" class="py-1 pr-3 font-semibold">
													{t().stockColumn}
												</th>
												<th scope="col" class="py-1 pr-3 font-semibold">
													{t().symbolColumn}
												</th>
												<th scope="col" class="py-1 font-semibold">
													{t().themesColumn}
												</th>
											</tr>
										</thead>
										<tbody>
											<For each={answer().hits}>
												{(hit) => (
													<tr class="border-b border-slate-200 align-top">
														<th scope="row" class="py-1 pr-3 font-medium">
															<a href={stockHash(hit.stockId, "company")} class={TASK_LINK}>
																{nameOf(hit)}
															</a>
														</th>
														<td class="py-1 pr-3 font-mono text-xs">{hit.symbol}</td>
														<td class="py-1">
															<ul class="flex flex-wrap gap-1.5" lang={locale()}>
																<For each={hit.themes}>
																	{(theme) => (
																		<li class="rounded-full border border-slate-300 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-800">
																			{theme[locale()]}
																		</li>
																	)}
																</For>
															</ul>
														</td>
													</tr>
												)}
											</For>
										</tbody>
									</table>
								</div>
								<Show when={answer().truncated}>
									<p class="text-xs text-slate-700">{t().truncated(answer().hits.length)}</p>
								</Show>
							</Match>
						</Switch>
					)}
				</Match>
			</Switch>
			<p class="text-sm">
				<a href={STOCKS_HASH} class={TASK_LINK} data-field="theme-search-close">
					{t().closeResults}
				</a>
			</p>
		</div>
	);
}

/**
 * A theme as the Company tab shows it, linking to the stocks that share it
 * (ADR-0066). Its name is the visible theme, prefixed by what the link does.
 */
export function ThemeLink(props: { readonly name: string }): JSX.Element {
	const t = useMessages(themeSearchMessages);
	return (
		<a
			href={themeSearchHash(props.name)}
			class="hover:underline focus-visible:underline"
			aria-label={t().themeLink(props.name)}
		>
			{props.name}
		</a>
	);
}
