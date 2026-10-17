import {
	type CostSummary,
	JOB_STATES,
	LEASED_JOB_STATES,
	type ResearchBudget,
	type ResourceUsage,
} from "@research/domain";
import { z } from "zod";
import { agentDescriptorSchema, agentIdSchema } from "./agent.ts";
import {
	GOOGLE_SYNC_MAX_EVENTS,
	googleAuthUrlEventSchema,
	googleCalendarActionSchema,
	googleCalendarConnectedSchema,
	googleCalendarDisconnectedSchema,
	googleCalendarIdSchema,
	googleCalendarSyncedSchema,
	googleEventBodySchema,
} from "./googleCalendar.ts";
import {
	MARKET_LIMITS,
	marketObservationSchema,
	marketSeriesIdSchema,
	marketSeriesMetaSchema,
	marketUnavailableCodeSchema,
} from "./market.ts";
import { NOTEBOOK_LIMITS, notebookSchema } from "./notebook.ts";
import {
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	jsonObjectSchema,
	marketSchema,
} from "./primitives.ts";
import {
	articleSchema,
	claimSchema,
	datasetSchema,
	demandScenarioSchema,
	evidenceSchema,
	financialObservationSchema,
	investorFilingSchema,
	licensePolicySchema,
	positionObservationSchema,
	pricingPowerRecordSchema,
	securitySchema,
	supplierLinkSchema,
} from "./records.ts";
import { uiOperationSchema } from "./ui.ts";
import {
	EARNINGS_COMPANY_NAME_MAX,
	EARNINGS_LIMITS,
	earningsEventSchema,
	earningsUnavailableCodeSchema,
	watchlistStockIdSchema,
} from "./watchlist.ts";

// The legal transition matrix is shared by Worker, runner and SPA through this package.
export {
	isJobState,
	isLeasedJobState,
	isTerminalJobState,
	JOB_STATES,
	JOB_TRANSITIONS,
	type JobState,
	LEASED_JOB_STATES,
	TERMINAL_JOB_STATES,
	transitionJob,
} from "@research/domain";

export const jobStateSchema = z.enum(JOB_STATES);
export const leasedJobStateSchema = z.enum(LEASED_JOB_STATES);
export const jobKindSchema = z.enum([
	"research",
	"news-ingest",
	"market-refresh",
	"earnings-refresh",
	"google-calendar",
	"notebook-assist",
]);
export type JobKind = z.infer<typeof jobKindSchema>;

/* ---------- Budget, usage, cost ---------- */

export const BUDGET_LIMITS = {
	maxAgentSteps: { min: 1, max: 12, default: 6 },
	maxToolCalls: { min: 0, max: 60, default: 20 },
	maxWallClockMs: { min: 30_000, max: 1_800_000, default: 600_000 },
	maxInputBytes: { min: 10_000, max: 2_000_000, default: 400_000 },
	maxSpendUsd: { min: 0, max: 50 },
} as const;

/**
 * The fixed ceilings every question runs under (owner decision 2026-10-17,
 * ADR-0029): the per-question limits are no longer edited, and each one is
 * at its maximum. Only the spend ceiling stays the owner's — it is their
 * consent to metered cost (AGT-012).
 */
export const RUN_LIMITS = {
	maxAgentSteps: BUDGET_LIMITS.maxAgentSteps.max,
	maxToolCalls: BUDGET_LIMITS.maxToolCalls.max,
	maxWallClockMs: BUDGET_LIMITS.maxWallClockMs.max,
	maxInputBytes: BUDGET_LIMITS.maxInputBytes.max,
} as const;

/** A question's budget: the fixed limits plus the owner's spend ceiling (null = none). */
export function runBudget(maxSpendUsd: number | null): ResearchBudget {
	return { ...RUN_LIMITS, maxSpendUsd };
}

