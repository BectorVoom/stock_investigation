import { describe, expect, it } from "vitest";
import {
	type DemandScenarioInput,
	deriveScenarioCagr,
	MAX_HORIZON_YEARS,
	MIN_HORIZON_YEARS,
} from "../../src/finance/demandScenario.ts";
import { expectErr, expectOk } from "../support/result.ts";

const valid: DemandScenarioInput = {
	productOrService: "Grid-scale battery storage",
	quantityKind: "unit-demand",
	unit: "GWh installed per year",
	baseYear: 2025,
	targetYear: 2030,
	baselineValue: 1024,
	bear: { targetValue: 1024, assumptions: ["Subsidies lapse"] },
	base: { targetValue: 3125, assumptions: ["Current policy holds"] },
	bull: { targetValue: 7776, assumptions: ["Cell prices fall faster"] },
	drivers: ["Renewables share"],
	barriers: ["Grid interconnection queues"],
	falsifiers: ["Installations flat for two consecutive years"],
	methodology: "Bottom-up from announced projects.",
};

function scenario(overrides: Partial<DemandScenarioInput>): DemandScenarioInput {
	return { ...valid, ...overrides };
}

describe("deriveScenarioCagr (FR-004 / DATA-009)", () => {
	it("derives one CAGR per case from the sourced baseline", () => {
		// Five-year horizon from a 1_024 baseline:
		//   bear 1_024 -> (1)^(1/5) - 1 = 0
		//   base 3_125 -> (3125/1024)^(1/5) - 1 = 5/4 - 1 = 0.25   (5^5 = 3_125, 4^5 = 1_024)
		//   bull 7_776 -> (7776/1024)^(1/5) - 1 = 6/4 - 1 = 0.5    (6^5 = 7_776)
		const cagr = expectOk(deriveScenarioCagr(valid));
		expect(cagr.bear).toBeCloseTo(0, 12);
		expect(cagr.base).toBeCloseTo(0.25, 12);
		expect(cagr.bull).toBeCloseTo(0.5, 12);
	});

	it("derives CAGRs over a three-year horizon", () => {
		// From 1_000 over 3 years: 1_000 -> 0%; 1_331 -> 10% (1.1^3); 1_728 -> 20% (1.2^3).
		const cagr = expectOk(
			deriveScenarioCagr(
				scenario({
					baseYear: 2026,
					targetYear: 2029,
					baselineValue: 1000,
					bear: { targetValue: 1000, assumptions: ["a"] },
					base: { targetValue: 1331, assumptions: ["b"] },
					bull: { targetValue: 1728, assumptions: ["c"] },
				}),
			),
		);
		expect(cagr.bear).toBeCloseTo(0, 12);
		expect(cagr.base).toBeCloseTo(0.1, 12);
		expect(cagr.bull).toBeCloseTo(0.2, 12);
	});

	it("returns null CAGRs, not zeros, when there is no sourced baseline", () => {
		expect(expectOk(deriveScenarioCagr(scenario({ baselineValue: null })))).toEqual({
			bear: null,
			base: null,
			bull: null,
		});
	});

	it("returns null CAGRs when the baseline is zero, where growth is undefined", () => {
		expect(expectOk(deriveScenarioCagr(scenario({ baselineValue: 0 })))).toEqual({
			bear: null,
			base: null,
			bull: null,
		});
	});

	it("accepts equal bear/base/bull targets", () => {
		const same = { targetValue: 2000, assumptions: ["x"] };
		expect(deriveScenarioCagr(scenario({ bear: same, base: same, bull: same })).ok).toBe(true);
	});

	it("exposes the three-to-five-year horizon bounds", () => {
		expect(MIN_HORIZON_YEARS).toBe(3);
		expect(MAX_HORIZON_YEARS).toBe(5);
	});

	it.each([3, 4, 5])("accepts a %i-year horizon", (years) => {
		expect(deriveScenarioCagr(scenario({ targetYear: 2025 + years })).ok).toBe(true);
	});

	it.each([-1, 0, 1, 2, 6, 10])("rejects a %i-year horizon", (years) => {
		expect(expectErr(deriveScenarioCagr(scenario({ targetYear: 2025 + years })))).toEqual([
			"HORIZON_OUT_OF_RANGE",
		]);
	});

	it("rejects a fractional horizon", () => {
		expect(expectErr(deriveScenarioCagr(scenario({ targetYear: 2028.5 })))).toEqual([
			"HORIZON_OUT_OF_RANGE",
		]);
	});

	it("rejects a blank unit", () => {
		expect(expectErr(deriveScenarioCagr(scenario({ unit: "   " })))).toEqual(["MISSING_UNIT"]);
	});

	it("rejects a blank methodology", () => {
		expect(expectErr(deriveScenarioCagr(scenario({ methodology: "" })))).toEqual([
			"MISSING_METHODOLOGY",
		]);
	});

	it("rejects scenarios whose targets are not ordered bear <= base <= bull", () => {
		expect(
			expectErr(deriveScenarioCagr(scenario({ bear: { targetValue: 4000, assumptions: ["a"] } }))),
		).toEqual(["SCENARIO_ORDER_INVALID"]);
		expect(
			expectErr(deriveScenarioCagr(scenario({ bull: { targetValue: 3000, assumptions: ["c"] } }))),
		).toEqual(["SCENARIO_ORDER_INVALID"]);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects a non-finite target (%s)", (value) => {
		expect(
			expectErr(deriveScenarioCagr(scenario({ base: { targetValue: value, assumptions: ["b"] } }))),
		).toEqual(["NON_FINITE"]);
	});

	it("requires at least one driver", () => {
		expect(expectErr(deriveScenarioCagr(scenario({ drivers: [] })))).toEqual(["MISSING_DRIVERS"]);
	});

	it("requires at least one falsifying observation", () => {
		expect(expectErr(deriveScenarioCagr(scenario({ falsifiers: [] })))).toEqual([
			"MISSING_FALSIFIERS",
		]);
	});

	it.each(["bear", "base", "bull"] as const)("requires assumptions for the %s case", (name) => {
		const stripped = { targetValue: valid[name].targetValue, assumptions: [] };
		expect(expectErr(deriveScenarioCagr(scenario({ [name]: stripped })))).toEqual([
			"MISSING_ASSUMPTIONS",
		]);
	});

	it("reports every violated invariant at once", () => {
		const errors = expectErr(
			deriveScenarioCagr(
				scenario({
					unit: "",
					methodology: " ",
					targetYear: 2026,
					bear: { targetValue: 9000, assumptions: [] },
					drivers: [],
					falsifiers: [],
				}),
			),
		);
		expect([...errors].sort()).toEqual(
			[
				"HORIZON_OUT_OF_RANGE",
				"MISSING_ASSUMPTIONS",
				"MISSING_DRIVERS",
				"MISSING_FALSIFIERS",
				"MISSING_METHODOLOGY",
				"MISSING_UNIT",
				"SCENARIO_ORDER_INVALID",
			].sort(),
		);
	});
});
