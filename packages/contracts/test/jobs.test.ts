import { describe, expect, it } from "vitest";
import {
	BUDGET_LIMITS,
	BUNDLE_LIMITS,
	CONVERSATION_CONTEXT_LIMITS,
	claimedJobSchema,
	claimJobRequestSchema,
	claimJobResponseSchema,
	completeJobRequestSchema,
	completeJobResponseSchema,
	conversationContextMessageSchema,
	costSummarySchema,
	effortSchema,
	heartbeatRequestSchema,
	heartbeatResponseSchema,
	ingestedArticleSchema,
	JOB_STATES,
	JOB_TRANSITIONS,
	jobKindSchema,
	jobStateSchema,
	LEASED_JOB_STATES,
	leasedJobStateSchema,
	MAX_RUNNER_EVENTS_PER_REQUEST,
	type ResearchBundle,
	releaseJobRequestSchema,
	releaseJobResponseSchema,
	researchBudgetSchema,
	researchBundleSchema,
	researchRequestSchema,
	researchRunSchema,
	resourceUsageSchema,
	runnerEventSchema,
	runnerEventsRequestSchema,
	runProgressEntrySchema,
	sourceFetchReportSchema,
	subscribedSourceRefSchema,
	TERMINAL_JOB_STATES,
	transitionJob,
	verificationStatusSchema,
	workspaceComponentSummarySchema,
} from "../src/index.ts";
import {
	agentDescriptor,
	claimedResearchJob,
	emptyBundle,
	ingestedArticle,
	researchBudget,
	researchBundle,
	researchRequest,
	researchRun,
	resourceUsage,
	sourceReport,
	subscribedSource,
	T0,
	T1,
} from "./fixtures.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

describe("job states", () => {
	it("accepts every lifecycle state and rejects unknown ones", () => {
		for (const state of JOB_STATES) expectAccepted(jobStateSchema, state);
		for (const state of ["running", "done", "PENDING", ""]) expectRejected(jobStateSchema, state);
	});

	it("restricts runner-reported states to leased states", () => {
		for (const state of LEASED_JOB_STATES) expectAccepted(leasedJobStateSchema, state);
		for (const state of [...TERMINAL_JOB_STATES, "pending", "waiting_approval"]) {
			expectRejected(leasedJobStateSchema, state);
		}
	});

	it("re-exports the shared transition matrix", () => {
		expect(transitionJob("pending", "claimed")).toEqual({ ok: true, value: "claimed" });
		expect(JOB_TRANSITIONS.completed).toEqual([]);
	});

	it("knows the job kinds", () => {
		expectAccepted(jobKindSchema, "research");
		expectAccepted(jobKindSchema, "news-ingest");
		expectAccepted(jobKindSchema, "market-refresh");
		expectAccepted(jobKindSchema, "earnings-refresh");
		expectAccepted(jobKindSchema, "google-calendar");
		expectRejected(jobKindSchema, "shell");
	});
});

describe("researchBudgetSchema (FR-016 / AGT-008 / AGT-012)", () => {
	it("accepts a budget within the ceilings, with and without authorized spend", () => {
		expectAccepted(researchBudgetSchema, researchBudget);
		expectAccepted(researchBudgetSchema, { ...researchBudget, maxSpendUsd: 2.5 });
		expectAccepted(researchBudgetSchema, { ...researchBudget, maxSpendUsd: 0 });
	});

	it("accepts each limit's minimum and maximum", () => {
		for (const key of [
			"maxAgentSteps",
			"maxToolCalls",
			"maxWallClockMs",
			"maxInputBytes",
		] as const) {
			expectAccepted(researchBudgetSchema, { ...researchBudget, [key]: BUDGET_LIMITS[key].min });
			expectAccepted(researchBudgetSchema, { ...researchBudget, [key]: BUDGET_LIMITS[key].max });
		}
		expectAccepted(researchBudgetSchema, {
			...researchBudget,
			maxSpendUsd: BUDGET_LIMITS.maxSpendUsd.max,
		});
	});

	it("rejects values outside each limit", () => {
		for (const key of [
			"maxAgentSteps",
			"maxToolCalls",
			"maxWallClockMs",
			"maxInputBytes",
		] as const) {
			expectRejected(
				researchBudgetSchema,
				{ ...researchBudget, [key]: BUDGET_LIMITS[key].min - 1 },
				[key],
			);
			expectRejected(
				researchBudgetSchema,
				{ ...researchBudget, [key]: BUDGET_LIMITS[key].max + 1 },
				[key],
			);
			expectRejected(
				researchBudgetSchema,
				{ ...researchBudget, [key]: BUDGET_LIMITS[key].min + 0.5 },
				[key],
			);
		}
		expectRejected(researchBudgetSchema, { ...researchBudget, maxSpendUsd: -0.01 }, [
			"maxSpendUsd",
		]);
		expectRejected(researchBudgetSchema, { ...researchBudget, maxSpendUsd: 50.01 }, [
			"maxSpendUsd",
		]);
	});

	it("has defaults inside the documented ranges", () => {
		for (const key of [
			"maxAgentSteps",
			"maxToolCalls",
			"maxWallClockMs",
			"maxInputBytes",
		] as const) {
			const limit = BUDGET_LIMITS[key];
			expect(limit.default).toBeGreaterThanOrEqual(limit.min);
			expect(limit.default).toBeLessThanOrEqual(limit.max);
		}
	});

	it("requires spend consent to be explicit: null, never omitted or unbounded", () => {
		expectRejected(researchBudgetSchema, without(researchBudget, "maxSpendUsd"), ["maxSpendUsd"]);
		expectRejected(
			researchBudgetSchema,
			{ ...researchBudget, maxSpendUsd: Number.POSITIVE_INFINITY },
			["maxSpendUsd"],
		);
		expectRejected(researchBudgetSchema, { ...researchBudget, maxSpendUsd: "unlimited" }, [
			"maxSpendUsd",
		]);
	});

	it("rejects every missing ceiling and unknown keys", () => {
		for (const key of [
			"maxAgentSteps",
			"maxToolCalls",
			"maxWallClockMs",
			"maxInputBytes",
		] as const) {
			expectRejected(researchBudgetSchema, without(researchBudget, key), [key]);
		}
		expectRejected(researchBudgetSchema, { ...researchBudget, allowPaidFallback: true });
	});
});