export const researchBudgetSchema = z.strictObject({
	maxAgentSteps: z
		.number()
		.int()
		.min(BUDGET_LIMITS.maxAgentSteps.min)
		.max(BUDGET_LIMITS.maxAgentSteps.max),
	maxToolCalls: z
		.number()
		.int()
		.min(BUDGET_LIMITS.maxToolCalls.min)
		.max(BUDGET_LIMITS.maxToolCalls.max),
	maxWallClockMs: z
		.number()
		.int()
		.min(BUDGET_LIMITS.maxWallClockMs.min)
		.max(BUDGET_LIMITS.maxWallClockMs.max),
	maxInputBytes: z
		.number()
		.int()
		.min(BUDGET_LIMITS.maxInputBytes.min)
		.max(BUDGET_LIMITS.maxInputBytes.max),
	/** null = no metered spend authorized. A metered backend then cannot be used. */
	maxSpendUsd: z
		.number()
		.min(BUDGET_LIMITS.maxSpendUsd.min)
		.max(BUDGET_LIMITS.maxSpendUsd.max)
		.nullable(),
}) satisfies z.ZodType<ResearchBudget>;

export const resourceUsageSchema = z.strictObject({
	agentSteps: z.number().int().nonnegative(),
	toolCalls: z.number().int().nonnegative(),
	inputBytes: z.number().int().nonnegative(),
	knownCostUsd: z.number().nonnegative(),
	hasUnmeteredUsage: z.boolean(),
}) satisfies z.ZodType<ResourceUsage>;

export const costSummarySchema = z
	.strictObject({
		status: z.enum(["none", "metered", "unknown-plan-limited"]),
		totalCostUsd: z.number().nonnegative().nullable(),
		meteredPortionUsd: z.number().nonnegative(),
	})
	// An unknown cost has no total at all; it can never be presented as $0 (AGT-008).
	.refine((cost) => (cost.status === "unknown-plan-limited") === (cost.totalCostUsd === null), {
		message: "totalCostUsd must be null exactly when the cost is unknown",
		path: ["totalCostUsd"],
	}) satisfies z.ZodType<CostSummary>;

/* ---------- Research request / run view ---------- */

export const effortSchema = z.enum(["low", "medium", "high"]);

/**
 * Whether a research run may open public web pages through the web.fetch_page
 * tool. Defined here (not in settings.ts) so both the stored owner setting
 * and the per-run request can share it without an import cycle (ARCH-004).
 */
export const webAccessSchema = z.enum(["off", "public-web"]);
export type WebAccess = z.infer<typeof webAccessSchema>;

export const researchRequestSchema = z.strictObject({
	workspaceId: idSchema,
	question: z.string().trim().min(3).max(2000),
	agentId: agentIdSchema,
	model: z.string().min(1).max(100).nullable(),
	effort: effortSchema,
	horizonYears: z.union([z.literal(3), z.literal(4), z.literal(5)]),
	markets: z.array(marketSchema).min(1).max(2),
	budget: researchBudgetSchema,
	// Fail closed (ARCH-017): a stored request from before this field existed
	// parses as "off", so web access is never granted by an old record.
	webAccess: webAccessSchema.default("off"),
});
export type ResearchRequest = z.infer<typeof researchRequestSchema>;

export const verificationStatusSchema = z.enum(["verified", "partially-verified", "unverified"]);

export const runProgressEntrySchema = z.strictObject({
	at: isoDateTimeSchema,
	kind: z.enum(["state", "note", "tool"]),
	text: z.string().max(600),
});

/** What produced a published result; stored with the run for reproducibility (AGT-010). */
export const bundleProvenanceSchema = z.strictObject({
	agentId: agentIdSchema,
	providerModel: z.string().max(100).nullable(),
	promptVersion: z.string().min(1).max(40),
	toolVersions: z.record(z.string().max(80), z.string().max(20)),
	dataCutoffAt: isoDateTimeSchema,
});

