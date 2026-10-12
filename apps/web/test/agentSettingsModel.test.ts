import { agentsResponseSchema, DEFAULT_AGENT_SETTINGS } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	type AgentSettingsDraft,
	agentOptions,
	type BudgetDraft,
	backendRequiresModel,
	buildModelSelectOptions,
	costStatement,
	defaultBudgetDraft,
	evaluateAgentSettings,
	evaluateBudget,
	FREE_TIER_CAUTION,
	groupModelsByProvider,
	isFreeTierModelId,
	isSettingsDraftChanged,
	MODEL_OTHER_VALUE,
	modelSelectValue,
	reportedModels,
	runnerNotice,
	settingsDraftFrom,
} from "../src/settings/agentSettingsModel.ts";
import { AGENT_SETTINGS, AGENTS, NO_RUNNER_AGENTS } from "./fixtures.ts";

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

function budget(overrides: Partial<BudgetDraft> = {}): BudgetDraft {
	return { ...defaultBudgetDraft(), ...overrides };
}

const MODELS_AGENTS = agentsResponseSchema.parse({
	...AGENTS,
	agents: AGENTS.agents.map((agent) =>
		agent.agentId === "claude-code"
			? { ...agent, capabilities: { ...agent.capabilities, models: ["b-model", "a-model"] } }
			: agent,
	),
});

function settingsDraft(overrides: Partial<AgentSettingsDraft> = {}): AgentSettingsDraft {
	return {
		...settingsDraftFrom(AGENT_SETTINGS),
		...overrides,
	};
}

describe("agent options", () => {
	it("lists every reported backend and lets only available ones be chosen", () => {
		const options = agentOptions(AGENTS);
		expect(options.map((option) => [option.agentId, option.selectable])).toEqual([
			["claude-code", true],
			["openrouter", true],
			["codex", false],
		]);
		const codex = options[2];
		expect(codex?.status).toBe("unavailable (NOT_INSTALLED)");
		expect(codex?.detail).toBe("Unavailable — NOT_INSTALLED: codex binary not found on PATH");
	});

	it("offers the baseline backends with unknown availability when no runner ever reported", () => {
		const options = agentOptions(NO_RUNNER_AGENTS);
		expect(options.map((option) => option.agentId)).toEqual([
			"opencode",
			"codex",
			"claude-code",
			"openrouter",
		]);
		expect(options.every((option) => option.selectable && option.costModel === "unknown")).toBe(
			true,
		);
		expect(options[0]?.detail).toContain("no runner has reported");
	});

	it("says the runner is offline and that the question will be queued", () => {
		expect(runnerNotice(AGENTS)).toBeNull();
		expect(runnerNotice(NO_RUNNER_AGENTS)).toContain("no runner has ever reported in");
		expect(runnerNotice(NO_RUNNER_AGENTS)).toContain("will be queued");
		const offline = runnerNotice({ ...AGENTS, runnerOnline: false });
		expect(offline).toContain("Runner offline (last seen 2026-10-05 00:00 UTC)");
		expect(offline).toContain("will be queued");
	});
});

describe("cost statement (FR-016)", () => {
	it("never presents a plan-limited backend as free", () => {
		const text = costStatement("plan-limited");
		expect(text).toContain("Cost unknown — limited by your plan");
		expect(text).not.toMatch(/\$\s?0|free of charge|no cost/i);
	});

	it("tells the owner a metered backend needs a spend limit and consent", () => {
		const text = costStatement("metered");
		expect(text).toContain("maximum spend greater than 0");
		expect(text).toContain("no paid fallback without consent");
	});

	it("does not guess the cost model of an unreported backend", () => {
		expect(costStatement("unknown")).toContain("Cost model unknown");
	});
});

