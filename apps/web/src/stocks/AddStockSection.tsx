import {
	EQUITY_FINANCIAL_LIMITS,
	type StockDirectoryHit,
	type WatchMarket,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { BUTTON, BUTTON_PRIMARY, ErrorNotice, Section } from "../components/ui.tsx";
import { StockSearchBox } from "../watchlist/StockSearchBox.tsx";
import type { StockDirectoryState } from "../watchlist/stockDirectory.ts";
import type { StockSearch } from "../watchlist/stockSearch.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import {
	type AddTarget,
	addTargetProblem,
	addTargetText,
	directoryStatusLine,
	resolveAddTarget,
	type StockSearchState,
	selectedStockText,
	storedDirectoryMarkets,
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
 * "Add a stock" (FR-018, ADR-0034, ADR-0049 §2): one search box that takes a
 * company name or a symbol (`resolveAddTarget` says what "Add stock" adds:
 * a picked hit, the hit whose symbol was typed, or a typed symbol whose
 * market's list is not stored), the "Also sync annual financial statements"
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
	const [query, setQuery] = createSignal("");
	const [picked, setPicked] = createSignal<StockDirectoryHit | null>(null);
	const [alsoSync, setAlsoSync] = createSignal(true);
	const problemsId = "watchlist-add-problems";
	const addTargetId = "watchlist-add-target";
	const alsoSyncId = createUniqueId();
	const limitId = createUniqueId();

	const target = (): AddTarget =>
		resolveAddTarget({
			query: query(),
			picked: picked(),
			state: props.searchState(),
			storedMarkets: storedDirectoryMarkets(props.directory.status()),
		});
	/** What "Add stock" would add, or null. */
	const stock = (): { readonly market: WatchMarket; readonly symbol: string } | null => {
		const current = target();
		if (current.kind === "hit") return current.hit;
		return current.kind === "symbol" ? current : null;
	};
	const problem = () => addTargetProblem(target(), model());
	/** The stored stock "Add stock" adds ("Selected: …"), picked or typed exactly. */
	const selectedText = (): string => {
		const current = target();
		return current.kind === "hit" ? selectedStockText(current.hit, locale(), model()) : "";
	};
	/**
	 * Editing the search text starts a new choice: the pick is cleared, so
	 * "Add stock" never adds a stock other than the one the form shows.
	 */
	const onQueryInput = (text: string): void => {
		setQuery(text);
		setPicked(null);
		props.search.input(text);
	};
	const submit = async (): Promise<void> => {
		const chosen = stock();
		if (chosen === null || props.busy) return;
		const added = await props.onAdd({
			market: chosen.market,
			symbol: chosen.symbol,
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
			<Show when={problem()}>
				{(text) => (
					<div class="mt-2 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800">
						<p class="font-medium">{m().toAddThisStock}</p>
						<ul aria-label={m().beforeYouCanAdd} id={problemsId} class="list-disc space-y-0.5 pl-5">
							<li>{text()}</li>
						</ul>
					</div>
				)}
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
					canSubmit={target().kind === "hit"}
					onQueryInput={onQueryInput}
					onPick={setPicked}
					onClear={() => onQueryInput("")}
				/>
				<output
					data-field="selected-stock"
					class="block text-sm font-medium text-slate-900 empty:hidden"
				>
					{selectedText()}
				</output>
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
						disabled={props.busy || stock() === null}
						aria-describedby={problem() === null ? addTargetId : `${problemsId} ${addTargetId}`}
					>
						{m().addStock}
					</button>
					<output id={addTargetId} data-field="add-target" class="text-sm text-slate-700">
						{(() => {
							const chosen = stock();
							return chosen === null ? "" : addTargetText(chosen.market, chosen.symbol, model());
						})()}
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
