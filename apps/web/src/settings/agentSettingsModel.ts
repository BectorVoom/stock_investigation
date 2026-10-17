import {
	type AgentDescriptor,
	type AgentSettings,
	type AgentsResponse,
	BASELINE_AGENT_IDS,
	BUDGET_LIMITS,
	isFreeTierModelId,
	isOpenRouterFreeModelId,
	OPENROUTER_FREE_AGENT_ID,
	type ResearchRequest,
	runBudget,
	type WebAccess,
} from "@research/contracts";
import type { ResearchBudget } from "../api/client.ts";
import { formatInstant } from "../lib/format.ts";

/**
 * Pure agent-settings rules (FR-012 / FR-016 / AGT-012): which backends can be
 * chosen, what the cost statement says, how the settings form validates, and
 * how the question form builds its request from the saved settings. No Solid,
 * no network — unit-tested directly. This is the single home of the backend
 * options, the availability list content and the budget-text rules; the
 * composer and the approval form import from here (ARCH-010).
 */

/** "unknown" = no runner has reported this backend, so how it bills is not known. */
export type CostModelView = AgentDescriptor["costModel"] | "unknown";

/**
 * The only per-question ceiling the owner edits: the maximum spend, which is
 * their consent to metered cost (AGT-012). The other limits are fixed
 * (RUN_LIMITS, ADR-0029). The amount stays as typed text until it validates.
 */
export interface SpendDraft {
	/** Empty = no metered spend authorized. */
	readonly maxSpendUsd: string;
	readonly spendConsent: boolean;
}

export function defaultSpendDraft(): SpendDraft {
	return { maxSpendUsd: "", spendConsent: false };
}

export function spendDraftFrom(budget: ResearchBudget): SpendDraft {
	return {
		maxSpendUsd: budget.maxSpendUsd === null ? "" : String(budget.maxSpendUsd),
		// Consent is never carried over: it is given again for each submission.
		spendConsent: false,
	};
}

export interface AgentOption {
	readonly agentId: string;
	readonly displayName: string;
	readonly selectable: boolean;
	readonly costModel: CostModelView;
	/** Short status for the option label, e.g. "available" or "unavailable (NOT_INSTALLED)". */
	readonly status: string;
	/** Longer explanation shown in the availability list. */
	readonly detail: string;
}

const BASELINE_DISPLAY_NAMES: { readonly [Id in (typeof BASELINE_AGENT_IDS)[number]]: string } = {
	opencode: "OpenCode",
	codex: "Codex",
	"claude-code": "Claude Code",
	openrouter: "OpenRouter",
};

const COST_MODEL_TEXT: { readonly [M in CostModelView]: string } = {
	"plan-limited": "plan-limited (cost unknown)",
	metered: "metered (billed per use)",
	unknown: "cost model unknown",
};

function describeAgent(agent: AgentDescriptor): AgentOption {
	const isolationNote =
		agent.toolIsolation === "enforced" ? "tool isolation enforced" : "tool isolation unverified";
	if (agent.availability.status === "available") {
		return {
			agentId: agent.agentId,
			displayName: agent.displayName,
			selectable: true,
			costModel: agent.costModel,
			status: "available",
			detail: `Available — ${COST_MODEL_TEXT[agent.costModel]}; ${isolationNote}.`,
		};
	}
	return {
		agentId: agent.agentId,
		displayName: agent.displayName,
		selectable: false,
		costModel: agent.costModel,
		status: `unavailable (${agent.availability.reasonCode})`,
		detail: `Unavailable — ${agent.availability.reasonCode}${agent.availability.detail === "" ? "" : `: ${agent.availability.detail}`}`,
	};
}

/**
 * Backends the owner can see. Unavailable ones stay listed with their reason
 * but cannot be chosen. When no runner has ever reported, the baseline
 * backends are offered with their availability stated as unknown so a question
 * can still be queued.
 */
export function agentOptions(agents: AgentsResponse | null): readonly AgentOption[] {
	if (agents === null) return [];
	if (agents.agents.length > 0) return agents.agents.map(describeAgent);
	return BASELINE_AGENT_IDS.map((agentId) => ({
		agentId,
		displayName: BASELINE_DISPLAY_NAMES[agentId],
		selectable: true,
		costModel: "unknown",
		status: "availability unknown",
		detail: "Availability unknown — no runner has reported this backend yet.",
	}));
}

