import type { StockTab, ThemeSearchResponse } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
	type Accessor,
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
import {
	BUTTON_PRIMARY,
	ErrorNotice,
	IconButton,
	INPUT,
	LABEL,
	Loading,
	Section,
} from "../components/ui.tsx";
import { stockHash, type ThemeRoute, themeSearchHash } from "../router.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import { pageNumbers } from "./pageNumbers.ts";
import { STOCK_DETAIL_HEADING_ID } from "./stockTabs.ts";
import { themeSearchMessages } from "./themeSearch.messages.ts";

/** The theme box's DOM id on the Stocks page. */
export const THEME_SEARCH_ID = "stocks-theme-search";

/** The results caption's DOM id: a page change moves focus here. */
const RESULTS_CAPTION_ID = "stocks-theme-results-caption";

/** The panel beside the results that shows the chosen stock (ADR-0070). */
const THEME_PANEL_ID = "stocks-theme-panel";

/** The longest words the box takes (the API's `maxQueryChars`). */
const MAX_WORDS_CHARS = 100;

/** Renders one stock's detail at a tab (the Stocks page owns the Watchlist read). */
export type ThemeStockPanel = (
	stockId: string,
	tab: Accessor<StockTab>,
	onSelectTab: (tab: StockTab) => void,
) => JSX.Element;

/**
 * "Find stocks by theme" (ADR-0066, ADR-0070): a box whose submit opens
 * `#/stocks/themes/<words>`, and — while the URL carries words — one page
 * of 50 of the owner's stocks whose shown themes contain them. A stock's
 * name shows that stock in a panel beside the results (below them on a
 * narrow screen) instead of leaving the search. Nothing is read until
 * words are submitted or linked to.
 */
export function ThemeSearchArea(props: {
	readonly api: ApiClient;
	/** The words and page in the URL; null when no theme search is shown. */
	readonly theme: ThemeRoute | null;
	/** Opens a search or one of its pages (a new history entry). */
	readonly onSearch: (theme: ThemeRoute) => void;
	readonly stockPanel: ThemeStockPanel;
}): JSX.Element {
	const t = useMessages(themeSearchMessages);
	const words = createMemo(() => props.theme?.words ?? null);
	const [draft, setDraft] = createSignal(words() ?? "");
	// A theme link or Back changes the words: the box follows them.
	createEffect(on(words, (current) => setDraft(current ?? ""), { defer: true }));
	const submit = (event: SubmitEvent): void => {
		event.preventDefault();
		const next = draft().trim();
		if (next !== "") props.onSearch({ words: next, page: 1 });
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
			{/* Keyed by the words: a new search forgets the shown stock; a page change keeps it. */}
			<Show when={words()} keyed>
				{(current) => (
					<ThemeResults
						api={props.api}
						words={current}
						page={() => props.theme?.page ?? 1}
						onPage={(page) => props.onSearch({ words: current, page })}
						stockPanel={props.stockPanel}
					/>
				)}
			</Show>
		</Section>
	);
}

type ResultsState =
	| { readonly kind: "loading" }
	| { readonly kind: "ready"; readonly answer: ThemeSearchResponse }
	| { readonly kind: "failed"; readonly failure: ApiFailure };

type ThemeHit = ThemeSearchResponse["hits"][number];

/** True for a plain click: a modified or middle click keeps the link's own behaviour (a new tab). */
function isPlainClick(event: MouseEvent): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * One page of the stocks whose themes contain `words`, read once per page
 * (and on Retry), and the stock chosen from them in a panel beside them.
 */
