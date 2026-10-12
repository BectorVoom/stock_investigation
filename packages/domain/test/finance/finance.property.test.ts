import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveCagr } from "../../src/finance/cagr.ts";
import { type DemandScenarioInput, deriveScenarioCagr } from "../../src/finance/demandScenario.ts";
import { classifyReportedPositionChange } from "../../src/finance/filings.ts";
import { computeNetProfitMargin, type IncomeFigure } from "../../src/finance/netMargin.ts";
import { trailingPer } from "../../src/finance/per.ts";
import { jpMarginBuySellRatio, usDaysToCover } from "../../src/finance/positions.ts";
import { assessPricingPower, type PricingPowerInputs } from "../../src/finance/pricingPower.ts";
import type { ReportingPeriod } from "../../src/finance/types.ts";

const positive = fc.double({ min: 1e-3, max: 1e9, noNaN: true });
const nonNegative = fc.double({ min: 0, max: 1e9, noNaN: true });
const anyNumber = fc.double();
const year = fc.integer({ min: 1990, max: 2100 });

function relativeError(actual: number, expected: number): number {
	return Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
}

describe("deriveCagr properties", () => {
	it("round-trips: base x (1 + cagr)^years reproduces the target", () => {
		fc.assert(
			fc.property(
				positive,
				nonNegative,
				year,
				fc.integer({ min: 1, max: 30 }),
				(base, target, baseYear, years) => {
					const result = deriveCagr(base, target, baseYear, baseYear + years);
					expect(result.ok).toBe(true);
					if (!result.ok) return;
					const reconstructed = base * (1 + result.value) ** years;
					expect(relativeError(reconstructed, target)).toBeLessThan(1e-6);
				},
			),
		);
	});

	it("has the sign of (target - base) and never falls below -100%", () => {
		fc.assert(
			fc.property(positive, nonNegative, fc.integer({ min: 1, max: 30 }), (base, target, years) => {
				const result = deriveCagr(base, target, 2025, 2025 + years);
				if (!result.ok) return;
				expect(result.value).toBeGreaterThanOrEqual(-1);
				if (target > base * 1.000001) expect(result.value).toBeGreaterThan(0);
				if (target < base * 0.999999) expect(result.value).toBeLessThan(0);
			}),
		);
	});

	it("is scale-invariant: the unit of measure does not change the growth rate", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 1, max: 1e6, noNaN: true }),
				fc.double({ min: 1, max: 1e6, noNaN: true }),
				fc.integer({ min: 1, max: 10 }),
				fc.constantFrom(1000, 1_000_000, 0.001),
				(base, target, years, scale) => {
					const plain = deriveCagr(base, target, 2025, 2025 + years);
					const scaled = deriveCagr(base * scale, target * scale, 2025, 2025 + years);
					if (!plain.ok || !scaled.ok) throw new Error("expected both to be derivable");
					expect(scaled.value).toBeCloseTo(plain.value, 8);
				},
			),
		);
	});

	it("is total: any numeric input yields a finite ratio or a typed error, never NaN", () => {
		fc.assert(
			fc.property(anyNumber, anyNumber, anyNumber, anyNumber, (base, target, from, to) => {
				const result = deriveCagr(base, target, from, to);
				if (result.ok) expect(Number.isNaN(result.value)).toBe(false);
				else {
					expect(["NON_FINITE", "NON_POSITIVE_BASE", "NEGATIVE_TARGET", "INVALID_YEARS"]).toContain(
						result.error,
					);
				}
			}),
		);
	});
});

describe("trailingPer properties", () => {
	it("is ok exactly when price >= 0 and EPS > 0, and then price = PER x EPS", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -1e9, max: 1e9, noNaN: true }),
				fc.double({ min: -1e6, max: 1e6, noNaN: true }),
				(price, eps) => {
					const result = trailingPer(price, eps);
					expect(result.ok).toBe(price >= 0 && eps > 0);
					if (!result.ok) return;
					expect(result.value).toBeGreaterThanOrEqual(0);
					if (Number.isFinite(result.value)) {
						expect(relativeError(result.value * eps, price)).toBeLessThan(1e-9);
					}
				},
			),
		);
	});

	it("never returns a ratio for non-positive EPS, whatever the price", () => {
		fc.assert(
			fc.property(anyNumber, fc.double({ max: 0, noNaN: true }), (price, eps) => {
				expect(trailingPer(price, eps).ok).toBe(false);
			}),
		);
	});
});

