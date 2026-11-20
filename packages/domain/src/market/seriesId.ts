import { err, ok, type Result } from "../result.ts";

export type MarketProviderId = "fred" | "twelve-data" | "materials" | "jpx";

const FRED_SYMBOL_PATTERN = /^[A-Z0-9]{1,25}$/;
const TWELVE_DATA_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9./-]{0,19}(:[A-Z0-9]{2,10})?$/;

/**
 * The JPX market statistics a `jpx:` series id may name (ADR-0076): the
 * daily short-selling ratio and the weekly margin buying balance (value) and
 * margin ratio, each read from JPX's published files. A closed list: JPX has
 * no symbol space of its own.
 */
export const JPX_MARKET_SYMBOLS = [
	"SHORT_SELLING_RATIO",
	"MARGIN_BUYING_VALUE",
	"MARGIN_RATIO",
] as const;
export type JpxMarketSymbol = (typeof JPX_MARKET_SYMBOLS)[number];

/** True for one of `JPX_MARKET_SYMBOLS` (exact, case-sensitive). */
export function isJpxMarketSymbol(symbol: string): symbol is JpxMarketSymbol {
	return (JPX_MARKET_SYMBOLS as readonly string[]).includes(symbol);
}

export type SeriesIdError = "INVALID_SERIES_ID";

/** Splits "<provider>:<symbol>" and checks the provider-specific symbol shape. */
export function parseMarketSeriesId(
	value: string,
): Result<{ readonly provider: MarketProviderId; readonly symbol: string }, SeriesIdError> {
	const separator = value.indexOf(":");
	if (separator <= 0) return err("INVALID_SERIES_ID");
	const provider = value.slice(0, separator);
	const symbol = value.slice(separator + 1);
	if (provider === "materials") {
		// Compare the complete match: JS `$` alone also accepts a final newline.
		return FRED_SYMBOL_PATTERN.exec(symbol)?.[0] === symbol
			? ok({ provider, symbol })
			: err("INVALID_SERIES_ID");
	}
	if (provider === "fred") {
		return FRED_SYMBOL_PATTERN.test(symbol) ? ok({ provider, symbol }) : err("INVALID_SERIES_ID");
	}
	if (provider === "twelve-data") {
		return TWELVE_DATA_SYMBOL_PATTERN.test(symbol)
			? ok({ provider, symbol })
			: err("INVALID_SERIES_ID");
	}
	if (provider === "jpx") {
		return isJpxMarketSymbol(symbol) ? ok({ provider, symbol }) : err("INVALID_SERIES_ID");
	}
	return err("INVALID_SERIES_ID");
}

export function formatMarketSeriesId(provider: MarketProviderId, symbol: string): string {
	return `${provider}:${symbol}`;
}
