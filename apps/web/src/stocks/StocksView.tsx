import type { StockTab } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createEffect, createMemo, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ErrorNotice, Loading } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { REGISTERED_STOCKS_HASH, type StockRoute } from "../router.ts";
import { createClock } from "../tasks/clock.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import type { FinancialsActions } from "./FinancialsTab.tsx";
import { STOCK_DETAIL_HEADING_ID, StockDetail } from "./StockDetail.tsx";
import { createStockRegistry } from "./stockRegistry.ts";
import { stocksMessages } from "./stocks.messages.ts";
import { selectedStockFor } from "./stocksModel.ts";

/**
 * The Stocks page (ADR-0049 §3): one stock's tabs — chart, financial
 * statements, company information and news — from the stored data. The
 * stock comes from the URL (`#/stocks/<stockId>[/<tab>]`); it is chosen on
 * the Registered stocks page or from a widget's link, and this page has no
 * picker. With no stock in the URL the page says where to choose one and
 * reads nothing. Switching tabs replaces the history entry.
 *
 * The registered stocks (watchlist and synced companies) are read, once a
 * stock is shown, only to name it and to offer its Financial statements
 * actions (sync now, start syncing). A stock that is not registered — or
 * stops being registered while shown — stays: its tabs say what is stored.
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
	const now = createClock();
	const registry = createStockRegistry({
		api: props.api,
		visibility: props.visibility,
		automaticRuns: false,
	});
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
	const selectTab = (tab: StockTab): void => {
		const id = selectedId();
		if (id !== null) props.onNavigate({ stockId: id, tab }, { replace: true });
	};
	const financials: FinancialsActions = {
		atTrackLimit: companies.atLimit,
		busy: registry.stockBusy,
		nowMs: now,
		syncNow: registry.syncOutcome,
		track: registry.trackOutcome,
		companyGone: () => companies.pollNow(),
		companiesKnown: () => companies.companies() !== null,
		watchlistKnown: () => watch.data() !== null,
	};

	return (
		<div class="space-y-3" data-page="stocks">
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
