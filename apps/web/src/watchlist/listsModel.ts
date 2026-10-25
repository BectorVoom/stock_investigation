import {
	EARNINGS_LIMITS,
	type HomeCapacityProblem,
	MARKET_LIMITS,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistList,
	type WatchlistResponse,
	type WatchlistStock,
	WIDGET_LIMITS,
	watchlistListTitleSchema,
} from "@research/contracts";
import type { MessagesOf } from "@research/i18n";
import type { ApiFailure } from "../api/http.ts";
import type { watchlistListsMessages } from "./watchlistLists.messages.ts";

/** The Lists section's words in the current language (the caller passes `m()`). */
export type ListsText = MessagesOf<typeof watchlistListsMessages>;

/**
 * Pure helpers of the Watchlist page's Lists section (ADR-0040 §7): no DOM,
 * no fetch. The bounds are the contract's (`WATCHLIST_LISTS_LIMITS`, the
 * domain's by reference), never restated.
 */

/** The trimmed title when the contract takes it, else null. */
export function validListTitle(text: string): string | null {
	const parsed = watchlistListTitleSchema.safeParse(text);
	return parsed.success ? parsed.data : null;
}

/** Whether the owner already has the most lists there can be. */
export function listsFull(watchlist: WatchlistResponse): boolean {
	return watchlist.lists.length >= WATCHLIST_LISTS_LIMITS.maxLists;
}

/** Whether a list already holds the most stocks a list can. */
export function listFull(list: WatchlistList): boolean {
	return list.stockIds.length >= WATCHLIST_LISTS_LIMITS.maxStocksPerList;
}

/** How many more stocks the list takes. */
export function listRoom(list: WatchlistList): number {
	return Math.max(0, WATCHLIST_LISTS_LIMITS.maxStocksPerList - list.stockIds.length);
}

/** The watchlist's stocks not in the list yet, in watchlist order (the Add stock dialog's checkboxes). */
export function stocksOutsideList(
	watchlist: WatchlistResponse,
	list: WatchlistList,
): WatchlistStock[] {
	const inList = new Set(list.stockIds);
	return watchlist.stocks.filter((stock) => !inList.has(stock.stockId));
}

/** The titles of the lists each stock is in, in list order (the stock table's "In lists: …"). */
export function listTitlesByStock(
	lists: readonly WatchlistList[],
): ReadonlyMap<string, readonly string[]> {
	const titles = new Map<string, string[]>();
	for (const list of lists) {
		for (const stockId of list.stockIds) {
			const current = titles.get(stockId);
			if (current === undefined) titles.set(stockId, [list.title]);
			else current.push(list.title);
		}
	}
	return titles;
}

/**
 * The sentence for a refused list write, by its stable reason (ADR-0040 §2):
 * a full list, too many lists, a full watchlist, or a list or stock that is
 * gone; null for any other failure, whose code and message the notice shows.
 */
export function listFailureReason(failure: ApiFailure, text: ListsText): string | null {
	switch (failure.detail) {
		case "WATCHLIST_LIST_FULL":
			return text.listFull(WATCHLIST_LISTS_LIMITS.maxStocksPerList);
		case "WATCHLIST_LISTS_FULL":
			return text.listsFull(WATCHLIST_LISTS_LIMITS.maxLists);
		case "WATCHLIST_FULL":
			return text.watchlistFull(EARNINGS_LIMITS.maxStocks);
	}
	return failure.code === "NOT_FOUND" ? text.changedElsewhere : null;
}

/** Home's bound that refused Show on Home, in words. */
export function homeFullText(problem: HomeCapacityProblem, text: ListsText): string {
	switch (problem.code) {
		case "TOO_MANY_WIDGETS":
			return text.homeTooManyWidgets(MARKET_LIMITS.maxWidgets);
		case "TOO_MANY_SERIES":
			return text.homeTooManySeries(MARKET_LIMITS.maxSeries);
		case "DASHBOARD_TOO_LARGE":
			return text.homeTooLarge(Math.floor(WIDGET_LIMITS.maxContentBytes / 1000));
	}
}
