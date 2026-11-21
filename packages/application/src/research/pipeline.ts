import {
	type AgentRuntime,
	authorizeToolCall,
	type CollectedEvidence,
	executeToolCall,
	extractJsonObject,
	parseAgentEvent,
	type ToolContext,
	type ToolOutput,
	type ToolRegistry,
} from "@research/agent-core";
import {
	BUNDLE_LIMITS,
	type Claim,
	type ConversationContextMessage,
	type DemandScenario,
	type FinancialObservation,
	type IngestedArticle,
	type InvestorFiling,
	type PositionObservation,
	type PricingPowerRecord,
	pricingPowerRecordSchema,
	type ResearchBundle,
	type ResearchRequest,
	researchBundleSchema,
	type Security,
	type SubscribedSourceRef,
	type SupplierLink,
	sanitizeToolErrorCode,
	securitySchema,
	uiOperationSchema,
	type WorkspaceComponentSummary,
} from "@research/contracts";
import {
	addUsage,
	assessPricingPower,
	type BudgetLimit,
	checkBudget,
	deriveScenarioCagr,
	err,
	extractNumberTokens,
	isPassageOf,
	type JobState,
	mentions,
	ok,
	type ResourceUsage,
	type Result,
	recentCountWithinBudget,
	resolveClaimEvidenceId,
	type UiOperation,
	verifyClaims,
} from "@research/domain";
import { agentThrewCode } from "../errors.ts";
import type { Clock } from "../ports.ts";
import { buildComparisonTables } from "./comparisonTables.ts";
import { directAnswerNote, readDirectAnswer } from "./directAnswer.ts";
import {
	type AnalysisDraft,
	analysisDraftSchema,
	type DraftScenario,
	draftPricingPowerSchema,
	draftScenarioSchema,
	draftSupplierSchema,
	MAX_TOOL_CALLS_PER_REPLY,
	planSchema,
	verdictsSchema,
} from "./draft.ts";
import { buildPresentation, DISCLAIMER, datasetGuide } from "./presentation.ts";
import {
	analysisPrompt,
	cutUtf8Bytes,
	directAnswerPrompt,
	PLANNING_CONTEXT_MAX_BYTES,
	PLANNING_FINAL_ROUND_NOTE,
	PLANNING_REMINDER,
	PLANNING_REPEAT_NOTE,
	PLANNING_SEARCH_BEFORE_FINAL_NOTE,
	PLANNING_SOURCES_MAX_BYTES,
	PLANNING_TOOL_CATALOG_MAX_BYTES,
	PROMPT_VERSION,
	planningPrompt,
	verificationPrompt,
} from "./prompts.ts";

const MAX_MODEL_OUTPUT_CHARS = 400_000;
const EVIDENCE_PACK_MAX = 150_000;
const EVIDENCE_ITEM_MAX = 4_000;
const PROMPT_OVERHEAD_BYTES = 12_000;
/** Bounds the full tool text of the immediately previous collection step, shown once in the next planning prompt. UTF-8 bytes, not UTF-16 units. */
export const PLANNING_FRESH_TEXT_MAX = 48_000;
/** Bounds the digest lines for older collection steps kept in later planning prompts. */
export const PLANNING_DIGEST_MAX = 8_000;
/** Caps how many digest lines compete for the digest budget, so one huge backlog cannot stall selection. */
export const PLANNING_DIGEST_MAX_LINES = 400;
/** Template, request, fence and headers: measured near 2 KiB, budgeted with margin. */
const PLANNING_FIXED_OVERHEAD_MAX_BYTES = 4_000;
/** Tools whose results are planning leads, not evidence. */
const DISCOVERY_TOOL_IDS: ReadonlySet<string> = new Set(["web.search", "news.search"]);
// Financial reads use the shared SEC client's request pacing.
const PARALLEL_STOCK_TOOL_IDS: ReadonlySet<string> = new Set([
	"stocks.search",
	"finance.sec_company_financials",
]);
const MAX_PARALLEL_STOCK_CALLS = 4;
/** Tools that read one page each; consecutive requests of a round run concurrently (ADR-0078). */
const PAGE_READ_TOOL_IDS: ReadonlySet<string> = new Set(["web.extract", "web.fetch_page"]);
/**
 * Absolute ceiling for any planning prompt, in UTF-8 bytes: fixed overhead +
 * tool catalog + source list + conversation context (each bounded in
 * `prompts.ts` before the prompt is built) + the two collected sections. The
 * builder fits the collected section into the remainder, so the ceiling holds
 * by construction; the collection loop below additionally refuses to send a
 * prompt over budget (fail closed, ARCH-017).
 */
export const PLANNING_PROMPT_BUDGET_BYTES =
	PLANNING_FIXED_OVERHEAD_MAX_BYTES +
	PLANNING_TOOL_CATALOG_MAX_BYTES +
	PLANNING_SOURCES_MAX_BYTES +
	PLANNING_CONTEXT_MAX_BYTES +
	PLANNING_FRESH_TEXT_MAX +
	PLANNING_DIGEST_MAX;

/** Progress sink. Implementations may reject when the lease is lost; the pipeline then stops. */
export interface PipelineReporter {
	planningRound?(fields: {
		readonly round: number;
		readonly finalRound: boolean;
		readonly requestedToolIds: string;
		readonly executed: number;
		readonly repeated: number;
		readonly denied: number;
		readonly refusedFinalRoundSearch: number;
	}): void;
	analysisAttempt?(fields: {
		readonly analysisAttempt: number;
		readonly durationSeconds: number;
		readonly modelTurnSeconds: number;
		readonly inputBytes: number;
		readonly outputBytes: number | null;
		readonly reason: string;
		readonly willRetry: boolean;
	}): void;
	state(state: JobState): Promise<void>;
	note(text: string): Promise<void>;
	tool(toolId: string, outcome: "executed" | "denied" | "failed", detail: string): Promise<void>;
	usage(usage: ResourceUsage): Promise<void>;
}

export interface ResearchPipelineInput {
	readonly runId: string;
	readonly request: ResearchRequest;
	readonly sources: readonly SubscribedSourceRef[];
	readonly workspaceComponents: readonly WorkspaceComponentSummary[];
	/** Bounded earlier conversation, oldest first; context for the question only, never evidence. */
	readonly conversationContext: readonly ConversationContextMessage[];
	/** Consumption of earlier attempts of this run; ceilings apply to the run as a whole. */
	readonly priorUsage: ResourceUsage;
	readonly signal: AbortSignal;
	/**
	 * Explicit owner opt-in to run a backend whose own tools could not be shown
	 * to be disabled. Defaults to refusing such a backend (fail closed).
	 */
	readonly allowUnverifiedToolIsolation: boolean;
}

export interface ResearchPipelineDeps {
	readonly agent: AgentRuntime;
	readonly tools: ToolRegistry;
	readonly clock: Clock;
	readonly reporter: PipelineReporter;
	/** Fresh unguessable token used to fence untrusted text in prompts. */
	readonly newFenceToken: () => string;
	readonly scratchDirectory: string | null;
}

export type PipelineOutcome =
	| {
			readonly kind: "completed";
			readonly bundle: ResearchBundle;
			readonly articles: readonly IngestedArticle[];
			readonly usage: ResourceUsage;
	  }
	| {
			readonly kind: "partial";
			readonly failureCode: string;
			/** The external service's status behind `failureCode`, unchanged (§4a); null otherwise. */
			readonly failureUpstreamStatus: number | null;
			readonly bundle: ResearchBundle;
			readonly articles: readonly IngestedArticle[];
			readonly usage: ResourceUsage;
	  }
	| {
			readonly kind: "failed";
			readonly failureCode: string;
			/**
			 * Most frequent tool error code with `ALL_TOOL_CALLS_FAILED`; with
			 * `NO_EVIDENCE_COLLECTED` one of `NO_TOOL_REQUESTED`,
			 * `PLAN_NOT_JSON`, `TOOLS_RETURNED_NOTHING` (ADR-0025).
			 */
			readonly failureDetail: string | null;
			/**
			 * The status the external service that caused the failure answered
			 * with, unchanged (docs/rule/error_handling.md §4a): the model
			 * provider's for a provider failure; for `ALL_TOOL_CALLS_FAILED`
			 * the most frequent status among the calls that failed with the
			 * reported `failureDetail` code (the latest wins a tie). Null when
			 * no external answer caused it.
			 */
			readonly failureUpstreamStatus: number | null;
			readonly retryable: boolean;
			readonly usage: ResourceUsage;
	  }
	| { readonly kind: "cancelled"; readonly usage: ResourceUsage }
	| {
			readonly kind: "waiting_approval";
			readonly approvalRequest: { readonly reasonCode: string; readonly detail: string };
			readonly usage: ResourceUsage;
	  };

type TurnFailure =
	| { readonly kind: "aborted" }
	| { readonly kind: "budget"; readonly limit: BudgetLimit }
	/** A metered turn ran without reporting its cost, so further spend cannot be bounded. */
	| { readonly kind: "unknown-spend" }
	| {
			readonly kind: "provider";
			readonly code: string;
			readonly retryable: boolean;
			/** The provider API's answer status, unchanged; null when no answer caused it (§4a). */
			readonly upstreamStatus: number | null;
	  };

interface Turn {
	readonly text: string;
	readonly toolRequests: readonly { readonly toolId: string; readonly args: unknown }[];
	readonly uiProposals: readonly unknown[];
}

interface CollectedEntry {
	/** Collection step (0-based) whose tool call produced this entry. */
	readonly step: number;
	/** Full text shown once, in the planning prompt of the next step. */
	readonly fullText: string;
	/** One-line reminders kept in later planning prompts (evidence titles are untrusted). */
	readonly digestLines: readonly string[];
}