describe("resourceUsageSchema and costSummarySchema", () => {
	it("accepts usage counters", () => {
		expectAccepted(resourceUsageSchema, resourceUsage);
	});

	it("rejects negative or fractional counters and a missing unmetered flag", () => {
		expectRejected(resourceUsageSchema, { ...resourceUsage, agentSteps: -1 }, ["agentSteps"]);
		expectRejected(resourceUsageSchema, { ...resourceUsage, toolCalls: 1.5 }, ["toolCalls"]);
		expectRejected(resourceUsageSchema, { ...resourceUsage, knownCostUsd: -1 }, ["knownCostUsd"]);
		expectRejected(resourceUsageSchema, without(resourceUsage, "hasUnmeteredUsage"), [
			"hasUnmeteredUsage",
		]);
	});

	it("accepts the three cost summaries the domain produces", () => {
		expectAccepted(costSummarySchema, { status: "none", totalCostUsd: 0, meteredPortionUsd: 0 });
		expectAccepted(costSummarySchema, {
			status: "metered",
			totalCostUsd: 0.42,
			meteredPortionUsd: 0.42,
		});
		expectAccepted(costSummarySchema, {
			status: "unknown-plan-limited",
			totalCostUsd: null,
			meteredPortionUsd: 0.3,
		});
	});

	it("rejects an unknown status, a missing total and a negative amount", () => {
		expectRejected(costSummarySchema, { status: "free", totalCostUsd: 0, meteredPortionUsd: 0 }, [
			"status",
		]);
		expectRejected(costSummarySchema, { status: "metered", meteredPortionUsd: 0 }, [
			"totalCostUsd",
		]);
		expectRejected(
			costSummarySchema,
			{ status: "metered", totalCostUsd: -1, meteredPortionUsd: 0 },
			["totalCostUsd"],
		);
	});
});

describe("researchRequestSchema (FR-004 / FR-012)", () => {
	it("accepts a research request", () => {
		expectAccepted(researchRequestSchema, researchRequest);
		expectAccepted(researchRequestSchema, {
			...researchRequest,
			markets: ["JP"],
			model: "some-model",
		});
	});

	it.each([3, 4, 5])("accepts a %i-year horizon", (horizonYears) => {
		expectAccepted(researchRequestSchema, { ...researchRequest, horizonYears });
	});

	it.each([0, 1, 2, 6, 10, 3.5, "5", null])("rejects the horizon %j", (horizonYears) => {
		expectRejected(researchRequestSchema, { ...researchRequest, horizonYears }, ["horizonYears"]);
	});

	it("requires at least one supported market", () => {
		expectRejected(researchRequestSchema, { ...researchRequest, markets: [] }, ["markets"]);
		expectRejected(researchRequestSchema, { ...researchRequest, markets: ["JP", "US", "JP"] }, [
			"markets",
		]);
		expectRejected(researchRequestSchema, { ...researchRequest, markets: ["CN"] }, ["markets"]);
	});

	it("bounds the question and trims it", () => {
		expectRejected(researchRequestSchema, { ...researchRequest, question: "  a " }, ["question"]);
		expectRejected(researchRequestSchema, { ...researchRequest, question: "q".repeat(2001) }, [
			"question",
		]);
		const parsed = expectAccepted(researchRequestSchema, {
			...researchRequest,
			question: "  Why?  ",
		});
		expect(parsed.question).toBe("Why?");
	});

	it("requires a budget, an agent and an effort level", () => {
		expectRejected(researchRequestSchema, without(researchRequest, "budget"), ["budget"]);
		expectRejected(researchRequestSchema, without(researchRequest, "agentId"), ["agentId"]);
		expectRejected(researchRequestSchema, { ...researchRequest, agentId: "Claude Code" }, [
			"agentId",
		]);
		expectRejected(researchRequestSchema, { ...researchRequest, effort: "max" }, ["effort"]);
		for (const effort of ["low", "medium", "high"]) expectAccepted(effortSchema, effort);
	});

	it("rejects tool or permission overrides smuggled into the request", () => {
		expectRejected(researchRequestSchema, { ...researchRequest, permittedToolIds: ["shell"] });
		expectRejected(researchRequestSchema, { ...researchRequest, ownerId: "someone-else" });
	});

	it("parses a stored request from before webAccess as off (fail closed, ARCH-017)", () => {
		const parsed = expectAccepted(researchRequestSchema, without(researchRequest, "webAccess"));
		expect(parsed.webAccess).toBe("off");
	});

	it("accepts both webAccess modes", () => {
		expect(expectAccepted(researchRequestSchema, researchRequest).webAccess).toBe("off");
		expect(
			expectAccepted(researchRequestSchema, { ...researchRequest, webAccess: "public-web" })
				.webAccess,
		).toBe("public-web");
		expectRejected(researchRequestSchema, { ...researchRequest, webAccess: "intranet" }, [
			"webAccess",
		]);
	});
});