/**
 * One schema for a stable failure code (finding 10, task 23b): uppercase
 * letters, digits and underscores, starting with a letter, 2..60 chars. WHY
 * a shared schema: the value is stored and shown in the UI as a "code", so
 * page-derived text from a tool must never reach it. A tool error code that
 * does not match is replaced by `TOOL_ERROR` in the pipeline, and stored
 * rows that do not match decode to null (never throw: old rows must keep
 * decoding). `failureCode` itself is NOT narrowed to this shape: audit
 * (2026-10-12) found live values that violate it — `AGENT_THREW_<Name>`
 * (e.g. `AGENT_THREW_TypeError`, pipeline turn throw) and
 * `RUNNER_ERROR_<Name>` (e.g. `RUNNER_ERROR_TypeError`, runner crash path)
 * carry the error class name in mixed case, and `SUBMISSION_REJECTED_<code>`
 * prefixes a stable API code. Narrowing `failureCode` would stop those
 * stored rows decoding, so it stays `max(80)` free text and only
 * `failureDetail` is narrowed.
 */
export const STABLE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,59}$/;
export const stableFailureCodeSchema = z.string().regex(STABLE_FAILURE_CODE_PATTERN);
export const TOOL_ERROR_FALLBACK_CODE = "TOOL_ERROR";

/**
 * The failure codes a `failureDetail` may accompany: the most frequent tool
 * error with `ALL_TOOL_CALLS_FAILED` (finding 10), why nothing was collected
 * with `NO_EVIDENCE_COLLECTED` (ADR-0025). One list for the run view, the
 * completion and the stored row, so they cannot disagree.
 */
export function failureCodeTakesDetail(failureCode: string | null): boolean {
	return failureCode === "ALL_TOOL_CALLS_FAILED" || failureCode === "NO_EVIDENCE_COLLECTED";
}

/** A tool error code that does not match the stable shape becomes `TOOL_ERROR`. */
export function sanitizeToolErrorCode(code: string): string {
	return STABLE_FAILURE_CODE_PATTERN.test(code) ? code : TOOL_ERROR_FALLBACK_CODE;
}

export const researchRunSchema = z
	.strictObject({
		runId: idSchema,
		kind: jobKindSchema,
		workspaceId: idSchema.nullable(),
		state: jobStateSchema,
		/** null for news-ingest, market-refresh and earnings-refresh jobs. */
		request: researchRequestSchema.nullable(),
		usage: resourceUsageSchema,
		cost: costSummarySchema,
		attempt: z.number().int().nonnegative(),
		maxAttempts: z.number().int().positive(),
		leaseExpiresAt: isoDateTimeSchema.nullable(),
		cancelRequested: z.boolean(),
		failureCode: z.string().max(80).nullable(),
		/**
		 * Short stable code carried alongside `failureCode` when every executed
		 * tool call failed (e.g. TIMEOUT with `ALL_TOOL_CALLS_FAILED`), or why
		 * nothing was collected with `NO_EVIDENCE_COLLECTED` (`NO_TOOL_REQUESTED`,
		 * `PLAN_NOT_JSON`, `TOOLS_RETURNED_NOTHING`, ADR-0025). Null
		 * otherwise; never free text from a tool. Tied to `failureCode` below:
		 * non-null only with `ALL_TOOL_CALLS_FAILED` or `NO_EVIDENCE_COLLECTED` (ARCH-005).
		 */
		failureDetail: stableFailureCodeSchema.nullable(),
		approvalRequest: z
			.strictObject({ reasonCode: z.string().max(80), detail: z.string().max(400) })
			.nullable(),
		retryOfRunId: idSchema.nullable(),
		verificationStatus: verificationStatusSchema.nullable(),
		providerModel: z.string().max(100).nullable(),
		provenance: bundleProvenanceSchema.nullable(),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
		progress: z.array(runProgressEntrySchema).max(200),
	})
	.refine((run) => run.failureDetail === null || failureCodeTakesDetail(run.failureCode), {
		message:
			"failureDetail may be non-null only when failureCode is ALL_TOOL_CALLS_FAILED or NO_EVIDENCE_COLLECTED",
		path: ["failureDetail"],
	});
export type ResearchRun = z.infer<typeof researchRunSchema>;

/* ---------- Research bundle (runner -> Worker on completion) ---------- */

