import { STOCK_DIRECTORY_LIMITS, type StockDirectoryHit } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { createSignal, For, type JSX, Show } from "solid-js";
import { failureMessageIn } from "../api/errorText.ts";
import { INPUT, LABEL } from "../components/ui.tsx";
import { watchlistMessages } from "./watchlist.messages.ts";
import { watchlistModelMessages } from "./watchlistModel.messages.ts";
import {
	moveActiveOption,
	type StockSearchState,
	stockHitNames,
	stockHitPlace,
	stockSearchHits,
	stockSearchStatusText,
} from "./watchlistModel.ts";

/**
 * The add-a-stock search (ADR-0033): a WAI-ARIA 1.2 combobox with a listbox
 * popup and list autocompletion. Focus stays in the input; the active option
 * is announced through `aria-activedescendant`. ↓/↑ open the list and move
 * (wrapping), Enter picks the active option (and otherwise submits the form),
 * Escape closes the list and, pressed again, clears the text. Hits already on
 * the watchlist say "Added" and cannot be picked (`aria-disabled`). A live
 * status line under the input tells "Searching…", the result count, or why
 * nothing matched. The request discipline (debounce, abort, stale answers)
 * lives in `createStockSearch`; this part only shows its state.
 */
export function StockSearchBox(props: {
	readonly id: string;
	readonly query: string;
	readonly state: StockSearchState;
	/** False when no market has a list downloaded (the empty answer is explained). */
	readonly listsStored: boolean | null;
	readonly onQueryInput: (text: string) => void;
	readonly onPick: (hit: StockDirectoryHit) => void;
	readonly onClear: () => void;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const model = useMessages(watchlistModelMessages);
	const locale = useLocale();
	const listId = `${props.id}-listbox`;
	const statusId = `${props.id}-status`;
	const optionId = (index: number): string => `${props.id}-option-${index}`;
	const [open, setOpen] = createSignal(false);
	// The active option belongs to the hits it was chosen in: a new answer
	// starts with no active option, with no effect to reset it.
	const [activeIn, setActiveIn] = createSignal<{
		readonly hits: readonly StockDirectoryHit[];
		readonly index: number;
	}>({ hits: [], index: -1 });
	const hits = () => stockSearchHits(props.state);
	const active = () => (activeIn().hits === hits() ? activeIn().index : -1);
	const expanded = () => open() && hits().length > 0;
	const statusText = () =>
		stockSearchStatusText(props.state, props.listsStored, model(), (error) =>
			failureMessageIn(error, locale()),
		);

	const setActive = (index: number): void => {
		setActiveIn({ hits: hits(), index });
	};

	const close = (): void => {
		setOpen(false);
		setActive(-1);
	};

	const pick = (index: number): void => {
		const hit = hits()[index];
		if (hit === undefined || hit.registered) return;
		close();
		props.onPick(hit);
	};

	const move = (direction: "next" | "previous"): void => {
		if (!expanded()) {
			setOpen(true);
			setActive(direction === "next" ? 0 : hits().length - 1);
			return;
		}
		setActive(moveActiveOption(active(), hits().length, direction));
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		switch (event.key) {
			case "ArrowDown":
				if (hits().length === 0) return;
				event.preventDefault();
				move("next");
				return;
			case "ArrowUp":
				if (hits().length === 0) return;
				event.preventDefault();
				move("previous");
				return;
			case "Enter":
				// With no active option Enter submits the form ("Add stock").
				if (!expanded() || active() < 0) return;
				event.preventDefault();
				pick(active());
				return;
			case "Escape":
				if (expanded()) {
					event.preventDefault();
					close();
					return;
				}
				if (props.query !== "") {
					event.preventDefault();
					props.onClear();
				}
				return;
			default:
				return;
		}
	};

	return (
		<div class="relative">
			<label for={props.id} class={LABEL}>
				{m().searchStocks}
			</label>
			<span class="relative block">
				<svg
					aria-hidden="true"
					width="14"
					height="14"
					viewBox="0 0 16 16"
					fill="currentColor"
					class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-slate-600"
				>
					<path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0" />
				</svg>
				<input
					id={props.id}
					type="text"
					role="combobox"
					class={`${INPUT} pl-7`}
					aria-autocomplete="list"
					aria-expanded={expanded()}
					aria-controls={listId}
					aria-activedescendant={active() >= 0 ? optionId(active()) : undefined}
					aria-describedby={statusId}
					placeholder={m().searchPlaceholder}
					maxLength={STOCK_DIRECTORY_LIMITS.maxQueryChars}
					autocomplete="off"
					spellcheck={false}
					value={props.query}
					onInput={(event) => {
						setOpen(true);
						props.onQueryInput(event.currentTarget.value);
					}}
					onKeyDown={onKeyDown}
					onBlur={close}
				/>
			</span>
			<div
				id={listId}
				role="listbox"
				aria-label={m().matchingStocks}
				hidden={!expanded()}
				class="absolute right-0 left-0 z-40 mt-1 max-h-80 overflow-y-auto rounded border border-slate-200 bg-white p-1"
			>
				<For each={hits()}>
					{(hit, index) => {
						const names = () => stockHitNames(hit, locale());
						return (
							// The input keeps focus and drives the active option
							// (aria-activedescendant), so options stay unfocusable.
							// biome-ignore lint/a11y/useFocusableInteractive: active-descendant pattern
							// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox input
							<div
								id={optionId(index())}
								role="option"
								aria-selected={index() === active()}
								aria-disabled={hit.registered ? "true" : undefined}
								data-stock-id={hit.stockId}
								class="flex min-h-7 items-baseline gap-2 rounded px-2 py-1 text-sm text-slate-900"
								classList={{
									"bg-slate-200": index() === active(),
									"cursor-pointer hover:bg-slate-200": !hit.registered,
									"cursor-not-allowed text-slate-600": hit.registered,
								}}
								// Keeps focus in the input, so the pick does not blur and close first.
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => pick(index())}
							>
								<span class="w-14 shrink-0 font-mono font-medium">{hit.symbol}</span>
								<span class="min-w-0 flex-1">
									<span>{names().primary}</span>
									<Show when={names().secondary}>
										{(secondary) => <span class="ml-1 text-xs text-slate-600">{secondary()}</span>}
									</Show>
								</span>
								<span class="shrink-0 text-xs text-slate-700">{stockHitPlace(hit, model())}</span>
								<Show when={hit.registered}>
									<span class="shrink-0 rounded bg-slate-100 px-1 text-xs font-medium text-slate-700">
										{m().alreadyAdded}
									</span>
								</Show>
							</div>
						);
					}}
				</For>
			</div>
			<output id={statusId} class="mt-1 block min-h-4 text-xs text-slate-700">
				{statusText()}
			</output>
		</div>
	);
}
