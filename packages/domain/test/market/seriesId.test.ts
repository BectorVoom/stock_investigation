import { describe, expect, it } from "vitest";
import { formatMarketSeriesId, parseMarketSeriesId } from "../../src/market/seriesId.ts";
import { expectErr, expectOk } from "../support/result.ts";

describe("parseMarketSeriesId", () => {
	it("parses FRED ids", () => {
		expect(expectOk(parseMarketSeriesId("fred:VIXCLS"))).toEqual({
			provider: "fred",
			symbol: "VIXCLS",
		});
		expect(expectOk(parseMarketSeriesId("fred:DGS10"))).toEqual({
			provider: "fred",
			symbol: "DGS10",
		});
	});

	it("parses Twelve Data ids with and without an exchange suffix", () => {
		expect(expectOk(parseMarketSeriesId("twelve-data:AAPL"))).toEqual({
			provider: "twelve-data",
			symbol: "AAPL",
		});
		expect(expectOk(parseMarketSeriesId("twelve-data:XAU/USD"))).toEqual({
			provider: "twelve-data",
			symbol: "XAU/USD",
		});
		expect(expectOk(parseMarketSeriesId("twelve-data:7203:JPX"))).toEqual({
			provider: "twelve-data",
			symbol: "7203:JPX",
		});
	});

	it("rejects unknown providers, empty symbols and bad shapes", () => {
		for (const bad of [
			"",
			"VIXCLS",
			"fred:",
			":VIXCLS",
			"nasdaq:AAPL",
			"fred:vixcls",
			"fred:VIX CLS",
			"fred:TOOLONGTOOLONGTOOLONGTOOLONG",
			"twelve-data:",
			"twelve-data:aapl",
			"twelve-data:AAPL:jp controversial",
		]) {
			expect(expectErr(parseMarketSeriesId(bad))).toBe("INVALID_SERIES_ID");
		}
	});

	it("round-trips through formatMarketSeriesId", () => {
		expect(formatMarketSeriesId("fred", "VIXCLS")).toBe("fred:VIXCLS");
		expect(expectOk(parseMarketSeriesId(formatMarketSeriesId("twelve-data", "XAU/USD")))).toEqual({
			provider: "twelve-data",
			symbol: "XAU/USD",
		});
	});
});
