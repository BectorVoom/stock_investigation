/**
 * Pricing-power assessment (FR-009 / DATA-008). Price realization is kept
 * separate from volume, mix, FX and cost effects; a margin improvement alone
 * is never classified as demonstrated pricing power.
 */
export interface PricingPowerInputs {
	/** Year-over-year percentages, e.g. 4.5 for +4.5%. null = not disclosed. */
	readonly revenueGrowthPct: number | null;
	readonly priceRealizationPct: number | null;
	readonly volumeGrowthPct: number | null;
	readonly mixEffectPct: number | null;
	readonly fxEffectPct: number | null;
	readonly inputCostChangePct: number | null;
	readonly grossMarginChangeBps: number | null;
	readonly operatingMarginChangeBps: number | null;
	readonly managementCommentaryEvidenceIds: readonly string[];
}

export type PricingPowerClassification =
	| "corroborated-price-realization"
	| "price-realization-uncorroborated"
	| "price-increase-offset-by-volume-loss"
	| "price-increase-absorbed-by-costs"
	| "no-price-realization"
	| "margin-improvement-without-price-evidence"
	| "insufficient-data";

export type PricingPowerInputName =
	| "priceRealizationPct"
	| "volumeGrowthPct"
	| "grossMarginChangeBps"
	| "managementCommentary";

export interface PricingPowerAssessment {
	readonly classification: PricingPowerClassification;
	readonly missingInputs: readonly PricingPowerInputName[];
	/**
	 * Reported revenue growth minus the additive sum of price, volume, mix and
	 * FX effects, in percentage points. null unless every term is disclosed.
	 */
	readonly unexplainedRevenueResidualPct: number | null;
}

function allFinite(values: readonly (number | null)[]): values is readonly number[] {
	return values.every((value) => value !== null && Number.isFinite(value));
}

function residual(inputs: PricingPowerInputs): number | null {
	const terms = [
		inputs.revenueGrowthPct,
		inputs.priceRealizationPct,
		inputs.volumeGrowthPct,
		inputs.mixEffectPct,
		inputs.fxEffectPct,
	];
	if (!allFinite(terms)) return null;
	const [revenue = 0, price = 0, volume = 0, mix = 0, fx = 0] = terms;
	return revenue - (price + volume + mix + fx);
}

function classify(inputs: PricingPowerInputs): PricingPowerClassification {
	const price = inputs.priceRealizationPct;
	const marginImproved =
		(inputs.grossMarginChangeBps ?? 0) > 0 || (inputs.operatingMarginChangeBps ?? 0) > 0;
	if (price === null) {
		return marginImproved ? "margin-improvement-without-price-evidence" : "insufficient-data";
	}
	if (price <= 0) return "no-price-realization";
	const volume = inputs.volumeGrowthPct;
	const grossMargin = inputs.grossMarginChangeBps;
	if (volume === null || grossMargin === null) return "price-realization-uncorroborated";
	// The price increase did not grow price-times-volume revenue. The effects compound:
	// +10% price with -9.5% volume is 1.10 x 0.905 = 0.9955, a decline, even though 10 > 9.5.
	if (volume < 0 && (1 + price / 100) * (1 + volume / 100) <= 1) {
		return "price-increase-offset-by-volume-loss";
	}
	if (grossMargin < 0) return "price-increase-absorbed-by-costs";
	if (inputs.managementCommentaryEvidenceIds.length === 0) {
		return "price-realization-uncorroborated";
	}
	return "corroborated-price-realization";
}

/** A non-finite figure is not a disclosure; it is treated exactly like an undisclosed (null) one. */
function disclosed(value: number | null): number | null {
	return value !== null && Number.isFinite(value) ? value : null;
}

export function assessPricingPower(rawInputs: PricingPowerInputs): PricingPowerAssessment {
	// Normalized first so NaN/Infinity can never satisfy a corroboration check by comparing false.
	const inputs: PricingPowerInputs = {
		...rawInputs,
		priceRealizationPct: disclosed(rawInputs.priceRealizationPct),
		volumeGrowthPct: disclosed(rawInputs.volumeGrowthPct),
		grossMarginChangeBps: disclosed(rawInputs.grossMarginChangeBps),
		operatingMarginChangeBps: disclosed(rawInputs.operatingMarginChangeBps),
	};
	const missingInputs: PricingPowerInputName[] = [];
	if (inputs.priceRealizationPct === null) missingInputs.push("priceRealizationPct");
	if (inputs.volumeGrowthPct === null) missingInputs.push("volumeGrowthPct");
	if (inputs.grossMarginChangeBps === null) missingInputs.push("grossMarginChangeBps");
	if (inputs.managementCommentaryEvidenceIds.length === 0) {
		missingInputs.push("managementCommentary");
	}
	return {
		classification: classify(inputs),
		missingInputs,
		unexplainedRevenueResidualPct: residual(inputs),
	};
}
