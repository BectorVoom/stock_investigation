import type { WatchMarket } from "./stockId.ts";

export type EarningsSourceId = "finnhub" | "jpx";

/**
 * The single definition of every watchlist/earnings bound (SPEC section 1).
 * Contracts builds `EARNINGS_LIMITS` from this object, so the two can never
 * drift. `horizonDays` is the refresh window `[today, today + 185 days]`.
 */
export const WATCHLIST_LIMITS = {
	maxStocks: 50,
	maxEventsPerStock: 8,
	horizonDays: 185,
} as const;

/**
 * The ONE market -> earnings-source mapping (ARCH-006): US listings come from
 * Finnhub, Japanese listings from JPX's published schedule. No scattered
 * conditionals elsewhere.
 */
export const EARNINGS_SOURCE_BY_MARKET: { readonly [M in WatchMarket]: EarningsSourceId } = {
	US: "finnhub",
	JP: "jpx",
};

/**
 * Provider adapter configuration. Widget and calendar read models use the
 * persisted earnings_sources reference rows instead (ADR-0043).
 */
export const EARNINGS_SOURCE_INFO: {
	readonly [S in EarningsSourceId]: { readonly publisher: string; readonly sourceUrl: string };
} = {
	finnhub: { publisher: "Finnhub", sourceUrl: "https://finnhub.io/" },
	jpx: {
		publisher: "Japan Exchange Group (JPX)",
		sourceUrl: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
	},
};
