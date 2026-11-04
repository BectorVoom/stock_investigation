import type { StockTab } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { type Accessor, createEffect, createMemo, type JSX, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ErrorNotice, Loading, Notice } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { REGISTERED_STOCKS_HASH, type StockRoute, type ThemeRoute } from "../router.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import { STOCK_DETAIL_HEADING_ID, StockDetail } from "./StockDetail.tsx";
import { StockSearchArea } from "./StockSearchArea.tsx";
import { StockWatchlistControl } from "./StockWatchlistControl.tsx";
import { createStockRegistry, type StockRegistry } from "./stockRegistry.ts";
import { stocksMessages } from "./stocks.messages.ts";
import { selectedStockFor } from "./stocksModel.ts";
import { ThemeSearchArea } from "./ThemeSearch.tsx";

/**
 * The Stocks page (ADR-0049 §3, ADR-0050): "Find a stock" — the stock
 * search, whose pick opens a stock — and "Find stocks by theme" (ADR-0066,
 * `#/stocks/themes/<words>[/<page>]` lists, 50 a page, the stocks whose
 * themes contain the words, and shows a clicked one beside them, ADR-0070)
 * above one stock's tabs (chart,
 * financial statements, company information and news) from the stored
 * data. The stock comes from the URL (`#/stocks/<stockId>[/<tab>]`): a
 * search pick, a Registered stocks row or a widget's link pushes it. With
 * no stock in the URL the page says where to choose one and reads nothing
 * until the owner searches. Switching tabs replaces the history entry.
 *
 * The Watchlist is read, once a stock is shown, to name it and to offer
 * "Add to Watchlist" / "Remove from Watchlist" (ADR-0050 §2). The page
 * never queues a sync: the server syncs the prices, statements and
 * business description of every stock in the stored stock lists, on the
 * Watchlist or not (ADR-0058). A stock that is not on the Watchlist — or
 * leaves it while shown — stays: its tabs say what is stored.
 */
export function StocksView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** The stock and tab from the URL; null for `#/stocks` alone. */
	readonly stock: StockRoute | null;
	/** The theme search's words and page from the URL (ADR-0066, ADR-0070). */
	readonly theme: ThemeRoute | null;
	/** Opens a theme search or one of its pages (a new history entry, so Back returns). */
	readonly onThemeSearch: (theme: ThemeRoute) => void;
	/** Changes the tab (replacing the history entry). */
	readonly onNavigate: (stock: StockRoute | null, options?: { readonly replace?: boolean }) => void;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const registry = createStockRegistry({ api: props.api, visibility: props.visibility });

	const selectedId = createMemo(() => props.stock?.stockId ?? null);
	const selectedTab = (): StockTab => props.stock?.tab ?? "chart";
	// The Watchlist is read once a stock is shown: in the page or beside the theme results.
	let started = false;
	const startRegistry = (): void => {
		if (started) return;
		started = true;
		registry.start();
	};
	createEffect(() => {
		if (selectedId() !== null) startRegistry();
	});

	const selected = createMemo(() => {
		const id = selectedId();
		if (id === null) return null;
		return selectedStockFor(id, registry.rowsById().get(id), registry.listTitles().get(id) ?? []);
	});
	/**
	 * A stock opened from a link (a Registered stocks row, a widget) gets
	 * focus on its heading, scrolled into view: the page that linked here
	 * may have been scrolled far down. Once per stock; a tab switch keeps
	 * focus on its tab.
	 */
	let focusedFor: string | null = null;
	createEffect(() => {
		const id = selectedId();
		if (id === null || focusedFor === id || !registry.settled() || selected() === null) return;
		focusedFor = id;
		queueMicrotask(() => {
			const heading = document.getElementById(STOCK_DETAIL_HEADING_ID);
			if (!(heading instanceof HTMLElement)) return;
			if (typeof heading.scrollIntoView === "function")
				heading.scrollIntoView({ block: "nearest" });
			heading.focus({ preventScroll: true });
		});
	});
	const selectTab = (tab: StockTab): void => {
		const id = selectedId();
		if (id !== null) props.onNavigate({ stockId: id, tab }, { replace: true });
	};

	return (
		<div class="space-y-3" data-page="stocks">
			<StockSearchArea
				api={props.api}
				onOpen={(hit) => props.onNavigate({ stockId: hit.stockId, tab: "chart" })}
			/>
			<ThemeSearchArea
				api={props.api}
				theme={props.theme}
				onSearch={props.onThemeSearch}
				stockPanel={(stockId, tab, onSelectTab) => {
					startRegistry();
					return (
						<WatchedStockDetail
							api={props.api}
							visibility={props.visibility}
							registry={registry}
							stockId={stockId}
							tab={tab}
							onSelectTab={onSelectTab}
						/>
					);
				}}
			/>
			<Show
				when={selectedId()}
				fallback={
					<Show when={props.theme === null}>
						<p class="text-sm text-slate-700" data-field="choose-stock">
							{s().chooseStock}{" "}
							<a href={REGISTERED_STOCKS_HASH} class={TASK_LINK}>
								{s().openRegistered}
							</a>
						</p>
					</Show>
				}
				keyed
			>
				{(stockId) => (
					<>
						<p class="text-sm">
							<a href={REGISTERED_STOCKS_HASH} class={TASK_LINK} data-field="choose-other-stock">
								{s().chooseOtherStock}
							</a>
						</p>
						<WatchedStockDetail
							api={props.api}
							visibility={props.visibility}
							registry={registry}
							stockId={stockId}
							tab={selectedTab}
							onSelectTab={selectTab}
						/>
					</>
				)}
			</Show>
		</div>
	);
}

/**
 * One stock's detail with its Watchlist status and add button (ADR-0050
 * §2), the Watchlist read's failure and the add's notice: the page's stock,
 * or the stock shown beside the theme results (ADR-0070). Keyed by stock by
 * its caller, so a notice about one stock's add ("Added 7203 to the
 * Watchlist…") does not follow to the next stock.
 */
function WatchedStockDetail(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	readonly registry: StockRegistry;
	readonly stockId: string;
	readonly tab: Accessor<StockTab>;
	readonly onSelectTab: (tab: StockTab) => void;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const { registry } = props;
	const { watch } = registry;
	onMount(() => watch.clearNotice());
	const selected = createMemo(() =>
		selectedStockFor(
			props.stockId,
			registry.rowsById().get(props.stockId),
			registry.listTitles().get(props.stockId) ?? [],
		),
	);
	return (
		<>
			<Show when={watch.failure()}>
				{(current) => (
					<ErrorNotice
						failure={current().error}
						title={current().title}
						onRetry={current().retry}
					/>
				)}
			</Show>
			<Show when={watch.notice()}>
				{(current) => <Notice tone="info">{current().text}</Notice>}
			</Show>
			<Show when={registry.settled()} fallback={<Loading label={s().tabThing(props.tab())} />}>
				<Show when={selected()}>
					{(stock) => (
						<StockDetail
							api={props.api}
							visibility={props.visibility}
							stock={stock}
							tab={props.tab}
							onSelectTab={props.onSelectTab}
							aside={<StockWatchlistControl api={props.api} stock={stock} watch={watch} />}
						/>
					)}
				</Show>
			</Show>
		</>
	);
}