describe("budget evaluation", () => {
	it("accepts the default limits for a plan-limited backend with no spend authorized", () => {
		expect(evaluateBudget(budget(), "plan-limited")).toEqual({
			budget: {
				maxAgentSteps: 6,
				maxToolCalls: 20,
				maxWallClockMs: 600_000,
				maxInputBytes: 400_000,
				maxSpendUsd: null,
			},
			problems: [],
			spendConsentRequired: false,
		});
	});

	it("ignores a typed spend for a plan-limited backend instead of authorizing it", () => {
		const result = evaluateBudget(
			budget({ maxSpendUsd: "25", spendConsent: true }),
			"plan-limited",
		);
		expect(result.budget?.maxSpendUsd).toBeNull();
		expect(result.spendConsentRequired).toBe(false);
	});

	it("blocks a metered backend with no spend limit", () => {
		const result = evaluateBudget(budget(), "metered");
		expect(result.budget).toBeNull();
		expect(result.spendConsentRequired).toBe(true);
		expect(result.problems).toContain(
			"A metered backend needs a maximum spend greater than 0 USD.",
		);
	});

	it("blocks a metered backend with a spend limit but no consent", () => {
		const result = evaluateBudget(budget({ maxSpendUsd: "2.5" }), "metered");
		expect(result.budget).toBeNull();
		expect(result.problems).toEqual(["Confirm consent to metered spend before submitting."]);
	});

	it.each([
		"0",
		"-1",
		"50.01",
		"abc",
	])("rejects a metered spend of %s even with consent", (spend) => {
		const result = evaluateBudget(budget({ maxSpendUsd: spend, spendConsent: true }), "metered");
		expect(result.budget).toBeNull();
		expect(result.problems).toContain("Max spend must be greater than 0 and at most 50 USD.");
	});

	it("authorizes exactly the consented spend for a metered backend", () => {
		const result = evaluateBudget(budget({ maxSpendUsd: "2.5", spendConsent: true }), "metered");
		expect(result.problems).toEqual([]);
		expect(result.budget?.maxSpendUsd).toBe(2.5);
	});

	it("requires consent before any spend on a backend whose cost model is unknown", () => {
		expect(evaluateBudget(budget(), "unknown").budget?.maxSpendUsd).toBeNull();
		const withSpend = evaluateBudget(budget({ maxSpendUsd: "1" }), "unknown");
		expect(withSpend.budget).toBeNull();
		expect(withSpend.spendConsentRequired).toBe(true);
	});

	it("stores a spend without consent when the settings form validates (AGT-012)", () => {
		const result = evaluateBudget(budget({ maxSpendUsd: "2.5" }), "metered", {
			requireConsent: false,
		});
		expect(result.problems).toEqual([]);
		expect(result.budget?.maxSpendUsd).toBe(2.5);
		expect(result.spendConsentRequired).toBe(false);
	});

	it("converts wall-clock minutes to milliseconds", () => {
		const result = evaluateBudget(budget({ maxWallClockMinutes: "0.5" }), "plan-limited");
		expect(result.budget?.maxWallClockMs).toBe(30_000);
	});

	it.each([
		[{ maxAgentSteps: "0" }, "Max agent steps must be a whole number from 1 to 12."],
		[{ maxAgentSteps: "13" }, "Max agent steps must be a whole number from 1 to 12."],
		[{ maxAgentSteps: "2.5" }, "Max agent steps must be a whole number from 1 to 12."],
		[{ maxToolCalls: "61" }, "Max tool calls must be a whole number from 0 to 60."],
		[{ maxToolCalls: "" }, "Max tool calls must be a whole number from 0 to 60."],
		[{ maxWallClockMinutes: "31" }, "Max wall-clock minutes must be a number from 0.5 to 30."],
		[{ maxInputBytes: "9999" }, "Max input bytes must be a whole number from 10000 to 2000000."],
	])("rejects out-of-range limits %o", (change, problem) => {
		const result = evaluateBudget(budget(change), "plan-limited");
		expect(result.budget).toBeNull();
		expect(result.problems).toEqual([problem]);
	});
});