describe("researchRunSchema", () => {
	it("accepts a running research job and a news-ingest job without a request", () => {
		expectAccepted(researchRunSchema, researchRun);
		expectAccepted(researchRunSchema, {
			...researchRun,
			kind: "news-ingest",
			workspaceId: null,
			request: null,
			state: "pending",
			leaseExpiresAt: null,
			attempt: 0,
		});
	});

	it("accepts a job waiting for approval and a verified completed job", () => {
		expectAccepted(researchRunSchema, {
			...researchRun,
			state: "waiting_approval",
			approvalRequest: { reasonCode: "SPEND_CONSENT_REQUIRED", detail: "Metered backend." },
		});
		expectAccepted(researchRunSchema, {
			...researchRun,
			state: "completed",
			verificationStatus: "partially-verified",
			cost: { status: "metered", totalCostUsd: 0.4, meteredPortionUsd: 0.4 },
		});
	});

	it("carries the tool error alongside ALL_TOOL_CALLS_FAILED on the run view", () => {
		expectAccepted(researchRunSchema, {
			...researchRun,
			state: "failed",
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TIMEOUT",
		});
		expectRejected(
			researchRunSchema,
			{
				...researchRun,
				state: "failed",
				failureCode: "ALL_TOOL_CALLS_FAILED",
				failureDetail: "x".repeat(81),
			},
			["failureDetail"],
		);
	});

	it("refuses page-derived text as a failure detail (finding 10, task 23b)", () => {
		for (const detail of [
			"Click here to read more",
			"timeout",
			"TIME OUT",
			"TIMEOUT!",
			"<timeout>",
			"a",
			"1TIMEOUT",
		]) {
			expectRejected(
				researchRunSchema,
				{
					...researchRun,
					state: "failed",
					failureCode: "ALL_TOOL_CALLS_FAILED",
					failureDetail: detail,
				},
				["failureDetail"],
			);
		}
		expectAccepted(researchRunSchema, {
			...researchRun,
			state: "failed",
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TOOL_ERROR",
		});
	});

	it("ties failureDetail to ALL_TOOL_CALLS_FAILED or NO_EVIDENCE_COLLECTED (ADR-0025)", () => {
		expectAccepted(researchRunSchema, {
			...researchRun,
			state: "failed",
			failureCode: "NO_EVIDENCE_COLLECTED",
			failureDetail: "NO_TOOL_REQUESTED",
		});
		for (const detail of ["PLAN_NOT_JSON", "TOOLS_RETURNED_NOTHING", "TIMEOUT"]) {
			expectAccepted(researchRunSchema, {
				...researchRun,
				state: "failed",
				failureCode: "NO_EVIDENCE_COLLECTED",
				failureDetail: detail,
			});
		}
		expectRejected(
			researchRunSchema,
			{
				...researchRun,
				state: "failed",
				failureCode: "PROVIDER_RATE_LIMITED",
				failureDetail: "TIMEOUT",
			},
			["failureDetail"],
		);
		expectRejected(
			researchRunSchema,
			{ ...researchRun, state: "failed", failureCode: null, failureDetail: "TIMEOUT" },
			["failureDetail"],
		);
		expectAccepted(researchRunSchema, {
			...researchRun,
			state: "failed",
			failureCode: "NO_EVIDENCE_COLLECTED",
			failureDetail: null,
		});
	});

	it("rejects unknown states and verification statuses", () => {
		expectRejected(researchRunSchema, { ...researchRun, state: "running" }, ["state"]);
		expectRejected(researchRunSchema, { ...researchRun, verificationStatus: "looks-good" }, [
			"verificationStatus",
		]);
		for (const status of ["verified", "partially-verified", "unverified"]) {
			expectAccepted(verificationStatusSchema, status);
		}
	});

	it("rejects a zero retry ceiling, a negative attempt and unknown keys", () => {
		expectRejected(researchRunSchema, { ...researchRun, maxAttempts: 0 }, ["maxAttempts"]);
		expectRejected(researchRunSchema, { ...researchRun, attempt: -1 }, ["attempt"]);
		expectRejected(researchRunSchema, { ...researchRun, leaseOwnerToken: "secret" });
	});

	it("bounds the progress log", () => {
		const entry = { at: T0, kind: "note", text: "working" };
		expectAccepted(runProgressEntrySchema, entry);
		expectRejected(runProgressEntrySchema, { ...entry, kind: "html" }, ["kind"]);
		expectAccepted(researchRunSchema, { ...researchRun, progress: repeat(entry, 200) });
		expectRejected(researchRunSchema, { ...researchRun, progress: repeat(entry, 201) }, [
			"progress",
		]);
	});
});

