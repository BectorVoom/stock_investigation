import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatStockId, parseStockId } from "../../src/watchlist/stockId.ts";
import { expectErr, expectOk } from "../support/result.ts";
import "../support/seededProperties.ts";

describe("parseStockId", () => {
	it("parses US symbols", () => {
		expect(expectOk(parseStockId("us:AAPL"))).toEqual({ market: "US", symbol: "AAPL" });
		expect(expectOk(parseStockId("us:BRK.B"))).toEqual({ market: "US", symbol: "BRK.B" });
		expect(expectOk(parseStockId("us:SPY-1"))).toEqual({ market: "US", symbol: "SPY-1" });
	});

	it("parses JP codes", () => {
		expect(expectOk(parseStockId("jp:7203"))).toEqual({ market: "JP", symbol: "7203" });
		expect(expectOk(parseStockId("jp:130A"))).toEqual({ market: "JP", symbol: "130A" });
	});

	it("rejects bad shapes", () => {
		for (const bad of [
			"",
			"AAPL",
			"us:",
			":AAPL",
			"nasdaq:AAPL",
			"US:AAPL",
			"JP:7203",
			"us:aapl",
			"us:AAPL ",
			"us:9ABC",
			"us:TOOLONGTOOLONG",
			"jp:",
			"jp:720",
			"jp:72033",
			"jp:A203",
			"jp:720a",
			"us:AAPL:extra",
		]) {
			expect(expectErr(parseStockId(bad))).toBe("INVALID_STOCK_ID");
		}
	});

	it("round-trips through formatStockId", () => {
		expect(formatStockId("US", "AAPL")).toBe("us:AAPL");
		expect(formatStockId("JP", "7203")).toBe("jp:7203");
		expect(expectOk(parseStockId(formatStockId("JP", "130A")))).toEqual({
			market: "JP",
			symbol: "130A",
		});
	});

	it("format/parse round-trips on generated ids", () => {
		const usSymbol = fc
			.tuple(
				fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
				fc.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-".split("")), {
					maxLength: 9,
				}),
			)
			.map(([first, rest]) => `${first}${rest.join("")}`);
		const jpCode = fc
			.tuple(
				fc.constantFrom(..."0123456789".split("")),
				fc.array(fc.constantFrom(..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")), {
					minLength: 3,
					maxLength: 3,
				}),
			)
			.map(([first, rest]) => `${first}${rest.join("")}`);
		fc.assert(
			fc.property(
				fc.oneof(
					usSymbol.map((symbol) => ({ market: "US", symbol }) as const),
					jpCode.map((symbol) => ({ market: "JP", symbol }) as const),
				),
				({ market, symbol }) => {
					expect(expectOk(parseStockId(formatStockId(market, symbol)))).toEqual({
						market,
						symbol,
					});
				},
			),
			{ numRuns: 300 },
		);
	});
});
