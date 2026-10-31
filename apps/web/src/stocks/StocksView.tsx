import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityCompanyView,
	formatStockId,
	type StockTab,
	type WatchlistStock,
} from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ConfirmDialog, ErrorNotice, Loading, Notice } from "../components/ui.tsx";
import { equitiesMessages } from "../equities/equities.messages.ts";
import { companyName } from "../equities/equitiesModel.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import type { StockRoute } from "../router.ts";
import { createClock } from "../tasks/clock.ts";
import { listTitlesByStock } from "../watchlist/listsModel.ts";
import { createStockDirectoryState } from "../watchlist/stockDirectory.ts";
import { createStockSearch } from "../watchlist/stockSearch.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import {
	isWatchlistRefreshActive,
	type StockSearchState,
	storedDirectoryMarkets,
	watchlistStatusText,
} from "../watchlist/watchlistModel.ts";
import { type AddStockRequest, AddStockSection } from "./AddStockSection.tsx";
import { createCompaniesState } from "./companiesState.ts";
import type { FinancialsActions } from "./FinancialsTab.tsx";
import { type Outcome, OutcomeNotice } from "./Outcome.tsx";
import { STOCK_DETAIL_HEADING_ID, StockDetail } from "./StockDetail.tsx";
import { StockListSection } from "./StockListSection.tsx";
import type { StockRowHandlers } from "./StockTable.tsx";
import { stocksMessages } from "./stocks.messages.ts";
import { mergeStockRows, type StockRow, selectedStockFor } from "./stocksModel.ts";
import { createWatchlistPageState } from "./watchlistState.ts";

/**
 * The Stocks page (ADR-0049): the Watchlist and Equities pages merged. One
 * list over the watchlist's stocks and the companies whose statements are
 * synced (`mergeStockRows`), with the Watchlist's list tabs, add form,
 * stock list downloads, earnings refresh and Google sync as they were and
 * the Equities page's sync status and actions on each row; below it, the
 * selected stock's tabs (`StockDetail`). Nothing is selected by default, so
 * opening the page reads only the list. The selection lives in the URL:
 * choosing a stock pushes a history entry, switching tabs replaces it.
 */