export const BUNDLE_LIMITS = {
	evidence: 80,
	claims: 80,
	scenarios: 12,
	securities: 40,
	supplierLinks: 60,
	financialObservations: 200,
	positionObservations: 80,
	investorFilings: 12,
	pricingPower: 40,
	datasets: 8,
	/** Total table cells across all datasets of one bundle. */
	datasetCells: 3_000,
	uiOperations: 30,
	articles: 400,
} as const;

const cellCountProbeSchema = z.array(
	z.looseObject({ rows: z.array(z.record(z.string(), z.unknown())) }),
);

function countCells(datasets: readonly unknown[]): number {
	const probed = cellCountProbeSchema.safeParse(datasets);
	// A shape the probe cannot read is left for the real schema to reject.
	if (!probed.success) return 0;
	return probed.data.reduce(
		(total, dataset) =>
			total + dataset.rows.reduce((cells, row) => cells + Object.keys(row).length, 0),
		0,
	);
}

/**
 * Datasets with a cheap size gate in front of the full validation. Cell
 * validation is the dominant cost of checking a submission, and the Worker has
 * a small CPU budget per request, so an oversized one is refused before that
 * cost is paid rather than after.
 */
export function boundedDatasets(maxDatasets: number, maxCells: number) {
	return z
		.array(z.unknown())
		.max(maxDatasets)
		.refine((datasets) => countCells(datasets) <= maxCells, {
			message: `at most ${maxCells} table cells are allowed`,
		})
		.pipe(z.array(datasetSchema));
}

const boundedDatasetsSchema = boundedDatasets(BUNDLE_LIMITS.datasets, BUNDLE_LIMITS.datasetCells);

export const researchBundleSchema = z.strictObject({
	evidence: z.array(evidenceSchema).max(BUNDLE_LIMITS.evidence),
	claims: z.array(claimSchema).max(BUNDLE_LIMITS.claims),
	scenarios: z.array(demandScenarioSchema).max(BUNDLE_LIMITS.scenarios),
	securities: z.array(securitySchema).max(BUNDLE_LIMITS.securities),
	supplierLinks: z.array(supplierLinkSchema).max(BUNDLE_LIMITS.supplierLinks),
	financialObservations: z
		.array(financialObservationSchema)
		.max(BUNDLE_LIMITS.financialObservations),
	positionObservations: z.array(positionObservationSchema).max(BUNDLE_LIMITS.positionObservations),
	investorFilings: z.array(investorFilingSchema).max(BUNDLE_LIMITS.investorFilings),
	pricingPower: z.array(pricingPowerRecordSchema).max(BUNDLE_LIMITS.pricingPower),
	datasets: boundedDatasetsSchema,
	/** Applied in order to the run's workspace; the server stamps ids and versions. */
	uiOperations: z.array(uiOperationSchema).max(BUNDLE_LIMITS.uiOperations),
	/** Plain-text answer posted to the conversation. Never rendered as HTML. */
	answerText: z.string().min(1).max(6000),
	answerClaimIds: z.array(idSchema).max(BUNDLE_LIMITS.claims),
	verificationStatus: verificationStatusSchema,
	provenance: bundleProvenanceSchema,
});
export type ResearchBundle = z.infer<typeof researchBundleSchema>;

/** A feed item the runner retrieved, before the Worker assigns ids and deduplicates. */
export const ingestedArticleSchema = articleSchema.omit({ articleId: true });
export type IngestedArticle = z.infer<typeof ingestedArticleSchema>;

export const sourceFetchReportSchema = z.strictObject({
	sourceId: idSchema,
	fetchedAt: isoDateTimeSchema,
	/** null on success; otherwise a stable fetch/parse error code. */
	errorCode: z.string().max(100).nullable(),
});

/* ---------- Runner protocol ---------- */

export const subscribedSourceRefSchema = z.strictObject({
	sourceId: idSchema,
	canonicalUrl: z.string(),
	publisher: z.string(),
	title: z.string(),
	licensePolicy: licensePolicySchema,
});
export type SubscribedSourceRef = z.infer<typeof subscribedSourceRefSchema>;