describe("researchBundleSchema", () => {
	it("accepts a full bundle and an empty one", () => {
		expectAccepted(researchBundleSchema, researchBundle);
		expectAccepted(researchBundleSchema, emptyBundle);
	});

	it("publishes the documented collection limits", () => {
		expect(BUNDLE_LIMITS).toEqual({
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
			datasetCells: 3_000,
			uiOperations: 30,
			articles: 400,
		});
	});

	it("caps the total number of table cells across a bundle's datasets", () => {
		const table = (datasetId: string, rowCount: number) => ({
			datasetId,
			title: "Wide table",
			columns: Array.from({ length: 10 }, (_, column) => ({
				key: `c${column}`,
				label: `Column ${column}`,
				kind: "text",
			})),
			rows: Array.from({ length: rowCount }, () =>
				Object.fromEntries(Array.from({ length: 10 }, (_, column) => [`c${column}`, { v: "x" }])),
			),
			createdAt: "2026-10-11T00:00:00.000Z",
		});
		// Two tables of 150 rows x 10 columns = exactly 3,000 cells: allowed.
		expectAccepted(researchBundleSchema, {
			...emptyBundle,
			datasets: [table("ds_a", 150), table("ds_b", 150)],
		});
		// One more row tips it over.
		const rejected = researchBundleSchema.safeParse({
			...emptyBundle,
			datasets: [table("ds_a", 150), table("ds_b", 151)],
		});
		expect(rejected.success).toBe(false);
		expect(rejected.error?.issues[0]?.message).toContain("at most 3000 table cells");
	});

	it("refuses an oversized bundle without validating its cells", () => {
		// Every cell is invalid, but the size gate answers first: no per-cell issues are produced.
		const junk = {
			datasetId: "ds_junk",
			rows: Array.from({ length: 400 }, () =>
				Object.fromEntries(Array.from({ length: 10 }, (_, column) => [`c${column}`, { bogus: 1 }])),
			),
		};
		const rejected = researchBundleSchema.safeParse({ ...emptyBundle, datasets: [junk] });
		expect(rejected.success).toBe(false);
		expect(rejected.error?.issues).toHaveLength(1);
	});

	const limited: readonly (keyof ResearchBundle & keyof typeof BUNDLE_LIMITS)[] = [
		"evidence",
		"claims",
		"scenarios",
		"securities",
		"supplierLinks",
		"financialObservations",
		"positionObservations",
		"investorFilings",
		"pricingPower",
		"datasets",
		"uiOperations",
	];

	it.each(limited)("accepts %s at its limit and rejects one more", (key) => {
		const [sample] = researchBundle[key];
		if (sample === undefined) throw new Error(`fixture has no ${key}`);
		const limit = BUNDLE_LIMITS[key];
		expectAccepted(researchBundleSchema, { ...emptyBundle, [key]: repeat(sample, limit) });
		expectRejected(researchBundleSchema, { ...emptyBundle, [key]: repeat(sample, limit + 1) }, [
			key,
		]);
	});

	it("bounds the answer text and the claim ids it cites", () => {
		expectAccepted(researchBundleSchema, { ...emptyBundle, answerText: "a".repeat(6000) });
		expectRejected(researchBundleSchema, { ...emptyBundle, answerText: "a".repeat(6001) }, [
			"answerText",
		]);
		expectRejected(researchBundleSchema, { ...emptyBundle, answerText: "" }, ["answerText"]);
		expectAccepted(researchBundleSchema, { ...emptyBundle, answerClaimIds: repeat("claim_1", 80) });
		expectRejected(
			researchBundleSchema,
			{ ...emptyBundle, answerClaimIds: repeat("claim_1", 81) },
			["answerClaimIds"],
		);
	});

	it("validates every nested record, not just the envelope", () => {
		expectRejected(
			researchBundleSchema,
			{
				...emptyBundle,
				financialObservations: [
					{ ...researchBundle.financialObservations[0], sourceEvidenceId: null },
				],
			},
			["financialObservations", 0, "sourceEvidenceId"],
		);
		expectRejected(
			researchBundleSchema,
			{ ...emptyBundle, supplierLinks: [{ ...researchBundle.supplierLinks[0], evidenceIds: [] }] },
			["supplierLinks", 0, "evidenceIds"],
		);
		expectRejected(
			researchBundleSchema,
			{ ...emptyBundle, uiOperations: [{ operation: "component.eval", code: "alert(1)" }] },
			["uiOperations", 0],
		);
	});

	it("rejects UI operations that carry a server-stamped envelope", () => {
		expectRejected(researchBundleSchema, {
			...emptyBundle,
			uiOperations: [
				{
					protocolVersion: 1,
					commandId: "cmd_1",
					workspaceId: "ws_other",
					expectedWorkspaceVersion: 0,
					operation: "component.remove",
					componentId: "x",
				},
			],
		});
	});

	it("requires provenance: agent, prompt version, tool versions and data cut-off (AGT-010)", () => {
		expectRejected(researchBundleSchema, without(emptyBundle, "provenance"), ["provenance"]);
		for (const key of [
			"agentId",
			"promptVersion",
			"toolVersions",
			"dataCutoffAt",
			"providerModel",
		] as const) {
			expectRejected(
				researchBundleSchema,
				{ ...emptyBundle, provenance: without(emptyBundle.provenance, key) },
				["provenance", key],
			);
		}
	});

	it("requires a verification status and rejects unknown keys such as raw HTML", () => {
		expectRejected(researchBundleSchema, without(emptyBundle, "verificationStatus"), [
			"verificationStatus",
		]);
		expectRejected(researchBundleSchema, { ...emptyBundle, answerHtml: "<p>hi</p>" });
	});
});

