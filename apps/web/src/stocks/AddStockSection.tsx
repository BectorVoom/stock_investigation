import {
	EQUITY_FINANCIAL_LIMITS,
	type StockDirectoryHit,
	type WatchMarket,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import {
	BUTTON,
	BUTTON_PRIMARY,
	DisclosureSummary,
	ErrorNotice,
	INPUT,
	Section,
	Select,
} from "../components/ui.tsx";
import { StockSearchBox } from "../watchlist/StockSearchBox.tsx";
import type { StockDirectoryState } from "../watchlist/stockDirectory.ts";
import type { StockSearch } from "../watchlist/stockSearch.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import {
	addTargetText,
	directoryStatusLine,
	pickedStockFor,
	type StockSearchState,
	selectedStockText,
	storedDirectoryMarkets,
	validateNewStock,
	WATCH_MARKETS,
} from "../watchlist/watchlistModel.ts";
import { stocksMessages } from "./stocks.messages.ts";

/** What the add form asks the page to do. */
export interface AddStockRequest {
	readonly market: WatchMarket;
	readonly symbol: string;
	/** "Also sync annual financial statements" was checked (and allowed). */
	readonly alsoSync: boolean;
}

/**
 * "Add a stock" (FR-018, ADR-0034, ADR-0049 §2): the directory search with
 * "Enter a symbol instead", the "Also sync annual financial statements"
 * checkbox (checked by default, disabled with its reason at the tracking
 * limit), and each market's stock list status with "Update stock list".
 * The page does the writes (`onAdd` resolves true when the watchlist took
 * the stock, and the form then clears).
 */