describe("settings draft", () => {
	it("converts stored numbers to editable text", () => {
		expect(settingsDraftFrom(AGENT_SETTINGS)).toEqual({
			defaultAgentId: "claude-code",
			models: {},
			effort: "medium",
			budget: {
				maxAgentSteps: "6",
				maxToolCalls: "20",
				maxWallClockMinutes: "10",
				maxInputBytes: "400000",
				maxSpendUsd: "",
				spendConsent: false,
			},
			webAccess: "off",
		});
	});

	it("starts unchosen from the defaults", () => {
		const draft = settingsDraftFrom(DEFAULT_AGENT_SETTINGS);
		expect(draft.defaultAgentId).toBe("");
		expect(evaluateAgentSettings(draft, AGENTS).problems).toContain(
			"Choose a default agent backend.",
		);
	});

	it("waits for the agent list before allowing a save", () => {
		const result = evaluateAgentSettings(settingsDraft(), null);
		expect(result.settings).toBeNull();
		expect(result.problems).toContain("Agent backends are still loading.");
	});

	it("builds the contract shape for a valid plan-limited draft", () => {
		const result = evaluateAgentSettings(settingsDraft(), AGENTS);
		expect(result.problems).toEqual([]);
		expect(result.costModel).toBe("plan-limited");
		expect(result.spendEditable).toBe(false);
		expect(result.modelText).toBe("");
		expect(result.settings).toEqual(AGENT_SETTINGS);
	});

	it("cannot save to an unavailable backend", () => {
		const result = evaluateAgentSettings(settingsDraft({ defaultAgentId: "codex" }), AGENTS);
		expect(result.settings).toBeNull();
		expect(result.problems).toContain("Codex is unavailable (NOT_INSTALLED) and cannot be used.");
	});

	it("blocks OpenCode without a model", () => {
		const draft = settingsDraft({ defaultAgentId: "opencode" });
		const missing = evaluateAgentSettings(draft, OPENCODE_AGENTS);
		expect(missing.settings).toBeNull();
		expect(
			missing.problems.some((problem) =>
				problem.includes(
					"OpenCode needs a model of the form provider/model — without one it cannot run.",
				),
			),
		).toBe(true);
		expect(missing.problems.some((problem) => problem.includes("list the runner reported"))).toBe(
			true,
		);

		const wrongShape = evaluateAgentSettings(
			settingsDraft({ defaultAgentId: "opencode", models: { opencode: "just-a-name" } }),
			OPENCODE_AGENTS,
		);
		expect(wrongShape.settings).toBeNull();
		expect(wrongShape.problems).toContain("The OpenCode model must have the form provider/model.");

		const valid = evaluateAgentSettings(
			settingsDraft({ defaultAgentId: "opencode", models: { opencode: "provider/model" } }),
			OPENCODE_AGENTS,
		);
		expect(valid.problems).toEqual([]);
		expect(valid.settings?.models).toEqual({ opencode: "provider/model" });
	});

	it("keeps each backend's model when switching backends", () => {
		const draft = settingsDraft({
			defaultAgentId: "openrouter",
			models: { "claude-code": "custom/model", openrouter: "other/model" },
		});
		expect(evaluateAgentSettings(draft, AGENTS).modelText).toBe("other/model");
		const switched = evaluateAgentSettings({ ...draft, defaultAgentId: "claude-code" }, AGENTS);
		expect(switched.modelText).toBe("custom/model");
	});

	it("drops an emptied model entry instead of storing it", () => {
		const result = evaluateAgentSettings(
			settingsDraft({ models: { "claude-code": "   " } }),
			AGENTS,
		);
		expect(result.problems).toEqual([]);
		expect(result.settings?.models).toEqual({});
	});

	it("rejects a model longer than the contract allows", () => {
		const result = evaluateAgentSettings(
			settingsDraft({ models: { "claude-code": `${"m".repeat(100)}/x` } }),
			AGENTS,
		);
		expect(result.settings).toBeNull();
		expect(result.problems).toContain("The model must be at most 100 characters.");
	});

	it("requires a spend for a metered backend but not for an unknown one", () => {
		const metered = evaluateAgentSettings(settingsDraft({ defaultAgentId: "openrouter" }), AGENTS);
		expect(metered.settings).toBeNull();
		expect(metered.spendEditable).toBe(true);
		expect(metered.problems).toContain(
			"A metered backend needs a maximum spend greater than 0 USD.",
		);

		const meteredWithSpend = evaluateAgentSettings(
			settingsDraft({
				defaultAgentId: "openrouter",
				models: { openrouter: "provider/model" },
				budget: budget({ maxSpendUsd: "2.5" }),
			}),
			AGENTS,
		);
		expect(meteredWithSpend.problems).toEqual([]);
		expect(meteredWithSpend.settings?.budget.maxSpendUsd).toBe(2.5);

		const unknown = evaluateAgentSettings(
			settingsDraft({ defaultAgentId: "claude-code" }),
			NO_RUNNER_AGENTS,
		);
		expect(unknown.problems).toEqual([]);
		expect(unknown.spendEditable).toBe(true);
		expect(unknown.settings?.budget.maxSpendUsd).toBeNull();
	});

	it("never stores a metered allowance for a plan-limited backend", () => {
		const result = evaluateAgentSettings(
			settingsDraft({ budget: budget({ maxSpendUsd: "25" }) }),
			AGENTS,
		);
		expect(result.problems).toEqual([]);
		expect(result.settings?.budget.maxSpendUsd).toBeNull();
	});
	it("rejects out-of-range limits", () => {
		const result = evaluateAgentSettings(
			settingsDraft({ budget: budget({ maxAgentSteps: "99" }) }),
			AGENTS,
		);
		expect(result.settings).toBeNull();
		expect(result.problems).toEqual(["Max agent steps must be a whole number from 1 to 12."]);
	});
});