describe("runner protocol: claim", () => {
	it("accepts a claim request listing available and unavailable backends", () => {
		expectAccepted(claimJobRequestSchema, { runnerVersion: "0.1.0", agents: [agentDescriptor] });
		expectAccepted(claimJobRequestSchema, { runnerVersion: "0.1.0", agents: [] });
	});

	it("rejects a claim request without a version, with too many agents, or with secrets", () => {
		expectRejected(claimJobRequestSchema, { agents: [] }, ["runnerVersion"]);
		expectRejected(
			claimJobRequestSchema,
			{ runnerVersion: "0.1.0", agents: repeat(agentDescriptor, 17) },
			["agents"],
		);
		expectRejected(claimJobRequestSchema, { runnerVersion: "0.1.0", agents: [], token: "secret" });
	});

	it("accepts a claimed research job and a claimed news-ingest job", () => {
		expectAccepted(claimedJobSchema, claimedResearchJob);
		expectAccepted(claimedJobSchema, {
			kind: "news-ingest",
			runId: "run_2",
			leaseGeneration: 3,
			leaseExpiresAt: T1,
			attempt: 2,
			heartbeatIntervalMs: 15_000,
			sources: [subscribedSource],
		});
	});

	it("requires a research job to carry its request and a news-ingest job not to", () => {
		expectRejected(claimedJobSchema, without(claimedResearchJob, "request"), ["request"]);
		expectRejected(claimedJobSchema, { ...claimedResearchJob, kind: "news-ingest" });
	});

	it("requires a positive lease generation, attempt and heartbeat interval", () => {
		expectRejected(claimedJobSchema, { ...claimedResearchJob, leaseGeneration: 0 }, [
			"leaseGeneration",
		]);
		expectRejected(claimedJobSchema, { ...claimedResearchJob, attempt: 0 }, ["attempt"]);
		expectRejected(claimedJobSchema, { ...claimedResearchJob, heartbeatIntervalMs: 0 }, [
			"heartbeatIntervalMs",
		]);
		expectRejected(claimedJobSchema, without(claimedResearchJob, "leaseExpiresAt"), [
			"leaseExpiresAt",
		]);
	});

	it("rejects unknown job kinds and database or owner credentials in the payload", () => {
		expectRejected(claimedJobSchema, { ...claimedResearchJob, kind: "shell" });
		expectRejected(claimedJobSchema, { ...claimedResearchJob, databaseUrl: "d1://prod" });
		expectRejected(claimedJobSchema, { ...claimedResearchJob, ownerSessionCookie: "abc" });
	});

	it("summarizes existing workspace components by id, type and optional title", () => {
		const summary = { componentId: "table_1", componentType: "data-table", title: "Demand" };
		expectAccepted(workspaceComponentSummarySchema, summary);
		expectAccepted(workspaceComponentSummarySchema, { ...summary, title: null });
		expectRejected(workspaceComponentSummarySchema, without(summary, "title"), ["title"]);
		expectRejected(workspaceComponentSummarySchema, without(summary, "componentId"), [
			"componentId",
		]);
		expectRejected(workspaceComponentSummarySchema, { ...summary, props: { datasetRef: "ds_1" } });
		expectAccepted(claimedJobSchema, { ...claimedResearchJob, workspaceComponents: [] });
		expectAccepted(claimedJobSchema, {
			...claimedResearchJob,
			workspaceComponents: repeat(summary, 60),
		});
		expectRejected(
			claimedJobSchema,
			{ ...claimedResearchJob, workspaceComponents: repeat(summary, 61) },
			["workspaceComponents"],
		);
		expectRejected(claimedJobSchema, without(claimedResearchJob, "workspaceComponents"), [
			"workspaceComponents",
		]);
	});

	it("carries a bounded slice of earlier conversation, oldest first", () => {
		expect(CONVERSATION_CONTEXT_LIMITS).toEqual({
			maxMessages: 6,
			maxMessageChars: 600,
			maxTotalBytes: 2_400,
		});
		const message = { role: "owner", text: "and what about Japan?" };
		expectAccepted(conversationContextMessageSchema, message);
		expectAccepted(conversationContextMessageSchema, { role: "assistant", text: "Here is more." });
		expectRejected(conversationContextMessageSchema, { role: "system", text: "hi" }, ["role"]);
		expectRejected(conversationContextMessageSchema, { role: "owner", text: "" }, ["text"]);
		expectRejected(conversationContextMessageSchema, { role: "owner", text: "a".repeat(601) }, [
			"text",
		]);
		expectAccepted(conversationContextMessageSchema, { role: "owner", text: "a".repeat(600) });
		expectRejected(conversationContextMessageSchema, { role: "owner", text: "x", extra: 1 });
		expectAccepted(claimedJobSchema, { ...claimedResearchJob, conversationContext: [] });
		expectAccepted(claimedJobSchema, {
			...claimedResearchJob,
			conversationContext: repeat(message, 6),
		});
		expectRejected(
			claimedJobSchema,
			{ ...claimedResearchJob, conversationContext: repeat(message, 7) },
			["conversationContext"],
		);
		expectRejected(claimedJobSchema, without(claimedResearchJob, "conversationContext"), [
			"conversationContext",
		]);
		// Six messages of 600 multi-byte characters pass the count and character
		// limits at 10,800 UTF-8 bytes against the 2,400-byte ceiling: rejected.
		expectRejected(
			claimedJobSchema,
			{
				...claimedResearchJob,
				conversationContext: repeat({ role: "owner", text: "日".repeat(600) }, 6),
			},
			["conversationContext"],
		);
		// Two such messages (3,600 bytes) are rejected too; one (1,800 bytes) fits.
		expectRejected(
			claimedJobSchema,
			{
				...claimedResearchJob,
				conversationContext: repeat({ role: "owner", text: "日".repeat(600) }, 2),
			},
			["conversationContext"],
		);
		expectAccepted(claimedJobSchema, {
			...claimedResearchJob,
			conversationContext: [{ role: "owner", text: "日".repeat(600) }],
		});
		expectRejected(claimedJobSchema, {
			kind: "news-ingest",
			runId: "run_2",
			leaseGeneration: 3,
			leaseExpiresAt: T1,
			attempt: 2,
			heartbeatIntervalMs: 15_000,
			sources: [subscribedSource],
			conversationContext: [],
		});
	});

	it("accepts an empty poll response and requires the back-off hint", () => {
		expectAccepted(claimJobResponseSchema, { job: null, pollAfterMs: 30_000 });
		expectAccepted(claimJobResponseSchema, { job: claimedResearchJob, pollAfterMs: 5000 });
		expectRejected(claimJobResponseSchema, { job: null }, ["pollAfterMs"]);
		expectRejected(claimJobResponseSchema, { job: null, pollAfterMs: 0 }, ["pollAfterMs"]);
		expectRejected(claimJobResponseSchema, { pollAfterMs: 1000 }, ["job"]);
	});

	it("validates subscribed source references", () => {
		expectAccepted(subscribedSourceRefSchema, subscribedSource);
		expectRejected(subscribedSourceRefSchema, { ...subscribedSource, licensePolicy: "full-text" }, [
			"licensePolicy",
		]);
		expectRejected(subscribedSourceRefSchema, without(subscribedSource, "licensePolicy"), [
			"licensePolicy",
		]);
	});
});

