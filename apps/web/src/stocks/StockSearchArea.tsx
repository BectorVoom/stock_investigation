import type { StockDirectoryHit, WatchMarket } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createSignal, type JSX, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { Section } from "../components/ui.tsx";
import { StockSearchBox } from "../watchlist/StockSearchBox.tsx";
import { createStockSearch } from "../watchlist/stockSearch.ts";
import { type StockSearchState, storedDirectoryMarkets } from "../watchlist/watchlistModel.ts";
import { stocksMessages } from "./stocks.messages.ts";
import { openableSearchState } from "./stocksModel.ts";

/** The search box's DOM id on the Stocks page. */
export const STOCKS_SEARCH_ID = "stocks-search";

/**
 * "Find a stock" (ADR-0050 §1): the stock-directory search box (ADR-0034)
 * on the Stocks page. Picking a hit opens that stock — registered or not —
 * and clears the box; nothing is added. The page reads nothing until the
 * owner types: the stored lists' status, which explains an empty answer,
 * is read once on the first search, and a failed read only leaves that
 * explanation out (the search itself still runs). It never queues a stock
 * list download.
 */
export function StockSearchArea(props: {
	readonly api: ApiClient;
	readonly onOpen: (hit: StockDirectoryHit) => void;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const [query, setQuery] = createSignal("");
	const [searchState, setSearchState] = createSignal<StockSearchState>({ kind: "idle" });
	const [storedMarkets, setStoredMarkets] = createSignal<readonly WatchMarket[] | null>(null);
	let disposed = false;
	let statusRead = false;
	const search = createStockSearch({
		search: (text, signal) => props.api.searchStockDirectory({ q: text }, signal),
		onState: setSearchState,
	});
	onCleanup(() => {
		disposed = true;
		search.dispose();
	});
	const readStatusOnce = (): void => {
		if (statusRead) return;
		statusRead = true;
		void props.api.getStockDirectory().then((result) => {
			if (!disposed && result.ok) setStoredMarkets(storedDirectoryMarkets(result.value));
		});
	};
	const onQueryInput = (text: string): void => {
		setQuery(text);
		if (text.trim() !== "") readStatusOnce();
		search.input(text);
	};

	return (
		<Section title={s().searchTitle}>
			<p class="text-xs text-slate-700">{s().searchHint}</p>
			<div class="mt-2 max-w-xl" data-field="stocks-search">
				<StockSearchBox
					id={STOCKS_SEARCH_ID}
					query={query()}
					state={openableSearchState(searchState())}
					storedMarkets={storedMarkets()}
					canSubmit={false}
					onQueryInput={onQueryInput}
					onPick={(hit) => {
						onQueryInput("");
						props.onOpen(hit);
					}}
					onClear={() => onQueryInput("")}
				/>
			</div>
		</Section>
	);
}
