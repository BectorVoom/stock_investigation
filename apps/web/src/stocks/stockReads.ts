import type { StockPricesResponse, StockProfileResponse } from "@research/contracts";
import type { ApiClient } from "../api/client.ts";
import { createReadCache, createReadEntry, type ReadEntry } from "../lib/readCache.ts";

/**
 * The Stocks page's shared per-stock reads (ADR-0049 §3): one entry per
 * (client, stock), kept for the visit, re-checked only while shown.
 * Prices change at most a few times a day (a market refresh) and the
 * directory once a week, so a shown read re-checks every five minutes; an
 * unchanged answer is a 304.
 */
export const STOCK_RECHECK_MS = 5 * 60_000;

/** A read answered this recently is shown again without a request (a tab switched back to). */
export const STOCK_FRESH_MS = 60_000;

/** Stocks whose reads one visit keeps (beyond the shown ones). */
const MAX_KEPT_STOCKS = 32;

const profiles = createReadCache<StockProfileResponse>(MAX_KEPT_STOCKS);
const prices = createReadCache<StockPricesResponse>(MAX_KEPT_STOCKS);

/** The stock's stored directory entry (Company tab, detail heading). */
export function stockProfileEntryFor(
	api: ApiClient,
	stockId: string,
): ReadEntry<StockProfileResponse> {
	return profiles.entry(api, stockId, () =>
		createReadEntry((etag) => api.getStockProfile(stockId, etag), {
			recheckMs: STOCK_RECHECK_MS,
			freshMs: STOCK_FRESH_MS,
		}),
	);
}

/** The stock's stored price series (Chart tab). */
export function stockPricesEntryFor(
	api: ApiClient,
	stockId: string,
): ReadEntry<StockPricesResponse> {
	return prices.entry(api, stockId, () =>
		createReadEntry((etag) => api.getStockPrices(stockId, etag), {
			recheckMs: STOCK_RECHECK_MS,
			freshMs: STOCK_FRESH_MS,
		}),
	);
}
