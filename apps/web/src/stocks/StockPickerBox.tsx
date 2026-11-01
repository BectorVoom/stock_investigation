import type { StockDirectoryHit, WatchMarket } from "@research/contracts";
import { createMemo, createSignal, type JSX, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { StockSearchBox } from "../watchlist/StockSearchBox.tsx";
import { createStockSearch } from "../watchlist/stockSearch.ts";
import { type StockSearchState, storedDirectoryMarkets } from "../watchlist/watchlistModel.ts";
import { openableSearchState } from "./stocksModel.ts";

/**
 * The stock-directory search box (ADR-0034) for picking any listed stock —
 * the Stocks page's "Find a stock" (ADR-0050 §1) and the financial widgets'
 * add dialog (ADR-0058 §6). Every hit can be picked, registered or not; a
 * pick clears the box. It reads nothing until the owner types: the stored
 * lists' status, which explains an empty answer, is read once on the first
 * search, and a failed read only leaves that explanation out (the search
 * itself still runs). It never queues a stock list download.
 */
export function StockPickerBox(props: {
	readonly api: ApiClient;
	readonly id: string;
	/** Enter with no active option submits the surrounding form (something is picked). */
	readonly canSubmit?: boolean;
	readonly onPick: (hit: StockDirectoryHit) => void;
}): JSX.Element {
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
	/** Memoised: the box reads its state many times per answer, and each read would copy the hits. */
	const openable = createMemo(() => openableSearchState(searchState()));
	const onQueryInput = (text: string): void => {
		setQuery(text);
		if (text.trim() !== "") readStatusOnce();
		search.input(text);
	};

	return (
		<StockSearchBox
			id={props.id}
			query={query()}
			state={openable()}
			storedMarkets={storedMarkets()}
			canSubmit={props.canSubmit ?? false}
			onQueryInput={onQueryInput}
			onPick={(hit) => {
				onQueryInput("");
				props.onPick(hit);
			}}
			onClear={() => onQueryInput("")}
		/>
	);
}