describe("runner-reported models", () => {
	it("returns null while the list loads, for unknown backends, or when the backend lists none", () => {
		expect(reportedModels(null, "claude-code")).toBeNull();
		expect(reportedModels(AGENTS, "claude-code")).toBeNull();
		expect(reportedModels(AGENTS, "unknown-backend")).toBeNull();
		expect(reportedModels(NO_RUNNER_AGENTS, "claude-code")).toBeNull();
	});

	it("returns the reported ids for the backend that lists them", () => {
		expect(reportedModels(MODELS_AGENTS, "claude-code")).toEqual(["b-model", "a-model"]);
		expect(reportedModels(MODELS_AGENTS, "openrouter")).toBeNull();
	});

	it("reaches the form through the settings evaluation", () => {
		expect(evaluateAgentSettings(settingsDraft(), AGENTS).reportedModels).toBeNull();
		expect(evaluateAgentSettings(settingsDraft(), null).reportedModels).toBeNull();
		expect(evaluateAgentSettings(settingsDraft(), MODELS_AGENTS).reportedModels).toEqual([
			"b-model",
			"a-model",
		]);
	});

	it("says where the OpenCode model list comes from when it blocks saving", () => {
		const missing = evaluateAgentSettings(
			settingsDraft({ defaultAgentId: "opencode" }),
			OPENCODE_AGENTS,
		);
		expect(missing.problems.some((problem) => problem.includes("list the runner reported"))).toBe(
			true,
		);
	});
});