export function StocksView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** The selected stock and tab from the URL; null for the bare list. */
	readonly stock: StockRoute | null;
	/** Changes the selection: a new stock pushes history, a tab switch replaces it. */
	readonly onNavigate: (stock: StockRoute | null, options?: { readonly replace?: boolean }) => void;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const s = useMessages(stocksMessages);
	const e = useMessages(equitiesMessages);
	const listText = useMessages(watchlistListsMessages);
	const model = useMessages(watchlistModelMessages);
	const now = createClock();

	const watch = createWatchlistPageState({ api: props.api, visibility: props.visibility });
	const companies = createCompaniesState({ api: props.api, visibility: props.visibility });
	const [searchState, setSearchState] = createSignal<StockSearchState>({ kind: "idle" });
	const search = createStockSearch({
		search: (text, signal) => props.api.searchStockDirectory({ q: text }, signal),
		onState: setSearchState,
	});
	const directory = createStockDirectoryState({
		api: props.api,
		visibility: props.visibility,
		// A list that just arrived may answer the query the owner is looking at.
		onListsChanged: () => search.refresh(),
	});
	onCleanup(() => {
		search.dispose();
		directory.dispose();
	});
	onMount(() => {
		directory.start();
		watch.start();
		companies.start();
	});

	/** What the last companies action said (sync, track, stop tracking). */
	const [outcome, setOutcome] = createSignal<Outcome | null>(null);
	const [removing, setRemoving] = createSignal<WatchlistStock | null>(null);
	const [untracking, setUntracking] = createSignal<EquityCompanyView | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);

	const rows = createMemo(() =>
		mergeStockRows(watch.data()?.stocks ?? [], companies.companies() ?? []),
	);
	const rowsById = createMemo(() => new Map(rows().map((row) => [row.stockId, row] as const)));
	const listTitles = createMemo(() => listTitlesByStock(watch.data()?.lists ?? []));
	const trackedIds = createMemo(
		() => new Set((companies.companies() ?? []).map((c) => formatStockId(c.market, c.symbol))),
	);
	/** Both list reads answered (or failed): a selected stock is then known to be listed or not. */
	const listsSettled = () =>
		(watch.data() !== null || watch.failure() !== null) &&
		(companies.companies() !== null || companies.failure() !== null);

	/* ---------- Selection ---------- */

	const selectedId = createMemo(() => props.stock?.stockId ?? null);
	const selectedTab = (): StockTab => props.stock?.tab ?? "chart";
	const selected = createMemo(() => {
		const id = selectedId();
		if (id === null) return null;
		return selectedStockFor(id, rowsById().get(id), listTitles().get(id) ?? []);
	});
	/**
	 * A selected stock that leaves both lists (removed from the watchlist and
	 * not synced, here or in another tab) is deselected. One the URL named
	 * without either list holding it stays: its tabs say what is stored.
	 */
	let wasListed = false;
	createEffect(
		on(selectedId, () => {
			wasListed = false;
		}),
	);
	createEffect(() => {
		const id = selectedId();
		if (id === null || watch.data() === null || companies.companies() === null) return;
		if (rowsById().has(id)) wasListed = true;
		else if (wasListed) props.onNavigate(null, { replace: true });
	});

	/** Moves focus to the detail heading and scrolls it into view (after the detail rendered). */
	const focusDetail = (): void => {
		queueMicrotask(() => {
			const heading = document.getElementById(STOCK_DETAIL_HEADING_ID);
			if (!(heading instanceof HTMLElement)) return;
			if (typeof heading.scrollIntoView === "function") heading.scrollIntoView({ block: "start" });
			heading.focus({ preventScroll: true });
		});
	};
	const show = (row: StockRow): void => {
		// The stock already shown keeps its tab; another one opens at Chart.
		if (selectedId() !== row.stockId) props.onNavigate({ stockId: row.stockId, tab: "chart" });
		focusDetail();
	};
	const selectTab = (tab: StockTab): void => {
		const id = selectedId();
		if (id !== null) props.onNavigate({ stockId: id, tab }, { replace: true });
	};

	/* ---------- Companies actions ---------- */

	const syncOutcome = async (company: EquityCompanyView): Promise<Outcome> => {
		const answer = await companies.syncNow(company);
		return answer.ok
			? { kind: "notice", tone: "info", text: e().syncQueued(companyName(company)) }
			: { kind: "failure", title: e().syncFailed, error: answer.error };
	};
	const trackOutcome = async (stockId: string): Promise<Outcome> => {
		const answer = await companies.track(stockId);
		return answer.ok
			? { kind: "notice", tone: "success", text: s().tracked(companyName(answer.value)) }
			: { kind: "failure", title: s().trackFailed, error: answer.error };
	};
	const stockBusy = (stockId: string): boolean => {
		const company = rowsById().get(stockId)?.company ?? null;
		return (
			companies.tracking().has(stockId) ||
			(company !== null && companies.busy().has(company.companyId))
		);
	};
	const confirmUntrack = async (): Promise<void> => {
		const company = untracking();
		if (company === null || companies.busy().has(company.companyId)) return;
		const answer = await companies.untrack(company);
		setUntracking(null);
		opener()?.focus();
		setOutcome(
			answer.ok
				? { kind: "notice", tone: "success", text: s().untracked(companyName(company)) }
				: { kind: "failure", title: s().untrackFailed, error: answer.error },
		);
	};

	const financials: FinancialsActions = {
		atTrackLimit: companies.atLimit,
		busy: stockBusy,
		nowMs: now,
		syncNow: syncOutcome,
		track: trackOutcome,
		companyGone: () => companies.pollNow(),
	};
	const handlers = (): Omit<StockRowHandlers, "busy"> => ({
		selectedId: selectedId(),
		companyBusy: (row) => stockBusy(row.stockId),
		atTrackLimit: companies.atLimit(),
		nowMs: now(),
		onShow: show,
		onAddToWatchlist: (row) => void addToWatchlist(row),
		onSyncNow: (company) => void syncOutcome(company).then(setOutcome),
		onTrack: (row) => void trackOutcome(row.stockId).then(setOutcome),
		onUntrack: (company, from) => {
			setOpener(from);
			setUntracking(company);
		},
	});

	/* ---------- Watchlist actions ---------- */

	/**
	 * "Add stock": the watchlist first, then — when checked — the company's
	 * statements (two existing writes). A failure of the second is reported
	 * on its own and leaves the first.
	 */
	const addStock = async (request: AddStockRequest): Promise<boolean> => {
		const symbol = request.symbol.trim().toUpperCase();
		setOutcome(null);
		const added = await watch.addStock(request.market, request.symbol);
		if (!added) return false;
		// The form clears now; the dates and the statements follow.
		void (async () => {
			await watch.afterStockWatched(m().added(symbol));
			const stockId = formatStockId(request.market, symbol);
			if (!request.alsoSync || trackedIds().has(stockId)) return;
			const answer = await companies.track(stockId);
			setOutcome(
				answer.ok
					? { kind: "notice", tone: "success", text: s().tracked(companyName(answer.value)) }
					: { kind: "failure", title: s().addedNotTracked(symbol), error: answer.error },
			);
		})();
		return true;
	};
	/** A tracked-only stock's "Add to Watchlist": the watchlist write, then its earnings dates. */
	const addToWatchlist = async (row: StockRow): Promise<void> => {
		if (await watch.addStock(row.market, row.symbol)) {
			await watch.afterStockWatched(s().addedToWatchlist(row.symbol));
		}
	};
	const confirmRemove = async (): Promise<void> => {
		const target = removing();
		if (target === null) return;
		await watch.removeStock(target);
		setRemoving(null);
		opener()?.focus();
	};
	/** How many lists a stock leaves when it is removed from the watchlist. */
	const listsLeft = (stock: WatchlistStock): number => listTitles().get(stock.stockId)?.length ?? 0;

	return (
		<div class="space-y-3" data-page="stocks">
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
			<OutcomeNotice outcome={outcome()} field="stocks-outcome" />

			<AddStockSection
				directory={directory}
				search={search}
				searchState={searchState}
				busy={watch.busy()}
				atTrackLimit={companies.atLimit()}
				onAdd={addStock}
			/>

			<StockListSection
				api={props.api}
				data={watch.data}
				rows={rows}
				loading={watch.loading}
				companiesLine={() => {
					const list = companies.companies();
					return list === null
						? null
						: s().syncedCount(list.length, EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies);
				}}
				handlers={handlers}
				pageBusy={watch.busy}
				storedMarkets={() => storedDirectoryMarkets(directory.status())}
				statusText={() => {
					const current = watch.data();
					return current === null ? null : watchlistStatusText(current, model());
				}}
				refreshDisabled={() => watch.busy() || isWatchlistRefreshActive(watch.data())}
				onRefresh={() => void watch.queueRefresh("all")}
				onRemoveFromWatchlist={(stock, from) => {
					setOpener(from);
					setRemoving(stock);
				}}
				onWritten={watch.reloadAfterWrite}
				onStockWatched={watch.afterStockWatched}
			/>

			<Show
				when={selectedId()}
				fallback={
					<p class="text-sm text-slate-700" data-field="choose-stock">
						{s().chooseStock}
					</p>
				}
				keyed
			>
				{(_stockId) => (
					<Show when={listsSettled()} fallback={<Loading label={s().tabThing(selectedTab())} />}>
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
				)}
			</Show>

			<Show when={removing()}>
				{(stock) => (
					<ConfirmDialog
						title={m().removeTitle(stock().symbol)}
						opener={opener()}
						confirmLabel={m().removeStock}
						pending={watch.busy()}
						failure={null}
						onConfirm={() => void confirmRemove()}
						onCancel={() => {
							setRemoving(null);
							opener()?.focus();
						}}
					>
						{m().removeBody(stock().symbol)}
						<Show when={listsLeft(stock()) > 0}>
							{" "}
							<span data-field="remove-leaves-lists">
								{listText().alsoLeavesLists(listsLeft(stock()))}
							</span>
						</Show>
					</ConfirmDialog>
				)}
			</Show>
			<Show when={untracking()}>
				{(company) => (
					<ConfirmDialog
						title={s().untrackHeading(companyName(company()))}
						opener={opener()}
						confirmLabel={s().untrackConfirm}
						pending={companies.busy().has(company().companyId)}
						failure={null}
						onConfirm={() => void confirmUntrack()}
						onCancel={() => setUntracking(null)}
					>
						<p>
							{s().untrackBody}{" "}
							{rowsById().get(formatStockId(company().market, company().symbol))?.watchlist
								? s().untrackStaysOnWatchlist
								: s().untrackLeavesList}
						</p>
					</ConfirmDialog>
				)}
			</Show>
		</div>
	);
}
