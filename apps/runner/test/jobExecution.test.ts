import type { ClaimedJob, CompleteJobRequest } from "@research/contracts";
import { EMPTY_USAGE } from "@research/domain";
import type { EventLogger, LogFields } from "@research/effects";
import { silentEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob, runFinishedFields, toCompletion } from "../src/jobExecution.ts";
import {
	apiFailure,
	createDeps,
	createFakeApi,
	INGEST_JOB,
	RESEARCH_JOB,
	RUN_ID,
} from "./support.ts";

const never = new AbortController().signal;

function stateSequence(
	events: { events: { seq: number; event: { type: string; state?: string } }[] }[],
) {
	return events
		.flatMap((request) => request.events)
		.filter((entry) => entry.event.type === "state")
		.map((entry) => entry.event.state);
}

describe("job execution under a lease", () => {
	it("reports ordered progress, completes exactly once and discards its scratch directory", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(RESEARCH_JOB, harness.deps, never);

		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		// Sequence numbers are strictly increasing across requests, so resends are idempotent.
		const seqs = calls.events.flatMap((request) => request.events.map((entry) => entry.seq));
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(calls.events.every((request) => request.leaseGeneration === 3)).toBe(true);

		expect(calls.completions).toHaveLength(1);
		expect(calls.completions[0]).toMatchObject({ outcome: "completed", leaseGeneration: 3 });
		expect(harness.scratch.created).toEqual([`/scratch/${RUN_ID}`]);
		expect(harness.scratch.removed).toEqual([`/scratch/${RUN_ID}`]);
		expect(harness.timers.every((timer) => timer.stopped)).toBe(true);
		// The agent ran inside the per-job scratch directory.
		expect(
			harness.agent.contexts.every((context) => context.scratchDirectory === `/scratch/${RUN_ID}`),
		).toBe(true);
	});

	it("stops and reports 'cancelled' when the heartbeat carries a cancellation", async () => {
		const { api, calls } = createFakeApi({
			heartbeat: [
				{ ok: true, value: { leaseExpiresAt: "2026-10-11T00:03:00.000Z", cancelRequested: true } },
			],
		});
		const harness = createDeps(api, {
			onTurn: async (turnIndex) => {
				if (turnIndex === 0) await harness.tickHeartbeat();
			},
		});
		await executeJob(RESEARCH_JOB, harness.deps, never);
		expect(calls.heartbeats).toEqual([3]);
		expect(calls.completions).toEqual([
			expect.objectContaining({ outcome: "cancelled", leaseGeneration: 3 }),
		]);
		// Cancelled during planning: the tool call the plan asked for never ran.
		expect(harness.tools.executed).toEqual([]);
	});

	it("submits nothing once the lease is lost (a superseded runner stays silent)", async () => {
		for (const lostVia of ["events", "heartbeat"] as const) {
			const { api, calls } = createFakeApi(
				lostVia === "events"
					? { events: [{ ok: true, value: { cancelRequested: false } }, apiFailure("STALE_LEASE")] }
					: { heartbeat: [apiFailure("STALE_LEASE")] },
			);
			const harness = createDeps(api, {
				onTurn: async (turnIndex) => {
					if (lostVia === "heartbeat" && turnIndex === 0) await harness.tickHeartbeat();
				},
			});
			await executeJob(RESEARCH_JOB, harness.deps, never);
			expect(calls.completions, lostVia).toEqual([]);
			// A lost lease is not ours to hand back (ADR-0036).
			expect(calls.releases, lostVia).toEqual([]);
			expect(harness.scratch.removed, lostVia).toEqual([`/scratch/${RUN_ID}`]);
		}
	});

	it("abandons the job on shutdown without completing it and hands the lease back (ADR-0036)", async () => {
		const shutdown = new AbortController();
		const { api, calls } = createFakeApi();
		const harness = createDeps(api, {
			onTurn: (turnIndex) => {
				if (turnIndex === 1) shutdown.abort();
			},
		});
		const records: { event: string; fields?: LogFields }[] = [];
		const record = (event: string, fields?: LogFields) => {
			records.push({ event, fields });
		};
		const logger: EventLogger = {
			info: record,
			warn: record,
			error: record,
			logFailures: () => 0,
		};
		await executeJob(RESEARCH_JOB, { ...harness.deps, logger }, shutdown.signal);
		expect(calls.completions).toEqual([]);
		// The usage so far travels with the release: the unflushed event queue would lose it.
		expect(calls.releases).toEqual([
			{ leaseGeneration: 3, usage: expect.objectContaining({ agentSteps: expect.any(Number) }) },
		]);
		expect(calls.releases[0]?.usage.agentSteps).toBeGreaterThanOrEqual(1);
		expect(harness.scratch.removed).toHaveLength(1);
		const events = records.map((entry) => entry.event);
		expect(events.indexOf("job_released")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("job_released")).toBeLessThan(events.indexOf("job_abandoned"));
		expect(records.find((entry) => entry.event === "job_released")?.fields).toEqual({
			runId: RUN_ID,
			state: "pending",
		});
		expect(records.find((entry) => entry.event === "job_abandoned")?.fields).toEqual({
			runId: RUN_ID,
			reason: "shutdown",
		});
	});

	it("logs a refused or failed release and still abandons the job", async () => {
		for (const [reply, expected] of [
			[apiFailure("STALE_LEASE"), { event: "release_failed", code: "STALE_LEASE" }],
			[
				{ ok: true, value: { state: "cancelled" } },
				{ event: "job_released", state: "cancelled" },
			],
			[
				() => {
					throw new Error("network down");
				},
				{ event: "release_failed", code: "RELEASE_REQUEST_FAILED" },
			],
		] as const) {
			const shutdown = new AbortController();
			shutdown.abort();
			const { api, calls } = createFakeApi({ release: [reply] });
			const harness = createDeps(api);
			const records: { event: string; fields?: LogFields }[] = [];
			const record = (event: string, fields?: LogFields) => {
				records.push({ event, fields });
			};
			const logger: EventLogger = {
				info: record,
				warn: record,
				error: record,
				logFailures: () => 0,
			};
			await executeJob(RESEARCH_JOB, { ...harness.deps, logger }, shutdown.signal);
			expect(calls.completions).toEqual([]);
			expect(calls.releases).toHaveLength(1);
			const { event, ...fields } = expected;
			expect(records.find((entry) => entry.event === event)?.fields).toEqual({
				runId: RUN_ID,
				...fields,
			});
			expect(records.some((entry) => entry.event === "job_abandoned")).toBe(true);
		}
	});

	it("records an honest failure when the Worker rejects the submitted result", async () => {
		const { api, calls } = createFakeApi({
			complete: [
				apiFailure("INTEGRITY_VIOLATION"),
				{ ok: true, value: { state: "completed", replayed: false, newArticleCount: 0 } },
			],
		});
		const harness = createDeps(api);
		await executeJob(RESEARCH_JOB, harness.deps, never);
		expect(calls.completions.map((completion) => completion.outcome)).toEqual([
			"completed",
			"failed",
		]);
		expect(calls.completions[1]).toMatchObject({
			failureCode: "SUBMISSION_REJECTED_INTEGRITY_VIOLATION",
			retryable: false,
		});
	});

	it("does not resubmit after a stale-lease completion", async () => {
		const { api, calls } = createFakeApi({ complete: [apiFailure("STALE_LEASE")] });
		const harness = createDeps(api);
		await executeJob(RESEARCH_JOB, harness.deps, never);
		expect(calls.completions).toHaveLength(1);
	});

	it("reports a retryable failure if the runner itself faults, and still cleans up", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const faulty = {
			...harness.deps,
			tools: {
				get: () => {
					throw new TypeError("registry exploded");
				},
				list: harness.deps.tools.list,
			},
		};
		await executeJob(RESEARCH_JOB, faulty, never);
		expect(calls.completions).toEqual([
			expect.objectContaining({
				outcome: "failed",
				failureCode: "RUNNER_ERROR_TypeError",
				retryable: true,
			}),
		]);
		expect(harness.scratch.removed).toHaveLength(1);
	});

	it("fails without retry when the requested backend is not registered on this runner", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{ ...RESEARCH_JOB, request: { ...RESEARCH_JOB.request, agentId: "codex" } },
			harness.deps,
			never,
		);
		expect(calls.completions).toEqual([
			expect.objectContaining({
				outcome: "failed",
				failureCode: "AGENT_NOT_REGISTERED",
				retryable: false,
			}),
		]);
		expect(harness.agent.requests).toHaveLength(0);
	});

	it("forwards the tool error alongside ALL_TOOL_CALLS_FAILED", () => {
		expect(
			toCompletion(3, {
				kind: "failed",
				failureCode: "ALL_TOOL_CALLS_FAILED",
				failureDetail: "TIMEOUT",
				retryable: false,
				usage: RESEARCH_JOB.priorUsage,
			}),
		).toMatchObject({
			outcome: "failed",
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TIMEOUT",
		});
	});
	it("forwards the claimed conversation context into the research prompts", async () => {
		const { api } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			{
				...RESEARCH_JOB,
				conversationContext: [{ role: "owner", text: "Focus on Japan." }],
			},
			harness.deps,
			never,
		);
		expect(harness.agent.requests[0]?.prompt).toContain("Owner: Focus on Japan.");
		expect(harness.agent.requests[1]?.prompt).toContain("Owner: Focus on Japan.");
		expect(harness.agent.requests[2]?.prompt ?? "").not.toContain("Owner: Focus on Japan.");
	});

	it("keeps undelivered events queued and resends them with the same sequence numbers", async () => {
		const { api, calls } = createFakeApi({
			events: [
				apiFailure("TRANSPORT_ERROR", true),
				{ ok: true, value: { cancelRequested: false } },
			],
		});
		const harness = createDeps(api);
		await executeJob(RESEARCH_JOB, harness.deps, never);
		const first = calls.events[0]?.events ?? [];
		const second = calls.events[1]?.events ?? [];
		expect(second.slice(0, first.length)).toEqual(first);
		expect(stateSequence(calls.events.slice(1))).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(calls.completions).toHaveLength(1);
	});
});

