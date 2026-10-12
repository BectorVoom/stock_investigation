import { describe, expect, it } from "vitest";
import { assessPricingPower, type PricingPowerInputs } from "../../src/finance/pricingPower.ts";

/** A fully disclosed, fully corroborated year; individual tests remove or change one input. */
const corroborated: PricingPowerInputs = {
	revenueGrowthPct: 8,
	priceRealizationPct: 5,
	volumeGrowthPct: 1.5,
	mixEffectPct: 0.5,
	fxEffectPct: 0.25,
	inputCostChangePct: 2,
	grossMarginChangeBps: 120,
	operatingMarginChangeBps: 80,
	managementCommentaryEvidenceIds: ["ev_call_q4"],
};

function assess(overrides: Partial<PricingPowerInputs>) {
	return assessPricingPower({ ...corroborated, ...overrides });
}

describe("assessPricingPower classification (FR-009 / DATA-008)", () => {
	it("classifies a disclosed price increase with stable volume, margin and commentary", () => {
		const assessment = assessPricingPower(corroborated);
		expect(assessment.classification).toBe("corroborated-price-realization");
		expect(assessment.missingInputs).toEqual([]);
	});

	it("never treats a margin improvement alone as pricing power", () => {
		const assessment = assess({ priceRealizationPct: null });
		expect(assessment.classification).toBe("margin-improvement-without-price-evidence");
		expect(assessment.missingInputs).toContain("priceRealizationPct");
	});

	it("flags an operating-margin-only improvement the same way", () => {
		expect(assess({ priceRealizationPct: null, grossMarginChangeBps: null }).classification).toBe(
			"margin-improvement-without-price-evidence",
		);
	});

	it("reports insufficient data when neither price nor a margin improvement is disclosed", () => {
		expect(
			assess({
				priceRealizationPct: null,
				grossMarginChangeBps: null,
				operatingMarginChangeBps: null,
			}).classification,
		).toBe("insufficient-data");
		expect(
			assess({
				priceRealizationPct: null,
				grossMarginChangeBps: -40,
				operatingMarginChangeBps: 0,
			}).classification,
		).toBe("insufficient-data");
	});

	it("reports no price realization for flat or falling prices, even with rising margins", () => {
		expect(assess({ priceRealizationPct: 0 }).classification).toBe("no-price-realization");
		expect(assess({ priceRealizationPct: -2 }).classification).toBe("no-price-realization");
	});

	it("leaves a price increase uncorroborated without volume data", () => {
		const assessment = assess({ volumeGrowthPct: null });
		expect(assessment.classification).toBe("price-realization-uncorroborated");
		expect(assessment.missingInputs).toEqual(["volumeGrowthPct"]);
	});

	it("leaves a price increase uncorroborated without gross-margin data", () => {
		const assessment = assess({ grossMarginChangeBps: null });
		expect(assessment.classification).toBe("price-realization-uncorroborated");
		expect(assessment.missingInputs).toEqual(["grossMarginChangeBps"]);
	});

	it("leaves a price increase uncorroborated without management commentary evidence", () => {
		const assessment = assess({ managementCommentaryEvidenceIds: [] });
		expect(assessment.classification).toBe("price-realization-uncorroborated");
		expect(assessment.missingInputs).toEqual(["managementCommentary"]);
	});

	it("detects a price increase fully offset by volume loss", () => {
		// +5% price with -6% volume: volume loss exceeds the price gain.
		expect(assess({ volumeGrowthPct: -6 }).classification).toBe(
			"price-increase-offset-by-volume-loss",
		);
		// Boundary: -5% volume exactly cancels +5% price.
		expect(assess({ volumeGrowthPct: -5 }).classification).toBe(
			"price-increase-offset-by-volume-loss",
		);
	});

	it("does not call a smaller volume decline an offset", () => {
		// +5% price with -4.5% volume still nets positive.
		expect(assess({ volumeGrowthPct: -4.5 }).classification).toBe("corroborated-price-realization");
	});

	it("detects a price increase absorbed by costs when gross margin falls", () => {
		expect(assess({ grossMarginChangeBps: -30 }).classification).toBe(
			"price-increase-absorbed-by-costs",
		);
	});

	it("reports volume loss ahead of cost absorption when both apply", () => {
		expect(assess({ volumeGrowthPct: -9, grossMarginChangeBps: -30 }).classification).toBe(
			"price-increase-offset-by-volume-loss",
		);
	});

	it("lists every missing input, in a stable order", () => {
		expect(
			assess({
				priceRealizationPct: null,
				volumeGrowthPct: null,
				grossMarginChangeBps: null,
				managementCommentaryEvidenceIds: [],
			}).missingInputs,
		).toEqual([
			"priceRealizationPct",
			"volumeGrowthPct",
			"grossMarginChangeBps",
			"managementCommentary",
		]);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("never classifies a non-finite price realization (%s) as price realization", (price) => {
		const assessment = assess({ priceRealizationPct: price });
		expect(assessment.classification).not.toBe("corroborated-price-realization");
		expect(assessment.classification).not.toBe("price-realization-uncorroborated");
		expect(assessment.missingInputs).toContain("priceRealizationPct");
	});

	it.each([
		["volumeGrowthPct", { volumeGrowthPct: Number.NaN }],
		["grossMarginChangeBps", { grossMarginChangeBps: Number.NaN }],
	] as const)("treats a non-finite %s as undisclosed, not as corroboration", (name, overrides) => {
		const assessment = assess(overrides);
		expect(assessment.classification).toBe("price-realization-uncorroborated");
		expect(assessment.missingInputs).toContain(name);
	});
});

describe("assessPricingPower revenue residual", () => {
	it("is reported revenue growth minus price, volume, mix and FX effects", () => {
		// 8 - (5 + 1.5 + 0.5 + 0.25) = 8 - 7.25 = 0.75 (all terms exact in binary)
		expect(assessPricingPower(corroborated).unexplainedRevenueResidualPct).toBe(0.75);
	});

	it("can be negative when the disclosed effects exceed reported growth", () => {
		// 6 - (5 + 1.5 + 0.5 + 0.25) = 6 - 7.25 = -1.25
		expect(assess({ revenueGrowthPct: 6 }).unexplainedRevenueResidualPct).toBe(-1.25);
	});

	it.each([
		"revenueGrowthPct",
		"priceRealizationPct",
		"volumeGrowthPct",
		"mixEffectPct",
		"fxEffectPct",
	] as const)("is null, not a partial sum, when %s is undisclosed", (name) => {
		expect(assess({ [name]: null }).unexplainedRevenueResidualPct).toBeNull();
	});

	it("is null when any term is non-finite", () => {
		expect(assess({ fxEffectPct: Number.NaN }).unexplainedRevenueResidualPct).toBeNull();
		expect(
			assess({ revenueGrowthPct: Number.POSITIVE_INFINITY }).unexplainedRevenueResidualPct,
		).toBeNull();
	});

	it("does not depend on cost or margin inputs", () => {
		expect(
			assess({ inputCostChangePct: null, grossMarginChangeBps: null })
				.unexplainedRevenueResidualPct,
		).toBe(0.75);
	});
});
