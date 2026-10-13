import { err, ok, type Result } from "../result.ts";

export type WatchMarket = "US" | "JP";

export type StockIdError = "INVALID_STOCK_ID";

const US_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
const JP_CODE_PATTERN = /^[0-9][0-9A-Z]{3}$/;

/** The per-market symbol shapes, exported so contracts can pre-validate without drifting. */
export const STOCK_SYMBOL_PATTERNS = {
	US: US_SYMBOL_PATTERN,
	JP: JP_CODE_PATTERN,
} as const;

/**
 * Splits "<market lowercased>:<symbol>" and checks the market-specific symbol
 * shape: `us:AAPL`, `jp:7203`. US symbols are 1..10 uppercase letters, digits,
 * dots or dashes starting with a letter; JP codes are four characters starting
 * with a digit (e.g. `7203`, `130A`).
 */
export function parseStockId(
	value: string,
): Result<{ readonly market: WatchMarket; readonly symbol: string }, StockIdError> {
	const separator = value.indexOf(":");
	if (separator <= 0) return err("INVALID_STOCK_ID");
	const market = value.slice(0, separator);
	const symbol = value.slice(separator + 1);
	if (market === "us") {
		return US_SYMBOL_PATTERN.test(symbol) ? ok({ market: "US", symbol }) : err("INVALID_STOCK_ID");
	}
	if (market === "jp") {
		return JP_CODE_PATTERN.test(symbol) ? ok({ market: "JP", symbol }) : err("INVALID_STOCK_ID");
	}
	return err("INVALID_STOCK_ID");
}

export function formatStockId(market: WatchMarket, symbol: string): string {
	return `${market.toLowerCase()}:${symbol}`;
}