function ThemeResults(props: {
	readonly api: ApiClient;
	readonly words: string;
	readonly page: Accessor<number>;
	readonly onPage: (page: number) => void;
	readonly stockPanel: ThemeStockPanel;
}): JSX.Element {
	const t = useMessages(themeSearchMessages);
	const locale = useLocale();
	const [state, setState] = createSignal<ResultsState>({ kind: "loading" });
	const [attempt, setAttempt] = createSignal(0);
	const [shown, setShown] = createSignal<string | null>(null);
	const [panelTab, setPanelTab] = createSignal<StockTab>("company");
	createEffect(
		on([props.page, attempt], ([page]) => {
			const controller = new AbortController();
			onCleanup(() => controller.abort());
			setState({ kind: "loading" });
			void props.api.searchThemes(props.words, page, controller.signal).then((result) => {
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
	const nameOf = (hit: ThemeHit): string =>
		(locale() === "ja" ? (hit.localName ?? hit.name) : (hit.name ?? hit.localName)) ?? hit.symbol;

	/** Moves to a page; focus goes to the results caption once the page is shown. */
	let focusCaption = false;
	const goToPage = (page: number): void => {
		focusCaption = true;
		props.onPage(page);
	};
	createEffect(() => {
		if (answer() === null || !focusCaption) return;
		focusCaption = false;
		queueMicrotask(() => {
			const caption = document.getElementById(RESULTS_CAPTION_ID);
			if (!(caption instanceof HTMLElement)) return;
			if (typeof caption.scrollIntoView === "function")
				caption.scrollIntoView({ block: "nearest" });
			caption.focus({ preventScroll: true });
		});
	});

	/** Shows a stock in the panel, on its Company tab, and moves focus to its heading. */
	const show = (hit: ThemeHit): void => {
		if (shown() !== hit.stockId) setPanelTab("company");
		setShown(hit.stockId);
		focusPanelHeading();
	};
	const focusPanelHeading = (): void => {
		// The heading appears once the Watchlist read settles; try for a short while.
		let tries = 0;
		const attemptFocus = (): void => {
			const heading = document.getElementById(STOCK_DETAIL_HEADING_ID);
			if (heading instanceof HTMLElement) {
				if (typeof heading.scrollIntoView === "function")
					heading.scrollIntoView({ block: "nearest" });
				heading.focus({ preventScroll: true });
				return;
			}
			tries += 1;
			if (tries < 20) setTimeout(attemptFocus, 50);
		};
		queueMicrotask(attemptFocus);
	};

	return (
		<div class="mt-3 space-y-2" data-field="theme-search-results">
			<div
				class={
					shown() === null
						? ""
						: "grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start"
				}
			>
				<div class="min-w-0 space-y-2">
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
									<Match when={answer().total === 0}>
										<p class="text-sm text-slate-700" data-field="theme-search-none">
											{t().none(props.words)}
										</p>
									</Match>
									<Match when={answer().total > 0}>
										<ResultsTable
											answer={answer()}
											words={props.words}
											shown={shown()}
											nameOf={nameOf}
											onShow={show}
										/>
										<Pagination answer={answer()} words={props.words} onPage={goToPage} />
									</Match>
								</Switch>
							)}
						</Match>
					</Switch>
				</div>
				<Show when={shown()} keyed>
					{(stockId) => (
						<aside
							id={THEME_PANEL_ID}
							class="min-w-0 space-y-2 lg:sticky lg:top-3 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-y-auto"
							aria-label={t().panelLabel}
							data-field="theme-stock-panel"
							data-stock-id={stockId}
						>
							<div class="flex items-center justify-between gap-2">
								<a href={stockHash(stockId, panelTab())} class={`${TASK_LINK} text-sm`}>
									{t().openStockPage}
								</a>
								<IconButton label={t().closePanel} icon="x-lg" onClick={() => setShown(null)} />
							</div>
							{props.stockPanel(stockId, panelTab, setPanelTab)}
						</aside>
					)}
				</Show>
			</div>
		</div>
	);
}

/** One page of matching stocks: a stock's name shows it in the panel. */
function ResultsTable(props: {
	readonly answer: ThemeSearchResponse;
	readonly words: string;
	readonly shown: string | null;
	readonly nameOf: (hit: ThemeHit) => string;
	readonly onShow: (hit: ThemeHit) => void;
}): JSX.Element {
	const t = useMessages(themeSearchMessages);
	const locale = useLocale();
	const first = (): number => (props.answer.page - 1) * props.answer.pageSize + 1;
	return (
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-left text-sm">
				<caption
					id={RESULTS_CAPTION_ID}
					tabIndex={-1}
					class="caption-top scroll-mt-4 pb-1 text-left text-xs text-slate-600 outline-none"
				>
					{t().resultsCaption(props.words)} ·{" "}
					{props.answer.pageCount > 1
						? t().resultRange(first(), first() + props.answer.hits.length - 1, props.answer.total)
						: t().resultCount(props.answer.total)}
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
					<For each={props.answer.hits}>
						{(hit) => {
							const current = () => props.shown === hit.stockId;
							return (
								<tr
									class={`border-b border-slate-200 align-top ${current() ? "bg-blue-50" : ""}`}
									data-stock-id={hit.stockId}
									aria-current={current() ? "true" : undefined}
								>
									<th scope="row" class="py-1 pr-3 font-medium">
										<a
											href={stockHash(hit.stockId, "company")}
											class={TASK_LINK}
											aria-controls={current() ? THEME_PANEL_ID : undefined}
											onClick={(event) => {
												if (!isPlainClick(event)) return;
												event.preventDefault();
												props.onShow(hit);
											}}
										>
											{props.nameOf(hit)}
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
							);
						}}
					</For>
				</tbody>
			</table>
		</div>
	);
}

/**
 * The page numbers ("1 2 3 4 … 10", `pageNumbers`) under the table, shown only when the results span more than one page. Each is a
 * link to its page's URL (so it opens in a new tab too); a plain click moves
 * in place. The current page is not a link.
 */
function Pagination(props: {
	readonly answer: ThemeSearchResponse;
	readonly words: string;
	readonly onPage: (page: number) => void;
}): JSX.Element {
	const t = useMessages(themeSearchMessages);
	const items = createMemo(() => pageNumbers(props.answer.page, props.answer.pageCount));
	const PageLink = (link: {
		readonly page: number;
		readonly label: string;
		readonly ariaLabel: string;
		readonly field: string;
	}): JSX.Element => (
		<a
			href={themeSearchHash(props.words, link.page)}
			class={PAGE_ITEM}
			aria-label={link.ariaLabel}
			data-field={link.field}
			onClick={(event) => {
				if (!isPlainClick(event)) return;
				event.preventDefault();
				props.onPage(link.page);
			}}
		>
			{link.label}
		</a>
	);
	return (
		<Show when={props.answer.pageCount > 1}>
			<nav aria-label={t().pagesLabel} data-field="theme-search-pages">
				<ul class="flex flex-wrap items-center gap-1">
					<For each={items()}>
						{(item) => (
							<li>
								<Show
									when={item !== "gap" ? item : null}
									fallback={
										<span class="px-1 text-sm text-slate-600" aria-hidden="true">
											…
										</span>
									}
								>
									{(page) => (
										<Show
											when={page() !== props.answer.page}
											fallback={
												<span
													class={`${PAGE_ITEM} bg-blue-700 font-semibold text-white`}
													aria-current="page"
													data-field="theme-page-current"
												>
													<span aria-hidden="true">{page()}</span>
													<span class="sr-only">{t().pageLabel(page())}</span>
												</span>
											}
										>
											<PageLink
												page={page()}
												label={String(page())}
												ariaLabel={t().pageLabel(page())}
												field="theme-page-number"
											/>
										</Show>
									)}
								</Show>
							</li>
						)}
					</For>
				</ul>
			</nav>
		</Show>
	);
}

/** A pager item: at least 32 px square, the page number centred. */
const PAGE_ITEM =
	"inline-flex min-h-8 min-w-8 items-center justify-center rounded px-2 text-sm text-slate-800 hover:bg-slate-100 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

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
