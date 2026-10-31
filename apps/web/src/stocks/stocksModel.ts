import {
	type EquityCompanyView,
	formatStockId,
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
 * Pure helpers of the Stocks page (ADR-0049 §2): the one stock list over the
 * watchlist and the companies whose statements are synced, keyed by stock id.
 */

/** One row of the Stocks list: a stock on the watchlist, tracked for statements, or both. */
export interface StockRow {
	readonly stockId: string;
	readonly market: WatchMarket;
	readonly symbol: string;
	/** The best stored name: the watchlist's, else the company's; null while neither knows one. */
	readonly name: string | null;
	readonly watchlist: WatchlistStock | null;
	readonly company: EquityCompanyView | null;
}

/**
 * The union of the watchlist's stocks (in the order they were added) and the
 * tracked companies that are not on the watchlist (in tracking order after
 * them), one row per stock id. A company that is no longer tracked is not a
 * row of its own and does not join a watchlist row: its statements are not
 * synced (ADR-0048 §7 keeps its data, the Stocks page shows it as untracked).
 * One pass over each input (a map from stock id to company), so the largest
 * list — the watchlist limit plus the tracking limit — costs microseconds.
 */
export function mergeStockRows(
	watchlist: readonly WatchlistStock[],
	companies: readonly EquityCompanyView[],
): readonly StockRow[] {
	const companyById = new Map<string, EquityCompanyView>();
	for (const company of companies) {
		if (!company.tracked) continue;
		const stockId = formatStockId(company.market, company.symbol);
		if (!companyById.has(stockId)) companyById.set(stockId, company);
	}
	const rows: StockRow[] = [];
	const seen = new Set<string>();
	for (const stock of watchlist) {
		if (seen.has(stock.stockId)) continue;
		seen.add(stock.stockId);
		const company = companyById.get(stock.stockId) ?? null;
		rows.push({
			stockId: stock.stockId,
			market: stock.market,
			symbol: stock.symbol,
			name: stock.name ?? company?.name ?? null,
			watchlist: stock,
			company,
		});
	}
	for (const [stockId, company] of companyById) {
		if (seen.has(stockId)) continue;
		seen.add(stockId);
		rows.push({
			stockId,
			market: company.market,
			symbol: company.symbol,
			name: company.name,
			watchlist: null,
			company,
		});
	}
	return rows;
}

/**
 * The selected stock as the tabs see it (ADR-0049 §3 rule 5): its row when
 * the page lists it, else the bare stock the URL names (a valid stock id
 * neither list holds — the tabs then say what is stored). Null for an id
 * that is not a stock id.
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
			company: row.company,
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
		company: null,
		listTitles,
	};
}

/** The heading's name: the page's, else the stored directory's (the UI language's first). */
export function detailName(
	pageName: string | null,
	directory: { readonly name: string; readonly localName: string | null } | null,
	locale: Locale,
): string | null {
	if (pageName !== null) return pageName;
	if (directory === null) return null;
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