interface Collected {
	readonly evidence: CollectedEvidence[];
	readonly securities: Security[];
	readonly financialObservations: FinancialObservation[];
	readonly positionObservations: PositionObservation[];
	readonly investorFilings: InvestorFiling[];
	readonly articles: IngestedArticle[];
	readonly entries: CollectedEntry[];
}

const utf8Encoder = new TextEncoder();
const SAFE_TOOL_ID_PATTERN = /^[a-z][a-z0-9._-]{0,39}$/;

function formatRequestedToolIds(calls: readonly { readonly toolId: string }[]): string {
	return calls
		.map((call) => (SAFE_TOOL_ID_PATTERN.test(call.toolId) ? call.toolId : "invalid"))
		.join(",")
		.slice(0, 200);
}

function byteLength(text: string): number {
	return utf8Encoder.encode(text).length;
}

/**
 * Steps kept back from collection so a run that needs them still reaches
 * analysis and independent verification (AGT-013). A full allowance keeps one
 * step each for analysis, its repair turn and verification; a 3–4 step
 * allowance keeps analysis plus verification as before; below that, analysis
 * alone. Counted from what is left of the run's allowance, which earlier
 * attempts may have used.
 */
function reservedPostCollectionSteps(remainingSteps: number): number {
	if (remainingSteps >= 5) return 3;
	if (remainingSteps >= 3) return 2;
	return 1;
}

const MAX_PLANNING_LEADS_PER_CALL = 12;
const MAX_PLANNING_LEAD_BYTES = 200;

/** One line per evidence item; otherwise any planning leads, else one line naming the record count. */
function digestLinesFor(toolId: string, output: ToolOutput): string[] {
	const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ");
	if (output.evidence.length > 0) {
		return output.evidence.map((item) => {
			const evidence = item.evidence;
			return oneLine(
				`[${evidence.evidenceId}] ${evidence.title} — ${evidence.publisher}; ${evidence.publishedAt ?? "undated"}`,
			);
		});
	}
	if (output.planningLeads.length > 0) {
		return output.planningLeads
			.slice(0, MAX_PLANNING_LEADS_PER_CALL)
			.map((lead) => cutUtf8Bytes(oneLine(lead), MAX_PLANNING_LEAD_BYTES));
	}
	const records =
		output.securities.length +
		output.financialObservations.length +
		output.positionObservations.length +
		output.investorFilings.length +
		output.articles.length;
	return [`${toolId}: ${records} record(s), no evidence`];
}

/**
 * What the planning prompt of collection `step` shows of earlier tool output
 * (ADR-0010). The previous step's full text appears here once and never again;
 * every earlier step — including the previous one — is also represented by
 * digest lines, the most recent ones that fit PLANNING_DIGEST_MAX (via
 * recentCountWithinBudget), so an evidence id stays mentioned as long as a
 * later planning prompt exists. Empty when nothing was collected yet, so the
 * prompt reads "(nothing yet)" as before.
 */
function collectedSoFarText(entries: readonly CollectedEntry[], step: number): string {
	const fresh = entries
		.filter((entry) => entry.step === step - 1)
		.map((entry) => entry.fullText)
		.join("\n\n");
	// The fresh cut is in UTF-8 bytes, not UTF-16 units: CJK output must not
	// overrun the budget threefold.
	const boundedFresh =
		byteLength(fresh) <= PLANNING_FRESH_TEXT_MAX
			? fresh
			: `${cutUtf8Bytes(fresh, PLANNING_FRESH_TEXT_MAX)}\n[older output truncated to the planning budget]`;
	const older = entries.filter((entry) => entry.step < step).flatMap((entry) => entry.digestLines);
	if (boundedFresh === "" && older.length === 0) return "";
	// Lines beyond the item cap cannot be selected, and their byte sizes are valid by construction.
	const sizes = older.slice(-PLANNING_DIGEST_MAX_LINES).map(byteLength);
	const keep = recentCountWithinBudget(sizes, PLANNING_DIGEST_MAX, PLANNING_DIGEST_MAX_LINES);
	const kept = older.slice(older.length - keep);
	const omitted = older.length - keep;
	const digest =
		kept.length === 0
			? "(no earlier output)"
			: [...kept, ...(omitted > 0 ? [`(${omitted} older entries omitted)`] : [])].join("\n");
	return [
		"New tool output since the previous step (full text, shown once):",
		boundedFresh === "" ? "(none)" : boundedFresh,
		"",
		"Earlier tool output (one line per evidence item; do not re-request it):",
		digest,
	].join("\n");
}

function sameListing(security: Security, ticker: string, exchange: string): boolean {
	return (
		security.ticker.toUpperCase() === ticker.toUpperCase() &&
		security.exchange.toLowerCase() === exchange.toLowerCase()
	);
}

/**
 * The research lifecycle from planning to a publishable bundle (section 6.3).
 *
 * The model only ever proposes; this function decides. Tool calls are
 * authorized against the registry, allowlist and budget; every id, quote and
 * figure in the model's analysis is checked against what was actually
 * retrieved; derived numbers (CAGR, pricing-power classification) are computed
 * here, never taken from the model. The function performs no persistence — it
 * returns an outcome the runner submits under its lease.
 */
