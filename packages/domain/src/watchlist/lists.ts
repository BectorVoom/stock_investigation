import {
	DASHBOARD_LIMITS,
	type DashboardWidget,
	distinctDashboardSeriesIds,
} from "../market/dashboard.ts";
import { formatMarketSeriesId } from "../market/seriesId.ts";
import type { WatchMarket } from "./stockId.ts";

/**
 * The single definition of every watchlist-list bound (ADR-0040). Contracts
 * builds its limits from this object, so the two can never drift. A list
 * holds at most as many stocks as one stock table shows, so one
 * `watchlist-prices` widget shows every stock of its list.
 */
export const WATCHLIST_LIST_LIMITS = {
	maxLists: 20,
	maxStocksPerList: DASHBOARD_LIMITS.maxTableSeries,
	maxTitleChars: 80,
} as const;

/**
 * Twelve Data's exchange code for a Tokyo Stock Exchange listing: Japanese
 * codes are not unique on their own across Twelve Data's exchanges.
 */
const JP_PRICE_EXCHANGE = "JPX";

/**
 * The ONE stock → price series mapping (ADR-0040 §3): a watchlist stock's
 * daily closes are the Twelve Data series of its symbol (`twelve-data:AAPL`),
 * on JPX for a Japanese code (`twelve-data:7203:JPX`). Every layer that
 * resolves a list to series calls this; nothing spells the format again.
 */
export function stockPriceSeriesId(market: WatchMarket, symbol: string): string {
	return formatMarketSeriesId(
		"twelve-data",
		market === "US" ? symbol : `${symbol}:${JP_PRICE_EXCHANGE}`,
	);
}

/** Distinct list ids a page's `watchlist-prices` widgets name, first appearance first. */
export function watchlistListIdsOf(widgets: readonly DashboardWidget[]): string[] {
	const ids = new Set<string>();
	for (const widget of widgets) {
		if (widget.type === "watchlist-prices") ids.add(widget.listId);
	}
	return [...ids];
}

/**
 * The market series one page (Home or one notebook) shows, in order
 * (ADR-0040 §4): first every series a widget names itself (the domain's
 * `distinctDashboardSeriesIds`), then, for each `watchlist-prices` widget in
 * widget order, its list's series in list order. Each id appears once; the
 * result stops at `limit`, so a page never shows more than
 * `DASHBOARD_LIMITS.maxSeries` series. Named series come first so that
 * adding a list widget, or a stock to a list, can never push a series out of
 * a widget that names it — only list rows past the limit go unshown.
 *
 * `listSeries` answers a list's series ids in list order, or `undefined` for
 * a list that does not exist (deleted): such a widget contributes nothing.
 * The API resolves lists from storage, the web from the `/watchlist`
 * response, both through `stockPriceSeriesId`, so server and client compute
 * the same page and the widget can say which of its rows are past the limit.
 */
export function pageSeriesIds(
	widgets: readonly DashboardWidget[],
	listSeries: (listId: string) => readonly string[] | undefined,
	limit: number = DASHBOARD_LIMITS.maxSeries,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (seriesId: string): boolean => {
		if (out.length >= limit) return false;
		if (!seen.has(seriesId)) {
			seen.add(seriesId);
			out.push(seriesId);
		}
		return true;
	};
	for (const seriesId of distinctDashboardSeriesIds(widgets)) {
		if (!push(seriesId)) return out;
	}
	for (const listId of watchlistListIdsOf(widgets)) {
		for (const seriesId of listSeries(listId) ?? []) {
			if (!push(seriesId)) return out;
		}
	}
	return out;
}
