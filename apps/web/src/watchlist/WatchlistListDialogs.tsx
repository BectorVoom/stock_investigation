import {
	type StockDirectoryHit,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistList,
	type WatchlistStock,
	type WatchMarket,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
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
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, BUTTON_PRIMARY, ErrorNotice, INPUT, LABEL } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { listFailureReason, listRoom, validListTitle } from "./listsModel.ts";
import { StockSearchBox } from "./StockSearchBox.tsx";
import { createStockSearch } from "./stockSearch.ts";
import { watchlistListsMessages } from "./watchlistLists.messages.ts";
import { watchlistModelMessages } from "./watchlistModel.messages.ts";
import { type StockSearchState, selectedStockText } from "./watchlistModel.ts";

/** A refused write shown inside a dialog: its reason sentence (or the action's title), code and message. */
export interface DialogFailure {
	readonly title: string;
	readonly error: ApiFailure;
}

/**
 * Opens a native modal `<dialog>` on mount and closes it on cleanup; Escape
 * runs `onCancel` (focus then returns to the opener, which the caller does).
 */
function useModal(onCancel: () => void): {
	readonly ref: (element: HTMLDialogElement) => void;
	readonly onCancel: (event: Event) => void;
} {
	let dialog: HTMLDialogElement | undefined;
	onMount(() => dialog?.showModal());
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});
	return {
		ref: (element) => {
			dialog = element;
		},
		onCancel: (event) => {
			event.preventDefault();
			onCancel();
		},
	};
}

/**
 * New list / Rename… (ADR-0040 §7): one title field (1–80 characters after
 * trimming, the contract's rule) in a modal dialog. The dialog stays open
 * until the write succeeds, so a refused one shows its reason here without
 * losing the text; Cancel or Escape closes and focus returns to the opener.
 */
export function ListTitleDialog(props: {
	readonly heading: string;
	readonly submitLabel: string;
	readonly initialTitle: string;
	readonly opener: HTMLElement | null;
	readonly pending: boolean;
	readonly failure: DialogFailure | null;
	/** Writes the trimmed title; the caller closes the dialog when it succeeded. */
	readonly onSubmit: (title: string) => void;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(watchlistListsMessages);
	const common = useMessages(commonMessages);
	const headingId = createUniqueId();
	const inputId = createUniqueId();
	const hintId = createUniqueId();
	const [title, setTitle] = createSignal(props.initialTitle);
	const valid = () => validListTitle(title());
	const close = (): void => {
		props.onClose();
		props.opener?.focus();
	};
	const modal = useModal(close);
	let input: HTMLInputElement | undefined;
	onMount(() => {
		input?.focus();
		input?.select();
	});
	return (
		<dialog
			ref={modal.ref}
			aria-labelledby={headingId}
			class="m-auto w-full max-w-md rounded bg-slate-100 p-4"
			data-list-title-dialog=""
			onCancel={modal.onCancel}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					const next = valid();
					if (next !== null && !props.pending) props.onSubmit(next);
				}}
			>
				<h3 id={headingId} class="text-base font-semibold text-slate-900">
					{props.heading}
				</h3>
				<div class="mt-2 space-y-1">
					<label for={inputId} class={LABEL}>
						{m().titleLabel}
					</label>
					<input
						ref={(element) => {
							input = element;
						}}
						id={inputId}
						type="text"
						class={INPUT}
						autocomplete="off"
						value={title()}
						aria-describedby={hintId}
						aria-invalid={valid() === null && title() !== ""}
						onInput={(event) => setTitle(event.currentTarget.value)}
					/>
					<p id={hintId} class="text-xs text-slate-700">
						{valid() === null && title() !== ""
							? m().titleProblem(WATCHLIST_LISTS_LIMITS.maxTitleChars)
							: m().titleHint(WATCHLIST_LISTS_LIMITS.maxTitleChars)}
					</p>
				</div>
				<Show when={props.failure}>
					{(failure) => (
						<div class="mt-2">
							<ErrorNotice failure={failure().error} title={failure().title} />
						</div>
					)}
				</Show>
				<div class="mt-3 flex gap-2">
					<button type="button" class={BUTTON} disabled={props.pending} onClick={() => close()}>
						{common().cancel}
					</button>
					<button type="submit" class={BUTTON_PRIMARY} disabled={props.pending || valid() === null}>
						{props.submitLabel}
					</button>
				</div>
			</form>
		</dialog>
	);
}

/** What the Add stock dialog asks to add: watchlist stocks by id, and at most one stock found by search. */
export interface ListStockChoice {
	readonly watched: readonly WatchlistStock[];
	readonly found: StockDirectoryHit | null;
}

/**
 * Add stock (ADR-0040 §7): the watchlist's stocks not yet in the list as
 * checkboxes, and the stock search box (ADR-0034) for a stock not on the
 * watchlist — adding it also adds it to the watchlist, which the dialog
 * says. More than the list's room disables the button and says why. The
 * dialog stays open until every chosen stock was added, so a refused add
 * shows its reason here.
 */
