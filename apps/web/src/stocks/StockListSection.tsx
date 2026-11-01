import {
	formatStockId,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistList,
	type WatchlistResponse,
	type WatchlistStock,
	type WatchMarket,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { type Accessor, createMemo, createSignal, type JSX, Show } from "solid-js";
import type { ApiClient, WatchlistData } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { focusTab, type TabItem, Tabs, tabElementId } from "../components/Tabs.tsx";
import {
	ActionMenu,
	BUTTON,
	ConfirmDialog,
	Empty,
	ErrorNotice,
	Loading,
	Section,
} from "../components/ui.tsx";
import {
	homeFullText,
	joinNames,
	listFailureReason,
	listFull,
	listsFull,
	stockNotAddedTitle,
	stocksOutsideList,
} from "../watchlist/listsModel.ts";
import {
	AddListStocksDialog,
	type DialogFailure,
	dialogFailure,
	type ListStockChoice,
	ListTitleDialog,
} from "../watchlist/WatchlistListDialogs.tsx";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { stocksById } from "../widgets/pageSeries.ts";
import { showWidgetOnHome } from "../widgets/showOnHome.ts";
import { watchlistPricesWidget } from "../widgets/widgetModel.ts";
import { StockTable } from "./StockTable.tsx";

type TitleDialogState =
	| { readonly mode: "create" }
	| { readonly mode: "rename"; readonly listId: string; readonly title: string };

const PANEL_ID = "watchlist-tab-panel";
/** The list tabs keep the Watchlist's ids (`watchlist-tab-<key>`). */
const TAB_PREFIX = "watchlist-tab";

/**
 * The Registered stocks page's lists (ADR-0040 §7, ADR-0049 §2, ADR-0054):
 * one tab per list in creation order over the list's stocks in list order
 * — symbol and name, "In lists: …", market and Remove from list per row —
 * with the list's actions: Add stock, Show on Home and a menu (Rename…,
 * Delete…). New list sits in the header. There is no tab of every stock:
 * a stock goes on and leaves the Watchlist from the Stocks page; with no
 * list yet the panel says how to make one.
 *
 * Every list write answers the whole watchlist; the page then re-reads it
 * (`onWritten`), also after a refusal so counts and enabled controls are
 * current, and a stock a list add put on the watchlist is announced
 * (`onStockWatched`; the server fetches its earnings dates and statements).
 * The selected tab survives re-reads; the first list is selected at first
 * and when the selected list is deleted (here or elsewhere).
 */
export function StockListSection(props: {
	readonly api: ApiClient;
	readonly data: Accessor<WatchlistResponse | null>;
	readonly loading: Accessor<boolean>;
	readonly storedMarkets: Accessor<readonly WatchMarket[] | null>;
	/** Re-reads the watchlist after a list write. */
	readonly onWritten: () => Promise<void>;
	/** After a list add put a new stock on the watchlist: re-read and say `notice` (its dates are on their way). */
	readonly onStockWatched: (notice: string) => Promise<void>;
}): JSX.Element {
	const page = useMessages(watchlistMessages);
	const m = useMessages(watchlistListsMessages);
	const locale = useLocale();
	let newListButton: HTMLButtonElement | undefined;
	/** The list id the owner selected; null until they do (the first list is shown). */
	const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
	const [pending, setPending] = createSignal(false);
	const [notice, setNotice] = createSignal<string | null>(null);
	const [failure, setFailure] = createSignal<DialogFailure | null>(null);
	const [titleDialog, setTitleDialog] = createSignal<TitleDialogState | null>(null);
	const [addListId, setAddListId] = createSignal<string | null>(null);
	const [dialogError, setDialogError] = createSignal<DialogFailure | null>(null);
	const [deleting, setDeleting] = createSignal<WatchlistList | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	const busy = () => pending();
	const lists = () => props.data()?.lists ?? [];
	const stocks = createMemo(() => {
		const current = props.data();
		return current === null ? new Map<string, WatchlistStock>() : stocksById(current);
	});
	/** One list's stocks, in list order (every member is a watchlist stock). */
	const listStocks = (list: WatchlistList): readonly WatchlistStock[] =>
		list.stockIds.flatMap((stockId) => {
			const stock = stocks().get(stockId);
			return stock === undefined ? [] : [stock];
		});
	const atListLimit = () => {
		const current = props.data();
		return current !== null && listsFull(current);
	};
	/**
	 * The shown list: the selected one, else the first — also when the
	 * selected list was deleted (here, by a poll or in another tab). Null
	 * only while there is no list.
	 */
	const selectedList = createMemo(
		() => lists().find((list) => list.listId === selectedKey()) ?? lists()[0] ?? null,
	);
	const shownKey = () => selectedList()?.listId ?? null;
	const tabs = createMemo((): TabItem<string>[] =>
		lists().map((list) => ({
			key: list.listId,
			label: m().listTab(list.title, list.stockIds.length),
		})),
	);
	const addList = () => lists().find((list) => list.listId === addListId()) ?? null;

	/**
	 * Runs one list write: clears the last outcome, reports a refusal and
	 * then re-reads the watchlist, so the counts and the enabled controls
	 * show the lists as they are now (another tab may have changed them).
	 * Resolves to the answer, or null when the write was refused.
	 */
	const run = async (
		write: () => Promise<ApiResult<WatchlistData>>,
		onRefused: (error: ApiFailure) => void,
	): Promise<WatchlistData | null> => {
		if (busy()) return null;
		setPending(true);
		setNotice(null);
		setFailure(null);
		const result = await write();
		setPending(false);
		if (!result.ok) {
			onRefused(result.error);
			await props.onWritten();
			return null;
		}
		return result.value;
	};
	const refuseInPage = (title: string) => (error: ApiFailure) =>
		setFailure({ title: listFailureReason(error, m()) ?? title, error });
	const refuseInDialog = (title: string) => (error: ApiFailure) =>
		setDialogError(dialogFailure(error, title, m()));
	const names = (items: readonly string[]): string => joinNames(items, locale());

	const openTitleDialog = (state: TitleDialogState, from: HTMLElement | null): void => {
		setOpener(from);
		setDialogError(null);
		setTitleDialog(state);
	};
	const closeTitleDialog = (): void => {
		setTitleDialog(null);
		opener()?.focus();
	};
	const submitTitle = async (title: string): Promise<void> => {
		const state = titleDialog();
		if (state === null) return;
		// The same title again changes nothing: no request.
		if (state.mode === "rename" && title === state.title) {
			closeTitleDialog();
			return;
		}
		if (state.mode === "rename") {
			const renamed = await run(
				() => props.api.renameWatchlistList(state.listId, title),
				refuseInDialog(m().notRenamed),
			);
			if (renamed === null) return;
			// The tab stays selected: its id did not change.
			closeTitleDialog();
			setNotice(m().renamed(title));
			await props.onWritten();
			return;
		}
		const before = new Set(lists().map((list) => list.listId));
		const created = await run(
			() => props.api.createWatchlistList(title),
			refuseInDialog(m().notCreated),
		);
		if (created === null) return;
		setTitleDialog(null);
		setNotice(m().created(title));
		await props.onWritten();
		// The new list's tab is selected and focused.
		const fresh = created.lists.find((list) => !before.has(list.listId));
		if (fresh === undefined) {
			opener()?.focus();
			return;
		}
		setSelectedKey(fresh.listId);
		focusTab(TAB_PREFIX, fresh.listId);
	};

	const confirmDelete = async (): Promise<void> => {
		const list = deleting();
		if (list === null) return;
		const done = await run(
			() => props.api.deleteWatchlistList(list.listId),
			refuseInPage(m().notDeleted),
		);
		setDeleting(null);
		opener()?.focus();
		if (done === null) return;
		setNotice(m().deleted(list.title));
		await props.onWritten();
		// The list's tab is gone: the first list is shown and its tab
		// focused, else (no list left) the New list button.
		setSelectedKey(null);
		const first = shownKey();
		if (first !== null) focusTab(TAB_PREFIX, first);
		else newListButton?.focus();
	};

	/**
	 * After Remove from list the row is gone: focus moves to the next row's
	 * Remove from list, else to the tab's Add stock (found after the re-read,
	 * which renders the rows again).
	 */
	const focusAfterRemove = (stockId: string | null): void => {
		const panel = document.getElementById(PANEL_ID);
		if (panel === null) return;
		const remove =
			stockId === null
				? null
				: panel.querySelector(`button[data-remove-stock="${CSS.escape(stockId)}"]`);
		const target = remove ?? panel.querySelector("button[data-list-add]");
		const key = shownKey();
		if (target instanceof HTMLElement) target.focus();
		else if (key !== null) focusTab(TAB_PREFIX, key);
	};
	const removeStock = async (list: WatchlistList, stock: WatchlistStock): Promise<void> => {
		const next = list.stockIds[list.stockIds.indexOf(stock.stockId) + 1] ?? null;
		const done = await run(
			() => props.api.removeWatchlistListStock(list.listId, stock.stockId),
			refuseInPage(m().notRemoved),
		);
		if (done !== null) {
			setNotice(m().removedFromList(stock.symbol, list.title));
			await props.onWritten();
		}
		focusAfterRemove(done !== null ? next : stock.stockId);
	};

	/**
	 * Adds the chosen stocks one request each, in the order shown (the API
	 * takes one stock per request), stopping at the first refusal. A refusal
	 * names the stock that failed and announces the ones already added; the
	 * dialog stays open on the lists as they are now. A searched stock is
	 * never on the watchlist yet (the search does not let one be picked), so
	 * once it is — added to the list, or put on the watchlist before its list
	 * insert lost a race — it is announced as after a plain add.
	 */
	const addStocks = async (list: WatchlistList, choice: ListStockChoice): Promise<void> => {
		const wanted = [
			...choice.watched.map((stock) => ({ market: stock.market, symbol: stock.symbol })),
			...(choice.found === null
				? []
				: [{ market: choice.found.market, symbol: choice.found.symbol }]),
		];
		const found = choice.found;
		const added: string[] = [];
		for (const stock of wanted) {
			const done = await run(
				() => props.api.addWatchlistListStock(list.listId, stock),
				(error) => setDialogError({ title: stockNotAddedTitle(stock.symbol, error, m()), error }),
			);
			if (done === null) {
				if (added.length > 0) setNotice(m().addedToList(names(added), list.title));
				// `run` re-read the watchlist: the searched stock may be on it now.
				if (
					found !== null &&
					stock.symbol === found.symbol &&
					stocks().has(formatStockId(found.market, found.symbol))
				) {
					await props.onStockWatched(m().addedToWatchlistOnly(found.symbol, list.title));
				}
				return;
			}
			added.push(stock.symbol);
		}
		setAddListId(null);
		opener()?.focus();
		if (found !== null) {
			const others = added.filter((symbol) => symbol !== found.symbol);
			if (others.length > 0) setNotice(m().addedToList(names(others), list.title));
			await props.onStockWatched(m().addedToListAndWatchlist(found.symbol, list.title));
			return;
		}
		setNotice(m().addedToList(names(added), list.title));
		await props.onWritten();
	};

	const showOnHome = async (list: WatchlistList): Promise<void> => {
		if (busy()) return;
		setPending(true);
		setNotice(null);
		setFailure(null);
		const shown = await showWidgetOnHome(
			props.api,
			(widget) => widget.type === "watchlist-prices" && widget.listId === list.listId,
			() => watchlistPricesWidget(list.listId, list.title),
		);
		setPending(false);
		switch (shown.kind) {
			case "added":
				setNotice(m().shownOnHome(list.title));
				return;
			case "already":
				setNotice(m().alreadyOnHome(list.title));
				return;
			case "full":
				setNotice(homeFullText(shown.problem, m()));
				return;
			case "failed":
				setFailure({ title: m().notShownOnHome, error: shown.failure });
				return;
		}
	};

	return (
		<Section
			title={page().stocksAndLists}
			actions={
				<div class="flex flex-wrap items-center gap-2">
					<button
						ref={(element) => {
							newListButton = element;
						}}
						type="button"
						class={BUTTON}
						disabled={busy() || props.data() === null || atListLimit()}
						aria-describedby={atListLimit() ? "watchlist-lists-limit" : undefined}
						onClick={(event) => openTitleDialog({ mode: "create" }, event.currentTarget)}
					>
						{m().newList}
					</button>
				</div>
			}
		>
			<Show when={atListLimit()}>
				<p id="watchlist-lists-limit" class="mt-1 text-xs text-amber-900">
					{m().listsFull(WATCHLIST_LISTS_LIMITS.maxLists)}
				</p>
			</Show>
			<Show when={failure()}>
				{(current) => (
					<div class="mt-2">
						<ErrorNotice failure={current().error} title={current().title} />
					</div>
				)}
			</Show>
			<output data-field="lists-status" class="mt-1 block text-sm text-slate-800 empty:hidden">
				{notice() ?? ""}
			</output>
			<Show when={props.loading()}>
				<Loading label={page().watchlistThing} />
			</Show>
			<Show when={!props.loading() && props.data() !== null}>
				<Show
					when={selectedList()}
					fallback={
						<div class="mt-2" data-field="no-lists">
							<Empty>{m().noListsYet}</Empty>
						</div>
					}
				>
					{(list) => (
						<>
							<div class="mt-2">
								<Tabs
									label={m().tabsLabel}
									idPrefix={TAB_PREFIX}
									tabs={tabs()}
									selected={list().listId}
									panelId={PANEL_ID}
									onSelect={(key) => setSelectedKey(key)}
								/>
							</div>
							<div
								id={PANEL_ID}
								role="tabpanel"
								aria-labelledby={tabElementId(TAB_PREFIX, list().listId)}
								class="pt-2"
								data-tab-panel={list().listId}
							>
								<ListPanel
									list={list()}
									members={listStocks(list())}
									busy={busy()}
									onAdd={(from) => {
										setOpener(from);
										setDialogError(null);
										setAddListId(list().listId);
									}}
									onShowOnHome={() => void showOnHome(list())}
									onRename={(from) =>
										openTitleDialog(
											{ mode: "rename", listId: list().listId, title: list().title },
											from,
										)
									}
									onDelete={(from) => {
										setOpener(from);
										setDeleting(list());
									}}
									onRemove={(stock) => void removeStock(list(), stock)}
								/>
							</div>
						</>
					)}
				</Show>
			</Show>

			<Show when={titleDialog()}>
				{(state) => (
					<ListTitleDialog
						heading={(() => {
							const current = state();
							return current.mode === "create"
								? m().newListHeading
								: m().renameHeading(current.title);
						})()}
						submitLabel={state().mode === "create" ? m().createList : m().save}
						initialTitle={(() => {
							const current = state();
							return current.mode === "create" ? "" : current.title;
						})()}
						opener={opener() ?? newListButton ?? null}
						pending={pending()}
						failure={dialogError()}
						onSubmit={(title) => void submitTitle(title)}
						onClose={() => setTitleDialog(null)}
					/>
				)}
			</Show>
			<Show when={addList()}>
				{(list) => (
					<AddListStocksDialog
						api={props.api}
						list={list()}
						candidates={(() => {
							const current = props.data();
							return current === null ? [] : stocksOutsideList(current, list());
						})()}
						storedMarkets={props.storedMarkets()}
						opener={opener()}
						pending={pending()}
						failure={dialogError()}
						onSubmit={(choice) => void addStocks(list(), choice)}
						onClose={() => setAddListId(null)}
					/>
				)}
			</Show>
			<Show when={deleting()}>
				{(list) => (
					<ConfirmDialog
						title={m().deleteHeading(list().title)}
						opener={opener()}
						confirmLabel={m().deleteList}
						pending={pending()}
						failure={null}
						onConfirm={() => void confirmDelete()}
						onCancel={() => setDeleting(null)}
					>
						{m().deleteBody}
					</ConfirmDialog>
				)}
			</Show>
		</Section>
	);
}

/**
 * A list's tab: "Title · n of 12 stocks" with Add stock, Show on Home and the
 * list's menu (Rename…, Delete…), then the stock table filtered to the list
 * (Remove from list per row), or the empty-state sentence. A full list
 * disables Add stock and says why.
 */
function ListPanel(props: {
	readonly list: WatchlistList;
	readonly members: readonly WatchlistStock[];
	/** True while a list write of the page is on its way. */
	readonly busy: boolean;
	readonly onAdd: (opener: HTMLElement) => void;
	readonly onShowOnHome: () => void;
	readonly onRename: (opener: HTMLElement | null) => void;
	readonly onDelete: (opener: HTMLElement | null) => void;
	readonly onRemove: (stock: WatchlistStock) => void;
}): JSX.Element {
	const m = useMessages(watchlistListsMessages);
	const full = () => listFull(props.list);
	const busy = () => props.busy;
	/** The menu's button: where focus returns after a dialog the menu opened. */
	const menuButton = (): HTMLElement | null => {
		const active = document.activeElement;
		return active instanceof HTMLElement ? active : null;
	};
	return (
		<div class="space-y-2" data-list-id={props.list.listId}>
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<p class="min-w-0 break-words text-sm text-slate-900" data-field="list-heading">
					<span class="font-semibold">{props.list.title}</span>
					<span class="text-slate-700">
						{" · "}
						{m().stockCountOf(props.list.stockIds.length, WATCHLIST_LISTS_LIMITS.maxStocksPerList)}
					</span>
				</p>
				<div class="ml-auto flex flex-wrap items-center gap-2">
					<button
						type="button"
						class={BUTTON}
						aria-label={m().addStockNamed(props.list.title)}
						data-list-add=""
						aria-describedby={full() ? "watchlist-list-full" : undefined}
						disabled={busy() || full()}
						onClick={(event) => props.onAdd(event.currentTarget)}
					>
						{m().addStock}
					</button>
					<button
						type="button"
						class={BUTTON}
						disabled={busy()}
						onClick={() => props.onShowOnHome()}
					>
						{m().showOnHome}
					</button>
					<ActionMenu
						buttonLabel={m().listActions(props.list.title)}
						menuLabel={m().listMenu(props.list.title)}
						iconTrigger={{ icon: "three-dots", disabled: busy() }}
						items={[
							{
								value: "rename",
								label: m().rename,
								disabled: busy(),
								onSelect: () => props.onRename(menuButton()),
							},
							{
								value: "delete",
								label: m().deleteItem,
								disabled: busy(),
								onSelect: () => props.onDelete(menuButton()),
							},
						]}
					/>
				</div>
			</div>
			<Show when={full()}>
				<p id="watchlist-list-full" class="text-xs text-amber-900">
					{m().listFull(WATCHLIST_LISTS_LIMITS.maxStocksPerList)}
				</p>
			</Show>
			<Show
				when={props.members.length > 0}
				fallback={<p class="text-sm text-slate-700">{m().emptyList}</p>}
			>
				<StockTable
					stocks={props.members}
					caption={m().listCaption(props.list.title)}
					list={{ title: props.list.title, busy: busy(), onRemove: props.onRemove }}
				/>
			</Show>
		</div>
	);
}
