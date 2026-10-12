import { describe, expect, it } from "vitest";
import {
	type JpMarginBalanceFigures,
	jpMarginBuySellRatio,
	positionLabels,
	type UsShortInterestFigures,
	usDaysToCover,
} from "../../src/finance/positions.ts";
import { expectErr, expectOk } from "../support/result.ts";

function jp(buy: number, sell: number): JpMarginBalanceFigures {
	return {
		jurisdiction: "JP",
		metric: "jp-margin-balance",
		marginBuyBalanceShares: buy,
		marginSellBalanceShares: sell,
	};
}

function us(shortInterest: number, averageDailyVolume: number | null): UsShortInterestFigures {
	return {
		jurisdiction: "US",
		metric: "us-short-interest",
		reportedShortInterestShares: shortInterest,
		averageDailyVolumeShares: averageDailyVolume,
	};
}

/* Hard gate 5: expected ratios are hand-computed, arithmetic shown. */
describe("jpMarginBuySellRatio", () => {
	it("divides the margin buy balance by the margin sell balance", () => {
		// 1_200_000 / 400_000 = 3
		expect(expectOk(jpMarginBuySellRatio(jp(1_200_000, 400_000)))).toBe(3);
		// 150_000 / 600_000 = 0.25
		expect(expectOk(jpMarginBuySellRatio(jp(150_000, 600_000)))).toBe(0.25);
	});

	it("returns zero when there is no margin buying (0 / 5_000 = 0)", () => {
		expect(expectOk(jpMarginBuySellRatio(jp(0, 5000)))).toBe(0);
	});

	it("reports a zero sell balance as an error, not Infinity", () => {
		expect(jpMarginBuySellRatio(jp(1000, 0))).toEqual({ ok: false, error: "ZERO_DENOMINATOR" });
		expect(expectErr(jpMarginBuySellRatio(jp(0, 0)))).toBe("ZERO_DENOMINATOR");
	});

	it("rejects negative balances", () => {
		expect(expectErr(jpMarginBuySellRatio(jp(-1, 100)))).toBe("NEGATIVE_INPUT");
		expect(expectErr(jpMarginBuySellRatio(jp(100, -1)))).toBe("NEGATIVE_INPUT");
	});

	it("rejects non-finite balances", () => {
		expect(expectErr(jpMarginBuySellRatio(jp(Number.NaN, 100)))).toBe("NON_FINITE");
		expect(expectErr(jpMarginBuySellRatio(jp(100, Number.POSITIVE_INFINITY)))).toBe("NON_FINITE");
	});
});

describe("usDaysToCover", () => {
	it("divides reported short interest by average daily volume", () => {
		// 9_000_000 / 2_250_000 = 4
		expect(expectOk(usDaysToCover(us(9_000_000, 2_250_000)))).toBe(4);
		// 500_000 / 4_000_000 = 0.125
		expect(expectOk(usDaysToCover(us(500_000, 4_000_000)))).toBe(0.125);
	});

	it("reports missing volume explicitly instead of inventing a ratio", () => {
		expect(usDaysToCover(us(9_000_000, null))).toEqual({
			ok: false,
			error: "VOLUME_UNAVAILABLE",
		});
	});

	it("reports zero volume as an error, not Infinity", () => {
		expect(expectErr(usDaysToCover(us(9_000_000, 0)))).toBe("ZERO_DENOMINATOR");
	});

	it("rejects negative and non-finite input", () => {
		expect(expectErr(usDaysToCover(us(-1, 100)))).toBe("NEGATIVE_INPUT");
		expect(expectErr(usDaysToCover(us(100, -1)))).toBe("NEGATIVE_INPUT");
		expect(expectErr(usDaysToCover(us(Number.NaN, 100)))).toBe("NON_FINITE");
		expect(expectErr(usDaysToCover(us(100, Number.NaN)))).toBe("NON_FINITE");
	});
});

describe("positionLabels (FR-007 / DATA-006)", () => {
	const jpLabels = positionLabels("jp-margin-balance");
	const usLabels = positionLabels("us-short-interest");

	it("labels the two jurisdictions differently", () => {
		expect(jpLabels.heading).not.toBe(usLabels.heading);
		expect(jpLabels.heading).toMatch(/Japan/);
		expect(jpLabels.heading).toMatch(/margin/i);
		expect(usLabels.heading).toMatch(/US/);
		expect(usLabels.heading).toMatch(/short interest/i);
	});

	it("never presents US short interest under a margin-balance heading, or vice versa", () => {
		expect(usLabels.heading).not.toMatch(/margin/i);
		expect(jpLabels.heading).not.toMatch(/short interest/i);
	});

	it("carries a caveat that the two metrics are not equivalent", () => {
		expect(jpLabels.caveat).toMatch(/not comparable to US short interest/i);
		expect(usLabels.caveat).toMatch(/not equivalent to Japan's margin-sale balance/i);
		expect(usLabels.caveat).toMatch(/no security-level US margin-buy balance/i);
	});
});
