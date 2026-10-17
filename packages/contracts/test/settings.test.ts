import { describe, expect, it } from "vitest";
import {
	agentSettingsResponseSchema,
	agentSettingsSchema,
	BUDGET_LIMITS,
	DEFAULT_AGENT_SETTINGS,
} from "../src/index.ts";
import { researchBudget } from "./fixtures.ts";
import { expectAccepted, expectRejected, without } from "./support.ts";

const validSettings = {
	defaultAgentId: "opencode",
	models: { opencode: "provider/model" },
	effort: "medium",
	budget: researchBudget,
	webAccess: "public-web",
} as const;

describe("agentSettingsSchema", () => {
	it("accepts the defaults", () => {
		const parsed = expectAccepted(agentSettingsSchema, DEFAULT_AGENT_SETTINGS);
		expect(parsed).toEqual(DEFAULT_AGENT_SETTINGS);
		expect(DEFAULT_AGENT_SETTINGS.defaultAgentId).toBeNull();
		expect(DEFAULT_AGENT_SETTINGS.models).toEqual({});
		expect(DEFAULT_AGENT_SETTINGS.effort).toBe("medium");
		expect(DEFAULT_AGENT_SETTINGS.webAccess).toBe("public-web");
		// Every question runs under the fixed limits, each at its maximum (ADR-0029).
		expect(DEFAULT_AGENT_SETTINGS.budget).toEqual({
			maxAgentSteps: BUDGET_LIMITS.maxAgentSteps.max,
			maxToolCalls: BUDGET_LIMITS.maxToolCalls.max,
			maxWallClockMs: BUDGET_LIMITS.maxWallClockMs.max,
			maxInputBytes: BUDGET_LIMITS.maxInputBytes.max,
			maxSpendUsd: null,
		});
	});

	it("accepts a null backend and an empty model map", () => {
		expectAccepted(agentSettingsSchema, { ...validSettings, defaultAgentId: null, models: {} });
	});

	it("rejects unknown keys", () => {
		expectRejected(agentSettingsSchema, { ...validSettings, theme: "dark" });
	});

	it("rejects an out-of-range budget", () => {
		expectRejected(agentSettingsSchema, {
			...validSettings,
			budget: { ...researchBudget, maxAgentSteps: BUDGET_LIMITS.maxAgentSteps.max + 1 },
		});
		expectRejected(agentSettingsSchema, {
			...validSettings,
			budget: { ...researchBudget, maxSpendUsd: 50.01 },
		});
	});

	it("rejects a bad agent id key in models", () => {
		expectRejected(agentSettingsSchema, {
			...validSettings,
			models: { "Claude Code": "provider/model" },
		});
	});

	it("rejects 17 models", () => {
		const models: Record<string, string> = {};
		for (let index = 0; index < 17; index += 1) {
			models[`backend-${index}`] = "provider/model";
		}
		expectRejected(agentSettingsSchema, { ...validSettings, models }, ["models"]);
	});

	it("accepts 16 models", () => {
		const models: Record<string, string> = {};
		for (let index = 0; index < 16; index += 1) {
			models[`backend-${index}`] = "provider/model";
		}
		expectAccepted(agentSettingsSchema, { ...validSettings, models });
	});

	it("requires every field", () => {
		for (const key of ["defaultAgentId", "models", "effort", "budget", "webAccess"] as const) {
			expectRejected(agentSettingsSchema, without(validSettings, key));
		}
	});
});

describe("agentSettingsResponseSchema", () => {
	it("accepts stored settings and defaults with a null timestamp", () => {
		expectAccepted(agentSettingsResponseSchema, {
			settings: validSettings,
			updatedAt: "2026-10-11T00:00:00.000Z",
			origin: "saved",
		});
		expectAccepted(agentSettingsResponseSchema, {
			settings: DEFAULT_AGENT_SETTINGS,
			updatedAt: null,
			origin: "defaults",
		});
		expectAccepted(agentSettingsResponseSchema, {
			settings: validSettings,
			updatedAt: null,
			origin: "carried-over",
		});
	});

	it("requires the origin so the UI can say which settings it is showing", () => {
		expectRejected(agentSettingsResponseSchema, {
			settings: validSettings,
			updatedAt: null,
		});
		expectRejected(agentSettingsResponseSchema, {
			settings: validSettings,
			updatedAt: null,
			origin: "remembered",
		});
	});
});