describe("model selector options", () => {
	it("groups by provider with providers and ids sorted", () => {
		expect(groupModelsByProvider(["b/b", "a/z", "a/a", "b/a"])).toEqual([
			{ provider: "a", models: ["a/a", "a/z"] },
			{ provider: "b", models: ["b/a", "b/b"] },
		]);
	});

	it("puts ids without a slash in group other", () => {
		expect(groupModelsByProvider(["plain", "a/x"])).toEqual([
			{ provider: "a", models: ["a/x"] },
			{ provider: "other", models: ["plain"] },
		]);
	});

	it("removes duplicates and never lists the Other sentinel", () => {
		const groups = groupModelsByProvider(["a/x", "a/x", MODEL_OTHER_VALUE]);
		expect(groups).toEqual([{ provider: "a", models: ["a/x"] }]);
	});

	it("uses Choose for a backend that requires a model and Backend default otherwise", () => {
		expect(backendRequiresModel("opencode")).toBe(true);
		expect(backendRequiresModel("claude-code")).toBe(false);
		expect(buildModelSelectOptions(["b/a"], "", true).firstOptionLabel).toBe("Choose a model…");
		expect(buildModelSelectOptions(["b/a"], "", false).firstOptionLabel).toBe("Backend default");
	});

	it("keeps a saved-but-unlisted model exactly when it is not reported", () => {
		expect(buildModelSelectOptions(["a/x"], "a/x", true).savedModel).toBeNull();
		expect(buildModelSelectOptions(["a/x"], "kept/y", true).savedModel).toBe("kept/y");
		expect(buildModelSelectOptions(["a/x"], "", true).savedModel).toBeNull();
		expect(buildModelSelectOptions(["a/x"], ` ${"kept/y"} `, true).savedModel).toBe("kept/y");
	});

	it("falls back to first plus Other when no models are reported", () => {
		for (const reported of [null, []] as const) {
			const optional = buildModelSelectOptions(reported, "", false);
			expect(optional.firstOptionLabel).toBe("Backend default");
			expect(optional.groups).toEqual([]);
			expect(optional.savedModel).toBeNull();
			const required = buildModelSelectOptions(reported, "", true);
			expect(required.firstOptionLabel).toBe("Choose a model…");
			expect(required.groups).toEqual([]);
		}
	});

	it("maps the current choice to the select value with the Other flag", () => {
		expect(modelSelectValue("", false)).toBe("");
		expect(modelSelectValue("a/x", false)).toBe("a/x");
		expect(modelSelectValue("kept/y", false)).toBe("kept/y");
		expect(modelSelectValue("a/x", true)).toBe(MODEL_OTHER_VALUE);
		expect(modelSelectValue("", true)).toBe(MODEL_OTHER_VALUE);
	});

	it("detects free-tier ids by their -free suffix", () => {
		expect(isFreeTierModelId("provider/model-free")).toBe(true);
		expect(isFreeTierModelId("provider/model")).toBe(false);
		expect(isFreeTierModelId("")).toBe(false);
		expect(FREE_TIER_CAUTION).toContain("every tool call rejected");
	});
});

describe("settings change detection", () => {
	it("is unchanged when nothing was edited, changed after an edit, unchanged after reverting", () => {
		const fresh = settingsDraftFrom(AGENT_SETTINGS);
		expect(isSettingsDraftChanged(fresh, AGENT_SETTINGS)).toBe(false);
		const edited = { ...fresh, effort: "high" as const };
		expect(isSettingsDraftChanged(edited, AGENT_SETTINGS)).toBe(true);
		expect(isSettingsDraftChanged({ ...edited, effort: "medium" as const }, AGENT_SETTINGS)).toBe(
			false,
		);
	});

	it("notices model and budget edits", () => {
		const fresh = settingsDraftFrom(AGENT_SETTINGS);
		expect(
			isSettingsDraftChanged(
				{ ...fresh, models: { "claude-code": "custom/model" } },
				AGENT_SETTINGS,
			),
		).toBe(true);
		expect(
			isSettingsDraftChanged(
				{ ...fresh, budget: { ...fresh.budget, maxSpendUsd: "3" } },
				AGENT_SETTINGS,
			),
		).toBe(true);
	});
});
