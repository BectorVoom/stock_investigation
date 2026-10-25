import type {
	WatchlistList,
	WatchlistResponse,
	WatchlistStock,
	WidgetCore,
} from "@research/contracts";
import { pageSeriesIds, stockPriceSeriesId } from "@research/domain";

/**
 * The page-series rule as the web applies it (ADR-0040 §4): the domain's
 * `pageSeriesIds` over the page's widgets, with each list resolved from the
 * `/watchlist` response through `stockPriceSeriesId` — the same function
 * and the same mapping the API applies, so the client knows which series
 * the page is served and which list rows are past the limit. Nothing here
 * restates the rule.
 */

/** Whether a page widget reads the watchlist: the earnings calendar or a Watchlist prices widget. */
export function readsWatchlist(widget: { readonly type: string }): boolean {
	return widget.type === "earnings-calendar" || widget.type === "watchlist-prices";
}

/** Whether a page holds a Watchlist prices widget (its series depend on the lists). */
export function hasListWidget(widgets: readonly { readonly type: string }[]): boolean {
	return widgets.some((widget) => widget.type === "watchlist-prices");
}

/** One list's stocks, in list order (every member is a watchlist stock: the contract checks it). */
export function listStocks(
	list: WatchlistList,
	stocks: ReadonlyMap<string, WatchlistStock>,
): WatchlistStock[] {
	return list.stockIds.flatMap((stockId) => {
		const stock = stocks.get(stockId);
		return stock === undefined ? [] : [stock];
	});
}

/** The watchlist's stocks by id. */
export function stocksById(watchlist: WatchlistResponse): ReadonlyMap<string, WatchlistStock> {
	return new Map(watchlist.stocks.map((stock) => [stock.stockId, stock]));
}

/**
 * A list's price series, in list order, or `undefined` for a list the
 * watchlist does not hold (deleted) — the lookup `pageSeriesIds` takes.
 * With no watchlist loaded every list is unknown, so a page then counts
 * only the series its widgets name.
 */
export function listSeriesLookup(
	watchlist: WatchlistResponse | null,
): (listId: string) => readonly string[] | undefined {
	if (watchlist === null) return () => undefined;
	const stocks = stocksById(watchlist);
	const lists = new Map(watchlist.lists.map((list) => [list.listId, list]));
	return (listId) => {
		const list = lists.get(listId);
		return list === undefined
			? undefined
			: listStocks(list, stocks).map((stock) => stockPriceSeriesId(stock.market, stock.symbol));
	};
}

/** The series the page is served, in order: named series first, then the lists' (ADR-0040 §4). */
export function webPageSeriesIds(
	widgets: readonly WidgetCore[],
	watchlist: WatchlistResponse | null,
): string[] {
	return pageSeriesIds(widgets, listSeriesLookup(watchlist));
}
