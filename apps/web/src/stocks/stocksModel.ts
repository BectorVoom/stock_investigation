import {
	parseStockId,
	type WatchlistList,
	type WatchlistStock,
	type WatchMarket,
} from "@research/contracts";
import type { Locale } from "@research/i18n";
import { listFull } from "../watchlist/listsModel.ts";
import type { StockSearchState } from "../watchlist/watchlistModel.ts";
import type { SelectedStock } from "./stockTabs.ts";

/**
 * Pure helpers of the Stocks page (ADR-0049 §2): the registered stocks are
 * the Watchlist's, keyed by stock id. Tracked companies add no rows: the
 * server tracks every stock in the stored stock lists (ADR-0058 §3), so a
 * company says nothing about what the owner follows.
 */

/** One registered stock: a stock on the Watchlist. */
export interface StockRow {
	readonly stockId: string;
	readonly market: WatchMarket;
	readonly symbol: string;
	/** The Watchlist's stored name; null while it knows none. */
	readonly name: string | null;
	readonly watchlist: WatchlistStock;
}

/**
 * The Watchlist's stocks in the order they were added, one row per stock
 * id (the first wins). One pass over at most the Watchlist limit.
 */
export function watchlistRows(watchlist: readonly WatchlistStock[]): readonly StockRow[] {
	const rows: StockRow[] = [];
	const seen = new Set<string>();
	for (const stock of watchlist) {
		if (seen.has(stock.stockId)) continue;
		seen.add(stock.stockId);
		rows.push({
			stockId: stock.stockId,
			market: stock.market,
			symbol: stock.symbol,
			name: stock.name ?? null,
			watchlist: stock,
		});
	}
	return rows;
}

/**
 * The selected stock as the tabs see it (ADR-0049 §3 rule 5): its row when
 * it is on the Watchlist, else the bare stock the URL names (a valid stock
 * id the Watchlist does not hold — the tabs then say what is stored). Null
 * for an id that is not a stock id.
 */
export function selectedStockFor(
	stockId: string,
	row: StockRow | undefined,
	listTitles: readonly string[],
): SelectedStock | null {
	if (row !== undefined) {
		return {
			stockId: row.stockId,
			market: row.market,
			symbol: row.symbol,
			name: row.name,
			watchlist: row.watchlist,
			listTitles,
		};
	}
	const parsed = parseStockId(stockId);
	if (parsed === null) return null;
	return {
		stockId,
		market: parsed.market,
		symbol: parsed.symbol,
		name: null,
		watchlist: null,
		listTitles,
	};
}

/**
 * The heading's name: the page's, else the stored directory's (the UI
 * language's first), else the stored company's (a stock that left the
 * stock list keeps the name its statements were filed under).
 */
export function detailName(
	pageName: string | null,
	directory: { readonly name: string; readonly localName: string | null } | null,
	companyName: string | null,
	locale: Locale,
): string | null {
	if (pageName !== null) return pageName;
	if (directory === null) return companyName;
	return locale === "ja" ? (directory.localName ?? directory.name) : directory.name;
}

/**
 * The Stocks page's search opens stocks rather than adding them (ADR-0050
 * §1): every hit can be picked, registered or not, so the box is given
 * the hits with `registered` cleared. The same state object comes back
 * when nothing needs clearing (idle, failed, or no registered hit).
 */
export function openableSearchState(state: StockSearchState): StockSearchState {
	if (state.kind !== "searching" && state.kind !== "results") return state;
	if (!state.hits.some((hit) => hit.registered)) return state;
	return { ...state, hits: state.hits.map((hit) => ({ ...hit, registered: false })) };
}

/** How one list stands for the shown stock in the Add to Watchlist dialog (ADR-0050 §2). */
export type ListChoiceState = "available" | "member" | "full";

export interface ListChoice {
	readonly list: WatchlistList;
	readonly state: ListChoiceState;
}

/**
 * Every list, in the owner's order, with whether the stock can be added to
 * it: already in it ("member"), at the list's limit ("full"), or
 * "available". One pass over each list's stock ids.
 */
export function listChoicesFor(lists: readonly WatchlistList[], stockId: string): ListChoice[] {
	return lists.map((list) => ({
		list,
		state: list.stockIds.includes(stockId) ? "member" : listFull(list) ? "full" : "available",
	}));
}

/**
 * Whether the detail's add button has anything to do: a stock that is not
 * on the watchlist can always be put there; one that is needs a list that
 * can still take it.
 */
export function canAddFromDetail(onWatchlist: boolean, choices: readonly ListChoice[]): boolean {
	return !onWatchlist || choices.some((choice) => choice.state === "available");
}