export function AddListStocksDialog(props: {
	readonly api: ApiClient;
	readonly list: WatchlistList;
	/** The watchlist's stocks not in the list, in watchlist order. */
	readonly candidates: readonly WatchlistStock[];
	readonly storedMarkets: readonly WatchMarket[] | null;
	readonly opener: HTMLElement | null;
	readonly pending: boolean;
	readonly failure: DialogFailure | null;
	readonly onSubmit: (choice: ListStockChoice) => void;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(watchlistListsMessages);
	const model = useMessages(watchlistModelMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	const headingId = createUniqueId();
	const searchId = createUniqueId();
	const [checked, setChecked] = createSignal<ReadonlySet<string>>(new Set());
	const [query, setQuery] = createSignal("");
	const [searchState, setSearchState] = createSignal<StockSearchState>({ kind: "idle" });
	const [found, setFound] = createSignal<StockDirectoryHit | null>(null);
	const search = createStockSearch({
		search: (text, signal) => props.api.searchStockDirectory({ q: text }, signal),
		onState: setSearchState,
	});
	onCleanup(() => search.dispose());
	const close = (): void => {
		props.onClose();
		props.opener?.focus();
	};
	const modal = useModal(close);

	const chosenWatched = createMemo(() =>
		props.candidates.filter((stock) => checked().has(stock.stockId)),
	);
	const count = () => chosenWatched().length + (found() === null ? 0 : 1);
	const room = () => listRoom(props.list);
	const tooMany = () => count() > room();
	const toggle = (stockId: string, on: boolean): void => {
		setChecked((current) => {
			const next = new Set(current);
			if (on) next.add(stockId);
			else next.delete(stockId);
			return next;
		});
	};
	const onQueryInput = (text: string): void => {
		setQuery(text);
		setFound(null);
		search.input(text);
	};
	let firstCheckbox: HTMLInputElement | undefined;
	// Focus starts on the first watchlist stock, else on the search box.
	onMount(() => {
		const start = firstCheckbox ?? document.getElementById(searchId);
		start?.focus();
	});

	return (
		<dialog
			ref={modal.ref}
			aria-labelledby={headingId}
			class="m-auto w-full max-w-lg rounded bg-slate-100 p-4"
			data-list-add-dialog=""
			onCancel={modal.onCancel}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (props.pending || count() === 0 || tooMany()) return;
					props.onSubmit({ watched: chosenWatched(), found: found() });
				}}
			>
				<h3 id={headingId} class="text-base font-semibold text-slate-900">
					{m().addHeading(props.list.title)}
				</h3>
				<p class="mt-1 text-xs text-slate-700">{m().roomLeft(room())}</p>
				<fieldset class="mt-2 space-y-1">
					<legend class={LABEL}>{m().watchedStocks}</legend>
					<Show
						when={props.candidates.length > 0}
						fallback={<p class="text-sm text-slate-700">{m().noOtherWatched}</p>}
					>
						<ul class="max-h-48 space-y-0.5 overflow-y-auto rounded bg-white p-1">
							<For each={props.candidates}>
								{(stock, index) => (
									<li>
										<label class="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-100">
											<input
												ref={(element) => {
													if (index() === 0) firstCheckbox = element;
												}}
												type="checkbox"
												data-stock-id={stock.stockId}
												checked={checked().has(stock.stockId)}
												onChange={(event) => toggle(stock.stockId, event.currentTarget.checked)}
											/>
											<span class="w-14 shrink-0 font-mono font-medium">{stock.symbol}</span>
											<span class="min-w-0 flex-1 truncate text-slate-700">
												{stock.name ?? model().marketName(stock.market)}
											</span>
										</label>
									</li>
								)}
							</For>
						</ul>
					</Show>
				</fieldset>
				<div class="mt-3 space-y-1" data-field="list-add-search">
					<p class="text-xs font-medium text-slate-700">{m().searchHeading}</p>
					<p class="text-xs text-slate-700">{m().searchHint}</p>
					<StockSearchBox
						id={searchId}
						query={query()}
						state={searchState()}
						storedMarkets={props.storedMarkets}
						canSubmit={found() !== null}
						onQueryInput={onQueryInput}
						onPick={(hit) => setFound(hit)}
						onClear={() => onQueryInput("")}
					/>
					<output
						data-field="list-add-found"
						class="block text-sm font-medium text-slate-900 empty:hidden"
					>
						{(() => {
							const hit = found();
							return hit === null ? "" : selectedStockText(hit, locale(), model());
						})()}
					</output>
				</div>
				<Show when={tooMany()}>
					<p class="mt-2 text-xs text-amber-900" data-field="list-add-too-many">
						{m().tooManyChosen(room())}
					</p>
				</Show>
				<Show when={props.failure}>
					{(failure) => (
						<div class="mt-2">
							<ErrorNotice failure={failure().error} title={failure().title} />
						</div>
					)}
				</Show>
				<div class="mt-3 flex gap-2">
					<button type="button" class={BUTTON} disabled={props.pending} onClick={() => close()}>
						{common().cancel}
					</button>
					<button
						type="submit"
						class={BUTTON_PRIMARY}
						disabled={props.pending || count() === 0 || tooMany()}
					>
						{m().addChosen(count())}
					</button>
				</div>
			</form>
		</dialog>
	);
}

/** The failure a dialog shows for a refused list write: the reason sentence, else the action's title. */
export function dialogFailure(
	error: ApiFailure,
	actionTitle: string,
	text: Parameters<typeof listFailureReason>[1],
): DialogFailure {
	return { title: listFailureReason(error, text) ?? actionTitle, error };
}
