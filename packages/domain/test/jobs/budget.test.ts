import { describe, expect, it } from "vitest";
import {
	addUsage,
	checkBudget,
	EMPTY_USAGE,
	type ResearchBudget,
	type ResourceUsage,
	summarizeCost,
} from "../../src/jobs/budget.ts";
import { deepFreeze } from "../support/deepFreeze.ts";

const budget: ResearchBudget = {
	maxAgentSteps: 6,
	maxToolCalls: 20,
	maxWallClockMs: 600_000,
	maxInputBytes: 400_000,
	maxSpendUsd: 2,
};

function usage(overrides: Partial<ResourceUsage> = {}): ResourceUsage {
	return { ...EMPTY_USAGE, ...overrides };
}

describe("addUsage", () => {
	it("starts from an empty, fully metered usage", () => {
		expect(EMPTY_USAGE).toEqual({
			agentSteps: 0,
			toolCalls: 0,
			inputBytes: 0,
			knownCostUsd: 0,
			hasUnmeteredUsage: false,
		});
	});

	it("adds each counter", () => {
		// 2 + 1 steps, 5 + 3 calls, 1_000 + 250 bytes, 0.5 + 0.25 USD
		const next = addUsage(
			usage({ agentSteps: 2, toolCalls: 5, inputBytes: 1000, knownCostUsd: 0.5 }),
			{ agentSteps: 1, toolCalls: 3, inputBytes: 250, costUsd: 0.25 },
		);
		expect(next).toEqual({
			agentSteps: 3,
			toolCalls: 8,
			inputBytes: 1250,
			knownCostUsd: 0.75,
			hasUnmeteredUsage: false,
		});
	});

	it("treats omitted counters as zero", () => {
		const start = usage({ agentSteps: 2, toolCalls: 5, inputBytes: 1000, knownCostUsd: 0.5 });
		expect(addUsage(start, {})).toEqual(start);
		expect(addUsage(start, { toolCalls: 1 })).toEqual({ ...start, toolCalls: 6 });
	});

	it("records an unknown cost as unmetered instead of adding zero silently", () => {
		const next = addUsage(usage({ knownCostUsd: 0.5 }), { agentSteps: 1, costUsd: null });
		expect(next.hasUnmeteredUsage).toBe(true);
		expect(next.knownCostUsd).toBe(0.5);
	});

	it("distinguishes a reported zero cost from an unknown cost", () => {
		expect(addUsage(EMPTY_USAGE, { costUsd: 0 }).hasUnmeteredUsage).toBe(false);
		expect(addUsage(EMPTY_USAGE, {}).hasUnmeteredUsage).toBe(false);
		expect(addUsage(EMPTY_USAGE, { costUsd: null }).hasUnmeteredUsage).toBe(true);
	});

	it("keeps the unmetered flag once set", () => {
		const unmetered = addUsage(EMPTY_USAGE, { costUsd: null });
		expect(addUsage(unmetered, { costUsd: 1 }).hasUnmeteredUsage).toBe(true);
		expect(addUsage(unmetered, {}).hasUnmeteredUsage).toBe(true);
	});

	it("does not mutate its arguments", () => {
		const start = deepFreeze(usage({ agentSteps: 1 }));
		const delta = deepFreeze({ agentSteps: 1, costUsd: null });
		expect(addUsage(start, delta)).not.toBe(start);
		expect(start.agentSteps).toBe(1);
	});
});