export async function runResearchPipeline(
	input: ResearchPipelineInput,
	deps: ResearchPipelineDeps,
): Promise<PipelineOutcome> {
	const { runId, request } = input;
	const budget = request.budget;
	const startedMs = deps.clock.nowMs();
	const deadline = new Date(startedMs + budget.maxWallClockMs).toISOString();
	const elapsedMs = () => deps.clock.nowMs() - startedMs;
	// Steps, tool calls, input bytes and spend accumulate across attempts (AGT-008); only the
	// wall clock is per attempt, because time spent waiting in the queue is not work.
	let usage = input.priorUsage;
	const metered = deps.agent.costModel === "metered";
	/** Largest cost any single turn has reported so far; the reservation for the next one. */
	let largestTurnCostUsd = 0;

	const counters = new Map<string, number>();
	const nextId = (prefix: string): string => {
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		return `${runId}_${prefix}${next}`;
	};
	// A tool whose destination is chosen by the model (public web) runs only
	// when the owner enabled web access on the request (fail closed, ARCH-017).
	// Tools the run cannot use are neither advertised to the model nor
	// authorized, so a plan that requests one anyway is denied (AGT-006).
	const permittedTools = deps.tools
		.list()
		.filter(
			(tool) => tool.networkAllowlist.kind !== "public-web" || request.webAccess === "public-web",
		);
	const permittedToolIds = new Set(permittedTools.map((tool) => tool.toolId));
	const toolContext: ToolContext = {
		runId,
		signal: input.signal,
		nowIso: () => deps.clock.nowIso(),
		nextId,
		subscribedSources: input.sources,
	};

	const failed = (
		failureCode: string,
		retryable: boolean,
		failureDetail: string | null = null,
		failureUpstreamStatus: number | null = null,
	): PipelineOutcome => ({
		kind: "failed",
		failureCode,
		failureDetail,
		failureUpstreamStatus,
		retryable,
		usage,
	});

	/** Most frequent tool error code, ties broken alphabetically for determinism. */
	const mostFrequentToolError = (counts: ReadonlyMap<string, number>): string | null => {
		let best: string | null = null;
		let bestCount = 0;
		for (const [code, count] of counts) {
			// Finding 10: only the stable shape may leave the runner as a
			// "code" — page-derived text becomes TOOL_ERROR (ARCH-005).
			const stable = sanitizeToolErrorCode(code);
			if (count > bestCount || (count === bestCount && (best === null || stable < best))) {
				best = stable;
				bestCount = count;
			}
		}
		return best;
	};

	/**
	 * The upstream status reported with `ALL_TOOL_CALLS_FAILED`: the most
	 * frequent status among the calls that failed with `code`, the latest
	 * wins a tie; null when none of them carried one (§4a rule 6).
	 */
	const toolErrorStatus = (code: string | null): number | null => {
		if (code === null) return null;
		let best: number | null = null;
		let bestCount = 0;
		let bestLast = -1;
		for (const [status, seen] of toolErrorStatuses.get(code) ?? []) {
			if (seen.count > bestCount || (seen.count === bestCount && seen.last > bestLast)) {
				best = status;
				bestCount = seen.count;
				bestLast = seen.last;
			}
		}
		return best;
	};

	/* ----- Pre-flight: capability and consent negotiation, before any quota is spent ----- */
	const probe = await deps.agent.probe();
	if (probe.availability.status !== "available") {
		return failed(`AGENT_UNAVAILABLE_${probe.availability.reasonCode}`, false);
	}
	if (deps.agent.toolIsolation !== "enforced" && !input.allowUnverifiedToolIsolation) {
		return failed("TOOL_ISOLATION_UNVERIFIED", false);
	}

	/** One model turn under the run's budget. Never throws for provider failures. */
	async function turn(prompt: string, measuredBytes?: number): Promise<Result<Turn, TurnFailure>> {
		if (input.signal.aborted) return err({ kind: "aborted" });
		const inputBytes = measuredBytes ?? byteLength(prompt);
		// On a metered backend an unreported cost means the running total is unknown: stop
		// and ask, rather than keep spending against a ceiling that can no longer be checked.
		if (metered && budget.maxSpendUsd !== null && usage.hasUnmeteredUsage)
			return err({ kind: "unknown-spend" });
		// Reserve what the most expensive turn so far cost, so the ceiling is checked BEFORE
		// the request is made. The first metered turn has no history and reserves nothing;
		// that single turn is the documented worst-case overshoot.
		const allowed = checkBudget(budget, usage, elapsedMs(), {
			agentSteps: 1,
			inputBytes,
			costUsd: metered ? largestTurnCostUsd : 0,
		});
		if (!allowed.ok) return err({ kind: "budget", limit: allowed.error });
		usage = addUsage(usage, { agentSteps: 1, inputBytes });

		let text = "";
		const toolRequests: { toolId: string; args: unknown }[] = [];
		const uiProposals: unknown[] = [];
		// undefined = the provider reported nothing; that is an unknown cost, not a zero one.
		let reportedCost: number | null | undefined;
		let failure: TurnFailure | null = null;
		let finished = false;
		try {
			const events = deps.agent.run(
				{
					runId,
					conversationId: request.workspaceId,
					prompt,
					permittedToolIds: [...permittedToolIds],
					maxToolCalls: Math.max(0, budget.maxToolCalls - usage.toolCalls),
					deadline,
				},
				{
					signal: input.signal,
					scratchDirectory: deps.scratchDirectory,
					model: request.model,
					effort: request.effort,
				},
			);
			for await (const raw of events) {
				const parsed = parseAgentEvent(raw);
				if (!parsed.ok) {
					failure = {
						kind: "provider",
						code: "AGENT_EVENT_INVALID",
						retryable: false,
						upstreamStatus: null,
					};
					break;
				}
				const event = parsed.value;
				if (event.type === "text.delta") {
					text += event.text;
					if (text.length > MAX_MODEL_OUTPUT_CHARS) {
						failure = {
							kind: "provider",
							code: "AGENT_OUTPUT_TOO_LARGE",
							retryable: false,
							upstreamStatus: null,
						};
						break;
					}
				} else if (event.type === "tool.request") {
					toolRequests.push({ toolId: event.toolId, args: event.args });
				} else if (event.type === "ui.command") {
					uiProposals.push(event.command);
				} else if (event.type === "usage") {
					reportedCost = event.knownCostUsd;
				} else if (event.type === "failed") {
					failure = {
						kind: "provider",
						code: event.code,
						retryable: event.retryable,
						upstreamStatus: event.upstreamStatus ?? null,
					};
					break;
				} else if (event.type === "completed") {
					finished = true;
					break;
				}
			}
		} catch (error) {
			// Adapters are contractually non-throwing; treat a throw as a provider failure, not a crash.
			failure = {
				kind: "provider",
				code: agentThrewCode(error),
				retryable: true,
				upstreamStatus: null,
			};
		}
		usage = addUsage(usage, { costUsd: reportedCost ?? null });
		if (typeof reportedCost === "number" && Number.isFinite(reportedCost)) {
			largestTurnCostUsd = Math.max(largestTurnCostUsd, reportedCost);
		}
		await deps.reporter.usage(usage);
		if (input.signal.aborted) return err({ kind: "aborted" });
		if (failure !== null) return err(failure);
		if (!finished) {
			return err({
				kind: "provider",
				code: "AGENT_STREAM_ENDED_EARLY",
				retryable: true,
				upstreamStatus: null,
			});
		}
		const spend = checkBudget(budget, usage, 0);
		if (!spend.ok && spend.error === "MAX_SPEND")
			return err({ kind: "budget", limit: "MAX_SPEND" });
		return ok({ text, toolRequests, uiProposals });
	}

	/** The run pauses for the owner whenever continuing would need spend they have not authorized. */
	const spendApproval = (failure: TurnFailure): PipelineOutcome | null => {
		if (failure.kind === "unknown-spend") {
			return {
				kind: "waiting_approval",
				approvalRequest: {
					reasonCode: "METERED_COST_UNKNOWN",
					detail:
						"A metered request did not report its cost, so total spend is unknown. Approve to continue.",
				},
				usage,
			};
		}
		if (failure.kind === "budget" && failure.limit === "MAX_SPEND") {
			return {
				kind: "waiting_approval",
				approvalRequest: {
					reasonCode: "SPEND_LIMIT_REACHED",
					detail: `Metered spend is ${usage.knownCostUsd.toFixed(4)} USD of the authorized ${budget.maxSpendUsd ?? 0} USD; the next request could exceed it.`,
				},
				usage,
			};
		}
		return null;
	};
	const failureCode = (failure: Exclude<TurnFailure, { kind: "aborted" }>): string =>
		failure.kind === "budget"
			? failure.limit
			: failure.kind === "unknown-spend"
				? "METERED_COST_UNKNOWN"
				: failure.code;
	/** The provider's answer status behind a turn failure, unchanged (§4a). */
	const failureStatus = (failure: Exclude<TurnFailure, { kind: "aborted" }>): number | null =>
		failure.kind === "provider" ? failure.upstreamStatus : null;

	/**
	 * ADR-0079: the planner judged the question to need no research. One turn
	 * answers it from general knowledge (with an optional flow diagram); the
	 * stages are still walked in order, the answer carries the pipeline's
	 * "not researched" note, and nothing is presented as verified.
	 */
	async function answerDirectly(): Promise<PipelineOutcome> {
		await deps.reporter.note(
			"The planner judged that this question needs no research; answering from the model's general knowledge.",
		);
		await deps.reporter.state("analyzing");
		const answered = await turn(
			directAnswerPrompt({
				request,
				nowIso: deps.clock.nowIso(),
				conversationContext: input.conversationContext,
				fenceToken: deps.newFenceToken(),
			}),
		);
		if (!answered.ok) {
			if (answered.error.kind === "aborted") return { kind: "cancelled", usage };
			const pause = spendApproval(answered.error);
			if (pause !== null) return pause;
			return failed(
				failureCode(answered.error),
				answered.error.kind === "provider" && answered.error.retryable,
				null,
				failureStatus(answered.error),
			);
		}
		await deps.reporter.state("verifying");
		const parts = readDirectAnswer(answered.value.text);
		if (parts === null) return failed("DIRECT_ANSWER_INVALID", false);
		for (const note of parts.notes) await deps.reporter.note(note);
		await deps.reporter.state("publishing");
		const bundle = researchBundleSchema.safeParse({
			evidence: [],
			claims: [],
			scenarios: [],
			securities: [],
			supplierLinks: [],
			financialObservations: [],
			positionObservations: [],
			investorFilings: [],
			pricingPower: [],
			datasets: [],
			uiOperations:
				parts.diagram === null
					? []
					: [
							{
								operation: "component.create",
								componentId: `${runId}_diagram`,
								componentType: "flow-diagram",
								schemaVersion: 1,
								props: parts.diagram,
							},
						],
			answerText: `${parts.answer}\n\n${directAnswerNote(request.question)}`.slice(0, 6000),
			answerClaimIds: [],
			verificationStatus: "unverified",
			provenance: {
				agentId: deps.agent.agentId,
				providerModel: request.model ?? probe.capabilities.model ?? null,
				promptVersion: PROMPT_VERSION,
				toolVersions: Object.fromEntries(
					deps.tools.list().map((tool) => [tool.toolId, tool.version]),
				),
				dataCutoffAt: deps.clock.nowIso(),
			},
		});
		if (!bundle.success) {
			await deps.reporter.note(
				`Bundle failed contract validation at: ${bundle.error.issues
					.slice(0, 4)
					.map((issue) => issue.path.join("."))
					.join("; ")}`,
			);
			return failed("BUNDLE_INVALID", false);
		}
		return { kind: "completed", bundle: bundle.data, articles: [], usage };
	}

	/* ----- Planning and collection ----- */
	await deps.reporter.state("planning");
	const collected: Collected = {
		evidence: [],
		securities: [],
		financialObservations: [],
		positionObservations: [],
		investorFilings: [],
		articles: [],
		entries: [],
	};
	const uiProposals: unknown[] = [];
	// Collection stops before the reserved tail so a run that needs the
	// analysis repair turn still reaches independent verification (AGT-013).
	// Counted from what is left of the run's allowance, which earlier attempts may have used.
	const remainingSteps = Math.max(0, budget.maxAgentSteps - usage.agentSteps);
	const reservedSteps = reservedPostCollectionSteps(remainingSteps);
	const collectionSteps = Math.max(0, remainingSteps - reservedSteps);
	let reachedCollecting = false;
	let stoppedBy: BudgetLimit | null = null;
	// Executed tool calls (authorized and run, whether they returned evidence
	// or failed): when at least one ran and none succeeded, the run failed as
	// ALL_TOOL_CALLS_FAILED with the most frequent tool error code, not as
	// NO_EVIDENCE_COLLECTED. Denied requests never ran and are not counted.
	let executedToolCalls = 0;
	let succeededToolCalls = 0;
	let deniedToolCalls = 0;
	// Planning accounting for the NO_EVIDENCE_COLLECTED detail (ADR-0025):
	// valid plans parsed, tool calls ever requested, and invalid replies.
	let validPlanCount = 0;
	let requestedToolCalls = 0;
	let invalidPlanCount = 0;
	// ADR-0025 reminder: when the first valid plan asks for no tools while
	// nothing has been collected, executed or denied, the next collection
	// step carries a short note saying so. At most one reminder per run, and
	// it uses the next step of the same collection allowance (no extra steps).
	let reminderSent = false;
	let reminderPending: string | null = null;
	const toolErrorCounts = new Map<string, number>();
	// Per tool error code: each upstream status seen, how often and the index
	// of its latest call — for `toolErrorStatus` (§4a rule 6).
	const toolErrorStatuses = new Map<string, Map<number, { count: number; last: number }>>();
	const completedRequests = new Set<string>();
	const unavailableTools = new Set<string>();
	const securityIdByListing = new Map<string, string>();
	const remappedSecurityId = new Map<string, string>();
	const knownCollectedSecurityIds = new Set<string>();
	const seenFinancialObservationKeys = new Set<string>();
	let collectionLimitReached = false;
	let searchCooldownEncountered = false;
	let foundSearchLeads = false;
	let webSearchRequested = false;

	collection: for (let step = 0; step < collectionSteps; step += 1) {
		// Spend the remaining model turns on analysis and verification instead
		// of an open-ended search for more sources.
		if (step >= 3) {
			collectionLimitReached = true;
			await deps.reporter.note(
				collected.evidence.length === 0
					? "Collection ended after three planning rounds without citeable evidence."
					: "Collection stopped after three planning rounds.",
			);
			break;
		}
		const remainingToolCalls = budget.maxToolCalls - usage.toolCalls;
		if (remainingToolCalls <= 0) break;
		// No round follows the last one to open search results (ADR-0078).
		const finalRound = step + 1 >= Math.min(collectionSteps, 3);
		const searchBeforeFinal =
			!finalRound &&
			step + 2 === Math.min(collectionSteps, 3) &&
			collected.evidence.length === 0 &&
			permittedToolIds.has("web.search") &&
			!unavailableTools.has("web.search") &&
			!webSearchRequested;
		// ADR-0079: only the first round, before anything was collected, may
		// decide that the question needs no research. A news task always researches.
		const routingRound =
			step === 0 && collected.entries.length === 0 && request.outputType !== "news";
		const roundReminder =
			!permittedToolIds.has("web.fetch_page") && permittedToolIds.has("stocks.search")
				? [
						permittedToolIds.has("web.extract")
							? "Use web.search for discovery and web.extract to read relevant original pages. For news.search, use keywords of at least three characters, e.g. artificial intelligence. Use the exact company name alone when searching stored records before adding topic terms. A general feed is a recent snapshot. Use only sources relevant to the requested company and state when evidence is missing."
							: "Use web.search for discovery when listed. Direct page fetching is unavailable. Use listed stored-record, subscribed-feed, or official-data tools to collect citeable evidence, and disclose remaining gaps.",
						reminderPending,
					]
						.filter(Boolean)
						.join(" ")
				: reminderPending;
		const stageNote = finalRound
			? PLANNING_FINAL_ROUND_NOTE
			: searchBeforeFinal
				? PLANNING_SEARCH_BEFORE_FINAL_NOTE
				: null;
		const prompt = planningPrompt({
			request,
			nowIso: deps.clock.nowIso(),
			tools: permittedTools.filter((tool) => !unavailableTools.has(tool.toolId)),
			sources: input.sources,
			collectedSoFar: collectedSoFarText(collected.entries, step),
			remainingToolCalls,
			conversationContext: input.conversationContext,
			fenceToken: deps.newFenceToken(),
			promptBudgetBytes: PLANNING_PROMPT_BUDGET_BYTES,
			routing: routingRound,
			reminder: [roundReminder, stageNote].filter(Boolean).join(" ") || null,
		});
		// The reminder is consumed by the prompt it was attached to.
		reminderPending = null;
		// Fail closed: the builder guarantees the ceiling, so reaching it means
		// a bug — stop collecting rather than send an over-budget prompt.
		const promptBytes = byteLength(prompt);
		if (promptBytes > PLANNING_PROMPT_BUDGET_BYTES) {
			await deps.reporter.note("Planning stopped early: the prompt would exceed its byte budget.");
			stoppedBy = "MAX_INPUT_BYTES";
			break;
		}
		const planned = await turn(prompt, promptBytes);
		if (!planned.ok) {
			if (planned.error.kind === "aborted") return { kind: "cancelled", usage };
			const pause = spendApproval(planned.error);
			if (pause !== null) return pause;
			if (planned.error.kind === "budget") {
				stoppedBy = planned.error.limit;
				break;
			}
			if (planned.error.kind === "provider" && collected.evidence.length === 0) {
				return failed(
					planned.error.code,
					planned.error.retryable,
					null,
					planned.error.upstreamStatus,
				);
			}
			await deps.reporter.note(`Planning stopped early: ${failureCode(planned.error)}.`);
			break;
		}
		uiProposals.push(...planned.value.uiProposals);
		const json = extractJsonObject(planned.value.text);
		const parsedPlan = json.ok ? planSchema.safeParse(json.value) : null;
		// ADR-0028: a backend may deliver the plan as tool requests instead of
		// JSON text (a model that calls the listed research tools natively).
		// Those requests ARE the plan; they are authorized below like any other.
		const plan =
			parsedPlan?.success === true
				? parsedPlan.data
				: planned.value.toolRequests.length > 0
					? { toolCalls: [], done: false, needsResearch: true }
					: null;
		if (plan === null) {
			invalidPlanCount += 1;
			await deps.reporter.note("The planning reply was not valid JSON; no tools were run for it.");
			continue;
		}
		if (!reachedCollecting) {
			await deps.reporter.state("collecting");
			reachedCollecting = true;
		}
		const calls = [...plan.toolCalls, ...planned.value.toolRequests].slice(
			0,
			MAX_TOOL_CALLS_PER_REPLY,
		);
		validPlanCount += 1;
		requestedToolCalls += calls.length;
		if (calls.some((call) => call.toolId === "web.search")) {
			webSearchRequested = true;
		}
		let executedInRound = 0;
		let repeatedInRound = 0;
		let deniedInRound = 0;
		let refusedFinalRoundSearchInRound = 0;
		const logPlanningRound = () => {
			deps.reporter.planningRound?.({
				round: step + 1,
				finalRound,
				requestedToolIds: formatRequestedToolIds(calls),
				executed: executedInRound,
				repeated: repeatedInRound,
				denied: deniedInRound,
				refusedFinalRoundSearch: refusedFinalRoundSearchInRound,
			});
		};
		if (routingRound && calls.length === 0 && plan.needsResearch === false) {
			logPlanningRound();
			return answerDirectly();
		}
		// ADR-0025 reminder: a valid plan that asks for nothing while nothing
		// has been collected, executed or denied gets one retry with a note.
		// It consumes the next step of the same collection allowance.
		if (
			calls.length === 0 &&
			!reminderSent &&
			collected.evidence.length === 0 &&
			collected.entries.length === 0 &&
			executedToolCalls === 0 &&
			deniedToolCalls === 0
		) {
			if (step + 1 < collectionSteps) {
				reminderSent = true;
				reminderPending = PLANNING_REMINDER;
				logPlanningRound();
				await deps.reporter.note("The plan requested no tools; asking the model again.");
				await deps.reporter.usage(usage);
				continue;
			}
		}
		// Batch consecutive page reads or stock and SEC financial reads.
		// Authorization, de-duplication, final-round rules, and budgets are
		// checked in plan order, and results are recorded in that order.
		let callIndex = 0;
		while (callIndex < calls.length) {
			let batchEnd = callIndex + 1;
			if (PAGE_READ_TOOL_IDS.has(calls[callIndex]?.toolId ?? "")) {
				while (batchEnd < calls.length && PAGE_READ_TOOL_IDS.has(calls[batchEnd]?.toolId ?? "")) {
					batchEnd += 1;
				}
			}
			if (PARALLEL_STOCK_TOOL_IDS.has(calls[callIndex]?.toolId ?? "")) {
				while (
					batchEnd - callIndex < MAX_PARALLEL_STOCK_CALLS &&
					PARALLEL_STOCK_TOOL_IDS.has(calls[batchEnd]?.toolId ?? "")
				) {
					batchEnd += 1;
				}
			}
			const batch: {
				readonly call: (typeof calls)[number];
				readonly label: string;
				readonly requestKey: string;
				readonly start: () => Promise<{
					readonly result: Awaited<ReturnType<typeof executeToolCall>>;
					readonly deadlineReached: boolean;
				}>;
			}[] = [];
			const batchKeys = new Set<string>();
			// A limit reached while preparing stops collection once the calls
			// already started have been recorded, as when they ran one by one.
			let stopAfterBatch = false;
			for (; callIndex < batchEnd; callIndex += 1) {
				const call = calls[callIndex];
				if (call === undefined) break;
				if (input.signal.aborted) return { kind: "cancelled", usage };
				const label = call.toolId.slice(0, 80);
				const authorized = authorizeToolCall(
					deps.tools,
					{ permittedToolIds, remainingToolCalls: budget.maxToolCalls - usage.toolCalls },
					call,
				);
				if (!authorized.ok) {
					deniedToolCalls += 1;
					deniedInRound += 1;
					await deps.reporter.tool(label, "denied", authorized.error);
					const note = `Tool request ${label} was denied: ${authorized.error}.`;
					collected.entries.push({ step, fullText: note, digestLines: [note] });
					if (authorized.error === "TOOL_CALL_BUDGET_EXHAUSTED") {
						stoppedBy = "MAX_TOOL_CALLS";
						stopAfterBatch = true;
						break;
					}
					continue;
				}
				const requestKey = `${call.toolId}\n${JSON.stringify(authorized.value.args)}`;
				if (completedRequests.has(requestKey) || batchKeys.has(requestKey)) {
					repeatedInRound += 1;
					await deps.reporter.tool(label, "denied", "REPEATED_REQUEST");
					const note = `Tool ${label} was not repeated; use its earlier result or another tool.`;
					collected.entries.push({ step, fullText: note, digestLines: [note] });
					continue;
				}
				if (unavailableTools.has(call.toolId)) {
					const note = `Tool ${label} was not repeated; use its earlier result or another tool.`;
					collected.entries.push({ step, fullText: note, digestLines: [note] });
					continue;
				}
				if (finalRound && DISCOVERY_TOOL_IDS.has(call.toolId)) {
					// Leads are only evidence once a page is read, and no round follows to read them.
					refusedFinalRoundSearchInRound += 1;
					await deps.reporter.tool(label, "denied", "FINAL_ROUND_NO_SEARCH");
					const note = `Tool ${label} was not run: search results cannot be opened after the final collection round.`;
					collected.entries.push({ step, fullText: note, digestLines: [note] });
					continue;
				}
				const withinBudget = checkBudget(budget, usage, elapsedMs(), { toolCalls: 1 });
				if (!withinBudget.ok) {
					stoppedBy = withinBudget.error;
					stopAfterBatch = true;
					break;
				}
				usage = addUsage(usage, { toolCalls: 1 });
				// A tool may not outlive the run: its signal also fires at the run's wall-clock deadline.
				const runDeadline = AbortSignal.timeout(Math.max(1, budget.maxWallClockMs - elapsedMs()));
				batchKeys.add(requestKey);
				batch.push({
					call,
					label,
					requestKey,
					// Started together once the batch is prepared, in plan order.
					start: async () => {
						const result = await executeToolCall(authorized.value, {
							...toolContext,
							signal: AbortSignal.any([input.signal, runDeadline]),
						});
						return { result, deadlineReached: runDeadline.aborted && !input.signal.aborted };
					},
				});
			}
			const results = await Promise.all(batch.map((prepared) => prepared.start()));
			for (const [position, started] of batch.entries()) {
				const { call, label, requestKey } = started;
				const completed = results[position];
				if (completed === undefined) continue;
				const { result, deadlineReached } = completed;
				if (deadlineReached) {
					executedToolCalls += 1;
					executedInRound += 1;
					toolErrorCounts.set("MAX_WALL_CLOCK", (toolErrorCounts.get("MAX_WALL_CLOCK") ?? 0) + 1);
					await deps.reporter.tool(label, "failed", "MAX_WALL_CLOCK");
					stoppedBy = "MAX_WALL_CLOCK";
					logPlanningRound();
					break collection;
				}
				executedToolCalls += 1;
				executedInRound += 1;
				if (!result.ok) {
					if (
						call.toolId === "web.search" &&
						(result.error.upstreamStatus === 432 || result.error.code === "SEARCH_PLAN_LIMIT")
					) {
						unavailableTools.add(call.toolId);
						searchCooldownEncountered = true;
						const note = "General web search is unavailable for this run.";
						collected.entries.push({ step, fullText: note, digestLines: [note] });
						continue;
					}
					if (result.error.code === "NOT_CONFIGURED" || result.error.code === "SEARCH_COOLDOWN") {
						unavailableTools.add(call.toolId);
					}
					if (result.error.code === "SEARCH_COOLDOWN") searchCooldownEncountered = true;
					const code = sanitizeToolErrorCode(result.error.code.slice(0, 80));
					toolErrorCounts.set(code, (toolErrorCounts.get(code) ?? 0) + 1);
					const upstreamStatus = result.error.upstreamStatus;
					if (upstreamStatus !== undefined) {
						const statuses =
							toolErrorStatuses.get(code) ?? new Map<number, { count: number; last: number }>();
						const seen = statuses.get(upstreamStatus);
						statuses.set(upstreamStatus, {
							count: (seen?.count ?? 0) + 1,
							last: executedToolCalls,
						});
						toolErrorStatuses.set(code, statuses);
					}
					const detail = result.error.code.slice(0, 300);
					await deps.reporter.tool(label, "failed", detail);
					const note = `Tool ${label} failed: ${detail}.`;
					collected.entries.push({ step, fullText: note, digestLines: [note] });
					continue;
				}
				succeededToolCalls += 1;
				completedRequests.add(requestKey);
				const output = result.value;
				// Search snippets are planning leads. Only the fetched original can support a claim.
				const discovery = DISCOVERY_TOOL_IDS.has(call.toolId);
				if (discovery) foundSearchLeads ||= output.evidence.length > 0;
				else collected.evidence.push(...output.evidence);
				for (const sec of output.securities) {
					const listingKey = `${sec.country}:${sec.exchange.toLowerCase()}:${sec.ticker.toUpperCase()}`;
					const existingId = securityIdByListing.get(listingKey);
					if (existingId !== undefined) {
						remappedSecurityId.set(sec.securityId, existingId);
					} else {
						securityIdByListing.set(listingKey, sec.securityId);
						remappedSecurityId.set(sec.securityId, sec.securityId);
						knownCollectedSecurityIds.add(sec.securityId);
						collected.securities.push(sec);
					}
				}
				for (const obs of output.financialObservations) {
					const mappedSecId = remappedSecurityId.get(obs.securityId) ?? obs.securityId;
					if (knownCollectedSecurityIds.has(mappedSecId)) {
						const periodKey =
							obs.period === null ? "null" : `${obs.period.fiscalYear}:${obs.period.fiscalPeriod}`;
						const obsKey = `${mappedSecId}:${obs.metricCode}:${periodKey}`;
						if (seenFinancialObservationKeys.has(obsKey)) continue;
						seenFinancialObservationKeys.add(obsKey);
					}
					collected.financialObservations.push(
						mappedSecId === obs.securityId ? obs : { ...obs, securityId: mappedSecId },
					);
				}
				for (const pos of output.positionObservations) {
					const mappedSecId = remappedSecurityId.get(pos.securityId) ?? pos.securityId;
					collected.positionObservations.push(
						mappedSecId === pos.securityId ? pos : { ...pos, securityId: mappedSecId },
					);
				}
				collected.investorFilings.push(...output.investorFilings);
				collected.articles.push(...output.articles);
				collected.entries.push({
					step,
					fullText: `Result of ${label}:\n${output.modelText}`,
					digestLines: digestLinesFor(call.toolId, output),
				});
				await deps.reporter.tool(
					label,
					"executed",
					`${output.evidence.length} ${discovery ? "search lead(s)" : "evidence item(s)"}`,
				);
			}
			if (stopAfterBatch) {
				logPlanningRound();
				break collection;
			}
		}
		logPlanningRound();
		await deps.reporter.usage(usage);
		if (calls.length > 0 && repeatedInRound === calls.length) {
			reminderPending = PLANNING_REPEAT_NOTE;
			if (collected.evidence.length === 0) continue;
		}
		// A plan's done flag predates its tool results. A paused search with
		// no evidence needs another plan, rather than immediate failure.
		if (searchCooldownEncountered && collected.evidence.length === 0) {
			reminderPending =
				"Search is temporarily unavailable. Continue collecting evidence with another listed tool, subscribed feeds, stored records or known source URLs. Do not repeat a paused search or invent URLs.";
			if (step + 1 < Math.min(collectionSteps, 3)) {
				await deps.reporter.note(
					"Search is temporarily unavailable; continuing with other sources.",
				);
			}
			continue;
		}
		if (
			(toolErrorCounts.has("ROBOTS_DISALLOWED") || toolErrorCounts.has("EXTRACT_NO_CONTENT")) &&
			collected.evidence.length === 0
		) {
			reminderPending =
				"A page blocked automated access. Use an accessible original page from a different publisher, an official API, or stored records. In the final collection round, fetch an available source before requesting more search leads.";
			continue;
		}
		if (
			foundSearchLeads &&
			collected.evidence.length === 0 &&
			(permittedToolIds.has("web.extract") || permittedToolIds.has("web.fetch_page"))
		) {
			reminderPending =
				"Open relevant original pages from the search leads and assess the sources before ending collection.";
			continue;
		}
		if (plan.done || calls.length === 0) break;
	}
	if (!reachedCollecting) await deps.reporter.state("collecting");

	const articles = [
		...new Map(collected.articles.map((article) => [article.canonicalUrl, article])).values(),
	].slice(0, BUNDLE_LIMITS.articles);
	if (collected.evidence.length === 0) {
		if (toolErrorCounts.size > 0 && succeededToolCalls === 0) {
			const detail = mostFrequentToolError(toolErrorCounts);
			return failed("ALL_TOOL_CALLS_FAILED", false, detail, toolErrorStatus(detail));
		}
		// ADR-0025: NO_EVIDENCE_COLLECTED carries why. Precedence is fixed:
		// a success with no evidence beats a parse question (a success implies
		// a valid plan); a run with no valid plan at all is PLAN_NOT_JSON;
		// valid plans that never asked for anything are NO_TOOL_REQUESTED;
		// anything else (e.g. every request denied, or the budget stopped the
		// run before a tool could run) carries no detail.
		if (succeededToolCalls > 0) {
			return failed("NO_EVIDENCE_COLLECTED", false, "TOOLS_RETURNED_NOTHING");
		}
		if (validPlanCount === 0 && invalidPlanCount > 0) {
			return failed("NO_EVIDENCE_COLLECTED", false, "PLAN_NOT_JSON");
		}
		if (requestedToolCalls === 0) {
			return failed("NO_EVIDENCE_COLLECTED", false, "NO_TOOL_REQUESTED");
		}
		return failed("NO_EVIDENCE_COLLECTED", false);
	}

	/* ----- Analysis ----- */
	await deps.reporter.state("analyzing");
	const packBudget = Math.min(
		EVIDENCE_PACK_MAX,
		Math.max(0, budget.maxInputBytes - usage.inputBytes - PROMPT_OVERHEAD_BYTES),
	);
	let evidencePack = "";
	let evidencePackBytes = 0;
	// Only evidence the model is actually shown may be cited: ids are guessable,
	// so an id outside the pack would be a citation of something it never read.
	const shown: CollectedEvidence[] = [];
	// An exact re-fetch carries no new quotable text, so the first copy carries
	// the citation and later copies with the same checksum are skipped (ADR-0010).
	const packedChecksums = new Set<string>();
	let duplicateEvidence = 0;
	for (const item of collected.evidence) {
		if (packedChecksums.has(item.evidence.checksum)) {
			duplicateEvidence += 1;
			continue;
		}
		const e = item.evidence;
		const entry = `[${e.evidenceId}] ${e.title} — ${e.publisher}; ${e.sourceUrl}; published ${e.publishedAt ?? "undated"}; retrieved ${e.retrievedAt}\n${item.retrievedText.slice(0, EVIDENCE_ITEM_MAX)}\n\n`;
		const entryBytes = byteLength(entry);
		if (evidencePackBytes + entryBytes > packBudget) break;
		// Each entry ends with a newline, so UTF-8 byte counts add across entries.
		evidencePackBytes += entryBytes;
		evidencePack += entry;
		packedChecksums.add(item.evidence.checksum);
		shown.push(item);
	}
	if (shown.length === 0) return failed("MAX_INPUT_BYTES", false);
	const evidenceById = new Map(shown.map((item) => [item.evidence.evidenceId, item]));
	const omittedEvidence = collected.evidence.length - shown.length;
	const recordSummary =
		[
			...collected.securities.map(
				(s) => `security ${s.issuerName} ${s.exchange}:${s.ticker} (${s.country})`,
			),
			...collected.financialObservations.map(
				(o) => `${o.metricCode} = ${o.value ?? `unavailable (${o.unavailableReason})`}`,
			),
			...collected.investorFilings.map(
				(f) =>
					`${f.form} of ${f.investorName}, period ending ${f.reportPeriodEnd}, filed ${f.filedAt}`,
			),
		]
			.join("\n")
			.slice(0, 8_000) || "(none)";

	const shownEvidenceIds = new Set(evidenceById.keys());
	const evidenceTexts = shown.map((item) => ({
		evidenceId: item.evidence.evidenceId,
		retrievedText: `${item.evidence.title}\n${item.retrievedText.slice(0, EVIDENCE_ITEM_MAX)}`,
	}));
	const claimDrafts = (claims: AnalysisDraft["claims"]) =>
		claims.map((claim, index) => ({
			claimId: `draft_${index}`,
			text: claim.text,
			claimType: claim.claimType,
			links: claim.evidence.map((link) => ({
				evidenceId: resolveClaimEvidenceId(runId, link.evidenceId, shownEvidenceIds),
				relation: link.relation,
				quote: link.quote === "" ? null : link.quote,
			})),
		}));
	const now = deps.clock.nowIso();
	const dataCutoffAt = now;
	const hasToolRecords =
		collected.financialObservations.length +
			collected.positionObservations.length +
			collected.investorFilings.length >
		0;
	let repairNote: string | null = null;
	let draft: ReturnType<typeof analysisDraftSchema.safeParse> | null = null;
	let checkedClaims: ReturnType<typeof verifyClaims> | undefined;
	let analysisFailure: string | null = null;
	// The provider's status behind `analysisFailure`, unchanged (§4a); null when none.
	let analysisFailureStatus: number | null = null;
	for (let attempt = 0; attempt < 2 && draft?.success !== true; attempt += 1) {
		const attemptStarted = performance.now();
		const prompt = analysisPrompt({
			request,
			nowIso: now,
			evidencePack,
			recordSummary,
			datasetGuide: datasetGuide(runId),
			existingComponents: input.workspaceComponents,
			conversationContext: input.conversationContext,
			fenceToken: deps.newFenceToken(),
			repairNote,
		});
		const inputBytes = byteLength(prompt);
		const modelTurnStarted = performance.now();
		const analysed = await turn(prompt, inputBytes);
		const modelTurnSeconds = (performance.now() - modelTurnStarted) / 1_000;
		const logAttempt = (reason: string, retryable = false) => {
			if (!deps.reporter.analysisAttempt) return;
			deps.reporter.analysisAttempt({
				analysisAttempt: attempt + 1,
				durationSeconds: (performance.now() - attemptStarted) / 1_000,
				modelTurnSeconds,
				inputBytes,
				outputBytes: analysed.ok ? byteLength(analysed.value.text) : null,
				reason,
				willRetry: retryable && attempt === 0,
			});
		};
		if (!analysed.ok) {
			if (analysed.error.kind === "aborted") {
				logAttempt("aborted");
				return { kind: "cancelled", usage };
			}
			const code = failureCode(analysed.error);
			const truncated = code === "PROVIDER_OUTPUT_TRUNCATED";
			logAttempt(truncated ? "output_truncated" : analysed.error.kind, truncated);
			const pause = spendApproval(analysed.error);
			if (pause !== null) return pause;
			analysisFailure = code;
			analysisFailureStatus = failureStatus(analysed.error);
			// A smaller answer can recover within the existing repair allowance and budgets.
			if (truncated && attempt === 0) {
				repairNote =
					"the provider truncated the previous reply at its output limit. Return a smaller complete JSON object: at most 6 short atomic claims with only the shortest sufficient verbatim supporting quotes; omit optional uiOperations and leave unrelated scenarios, suppliers and pricingPower empty. Prioritize the direct answer and state coverage limitations; do not repeat structured records.";
				continue;
			}
			break;
		}
		uiProposals.push(...analysed.value.uiProposals);
		const json = extractJsonObject(analysed.value.text);
		if (!json.ok) {
			logAttempt("invalid_json", true);
			repairNote = "the reply contained no parseable JSON object";
			analysisFailure = "ANALYSIS_OUTPUT_INVALID";
			analysisFailureStatus = null;
			continue;
		}
		draft = analysisDraftSchema.safeParse(json.value);
		if (!draft.success) {
			logAttempt("invalid_schema", true);
			repairNote = `invalid fields: ${draft.error.issues
				.slice(0, 6)
				.map((issue) => issue.path.join("."))
				.join(", ")}`;
			analysisFailure = "ANALYSIS_OUTPUT_INVALID";
			analysisFailureStatus = null;
		} else if (draft.data.claims.length === 0 && !hasToolRecords) {
			logAttempt("no_claims_without_tool_records", true);
			repairNote =
				"claims is empty despite retrieved evidence. Answer the question with cited findings or cited exclusions/data limitations for the inspected candidates; use inference for calculations and quote the source inputs. Do not fabricate a match or claim exhaustive coverage.";
			draft = null;
			analysisFailure = "ANALYSIS_OUTPUT_INVALID";
			analysisFailureStatus = null;
		} else {
			if (attempt === 0 && draft.data.claims.length > 0) {
				const checked = verifyClaims(claimDrafts(draft.data.claims), evidenceTexts);
				if (checked.every((claim) => claim.status === "unsupported")) {
					logAttempt("all_claims_unsupported", true);
					repairNote =
						"none of the claims has usable quoted support from a shown evidence id. Return at most 6 short atomic claims. Use only the exact ids printed in square brackets in the Evidence section; never invent ids or use an article id. Copy each supporting quote word-for-word from that evidence, including original dates and numbers, and use a passage at least 12 characters long. Never paraphrase a quote, change a year, or join nonadjacent passages. Omit claims you cannot quote. Observation numbers must retain the source digits and units (for example $108.5 billion, not 1085億ドル). A unit conversion is a calculation: use inference and quote the original inputs. Never change source years. Leave unrelated scenarios, suppliers and pricingPower empty. Valid evidence ids: " +
						JSON.stringify([...shownEvidenceIds].slice(0, 12));
					draft = null;
					analysisFailure = "ANALYSIS_OUTPUT_INVALID";
					analysisFailureStatus = null;
					continue;
				}
				checkedClaims = checked;
			}
			logAttempt("accepted");
			analysisFailure = null;
			analysisFailureStatus = null;
		}
	}
	const analysis = draft?.success === true ? draft.data : null;
	const notes: string[] = [];
	if (collectionLimitReached)
		notes.push(
			"Collection was limited to three planning rounds; additional sources may not have been retrieved.",
		);
	if (omittedEvidence > 0) {
		notes.push(
			duplicateEvidence > 0
				? `${omittedEvidence} retrieved item(s) were not analysed: ${duplicateEvidence} exact duplicate(s) skipped; ${omittedEvidence - duplicateEvidence} item(s) did not fit the input-size budget.`
				: `${omittedEvidence} retrieved item(s) did not fit the input-size budget and were not analysed.`,
		);
	}
	if (analysis === null && !hasToolRecords) {
		return failed(
			analysisFailure ?? "ANALYSIS_FAILED",
			analysisFailure !== "ANALYSIS_OUTPUT_INVALID" &&
				analysisFailure !== "PROVIDER_OUTPUT_TRUNCATED",
			null,
			analysisFailureStatus,
		);
	}

	/* ----- Verification: deterministic checks first, then an independent model pass ----- */
	await deps.reporter.state("verifying");
	const knownEvidence = (ids: readonly string[]) => [
		...new Set(ids.filter((id) => evidenceById.has(id))),
	];

	// Claim IDs label the results, so allocate them only for the accepted draft.
	const acceptedClaims = analysis?.claims ?? [];
	const verified =
		checkedClaims ??
		(acceptedClaims.length === 0 ? [] : verifyClaims(claimDrafts(acceptedClaims), evidenceTexts));
	let claims: Claim[] = verified.map((claim) => ({
		claimId: nextId("cl"),
		text: claim.text,
		claimType: claim.claimType,
		status: claim.status,
		links: claim.links.map((link) => ({ ...link })),
		issues: claim.issues.slice(0, 24),
	}));

	// Deterministic checks show the quotes exist; they do not show the quotes entail the
	// claim. Until an independent verdict confirms it, a claim is not "supported" (AGT-013).
	let verdictByIndex: ReadonlyMap<number, "supported" | "unsupported" | "contradicted"> | null =
		null;
	const candidates = claims
		.map((claim, index) => ({ claim, index }))
		.filter(({ claim }) => claim.status === "supported");
	if (candidates.length > 0) {
		const checked = await turn(
			verificationPrompt({
				claims: candidates.map(({ claim, index }) => ({
					index,
					text: claim.text,
					passages: claim.links
						.filter((link) => link.relation === "supports" && link.quote !== null)
						.map((link) => `"${link.quote}"`)
						.join("\n"),
				})),
				fenceToken: deps.newFenceToken(),
				...(permittedToolIds.has("web.extract") ? { question: request.question } : {}),
			}),
		);
		if (!checked.ok) {
			if (checked.error.kind === "aborted") return { kind: "cancelled", usage };
			const pause = spendApproval(checked.error);
			if (pause !== null) return pause;
			notes.push(
				`Independent verification did not run (${failureCode(checked.error)}); no claim is reported as supported.`,
			);
		} else {
			const json = extractJsonObject(checked.value.text);
			const verdicts = json.ok ? verdictsSchema.safeParse(json.value) : null;
			if (verdicts === null || !verdicts.success) {
				notes.push(
					"Independent verification returned no usable verdicts; no claim is reported as supported.",
				);
			} else {
				verdictByIndex = new Map(
					verdicts.data.verdicts.map((verdict) => [verdict.claimIndex, verdict.verdict]),
				);
			}
		}
	}
	const verifierRan = verdictByIndex !== null;
	// Verification can only downgrade. A claim the verifier rejected, skipped, or never got to
	// judge loses "supported"; nothing is ever upgraded.
	claims = claims.map((claim, index) =>
		claim.status === "supported" && verdictByIndex?.get(index) !== "supported"
			? {
					...claim,
					status: "unsupported" as const,
					issues: [...claim.issues, { code: "NOT_INDEPENDENTLY_VERIFIED" as const }].slice(0, 24),
				}
			: claim,
	);
	// Quotes were needed in memory to verify; they are stored only where the source's
	// license permits keeping a passage (DATA-010).
	const mayRetainQuote = (evidenceId: string) =>
		evidenceById.get(evidenceId)?.retainQuotes === true;
	claims = claims.map((claim) => ({
		...claim,
		links: claim.links.map((link) =>
			mayRetainQuote(link.evidenceId) ? link : { ...link, quote: null },
		),
	}));
	/** Text of a shown evidence item exactly as the model saw it. */
	const shownText = (evidenceId: string): string | null => {
		const item = evidenceById.get(evidenceId);
		return item === undefined
			? null
			: `${item.evidence.title}\n${item.retrievedText.slice(0, EVIDENCE_ITEM_MAX)}`;
	};

	const scenarios: DemandScenario[] = [];
	const scenarioIdByDraftIndex = new Map<number, string>();
	(analysis?.scenarios ?? []).forEach((raw, index) => {
		const parsed = draftScenarioSchema.safeParse(raw);
		if (!parsed.success) {
			notes.push(`Scenario ${index + 1} was dropped: malformed.`);
			return;
		}
		const scenario = withVerifiedBaseline(parsed.data, shownText, notes, index);
		const derived = deriveScenarioCagr(scenario);
		if (!derived.ok) {
			notes.push(`Scenario ${index + 1} was dropped: ${derived.error.join(", ")}.`);
			return;
		}
		const scenarioId = nextId("sc");
		scenarioIdByDraftIndex.set(index, scenarioId);
		scenarios.push({
			scenarioId,
			productOrService: scenario.productOrService,
			quantityKind: scenario.quantityKind,
			unit: scenario.unit,
			baseYear: scenario.baseYear,
			targetYear: scenario.targetYear,
			baselineValue: scenario.baselineValue,
			bear: scenario.bear,
			base: scenario.base,
			bull: scenario.bull,
			drivers: scenario.drivers,
			barriers: scenario.barriers,
			falsifiers: scenario.falsifiers,
			methodology: scenario.methodology,
			derivedCagr: derived.value,
			baselineEvidenceId: scenario.baselineEvidenceId,
			baselineQuote:
				scenario.baselineEvidenceId !== null && mayRetainQuote(scenario.baselineEvidenceId)
					? scenario.baselineQuote
					: null,
			supportingEvidenceIds: knownEvidence(scenario.supportingEvidenceIds),
			contraryEvidenceIds: knownEvidence(scenario.contraryEvidenceIds),
		});
	});

	const securities: Security[] = [...collected.securities];
	const supplierLinks: SupplierLink[] = [];
	(analysis?.suppliers ?? []).forEach((raw, index) => {
		const parsed = draftSupplierSchema.safeParse(raw);
		if (!parsed.success) {
			notes.push(`Supplier ${index + 1} was dropped: malformed.`);
			return;
		}
		const supplier = parsed.data;
		// The relationship must rest on a passage that was shown, is quoted verbatim and names
		// the issuer. Any existing evidence id is not enough.
		const relationship = supplier.evidence.filter((link) => {
			const text = shownText(link.evidenceId);
			return (
				text !== null &&
				isPassageOf(link.quote, text) &&
				(mentions(text, supplier.issuerName) || mentions(text, supplier.ticker))
			);
		});
		if (relationship.length === 0) {
			notes.push(
				`Supplier ${supplier.issuerName} was dropped: no retrieved passage names it and establishes the relationship.`,
			);
			return;
		}
		const evidenceIds = [...new Set(relationship.map((link) => link.evidenceId))];
		// Figures in the description (e.g. "40% of revenue") must come from that same evidence.
		const citedNumbers = new Set(
			evidenceIds.flatMap((id) => extractNumberTokens(shownText(id) ?? "")),
		);
		const description = [supplier.businessExposure, ...supplier.productsOrServices].join(" ");
		const stray = extractNumberTokens(description).filter((token) => !citedNumbers.has(token));
		if (stray.length > 0) {
			notes.push(
				`Supplier ${supplier.issuerName} was dropped: its description states figures (${stray.slice(0, 3).join(", ")}) the cited evidence does not contain.`,
			);
			return;
		}
		if (!request.markets.includes(supplier.country)) {
			notes.push(`Supplier ${supplier.issuerName} was dropped: outside the requested markets.`);
			return;
		}
		let security = securities.find((s) => sameListing(s, supplier.ticker, supplier.exchange));
		if (security === undefined) {
			const candidate = securitySchema.safeParse({
				securityId: nextId("sec"),
				country: supplier.country,
				ticker: supplier.ticker,
				exchange: supplier.exchange,
				issuerName: supplier.issuerName,
				issuerIdentifier: null,
				listingCurrency: supplier.country === "JP" ? "JPY" : "USD",
				reportingCurrency: null,
				formerTickers: [],
				// No tool confirmed this ticker/exchange pair; it is shown as unverified.
				listingVerification: "unverified",
			});
			if (!candidate.success) {
				notes.push(`Supplier ${supplier.issuerName} was dropped: ticker/exchange not recognised.`);
				return;
			}
			security = candidate.data;
			securities.push(security);
		}
		const quoted = relationship.find((link) => mayRetainQuote(link.evidenceId));
		supplierLinks.push({
			supplierLinkId: nextId("sup"),
			scenarioId:
				supplier.scenarioIndex === null
					? null
					: (scenarioIdByDraftIndex.get(supplier.scenarioIndex) ?? null),
			securityId: security.securityId,
			productsOrServices: supplier.productsOrServices,
			businessExposure: supplier.businessExposure,
			evidenceIds,
			relationshipQuote: quoted?.quote ?? null,
		});
	});

	const pricingPower: PricingPowerRecord[] = [];
	(analysis?.pricingPower ?? []).forEach((raw, index) => {
		const parsed = draftPricingPowerSchema.safeParse(raw);
		if (!parsed.success) {
			notes.push(`Pricing-power entry ${index + 1} was dropped: malformed.`);
			return;
		}
		const entry = parsed.data;
		const security = securities.find((s) => sameListing(s, entry.ticker, entry.exchange));
		const evidenceIds = knownEvidence(entry.evidenceIds);
		if (security === undefined || evidenceIds.length === 0) {
			notes.push(`Pricing-power entry ${index + 1} was dropped: unknown security or no evidence.`);
			return;
		}
		// A figure is used only if the cited evidence states that number; otherwise it is
		// treated as undisclosed, which the classification handles explicitly.
		const disclosedNumbers = new Set(
			evidenceIds.flatMap((id) => extractNumberTokens(shownText(id) ?? "")),
		);
		let undisclosed = 0;
		const disclosed = (value: number | null): number | null => {
			if (value === null) return null;
			if (disclosedNumbers.has(String(Math.abs(value)))) return value;
			undisclosed += 1;
			return null;
		};
		const inputs = {
			revenueGrowthPct: disclosed(entry.revenueGrowthPct),
			priceRealizationPct: disclosed(entry.priceRealizationPct),
			volumeGrowthPct: disclosed(entry.volumeGrowthPct),
			mixEffectPct: disclosed(entry.mixEffectPct),
			fxEffectPct: disclosed(entry.fxEffectPct),
			inputCostChangePct: disclosed(entry.inputCostChangePct),
			grossMarginChangeBps: disclosed(entry.grossMarginChangeBps),
			operatingMarginChangeBps: disclosed(entry.operatingMarginChangeBps),
			managementCommentaryEvidenceIds: knownEvidence(entry.managementCommentaryEvidenceIds),
		};
		if (undisclosed > 0) {
			notes.push(
				`Pricing-power entry ${index + 1}: ${undisclosed} figure(s) not found in the cited evidence were treated as undisclosed.`,
			);
		}
		const assessment = assessPricingPower(inputs);
		const record = pricingPowerRecordSchema.safeParse({
			pricingPowerId: nextId("pp"),
			securityId: security.securityId,
			period: {
				fiscalYear: entry.fiscalYear,
				fiscalPeriod: entry.fiscalPeriod,
				periodStart: entry.periodStart,
				periodEnd: entry.periodEnd,
			},
			inputs,
			assessment: { ...assessment, missingInputs: [...assessment.missingInputs] },
			evidenceIds,
		});
		if (record.success) pricingPower.push(record.data);
		else notes.push(`Pricing-power entry ${index + 1} was dropped: invalid period.`);
	});

	const shownEvidenceForTables = new Map(
		shown.map((item) => [
			item.evidence.evidenceId,
			{
				evidence: item.evidence,
				shownText: `${item.evidence.title}\n${item.retrievedText.slice(0, EVIDENCE_ITEM_MAX)}`,
			},
		]),
	);
	const comparisonTables = buildComparisonTables({
		runId,
		rawTables: analysis?.comparisonTables ?? [],
		claims,
		shownEvidenceById: shownEvidenceForTables,
		notes,
	});

	/* ----- Publishing: assemble the bundle from verified pieces only ----- */
	await deps.reporter.state("publishing");
	const supportedCount = claims.filter((claim) => claim.status === "supported").length;
	const verificationStatus: ResearchBundle["verificationStatus"] =
		claims.length > 0 && supportedCount === claims.length && verifierRan
			? "verified"
			: supportedCount > 0
				? "partially-verified"
				: "unverified";

	// An observation must describe a security the bundle actually identifies (DATA-001). A tool
	// that could not tie its result to one is reported rather than stored as a dangling record.
	const knownSecurityIds = new Set(securities.map((security) => security.securityId));
	const identified = <T extends { readonly securityId: string }>(
		items: readonly T[],
		label: string,
	) => {
		const kept = items.filter((item) => knownSecurityIds.has(item.securityId));
		if (kept.length < items.length) {
			notes.push(
				`${items.length - kept.length} ${label} could not be linked to an identified security and were not stored.`,
			);
		}
		return kept;
	};
	const financialObservations = identified(
		collected.financialObservations,
		"financial observation(s)",
	).slice(0, BUNDLE_LIMITS.financialObservations);
	const positionObservations = identified(
		collected.positionObservations,
		"position observation(s)",
	).slice(0, BUNDLE_LIMITS.positionObservations);
	const investorFilings = collected.investorFilings.slice(0, BUNDLE_LIMITS.investorFilings);
	const citedIds = new Set<string>([
		...claims.flatMap((claim) => claim.links.map((link) => link.evidenceId)),
		...scenarios.flatMap((s) => [
			...s.supportingEvidenceIds,
			...s.contraryEvidenceIds,
			...(s.baselineEvidenceId === null ? [] : [s.baselineEvidenceId]),
		]),
		...supplierLinks.flatMap((link) => link.evidenceIds),
		...pricingPower.flatMap((p) => [...p.evidenceIds, ...p.inputs.managementCommentaryEvidenceIds]),
		...comparisonTables.flatMap((table) => table.sourceIds),
		...financialObservations.flatMap((o) =>
			o.sourceEvidenceId === null ? [] : [o.sourceEvidenceId],
		),
		...positionObservations.flatMap((o) =>
			o.sourceEvidenceId === null ? [] : [o.sourceEvidenceId],
		),
		...investorFilings.map((filing) => filing.sourceEvidenceId),
	]);
	const evidence = collected.evidence
		.map((item) => item.evidence)
		.filter((item) => citedIds.has(item.evidenceId))
		.slice(0, BUNDLE_LIMITS.evidence);

	// The published answer is assembled from verified records only. The model's own prose is
	// never published: it would be factual-sounding text with nothing behind it (AGT-009).
	const conflictingCount = claims.filter((c) => c.status === "conflicting").length;
	const unsupportedCount = claims.filter((c) => c.status === "unsupported").length;
	const listed = (status: Claim["status"], limit: number) =>
		claims
			.filter((claim) => claim.status === status)
			.slice(0, limit)
			.map((claim) => `- ${claim.text}`);
	const answerText = [
		analysis === null
			? `The analysis step did not produce usable output (${analysisFailure ?? "unknown"}). Records retrieved by tools are shown as-is.`
			: `${supportedCount} of ${claims.length} claim(s) are supported by retrieved evidence and independently confirmed; ${conflictingCount} have conflicting evidence and ${unsupportedCount} are unsupported.`,
		supportedCount === 0 ? "" : ["Supported findings:", ...listed("supported", 8)].join("\n"),
		conflictingCount === 0
			? ""
			: ["Findings with conflicting evidence:", ...listed("conflicting", 5)].join("\n"),
		unsupportedCount === 0
			? ""
			: [
					"Not supported (shown for transparency, do not rely on these):",
					...listed("unsupported", 5),
				].join("\n"),
		`${scenarios.length} demand scenario(s), ${supplierLinks.length} supplier link(s) and ${financialObservations.length} financial observation(s) are on the canvas.`,
		...notes,
		stoppedBy === null ? "" : `Collection stopped early at a budget limit: ${stoppedBy}.`,
		DISCLAIMER,
	]
		.filter((part) => part !== "")
		.join("\n\n")
		.slice(0, 6000);

	const presentation = buildPresentation({
		runId,
		question: request.question,
		nowIso: now,
		dataCutoffAt,
		claims,
		scenarios,
		securities,
		supplierLinks,
		financialObservations,
		positionObservations,
		evidence,
		comparisonTables,
	});
	const accepted: UiOperation[] = [];
	let rejectedProposals = 0;
	for (const proposal of [...(analysis?.uiOperations ?? []), ...uiProposals]) {
		const parsed = uiOperationSchema.safeParse(proposal);
		if (parsed.success && isModelAuthorable(parsed.data, runId)) accepted.push(parsed.data);
		else rejectedProposals += 1;
	}
	const proposed = namespaceModelComponents(accepted, runId);
	if (rejectedProposals > 0) {
		await deps.reporter.note(
			`${rejectedProposals} model display instruction(s) were refused (invalid, or outside what a model may author).`,
		);
	}

	// Validated at runtime against the contract the Worker enforces, so a mistake here
	// surfaces as a typed failure in the runner instead of a rejected submission.
	const bundle = researchBundleSchema.safeParse({
		evidence,
		claims: claims.slice(0, BUNDLE_LIMITS.claims),
		scenarios,
		securities: securities.slice(0, BUNDLE_LIMITS.securities),
		supplierLinks,
		financialObservations,
		positionObservations,
		investorFilings,
		pricingPower,
		datasets: presentation.datasets,
		uiOperations: [...presentation.uiOperations, ...proposed].slice(0, BUNDLE_LIMITS.uiOperations),
		answerText,
		answerClaimIds: claims.slice(0, BUNDLE_LIMITS.claims).map((claim) => claim.claimId),
		verificationStatus,
		provenance: {
			agentId: deps.agent.agentId,
			providerModel: request.model ?? probe.capabilities.model ?? null,
			promptVersion: PROMPT_VERSION,
			toolVersions: Object.fromEntries(
				deps.tools.list().map((tool) => [tool.toolId, tool.version]),
			),
			dataCutoffAt,
		},
	});
	if (!bundle.success) {
		await deps.reporter.note(
			`Bundle failed contract validation at: ${bundle.error.issues
				.slice(0, 4)
				.map((issue) => issue.path.join("."))
				.join("; ")}`,
		);
		return failed("BUNDLE_INVALID", false);
	}

	const incomplete = stoppedBy ?? analysisFailure;
	return incomplete === null
		? { kind: "completed", bundle: bundle.data, articles, usage }
		: {
				kind: "partial",
				failureCode: incomplete,
				// A budget stop is ours; only an analysis failure can carry a provider status.
				failureUpstreamStatus: stoppedBy === null ? analysisFailureStatus : null,
				bundle: bundle.data,
				articles,
				usage,
			};
}

