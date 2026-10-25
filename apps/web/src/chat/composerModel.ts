import {
	type AgentSettings,
	type AgentsResponse,
	BUDGET_LIMITS,
	OPENROUTER_FREE_AGENT_ID,
	type ResearchRequest,
	runBudget,
} from "@research/contracts";
import type { MessagesOf } from "@research/i18n";
import type { ResearchBudget } from "../api/client.ts";
import {
	type AgentOption,
	type AgentSettingsText,
	agentOptions,
} from "../settings/agentSettingsModel.ts";
import type { composerMessages } from "./composer.messages.ts";

export type ComposerText = MessagesOf<typeof composerMessages>;

/**
 * Pure composer rules (FR-012 / FR-016 / AGT-012): the draft holds only what
 * belongs to one question, while backend, model, effort, spend ceiling and
 * web access are read from the saved agent settings and the other limits are
 * fixed (RUN_LIMITS, ADR-0029). The composer shows the
 * backend/model/effort/web-access summary; the optional spend
 * ceiling and the cost statement live in Settings → AI agent (owner decision
 * 2026-10-12). No Solid, no network — unit-tested directly.
 */

/** Form draft: only what belongs to one question. */
export interface ComposerDraft {
	readonly question: string;
	readonly horizonYears: ResearchRequest["horizonYears"];
	readonly markets: { readonly JP: boolean; readonly US: boolean };
	/** Legacy draft field; ignored when validating a question. */
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
	/**
	 * The problems in `problems` that a missing or wrong setting causes (or
	 * data still loading), as opposed to the question itself. They block
	 * everything, so the form shows them before the owner types.
	 */
	readonly configurationProblems: readonly string[];
	readonly request: ResearchRequest | null;
}

export function evaluateComposer(
	draft: ComposerDraft,
	agents: AgentsResponse | null,
	settings: AgentSettings | null,
	workspaceId: string,
	text: ComposerText,
	/** Words of the backend options (names, availability) in the UI language. */
	agentText: AgentSettingsText,
): ComposerEvaluation {
	const options = agentOptions(agents, agentText);
	const selectedAgent =
		settings?.defaultAgentId == null
			? null
			: (options.find((option) => option.agentId === settings.defaultAgentId) ?? null);
	const costModel = selectedAgent?.costModel ?? "unknown";
	const model =
		settings?.defaultAgentId == null ? null : (settings.models[settings.defaultAgentId] ?? null);
	const problems: string[] = [];
	const configurationProblems: string[] = [];
	const configuration = (problem: string) => {
		problems.push(problem);
		configurationProblems.push(problem);
	};

	const question = draft.question.trim();
	if (question.length < 3) problems.push(text.questionTooShort);
	if (question.length > 2000) problems.push(text.questionTooLong);
	if (agents === null) {
		configuration(text.agentsLoading);
	} else if (settings?.defaultAgentId == null || selectedAgent === null) {
		configuration(text.chooseBackend);
	} else if (!selectedAgent.selectable) {
		configuration(text.backendUnusable(selectedAgent.displayName, selectedAgent.status));
	}
	if (
		selectedAgent !== null &&
		selectedAgent.agentId === "opencode" &&
		(model === null || model.trim() === "")
	) {
		configuration(text.openCodeNeedsModel);
	}
	if (
		selectedAgent !== null &&
		selectedAgent.agentId === OPENROUTER_FREE_AGENT_ID &&
		(model === null || model.trim() === "")
	) {
		configuration(text.openRouterNeedsModel);
	}
	const markets = (["JP", "US"] as const).filter((market) => draft.markets[market]);
	if (markets.length === 0) problems.push(text.chooseMarket);
	if (settings === null) {
		configuration(text.settingsLoading);
	}

	// The request carries the fixed limits (RUN_LIMITS, ADR-0029) and the saved
	// spend ceiling. A plan-limited backend never gets a metered allowance,
	// whatever is stored.
	const budget =
		settings === null
			? null
			: runBudget(costModel === "plan-limited" ? null : settings.budget.maxSpendUsd);
	const spend = budget?.maxSpendUsd ?? null;
	const spendConsentRequired = false;
	if (
		spend !== null &&
		(!Number.isFinite(spend) || spend <= 0 || spend > BUDGET_LIMITS.maxSpendUsd.max)
	) {
		configuration(text.maxSpendRange(BUDGET_LIMITS.maxSpendUsd.max));
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
		configurationProblems,
		request,
	};
}
