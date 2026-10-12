import { describe, expect, it } from "vitest";
import { computePer, type EpsFigure, type PriceQuote, trailingPer } from "../../src/finance/per.ts";
import type { ReportingPeriod } from "../../src/finance/types.ts";
import { expectErr, expectOk } from "../support/result.ts";

/*
 * Hard gate 5: every expected ratio below is a hand-computed constant with the
 * arithmetic shown. None is derived by calling the implementation.
 */
describe("trailingPer", () => {
	it.each([
		// 16 x 155 = 2_480, so 2_480 / 155 = 16
		{ price: 2480, eps: 155, expected: 16 },
		// 28 x 6.78 = 168 + 21.84 = 189.84, so 189.84 / 6.78 = 28
		{ price: 189.84, eps: 6.78, expected: 28 },
		// 12.5 x 8 = 100, so 100 / 8 = 12.5
		{ price: 100, eps: 8, expected: 12.5 },
		// 400 x 0.25 = 100, so 100 / 0.25 = 400 (tiny positive EPS gives a large, still valid PER)
		{ price: 100, eps: 0.25, expected: 400 },
	])("price $price / EPS $eps = $expected", ({ price, eps, expected }) => {
		expect(expectOk(trailingPer(price, eps))).toBeCloseTo(expected, 10);
	});

	it("accepts a zero price (0 / 5 = 0)", () => {
		expect(trailingPer(0, 5)).toEqual({ ok: true, value: 0 });
	});

	it("reports zero EPS as an error, never Infinity", () => {
		expect(trailingPer(100, 0)).toEqual({ ok: false, error: "NON_POSITIVE_EPS" });
	});

	it("reports negative EPS as an error, never a negative or positive ratio", () => {
		expect(trailingPer(100, -4)).toEqual({ ok: false, error: "NON_POSITIVE_EPS" });
		expect(trailingPer(100, -0.01)).toEqual({ ok: false, error: "NON_POSITIVE_EPS" });
	});

	it("rejects a negative price", () => {
		expect(trailingPer(-1, 5)).toEqual({ ok: false, error: "NEGATIVE_PRICE" });
	});

	it.each([
		[Number.NaN, 5],
		[100, Number.NaN],
		[Number.POSITIVE_INFINITY, 5],
		[100, Number.POSITIVE_INFINITY],
		[Number.NEGATIVE_INFINITY, 5],
		[100, Number.NEGATIVE_INFINITY],
	])("rejects non-finite input (%s, %s)", (price, eps) => {
		expect(trailingPer(price, eps)).toEqual({ ok: false, error: "NON_FINITE" });
	});

	it("checks finiteness before sign, so NaN never masquerades as a sign error", () => {
		expect(trailingPer(Number.NaN, -1)).toEqual({ ok: false, error: "NON_FINITE" });
		expect(trailingPer(-1, Number.NaN)).toEqual({ ok: false, error: "NON_FINITE" });
	});
});

const FY2025: ReportingPeriod = {
	fiscalYear: 2025,
	fiscalPeriod: "FY",
	periodStart: "2025-04-01",
	periodEnd: "2026-03-31",
};

const quote: PriceQuote = {
	securityId: "sec_7203",
	price: { amount: 2480, currency: "JPY" },
	priceAsOf: "2026-10-09T06:00:00Z",
	adjustmentBasis: "split-adjusted",
};

const trailingEps: EpsFigure = {
	securityId: "sec_7203",
	eps: { amount: 155, currency: "JPY" },
	basis: "trailing",
	actualOrEstimate: "actual",
	period: FY2025,
	adjustmentBasis: "split-adjusted",
	dilution: "diluted",
};

describe("computePer", () => {
	it("returns the ratio together with every qualifier FR-006 requires", () => {
		// 2_480 JPY / 155 JPY = 16 (16 x 155 = 2_480)
		expect(expectOk(computePer(quote, trailingEps))).toEqual({
			per: 16,
			formula: "price / EPS",
			epsBasis: "trailing",
			actualOrEstimate: "actual",
			dilution: "diluted",
			currency: "JPY",
			priceAsOf: "2026-10-09T06:00:00Z",
			earningsPeriod: FY2025,
			adjustmentBasis: "split-adjusted",
		});
	});

	it("labels a forward PER as an estimate", () => {
		const forwardEps: EpsFigure = {
			...trailingEps,
			// 2_480 / 124 = 20 (20 x 124 = 2_480)
			eps: { amount: 124, currency: "JPY" },
			basis: "forward",
			actualOrEstimate: "estimate",
			dilution: "basic",
		};
		const value = expectOk(computePer(quote, forwardEps));
		expect(value.per).toBe(20);
		expect(value.epsBasis).toBe("forward");
		expect(value.actualOrEstimate).toBe("estimate");
		expect(value.dilution).toBe("basic");
	});

	it("rejects figures for different securities", () => {
		const other: EpsFigure = { ...trailingEps, securityId: "sec_6758" };
		expect(expectErr(computePer(quote, other))).toBe("SECURITY_MISMATCH");
	});

	it("rejects a price and EPS in different currencies instead of dividing them", () => {
		const usdEps: EpsFigure = { ...trailingEps, eps: { amount: 1.05, currency: "USD" } };
		expect(expectErr(computePer(quote, usdEps))).toBe("CURRENCY_MISMATCH");
	});

	it("rejects mixed split-adjustment bases", () => {
		const unadjusted: EpsFigure = { ...trailingEps, adjustmentBasis: "unadjusted" };
		expect(expectErr(computePer(quote, unadjusted))).toBe("ADJUSTMENT_BASIS_MISMATCH");
	});

	it("rejects a trailing EPS that is an estimate and a forward EPS that is an actual", () => {
		const trailingEstimate: EpsFigure = { ...trailingEps, actualOrEstimate: "estimate" };
		const forwardActual: EpsFigure = { ...trailingEps, basis: "forward" };
		expect(expectErr(computePer(quote, trailingEstimate))).toBe("EPS_BASIS_MISMATCH");
		expect(expectErr(computePer(quote, forwardActual))).toBe("EPS_BASIS_MISMATCH");
	});

	it("reports a loss-making issuer as NON_POSITIVE_EPS, not as a PER", () => {
		const loss: EpsFigure = { ...trailingEps, eps: { amount: -31.2, currency: "JPY" } };
		const zero: EpsFigure = { ...trailingEps, eps: { amount: 0, currency: "JPY" } };
		expect(computePer(quote, loss)).toEqual({ ok: false, error: "NON_POSITIVE_EPS" });
		expect(computePer(quote, zero)).toEqual({ ok: false, error: "NON_POSITIVE_EPS" });
	});

	it("propagates non-finite and negative-price errors", () => {
		const nanEps: EpsFigure = { ...trailingEps, eps: { amount: Number.NaN, currency: "JPY" } };
		const negativeQuote: PriceQuote = { ...quote, price: { amount: -5, currency: "JPY" } };
		expect(expectErr(computePer(quote, nanEps))).toBe("NON_FINITE");
		expect(expectErr(computePer(negativeQuote, trailingEps))).toBe("NEGATIVE_PRICE");
	});
});