/**
 * Model ids the runner reported for a backend (`capabilities.models`), or
 * null when the backend cannot list them. The settings form offers them as a
 * selector grouped by provider; an id the runner did not list can still be
 * typed through the "Other" option.
 */
export function reportedModels(
	agents: AgentsResponse | null,
	agentId: string,
): readonly string[] | null {
	if (agents === null) return null;
	const descriptor = agents.agents.find((agent) => agent.agentId === agentId);
	const models = descriptor?.capabilities.models;
	return models === undefined ? null : [...models];
}

/** OpenCode and the free backend require a model; other backends have their own default. */
export function backendRequiresModel(agentId: string): boolean {
	return agentId === "opencode" || agentId === OPENROUTER_FREE_AGENT_ID;
}

/** Value of the "Other — type a model id…" option; never saved as a model id. */
export const MODEL_OTHER_VALUE = "__other__";

export const MODEL_OTHER_LABEL = "Other — type a model id…";

/** Label suffix for a stored model that the runner did not list. */
export const MODEL_SAVED_SUFFIX = " (saved — not in the runner's list)";

/** Exact caution shown for free-tier OpenCode models (ask-and-reject isolation). */
export const FREE_TIER_CAUTION =
	"OpenCode serves free-tier models only to sessions that list its tools, so this app runs them with every tool call rejected; an answer fails if the model tries a tool, and a plan model avoids that.";

export { isFreeTierModelId };

/** Note shown for the OpenRouter free-models backend, which never authorizes spend. */
export const FREE_PLAN_NOTE =
	"OpenRouter limits free models per minute and per day, and each agent step of a question uses one request. No spend is authorized for this backend.";

export interface ModelProviderGroup {
	readonly provider: string;
	readonly models: readonly string[];
}

/**
 * Group reported ids by the part before the first `/` (ARCH-010: the single
 * home of the grouping rule). Providers and ids are sorted; an id without
 * `/` (or with an empty provider) goes in group "other". Duplicates are
 * removed; the "Other" sentinel is never a listed model.
 */
export function groupModelsByProvider(models: readonly string[]): readonly ModelProviderGroup[] {
	const unique = [...new Set(models)].filter((model) => model !== MODEL_OTHER_VALUE).sort();
	const byProvider = new Map<string, string[]>();
	for (const model of unique) {
		const slash = model.indexOf("/");
		const provider = slash <= 0 ? "other" : model.slice(0, slash);
		const group = byProvider.get(provider);
		if (group === undefined) byProvider.set(provider, [model]);
		else group.push(model);
	}
	return [...byProvider.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([provider, ids]) => ({ provider, models: [...ids].sort() }));
}

export interface ModelSelectOptions {
	/** Label of the empty-value first option. */
	readonly firstOptionLabel: string;
	readonly groups: readonly ModelProviderGroup[];
	/**
	 * Trimmed current model when it is non-empty and not in the reported
	 * list (and not the sentinel): rendered as its own option so opening the
	 * form never silently changes a stored choice. Null when no such option
	 * is needed.
	 */
	readonly savedModel: string | null;
}

/**
 * Option-building rules for the "Model for this backend" selector: which
 * first option applies, grouping/sorting, and the saved-but-unlisted option.
 * `currentModel` is the trimmed model text for the selected backend.
 */
export function buildModelSelectOptions(
	reported: readonly string[] | null,
	currentModel: string,
	requiresModel: boolean,
): ModelSelectOptions {
	const trimmed = currentModel.trim();
	const listed = reported ?? [];
	const groups = groupModelsByProvider(listed);
	const inList = listed.includes(trimmed);
	const savedModel = trimmed === "" || inList || trimmed === MODEL_OTHER_VALUE ? null : trimmed;
	return {
		firstOptionLabel: requiresModel ? "Choose a model…" : "Backend default",
		groups,
		savedModel,
	};
}

/**
 * Which select value shows the current choice: "" for the first option,
 * a listed or saved id, or the "Other" sentinel while the text input is
 * shown. `otherMode` is the component's per-backend "Other was chosen" flag.
 */
export function modelSelectValue(currentModel: string, otherMode: boolean): string {
	if (otherMode) return MODEL_OTHER_VALUE;
	const trimmed = currentModel.trim();
	if (trimmed === "") return "";
	return trimmed;
}

