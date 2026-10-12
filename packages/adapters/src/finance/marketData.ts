/**
 * Source-neutral ports for market data that V1 has NO licensed, verified
 * source for (ARCHITECTURE section 13: "use source-neutral ports and mark
 * uncovered metrics unavailable").
 *
 * The `Unconfigured*` implementations are the only ones that exist. They
 * perform no network access and return a typed "unavailable" with a reason
 * that is carried verbatim into `unavailableReason` on the stored record
 * (DATA-011). Nothing here scrapes a site or produces a number.
 *
 * Why nothing is wired in:
 *  - share prices: exchange/vendor market data is licensed; no free source
 *    with redistribution-compatible terms has been verified for this project;
 *  - US short interest: FINRA publishes it, but its data terms and API access
 *    have not been reviewed for this use;
 *  - Japan margin balances: JPX publishes statistics, with the same caveat.
 */
import type {
	JpMarginBalanceFigures,
	PriceQuote,
	Result,
	UsShortInterestFigures,
} from "@research/domain";
import { err } from "@research/domain";

export interface MarketDataUnavailable {
	readonly code: "SOURCE_NOT_CONFIGURED" | "NO_DATA" | "SOURCE_FAILED";
	/** Shown to the owner and stored as `unavailableReason`; at most 300 characters. */
	readonly reason: string;
}

/** Where an available figure came from, sufficient to build an Evidence record. */
export interface MarketDataProvenance {
	readonly sourceUrl: string;
	readonly title: string;
	readonly publisher: string;
	readonly publishedAt: string | null;
	/** The retrieved text the figure can be checked against. */
	readonly retrievedText: string;
}

export interface SharePriceReport {
	readonly quote: PriceQuote;
	readonly provenance: MarketDataProvenance;
}

export interface SharePriceSource {
	latestQuote(query: {
		readonly securityId: string;
		readonly ticker: string;
		readonly exchange: string;
	}): Promise<Result<SharePriceReport, MarketDataUnavailable>>;
}

export interface UsShortInterestReport {
	readonly figures: UsShortInterestFigures;
	/** Settlement date the short interest is reported as of (YYYY-MM-DD). */
	readonly settlementDate: string;
	readonly disseminatedAt: string | null;
	readonly provenance: MarketDataProvenance;
}

export interface UsShortInterestSource {
	latestShortInterest(query: {
		readonly ticker: string;
	}): Promise<Result<UsShortInterestReport, MarketDataUnavailable>>;
}

export interface JpMarginBalanceReport {
	readonly figures: JpMarginBalanceFigures;
	/** Date the balances are reported as of (YYYY-MM-DD). */
	readonly asOfDate: string;
	readonly disseminatedAt: string | null;
	readonly provenance: MarketDataProvenance;
}

export interface JpMarginBalanceSource {
	latestMarginBalance(query: {
		/** Four-character securities code, e.g. "7203". */
		readonly code: string;
	}): Promise<Result<JpMarginBalanceReport, MarketDataUnavailable>>;
}

export const NO_SHARE_PRICE_SOURCE_REASON =
	"No licensed market-data source is configured, so no share price is available. A price-based ratio cannot be computed and is reported unavailable rather than estimated.";
export const NO_US_SHORT_INTEREST_SOURCE_REASON =
	"No US short-interest source is configured. FINRA publishes equity short interest, but no licensed, verified feed is connected to this workspace.";
export const NO_JP_MARGIN_BALANCE_SOURCE_REASON =
	"No Japanese margin-balance source is configured. JPX publishes margin trading statistics, but no licensed, verified feed is connected to this workspace.";

function notConfigured(reason: string): Result<never, MarketDataUnavailable> {
	return err({ code: "SOURCE_NOT_CONFIGURED", reason });
}

export const unconfiguredSharePriceSource: SharePriceSource = {
	latestQuote: async () => notConfigured(NO_SHARE_PRICE_SOURCE_REASON),
};

export const unconfiguredUsShortInterestSource: UsShortInterestSource = {
	latestShortInterest: async () => notConfigured(NO_US_SHORT_INTEREST_SOURCE_REASON),
};

export const unconfiguredJpMarginBalanceSource: JpMarginBalanceSource = {
	latestMarginBalance: async () => notConfigured(NO_JP_MARGIN_BALANCE_SOURCE_REASON),
};