describe("news ingestion jobs (FR-003)", () => {
	it("walks the lifecycle, deduplicates within the run and reports per-source results", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api, {
			feedDocuments: {
				"https://news.example.org/feed.xml":
					"FEED:Battery orders rise@https://news.example.org/a/1?utm_source=rss|Battery orders rise@https://news.example.org/a/1|Chip fab opens@https://news.example.org/a/2|Internal@http://10.0.0.1/x",
			},
		});
		await executeJob(INGEST_JOB, harness.deps, never);

		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		const completion = calls.completions[0];
		expect(completion?.outcome).toBe("ingested");
		if (completion?.outcome !== "ingested") throw new Error("expected an ingest completion");
		expect(completion.articles.map((article) => article.canonicalUrl)).toEqual([
			"https://news.example.org/a/1",
			"https://news.example.org/a/2",
		]);
		expect(completion.articles[0]).toMatchObject({
			sourceId: "src_news",
			publisher: "Example News",
			excerpt: "summary text",
		});
		expect(completion.sourceReports).toEqual([
			{ sourceId: "src_news", fetchedAt: "2026-10-11T00:00:00.000Z", errorCode: null },
		]);
		expect(harness.agent.requests).toHaveLength(0);
	});

	it("reports a failing source and still completes", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(INGEST_JOB, harness.deps, never);
		const completion = calls.completions[0];
		if (completion?.outcome !== "ingested") throw new Error("expected an ingest completion");
		expect(completion.articles).toEqual([]);
		expect(completion.sourceReports[0]).toMatchObject({
			sourceId: "src_news",
			errorCode: "TIMEOUT",
		});
	});
});

