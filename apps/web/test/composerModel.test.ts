import { type AgentSettings, agentsResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	type ComposerDraft,
	defaultComposerDraft,
	evaluateComposer,
} from "../src/chat/composerModel.ts";
import { AGENT_SETTINGS, AGENTS, NO_RUNNER_AGENTS, WORKSPACE_ID } from "./fixtures.ts";

const OPENCODE_AGENTS = agentsResponseSchema.parse({
	...AGENTS,
	agents: [
		...AGENTS.agents,
		{
			agentId: "opencode",
			displayName: "OpenCode",
			capabilities: { supported: ["cancel"] },
			costModel: "plan-limited",
			toolIsolation: "enforced",
			availability: { status: "available" },
		},
	],
});

function draft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
	return {
		...defaultComposerDraft(),
		question: "Where will storage demand grow?",
		...overrides,
	};
}

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
	return { ...AGENT_SETTINGS, ...overrides };
}

const METERED_SETTINGS = settings({
	defaultAgentId: "openrouter",
	models: { openrouter: "provider/model" },
	effort: "high",
	budget: { ...AGENT_SETTINGS.budget, maxSpendUsd: 3 },
	webAccess: "public-web",
});

describe("composer evaluation", () => {
	it("builds the research request from the saved agent settings", () => {
		const result = evaluateComposer(draft(), AGENTS, AGENT_SETTINGS, WORKSPACE_ID);
		expect(result.problems).toEqual([]);
		expect(result.model).toBeNull();
		expect(result.spendConsentRequired).toBe(false);
		expect(result.budget).toEqual(AGENT_SETTINGS.budget);
		expect(result.request).toEqual({
			workspaceId: WORKSPACE_ID,
			question: "Where will storage demand grow?",
			agentId: "claude-code",
			model: null,
			effort: "medium",
			horizonYears: 5,
			markets: ["JP", "US"],
			budget: AGENT_SETTINGS.budget,
			webAccess: "off",
		});
	});

	it("uses the stored model, effort, budget and web access", () => {
		const result = evaluateComposer(
			draft({ spendConsent: true }),
			AGENTS,
			METERED_SETTINGS,
			WORKSPACE_ID,
		);
		expect(result.problems).toEqual([]);
		expect(result.model).toBe("provider/model");
		expect(result.request?.agentId).toBe("openrouter");
		expect(result.request?.model).toBe("provider/model");
		expect(result.request?.effort).toBe("high");
		expect(result.request?.budget.maxSpendUsd).toBe(3);
		expect(result.request?.webAccess).toBe("public-web");
	});

	it("never sends a metered allowance for a plan-limited backend, whatever is stored", () => {
		const stored = settings({ budget: { ...AGENT_SETTINGS.budget, maxSpendUsd: 5 } });
		const result = evaluateComposer(draft(), AGENTS, stored, WORKSPACE_ID);
		expect(result.problems).toEqual([]);
		expect(result.budget?.maxSpendUsd).toBeNull();
		expect(result.request?.budget.maxSpendUsd).toBeNull();
		expect(result.spendConsentRequired).toBe(false);
	});

	it("asks for a default backend in Settings → AI agent when none is chosen", () => {
		const result = evaluateComposer(
			draft(),
			AGENTS,
			settings({ defaultAgentId: null }),
			WORKSPACE_ID,
		);
		expect(result.request).toBeNull();
		expect(result.problems).toContain("Choose a default agent backend in Settings → AI agent.");
	});

	it("cannot submit to an unavailable backend", () => {
		const result = evaluateComposer(
			draft(),
			AGENTS,
			settings({ defaultAgentId: "codex" }),
			WORKSPACE_ID,
		);
		expect(result.request).toBeNull();
		expect(
			result.problems.some((problem) => problem.includes("Codex is unavailable (NOT_INSTALLED)")),
		).toBe(true);
		expect(result.problems.every((problem) => problem.endsWith("in Settings → AI agent."))).toBe(
			true,
		);
	});

	it("cannot submit with OpenCode until a model is chosen in Settings", () => {
		const missing = evaluateComposer(
			draft(),
			OPENCODE_AGENTS,
			settings({ defaultAgentId: "opencode" }),
			WORKSPACE_ID,
		);
		expect(missing.request).toBeNull();
		expect(missing.problems).toContain(
			"OpenCode needs a model of the form provider/model — choose one in Settings → AI agent.",
		);

		const chosen = evaluateComposer(
			draft(),
			OPENCODE_AGENTS,
			settings({ defaultAgentId: "opencode", models: { opencode: "provider/model" } }),
			WORKSPACE_ID,
		);
		expect(chosen.problems).toEqual([]);
		expect(chosen.request?.model).toBe("provider/model");
	});

	it("cannot submit to a metered backend without a stored spend limit", () => {
		const result = evaluateComposer(
			draft({ spendConsent: true }),
			AGENTS,
			settings({ defaultAgentId: "openrouter", models: { openrouter: "provider/model" } }),
			WORKSPACE_ID,
		);
		expect(result.request).toBeNull();
		expect(result.spendConsentRequired).toBe(false);
		expect(result.problems).toContain(
			"A metered backend needs a maximum spend greater than 0 USD — set it in Settings → AI agent.",
		);
	});

	it("requires the one-time consent on the form for a metered run", () => {
		const unconsented = evaluateComposer(draft(), AGENTS, METERED_SETTINGS, WORKSPACE_ID);
		expect(unconsented.request).toBeNull();
		expect(unconsented.spendConsentRequired).toBe(true);
		expect(unconsented.problems).toEqual(["Confirm consent to metered spend on the form itself."]);

		const consented = evaluateComposer(
			draft({ spendConsent: true }),
			AGENTS,
			METERED_SETTINGS,
			WORKSPACE_ID,
		);
		expect(consented.request?.budget.maxSpendUsd).toBe(3);
	});

	it("can queue a question with no spend on a backend whose cost model is unknown", () => {
		const result = evaluateComposer(
			draft(),
			NO_RUNNER_AGENTS,
			settings({ defaultAgentId: "claude-code" }),
			WORKSPACE_ID,
		);
		expect(result.problems).toEqual([]);
		expect(result.request?.budget.maxSpendUsd).toBeNull();
	});

	it("waits for the agent list and the saved settings before allowing a submission", () => {
		const noAgents = evaluateComposer(draft(), null, AGENT_SETTINGS, WORKSPACE_ID);
		expect(noAgents.request).toBeNull();
		expect(noAgents.problems).toContain("Agent backends are still loading.");

		const noSettings = evaluateComposer(draft(), AGENTS, null, WORKSPACE_ID);
		expect(noSettings.request).toBeNull();
		expect(noSettings.problems).toContain("Agent settings are still loading.");
	});

	it("explains every reason submit is disabled, each with where to fix it", () => {
		const result = evaluateComposer(
			draft({ question: " a ", markets: { JP: false, US: false } }),
			AGENTS,
			settings({ defaultAgentId: null }),
			WORKSPACE_ID,
		);
		expect(result.request).toBeNull();
		expect(result.problems).toEqual([
			"Enter a research question (at least 3 characters).",
			"Choose a default agent backend in Settings → AI agent.",
			"Choose at least one market (JP or US).",
		]);
	});

	it("sends only the selected markets and a trimmed question", () => {
		const result = evaluateComposer(
			draft({ question: "  Battery demand?  ", markets: { JP: false, US: true }, horizonYears: 3 }),
			AGENTS,
			AGENT_SETTINGS,
			WORKSPACE_ID,
		);
		expect(result.request?.markets).toEqual(["US"]);
		expect(result.request?.question).toBe("Battery demand?");
		expect(result.request?.horizonYears).toBe(3);
	});

	it("carries no cost statement or cost model; limits and cost live in Settings → AI agent", () => {
		const result = evaluateComposer(draft(), AGENTS, AGENT_SETTINGS, WORKSPACE_ID);
		// Owner decision 2026-10-12: the composer shows the backend/model/effort
		// summary and the consent amount, never the limits or cost statement.
		expect("costStatement" in result).toBe(false);
		expect("costModel" in result).toBe(false);
		expect(result.request?.budget.maxSpendUsd).toBeNull();
	});
});
