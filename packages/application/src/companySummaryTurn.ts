import {
	type AgentRuntime,
	extractJsonObject,
	fenceUntrustedText,
	parseAgentEvent,
} from "@research/agent-core";
import {
	type ClaimedJob,
	COMPANY_SUMMARY_LIMITS,
	type CompanySummary,
	type CompanySummaryFacts,
	companySummarySchema,
} from "@research/contracts";
import { addUsage, EMPTY_USAGE, type ResourceUsage } from "@research/domain";
import { agentThrewCode } from "./errors.ts";
import type { Clock } from "./ports.ts";
import type { PipelineReporter } from "./research/pipeline.ts";

/**
 * The company-summary turn (ADR-0060): one model turn (plus at most one
 * repair turn) writes a short description of the company and its
 * investment themes, in English and Japanese, from the stored facts the
 * claim carries. No tools, no network.
 */

/** First line of every company-summary prompt; the scripted agent keys on it. */
export const COMPANY_SUMMARY_TURN_MARKER = "COMPANY SUMMARY TURN v1";

/** Absolute ceiling for a company-summary prompt in UTF-8 bytes: over it the turn fails closed. */
export const COMPANY_SUMMARY_PROMPT_BUDGET_BYTES = 32_000;

const MAX_MODEL_OUTPUT_CHARS = 100_000;

/** How long one model turn may take. */
const TURN_DEADLINE_MS = 600_000;

export type CompanySummaryTurnJob = Extract<ClaimedJob, { kind: "company-summary" }>;

export interface CompanySummaryTurnInput extends CompanySummaryTurnJob {
	readonly signal: AbortSignal;
	/**
	 * Explicit owner opt-in to run a backend whose own tools could not be
	 * shown to be disabled. Defaults to refusing such a backend (fail closed).
	 */
	readonly allowUnverifiedToolIsolation: boolean;
}

export interface CompanySummaryTurnDeps {
	readonly agent: AgentRuntime;
	readonly clock: Clock;
	readonly reporter: PipelineReporter;
	/** Fresh unguessable token used to fence untrusted text in prompts. */
	readonly newFenceToken: () => string;
	/** The job's own empty scratch directory (AGT-004); null only for backends that need none. */
	readonly scratchDirectory: string | null;
}

export type CompanySummaryTurnOutcome =
	| { readonly kind: "summarized"; readonly summary: CompanySummary; readonly usage: ResourceUsage }
	| {
			readonly kind: "failed";
			readonly failureCode: string;
			/** The model provider's answer status behind `failureCode`, unchanged (§4a); null otherwise. */
			readonly failureUpstreamStatus: number | null;
			readonly retryable: boolean;
			readonly usage: ResourceUsage;
	  }
	| { readonly kind: "cancelled"; readonly usage: ResourceUsage };

/** The stored facts as prompt lines; each value fenced, since it came from outside. */
function factLines(stockId: string, facts: CompanySummaryFacts, fenceToken: string): string[] {
	const lines = [`Stock: ${stockId}`];
	const add = (label: string, value: string | null) => {
		if (value !== null) lines.push(fenceUntrustedText(label, value, fenceToken));
	};
	add("Company name", facts.name);
	add("Local (Japanese) name", facts.localName);
	add("Listing", facts.listing);
	add("Sector (TSE 33-sector, 17-sector)", facts.sector);
	add("Start of the business section of the latest annual report", facts.businessExcerpt);
	return lines;
}