describe("progress notes", () => {
	it("never queues a note the Worker would refuse, which would block every later event", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const job: Extract<ClaimedJob, { kind: "google-calendar" }> = {
			kind: "google-calendar",
			runId: RUN_ID,
			leaseGeneration: 3,
			leaseExpiresAt: "2026-10-11T00:01:30.000Z",
			attempt: 1,
			heartbeatIntervalMs: 20_000,
			sources: [],
			action: "disconnect",
		};
		await executeJob(
			job,
			{
				...harness.deps,
				executeGoogleCalendar: async (claimed, _env, _signal, reporter) => {
					await reporter.note("");
					await reporter.note("kept");
					return {
						outcome: "google-calendar-disconnected",
						leaseGeneration: claimed.leaseGeneration,
						usage: EMPTY_USAGE,
						revoked: false,
					};
				},
			},
			never,
		);
		const notes = calls.events
			.flatMap((request) => request.events)
			.flatMap((entry) => (entry.event.type === "note" ? [entry.event.text] : []));
		expect(notes).toEqual(["kept"]);
	});
});

describe("usage accounting survives runner faults and retries (AGT-008)", () => {
	it("reports what was already consumed when the runner faults mid-run", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const faulty = {
			...harness.deps,
			tools: {
				// The planning turn has already been paid for when the tool lookup blows up.
				get: () => {
					throw new TypeError("registry exploded");
				},
				list: harness.deps.tools.list,
			},
		};
		await executeJob(RESEARCH_JOB, faulty, never);
		const completion = calls.completions[0];
		expect(completion).toMatchObject({ outcome: "failed", retryable: true });
		// Not zero: one model turn ran, and its cost on a plan-limited backend is unknown.
		expect(completion?.usage).toMatchObject({ agentSteps: 1, hasUnmeteredUsage: true });
		expect(completion?.usage.inputBytes).toBeGreaterThan(0);
	});

	it("continues from the usage of earlier attempts instead of starting at zero", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const priorUsage = {
			agentSteps: 2,
			toolCalls: 3,
			inputBytes: 5_000,
			knownCostUsd: 0,
			hasUnmeteredUsage: true,
		};
		await executeJob({ ...RESEARCH_JOB, priorUsage }, harness.deps, never);
		const completion = calls.completions[0];
		expect(completion?.outcome).toBe("completed");
		// This attempt added three turns and one tool call on top of the earlier attempt.
		expect(completion?.usage).toMatchObject({ agentSteps: 5, toolCalls: 4 });
		expect(completion?.usage.inputBytes).toBeGreaterThan(5_000);
	});
});