const PERIOD: ReportingPeriod = {
	fiscalYear: 2025,
	fiscalPeriod: "FY",
	periodStart: "2025-01-01",
	periodEnd: "2025-12-31",
};

function usd(amount: number): IncomeFigure {
	return {
		amount: { amount, currency: "USD" },
		period: PERIOD,
		accountingStandard: "US-GAAP",
		continuingOperationsPolicy: "total",
	};
}

describe("computeNetProfitMargin properties", () => {
	// Magnitudes are kept away from the subnormal range so a ratio cannot underflow to zero.
	const netIncome = fc.oneof(
		fc.constant(0),
		fc.double({ min: 1e-3, max: 1e9, noNaN: true }),
		fc.double({ min: -1e9, max: -1e-3, noNaN: true }),
	);

	it("has the sign of net income", () => {
		fc.assert(
			fc.property(netIncome, positive, (income, revenue) => {
				const result = computeNetProfitMargin(usd(income), usd(revenue));
				if (!result.ok) throw new Error(`unexpected ${result.error}`);
				expect(Math.sign(result.value.marginRatio)).toBe(Math.sign(income));
			}),
		);
	});

	it("is invariant under a common scale factor (thousands vs millions)", () => {
		fc.assert(
			fc.property(
				netIncome,
				fc.double({ min: 1, max: 1e9, noNaN: true }),
				fc.constantFrom(1000, 1_000_000),
				(income, revenue, scale) => {
					const plain = computeNetProfitMargin(usd(income), usd(revenue));
					const scaled = computeNetProfitMargin(usd(income * scale), usd(revenue * scale));
					if (!plain.ok || !scaled.ok) throw new Error("expected both margins");
					expect(relativeError(scaled.value.marginRatio, plain.value.marginRatio)).toBeLessThan(
						1e-9,
					);
				},
			),
		);
	});

	it("reconstructs net income as margin x revenue", () => {
		fc.assert(
			fc.property(netIncome, fc.double({ min: 1, max: 1e9, noNaN: true }), (income, revenue) => {
				const result = computeNetProfitMargin(usd(income), usd(revenue));
				if (!result.ok) throw new Error(`unexpected ${result.error}`);
				expect(relativeError(result.value.marginRatio * revenue, income)).toBeLessThan(1e-9);
			}),
		);
	});

	it("never yields a margin for non-positive revenue", () => {
		fc.assert(
			fc.property(netIncome, fc.double({ min: -1e9, max: 0, noNaN: true }), (income, revenue) => {
				expect(computeNetProfitMargin(usd(income), usd(revenue))).toEqual({
					ok: false,
					error: "NON_POSITIVE_REVENUE",
				});
			}),
		);
	});

	it("is total: any amounts yield a finite ratio or a typed error", () => {
		fc.assert(
			fc.property(anyNumber, anyNumber, (income, revenue) => {
				const result = computeNetProfitMargin(usd(income), usd(revenue));
				if (result.ok) expect(Number.isNaN(result.value.marginRatio)).toBe(false);
			}),
		);
	});
});

describe("position ratio properties", () => {
	it("never returns a non-finite ratio", () => {
		fc.assert(
			fc.property(anyNumber, anyNumber, (numerator, denominator) => {
				const jp = jpMarginBuySellRatio({
					jurisdiction: "JP",
					metric: "jp-margin-balance",
					marginBuyBalanceShares: numerator,
					marginSellBalanceShares: denominator,
				});
				const us = usDaysToCover({
					jurisdiction: "US",
					metric: "us-short-interest",
					reportedShortInterestShares: numerator,
					averageDailyVolumeShares: denominator,
				});
				for (const result of [jp, us]) {
					if (result.ok) {
						expect(Number.isNaN(result.value)).toBe(false);
						expect(result.value).toBeGreaterThanOrEqual(0);
					}
				}
				expect(jp.ok).toBe(us.ok);
			}),
		);
	});
});

