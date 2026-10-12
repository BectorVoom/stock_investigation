import { err, ok, type Result } from "../result.ts";
import { deriveCagr } from "./cagr.ts";

export const MIN_HORIZON_YEARS = 3;
export const MAX_HORIZON_YEARS = 5;

export interface ScenarioCase {
	readonly targetValue: number;
	readonly assumptions: readonly string[];
}

/** What a quantity measures; unit demand, revenue and price growth must not be conflated. */
export type DemandQuantityKind = "unit-demand" | "revenue" | "price";

export interface DemandScenarioInput {
	readonly productOrService: string;
	readonly quantityKind: DemandQuantityKind;
	readonly unit: string;
	readonly baseYear: number;
	readonly targetYear: number;
	/** null when no sourced baseline exists; CAGR is then not derivable. */
	readonly baselineValue: number | null;
	readonly bear: ScenarioCase;
	readonly base: ScenarioCase;
	readonly bull: ScenarioCase;
	readonly drivers: readonly string[];
	readonly barriers: readonly string[];
	readonly falsifiers: readonly string[];
	readonly methodology: string;
}

export type DemandScenarioError =
	| "MISSING_UNIT"
	| "MISSING_METHODOLOGY"
	| "HORIZON_OUT_OF_RANGE"
	| "SCENARIO_ORDER_INVALID"
	| "MISSING_DRIVERS"
	| "MISSING_FALSIFIERS"
	| "MISSING_ASSUMPTIONS"
	| "NON_FINITE";

export interface DerivedScenarioCagr {
	readonly bear: number | null;
	readonly base: number | null;
	readonly bull: number | null;
}

function cagrOrNull(input: DemandScenarioInput, targetValue: number): number | null {
	if (input.baselineValue === null) return null;
	const cagr = deriveCagr(input.baselineValue, targetValue, input.baseYear, input.targetYear);
	return cagr.ok ? cagr.value : null;
}

/** Validates a scenario's structural invariants (DATA-009) and derives nullable CAGRs. */
export function deriveScenarioCagr(
	input: DemandScenarioInput,
): Result<DerivedScenarioCagr, readonly DemandScenarioError[]> {
	const errors: DemandScenarioError[] = [];
	const cases = [input.bear, input.base, input.bull];
	if (input.unit.trim() === "") errors.push("MISSING_UNIT");
	if (input.methodology.trim() === "") errors.push("MISSING_METHODOLOGY");
	const horizon = input.targetYear - input.baseYear;
	if (!Number.isInteger(horizon) || horizon < MIN_HORIZON_YEARS || horizon > MAX_HORIZON_YEARS) {
		errors.push("HORIZON_OUT_OF_RANGE");
	}
	if (!cases.every((scenarioCase) => Number.isFinite(scenarioCase.targetValue))) {
		errors.push("NON_FINITE");
	} else if (
		input.bear.targetValue > input.base.targetValue ||
		input.base.targetValue > input.bull.targetValue
	) {
		errors.push("SCENARIO_ORDER_INVALID");
	}
	if (input.drivers.length === 0) errors.push("MISSING_DRIVERS");
	if (input.falsifiers.length === 0) errors.push("MISSING_FALSIFIERS");
	if (cases.some((scenarioCase) => scenarioCase.assumptions.length === 0)) {
		errors.push("MISSING_ASSUMPTIONS");
	}
	if (errors.length > 0) return err(errors);
	return ok({
		bear: cagrOrNull(input, input.bear.targetValue),
		base: cagrOrNull(input, input.base.targetValue),
		bull: cagrOrNull(input, input.bull.targetValue),
	});
}