/** The prompt of one turn; `repairNote` says why the previous reply was rejected. */
export function companySummaryPrompt(input: {
	readonly stockId: string;
	readonly facts: CompanySummaryFacts;
	readonly fenceToken: string;
	readonly repairNote: string | null;
}): string {
	const limits = COMPANY_SUMMARY_LIMITS;
	return [
		COMPANY_SUMMARY_TURN_MARKER,
		"",
		"You write a short, neutral company summary for an investor's stock page.",
		"Describe what the company does: its main businesses, products or services, and where it earns its revenue.",
		`Then list ${limits.minThemes} to ${limits.maxThemes} investment themes the company belongs to`,
		"(short tags investors use to group stocks, such as AI, Semiconductors, EV, Cloud, Defense, Inbound tourism).",
		"Rely on the facts below; use your own knowledge only for what they leave out, and do not invent figures.",
		"No investment advice, no price targets, no forecasts.",
		"",
		"Write everything twice: in English (en) and in natural Japanese (ja).",
		`Each description: 2 to 4 sentences, at most ${limits.maxDescriptionChars} characters.`,
		`Each theme: at most ${limits.maxThemeChars} characters, a noun phrase, no trailing punctuation.`,
		"",
		"Answer with ONE JSON object and nothing else, exactly this shape:",
		'{"description": {"en": "...", "ja": "..."}, "themes": [{"en": "...", "ja": "..."}]}',
		"",
		"Facts:",
		...factLines(input.stockId, input.facts, input.fenceToken),
		...(input.repairNote === null
			? []
			: [
					"",
					`Your previous answer was rejected: ${input.repairNote} Answer again with valid JSON.`,
				]),
	].join("\n");
}

type ModelTurnResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly cancelled: true }
	| {
			readonly ok: false;
			readonly cancelled: false;
			readonly code: string;
			readonly retryable: boolean;
			readonly upstreamStatus: number | null;
	  };

/** The model's reply as a summary, or why it is not one. */
export function checkCompanySummaryReply(
	text: string,
):
	| { readonly ok: true; readonly summary: CompanySummary }
	| { readonly ok: false; readonly message: string } {
	const json = extractJsonObject(text);
	if (!json.ok) {
		return {
			ok: false,
			message:
				json.error === "NO_JSON_OBJECT"
					? "the reply contained no parseable JSON object."
					: "the reply contained malformed JSON.",
		};
	}
	const parsed = companySummarySchema.safeParse(json.value);
	if (!parsed.success) {
		const fields = parsed.error.issues
			.slice(0, 6)
			.map((issue) => `${issue.path.join(".")} (${issue.message})`)
			.join(", ");
		return { ok: false, message: `invalid fields: ${fields}.` };
	}
	return { ok: true, summary: parsed.data };
}