describe("runner protocol: lease hand-back (ADR-0036)", () => {
	const usage = {
		agentSteps: 2,
		toolCalls: 1,
		inputBytes: 4_096,
		knownCostUsd: 0.25,
		hasUnmeteredUsage: false,
	};

	it("accepts a release with its generation and usage, and both answers", () => {
		expectAccepted(releaseJobRequestSchema, { leaseGeneration: 1, usage });
		expectAccepted(releaseJobResponseSchema, { state: "pending" });
		expectAccepted(releaseJobResponseSchema, { state: "cancelled" });
	});

	it("rejects a release without usage, with a bad generation or extra fields", () => {
		expectRejected(releaseJobRequestSchema, { leaseGeneration: 1 }, ["usage"]);
		expectRejected(releaseJobRequestSchema, { leaseGeneration: 0, usage }, ["leaseGeneration"]);
		expectRejected(releaseJobRequestSchema, { leaseGeneration: 1, usage, attempt: 0 });
		expectRejected(releaseJobResponseSchema, { state: "claimed" }, ["state"]);
	});
});

describe("runner protocol: heartbeat and events", () => {
	it("accepts a heartbeat for a lease generation and its response", () => {
		expectAccepted(heartbeatRequestSchema, { leaseGeneration: 1 });
		expectAccepted(heartbeatResponseSchema, { leaseExpiresAt: T1, cancelRequested: false });
	});

	it.each([0, -1, 1.5, "1", null])("rejects the lease generation %j", (leaseGeneration) => {
		expectRejected(heartbeatRequestSchema, { leaseGeneration }, ["leaseGeneration"]);
	});

	it("rejects a heartbeat without a generation or with extra fields", () => {
		expectRejected(heartbeatRequestSchema, {}, ["leaseGeneration"]);
		expectRejected(heartbeatRequestSchema, { leaseGeneration: 1, extendMs: 86_400_000 });
		expectRejected(heartbeatResponseSchema, { leaseExpiresAt: T1 }, ["cancelRequested"]);
	});

	const event = (payload: object) => ({ seq: 0, at: T0, event: payload });

	it.each([
		{ type: "state", state: "collecting" },
		{ type: "note", text: "Fetched 12 articles." },
		{ type: "tool", toolId: "news.search", outcome: "executed", detail: "ok" },
		{ type: "tool", toolId: "shell", outcome: "denied", detail: "UNKNOWN_TOOL" },
		{ type: "usage", usage: resourceUsage },
		{ type: "provider-session", sessionRef: "sess_abc" },
	])("accepts the runner event %j", (payload) => {
		expectAccepted(runnerEventSchema, event(payload));
	});

	it("does not let a runner report a terminal or non-leased state as an event", () => {
		for (const state of [
			"completed",
			"failed",
			"cancelled",
			"partial",
			"pending",
			"waiting_approval",
		]) {
			expectRejected(runnerEventSchema, event({ type: "state", state }), ["event", "state"]);
		}
	});

	it("rejects unknown event types, tool outcomes and extra keys", () => {
		expectRejected(runnerEventSchema, event({ type: "exec", command: "rm -rf /" }));
		expectRejected(
			runnerEventSchema,
			event({ type: "tool", toolId: "t", outcome: "bypassed", detail: "" }),
		);
		expectRejected(runnerEventSchema, event({ type: "note", text: "x", html: "<b>x</b>" }));
		expectRejected(runnerEventSchema, event({ type: "note", text: "" }));
	});

	it("requires a non-negative integer sequence number and a timestamp", () => {
		expectRejected(runnerEventSchema, { ...event({ type: "note", text: "x" }), seq: -1 }, ["seq"]);
		expectRejected(runnerEventSchema, { ...event({ type: "note", text: "x" }), seq: 0.5 }, ["seq"]);
		expectRejected(runnerEventSchema, without(event({ type: "note", text: "x" }), "at"), ["at"]);
	});

	it("bounds a batch of events", () => {
		const one = event({ type: "note", text: "x" });
		expect(MAX_RUNNER_EVENTS_PER_REQUEST).toBe(50);
		expectAccepted(runnerEventsRequestSchema, { leaseGeneration: 1, events: repeat(one, 50) });
		expectRejected(runnerEventsRequestSchema, { leaseGeneration: 1, events: repeat(one, 51) }, [
			"events",
		]);
		expectRejected(runnerEventsRequestSchema, { leaseGeneration: 1, events: [] }, ["events"]);
		expectRejected(runnerEventsRequestSchema, { events: [one] }, ["leaseGeneration"]);
	});
});