describe("job_finished carries the removed run-card facts (identifiers/codes/counts only)", () => {
	function recordingLogger(into: { event: string; fields?: LogFields }[]): EventLogger {
		return {
			info: (event, fields) => {
				into.push({ event, fields });
			},
			warn: (event, fields) => {
				into.push({ event, fields });
			},
			error: (event, fields) => {
				into.push({ event, fields });
			},
			logFailures: () => 0,
		};
	}

	it("logs attempt, budget, usage, cost-known, verification and progress counts for a completed run", async () => {
		const { api } = createFakeApi();
		const harness = createDeps(api);
		const records: { event: string; fields?: LogFields }[] = [];
		await executeJob(RESEARCH_JOB, { ...harness.deps, logger: recordingLogger(records) }, never);
		const finished = records.find((entry) => entry.event === "job_finished");
		expect(finished).toBeDefined();
		expect(finished?.fields).toMatchObject({
			runId: RUN_ID,
			state: "completed",
			attempt: 1,
			maxAttempts: 3,
			agentId: "scripted",
			promptVersion: "research-v5",
			maxAgentSteps: 6,
			maxToolCalls: 10,
			maxWallClockMs: 600_000,
			maxInputBytes: 400_000,
			maxSpendUsd: null,
			failureCode: null,
			verificationStatus: "verified",
		});
		const fields = finished?.fields ?? {};
		expect(fields.agentSteps).toBeGreaterThan(0);
		expect(fields.toolCalls).toBeGreaterThan(0);
		expect(fields.costKnown).toBe(false);
		// Progress kinds add up: every reported state/note/tool entry is counted.
		expect(fields.progressCount).toBe(
			(fields.progressStateCount as number) +
				(fields.progressNoteCount as number) +
				(fields.progressToolCount as number),
		);
		expect(fields.progressStateCount).toBeGreaterThan(0);
	});

	it("logs the failure code with no verification for a failed run", () => {
		const completion: CompleteJobRequest = {
			outcome: "failed",
			leaseGeneration: 3,
			usage: RESEARCH_JOB.priorUsage,
			failureCode: "NO_EVIDENCE_COLLECTED",
			retryable: false,
		};
		expect(
			runFinishedFields(RESEARCH_JOB, completion, "failed", { state: 2, note: 1, tool: 0 }),
		).toMatchObject({
			runId: RUN_ID,
			state: "failed",
			attempt: 1,
			maxAttempts: 3,
			agentId: "scripted",
			providerModel: null,
			promptVersion: "research-v5",
			failureCode: "NO_EVIDENCE_COLLECTED",
			verificationStatus: null,
			progressCount: 3,
			progressStateCount: 2,
			progressNoteCount: 1,
			progressToolCount: 0,
		});
	});

	it("omits budget fields and nulls research-only facts for a news-ingest job", () => {
		const completion: CompleteJobRequest = {
			outcome: "ingested",
			leaseGeneration: 1,
			usage: RESEARCH_JOB.priorUsage,
			articles: [],
			sourceReports: [],
		};
		const fields = runFinishedFields(INGEST_JOB, completion, "completed", {
			state: 5,
			note: 0,
			tool: 0,
		});
		expect(fields).toMatchObject({
			runId: "run_ingest",
			agentId: null,
			providerModel: null,
			promptVersion: null,
			failureCode: null,
			verificationStatus: null,
			progressCount: 5,
		});
		expect("maxAgentSteps" in fields).toBe(false);
		expect("maxSpendUsd" in fields).toBe(false);
	});

	it("never carries prompts, question text, progress text or error messages", async () => {
		const { api } = createFakeApi();
		const harness = createDeps(api);
		const records: { event: string; fields?: LogFields }[] = [];
		await executeJob(RESEARCH_JOB, { ...harness.deps, logger: recordingLogger(records) }, never);
		const finished = records.find((entry) => entry.event === "job_finished");
		const line = JSON.stringify(finished?.fields ?? {});
		expect(line).not.toContain("Which storage products");
		expect(line).not.toContain("planning");
	});
});

