import type { StockTab } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createEffect, createMemo, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ErrorNotice, Loading, Notice } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { REGISTERED_STOCKS_HASH, type StockRoute } from "../router.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import type { FinancialsActions } from "./FinancialsTab.tsx";
import { STOCK_DETAIL_HEADING_ID, StockDetail } from "./StockDetail.tsx";
import { StockSearchArea } from "./StockSearchArea.tsx";
import { StockWatchlistControl } from "./StockWatchlistControl.tsx";
import { createStockRegistry } from "./stockRegistry.ts";
import { stocksMessages } from "./stocks.messages.ts";
import { selectedStockFor } from "./stocksModel.ts";

/**
 * The Stocks page (ADR-0049 §3, ADR-0050): "Find a stock" — the stock
 * search, whose pick opens a stock — above one stock's tabs (chart,
 * financial statements, company information and news) from the stored
 * data. The stock comes from the URL (`#/stocks/<stockId>[/<tab>]`): a
 * search pick, a Registered stocks row or a widget's link pushes it. With
 * no stock in the URL the page says where to choose one and reads nothing
 * until the owner searches. Switching tabs replaces the history entry.
 *
 * The registered stocks (watchlist and synced companies) are read, once a
 * stock is shown, to name it, to show its statements' sync and to offer
 * "Add to Watchlist" / "Remove from Watchlist" (ADR-0050 §2, ADR-0054). The
 * page never queues a sync: the server syncs the statements of every
 * Watchlist stock. A stock that is not registered — or stops being
 * registered while shown — stays: its tabs say what is stored.
 */
export function StocksView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** The stock and tab from the URL; null for `#/stocks` alone. */
	readonly stock: StockRoute | null;
	/** Changes the tab (replacing the history entry). */
	readonly onNavigate: (stock: StockRoute | null, options?: { readonly replace?: boolean }) => void;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const registry = createStockRegistry({ api: props.api, visibility: props.visibility });
	const { watch, companies } = registry;

	const selectedId = createMemo(() => props.stock?.stockId ?? null);
	const selectedTab = (): StockTab => props.stock?.tab ?? "chart";
	let started = false;
	createEffect(() => {
		if (selectedId() === null || started) return;
		started = true;
		registry.start();
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
	// A notice about one stock's add ("Added 7203 to the Watchlist…") does not follow to the next stock.
	let noticeFor: string | null = null;
	createEffect(() => {
		const id = selectedId();
		if (noticeFor !== null && id !== noticeFor) watch.clearNotice();
		noticeFor = id;
	});
	const selectTab = (tab: StockTab): void => {
		const id = selectedId();
		if (id !== null) props.onNavigate({ stockId: id, tab }, { replace: true });
	};
	const financials: FinancialsActions = {
		companyGone: () => companies.pollNow(),
		companiesKnown: () => companies.companies() !== null,
	};

	return (
		<div class="space-y-3" data-page="stocks">
			<StockSearchArea
				api={props.api}
				onOpen={(hit) => props.onNavigate({ stockId: hit.stockId, tab: "chart" })}
			/>
			<Show
				when={selectedId()}
				fallback={
					<p class="text-sm text-slate-700" data-field="choose-stock">
						{s().chooseStock}{" "}
						<a href={REGISTERED_STOCKS_HASH} class={TASK_LINK}>
							{s().openRegistered}
						</a>
					</p>
				}
				keyed
			>
				{(_stockId) => (
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
						<Show when={companies.failure()}>
							{(error) => (
								<ErrorNotice
									failure={error()}
									title={s().companiesFailed}
									onRetry={() => companies.pollNow()}
								/>
							)}
						</Show>
						<p class="text-sm">
							<a href={REGISTERED_STOCKS_HASH} class={TASK_LINK} data-field="choose-other-stock">
								{s().chooseOtherStock}
							</a>
						</p>
						<Show
							when={registry.settled()}
							fallback={<Loading label={s().tabThing(selectedTab())} />}
						>
							<Show when={selected()}>
								{(stock) => (
									<StockDetail
										api={props.api}
										visibility={props.visibility}
										stock={stock}
										tab={selectedTab}
										onSelectTab={selectTab}
										financials={financials}
										aside={<StockWatchlistControl api={props.api} stock={stock} watch={watch} />}
									/>
								)}
							</Show>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}