/** Honest statement about the runner, or null when it is online. */
export function runnerNotice(agents: AgentsResponse | null): string | null {
	if (agents === null || agents.runnerOnline) return null;
	if (agents.runnerLastSeenAt === null) {
		return "Runner offline — no runner has ever reported in. Your question will be queued and will start when a runner connects.";
	}
	return `Runner offline (last seen ${formatInstant(agents.runnerLastSeenAt)}). Your question will be queued and will start when the runner reconnects. Backend availability below is as last reported.`;
}

/** FR-016: what the owner is told about cost before submitting. Never "$0". */
export function costStatement(costModel: CostModelView): string {
	if (costModel === "plan-limited") {
		return "Cost unknown — limited by your plan. This backend runs under your subscription's limits and does not report a price; no metered (paid) spend is authorized for this run.";
	}
	if (costModel === "metered") {
		return "Metered backend — usage is billed to your provider account. Set a maximum spend greater than 0 and confirm consent to continue. There is no paid fallback without consent.";
	}
	return "Cost model unknown until a runner reports this backend. No metered (paid) spend is authorized unless you set a maximum spend and confirm consent.";
}

export interface BudgetEvaluation {
	/** The question's budget (fixed limits plus the spend), or null while the spend is invalid or consent is missing. */
	readonly budget: ResearchBudget | null;
	readonly problems: readonly string[];
	/** True when the consent checkbox must be shown and ticked. */
	readonly spendConsentRequired: boolean;
}

export function evaluateBudget(
	draft: SpendDraft,
	costModel: CostModelView,
	options: { readonly requireConsent?: boolean } = {},
): BudgetEvaluation {
	// Storing a maximum spend is not consent (AGT-012): the settings form
	// validates without it, while the composer and the approval form require
	// the one-time consent again for each run.
	const requireConsent = options.requireConsent ?? true;
	const problems: string[] = [];
	const spendText = draft.maxSpendUsd.trim();
	let maxSpendUsd: number | null = null;
	let spendConsentRequired = false;
	if (costModel === "plan-limited") {
		// A plan-limited backend never gets a metered allowance, whatever was typed.
		maxSpendUsd = null;
	} else if (spendText === "") {
		if (costModel === "metered") {
			spendConsentRequired = requireConsent;
			problems.push("A metered backend needs a maximum spend greater than 0 USD.");
		}
	} else {
		spendConsentRequired = requireConsent;
		const spend = Number(spendText);
		if (!Number.isFinite(spend) || spend <= 0 || spend > BUDGET_LIMITS.maxSpendUsd.max) {
			problems.push(
				`Max spend must be greater than 0 and at most ${BUDGET_LIMITS.maxSpendUsd.max} USD.`,
			);
		} else {
			maxSpendUsd = spend;
		}
	}
	if (spendConsentRequired && requireConsent && !draft.spendConsent) {
		problems.push("Confirm consent to metered spend before submitting.");
	}
	return {
		budget: problems.length === 0 ? runBudget(maxSpendUsd) : null,
		problems,
		spendConsentRequired,
	};
}

/* ---------- Settings form draft ---------- */

/** What the AI agent section edits. Empty `defaultAgentId` = none chosen yet. */
export interface AgentSettingsDraft {
	readonly defaultAgentId: string;
	/** Model text per backend id; a backend without an entry uses its own default. */
	readonly models: Readonly<Record<string, string>>;
	readonly effort: ResearchRequest["effort"];
	readonly budget: SpendDraft;
	readonly webAccess: WebAccess;
}

export function settingsDraftFrom(settings: AgentSettings): AgentSettingsDraft {
	return {
		defaultAgentId: settings.defaultAgentId ?? "",
		models: { ...settings.models },
		effort: settings.effort,
		budget: spendDraftFrom(settings.budget),
		webAccess: settings.webAccess,
	};
}

export interface SettingsEvaluation {
	readonly selectedAgent: AgentOption | null;
	readonly costModel: CostModelView;
	readonly costStatement: string;
	/** False for plan-limited backends, which never receive a metered allowance. */
	readonly spendEditable: boolean;
	/** The stored model text for the selected backend, or "" for the backend default. */
	readonly modelText: string;
	/**
	 * Model ids the runner reported for the selected backend, or null when it
	 * lists none. The form offers them in the model selector grouped by
	 * provider; an id outside the list can still be typed through "Other".
	 */
	readonly reportedModels: readonly string[] | null;
	/** Why saving is disabled; empty when `settings` is set. */
	readonly problems: readonly string[];
	readonly settings: AgentSettings | null;
}

