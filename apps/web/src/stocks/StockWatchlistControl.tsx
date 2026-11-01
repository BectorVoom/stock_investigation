import { WATCHLIST_LISTS_LIMITS } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
	type Accessor,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	ConfirmDialog,
	ErrorNotice,
	LABEL,
} from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { REGISTERED_STOCKS_HASH } from "../router.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import { joinNames } from "../watchlist/listsModel.ts";
import { type DialogFailure, dialogFailure } from "../watchlist/WatchlistListDialogs.tsx";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { STOCK_DETAIL_HEADING_ID } from "./StockDetail.tsx";
import { stocksMessages } from "./stocks.messages.ts";
import { canAddFromDetail, type ListChoice, listChoicesFor } from "./stocksModel.ts";
import type { SelectedStock } from "./stockTabs.ts";
import type { WatchlistPageState } from "./watchlistState.ts";

/**
 * The shown stock's place on the Watchlist (ADR-0050 §2), beside its
 * heading: "On the Watchlist" and the lists it is in, and the add button —
 * "Add to Watchlist" for a stock that is not on it, "Add to a list" for one
 * that is while a list can still take it. The button opens a dialog with
 * one checkbox per list. A stock on the Watchlist also gets "Remove from
 * Watchlist" (ADR-0054: the only place a stock leaves it), confirmed in a
 * dialog that says how many lists it leaves too. Nothing shows until the
 * watchlist is read, so no button offers a change the page cannot judge.
 *
 * The writes are the existing ones: each ticked list is one list add
 * (which puts the stock on the watchlist first), and with no list ticked
 * the stock goes on the watchlist alone. A stock that just went on the
 * watchlist has its earnings dates fetched by the server at the runner's
 * next claim, as after an add on Registered stocks; the page says so and
 * looks for them soon. The server also syncs the statements of every
 * Watchlist stock and the Google Calendar (ADR-0054): the page queues no
 * sync.
 */