describe("reported position change properties", () => {
	const shares = fc.option(fc.integer({ min: 0, max: 1_000_000_000 }), { nil: null });

	it("mirrors: swapping the quarters swaps increase/decrease and new/gone", () => {
		const mirror = {
			"newly-reported-holding": "no-longer-reported",
			"no-longer-reported": "newly-reported-holding",
			"increase-in-reported-position": "decrease-in-reported-position",
			"decrease-in-reported-position": "increase-in-reported-position",
			"unchanged-reported-position": "unchanged-reported-position",
			"not-reported": "not-reported",
		} as const;
		fc.assert(
			fc.property(shares, shares, (previous, current) => {
				const forward = classifyReportedPositionChange(previous, current);
				expect(classifyReportedPositionChange(current, previous)).toBe(mirror[forward]);
			}),
		);
	});
});

describe("assessPricingPower properties", () => {
	const pct = fc.option(fc.double({ min: -50, max: 50, noNaN: true }), { nil: null });
	const inputs: fc.Arbitrary<PricingPowerInputs> = fc.record({
		revenueGrowthPct: pct,
		priceRealizationPct: pct,
		volumeGrowthPct: pct,
		mixEffectPct: pct,
		fxEffectPct: pct,
		inputCostChangePct: pct,
		grossMarginChangeBps: pct,
		operatingMarginChangeBps: pct,
		managementCommentaryEvidenceIds: fc.array(fc.constantFrom("ev_1", "ev_2"), { maxLength: 2 }),
	});

	it("only calls price realization corroborated when every corroborating input is present", () => {
		fc.assert(
			fc.property(inputs, (candidate) => {
				const assessment = assessPricingPower(candidate);
				if (assessment.classification !== "corroborated-price-realization") return;
				expect(assessment.missingInputs).toEqual([]);
				expect(candidate.priceRealizationPct).toBeGreaterThan(0);
				expect(candidate.grossMarginChangeBps).toBeGreaterThanOrEqual(0);
			}),
		);
	});

	it("never credits pricing power when price realization is undisclosed", () => {
		fc.assert(
			fc.property(inputs, (candidate) => {
				const assessment = assessPricingPower({ ...candidate, priceRealizationPct: null });
				expect(["margin-improvement-without-price-evidence", "insufficient-data"]).toContain(
					assessment.classification,
				);
				expect(assessment.unexplainedRevenueResidualPct).toBeNull();
			}),
		);
	});
});

describe("deriveScenarioCagr properties", () => {
	it("orders derived CAGRs like the scenario targets: bear <= base <= bull", () => {
		fc.assert(
			fc.property(
				positive,
				fc.tuple(nonNegative, nonNegative, nonNegative),
				fc.integer({ min: 3, max: 5 }),
				(baseline, targets, horizon) => {
					const [bear = 0, base = 0, bull = 0] = [...targets].sort((a, b) => a - b);
					const input: DemandScenarioInput = {
						productOrService: "p",
						quantityKind: "revenue",
						unit: "USD bn",
						baseYear: 2025,
						targetYear: 2025 + horizon,
						baselineValue: baseline,
						bear: { targetValue: bear, assumptions: ["a"] },
						base: { targetValue: base, assumptions: ["b"] },
						bull: { targetValue: bull, assumptions: ["c"] },
						drivers: ["d"],
						barriers: [],
						falsifiers: ["f"],
						methodology: "m",
					};
					const result = deriveScenarioCagr(input);
					if (!result.ok) throw new Error(`unexpected ${result.error.join(",")}`);
					const { bear: bearCagr, base: baseCagr, bull: bullCagr } = result.value;
					if (bearCagr === null || baseCagr === null || bullCagr === null) {
						throw new Error("a positive baseline must make every CAGR derivable");
					}
					expect(bearCagr).toBeLessThanOrEqual(baseCagr);
					expect(baseCagr).toBeLessThanOrEqual(bullCagr);
				},
			),
		);
	});
});
