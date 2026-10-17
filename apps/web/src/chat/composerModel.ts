import {
	type AgentSettings,
	type AgentsResponse,
	BUDGET_LIMITS,
	OPENROUTER_FREE_AGENT_ID,
	type ResearchRequest,
	runBudget,
} from "@research/contracts";
import type { ResearchBudget } from "../api/client.ts";
import { type AgentOption, agentOptions } from "../settings/agentSettingsModel.ts";

/**
 * Pure composer rules (FR-012 / FR-016 / AGT-012): the draft holds only what
 * belongs to one question, while backend, model, effort, spend ceiling and
 * web access are read from the saved agent settings and the other limits are
 * fixed (RUN_LIMITS, ADR-0029). The composer shows the
 * backend/model/effort/web-access summary and the consent amount; the spend
 * ceiling and the cost statement live in Settings → AI agent (owner decision
 * 2026-10-12). No Solid, no network — unit-tested directly.
 */

/** Form draft: only what belongs to ONE question. Consent is one-time per submission. */
export interface ComposerDraft {
	readonly question: string;
	readonly horizonYears: ResearchRequest["horizonYears"];
	readonly markets: { readonly JP: boolean; readonly US: boolean };
	readonly spendConsent: boolean;
}

export function defaultComposerDraft(): ComposerDraft {
	return {
		question: "",
		horizonYears: 5,
		markets: { JP: true, US: true },
		spendConsent: false,
	};
}

export interface ComposerEvaluation {
	readonly selectedAgent: AgentOption | null;
	/** The model that will run, or null for the backend's own default. */
	readonly model: string | null;
	/** The limits that will run, with a plan-limited backend forced to no spend allowance. */
	readonly budget: ResearchBudget | null;
	readonly spendConsentRequired: boolean;
	/** Why submit is disabled; empty when `request` is set. Each ends with where to fix it. */
	readonly problems: readonly string[];
	readonly request: ResearchRequest | null;
}

export function evaluateComposer(
	draft: ComposerDraft,
	agents: AgentsResponse | null,
	settings: AgentSettings | null,
	workspaceId: string,
): ComposerEvaluation {
	const options = agentOptions(agents);
	const selectedAgent =
		settings?.defaultAgentId == null
			? null
			: (options.find((option) => option.agentId === settings.defaultAgentId) ?? null);
	const costModel = selectedAgent?.costModel ?? "unknown";
	const model =
		settings?.defaultAgentId == null ? null : (settings.models[settings.defaultAgentId] ?? null);
	const problems: string[] = [];

	const question = draft.question.trim();
	if (question.length < 3) problems.push("Enter a research question (at least 3 characters).");
	if (question.length > 2000) problems.push("The question must be at most 2000 characters.");
	if (agents === null) {
		problems.push("Agent backends are still loading.");
	} else if (settings?.defaultAgentId == null || selectedAgent === null) {
		problems.push("Choose a default agent backend in Settings → AI agent.");
	} else if (!selectedAgent.selectable) {
		problems.push(
			`${selectedAgent.displayName} is ${selectedAgent.status} and cannot be used — choose another backend in Settings → AI agent.`,
		);
	}
	if (
		selectedAgent !== null &&
		selectedAgent.agentId === "opencode" &&
		(model === null || model.trim() === "")
	) {
		problems.push(
			"OpenCode needs a model of the form provider/model — choose one in Settings → AI agent.",
		);
	}
	if (
		selectedAgent !== null &&
		selectedAgent.agentId === OPENROUTER_FREE_AGENT_ID &&
		(model === null || model.trim() === "")
	) {
		problems.push("OpenRouter (free models) needs a model — choose one in Settings → AI agent.");
	}
	const markets = (["JP", "US"] as const).filter((market) => draft.markets[market]);
	if (markets.length === 0) problems.push("Choose at least one market (JP or US).");
	if (settings === null) {
		problems.push("Agent settings are still loading.");
	}

	// The request carries the fixed limits (RUN_LIMITS, ADR-0029) and the saved
	// spend ceiling. A plan-limited backend never gets a metered allowance,
	// whatever is stored.
	const budget =
		settings === null
			? null
			: runBudget(costModel === "plan-limited" ? null : settings.budget.maxSpendUsd);
	const spend = budget?.maxSpendUsd ?? null;
	let spendConsentRequired = false;
	if (settings !== null && selectedAgent !== null && costModel !== "plan-limited") {
		if (spend === null || spend <= 0) {
			if (costModel === "metered") {
				problems.push(
					"A metered backend needs a maximum spend greater than 0 USD — set it in Settings → AI agent.",
				);
			}
		} else if (spend > BUDGET_LIMITS.maxSpendUsd.max) {
			problems.push(
				`Max spend must be greater than 0 and at most ${BUDGET_LIMITS.maxSpendUsd.max} USD — fix it in Settings → AI agent.`,
			);
		} else {
			spendConsentRequired = true;
		}
	}
	if (spendConsentRequired && !draft.spendConsent) {
		problems.push("Confirm consent to metered spend on the form itself.");
	}

	const request: ResearchRequest | null =
		problems.length === 0 &&
		settings !== null &&
		settings.defaultAgentId !== null &&
		selectedAgent !== null &&
		budget !== null
			? {
					workspaceId,
					question,
					agentId: selectedAgent.agentId,
					model,
					effort: settings.effort,
					horizonYears: draft.horizonYears,
					markets,
					budget,
					webAccess: settings.webAccess,
				}
			: null;

	return {
		selectedAgent,
		model,
		budget,
		spendConsentRequired,
		problems,
		request,
	};
}