/**
 * The stored request for a `notebook-assist` job (ADR-0020): the owner's
 * instruction, the explicit selection, the notebook version the owner saw,
 * and the agent choices saved in Settings → AI agent at that moment. Stored
 * in `request_json` like every other job input; the claim carries the live
 * notebook instead of a copy.
 */
export const notebookAssistJobRequestSchema = z.strictObject({
	instruction: z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxInstructionChars),
	selectedWidgetIds: z.array(idSchema).max(NOTEBOOK_LIMITS.maxSelectedWidgets),
	notebookVersion: z.number().int().nonnegative(),
	agent: z.strictObject({
		agentId: agentIdSchema,
		model: z.string().min(1).max(100).nullable(),
		effort: effortSchema,
	}),
});
export type NotebookAssistJobRequest = z.infer<typeof notebookAssistJobRequestSchema>;

export const claimJobRequestSchema = z.strictObject({
	runnerVersion: z.string().min(1).max(40),
	/** Every backend the runner knows, including unavailable ones, so the UI can say why. */
	agents: z.array(agentDescriptorSchema).max(16),
});
export type ClaimJobRequest = z.infer<typeof claimJobRequestSchema>;

export const workspaceComponentSummarySchema = z.strictObject({
	componentId: z.string(),
	componentType: z.string(),
	title: z.string().nullable(),
});
export type WorkspaceComponentSummary = z.infer<typeof workspaceComponentSummarySchema>;

const leaseShape = {
	runId: idSchema,
	leaseGeneration: z.number().int().positive(),
	leaseExpiresAt: isoDateTimeSchema,
	attempt: z.number().int().positive(),
	heartbeatIntervalMs: z.number().int().positive(),
	sources: z.array(subscribedSourceRefSchema).max(200),
};

/** Ceilings for the slice of earlier conversation a research job carries (data-volume budget). */
export const CONVERSATION_CONTEXT_LIMITS = {
	maxMessages: 6,
	maxMessageChars: 600,
	maxTotalBytes: 2_400,
} as const;

export const conversationContextMessageSchema = z.strictObject({
	role: z.enum(["owner", "assistant"]),
	text: z.string().min(1).max(CONVERSATION_CONTEXT_LIMITS.maxMessageChars),
});
export type ConversationContextMessage = z.infer<typeof conversationContextMessageSchema>;

const utf8Encoder = new TextEncoder();

/**
 * Bounded slice of earlier conversation, oldest first (data-volume budget):
 * at most `maxMessages` messages of at most `maxMessageChars` characters whose
 * UTF-8 bytes sum to at most `maxTotalBytes`. The byte refinement matters:
 * six messages of 600 multi-byte characters pass the count/character limits at
 * far more than 2,400 bytes.
 */
export const conversationContextSchema = z
	.array(conversationContextMessageSchema)
	.max(CONVERSATION_CONTEXT_LIMITS.maxMessages)
	.refine(
		(messages) =>
			messages.reduce((total, message) => total + utf8Encoder.encode(message.text).byteLength, 0) <=
			CONVERSATION_CONTEXT_LIMITS.maxTotalBytes,
		{
			message: `conversation context must fit ${CONVERSATION_CONTEXT_LIMITS.maxTotalBytes} UTF-8 bytes`,
		},
	);