describe("runner protocol: completion", () => {
	const base = { leaseGeneration: 1, usage: resourceUsage };
	const delivered = {
		bundle: emptyBundle,
		articles: [ingestedArticle],
		sourceReports: [sourceReport],
	};

	const outcomes = {
		completed: { outcome: "completed", ...base, ...delivered },
		partial: { outcome: "partial", ...base, ...delivered, failureCode: "MAX_WALL_CLOCK" },
		ingested: {
			outcome: "ingested",
			...base,
			articles: [ingestedArticle],
			sourceReports: [sourceReport],
		},
		failed: { outcome: "failed", ...base, failureCode: "PROVIDER_ERROR", retryable: true },
		cancelled: { outcome: "cancelled", ...base },
		waiting_approval: {
			outcome: "waiting_approval",
			...base,
			approvalRequest: { reasonCode: "SPEND_CONSENT_REQUIRED", detail: "Metered backend." },
		},
	} as const;

	it.each(Object.keys(outcomes) as (keyof typeof outcomes)[])("accepts the %s outcome", (name) => {
		expectAccepted(completeJobRequestSchema, outcomes[name]);
	});

	it.each(
		Object.keys(outcomes) as (keyof typeof outcomes)[],
	)("requires the lease generation and usage on the %s outcome", (name) => {
		expectRejected(completeJobRequestSchema, without(outcomes[name], "leaseGeneration"), [
			"leaseGeneration",
		]);
		expectRejected(completeJobRequestSchema, without(outcomes[name], "usage"), ["usage"]);
		expectRejected(completeJobRequestSchema, { ...outcomes[name], leaseGeneration: 0 }, [
			"leaseGeneration",
		]);
	});

	it("rejects unknown outcomes", () => {
		for (const outcome of ["success", "done", "COMPLETED", ""]) {
			expectRejected(completeJobRequestSchema, { ...outcomes.cancelled, outcome });
		}
		expectRejected(completeJobRequestSchema, base);
	});

	it("requires a completed job to deliver its bundle", () => {
		expectRejected(completeJobRequestSchema, without(outcomes.completed, "bundle"), ["bundle"]);
	});

	it("requires a partial result to say what stopped the run", () => {
		expectRejected(completeJobRequestSchema, without(outcomes.partial, "failureCode"), [
			"failureCode",
		]);
		expectRejected(completeJobRequestSchema, { ...outcomes.partial, failureCode: "" }, [
			"failureCode",
		]);
	});

	it("requires a failure to carry a code and a retryable flag, and no bundle", () => {
		expectRejected(completeJobRequestSchema, without(outcomes.failed, "failureCode"), [
			"failureCode",
		]);
		expectRejected(completeJobRequestSchema, without(outcomes.failed, "retryable"), ["retryable"]);
		expectRejected(completeJobRequestSchema, { ...outcomes.failed, bundle: emptyBundle });
	});

	it("carries the most frequent tool error alongside ALL_TOOL_CALLS_FAILED", () => {
		expectAccepted(completeJobRequestSchema, {
			...outcomes.failed,
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TIMEOUT",
		});
		// The detail is a short code, never free text: empty and oversized values are refused.
		expectRejected(completeJobRequestSchema, { ...outcomes.failed, failureDetail: "" }, [
			"failureDetail",
		]);
		expectRejected(
			completeJobRequestSchema,
			{ ...outcomes.failed, failureDetail: "x".repeat(81) },
			["failureDetail"],
		);
	});

	it("refuses page-derived text and a mis-tied detail on completion (finding 10, ADR-0025)", () => {
		for (const detail of ["Click here to read more", "timeout", "TIME OUT", "a", "1X"]) {
			expectRejected(
				completeJobRequestSchema,
				{ ...outcomes.failed, failureCode: "ALL_TOOL_CALLS_FAILED", failureDetail: detail },
				["failureDetail"],
			);
			expectRejected(
				completeJobRequestSchema,
				{ ...outcomes.failed, failureCode: "NO_EVIDENCE_COLLECTED", failureDetail: detail },
				["failureDetail"],
			);
		}
		for (const detail of ["NO_TOOL_REQUESTED", "PLAN_NOT_JSON", "TOOLS_RETURNED_NOTHING"]) {
			expectAccepted(completeJobRequestSchema, {
				...outcomes.failed,
				failureCode: "NO_EVIDENCE_COLLECTED",
				failureDetail: detail,
			});
		}
		expectRejected(
			completeJobRequestSchema,
			{ ...outcomes.failed, failureCode: "PROVIDER_RATE_LIMITED", failureDetail: "TIMEOUT" },
			["failureDetail"],
		);
		expectAccepted(completeJobRequestSchema, {
			...outcomes.failed,
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TOOL_ERROR",
		});
		expectAccepted(completeJobRequestSchema, {
			...outcomes.failed,
			failureCode: "NO_EVIDENCE_COLLECTED",
		});
	});

	it("rejects a cancelled or approval-seeking completion that smuggles results", () => {
		expectRejected(completeJobRequestSchema, { ...outcomes.cancelled, bundle: emptyBundle });
		expectRejected(completeJobRequestSchema, { ...outcomes.waiting_approval, bundle: emptyBundle });
		expectRejected(
			completeJobRequestSchema,
			without(outcomes.waiting_approval, "approvalRequest"),
			["approvalRequest"],
		);
	});

	it("bounds ingested articles and source reports", () => {
		expectAccepted(completeJobRequestSchema, {
			...outcomes.ingested,
			articles: repeat(ingestedArticle, BUNDLE_LIMITS.articles),
		});
		expectRejected(
			completeJobRequestSchema,
			{ ...outcomes.ingested, articles: repeat(ingestedArticle, BUNDLE_LIMITS.articles + 1) },
			["articles"],
		);
		expectRejected(
			completeJobRequestSchema,
			{ ...outcomes.ingested, sourceReports: repeat(sourceReport, 201) },
			["sourceReports"],
		);
	});

	it("does not let the runner choose article ids", () => {
		expectAccepted(ingestedArticleSchema, ingestedArticle);
		expectRejected(ingestedArticleSchema, {
			...ingestedArticle,
			articleId: "art_chosen_by_runner",
		});
		expectRejected(
			ingestedArticleSchema,
			{ ...ingestedArticle, canonicalUrl: "http://insecure.example.org/" },
			["canonicalUrl"],
		);
	});

	it("validates source fetch reports", () => {
		expectAccepted(sourceFetchReportSchema, sourceReport);
		expectAccepted(sourceFetchReportSchema, { ...sourceReport, errorCode: "FETCH_TIMEOUT" });
		expectRejected(sourceFetchReportSchema, without(sourceReport, "errorCode"), ["errorCode"]);
	});

	it("accepts the completion response, including an idempotent replay", () => {
		expectAccepted(completeJobResponseSchema, {
			state: "completed",
			replayed: false,
			newArticleCount: 3,
		});
		expectAccepted(completeJobResponseSchema, {
			state: "completed",
			replayed: true,
			newArticleCount: 0,
		});
		expectRejected(completeJobResponseSchema, { state: "completed", newArticleCount: 0 }, [
			"replayed",
		]);
		expectRejected(
			completeJobResponseSchema,
			{ state: "ok", replayed: false, newArticleCount: 0 },
			["state"],
		);
		expectRejected(
			completeJobResponseSchema,
			{ state: "completed", replayed: false, newArticleCount: -1 },
			["newArticleCount"],
		);
	});
});

