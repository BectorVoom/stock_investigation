import { describe, expect, it } from "vitest";
import { EARNINGS_SOURCE_BY_MARKET, WATCHLIST_LIMITS } from "../../src/watchlist/limits.ts";

describe("watchlist limits and source mapping", () => {
	it("pins the bounds from SPEC section 1", () => {
		expect(WATCHLIST_LIMITS.maxStocks).toBe(50);
		expect(WATCHLIST_LIMITS.maxEventsPerStock).toBe(8);
		expect(WATCHLIST_LIMITS.horizonDays).toBe(185);
	});

	it("maps each market to exactly one source", () => {
		expect(EARNINGS_SOURCE_BY_MARKET).toEqual({ US: "finnhub", JP: "jpx" });
	});
});