export async function runCompanySummaryTurn(
	input: CompanySummaryTurnInput,
	deps: CompanySummaryTurnDeps,
): Promise<CompanySummaryTurnOutcome> {
	let usage: ResourceUsage = EMPTY_USAGE;
	const failed = (
		failureCode: string,
		retryable: boolean,
		failureUpstreamStatus: number | null = null,
	): CompanySummaryTurnOutcome => ({
		kind: "failed",
		failureCode,
		failureUpstreamStatus,
		retryable,
		usage,
	});

	if (input.signal.aborted) return { kind: "cancelled", usage };
	const probe = await deps.agent.probe();
	if (probe.availability.status !== "available") {
		return failed(`AGENT_UNAVAILABLE_${probe.availability.reasonCode}`, false);
	}
	if (deps.agent.toolIsolation !== "enforced" && !input.allowUnverifiedToolIsolation) {
		return failed("TOOL_ISOLATION_UNVERIFIED", false);
	}

	const encoder = new TextEncoder();
	const byteLength = (text: string): number => encoder.encode(text).length;

	/** One model turn with no tools. Never throws. */
	async function modelTurn(prompt: string): Promise<ModelTurnResult> {
		if (input.signal.aborted) return { ok: false, cancelled: true };
		usage = addUsage(usage, { agentSteps: 1, inputBytes: byteLength(prompt) });
		let text = "";
		// undefined = the provider reported nothing; that is an unknown cost, not a zero one.
		let reportedCost: number | null | undefined;
		let providerFailure: {
			readonly code: string;
			readonly retryable: boolean;
			readonly upstreamStatus: number | null;
		} | null = null;
		let finished = false;
		try {
			const events = deps.agent.run(
				{
					runId: input.runId,
					conversationId: input.runId,
					prompt,
					permittedToolIds: [],
					maxToolCalls: 0,
					deadline: new Date(deps.clock.nowMs() + TURN_DEADLINE_MS).toISOString(),
				},
				{
					signal: input.signal,
					scratchDirectory: deps.scratchDirectory,
					model: input.agent.model,
					effort: input.agent.effort,
				},
			);
			for await (const raw of events) {
				const parsed = parseAgentEvent(raw);
				if (!parsed.ok) {
					providerFailure = { code: "AGENT_EVENT_INVALID", retryable: false, upstreamStatus: null };
					break;
				}
				const event = parsed.value;
				if (event.type === "text.delta") {
					text += event.text;
					if (text.length > MAX_MODEL_OUTPUT_CHARS) {
						providerFailure = {
							code: "AGENT_OUTPUT_TOO_LARGE",
							retryable: false,
							upstreamStatus: null,
						};
						break;
					}
				} else if (event.type === "usage") {
					reportedCost = event.knownCostUsd;
				} else if (event.type === "failed") {
					providerFailure = {
						code: event.code,
						retryable: event.retryable,
						upstreamStatus: event.upstreamStatus ?? null,
					};
					break;
				} else if (event.type === "completed") {
					finished = true;
					break;
				}
				// Tool and UI events are ignored: the turn has no tools.
			}
		} catch (error) {
			// Adapters are contractually non-throwing; treat a throw as a provider failure, not a crash.
			providerFailure = { code: agentThrewCode(error), retryable: true, upstreamStatus: null };
		}
		usage = addUsage(usage, { costUsd: reportedCost ?? null });
		await deps.reporter.usage(usage);
		if (input.signal.aborted) return { ok: false, cancelled: true };
		if (providerFailure !== null) return { ok: false, cancelled: false, ...providerFailure };
		if (!finished) {
			return {
				ok: false,
				cancelled: false,
				code: "AGENT_STREAM_ENDED_EARLY",
				retryable: true,
				upstreamStatus: null,
			};
		}
		return { ok: true, text };
	}

	// The job state machine only moves forward one stage at a time:
	// collecting = the facts into a prompt, analyzing = the model turn,
	// verifying = checking its JSON (and the one repair turn), publishing =
	// handing the summary to the API.
	await deps.reporter.state("planning");
	await deps.reporter.state("collecting");
	const prompt = (repairNote: string | null) =>
		companySummaryPrompt({
			stockId: input.stockId,
			facts: input.facts,
			fenceToken: deps.newFenceToken(),
			repairNote,
		});
	const firstPrompt = prompt(null);
	if (byteLength(firstPrompt) > COMPANY_SUMMARY_PROMPT_BUDGET_BYTES) {
		return failed("COMPANY_SUMMARY_PROMPT_TOO_LARGE", false);
	}
	await deps.reporter.state("analyzing");
	const first = await modelTurn(firstPrompt);
	if (!first.ok) {
		return first.cancelled
			? { kind: "cancelled", usage }
			: failed(first.code, first.retryable, first.upstreamStatus);
	}
	await deps.reporter.state("verifying");
	const checked = checkCompanySummaryReply(first.text);
	if (checked.ok) {
		await deps.reporter.state("publishing");
		return { kind: "summarized", summary: checked.summary, usage };
	}
	await deps.reporter.note("The first reply was rejected; asking for corrected JSON.");
	const repairPrompt = prompt(checked.message);
	if (byteLength(repairPrompt) > COMPANY_SUMMARY_PROMPT_BUDGET_BYTES) {
		return failed("COMPANY_SUMMARY_PROMPT_TOO_LARGE", false);
	}
	const second = await modelTurn(repairPrompt);
	if (!second.ok) {
		return second.cancelled
			? { kind: "cancelled", usage }
			: failed(second.code, second.retryable, second.upstreamStatus);
	}
	const rechecked = checkCompanySummaryReply(second.text);
	if (rechecked.ok) {
		await deps.reporter.state("publishing");
		return { kind: "summarized", summary: rechecked.summary, usage };
	}
	return failed("COMPANY_SUMMARY_REPLY_INVALID", false);
}