/**
 * Keeps a scenario's baseline only if a verbatim passage of the cited evidence
 * — within the text the model was shown — states that number. Otherwise the
 * baseline becomes "no sourced baseline" and no growth rate is derived from it
 * (DATA-011). A matching number somewhere else in the document is not enough.
 */
function withVerifiedBaseline(
	scenario: DraftScenario,
	shownText: (evidenceId: string) => string | null,
	notes: string[],
	index: number,
): DraftScenario {
	const unsourced: DraftScenario = {
		...scenario,
		baselineValue: null,
		baselineEvidenceId: null,
		baselineQuote: null,
	};
	if (scenario.baselineValue === null) return unsourced;
	const text = scenario.baselineEvidenceId === null ? null : shownText(scenario.baselineEvidenceId);
	const quote = scenario.baselineQuote;
	const stated =
		text !== null &&
		quote !== null &&
		isPassageOf(quote, text) &&
		extractNumberTokens(quote).some((token) => Number(token) === scenario.baselineValue);
	if (stated) return scenario;
	notes.push(
		`Scenario ${index + 1}: no cited passage states the baseline, so no growth rate is derived.`,
	);
	return unsourced;
}

/** Component types whose content is entirely stored data, with no free text of the model's own. */
const MODEL_CREATABLE_TYPES: ReadonlySet<string> = new Set([
	"data-table",
	"financial-table",
	"line-chart",
	"bar-chart",
	"candlestick-chart",
	"source-list",
]);