export function AddStockSection(props: {
	readonly directory: StockDirectoryState;
	/** The page's directory search (it re-runs when a stock list arrives). */
	readonly search: StockSearch;
	readonly searchState: Accessor<StockSearchState>;
	readonly busy: boolean;
	/** The tracking limit is reached: the checkbox is off and says why. */
	readonly atTrackLimit: boolean;
	readonly onAdd: (request: AddStockRequest) => Promise<boolean>;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const s = useMessages(stocksMessages);
	const locale = useLocale();
	const model = useMessages(watchlistModelMessages);
	const [market, setMarket] = createSignal<WatchMarket>("US");
	const [symbol, setSymbol] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [picked, setPicked] = createSignal<StockDirectoryHit | null>(null);
	const [alsoSync, setAlsoSync] = createSignal(true);
	const problemsId = "watchlist-add-problems";
	const addTargetId = "watchlist-add-target";
	const alsoSyncId = createUniqueId();
	const limitId = createUniqueId();

	const problems = () => validateNewStock(market(), symbol(), model());
	/** The picked search hit while the form still holds it ("Selected: …"). */
	const selected = () => pickedStockFor(picked(), market(), symbol());
	const selectedText = (): string => {
		const hit = selected();
		return hit === null ? "" : selectedStockText(hit, locale(), model());
	};
	/**
	 * Editing the search text starts a new choice: the pick and any symbol
	 * (picked, or typed by hand under a possibly collapsed "Enter a symbol
	 * instead") are cleared, so "Add stock" never adds a stock other than
	 * the one the form shows. A symbol typed after a search stays, and the
	 * line beside the button names it.
	 */
	const onQueryInput = (text: string): void => {
		setQuery(text);
		setSymbol("");
		setPicked(null);
		props.search.input(text);
	};
	const pickStock = (hit: StockDirectoryHit): void => {
		setMarket(hit.market);
		setSymbol(hit.symbol);
		setPicked(hit);
	};
	const submit = async (): Promise<void> => {
		if (problems().length > 0 || props.busy) return;
		const added = await props.onAdd({
			market: market(),
			symbol: symbol(),
			alsoSync: alsoSync() && !props.atTrackLimit,
		});
		if (!added) return;
		onQueryInput("");
	};
	const allDirectoryRunsActive = () =>
		props.directory.status()?.markets.every((entry) => entry.activeRunId !== null) ?? false;

	return (
		<Section title={m().addStockTitle} label={m().addStockTitle}>
			<p class="text-xs text-slate-700">{m().addStockHint}</p>
			<Show when={problems().length > 0}>
				<div class="mt-2 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800">
					<p class="font-medium">{m().toAddThisStock}</p>
					<ul aria-label={m().beforeYouCanAdd} id={problemsId} class="list-disc space-y-0.5 pl-5">
						<For each={problems()}>{(problem) => <li>{problem}</li>}</For>
					</ul>
				</div>
			</Show>
			<form
				aria-label={m().addStockTitle}
				class="mt-2 max-w-xl space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<StockSearchBox
					id="watchlist-search"
					query={query()}
					state={props.searchState()}
					storedMarkets={storedDirectoryMarkets(props.directory.status())}
					canSubmit={selected() !== null}
					onQueryInput={onQueryInput}
					onPick={pickStock}
					onClear={() => onQueryInput("")}
				/>
				<output
					data-field="selected-stock"
					class="block text-sm font-medium text-slate-900 empty:hidden"
				>
					{selectedText()}
				</output>
				<details class="group text-xs">
					<DisclosureSummary class="text-slate-700">{m().enterSymbolInstead}</DisclosureSummary>
					<div class="mt-1 flex flex-wrap items-end gap-2">
						<div class="w-40">
							<label for="watchlist-market" class="block text-xs font-medium text-slate-700">
								{m().market}
							</label>
							<Select
								id="watchlist-market"
								onChange={(event) => {
									const next = event.currentTarget.value;
									if (next === "US" || next === "JP") setMarket(next);
								}}
							>
								<For each={WATCH_MARKETS}>
									{(entry) => (
										<option value={entry} selected={market() === entry}>
											{model().marketName(entry)}
										</option>
									)}
								</For>
							</Select>
						</div>
						<div class="min-w-40 flex-1">
							<label for="watchlist-symbol" class="block text-xs font-medium text-slate-700">
								{m().symbol}
							</label>
							<input
								id="watchlist-symbol"
								type="text"
								class={`${INPUT} font-mono`}
								// i18n-exempt: example tickers, the same in every language
								placeholder={market() === "US" ? "AAPL" : "7203"}
								maxLength={16}
								autocomplete="off"
								spellcheck={false}
								value={symbol()}
								aria-describedby={problems().length > 0 ? problemsId : undefined}
								onInput={(event) => setSymbol(event.currentTarget.value)}
							/>
						</div>
					</div>
				</details>
				<div class="text-sm text-slate-800">
					<label for={alsoSyncId} class="inline-flex min-h-6 items-center gap-2">
						<input
							id={alsoSyncId}
							type="checkbox"
							data-field="also-sync"
							checked={alsoSync() && !props.atTrackLimit}
							disabled={props.atTrackLimit}
							aria-describedby={props.atTrackLimit ? limitId : `${alsoSyncId}-hint`}
							onChange={(event) => setAlsoSync(event.currentTarget.checked)}
						/>
						{s().alsoSync}
					</label>
					<Show
						when={props.atTrackLimit}
						fallback={
							<p id={`${alsoSyncId}-hint`} class="text-2xs text-slate-600">
								{s().alsoSyncHint}
							</p>
						}
					>
						<p id={limitId} class="text-xs text-amber-900" data-field="track-limit">
							{s().atLimit(EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies)}
						</p>
					</Show>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<button
						type="submit"
						class={BUTTON_PRIMARY}
						disabled={props.busy || problems().length > 0}
						aria-describedby={problems().length > 0 ? `${problemsId} ${addTargetId}` : addTargetId}
					>
						{m().addStock}
					</button>
					<output id={addTargetId} data-field="add-target" class="text-sm text-slate-700">
						{addTargetText(market(), symbol(), model())}
					</output>
				</div>
			</form>
			<div
				data-field="stock-lists"
				class="mt-3 flex flex-wrap items-start justify-between gap-2 border-t border-slate-200 pt-2"
			>
				<div
					class="min-w-0 flex-1 space-y-0.5 text-xs text-slate-700"
					data-field="directory-status"
				>
					<Show when={props.directory.status()}>
						{(current) => (
							<For each={current().markets}>
								{(entry) => (
									<p data-market={entry.market}>
										{directoryStatusLine(entry, model())}{" "}
										<span>
											{m().sourceColumn}:{" "}
											<SafeLink url={entry.sourceUrl}>{entry.publisher}</SafeLink>
										</span>
									</p>
								)}
							</For>
						)}
					</Show>
					<output class="block">
						{props.directory.queuedByOwner() ? m().directoryQueued : ""}
					</output>
				</div>
				<button
					type="button"
					class={BUTTON}
					disabled={props.directory.queuing() || allDirectoryRunsActive()}
					onClick={() => props.directory.update()}
				>
					{m().updateStockList}
				</button>
			</div>
			<Show when={props.directory.failure()}>
				{(current) => (
					<div class="mt-2">
						<ErrorNotice
							failure={current().error}
							title={current().action === "load" ? m().directoryLoadFailed : m().directoryNotQueued}
							onRetry={current().action === "load" ? () => props.directory.start() : undefined}
						/>
					</div>
				)}
			</Show>
		</Section>
	);
}