const MAX_MODEL_LENGTH = 100;

/**
 * Validates the settings draft. Storing a maximum spend is not consent, so no
 * consent problem is ever reported here — consent is asked on each question.
 */
export function evaluateAgentSettings(
	draft: AgentSettingsDraft,
	agents: AgentsResponse | null,
): SettingsEvaluation {
	const options = agentOptions(agents);
	const selectedAgent =
		draft.defaultAgentId === ""
			? null
			: (options.find((option) => option.agentId === draft.defaultAgentId) ?? null);
	const costModel: CostModelView = selectedAgent?.costModel ?? "unknown";
	const budget = evaluateBudget(draft.budget, costModel, { requireConsent: false });
	const problems: string[] = [];

	if (agents === null) {
		problems.push("Agent backends are still loading.");
	} else if (selectedAgent === null) {
		problems.push("Choose a default agent backend.");
	} else if (!selectedAgent.selectable) {
		problems.push(`${selectedAgent.displayName} is ${selectedAgent.status} and cannot be used.`);
	}
	const modelText = draft.defaultAgentId === "" ? "" : (draft.models[draft.defaultAgentId] ?? "");
	if (selectedAgent !== null && selectedAgent.agentId === "opencode") {
		// The OpenCode adapter refuses to pick a provider by itself, so running
		// it without a model could spend through a metered provider unasked.
		if (modelText.trim() === "") {
			problems.push(
				"OpenCode needs a model of the form provider/model — without one it cannot run. Choose one from the list the runner reported, or type one.",
			);
		} else if (!modelText.trim().includes("/")) {
			problems.push("The OpenCode model must have the form provider/model.");
		}
	}
	if (selectedAgent !== null && selectedAgent.agentId === OPENROUTER_FREE_AGENT_ID) {
		if (modelText.trim() === "") {
			problems.push(
				"OpenRouter (free models) needs a model — without one it cannot run. Choose one from the list the runner reported, or type one.",
			);
		} else if (!isOpenRouterFreeModelId(modelText.trim())) {
			problems.push(
				"The OpenRouter free model must end in :free (or be openrouter/free) — any other model is billed and is refused by this backend.",
			);
		}
	}
	if (modelText.length > MAX_MODEL_LENGTH) {
		problems.push(`The model must be at most ${MAX_MODEL_LENGTH} characters.`);
	}
	problems.push(...budget.problems);

	const settings: AgentSettings | null =
		problems.length === 0 && selectedAgent !== null && budget.budget !== null
			? {
					defaultAgentId: selectedAgent.agentId,
					models: trimmedModels(draft.models),
					effort: draft.effort,
					budget: budget.budget,
					webAccess: draft.webAccess,
				}
			: null;
	return {
		selectedAgent,
		costModel,
		costStatement: costStatement(costModel),
		spendEditable: costModel !== "plan-limited",
		modelText,
		reportedModels: selectedAgent === null ? null : reportedModels(agents, selectedAgent.agentId),
		problems,
		settings,
	};
}

function trimmedModels(models: Readonly<Record<string, string>>): Record<string, string> {
	const trimmed: Record<string, string> = {};
	for (const [agentId, text] of Object.entries(models)) {
		if (text.trim() !== "") trimmed[agentId] = text.trim();
	}
	return trimmed;
}

function modelsEqual(
	a: Readonly<Record<string, string>>,
	b: Readonly<Record<string, string>>,
): boolean {
	const keysA = Object.keys(a).sort();
	const keysB = Object.keys(b).sort();
	return (
		keysA.length === keysB.length &&
		keysA.every((key, index) => key === keysB[index] && a[key] === b[key])
	);
}

/** True once the owner has edited anything away from what was last loaded or saved. */
export function isSettingsDraftChanged(
	draft: AgentSettingsDraft,
	original: AgentSettings,
): boolean {
	const fresh = settingsDraftFrom(original);
	return (
		draft.defaultAgentId !== fresh.defaultAgentId ||
		draft.effort !== fresh.effort ||
		draft.webAccess !== fresh.webAccess ||
		!modelsEqual(draft.models, fresh.models) ||
		draft.budget.maxSpendUsd !== fresh.budget.maxSpendUsd
	);
}
