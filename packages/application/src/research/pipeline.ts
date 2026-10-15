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
	type UiOperation,
	verifyClaims,
} from "@research/domain";
import type { Clock } from "../ports.ts";
import {
	analysisDraftSchema,
	type DraftScenario,
	draftPricingPowerSchema,
	draftScenarioSchema,
	draftSupplierSchema,
	planSchema,
	verdictsSchema,
} from "./draft.ts";
import { buildPresentation, DISCLAIMER, datasetGuide } from "./presentation.ts";
import {
	analysisPrompt,
	cutUtf8Bytes,
	PLANNING_CONTEXT_MAX_BYTES,
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
			readonly bundle: ResearchBundle;
			readonly articles: readonly IngestedArticle[];
			readonly usage: ResourceUsage;
	  }
	| {
			readonly kind: "failed";
			readonly failureCode: string;
			/** Most frequent tool error code when `failureCode` is `ALL_TOOL_CALLS_FAILED`. */
			readonly failureDetail: string | null;
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
	| { readonly kind: "provider"; readonly code: string; readonly retryable: boolean };

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

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** One line per evidence item; a result with no evidence is one line naming its record count. */
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
	const sizes = older.map((line) => byteLength(line));
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
	): PipelineOutcome => ({
		kind: "failed",
		failureCode,
		failureDetail,
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

	/* ----- Pre-flight: capability and consent negotiation, before any quota is spent ----- */
	const probe = await deps.agent.probe();
	if (probe.availability.status !== "available") {
		return failed(`AGENT_UNAVAILABLE_${probe.availability.reasonCode}`, false);
	}
	if (deps.agent.toolIsolation !== "enforced" && !input.allowUnverifiedToolIsolation) {
		return failed("TOOL_ISOLATION_UNVERIFIED", false);
	}
	if (deps.agent.costModel === "metered" && (budget.maxSpendUsd ?? 0) <= 0) {
		return failed("SPEND_NOT_AUTHORIZED", false);
	}

	/** One model turn under the run's budget. Never throws for provider failures. */
	async function turn(prompt: string): Promise<Result<Turn, TurnFailure>> {
		if (input.signal.aborted) return err({ kind: "aborted" });
		const inputBytes = byteLength(prompt);
		// On a metered backend an unreported cost means the running total is unknown: stop
		// and ask, rather than keep spending against a ceiling that can no longer be checked.
		if (metered && usage.hasUnmeteredUsage) return err({ kind: "unknown-spend" });
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
					failure = { kind: "provider", code: "AGENT_EVENT_INVALID", retryable: false };
					break;
				}
				const event = parsed.value;
				if (event.type === "text.delta") {
					text += event.text;
					if (text.length > MAX_MODEL_OUTPUT_CHARS) {
						failure = { kind: "provider", code: "AGENT_OUTPUT_TOO_LARGE", retryable: false };
						break;
					}
				} else if (event.type === "tool.request") {
					toolRequests.push({ toolId: event.toolId, args: event.args });
				} else if (event.type === "ui.command") {
					uiProposals.push(event.command);
				} else if (event.type === "usage") {
					reportedCost = event.knownCostUsd;
				} else if (event.type === "failed") {
					failure = { kind: "provider", code: event.code, retryable: event.retryable };
					break;
				} else if (event.type === "completed") {
					finished = true;
					break;
				}
			}
		} catch (error) {
			// Adapters are contractually non-throwing; treat a throw as a provider failure, not a crash.
			const name = error instanceof Error ? error.name : "unknown";
			failure = { kind: "provider", code: `AGENT_THREW_${name}`.slice(0, 60), retryable: true };
		}
		usage = addUsage(usage, { costUsd: reportedCost ?? null });
		if (typeof reportedCost === "number" && Number.isFinite(reportedCost)) {
			largestTurnCostUsd = Math.max(largestTurnCostUsd, reportedCost);
		}
		await deps.reporter.usage(usage);
		if (input.signal.aborted) return err({ kind: "aborted" });
		if (failure !== null) return err(failure);
		if (!finished) {
			return err({ kind: "provider", code: "AGENT_STREAM_ENDED_EARLY", retryable: true });
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
	// Keep one step for analysis, and one more for independent verification when the budget allows.
	// Counted from what is left of the run's allowance, which earlier attempts may have used.
	const remainingSteps = Math.max(0, budget.maxAgentSteps - usage.agentSteps);
	const reservedSteps = remainingSteps >= 3 ? 2 : 1;
	const collectionSteps = Math.max(0, remainingSteps - reservedSteps);
	let reachedCollecting = false;
	let stoppedBy: BudgetLimit | null = null;
	// Executed tool calls (authorized and run, whether they returned evidence
	// or failed): when at least one ran and none succeeded, the run failed as
	// ALL_TOOL_CALLS_FAILED with the most frequent tool error code, not as
	// NO_EVIDENCE_COLLECTED. Denied requests never ran and are not counted.
	let executedToolCalls = 0;
	let succeededToolCalls = 0;
	const toolErrorCounts = new Map<string, number>();

	collection: for (let step = 0; step < collectionSteps; step += 1) {
		const remainingToolCalls = budget.maxToolCalls - usage.toolCalls;
		if (remainingToolCalls <= 0) break;
		const prompt = planningPrompt({
			request,
			nowIso: deps.clock.nowIso(),
			tools: permittedTools,
			sources: input.sources,
			collectedSoFar: collectedSoFarText(collected.entries, step),
			remainingToolCalls,
			conversationContext: input.conversationContext,
			fenceToken: deps.newFenceToken(),
			promptBudgetBytes: PLANNING_PROMPT_BUDGET_BYTES,
		});
		// Fail closed: the builder guarantees the ceiling, so reaching it means
		// a bug — stop collecting rather than send an over-budget prompt.
		if (byteLength(prompt) > PLANNING_PROMPT_BUDGET_BYTES) {
			await deps.reporter.note("Planning stopped early: the prompt would exceed its byte budget.");
			stoppedBy = "MAX_INPUT_BYTES";
			break;
		}
		const planned = await turn(prompt);
		if (!planned.ok) {
			if (planned.error.kind === "aborted") return { kind: "cancelled", usage };
			const pause = spendApproval(planned.error);
			if (pause !== null) return pause;
			if (planned.error.kind === "budget") {
				stoppedBy = planned.error.limit;
				break;
			}
			if (planned.error.kind === "provider" && collected.evidence.length === 0) {
				return failed(planned.error.code, planned.error.retryable);
			}
			await deps.reporter.note(`Planning stopped early: ${failureCode(planned.error)}.`);
			break;
		}
		uiProposals.push(...planned.value.uiProposals);
		const json = extractJsonObject(planned.value.text);
		const plan = json.ok ? planSchema.safeParse(json.value) : null;
		if (plan === null || !plan.success) {
			await deps.reporter.note("The planning reply was not valid JSON; no tools were run for it.");
			continue;
		}
		if (!reachedCollecting) {
			await deps.reporter.state("collecting");
			reachedCollecting = true;
		}
		const calls = [...plan.data.toolCalls, ...planned.value.toolRequests];
		for (const call of calls) {
			if (input.signal.aborted) return { kind: "cancelled", usage };
			const label = call.toolId.slice(0, 80);
			const authorized = authorizeToolCall(
				deps.tools,
				{ permittedToolIds, remainingToolCalls: budget.maxToolCalls - usage.toolCalls },
				call,
			);
			if (!authorized.ok) {
				await deps.reporter.tool(label, "denied", authorized.error);
				const note = `Tool request ${label} was denied: ${authorized.error}.`;
				collected.entries.push({ step, fullText: note, digestLines: [note] });
				if (authorized.error === "TOOL_CALL_BUDGET_EXHAUSTED") {
					stoppedBy = "MAX_TOOL_CALLS";
					break collection;
				}
				continue;
			}
			const withinBudget = checkBudget(budget, usage, elapsedMs(), { toolCalls: 1 });
			if (!withinBudget.ok) {
				stoppedBy = withinBudget.error;
				break collection;
			}
			usage = addUsage(usage, { toolCalls: 1 });
			// A tool may not outlive the run: its signal also fires at the run's wall-clock deadline.
			const runDeadline = AbortSignal.timeout(Math.max(1, budget.maxWallClockMs - elapsedMs()));
			const result = await executeToolCall(authorized.value, {
				...toolContext,
				signal: AbortSignal.any([input.signal, runDeadline]),
			});
			if (runDeadline.aborted && !input.signal.aborted) {
				executedToolCalls += 1;
				toolErrorCounts.set("MAX_WALL_CLOCK", (toolErrorCounts.get("MAX_WALL_CLOCK") ?? 0) + 1);
				await deps.reporter.tool(label, "failed", "MAX_WALL_CLOCK");
				stoppedBy = "MAX_WALL_CLOCK";
				break collection;
			}
			executedToolCalls += 1;
			if (!result.ok) {
				const code = sanitizeToolErrorCode(result.error.code.slice(0, 80));
				toolErrorCounts.set(code, (toolErrorCounts.get(code) ?? 0) + 1);
				await deps.reporter.tool(label, "failed", result.error.code.slice(0, 300));
				const note = `Tool ${label} failed: ${result.error.code}.`;
				collected.entries.push({ step, fullText: note, digestLines: [note] });
				continue;
			}
			succeededToolCalls += 1;
			const output = result.value;
			collected.evidence.push(...output.evidence);
			collected.securities.push(...output.securities);
			collected.financialObservations.push(...output.financialObservations);
			collected.positionObservations.push(...output.positionObservations);
			collected.investorFilings.push(...output.investorFilings);
			collected.articles.push(...output.articles);
			collected.entries.push({
				step,
				fullText: `Result of ${label}:\n${output.modelText}`,
				digestLines: digestLinesFor(call.toolId, output),
			});
			await deps.reporter.tool(label, "executed", `${output.evidence.length} evidence item(s)`);
		}
		await deps.reporter.usage(usage);
		if (plan.data.done || calls.length === 0) break;
	}
	if (!reachedCollecting) await deps.reporter.state("collecting");

	const articles = [
		...new Map(collected.articles.map((article) => [article.canonicalUrl, article])).values(),
	].slice(0, BUNDLE_LIMITS.articles);
	if (collected.evidence.length === 0) {
		if (executedToolCalls > 0 && succeededToolCalls === 0) {
			return failed("ALL_TOOL_CALLS_FAILED", false, mostFrequentToolError(toolErrorCounts));
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
		const entry = `[${e.evidenceId}] ${e.title} — ${e.publisher}; published ${e.publishedAt ?? "undated"}; retrieved ${e.retrievedAt}\n${item.retrievedText.slice(0, EVIDENCE_ITEM_MAX)}\n\n`;
		if (byteLength(evidencePack) + byteLength(entry) > packBudget) break;
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

	const now = deps.clock.nowIso();
	const dataCutoffAt = now;
	let repairNote: string | null = null;
	let draft: ReturnType<typeof analysisDraftSchema.safeParse> | null = null;
	let analysisFailure: string | null = null;
	for (let attempt = 0; attempt < 2 && draft?.success !== true; attempt += 1) {
		const analysed = await turn(
			analysisPrompt({
				request,
				nowIso: now,
				evidencePack,
				recordSummary,
				datasetGuide: datasetGuide(runId),
				existingComponents: input.workspaceComponents,
				conversationContext: input.conversationContext,
				fenceToken: deps.newFenceToken(),
				repairNote,
			}),
		);
		if (!analysed.ok) {
			if (analysed.error.kind === "aborted") return { kind: "cancelled", usage };
			const pause = spendApproval(analysed.error);
			if (pause !== null) return pause;
			analysisFailure = failureCode(analysed.error);
			break;
		}
		uiProposals.push(...analysed.value.uiProposals);
		const json = extractJsonObject(analysed.value.text);
		if (!json.ok) {
			repairNote = "the reply contained no parseable JSON object";
			analysisFailure = "ANALYSIS_OUTPUT_INVALID";
			continue;
		}
		draft = analysisDraftSchema.safeParse(json.value);
		if (!draft.success) {
			repairNote = `invalid fields: ${draft.error.issues
				.slice(0, 6)
				.map((issue) => issue.path.join("."))
				.join(", ")}`;
			analysisFailure = "ANALYSIS_OUTPUT_INVALID";
		} else {
			analysisFailure = null;
		}
	}
	const analysis = draft?.success === true ? draft.data : null;
	const notes: string[] = [];
	if (omittedEvidence > 0) {
		notes.push(
			duplicateEvidence > 0
				? `${omittedEvidence} retrieved item(s) were not analysed: ${duplicateEvidence} exact duplicate(s) skipped and the rest did not fit the input-size budget.`
				: `${omittedEvidence} retrieved item(s) did not fit the input-size budget and were not analysed.`,
		);
	}
	const hasToolRecords =
		collected.financialObservations.length +
			collected.positionObservations.length +
			collected.investorFilings.length >
		0;
	if (analysis === null && !hasToolRecords) {
		return failed(
			analysisFailure ?? "ANALYSIS_FAILED",
			analysisFailure !== "ANALYSIS_OUTPUT_INVALID",
		);
	}

	/* ----- Verification: deterministic checks first, then an independent model pass ----- */
	await deps.reporter.state("verifying");
	const knownEvidence = (ids: readonly string[]) => [
		...new Set(ids.filter((id) => evidenceById.has(id))),
	];
	const verified = verifyClaims(
		(analysis?.claims ?? []).map((claim) => ({
			claimId: nextId("cl"),
			text: claim.text,
			claimType: claim.claimType,
			links: claim.evidence.map((link) => ({
				evidenceId: link.evidenceId,
				relation: link.relation,
				quote: link.quote === "" ? null : link.quote,
			})),
		})),
		shown.map((item) => ({
			evidenceId: item.evidence.evidenceId,
			// Match against exactly what the model was shown, not text it never saw.
			retrievedText: `${item.evidence.title}\n${item.retrievedText.slice(0, EVIDENCE_ITEM_MAX)}`,
		})),
	);
	let claims: Claim[] = verified.map((claim) => ({
		claimId: claim.claimId,
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
		: { kind: "partial", failureCode: incomplete, bundle: bundle.data, articles, usage };
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
