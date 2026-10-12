import { err, ok, type Result } from "../result.ts";
import type { ActualOrEstimate, AdjustmentBasis, Money, ReportingPeriod } from "./types.ts";

export type PerError =
	| "NON_FINITE"
	| "NEGATIVE_PRICE"
	| "NON_POSITIVE_EPS"
	| "CURRENCY_MISMATCH"
	| "SECURITY_MISMATCH"
	| "ADJUSTMENT_BASIS_MISMATCH"
	| "EPS_BASIS_MISMATCH";

/**
 * Price / trailing EPS. Missing or non-positive EPS is an error, never a
 * "meaningful" positive ratio. Callers must separately guarantee both figures
 * describe the same security, currency and adjustment basis (see `computePer`).
 */
export function trailingPer(price: number, trailingEps: number): Result<number, PerError> {
	if (!Number.isFinite(price) || !Number.isFinite(trailingEps)) return err("NON_FINITE");
	if (price < 0) return err("NEGATIVE_PRICE");
	if (trailingEps <= 0) return err("NON_POSITIVE_EPS");
	const ratio = price / trailingEps;
	// A finite price over a denormal EPS overflows; that is not a reportable ratio.
	return Number.isFinite(ratio) ? ok(ratio) : err("NON_FINITE");
}

export type EpsBasis = "trailing" | "forward";

export interface PriceQuote {
	readonly securityId: string;
	readonly price: Money;
	readonly priceAsOf: string;
	readonly adjustmentBasis: AdjustmentBasis;
}

export interface EpsFigure {
	readonly securityId: string;
	readonly eps: Money;
	readonly basis: EpsBasis;
	readonly actualOrEstimate: ActualOrEstimate;
	readonly period: ReportingPeriod;
	readonly adjustmentBasis: AdjustmentBasis;
	readonly dilution: "basic" | "diluted";
}

export interface PerValue {
	readonly per: number;
	readonly formula: "price / EPS";
	readonly epsBasis: EpsBasis;
	readonly actualOrEstimate: ActualOrEstimate;
	readonly dilution: "basic" | "diluted";
	readonly currency: string;
	readonly priceAsOf: string;
	readonly earningsPeriod: ReportingPeriod;
	readonly adjustmentBasis: AdjustmentBasis;
}

/** PER with the qualifying metadata FR-006 requires; rejects mismatched inputs instead of guessing. */
export function computePer(quote: PriceQuote, eps: EpsFigure): Result<PerValue, PerError> {
	if (quote.securityId !== eps.securityId) return err("SECURITY_MISMATCH");
	if (quote.price.currency !== eps.eps.currency) return err("CURRENCY_MISMATCH");
	if (quote.adjustmentBasis !== eps.adjustmentBasis) return err("ADJUSTMENT_BASIS_MISMATCH");
	// Trailing EPS is by definition reported; forward EPS is by definition an estimate.
	const expected: ActualOrEstimate = eps.basis === "trailing" ? "actual" : "estimate";
	if (eps.actualOrEstimate !== expected) return err("EPS_BASIS_MISMATCH");
	const ratio = trailingPer(quote.price.amount, eps.eps.amount);
	if (!ratio.ok) return ratio;
	return ok({
		per: ratio.value,
		formula: "price / EPS",
		epsBasis: eps.basis,
		actualOrEstimate: eps.actualOrEstimate,
		dilution: eps.dilution,
		currency: quote.price.currency,
		priceAsOf: quote.priceAsOf,
		earningsPeriod: eps.period,
		adjustmentBasis: quote.adjustmentBasis,
	});
}
