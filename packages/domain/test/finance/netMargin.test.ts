import { describe, expect, it } from "vitest";
import { computeNetProfitMargin, type IncomeFigure } from "../../src/finance/netMargin.ts";
import { isSameReportingPeriod, type ReportingPeriod } from "../../src/finance/types.ts";
import { expectErr, expectOk } from "../support/result.ts";

const FY2025: ReportingPeriod = {
	fiscalYear: 2025,
	fiscalPeriod: "FY",
	periodStart: "2025-01-01",
	periodEnd: "2025-12-31",
};

function figure(amount: number, overrides: Partial<IncomeFigure> = {}): IncomeFigure {
	return {
		amount: { amount, currency: "USD" },
		period: FY2025,
		accountingStandard: "US-GAAP",
		continuingOperationsPolicy: "total",
		...overrides,
	};
}

/* Hard gate 5: expected margins are hand-computed constants, arithmetic shown. */
describe("computeNetProfitMargin", () => {
	it("divides net income by revenue and keeps the accounting qualifiers", () => {
		// 1_250 / 10_000 = 0.125 (10_000 x 0.125 = 1_250)
		expect(expectOk(computeNetProfitMargin(figure(1250), figure(10_000)))).toEqual({
			marginRatio: 0.125,
			formula: "net income / revenue",
			currency: "USD",
			period: FY2025,
			accountingStandard: "US-GAAP",
			continuingOperationsPolicy: "total",
		});
	});

	it("handles yen-scale figures", () => {
		// 362_400 / 4_530_000 = 0.08 (4_530_000 x 0.08 = 362_400)
		const yen = (amount: number): IncomeFigure =>
			figure(amount, { amount: { amount, currency: "JPY" }, accountingStandard: "JGAAP" });
		const margin = expectOk(computeNetProfitMargin(yen(362_400), yen(4_530_000)));
		expect(margin.marginRatio).toBeCloseTo(0.08, 12);
		expect(margin.currency).toBe("JPY");
		expect(margin.accountingStandard).toBe("JGAAP");
	});

	it("returns a negative margin for a net loss", () => {
		// -300 / 2_400 = -0.125 (2_400 x 0.125 = 300)
		expect(expectOk(computeNetProfitMargin(figure(-300), figure(2400))).marginRatio).toBe(-0.125);
	});

	it("returns zero for break-even", () => {
		expect(expectOk(computeNetProfitMargin(figure(0), figure(2400))).marginRatio).toBe(0);
	});

	it("allows a margin above 100% (e.g. a one-off gain): 300 / 200 = 1.5", () => {
		expect(expectOk(computeNetProfitMargin(figure(300), figure(200))).marginRatio).toBe(1.5);
	});

	it("rejects zero revenue instead of returning Infinity or NaN", () => {
		expect(computeNetProfitMargin(figure(10), figure(0))).toEqual({
			ok: false,
			error: "NON_POSITIVE_REVENUE",
		});
		expect(expectErr(computeNetProfitMargin(figure(0), figure(0)))).toBe("NON_POSITIVE_REVENUE");
	});

	it("rejects negative revenue", () => {
		expect(expectErr(computeNetProfitMargin(figure(10), figure(-5)))).toBe("NON_POSITIVE_REVENUE");
	});

	it.each([
		[Number.NaN, 100],
		[100, Number.NaN],
		[Number.POSITIVE_INFINITY, 100],
		[100, Number.NEGATIVE_INFINITY],
	])("rejects non-finite amounts (%s, %s)", (netIncome, revenue) => {
		expect(expectErr(computeNetProfitMargin(figure(netIncome), figure(revenue)))).toBe(
			"NON_FINITE",
		);
	});

	it("rejects figures in different currencies", () => {
		const jpyRevenue = figure(10_000, { amount: { amount: 10_000, currency: "JPY" } });
		expect(expectErr(computeNetProfitMargin(figure(1250), jpyRevenue))).toBe("CURRENCY_MISMATCH");
	});

	it.each<[string, Partial<ReportingPeriod>]>([
		["fiscal year", { fiscalYear: 2024 }],
		["fiscal period", { fiscalPeriod: "Q4" }],
		["period start", { periodStart: "2025-04-01" }],
		["period end", { periodEnd: "2026-03-31" }],
	])("rejects figures whose %s differs", (_label, periodOverride) => {
		const otherPeriod = figure(10_000, { period: { ...FY2025, ...periodOverride } });
		expect(expectErr(computeNetProfitMargin(figure(1250), otherPeriod))).toBe("PERIOD_MISMATCH");
	});

	it("rejects mixed accounting standards", () => {
		const ifrs = figure(10_000, { accountingStandard: "IFRS" });
		expect(expectErr(computeNetProfitMargin(figure(1250), ifrs))).toBe(
			"ACCOUNTING_STANDARD_MISMATCH",
		);
	});

	it("rejects mixed continuing-operations policies", () => {
		const continuing = figure(10_000, { continuingOperationsPolicy: "continuing-only" });
		expect(expectErr(computeNetProfitMargin(figure(1250), continuing))).toBe(
			"CONTINUING_OPERATIONS_POLICY_MISMATCH",
		);
	});

	it("reports the basis mismatch even when revenue is also non-positive", () => {
		// A mismatched pair is not a computable margin at all, whatever the amounts are.
		const jpyZero = figure(0, { amount: { amount: 0, currency: "JPY" } });
		expect(expectErr(computeNetProfitMargin(figure(1250), jpyZero))).toBe("CURRENCY_MISMATCH");
	});
});

describe("isSameReportingPeriod", () => {
	it("is true for structurally equal periods and false when any field differs", () => {
		expect(isSameReportingPeriod(FY2025, { ...FY2025 })).toBe(true);
		expect(isSameReportingPeriod(FY2025, { ...FY2025, fiscalPeriod: "TTM" })).toBe(false);
		expect(isSameReportingPeriod(FY2025, { ...FY2025, fiscalYear: 2026 })).toBe(false);
	});
});