/**
 * Renames each component the model creates into this run's id namespace
 * (`${runId}_model<n>`), after `isModelAuthorable` has judged the model's own
 * id. The Chat thread shows a component after the answer of the run whose
 * `${runId}_` prefix it carries (ADR-0020); a model-chosen id carries none, so
 * its chart would show nowhere. Later instructions in the same reply that name
 * a created component follow the rename. Deterministic ids never use the
 * `model` suffix, so the two cannot collide.
 */
function namespaceModelComponents(
	operations: readonly UiOperation[],
	runId: string,
): UiOperation[] {
	const renamed = new Map<string, string>();
	for (const operation of operations) {
		if (operation.operation === "component.create" && !renamed.has(operation.componentId)) {
			renamed.set(operation.componentId, `${runId}_model${renamed.size + 1}`);
		}
	}
	const rename = (componentId: string) => renamed.get(componentId) ?? componentId;
	return operations.map((operation) => {
		switch (operation.operation) {
			case "component.create":
			case "component.remove":
			case "component.focus":
			case "component.select":
				return { ...operation, componentId: rename(operation.componentId) };
			default:
				return operation;
		}
	});
}

/**
 * What a model may do to the canvas. It may add views over stored datasets and
 * sources, and remove, focus or select components of earlier runs. It may not
 * author free-text components (reports, news cards, company profiles), may not
 * rewrite any component's props, and may not touch what this run's own
 * deterministic presentation creates — so it can neither restate findings in
 * its own words nor remove them.
 */
function isModelAuthorable(operation: UiOperation, runId: string): boolean {
	const ownedByThisRun = (componentId: string) => componentId.startsWith(`${runId}_`);
	switch (operation.operation) {
		case "component.create":
			return (
				MODEL_CREATABLE_TYPES.has(operation.componentType) && !ownedByThisRun(operation.componentId)
			);
		case "component.remove":
		case "component.focus":
		case "component.select":
			return !ownedByThisRun(operation.componentId);
		default:
			return false;
	}
}
