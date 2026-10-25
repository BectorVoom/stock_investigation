import {
	formatStockId,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistList,
	type WatchlistResponse,
	type WatchlistStock,
	type WatchMarket,
} from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { type Accessor, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { ApiClient, WatchlistData } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import {
	ActionMenu,
	BUTTON,
	BUTTON_DANGER,
	ConfirmDialog,
	ErrorNotice,
	Section,
} from "../components/ui.tsx";
import { listStocks, stocksById } from "../widgets/pageSeries.ts";
import { showWidgetOnHome } from "../widgets/showOnHome.ts";
import { watchlistPricesWidget } from "../widgets/widgetModel.ts";
import {
	homeFullText,
	listFailureReason,
	listFull,
	listsFull,
	stocksOutsideList,
} from "./listsModel.ts";
import {
	AddListStocksDialog,
	type DialogFailure,
	dialogFailure,
	type ListStockChoice,
	ListTitleDialog,
} from "./WatchlistListDialogs.tsx";
import { watchlistListsMessages } from "./watchlistLists.messages.ts";
import { watchlistModelMessages } from "./watchlistModel.messages.ts";

type TitleDialogState =
	| { readonly mode: "create" }
	| { readonly mode: "rename"; readonly listId: string; readonly title: string };

/**
 * The Watchlist page's Lists section (ADR-0040 §7), below the add-a-stock
 * form: New list, then one card per list — its title and count, a menu
 * (Rename…, Show on Home, Delete…), its stocks with Remove from list, and
 * Add stock. The bounds (20 lists, 12 stocks a list) disable the controls
 * and say why. Every write answers the whole watchlist; the page then
 * re-reads it (`onWritten`) like after its own changes, and a stock a list
 * add put on the watchlist queues the earnings refresh the page's plain add
 * queues (`onStockWatched`).
 */
export function WatchlistListsSection(props: {
	readonly api: ApiClient;
	readonly data: Accessor<WatchlistResponse | null>;
	/** True while the page itself writes (add or remove a stock, queue a refresh). */
	readonly pageBusy: Accessor<boolean>;
	readonly storedMarkets: Accessor<readonly WatchMarket[] | null>;
	/** Re-reads the watchlist after a list write. */
	readonly onWritten: () => Promise<void>;
	/** After a list add put a new stock on the watchlist: re-read and queue its earnings dates, saying `notice`. */
	readonly onStockWatched: (notice: string) => Promise<void>;
}): JSX.Element {
	const m = useMessages(watchlistListsMessages);
	const [pending, setPending] = createSignal(false);
	const [notice, setNotice] = createSignal<string | null>(null);
	const [failure, setFailure] = createSignal<DialogFailure | null>(null);
	const [titleDialog, setTitleDialog] = createSignal<TitleDialogState | null>(null);
	const [addListId, setAddListId] = createSignal<string | null>(null);
	const [dialogError, setDialogError] = createSignal<DialogFailure | null>(null);
	const [deleting, setDeleting] = createSignal<WatchlistList | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	const busy = () => pending() || props.pageBusy();
	const lists = () => props.data()?.lists ?? [];
	const stocks = createMemo(() => {
		const current = props.data();
		return current === null ? new Map<string, WatchlistStock>() : stocksById(current);
	});
	const atListLimit = () => {
		const current = props.data();
		return current !== null && listsFull(current);
	};
	const addList = () => lists().find((list) => list.listId === addListId()) ?? null;

	/** Runs one list write: clears the last outcome, reports a refusal, re-reads after any answer. */
	const run = async (
		write: () => Promise<ApiResult<WatchlistData>>,
		onRefused: (error: ApiFailure) => void,
	): Promise<boolean> => {
		if (busy()) return false;
		setPending(true);
		setNotice(null);
		setFailure(null);
		const result = await write();
		setPending(false);
		if (!result.ok) {
			onRefused(result.error);
			// A list or stock that is gone: show the lists as they are now.
			if (result.error.code === "NOT_FOUND") await props.onWritten();
			return false;
		}
		return true;
	};
	const refuseInPage = (title: string) => (error: ApiFailure) =>
		setFailure({ title: listFailureReason(error, m()) ?? title, error });
	const refuseInDialog = (title: string) => (error: ApiFailure) =>
		setDialogError(dialogFailure(error, title, m()));

	const openTitleDialog = (state: TitleDialogState, from: HTMLElement | null): void => {
		setOpener(from);
		setDialogError(null);
		setTitleDialog(state);
	};
	const submitTitle = async (title: string): Promise<void> => {
		const state = titleDialog();
		if (state === null) return;
		const done =
			state.mode === "create"
				? await run(() => props.api.createWatchlistList(title), refuseInDialog(m().notCreated))
				: await run(
						() => props.api.renameWatchlistList(state.listId, title),
						refuseInDialog(m().notRenamed),
					);
		if (!done) return;
		setTitleDialog(null);
		opener()?.focus();
		setNotice(state.mode === "create" ? m().created(title) : m().renamed(title));
		await props.onWritten();
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
		if (!done) return;
		setNotice(m().deleted(list.title));
		await props.onWritten();
	};

	const removeStock = async (list: WatchlistList, stock: WatchlistStock): Promise<void> => {
		const done = await run(
			() => props.api.removeWatchlistListStock(list.listId, stock.stockId),
			refuseInPage(m().notRemoved),
		);
		if (!done) return;
		setNotice(m().removedFromList(stock.symbol, list.title));
		await props.onWritten();
	};

	/**
	 * Adds the chosen stocks one request each, in the order shown (the API
	 * takes one stock per request), stopping at the first refusal; the page
	 * re-reads whatever was added.
	 */
	const addStocks = async (list: WatchlistList, choice: ListStockChoice): Promise<void> => {
		const wanted = [
			...choice.watched.map((stock) => ({ market: stock.market, symbol: stock.symbol })),
			...(choice.found === null
				? []
				: [{ market: choice.found.market, symbol: choice.found.symbol }]),
		];
		const added: string[] = [];
		for (const stock of wanted) {
			const done = await run(
				() => props.api.addWatchlistListStock(list.listId, stock),
				refuseInDialog(m().notAdded),
			);
			if (!done) {
				if (added.length > 0) await props.onWritten();
				return;
			}
			added.push(stock.symbol);
		}
		setAddListId(null);
		opener()?.focus();
		const found = choice.found;
		// A searched stock already on the watchlist cannot be picked, so `found` is a new stock.
		if (found !== null && !stocks().has(formatStockId(found.market, found.symbol))) {
			const others = added.filter((symbol) => symbol !== found.symbol);
			if (others.length > 0) setNotice(m().addedToList(others.join(", "), list.title));
			await props.onStockWatched(m().addedToListAndWatchlist(found.symbol, list.title));
			return;
		}
		setNotice(m().addedToList(added.join(", "), list.title));
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
			title={m().sectionTitle}
			actions={
				<button
					type="button"
					class={BUTTON}
					disabled={busy() || props.data() === null || atListLimit()}
					aria-describedby={atListLimit() ? "watchlist-lists-limit" : undefined}
					onClick={(event) => openTitleDialog({ mode: "create" }, event.currentTarget)}
				>
					{m().newList}
				</button>
			}
		>
			<p class="text-xs text-slate-700">{m().sectionHint}</p>
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
			<Show when={props.data() !== null}>
				<Show
					when={lists().length > 0}
					fallback={<p class="mt-2 text-sm text-slate-700">{m().noLists}</p>}
				>
					<ul class="mt-2 grid gap-2 sm:grid-cols-2" aria-label={m().sectionTitle}>
						<For each={lists()}>
							{(list) => (
								<ListCard
									list={list}
									members={listStocks(list, stocks())}
									busy={busy()}
									onRename={(from) =>
										openTitleDialog(
											{ mode: "rename", listId: list.listId, title: list.title },
											from,
										)
									}
									onShowOnHome={() => void showOnHome(list)}
									onDelete={(from) => {
										setOpener(from);
										setDeleting(list);
									}}
									onRemove={(stock) => void removeStock(list, stock)}
									onAdd={(from) => {
										setOpener(from);
										setDialogError(null);
										setAddListId(list.listId);
									}}
								/>
							)}
						</For>
					</ul>
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
						opener={opener()}
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

/** One list card: title and count, its menu, its stocks, Add stock. */
function ListCard(props: {
	readonly list: WatchlistList;
	readonly members: readonly WatchlistStock[];
	readonly busy: boolean;
	readonly onRename: (opener: HTMLElement | null) => void;
	readonly onShowOnHome: () => void;
	readonly onDelete: (opener: HTMLElement | null) => void;
	readonly onRemove: (stock: WatchlistStock) => void;
	readonly onAdd: (opener: HTMLElement) => void;
}): JSX.Element {
	const m = useMessages(watchlistListsMessages);
	const model = useMessages(watchlistModelMessages);
	const full = () => listFull(props.list);
	const fullId = () => `list-full-${props.list.listId}`;
	/** The menu's button: where focus returns after a dialog the menu opened. */
	const menuButton = (): HTMLElement | null => {
		const active = document.activeElement;
		return active instanceof HTMLElement ? active : null;
	};
	return (
		<li
			class="flex min-w-0 flex-col gap-2 rounded border border-slate-300 bg-white p-3"
			aria-label={m().listCard(props.list.title)}
			data-list-id={props.list.listId}
		>
			<div class="flex items-start gap-2">
				<div class="min-w-0 flex-1">
					<h4 class="break-words text-sm font-semibold text-slate-900">{props.list.title}</h4>
					<p class="text-xs text-slate-700" data-field="list-count">
						{m().stockCountOf(props.list.stockIds.length, WATCHLIST_LISTS_LIMITS.maxStocksPerList)}
					</p>
				</div>
				<ActionMenu
					buttonLabel={m().listActions(props.list.title)}
					menuLabel={m().listMenu(props.list.title)}
					iconTrigger={{ icon: "three-dots", disabled: props.busy }}
					items={[
						{
							value: "rename",
							label: m().rename,
							disabled: props.busy,
							onSelect: () => props.onRename(menuButton()),
						},
						{
							value: "home",
							label: m().showOnHome,
							disabled: props.busy,
							onSelect: () => props.onShowOnHome(),
						},
						{
							value: "delete",
							label: m().deleteItem,
							disabled: props.busy,
							onSelect: () => props.onDelete(menuButton()),
						},
					]}
				/>
			</div>
			<Show
				when={props.members.length > 0}
				fallback={<p class="text-sm text-slate-700">{m().emptyList}</p>}
			>
				<ul class="divide-y divide-slate-200" aria-label={m().listStocks(props.list.title)}>
					<For each={props.members}>
						{(stock) => (
							<li class="flex items-center gap-2 py-1" data-stock-id={stock.stockId}>
								<span class="w-14 shrink-0 font-mono text-sm font-medium">{stock.symbol}</span>
								<span class="min-w-0 flex-1 truncate text-sm text-slate-700">
									{stock.name ?? model().marketName(stock.market)}
								</span>
								<button
									type="button"
									class={BUTTON_DANGER}
									aria-label={m().removeFromListNamed(stock.symbol, props.list.title)}
									disabled={props.busy}
									onClick={() => props.onRemove(stock)}
								>
									{m().removeFromList}
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>
			<div class="mt-auto flex flex-wrap items-center gap-2">
				<button
					type="button"
					class={BUTTON}
					aria-label={m().addStockNamed(props.list.title)}
					aria-describedby={full() ? fullId() : undefined}
					disabled={props.busy || full()}
					onClick={(event) => props.onAdd(event.currentTarget)}
				>
					{m().addStock}
				</button>
				<Show when={full()}>
					<p id={fullId()} class="text-xs text-amber-900">
						{m().listFull(WATCHLIST_LISTS_LIMITS.maxStocksPerList)}
					</p>
				</Show>
			</div>
		</li>
	);
}