describe("checkBudget", () => {
	const ok = { ok: true, value: undefined };

	it("passes when usage is within every ceiling", () => {
		expect(checkBudget(budget, EMPTY_USAGE, 0)).toEqual(ok);
		expect(
			checkBudget(
				budget,
				usage({ agentSteps: 6, toolCalls: 20, inputBytes: 400_000, knownCostUsd: 2 }),
				599_999,
			),
		).toEqual(ok);
	});

	it("checks the planned step before it runs, so a ceiling is never overshot", () => {
		const atStepLimit = usage({ agentSteps: 6 });
		expect(checkBudget(budget, atStepLimit, 0)).toEqual(ok);
		expect(checkBudget(budget, atStepLimit, 0, { agentSteps: 1 })).toEqual({
			ok: false,
			error: "MAX_AGENT_STEPS",
		});
	});

	it("enforces the tool-call ceiling", () => {
		expect(checkBudget(budget, usage({ toolCalls: 20 }), 0, { toolCalls: 1 })).toEqual({
			ok: false,
			error: "MAX_TOOL_CALLS",
		});
		expect(checkBudget(budget, usage({ toolCalls: 19 }), 0, { toolCalls: 1 })).toEqual(ok);
	});

	it("enforces the wall-clock ceiling at the limit itself", () => {
		expect(checkBudget(budget, EMPTY_USAGE, 600_000)).toEqual({
			ok: false,
			error: "MAX_WALL_CLOCK",
		});
		expect(checkBudget(budget, EMPTY_USAGE, 900_000)).toEqual({
			ok: false,
			error: "MAX_WALL_CLOCK",
		});
	});

	it("enforces the input-size ceiling", () => {
		expect(checkBudget(budget, usage({ inputBytes: 399_000 }), 0, { inputBytes: 1001 })).toEqual({
			ok: false,
			error: "MAX_INPUT_BYTES",
		});
		expect(checkBudget(budget, usage({ inputBytes: 399_000 }), 0, { inputBytes: 1000 })).toEqual(
			ok,
		);
	});

	it("enforces the spend ceiling", () => {
		// 1.75 + 0.5 = 2.25 > 2
		expect(checkBudget(budget, usage({ knownCostUsd: 1.75 }), 0, { costUsd: 0.5 })).toEqual({
			ok: false,
			error: "MAX_SPEND",
		});
		// 1.75 + 0.25 = 2 = ceiling, still allowed
		expect(checkBudget(budget, usage({ knownCostUsd: 1.75 }), 0, { costUsd: 0.25 })).toEqual(ok);
	});

	it("allows no metered spend at all when none was authorized (AGT-012)", () => {
		const noSpend: ResearchBudget = { ...budget, maxSpendUsd: null };
		expect(checkBudget(noSpend, EMPTY_USAGE, 0, { costUsd: 0.01 })).toEqual({
			ok: false,
			error: "MAX_SPEND",
		});
		expect(checkBudget(noSpend, usage({ knownCostUsd: 0.000001 }), 0)).toEqual({
			ok: false,
			error: "MAX_SPEND",
		});
		expect(checkBudget(noSpend, EMPTY_USAGE, 0, { agentSteps: 1, costUsd: 0 })).toEqual(ok);
	});

	it("lets a plan-limited step with unknown cost proceed without counting it as spend", () => {
		const noSpend: ResearchBudget = { ...budget, maxSpendUsd: null };
		expect(checkBudget(noSpend, EMPTY_USAGE, 0, { agentSteps: 1, costUsd: null })).toEqual(ok);
	});

	it("does not mutate usage when projecting the next step", () => {
		const current = deepFreeze(usage({ agentSteps: 5 }));
		expect(checkBudget(budget, current, 0, { agentSteps: 1 })).toEqual(ok);
		expect(current.agentSteps).toBe(5);
	});
});

describe("summarizeCost (FR-016 / AGT-008)", () => {
	it("reports nothing spent when nothing ran", () => {
		expect(summarizeCost(EMPTY_USAGE)).toEqual({
			status: "none",
			totalCostUsd: 0,
			meteredPortionUsd: 0,
		});
	});

	it("reports the metered total when every step was metered", () => {
		expect(summarizeCost(usage({ agentSteps: 3, knownCostUsd: 0.42 }))).toEqual({
			status: "metered",
			totalCostUsd: 0.42,
			meteredPortionUsd: 0.42,
		});
	});

	it("reports a metered run that happened to cost nothing as metered $0", () => {
		expect(summarizeCost(usage({ agentSteps: 1, knownCostUsd: 0 }))).toEqual({
			status: "metered",
			totalCostUsd: 0,
			meteredPortionUsd: 0,
		});
	});

	it("never reports an unknown cost as $0", () => {
		expect(summarizeCost(usage({ agentSteps: 4, hasUnmeteredUsage: true }))).toEqual({
			status: "unknown-plan-limited",
			totalCostUsd: null,
			meteredPortionUsd: 0,
		});
	});

	it("keeps the known portion visible when only part of the usage was metered", () => {
		expect(
			summarizeCost(usage({ agentSteps: 4, knownCostUsd: 0.3, hasUnmeteredUsage: true })),
		).toEqual({ status: "unknown-plan-limited", totalCostUsd: null, meteredPortionUsd: 0.3 });
	});
});