export function StockWatchlistControl(props: {
	readonly api: ApiClient;
	readonly stock: Accessor<SelectedStock>;
	readonly watch: WatchlistPageState;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const listText = useMessages(watchlistListsMessages);
	const watchText = useMessages(watchlistMessages);
	const locale = useLocale();
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	const [open, setOpen] = createSignal(false);
	/** The Remove from Watchlist button while its confirmation is open. */
	const [removeOpener, setRemoveOpener] = createSignal<HTMLElement | null>(null);
	const [pending, setPending] = createSignal(false);
	const [failure, setFailure] = createSignal<DialogFailure | null>(null);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const onWatchlist = () => props.stock().watchlist !== null;
	const choices = createMemo((): ListChoice[] =>
		listChoicesFor(props.watch.data()?.lists ?? [], props.stock().stockId),
	);
	const canAdd = () => canAddFromDetail(onWatchlist(), choices());
	/**
	 * Focus returns to the button; after an add that left nothing more to
	 * add the button is gone, so it lands on the stock's heading instead.
	 */
	const close = (): void => {
		setOpen(false);
		setFailure(null);
		queueMicrotask(() => {
			const button = opener();
			if (button?.isConnected === true) button.focus();
			else document.getElementById(STOCK_DETAIL_HEADING_ID)?.focus();
		});
	};

	const add = async (listIds: readonly string[]): Promise<void> => {
		if (pending()) return;
		const stock = props.stock();
		const request = { market: stock.market, symbol: stock.symbol };
		const wasWatched = stock.watchlist !== null;
		const titleOf = new Map(choices().map((choice) => [choice.list.listId, choice.list.title]));
		const addedTo: string[] = [];
		let watched = wasWatched;
		let refused: DialogFailure | null = null;
		setPending(true);
		setFailure(null);
		if (listIds.length === 0) {
			const result = await props.api.addWatchlistStock(request);
			if (result.ok) watched = true;
			else refused = dialogFailure(result.error, s().notAddedToWatchlist(stock.symbol), listText());
		}
		for (const listId of listIds) {
			const result = await props.api.addWatchlistListStock(listId, request);
			if (!result.ok) {
				refused = dialogFailure(result.error, listText().notAddedNamed(stock.symbol), listText());
				break;
			}
			watched = true;
			addedTo.push(titleOf.get(listId) ?? listId);
		}
		// The watchlist is read again before the dialog closes — after a
		// refusal too, which may come from a list changed elsewhere — so the
		// button (or its absence), the status line and the dialog's lists
		// show what landed when focus returns. The page's watchlist state
		// outlives this control: when another stock was opened meanwhile,
		// the re-read and the announcement of its earnings dates still follow, and
		// only this control's own signals are left alone.
		// Only a write that landed is the owner's change the Google sync
		// follows; a refusal that changed nothing only re-reads.
		if (watched !== wasWatched || addedTo.length > 0) await props.watch.reloadAfterWrite();
		else await props.watch.reload();
		if (!disposed) {
			setPending(false);
			if (refused !== null) setFailure(refused);
			else close();
		}
		const lists = joinNames(addedTo, locale());
		if (!wasWatched && watched) {
			await props.watch.afterStockWatched(
				addedTo.length === 0
					? s().addedToWatchlist(stock.symbol)
					: s().addedToWatchlistAndLists(stock.symbol, lists),
				{ reloaded: true },
			);
		} else if (addedTo.length > 0 && !disposed) {
			props.watch.say(s().addedToLists(stock.symbol, lists));
		}
	};

	/** Focus after the confirmation closes: the button if it is still there, else the heading. */
	const focusAfterRemove = (): void => {
		queueMicrotask(() => {
			const button = removeOpener();
			setRemoveOpener(null);
			if (button?.isConnected === true) button.focus();
			else document.getElementById(STOCK_DETAIL_HEADING_ID)?.focus();
		});
	};
	const confirmRemove = async (): Promise<void> => {
		const stock = props.stock().watchlist;
		if (stock === null) return;
		// The page states a refusal above the stock (`watch.failure`).
		await props.watch.removeStock(stock);
		if (!disposed) focusAfterRemove();
	};

	return (
		<Show when={props.watch.data() !== null}>
			<div class="flex flex-wrap items-center gap-2" data-field="stock-watchlist">
				<Show when={onWatchlist()}>
					<p class="text-xs text-slate-700" data-field="stock-watchlist-status">
						{s().onWatchlistStatus}
						<Show when={props.stock().listTitles.length > 0}>
							{" · "}
							{listText().inLists(joinNames(props.stock().listTitles, locale()))}
						</Show>
					</p>
				</Show>
				<Show when={canAdd()}>
					<button
						type="button"
						class={BUTTON}
						data-field="stock-add-to-watchlist"
						// Not disabled while the page queues the new stock's dates:
						// focus returns here then, and a disabled button drops it.
						disabled={pending()}
						aria-haspopup="dialog"
						onClick={(event) => {
							setOpener(event.currentTarget);
							setFailure(null);
							setOpen(true);
						}}
					>
						{onWatchlist() ? s().addToList : s().addToWatchlist}
					</button>
				</Show>
				<Show when={onWatchlist()}>
					<button
						type="button"
						class={BUTTON_DANGER}
						data-field="stock-remove-from-watchlist"
						disabled={props.watch.busy()}
						aria-haspopup="dialog"
						onClick={(event) => setRemoveOpener(event.currentTarget)}
					>
						{s().removeFromWatchlist}
					</button>
				</Show>
			</div>
			<Show when={removeOpener() !== null && onWatchlist()}>
				<ConfirmDialog
					title={watchText().removeTitle(props.stock().symbol)}
					opener={removeOpener()}
					confirmLabel={watchText().removeStock}
					pending={props.watch.busy()}
					failure={null}
					onConfirm={() => void confirmRemove()}
					onCancel={focusAfterRemove}
				>
					{watchText().removeBody(props.stock().symbol)}
					<Show when={props.stock().listTitles.length > 0}>
						{" "}
						<span data-field="remove-leaves-lists">
							{listText().alsoLeavesLists(props.stock().listTitles.length)}
						</span>
					</Show>
				</ConfirmDialog>
			</Show>
			<Show when={open()}>
				<AddToWatchlistDialog
					symbol={props.stock().symbol}
					onWatchlist={onWatchlist()}
					choices={choices()}
					pending={pending()}
					failure={failure()}
					onSubmit={(listIds) => void add(listIds)}
					onClose={close}
				/>
			</Show>
		</Show>
	);
}

/**
 * The list choice (ADR-0050 §2): a modal dialog with one checkbox per list,
 * in the owner's order. A list that holds the stock shows ticked and
 * disabled ("Already in this list"); a full one disabled ("Full"). With no
 * list ticked, Add puts a stock that is not on the watchlist there alone;
 * for one that is, Add waits for a ticked list. Escape and Cancel close it
 * and focus returns to the button.
 */
function AddToWatchlistDialog(props: {
	readonly symbol: string;
	readonly onWatchlist: boolean;
	readonly choices: readonly ListChoice[];
	readonly pending: boolean;
	readonly failure: DialogFailure | null;
	readonly onSubmit: (listIds: readonly string[]) => void;
	readonly onClose: () => void;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const listText = useMessages(watchlistListsMessages);
	const common = useMessages(commonMessages);
	const headingId = createUniqueId();
	const introId = createUniqueId();
	const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set());
	/** The ticked lists that can still take the stock (a list that changed meanwhile drops out). */
	const chosen = createMemo(() =>
		props.choices
			.filter((choice) => choice.state === "available" && ticked().has(choice.list.listId))
			.map((choice) => choice.list.listId),
	);
	const canSubmit = () => !props.pending && (!props.onWatchlist || chosen().length > 0);
	const toggle = (listId: string, on: boolean): void => {
		setTicked((current) => {
			const next = new Set(current);
			if (on) next.add(listId);
			else next.delete(listId);
			return next;
		});
	};
	/** "Already in this list", or the list's count ("Full · 12 of 12 stocks" at its limit). */
	const choiceNote = (choice: ListChoice): string => {
		if (choice.state === "member") return s().alreadyInList;
		const count = listText().stockCountOf(
			choice.list.stockIds.length,
			WATCHLIST_LISTS_LIMITS.maxStocksPerList,
		);
		return choice.state === "full" ? `${s().listIsFull} · ${count}` : count;
	};
	let dialog: HTMLDialogElement | undefined;
	let submitButton: HTMLButtonElement | undefined;
	onMount(() => {
		dialog?.showModal();
		const first = dialog?.querySelector<HTMLInputElement>("input[type=checkbox]:not(:disabled)");
		(first ?? submitButton)?.focus();
	});
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			aria-describedby={introId}
			class="m-auto w-full max-w-md rounded bg-slate-100 p-4"
			data-field="add-to-watchlist-dialog"
			onCancel={(event) => {
				event.preventDefault();
				// Like Cancel, Escape waits for a write on its way: its refusal is shown here.
				if (!props.pending) props.onClose();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (canSubmit()) props.onSubmit(chosen());
				}}
			>
				<h3 id={headingId} class="text-base font-semibold text-slate-900">
					{props.onWatchlist
						? s().addToListsHeading(props.symbol)
						: s().addToWatchlistNamed(props.symbol)}
				</h3>
				<p id={introId} class="mt-1 text-xs text-slate-700">
					{props.onWatchlist ? s().addIntroWatched : s().addIntro}
				</p>
				<fieldset class="mt-2 space-y-1">
					<legend class={LABEL}>{s().lists}</legend>
					<Show
						when={props.choices.length > 0}
						fallback={
							<p class="text-sm text-slate-700" data-field="no-lists">
								{s().noListsYet}{" "}
								<a href={REGISTERED_STOCKS_HASH} class={TASK_LINK} onClick={() => props.onClose()}>
									{s().openRegistered}
								</a>
							</p>
						}
					>
						<ul class="max-h-64 space-y-0.5 overflow-y-auto rounded bg-white p-1">
							<For each={props.choices}>
								{(choice) => (
									<li>
										<label
											class="flex min-h-8 items-center gap-2 rounded px-2 py-1 text-sm"
											classList={{
												"cursor-pointer hover:bg-slate-100": choice.state === "available",
												"text-slate-600": choice.state !== "available",
											}}
										>
											<input
												type="checkbox"
												data-list-id={choice.list.listId}
												checked={choice.state === "member" || ticked().has(choice.list.listId)}
												disabled={choice.state !== "available" || props.pending}
												onChange={(event) =>
													toggle(choice.list.listId, event.currentTarget.checked)
												}
											/>
											<span class="min-w-0 flex-1 truncate">{choice.list.title}</span>
											<span class="shrink-0 text-xs text-slate-700">{choiceNote(choice)}</span>
										</label>
									</li>
								)}
							</For>
						</ul>
					</Show>
				</fieldset>
				<Show when={props.failure}>
					{(current) => (
						<div class="mt-2">
							<ErrorNotice failure={current().error} title={current().title} />
						</div>
					)}
				</Show>
				<div class="mt-3 flex gap-2">
					<button
						type="button"
						class={BUTTON}
						disabled={props.pending}
						onClick={() => props.onClose()}
					>
						{common().cancel}
					</button>
					<button
						ref={(element) => {
							submitButton = element;
						}}
						type="submit"
						class={BUTTON_PRIMARY}
						disabled={!canSubmit()}
					>
						{s().addConfirm}
					</button>
				</div>
			</form>
		</dialog>
	);
}
