import { err, ok, type Result } from "../result.ts";

export type CagrError = "NON_FINITE" | "NON_POSITIVE_BASE" | "NEGATIVE_TARGET" | "INVALID_YEARS";

/** Compound annual growth rate as a ratio: (target / base)^(1 / years) - 1. */
export function deriveCagr(
	baseValue: number,
	targetValue: number,
	baseYear: number,
	targetYear: number,
): Result<number, CagrError> {
	if (![baseValue, targetValue, baseYear, targetYear].every(Number.isFinite)) {
		return err("NON_FINITE");
	}
	if (!Number.isInteger(baseYear) || !Number.isInteger(targetYear) || targetYear <= baseYear) {
		return err("INVALID_YEARS");
	}
	if (baseValue <= 0) return err("NON_POSITIVE_BASE");
	if (targetValue < 0) return err("NEGATIVE_TARGET");
	const years = targetYear - baseYear;
	const direct = (targetValue / baseValue) ** (1 / years) - 1;
	if (Number.isFinite(direct)) return ok(direct);
	// target / base can overflow although the growth rate itself is representable;
	// log space avoids the intermediate ratio.
	const viaLogs = Math.exp((Math.log(targetValue) - Math.log(baseValue)) / years) - 1;
	return Number.isFinite(viaLogs) ? ok(viaLogs) : err("NON_FINITE");
}
