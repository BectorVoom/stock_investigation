import { err, ok, type Result } from "../result.ts";

/** Owner-set ceilings for one research run (FR-016 / AGT-008). */
export interface ResearchBudget {
	readonly maxAgentSteps: number;
	readonly maxToolCalls: number;
	readonly maxWallClockMs: number;
	readonly maxInputBytes: number;
	/** null = no spending cap. */
	readonly maxSpendUsd: number | null;
}

export interface ResourceUsage {
	readonly agentSteps: number;
	readonly toolCalls: number;
	readonly inputBytes: number;
	/** Sum of the costs the provider actually reported. */
	readonly knownCostUsd: number;
	/** True once any step ran whose cost the provider could not report. */
	readonly hasUnmeteredUsage: boolean;
}

export const EMPTY_USAGE: ResourceUsage = {
	agentSteps: 0,
	toolCalls: 0,
	inputBytes: 0,
	knownCostUsd: 0,
	hasUnmeteredUsage: false,
};

export type BudgetLimit =
	| "MAX_AGENT_STEPS"
	| "MAX_TOOL_CALLS"
	| "MAX_WALL_CLOCK"
	| "MAX_INPUT_BYTES"
	| "MAX_SPEND";

export interface UsageDelta {
	readonly agentSteps?: number;
	readonly toolCalls?: number;
	readonly inputBytes?: number;
	/** number = metered cost for this step; null = the step ran but its cost is unknown. */
	readonly costUsd?: number | null;
}

/** A usable increment: finite and non-negative. Anything else counts as zero. */
function increment(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Usage only ever grows. A negative or non-finite increment is ignored, and a
 * cost that is not a finite non-negative number is treated as unknown rather
 * than silently reducing or corrupting the total.
 */
export function addUsage(usage: ResourceUsage, delta: UsageDelta): ResourceUsage {
	const cost = delta.costUsd;
	const costIsUnknown =
		cost === null || (cost !== undefined && (!Number.isFinite(cost) || cost < 0));
	return {
		agentSteps: usage.agentSteps + increment(delta.agentSteps),
		toolCalls: usage.toolCalls + increment(delta.toolCalls),
		inputBytes: usage.inputBytes + increment(delta.inputBytes),
		knownCostUsd: usage.knownCostUsd + (costIsUnknown ? 0 : increment(cost ?? undefined)),
		hasUnmeteredUsage: usage.hasUnmeteredUsage || costIsUnknown,
	};
}

/**
 * Checks whether `usage` plus the `next` planned step stays within budget.
 * Call before performing the step so a limit is never overshot.
 */
export function checkBudget(
	budget: ResearchBudget,
	usage: ResourceUsage,
	elapsedMs: number,
	next: UsageDelta = {},
): Result<void, BudgetLimit> {
	const projected = addUsage(usage, next);
	// Each comparison is written so that NaN fails it: a corrupt counter is over budget, not under.
	if (!(projected.agentSteps <= budget.maxAgentSteps)) return err("MAX_AGENT_STEPS");
	if (!(projected.toolCalls <= budget.maxToolCalls)) return err("MAX_TOOL_CALLS");
	if (!(elapsedMs < budget.maxWallClockMs)) return err("MAX_WALL_CLOCK");
	if (!(projected.inputBytes <= budget.maxInputBytes)) return err("MAX_INPUT_BYTES");
	if (budget.maxSpendUsd !== null && !(projected.knownCostUsd <= budget.maxSpendUsd)) {
		return err("MAX_SPEND");
	}
	return ok(undefined);
}

export type CostStatus = "none" | "metered" | "unknown-plan-limited";

export interface CostSummary {
	readonly status: CostStatus;
	/** null whenever any usage was unmetered: an unknown cost is never reported as $0. */
	readonly totalCostUsd: number | null;
	readonly meteredPortionUsd: number;
}

export function summarizeCost(usage: ResourceUsage): CostSummary {
	if (usage.hasUnmeteredUsage) {
		return {
			status: "unknown-plan-limited",
			totalCostUsd: null,
			meteredPortionUsd: usage.knownCostUsd,
		};
	}
	const ran = usage.agentSteps > 0 || usage.knownCostUsd > 0;
	return {
		status: ran ? "metered" : "none",
		totalCostUsd: usage.knownCostUsd,
		meteredPortionUsd: usage.knownCostUsd,
	};
}
