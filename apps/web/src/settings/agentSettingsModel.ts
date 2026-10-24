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
import type { MessagesOf } from "@research/i18n";
import type { ResearchBudget } from "../api/client.ts";
import { formatInstant } from "../lib/format.ts";
import { agentSettingsModelMessages } from "./agentSettingsModel.messages.ts";

/**
 * Pure agent-settings rules (FR-012 / FR-016 / AGT-012): which backends can be
 * chosen, what the cost statement says, how the settings form validates, and
 * how the question form builds its request from the saved settings. No Solid,
 * no network — unit-tested directly. This is the single home of the backend
 * options, the availability list content and the budget-text rules; the
 * composer and the approval form import from here (ARCH-010).
 *
 * Owner-facing sentences come from the `text` parameter, the words of
 * `agentSettingsModelMessages` in the UI language (ADR-0032). The functions
 * the Chat page also calls default it to English.
 */

/** The words the rules build sentences from, in one UI language. */
export type AgentSettingsText = MessagesOf<typeof agentSettingsModelMessages>;

const ENGLISH: AgentSettingsText = agentSettingsModelMessages.en;

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
	// i18n-exempt: product name
	"claude-code": "Claude Code",
	openrouter: "OpenRouter",
};

function costModelText(costModel: CostModelView, text: AgentSettingsText): string {
	if (costModel === "plan-limited") return text.costPlanLimited;
	if (costModel === "metered") return text.costMetered;
	return text.costUnknown;
}

function describeAgent(agent: AgentDescriptor, text: AgentSettingsText): AgentOption {
	const isolationNote =
		agent.toolIsolation === "enforced" ? text.isolationEnforced : text.isolationUnverified;
	if (agent.availability.status === "available") {
		return {
			agentId: agent.agentId,
			displayName: agent.displayName,
			selectable: true,
			costModel: agent.costModel,
			status: text.statusAvailable,
			detail: text.detailAvailable(costModelText(agent.costModel, text), isolationNote),
		};
	}
	return {
		agentId: agent.agentId,
		displayName: agent.displayName,
		selectable: false,
		costModel: agent.costModel,
		status: text.statusUnavailable(agent.availability.reasonCode),
		detail: text.detailUnavailable(agent.availability.reasonCode, agent.availability.detail),
	};
}

/**
 * Backends the owner can see. Unavailable ones stay listed with their reason
 * but cannot be chosen. When no runner has ever reported, the baseline
 * backends are offered with their availability stated as unknown so a question
 * can still be queued.
 */
