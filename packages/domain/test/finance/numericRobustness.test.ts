import { describe, expect, it } from "vitest";
import {
	assessPricingPower,
	computeNetProfitMargin,
	deriveCagr,
	jpMarginBuySellRatio,
	type PricingPowerInputs,
	trailingPer,
} from "../../src/index.ts";

const period = {
	fiscalYear: 2025,
	fiscalPeriod: "FY",
	periodStart: "2025-01-01",
	periodEnd: "2025-12-31",
} as const;

describe("finance results are finite or an explicit error, never Infinity", () => {
	it("derives a growth rate whose intermediate ratio overflows", () => {
		// (1e308 / 1e-300) overflows to Infinity, but the 10-year rate is finite:
		// 10^((308 + 300) / 10) - 1 = 10^60.8 - 1 ~= 6.31e60.
		const cagr = deriveCagr(1e-300, 1e308, 2020, 2030);
		expect(cagr.ok).toBe(true);
		if (!cagr.ok) return;
		expect(Number.isFinite(cagr.value)).toBe(true);
		expect(cagr.value / 6.31e60).toBeCloseTo(1, 2);
	});

	it("reports NON_FINITE when the rate itself is not representable", () => {
		expect(deriveCagr(5e-324, 1e308, 2029, 2030)).toEqual({ ok: false, error: "NON_FINITE" });
	});

	it("does not return an infinite PER, margin or position ratio", () => {
		expect(trailingPer(1e308, 5e-324)).toEqual({ ok: false, error: "NON_FINITE" });
		const figure = (amount: number) =>
			({
				amount: { amount, currency: "USD" },
				period,
				accountingStandard: "US-GAAP",
				continuingOperationsPolicy: "total",
			}) as const;
		expect(computeNetProfitMargin(figure(1e308), figure(5e-324))).toEqual({
			ok: false,
			error: "NON_FINITE",
		});
		expect(
			jpMarginBuySellRatio({
				jurisdiction: "JP",
				metric: "jp-margin-balance",
				marginBuyBalanceShares: 1e308,
				marginSellBalanceShares: 5e-324,
			}),
		).toEqual({ ok: false, error: "NON_FINITE" });
	});
});

describe("pricing power: price and volume effects compound", () => {
	const inputs = (priceRealizationPct: number, volumeGrowthPct: number): PricingPowerInputs => ({
		revenueGrowthPct: null,
		priceRealizationPct,
		volumeGrowthPct,
		mixEffectPct: null,
		fxEffectPct: null,
		inputCostChangePct: null,
		grossMarginChangeBps: 50,
		operatingMarginChangeBps: null,
		managementCommentaryEvidenceIds: ["ev_1"],
	});

	it("treats +10% price with -9.5% volume as offset: 1.10 x 0.905 = 0.9955 < 1", () => {
		expect(assessPricingPower(inputs(10, -9.5)).classification).toBe(
			"price-increase-offset-by-volume-loss",
		);
	});

	it("treats +10% price with -9% volume as realized: 1.10 x 0.91 = 1.001 > 1", () => {
		expect(assessPricingPower(inputs(10, -9)).classification).toBe(
			"corroborated-price-realization",
		);
	});

	it("treats the exact break-even as offset: 1.25 x 0.80 = 1.00", () => {
		expect(assessPricingPower(inputs(25, -20)).classification).toBe(
			"price-increase-offset-by-volume-loss",
		);
	});
});