export const claimedJobSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("research"),
		...leaseShape,
		request: researchRequestSchema,
		/**
		 * Consumption of earlier attempts of this run. Budgets are per run, not per
		 * attempt, so a retry continues from here instead of starting at zero.
		 */
		priorUsage: resourceUsageSchema,
		/** What is already on the canvas, so the agent can update or remove it by id. */
		workspaceComponents: z.array(workspaceComponentSummarySchema).max(60),
		/** Bounded slice of earlier conversation, oldest first (data-volume budget). */
		conversationContext: conversationContextSchema,
	}),
	z.strictObject({ kind: z.literal("news-ingest"), ...leaseShape }),
	/**
	 * One notebook-assistant turn (ADR-0020): the owner's instruction, the
	 * explicit selection, the notebook as it was when the owner asked, and the
	 * agent choices saved in Settings at that moment. No tools, no network:
	 * the runner asks the model for widget commands and a short reply.
	 */
	z.strictObject({
		kind: z.literal("notebook-assist"),
		...leaseShape,
		workspaceId: idSchema,
		agent: z.strictObject({
			agentId: agentIdSchema,
			model: z.string().min(1).max(100).nullable(),
			effort: effortSchema,
		}),
		instruction: z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxInstructionChars),
		selectedWidgetIds: z.array(idSchema).max(NOTEBOOK_LIMITS.maxSelectedWidgets),
		notebook: notebookSchema,
		notebookVersion: z.number().int().nonnegative(),
		conversationContext: conversationContextSchema,
	}),
	z.strictObject({
		kind: z.literal("market-refresh"),
		...leaseShape,
		series: z
			.array(
				z.strictObject({
					seriesId: marketSeriesIdSchema,
					latestObservedOn: isoDateSchema.nullable(),
				}),
			)
			.max(MARKET_LIMITS.maxTrackedSeries),
	}),
	/**
	 * One earnings-date refresh over the owner's current watchlist (FR-018).
	 * `stocks` carries the stored company name (null when never retrieved) so
	 * the runner only asks the provider for names it still needs; the window
	 * is UTC dates from the server clock. Publisher and source URL are NOT
	 * carried: the API derives them from the source id (fixed strings).
	 */
	z.strictObject({
		kind: z.literal("earnings-refresh"),
		...leaseShape,
		fromDate: isoDateSchema,
		toDate: isoDateSchema,
		stocks: z
			.array(
				z.strictObject({
					stockId: watchlistStockIdSchema,
					name: z.string().trim().min(1).max(EARNINGS_COMPANY_NAME_MAX).nullable(),
				}),
			)
			.max(EARNINGS_LIMITS.maxStocks),
	}),
	/**
	 * One Google Calendar sync step (FR-019): the claim carries what the
	 * runner needs at CLAIM time as flat fields (additive; the runner
	 * fail-closes on this kind until phase G1). A single variant keeps the
	 * outer `kind` discriminator unique — one member per `kind` — while the
	 * refinement below enforces the per-action payload: connect and
	 * disconnect carry only the action; sync carries the calendar id (null
	 * when never connected), the digest of the desired set and the desired
	 * bodies (at most every stored event of every watched stock).
	 */
	z
		.strictObject({
			kind: z.literal("google-calendar"),
			...leaseShape,
			action: googleCalendarActionSchema,
			calendarId: googleCalendarIdSchema.nullable().optional(),
			desiredDigest: z
				.string()
				.regex(/^[0-9a-f]{64}$/, "desired digest must be sha256 hex")
				.optional(),
			events: z.array(googleEventBodySchema).max(GOOGLE_SYNC_MAX_EVENTS).optional(),
		})
		.superRefine((job, ctx) => {
			if (job.action === "sync") {
				if (job.calendarId === undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["calendarId"],
						message: "sync requires calendarId",
					});
				}
				if (job.desiredDigest === undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["desiredDigest"],
						message: "sync requires desiredDigest",
					});
				}
				if (job.events === undefined) {
					ctx.addIssue({ code: "custom", path: ["events"], message: "sync requires events" });
				}
				return;
			}
			for (const field of ["calendarId", "desiredDigest", "events"] as const) {
				if (job[field] !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: [field],
						message: `${job.action} carries no ${field}`,
					});
				}
			}
		}),
]);
export type ClaimedJob = z.infer<typeof claimedJobSchema>;

export const claimJobResponseSchema = z.strictObject({
	job: claimedJobSchema.nullable(),
	/** Server hint for the next poll, so an idle runner backs off (cost control). */
	pollAfterMs: z.number().int().positive(),
});
export type ClaimJobResponse = z.infer<typeof claimJobResponseSchema>;