export function agentOptions(
	agents: AgentsResponse | null,
	text: AgentSettingsText,
): readonly AgentOption[] {
	if (agents === null) return [];
	if (agents.agents.length > 0) return agents.agents.map((agent) => describeAgent(agent, text));
	return BASELINE_AGENT_IDS.map((agentId) => ({
		agentId,
		displayName: BASELINE_DISPLAY_NAMES[agentId],
		selectable: true,
		costModel: "unknown",
		status: text.statusUnknown,
		detail: text.detailUnknown,
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

/** English label of the "Other" option; the form shows `text.modelOther`. */
export const MODEL_OTHER_LABEL = ENGLISH.modelOther;

/** English label suffix for a stored model that the runner did not list (`text.modelSavedSuffix`). */
export const MODEL_SAVED_SUFFIX = ENGLISH.modelSavedSuffix;

/** Exact English caution for free-tier OpenCode models (ask-and-reject isolation). */
export const FREE_TIER_CAUTION = ENGLISH.freeTierCaution;

export { isFreeTierModelId };

/** English note for the OpenRouter free-models backend, which never authorizes spend. */
export const FREE_PLAN_NOTE = ENGLISH.freePlanNote;

export interface ModelProviderGroup {
	/** The `<optgroup>` heading, or null for a list shown without one. */
	readonly provider: string | null;
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

function hasProviderPrefix(model: string): boolean {
	return model.indexOf("/") > 0;
}

/**
 * Option-building rules for the "Model for this backend" selector: which
 * first option applies, grouping/sorting, and the saved-but-unlisted option.
 * `currentModel` is the trimmed model text for the selected backend.
 *
 * A list in which no id names a provider (Codex's catalog, Claude Code's
 * aliases) is one flat list in the runner's order, which is the backend's
 * own newest-first order; a heading or an alphabetical sort would only hide
 * that. Provider-prefixed lists are grouped by provider as before.
 */
export function buildModelSelectOptions(
	reported: readonly string[] | null,
	currentModel: string,
	requiresModel: boolean,
	text: AgentSettingsText,
): ModelSelectOptions {
	const trimmed = currentModel.trim();
	const listed = reported ?? [];
	const flat = [...new Set(listed)].filter((model) => model !== MODEL_OTHER_VALUE);
	const groups =
		flat.length > 0 && !flat.some(hasProviderPrefix)
			? [{ provider: null, models: flat }]
			: groupModelsByProvider(listed);
	const inList = listed.includes(trimmed);
	const savedModel = trimmed === "" || inList || trimmed === MODEL_OTHER_VALUE ? null : trimmed;
	return {
		firstOptionLabel: requiresModel ? text.chooseModel : text.backendDefault,
		groups,
		savedModel,
	};
}

/**
 * Claude Code's `--model` aliases, each the newest model of its family (a
 * product name). The runner reports the aliases; this only names them for
 * the owner.
 */
const CLAUDE_ALIAS_FAMILIES: Readonly<Record<string, string>> = {
	fable: "Fable",
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
};

/** Text of a model's option: a readable name where one is known, otherwise the id itself. */
export function modelOptionLabel(agentId: string, model: string, text: AgentSettingsText): string {
	const family = agentId === "claude-code" ? CLAUDE_ALIAS_FAMILIES[model] : undefined;
	return family === undefined ? model : text.latestModel(family);
}

/** Placeholder of the "Other" text input: the id shape the backend expects. */
export function customModelPlaceholder(agentId: string, text: AgentSettingsText): string {
	if (agentId === OPENROUTER_FREE_AGENT_ID) return "provider/model:free";
	if (agentId === "opencode" || agentId === "openrouter") return "provider/model";
	return text.modelIdPlaceholder;
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
export function runnerNotice(
	agents: AgentsResponse | null,
	text: AgentSettingsText,
): string | null {
	if (agents === null || agents.runnerOnline) return null;
	if (agents.runnerLastSeenAt === null) return text.runnerNeverSeen;
	return text.runnerOffline(formatInstant(agents.runnerLastSeenAt));
}

/** FR-016: what the owner is told about cost before submitting. Never "$0". */
export function costStatement(costModel: CostModelView, text: AgentSettingsText): string {
	if (costModel === "plan-limited") return text.costStatementPlanLimited;
	if (costModel === "metered") return text.costStatementMetered;
	return text.costStatementUnknown;
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
	text: AgentSettingsText,
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
			problems.push(text.meteredNeedsSpend);
		}
	} else {
		spendConsentRequired = requireConsent;
		const spend = Number(spendText);
		if (!Number.isFinite(spend) || spend <= 0 || spend > BUDGET_LIMITS.maxSpendUsd.max) {
			problems.push(text.spendOutOfRange(BUDGET_LIMITS.maxSpendUsd.max));
		} else {
			maxSpendUsd = spend;
		}
	}
	if (spendConsentRequired && requireConsent && !draft.spendConsent) {
		problems.push(text.confirmConsent);
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
	text: AgentSettingsText,
): SettingsEvaluation {
	const options = agentOptions(agents, text);
	const selectedAgent =
		draft.defaultAgentId === ""
			? null
			: (options.find((option) => option.agentId === draft.defaultAgentId) ?? null);
	const costModel: CostModelView = selectedAgent?.costModel ?? "unknown";
	const budget = evaluateBudget(draft.budget, costModel, { requireConsent: false }, text);
	const problems: string[] = [];

	if (agents === null) {
		problems.push(text.agentsLoading);
	} else if (selectedAgent === null) {
		problems.push(text.chooseDefaultBackend);
	} else if (!selectedAgent.selectable) {
		problems.push(text.backendUnusable(selectedAgent.displayName, selectedAgent.status));
	}
	const modelText = draft.defaultAgentId === "" ? "" : (draft.models[draft.defaultAgentId] ?? "");
	if (selectedAgent !== null && selectedAgent.agentId === "opencode") {
		// The OpenCode adapter refuses to pick a provider by itself, so running
		// it without a model could spend through a metered provider unasked.
		if (modelText.trim() === "") {
			problems.push(text.openCodeNeedsModel);
		} else if (!modelText.trim().includes("/")) {
			problems.push(text.openCodeModelShape);
		}
	}
	if (selectedAgent !== null && selectedAgent.agentId === OPENROUTER_FREE_AGENT_ID) {
		if (modelText.trim() === "") {
			problems.push(text.openRouterFreeNeedsModel);
		} else if (!isOpenRouterFreeModelId(modelText.trim())) {
			problems.push(text.openRouterFreeModelShape);
		}
	}
	if (modelText.length > MAX_MODEL_LENGTH) {
		problems.push(text.modelTooLong(MAX_MODEL_LENGTH));
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
		costStatement: costStatement(costModel, text),
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