describe("runner protocol: earnings-refresh (FR-018)", () => {
	const event = {
		periodKey: "2026-q4",
		announcementDate: "2026-10-29",
		fiscalPeriodLabel: "Q4 2026",
		fiscalPeriodEnd: null,
		timing: "after-close",
	};
	const claimedEarnings = {
		kind: "earnings-refresh",
		runId: "run_earn",
		leaseGeneration: 2,
		leaseExpiresAt: T1,
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		fromDate: "2026-10-13",
		toDate: "2027-04-16",
		stocks: [
			{ stockId: "us:AAPL", name: "Apple Inc" },
			{ stockId: "jp:7203", name: null },
		],
	};
	const refreshed = {
		outcome: "earnings-refreshed",
		leaseGeneration: 2,
		usage: resourceUsage,
		stocks: [
			{
				stockId: "us:AAPL",
				fetchedAt: T1,
				name: "Apple Inc",
				events: [event],
				errorCode: null,
			},
			{
				stockId: "jp:7203",
				fetchedAt: T1,
				name: null,
				events: [],
				errorCode: "SOURCE_FAILED",
			},
		],
	};

	it("accepts a claimed earnings-refresh job with its window and stocks", () => {
		expectAccepted(claimedJobSchema, claimedEarnings);
		expectAccepted(claimJobResponseSchema, { job: claimedEarnings, pollAfterMs: 2000 });
		expectAccepted(claimedJobSchema, { ...claimedEarnings, stocks: [] });
	});

	it("rejects a claimed earnings job with a bad id, window or stock cap", () => {
		expectRejected(
			claimedJobSchema,
			{ ...claimedEarnings, stocks: [{ stockId: "nope", name: null }] },
			["stocks"],
		);
		expectRejected(claimedJobSchema, without(claimedEarnings, "fromDate"), ["fromDate"]);
		expectRejected(claimedJobSchema, without(claimedEarnings, "toDate"), ["toDate"]);
		expectRejected(
			claimedJobSchema,
			{ ...claimedEarnings, stocks: repeat({ stockId: "us:AAPL", name: null }, 51) },
			["stocks"],
		);
		// Publisher and source URL are never sent by the runner: the API derives them.
		expectRejected(claimedJobSchema, { ...claimedEarnings, publisher: "Finnhub" });
	});

	it("accepts an earnings-refreshed completion with successes and failures", () => {
		expectAccepted(completeJobRequestSchema, refreshed);
		expectAccepted(completeJobRequestSchema, { ...refreshed, stocks: [] });
	});

	it("rejects an earnings completion with duplicate stock ids or period keys", () => {
		// A duplicate success+failure pair for one stock would apply the
		// events replace and then the failure path (or vice versa): the
		// contract rejects duplicates instead of deleting a "failed" stock's
		// events.
		expectRejected(
			completeJobRequestSchema,
			{
				...refreshed,
				stocks: [
					{ ...refreshed.stocks[1], errorCode: null, events: [event] },
					{ ...refreshed.stocks[1], errorCode: "SOURCE_FAILED", events: [] },
				],
			},
			["stocks"],
		);
		expectRejected(
			completeJobRequestSchema,
			{
				...refreshed,
				stocks: [{ ...refreshed.stocks[0], events: [event, event] }],
			},
			["stocks"],
		);
	});

	it("rejects an earnings completion that mixes events with an error code", () => {
		expectRejected(
			completeJobRequestSchema,
			{
				...refreshed,
				stocks: [{ ...refreshed.stocks[0], errorCode: "SOURCE_FAILED" }],
			},
			["stocks"],
		);
		expectRejected(
			completeJobRequestSchema,
			{
				...refreshed,
				stocks: [{ ...refreshed.stocks[1], errorCode: "NO_SCHEDULED_DATE", events: [event] }],
			},
			["stocks"],
		);
	});

	it("bounds earnings events per stock and stocks per completion", () => {
		const distinct = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				...event,
				periodKey: `2026-q${(index % 4) + 1}-${index}`,
			}));
		expectAccepted(completeJobRequestSchema, {
			...refreshed,
			stocks: [{ ...refreshed.stocks[0], events: distinct(8) }],
		});
		expectRejected(
			completeJobRequestSchema,
			{ ...refreshed, stocks: [{ ...refreshed.stocks[0], events: distinct(9) }] },
			["stocks"],
		);
		expectRejected(
			completeJobRequestSchema,
			{
				...refreshed,
				stocks: repeat({ ...refreshed.stocks[1] }, 51),
			},
			["stocks"],
		);
		expectRejected(
			completeJobRequestSchema,
			{ ...refreshed, stocks: [{ ...refreshed.stocks[1], errorCode: "BOGUS_CODE" }] },
			["stocks"],
		);
	});
});