describe("heartbeat logging can never reject unhandled (A1-2)", () => {
	it("a throwing heartbeat log still completes the job with no unhandled rejection", async () => {
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const { api, calls } = createFakeApi({ heartbeat: [apiFailure("SERVER_BUSY", true)] });
			const harness = createDeps(api, {
				onTurn: async (turnIndex) => {
					if (turnIndex === 0) await harness.tickHeartbeat();
				},
			});
			// The writer behind the logger is down for heartbeat lines only: every
			// other log call works, so the job itself must proceed to completion.
			const heartbeatDown: EventLogger = {
				info: (event, fields) => silentEventLogger.info(event, fields),
				warn: (event, fields) => {
					if (event === "heartbeat_failed") throw new Error("log writer down");
					silentEventLogger.warn(event, fields);
				},
				error: (event, fields) => silentEventLogger.error(event, fields),
				logFailures: () => 1,
			};
			await executeJob(RESEARCH_JOB, { ...harness.deps, logger: heartbeatDown }, never);
			// Let the detached heartbeat chain settle: an unhandled rejection
			// would be reported to the probe by now.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(rejections).toEqual([]);
			expect(calls.heartbeats).toEqual([3]);
			expect(calls.completions).toEqual([
				expect.objectContaining({ outcome: "completed", leaseGeneration: 3 }),
			]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