export const heartbeatRequestSchema = z.strictObject({
	leaseGeneration: z.number().int().positive(),
});
export const heartbeatResponseSchema = z.strictObject({
	leaseExpiresAt: isoDateTimeSchema,
	cancelRequested: z.boolean(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const runnerEventSchema = z.strictObject({
	/** Monotonic per lease generation; (runId, generation, seq) is the idempotency key. */
	seq: z.number().int().nonnegative(),
	at: isoDateTimeSchema,
	event: z.discriminatedUnion("type", [
		z.strictObject({ type: z.literal("state"), state: leasedJobStateSchema }),
		z.strictObject({ type: z.literal("note"), text: z.string().min(1).max(500) }),
		z.strictObject({
			type: z.literal("tool"),
			toolId: z.string().max(80),
			outcome: z.enum(["executed", "denied", "failed"]),
			detail: z.string().max(300),
		}),
		z.strictObject({ type: z.literal("usage"), usage: resourceUsageSchema }),
		z.strictObject({ type: z.literal("provider-session"), sessionRef: z.string().max(200) }),
		googleAuthUrlEventSchema,
	]),
});
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

export const MAX_RUNNER_EVENTS_PER_REQUEST = 50;

export const runnerEventsRequestSchema = z.strictObject({
	leaseGeneration: z.number().int().positive(),
	events: z.array(runnerEventSchema).min(1).max(MAX_RUNNER_EVENTS_PER_REQUEST),
});
export type RunnerEventsRequest = z.infer<typeof runnerEventsRequestSchema>;

const completionBase = {
	leaseGeneration: z.number().int().positive(),
	usage: resourceUsageSchema,
};

const failedCompletionSchema = z
	.strictObject({
		outcome: z.literal("failed"),
		...completionBase,
		failureCode: z.string().min(1).max(80),
		/**
		 * Most frequent tool error code when `failureCode` is
		 * `ALL_TOOL_CALLS_FAILED` (finding 10), or why nothing was collected
		 * when it is `NO_EVIDENCE_COLLECTED` (ADR-0025): a stable code, never
		 * free text; tied to `failureCode` so a stale detail cannot accompany
		 * another code.
		 */
		failureDetail: stableFailureCodeSchema.nullish(),
		retryable: z.boolean(),
	})
	.refine(
		(completion) =>
			completion.failureDetail === null ||
			completion.failureDetail === undefined ||
			failureCodeTakesDetail(completion.failureCode),
		{
			message:
				"failureDetail may be non-null only when failureCode is ALL_TOOL_CALLS_FAILED or NO_EVIDENCE_COLLECTED",
			path: ["failureDetail"],
		},
	);

export const completeJobRequestSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		outcome: z.literal("completed"),
		...completionBase,
		bundle: researchBundleSchema,
		articles: z.array(ingestedArticleSchema).max(BUNDLE_LIMITS.articles),
		sourceReports: z.array(sourceFetchReportSchema).max(200),
	}),
	/** Verified portions are kept; `failureCode` says what stopped the run. */
	z.strictObject({
		outcome: z.literal("partial"),
		...completionBase,
		failureCode: z.string().min(1).max(80),
		bundle: researchBundleSchema,
		articles: z.array(ingestedArticleSchema).max(BUNDLE_LIMITS.articles),
		sourceReports: z.array(sourceFetchReportSchema).max(200),
	}),
	z.strictObject({
		outcome: z.literal("ingested"),
		...completionBase,
		articles: z.array(ingestedArticleSchema).max(BUNDLE_LIMITS.articles),
		sourceReports: z.array(sourceFetchReportSchema).max(200),
	}),
	z
		.strictObject({
			outcome: z.literal("market-refreshed"),
			...completionBase,
			series: z
				.array(
					z.strictObject({
						seriesId: marketSeriesIdSchema,
						fetchedAt: isoDateTimeSchema,
						meta: marketSeriesMetaSchema.nullable(),
						observations: z
							.array(marketObservationSchema)
							.max(MARKET_LIMITS.maxObservationsPerResponse),
						errorCode: marketUnavailableCodeSchema.nullable(),
					}),
				)
				.max(MARKET_LIMITS.maxTrackedSeries),
		})
		.refine(
			(completion) =>
				completion.series.every(
					(entry) =>
						(entry.errorCode === null) === (entry.meta !== null) &&
						(entry.errorCode !== null ? entry.observations.length === 0 : true),
				),
			{
				message: "errorCode is null exactly when meta is present; errors carry no observations",
				path: ["series"],
			},
		),
	failedCompletionSchema,
	z.strictObject({ outcome: z.literal("cancelled"), ...completionBase }),
	/**
	 * A notebook-assistant result (ADR-0020). `commands` are widget-grid agent
	 * commands (`@research/widget-grid/agent`), already applied by the runner
	 * to its copy; the API parses and applies them again against the stored
	 * notebook at `baseVersion`, all or nothing. Removals travel separately
	 * and are never applied: the owner confirms them.
	 */
	z.strictObject({
		outcome: z.literal("notebook-assisted"),
		...completionBase,
		baseVersion: z.number().int().nonnegative(),
		reply: z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxReplyChars),
		commands: z.array(jsonObjectSchema).max(NOTEBOOK_LIMITS.maxCommandsPerTurn),
		proposedRemovals: z.array(idSchema).max(NOTEBOOK_LIMITS.maxCommandsPerTurn),
	}),
	z.strictObject({
		outcome: z.literal("waiting_approval"),
		...completionBase,
		approvalRequest: z.strictObject({
			reasonCode: z.string().min(1).max(80),
			detail: z.string().max(400),
		}),
	}),
	/**
	 * One earnings-date refresh result (FR-018): one entry per claimed stock.
	 * An error carries no events; the API keeps the stored events for every
	 * error EXCEPT `NO_SCHEDULED_DATE` — a successful retrieval with nothing
	 * listed, which clears the stored events while recording the code (and
	 * may carry the company `name`). A dated success carries its events and
	 * clears the code.
	 */
	z
		.strictObject({
			outcome: z.literal("earnings-refreshed"),
			...completionBase,
			stocks: z
				.array(
					z.strictObject({
						stockId: watchlistStockIdSchema,
						fetchedAt: isoDateTimeSchema,
						name: z.string().trim().min(1).max(EARNINGS_COMPANY_NAME_MAX).nullable(),
						events: z.array(earningsEventSchema).max(EARNINGS_LIMITS.maxEventsPerStock),
						errorCode: earningsUnavailableCodeSchema.nullable(),
					}),
				)
				.max(EARNINGS_LIMITS.maxStocks),
		})
		.refine(
			(completion) =>
				completion.stocks.every((entry) => entry.errorCode === null || entry.events.length === 0),
			{
				message: "errors carry no events",
				path: ["stocks"],
			},
		)
		// A duplicate success+failure pair for one stock would delete the
		// events of a "failed" stock; duplicates are rejected instead.
		.refine(
			(completion) =>
				new Set(completion.stocks.map((entry) => entry.stockId)).size === completion.stocks.length,
			{
				message: "stock ids must be distinct",
				path: ["stocks"],
			},
		)
		.refine(
			(completion) =>
				completion.stocks.every(
					(entry) =>
						new Set(entry.events.map((event) => event.periodKey)).size === entry.events.length,
				),
			{
				message: "period keys must be distinct within a stock",
				path: ["stocks"],
			},
		),
	/**
	 * Google Calendar outcomes (FR-019, additive): a connect completion
	 * carries the calendar id; a sync completion carries the calendar id, the
	 * desired digest it applied and the counts; a disconnect completion says
	 * whether the refresh token was revoked. Failures use the existing
	 * `failed` outcome with one of the stable `GOOGLE_*` codes.
	 */
	googleCalendarConnectedSchema,
	googleCalendarSyncedSchema,
	googleCalendarDisconnectedSchema,
]);
export type CompleteJobRequest = z.infer<typeof completeJobRequestSchema>;

export const completeJobResponseSchema = z.strictObject({
	state: jobStateSchema,
	/** True when this exact completion had already been recorded (idempotent replay). */
	replayed: z.boolean(),
	newArticleCount: z.number().int().nonnegative(),
});
export type CompleteJobResponse = z.infer<typeof completeJobResponseSchema>;
