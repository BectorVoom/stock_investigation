import {
	claimJobResponseSchema,
	completeJobResponseSchema,
	conversationResponseSchema,
	heartbeatResponseSchema,
	RUN_LIMITS,
	researchRunListResponseSchema,
	researchRunResponseSchema,
	runRecordsResponseSchema,
	workspaceViewSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	advanceToPublishing,
	apiError,
	body,
	bundleFor,
	CLAIM_BODY,
	claim,
	completeRun,
	completion,
	createHarness,
	createWorkspace,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	queueRun,
	researchRequest,
	stateEvents,
	TO_PUBLISHING,
	USAGE,
} from "./helpers.ts";

const LEASE_MS = 90_000;

async function runState(harness: ReturnType<typeof createHarness>, runId: string) {
	const response = await harness.call("GET", `/research-runs/${runId}`);
	return (await body(response, researchRunResponseSchema)).run;
}

describe("creating research runs (FR-014, FR-016)", () => {
	it("queues a run and stores the owner's question as a chat message", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);

		const run = await runState(harness, runId);
		expect(run.state).toBe("pending");
		expect(run.attempt).toBe(0);
		// Nothing has run yet: cost is "none", not a made-up figure.
		expect(run.cost).toEqual({ status: "none", totalCostUsd: 0, meteredPortionUsd: 0 });

		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages.map((message) => [message.role, message.text])).toEqual([
			["owner", "Which products will see demand growth?"],
		]);
	});

	it("replays the same run for a repeated idempotency key and rejects key reuse", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const key = idempotencyKey();
		const first = await harness.call("POST", "/research-runs", researchRequest(workspaceId), key);
		const second = await harness.call("POST", "/research-runs", researchRequest(workspaceId), key);
		const firstRun = (await body(first, researchRunResponseSchema)).run;
		const secondRun = (await body(second, researchRunResponseSchema)).run;
		expect(secondRun.runId).toBe(firstRun.runId);

		const runs = await body(
			await harness.call("GET", `/research-runs?workspaceId=${workspaceId}`),
			researchRunListResponseSchema,
		);
		expect(runs.runs).toHaveLength(1);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages).toHaveLength(1);

		const different = await harness.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId, { question: "A different question entirely" }),
			key,
		);
		expect(different.status).toBe(409);
		expect(await errorCode(different)).toBe("IDEMPOTENCY_KEY_REUSED");
	});

	it("requires an idempotency key", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const response = await harness.call("POST", "/research-runs", researchRequest(workspaceId));
		expect(response.status).toBe(400);
	});

	it("accepts a metered backend with or without an explicit spend ceiling", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const noConsent = await harness.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId, { agentId: "openrouter" }),
			idempotencyKey(),
		);
		expect(noConsent.status).toBe(202);

		const request = researchRequest(workspaceId, { agentId: "openrouter" });
		const withConsent = await harness.call(
			"POST",
			"/research-runs",
			{ ...request, budget: { ...request.budget, maxSpendUsd: 1.5 } },
			idempotencyKey(),
		);
		expect(withConsent.status).toBe(202);
	});

	it("accepts the Claude API backend without a spend ceiling once a runner reports it", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const request = researchRequest(workspaceId, { agentId: "claude-api" });
		const withSpend = { ...request, budget: { ...request.budget, maxSpendUsd: 2 } };
		const beforeReport = await harness.call("POST", "/research-runs", withSpend, idempotencyKey());
		expect(beforeReport.status).toBe(422);

		const token = await issueRunnerToken(harness);
		const reported = await harness.runner(token, "/jobs/claim", {
			...CLAIM_BODY,
			agents: [
				...CLAIM_BODY.agents,
				{
					agentId: "claude-api",
					displayName: "Claude API",
					capabilities: { supported: ["stream", "cancel"], model: "claude-opus-5-5" },
					costModel: "metered",
					toolIsolation: "enforced",
					availability: { status: "available" },
				},
			],
		});
		expect(reported.status).toBe(200);

		const noConsent = await harness.call("POST", "/research-runs", request, idempotencyKey());
		expect(noConsent.status).toBe(202);
		const accepted = await harness.call("POST", "/research-runs", withSpend, idempotencyKey());
		expect(accepted.status).toBe(202);
	});

	it("rejects an unregistered agent backend and an unknown workspace", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const unknownAgent = await harness.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId, { agentId: "made-up-agent" }),
			idempotencyKey(),
		);
		expect(await errorCode(unknownAgent)).toBe("UNKNOWN_AGENT");

		const unknownWorkspace = await harness.call(
			"POST",
			"/research-runs",
			researchRequest("ws_does_not_exist"),
			idempotencyKey(),
		);
		expect(unknownWorkspace.status).toBe(404);
	});

	it("rejects out-of-range budgets at the boundary", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const request = researchRequest(workspaceId);
		const response = await harness.call(
			"POST",
			"/research-runs",
			{ ...request, budget: { ...request.budget, maxToolCalls: 10_000 } },
			idempotencyKey(),
		);
		expect(response.status).toBe(400);
		expect((await apiError(response)).detail).toContain("budget.maxToolCalls");
	});

	it("caps the number of unfinished runs per owner", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		for (let index = 0; index < 5; index += 1) await queueRun(harness, workspaceId);
		const sixth = await harness.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId),
			idempotencyKey(),
		);
		expect(sixth.status).toBe(429);
	});
});

describe("leases (section 5.2, AGT-011)", () => {
	it("picks up a question within the one-second idle polling interval", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const idle = await body(
			await harness.runner(token, "/jobs/claim", CLAIM_BODY),
			claimJobResponseSchema,
		);
		expect(idle.job).toBeNull();
		expect(idle.pollAfterMs).toBeGreaterThan(0);
		expect(idle.pollAfterMs).toBeLessThanOrEqual(1_000);
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		harness.time.advance(idle.pollAfterMs);
		expect((await claim(harness, token))?.runId).toBe(runId);
	});

	it("grants one lease per job even when two runners race", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const tokenA = await issueRunnerToken(harness, "runner A");
		const tokenB = await issueRunnerToken(harness, "runner B");

		const [a, b] = await Promise.all([claim(harness, tokenA), claim(harness, tokenB)]);
		const winners = [a, b].filter((lease) => lease !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.runId).toBe(runId);
		expect(winners[0]?.leaseGeneration).toBe(1);
		expect((await runState(harness, runId)).attempt).toBe(1);
	});

	it("hands a research job a bounded slice of earlier conversation, and none to ingest", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);

		const firstId = await queueRun(harness, workspaceId);
		const first = await claim(harness, token);
		if (first === null || first.kind !== "research") throw new Error("expected a research lease");
		expect(first.runId).toBe(firstId);
		// The first question has no earlier conversation: nothing is sent.
		expect(first.conversationContext).toEqual([]);

		const secondId = await queueRun(harness, workspaceId);
		const second = await claim(harness, token);
		if (second === null || second.kind !== "research") throw new Error("expected a second lease");
		expect(second.runId).toBe(secondId);
		// The second job sees the first question but not its own.
		expect(second.conversationContext).toEqual([
			{ role: "owner", text: "Which products will see demand growth?" },
		]);
	});

	it("keeps the context anchored when ten later messages arrive after the question", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);

		await completeRun(harness, token, workspaceId);
		const secondId = await queueRun(harness, workspaceId);
		// Ten owner messages after the second question. Cancelled runs keep
		// their messages while freeing the unfinished cap, so ten fit. The
		// clock advances between enqueues so the claim order is deterministic.
		for (let round = 0; round < 2; round += 1) {
			const later: string[] = [];
			for (let index = 0; index < 4; index += 1) {
				harness.time.advance(1_000);
				later.push(await queueRun(harness, workspaceId));
			}
			for (const runId of later) await harness.call("POST", `/research-runs/${runId}/cancel`);
		}
		for (let index = 0; index < 2; index += 1) {
			harness.time.advance(1_000);
			await queueRun(harness, workspaceId);
		}

		const second = await claim(harness, token);
		if (second === null || second.kind !== "research") throw new Error("expected a lease");
		expect(second.runId).toBe(secondId);
		// The ten later messages cannot push the question out of the window:
		// the claim reads from before the run's own anchor.
		expect(second.conversationContext.map((message) => message.role)).toEqual([
			"owner",
			"assistant",
		]);
		expect(second.conversationContext[0]).toEqual({
			role: "owner",
			text: "Which products will see demand growth?",
		});
	});

	it("gives a retried run the same context as the original", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);

		await completeRun(harness, token, workspaceId);
		harness.time.advance(1_000);
		const originalId = await queueRun(harness, workspaceId);
		const original = await claim(harness, token);
		if (original === null || original.kind !== "research") throw new Error("expected a lease");
		expect(original.runId).toBe(originalId);
		await harness.runner(token, `/jobs/${originalId}/complete`, {
			outcome: "failed",
			leaseGeneration: original.leaseGeneration,
			usage: USAGE,
			failureCode: "PROVIDER_AUTH",
			retryable: false,
		});
		const retried = await body(
			await harness.call("POST", `/research-runs/${originalId}/retry`, undefined, idempotencyKey()),
			researchRunResponseSchema,
		);
		// A message after the failure must not change what the retry sees.
		harness.time.advance(1_000);
		await queueRun(harness, workspaceId);

		const redo = await claim(harness, token);
		if (redo === null || redo.kind !== "research") throw new Error("expected a retry lease");
		expect(redo.runId).toBe(retried.run.runId);
		// The retry has no owner message of its own; it inherits the anchor.
		expect(redo.conversationContext).toEqual(original.conversationContext);
		expect(redo.conversationContext.length).toBeGreaterThan(0);
	});

	it("keeps a queued run pending while no runner offers its backend", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const response = await harness.runner(token, "/jobs/claim", {
			runnerVersion: "test-1",
			agents: CLAIM_BODY.agents.map((agent) => ({
				...agent,
				availability: {
					status: "unavailable",
					reasonCode: "NOT_INSTALLED",
					detail: "binary not found",
				},
			})),
		});
		expect(response.status).toBe(200);
		expect((await runState(harness, runId)).state).toBe("pending");
	});

	it("extends the lease on heartbeat and records progress with legal transitions only", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");

		harness.time.advance(30_000);
		const heartbeat = await body(
			await harness.runner(token, `/jobs/${runId}/heartbeat`, {
				leaseGeneration: lease.leaseGeneration,
			}),
			heartbeatResponseSchema,
		);
		expect(Date.parse(heartbeat.leaseExpiresAt)).toBe(harness.time.clock.nowMs() + LEASE_MS);
		expect(heartbeat.cancelRequested).toBe(false);

		// claimed -> analyzing skips planning and collecting.
		const illegal = await harness.runner(
			token,
			`/jobs/${runId}/events`,
			stateEvents(harness, lease, ["analyzing"]),
		);
		expect(illegal.status).toBe(409);
		expect(await errorCode(illegal)).toBe("ILLEGAL_TRANSITION");
		expect((await runState(harness, runId)).state).toBe("claimed");

		await advanceToPublishing(harness, token, lease);
		const run = await runState(harness, runId);
		expect(run.state).toBe("publishing");
		expect(run.progress.map((entry) => entry.text)).toEqual(TO_PUBLISHING);
	});

	it("ignores a replayed events request instead of replaying its transitions", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const events = stateEvents(harness, lease, ["planning", "collecting"]);
		expect((await harness.runner(token, `/jobs/${runId}/events`, events)).status).toBe(200);
		expect((await harness.runner(token, `/jobs/${runId}/events`, events)).status).toBe(200);
		const run = await runState(harness, runId);
		expect(run.state).toBe("collecting");
		expect(run.progress).toHaveLength(2);
	});

	it("returns an expired job to the queue and fences out the runner that lost it", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const tokenA = await issueRunnerToken(harness, "runner A");
		const tokenB = await issueRunnerToken(harness, "runner B");
		const first = await claim(harness, tokenA);
		if (first === null) throw new Error("expected a lease");
		await harness.runner(
			tokenA,
			`/jobs/${runId}/events`,
			stateEvents(harness, first, ["planning"]),
		);

		// Runner A dies: no heartbeat until the lease has lapsed.
		harness.time.advance(LEASE_MS + 1);
		const second = await claim(harness, tokenB);
		expect(second?.runId).toBe(runId);
		expect(second?.leaseGeneration).toBe(2);
		expect(second?.attempt).toBe(2);
		if (second === null) throw new Error("expected a second lease");

		// Runner A comes back with its stale generation: every write is refused.
		const staleHeartbeat = await harness.runner(tokenA, `/jobs/${runId}/heartbeat`, {
			leaseGeneration: first.leaseGeneration,
		});
		const staleEvents = await harness.runner(
			tokenA,
			`/jobs/${runId}/events`,
			stateEvents(harness, first, ["collecting"], 10),
		);
		const staleCompletion = await harness.runner(
			tokenA,
			`/jobs/${runId}/complete`,
			completion(first, bundleFor(runId)),
		);
		for (const response of [staleHeartbeat, staleEvents, staleCompletion]) {
			expect(response.status).toBe(409);
			expect(await errorCode(response)).toBe("STALE_LEASE");
		}
		// Nor can runner A use the new generation number with its own credential.
		const impersonation = await harness.runner(tokenA, `/jobs/${runId}/heartbeat`, {
			leaseGeneration: second.leaseGeneration,
		});
		expect(await errorCode(impersonation)).toBe("STALE_LEASE");

		// The stale completion left nothing behind.
		const records = await body(
			await harness.call("GET", `/research-runs/${runId}/records`),
			runRecordsResponseSchema,
		);
		expect(records.evidence).toHaveLength(0);
		expect((await runState(harness, runId)).state).toBe("claimed");
	});

	it("fails a job once the retry ceiling is reached", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const lease = await claim(harness, token);
			expect(lease?.attempt).toBe(attempt);
			harness.time.advance(LEASE_MS + 1);
		}
		expect(await claim(harness, token)).toBeNull();
		const run = await runState(harness, runId);
		expect(run.state).toBe("failed");
		expect(run.failureCode).toBe("RETRY_CEILING_REACHED");
	});

	it("re-queues a retryable failure and gives up on a non-retryable one", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);

		const retryable = await queueRun(harness, workspaceId);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const failed = await harness.runner(token, `/jobs/${retryable}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "PROVIDER_RATE_LIMITED",
			retryable: true,
		});
		expect((await body(failed, completeJobResponseSchema)).state).toBe("pending");

		const again = await claim(harness, token);
		if (again === null) throw new Error("expected the job to be claimable again");
		const fatal = await harness.runner(token, `/jobs/${retryable}/complete`, {
			outcome: "failed",
			leaseGeneration: again.leaseGeneration,
			usage: USAGE,
			failureCode: "PROVIDER_AUTH",
			retryable: false,
		});
		expect((await body(fatal, completeJobResponseSchema)).state).toBe("failed");
		expect((await runState(harness, retryable)).failureCode).toBe("PROVIDER_AUTH");
	});

	it("stores the tool error alongside ALL_TOOL_CALLS_FAILED", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const failed = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TIMEOUT",
			retryable: false,
		});
		expect(failed.status).toBe(200);
		const run = await runState(harness, runId);
		expect(run.state).toBe("failed");
		expect(run.failureCode).toBe("ALL_TOOL_CALLS_FAILED");
		expect(run.failureDetail).toBe("TIMEOUT");
	});

	it("refuses page-derived text as a failure detail (finding 10, task 23b, ADR-0025)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const hostile = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "Click here to read more",
			retryable: false,
		});
		expect(hostile.status).toBe(400);
		const hostileEvidence = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "NO_EVIDENCE_COLLECTED",
			failureDetail: "Click here to read more",
			retryable: false,
		});
		expect(hostileEvidence.status).toBe(400);
		const tied = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "PROVIDER_RATE_LIMITED",
			failureDetail: "TIMEOUT",
			retryable: false,
		});
		expect(tied.status).toBe(400);
	});

	it("stores why nothing was collected alongside NO_EVIDENCE_COLLECTED (ADR-0025)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const failed = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "NO_EVIDENCE_COLLECTED",
			failureDetail: "NO_TOOL_REQUESTED",
			retryable: false,
		});
		expect(failed.status).toBe(200);
		const run = await runState(harness, runId);
		expect(run.state).toBe("failed");
		expect(run.failureCode).toBe("NO_EVIDENCE_COLLECTED");
		expect(run.failureDetail).toBe("NO_TOOL_REQUESTED");
	});

	it("clears failure metadata when a new attempt is claimed (finding 11, task 23b)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const first = await claim(harness, token);
		if (first === null) throw new Error("expected a lease");
		const failed = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: first.leaseGeneration,
			usage: USAGE,
			failureCode: "PROVIDER_RATE_LIMITED",
			retryable: true,
		});
		expect((await body(failed, completeJobResponseSchema)).state).toBe("pending");
		expect((await runState(harness, runId)).failureCode).toBe("PROVIDER_RATE_LIMITED");
		const second = await claim(harness, token);
		if (second === null) throw new Error("expected the job to be claimable again");
		const claimed = await runState(harness, runId);
		expect(claimed.state).toBe("claimed");
		expect(claimed.failureCode).toBeNull();
		expect(claimed.failureDetail).toBeNull();
	});

	it("fail-then-succeed shows no stale TIMEOUT detail (finding 11, task 23b)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const first = await claim(harness, token);
		if (first === null) throw new Error("expected a lease");
		const failed = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: first.leaseGeneration,
			usage: USAGE,
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TIMEOUT",
			retryable: true,
		});
		expect((await body(failed, completeJobResponseSchema)).state).toBe("pending");
		const second = await claim(harness, token);
		if (second === null) throw new Error("expected the job to be claimable again");
		await advanceToPublishing(harness, token, second);
		const completed = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(second, bundleFor(runId)),
		);
		expect((await body(completed, completeJobResponseSchema)).state).toBe("completed");
		const run = await runState(harness, runId);
		expect(run.state).toBe("completed");
		expect(run.failureCode).toBeNull();
		expect(run.failureDetail).toBeNull();
	});

	it("fail-then-partial keeps only the partial code, not the old detail (finding 11)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const first = await claim(harness, token);
		if (first === null) throw new Error("expected a lease");
		const failed = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: first.leaseGeneration,
			usage: USAGE,
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TIMEOUT",
			retryable: true,
		});
		expect((await body(failed, completeJobResponseSchema)).state).toBe("pending");
		const second = await claim(harness, token);
		if (second === null) throw new Error("expected the job to be claimable again");
		await advanceToPublishing(harness, token, second);
		const partial = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "partial",
			leaseGeneration: second.leaseGeneration,
			usage: USAGE,
			failureCode: "MAX_WALL_CLOCK",
			bundle: bundleFor(runId),
			articles: [],
			sourceReports: [],
		});
		expect((await body(partial, completeJobResponseSchema)).state).toBe("partial");
		const run = await runState(harness, runId);
		expect(run.state).toBe("partial");
		expect(run.failureCode).toBe("MAX_WALL_CLOCK");
		expect(run.failureDetail).toBeNull();
	});

	it("fail-then-cancel shows no stale failure metadata (finding 11, task 23b)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const first = await claim(harness, token);
		if (first === null) throw new Error("expected a lease");
		const failed = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: first.leaseGeneration,
			usage: USAGE,
			failureCode: "ALL_TOOL_CALLS_FAILED",
			failureDetail: "TIMEOUT",
			retryable: true,
		});
		expect((await body(failed, completeJobResponseSchema)).state).toBe("pending");
		const second = await claim(harness, token);
		if (second === null) throw new Error("expected the job to be claimable again");
		const cancelled = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "cancelled",
			leaseGeneration: second.leaseGeneration,
			usage: USAGE,
		});
		expect((await body(cancelled, completeJobResponseSchema)).state).toBe("cancelled");
		const run = await runState(harness, runId);
		expect(run.state).toBe("cancelled");
		expect(run.failureCode).toBeNull();
		expect(run.failureDetail).toBeNull();
	});
});

describe("an external service's status on a run (docs/rule/error_handling.md §4a)", () => {
	async function failOnce(
		harness: ReturnType<typeof createHarness>,
		token: string,
		runId: string,
		failure: { readonly retryable: boolean; readonly failureUpstreamStatus?: number },
	) {
		const lease = await claim(harness, token);
		if (lease === null || lease.runId !== runId) throw new Error("expected to claim the run");
		const response = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "PROVIDER_UNAVAILABLE",
			...failure,
		});
		return (await body(response, completeJobResponseSchema)).state;
	}

	it("stores a failed completion's failureUpstreamStatus unchanged and shows it on the run", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const overloaded = await queueRun(harness, workspaceId);
		expect((await runState(harness, overloaded)).failureUpstreamStatus).toBeNull();
		expect(
			await failOnce(harness, token, overloaded, { retryable: false, failureUpstreamStatus: 529 }),
		).toBe("failed");
		const run = await runState(harness, overloaded);
		expect(run).toMatchObject({
			state: "failed",
			failureCode: "PROVIDER_UNAVAILABLE",
			failureUpstreamStatus: 529,
		});
		const listed = await body(
			await harness.call("GET", `/research-runs?workspaceId=${workspaceId}`),
			researchRunListResponseSchema,
		);
		expect(listed.runs.find((entry) => entry.runId === overloaded)?.failureUpstreamStatus).toBe(
			529,
		);

		// An owner retry is a new run: it starts with no failure at all.
		const retried = await body(
			await harness.call("POST", `/research-runs/${overloaded}/retry`, undefined, idempotencyKey()),
			researchRunResponseSchema,
		);
		expect(retried.run.failureUpstreamStatus).toBeNull();
		await harness.call("POST", `/research-runs/${retried.run.runId}/cancel`);

		// A runner that sends no status (built before the field) stores null.
		const noStatus = await queueRun(harness, workspaceId);
		expect(await failOnce(harness, token, noStatus, { retryable: false })).toBe("failed");
		expect(await runState(harness, noStatus)).toMatchObject({
			failureCode: "PROVIDER_UNAVAILABLE",
			failureUpstreamStatus: null,
		});
	});

	it("clears the status with the code when the next attempt is claimed, and the API's own failures carry none", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const runId = await queueRun(harness, workspaceId);
		expect(
			await failOnce(harness, token, runId, { retryable: true, failureUpstreamStatus: 503 }),
		).toBe("pending");
		expect((await runState(harness, runId)).failureUpstreamStatus).toBe(503);

		// The second attempt clears the previous attempt's code and status.
		const second = await claim(harness, token);
		expect(second?.runId).toBe(runId);
		expect(await runState(harness, runId)).toMatchObject({
			state: "claimed",
			failureCode: null,
			failureUpstreamStatus: null,
		});

		// The leases then lapse until the ceiling: a failure the API decided.
		harness.time.advance(LEASE_MS + 1);
		expect((await claim(harness, token))?.runId).toBe(runId);
		harness.time.advance(LEASE_MS + 1);
		expect(await claim(harness, token)).toBeNull();
		expect(await runState(harness, runId)).toMatchObject({
			state: "failed",
			failureCode: "RETRY_CEILING_REACHED",
			failureUpstreamStatus: null,
		});
	});

	it("stores a partial completion's failureUpstreamStatus, and a completed run carries none", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const runId = await queueRun(harness, workspaceId);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);
		const partial = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "partial",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "PROVIDER_RATE_LIMITED",
			failureUpstreamStatus: 429,
			bundle: bundleFor(runId),
			articles: [],
			sourceReports: [],
		});
		expect((await body(partial, completeJobResponseSchema)).state).toBe("partial");
		expect(await runState(harness, runId)).toMatchObject({
			state: "partial",
			failureCode: "PROVIDER_RATE_LIMITED",
			failureUpstreamStatus: 429,
		});

		const done = await completeRun(harness, token, workspaceId);
		expect((await runState(harness, done.runId)).failureUpstreamStatus).toBeNull();
	});
});

describe("cancel, retry, approval (FR-014)", () => {
	it("cancels a pending run immediately", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const cancelled = await body(
			await harness.call("POST", `/research-runs/${runId}/cancel`),
			researchRunResponseSchema,
		);
		expect(cancelled.run.state).toBe("cancelled");
		const token = await issueRunnerToken(harness);
		expect(await claim(harness, token)).toBeNull();
	});

	it("signals a running job through its heartbeat and discards a result that arrives afterwards", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);

		const requested = await body(
			await harness.call("POST", `/research-runs/${runId}/cancel`),
			researchRunResponseSchema,
		);
		expect(requested.run.state).toBe("publishing");
		expect(requested.run.cancelRequested).toBe(true);

		const heartbeat = await body(
			await harness.runner(token, `/jobs/${runId}/heartbeat`, {
				leaseGeneration: lease.leaseGeneration,
			}),
			heartbeatResponseSchema,
		);
		expect(heartbeat.cancelRequested).toBe(true);

		// The runner finishes anyway; the owner's cancellation wins and nothing is published.
		const late = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(lease, bundleFor(runId)),
		);
		expect((await body(late, completeJobResponseSchema)).state).toBe("cancelled");
		const view = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		expect(view.state.components).toHaveLength(0);
	});

	it("cancels a job whose runner vanished, once its lease has lapsed", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		await claim(harness, token);
		await harness.call("POST", `/research-runs/${runId}/cancel`);
		harness.time.advance(LEASE_MS + 1);
		expect(await claim(harness, token)).toBeNull();
		expect((await runState(harness, runId)).state).toBe("cancelled");
	});

	it("retries a failed run as a new run and refuses to retry a completed one", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const runId = await queueRun(harness, workspaceId);
		await harness.call("POST", `/research-runs/${runId}/cancel`);

		const retried = await body(
			await harness.call("POST", `/research-runs/${runId}/retry`, undefined, idempotencyKey()),
			researchRunResponseSchema,
		);
		expect(retried.run.runId).not.toBe(runId);
		expect(retried.run.retryOfRunId).toBe(runId);
		expect(retried.run.state).toBe("pending");
		await harness.call("POST", `/research-runs/${retried.run.runId}/cancel`);

		const done = await completeRun(harness, token, workspaceId);
		const refused = await harness.call(
			"POST",
			`/research-runs/${done.runId}/retry`,
			undefined,
			idempotencyKey(),
		);
		expect(refused.status).toBe(409);
		expect(await errorCode(refused)).toBe("ILLEGAL_TRANSITION");
	});

	describe("a retry runs on the agent choice saved now", () => {
		const BUDGET = researchRequest("ws_x").budget;

		async function queueAndCancel(
			harness: ReturnType<typeof createHarness>,
			workspaceId: string,
			overrides: Parameters<typeof researchRequest>[1] = {},
		): Promise<string> {
			const queued = await body(
				await harness.call(
					"POST",
					"/research-runs",
					researchRequest(workspaceId, overrides),
					idempotencyKey(),
				),
				researchRunResponseSchema,
			);
			await harness.call("POST", `/research-runs/${queued.run.runId}/cancel`);
			return queued.run.runId;
		}

		const retry = (harness: ReturnType<typeof createHarness>, runId: string) =>
			harness.call("POST", `/research-runs/${runId}/retry`, undefined, idempotencyKey());

		it("switches backend, model, effort and web access to the saved settings, keeping the question", async () => {
			const harness = createHarness();
			const workspaceId = await createWorkspace(harness);
			const runId = await queueAndCancel(harness, workspaceId);
			await harness.call("PUT", "/settings/agent", {
				defaultAgentId: "opencode",
				models: { opencode: "opencode/nemotron-3.5-lightning-free" },
				effort: "high",
				budget: { ...BUDGET, maxSpendUsd: 2 },
				webAccess: "public-web",
			});

			const retried = await body(await retry(harness, runId), researchRunResponseSchema);

			const original = researchRequest(workspaceId);
			expect(retried.run.request).toEqual({
				...original,
				agentId: "opencode",
				model: "opencode/nemotron-3.5-lightning-free",
				effort: "high",
				webAccess: "public-web",
				// The fixed limits (ADR-0029); a plan-limited backend never carries a spend allowance.
				budget: { ...RUN_LIMITS, maxSpendUsd: null },
			});
		});

		it("replays the original request when nothing is saved", async () => {
			const harness = createHarness();
			const workspaceId = await createWorkspace(harness);
			const runId = await queueAndCancel(harness, workspaceId);

			const retried = await body(await retry(harness, runId), researchRunResponseSchema);

			expect(retried.run.request).toEqual(researchRequest(workspaceId));
		});

		it("refuses a saved backend that needs a model but has none", async () => {
			const harness = createHarness();
			const workspaceId = await createWorkspace(harness);
			const runId = await queueAndCancel(harness, workspaceId);
			await harness.call("PUT", "/settings/agent", {
				defaultAgentId: "opencode",
				models: {},
				effort: "medium",
				budget: BUDGET,
				webAccess: "off",
			});

			const refused = await retry(harness, runId);

			expect(await errorCode(refused)).toBe("VALIDATION_FAILED");
		});

		it("retries with the currently selected metered backend without renewed consent", async () => {
			const harness = createHarness();
			const workspaceId = await createWorkspace(harness);
			const runId = await queueAndCancel(harness, workspaceId);
			await harness.call("PUT", "/settings/agent", {
				defaultAgentId: "openrouter",
				models: { openrouter: "example/model" },
				effort: "medium",
				budget: { ...BUDGET, maxSpendUsd: null },
				webAccess: "off",
			});

			const accepted = await retry(harness, runId);

			expect(accepted.status).toBe(202);
		});

		it("retries a metered run whose backend, model and spend are unchanged, under the fixed limits", async () => {
			const harness = createHarness();
			const workspaceId = await createWorkspace(harness);
			const budget = { ...BUDGET, maxSpendUsd: 1.5 };
			const runId = await queueAndCancel(harness, workspaceId, {
				agentId: "openrouter",
				model: "example/model",
				budget,
			});
			await harness.call("PUT", "/settings/agent", {
				defaultAgentId: "openrouter",
				models: { openrouter: "example/model" },
				effort: "high",
				budget,
				webAccess: "off",
			});

			const retried = await body(await retry(harness, runId), researchRunResponseSchema);

			expect(retried.run.request?.agentId).toBe("openrouter");
			expect(retried.run.request?.effort).toBe("high");
			// The older run's limits differed; only the spend carries the consent (ADR-0029).
			expect(retried.run.request?.budget).toEqual({ ...RUN_LIMITS, maxSpendUsd: 1.5 });
		});
	});

	it("parks a run for owner approval and resumes it under the approved budget", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await harness.runner(token, `/jobs/${runId}/events`, stateEvents(harness, lease, ["planning"]));
		const parked = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "waiting_approval",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			approvalRequest: { reasonCode: "SPEND_LIMIT_REACHED", detail: "limit reached" },
		});
		expect((await body(parked, completeJobResponseSchema)).state).toBe("waiting_approval");
		expect(await claim(harness, token)).toBeNull();

		const budget = { ...researchRequest(workspaceId).budget, maxToolCalls: 40 };
		const approved = await body(
			await harness.call("POST", `/research-runs/${runId}/approve`, { budget }),
			researchRunResponseSchema,
		);
		expect(approved.run.state).toBe("pending");
		expect(approved.run.request?.budget.maxToolCalls).toBe(40);
		expect(approved.run.approvalRequest).toBeNull();
		expect((await claim(harness, token))?.runId).toBe(runId);
	});
});

describe("completion (hard gates 4, 6, 8)", () => {
	it("stores the bundle, updates the workspace and posts a cited answer, atomically", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const { runId } = await completeRun(harness, token, workspaceId);

		const run = await runState(harness, runId);
		expect(run.state).toBe("completed");
		expect(run.verificationStatus).toBe("partially-verified");
		// The runner reported unmetered (subscription) usage: cost is unknown, never $0.
		expect(run.cost).toEqual({
			status: "unknown-plan-limited",
			totalCostUsd: null,
			meteredPortionUsd: 0,
		});

		const view = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		expect(view.state.version).toBe(2);
		expect(view.state.components.map((component) => component.componentType)).toEqual([
			"data-table",
			"source-list",
		]);
		expect(view.datasets.map((dataset) => dataset.datasetId)).toEqual([`${runId}_ds_scenarios`]);
		expect(view.sources.map((source) => source.evidenceId)).toEqual([`${runId}_ev1`]);

		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		const answer = conversation.messages.at(-1);
		expect(answer?.role).toBe("assistant");
		expect(answer?.claimIds).toEqual([`${runId}_cl1`]);
		expect(conversation.claims[0]?.links[0]?.evidenceId).toBe(`${runId}_ev1`);
		expect(conversation.evidence[0]?.sourceUrl).toBe(
			"https://news.example.org/articles/grid-storage",
		);

		const records = await body(
			await harness.call("GET", `/research-runs/${runId}/records`),
			runRecordsResponseSchema,
		);
		expect(records.scenarios[0]?.derivedCagr).toEqual({ bear: 0.1, base: 0.2, bull: 0.3 });
		expect(records.supplierLinks[0]?.evidenceIds).toEqual([`${runId}_ev1`]);
		expect(records.financialObservations[0]).toMatchObject({
			value: null,
			unavailableReason: "no licensed price source configured",
		});
	});

	it("treats a duplicate completion as a replay and does not duplicate anything", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const { runId, lease } = await completeRun(harness, token, workspaceId);

		const replay = await body(
			await harness.runner(token, `/jobs/${runId}/complete`, completion(lease, bundleFor(runId))),
			completeJobResponseSchema,
		);
		expect(replay).toEqual({ state: "completed", replayed: true, newArticleCount: 0 });

		const view = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		expect(view.state.version).toBe(2);
		expect(view.state.components).toHaveLength(2);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		const records = await body(
			await harness.call("GET", `/research-runs/${runId}/records`),
			runRecordsResponseSchema,
		);
		expect(records.evidence).toHaveLength(1);
		expect(records.claims).toHaveLength(1);
	});

	it("refuses to complete a run that has not reached publishing", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const response = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(lease, bundleFor(runId)),
		);
		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe("ILLEGAL_TRANSITION");
	});

	it.each([
		{
			name: "a claim citing evidence the bundle does not contain (fabricated citation)",
			mutate: (runId: string) => {
				const bundle = bundleFor(runId);
				return bundleFor(runId, {
					claims: bundle.claims.map((claim) => ({
						...claim,
						links: [
							{ evidenceId: `${runId}_ev_missing`, relation: "supports" as const, quote: "x" },
						],
					})),
				});
			},
			expected: "UNKNOWN_EVIDENCE",
		},
		{
			name: "a growth rate that is not the derivation of the scenario's own numbers",
			mutate: (runId: string) => {
				const bundle = bundleFor(runId);
				return bundleFor(runId, {
					scenarios: bundle.scenarios.map((scenario) => ({
						...scenario,
						derivedCagr: { bear: 0.1, base: 0.45, bull: 0.3 },
					})),
				});
			},
			expected: "CAGR_NOT_DERIVED",
		},
		{
			name: "a record id outside the run's own namespace",
			mutate: (runId: string) => {
				const bundle = bundleFor(runId);
				return bundleFor(runId, {
					evidence: bundle.evidence.map((item) => ({ ...item, evidenceId: "run_other_ev1" })),
				});
			},
			expected: "ID_NOT_RUN_SCOPED",
		},
		{
			name: "a 'supported' claim with no supporting link",
			mutate: (runId: string) => {
				const bundle = bundleFor(runId);
				return bundleFor(runId, {
					claims: bundle.claims.map((claim) => ({ ...claim, links: [] })),
				});
			},
			expected: "CLAIM_STATUS_INCONSISTENT",
		},
		{
			name: "a 'verified' status while a claim is unsupported",
			mutate: (runId: string) => {
				const bundle = bundleFor(runId);
				return bundleFor(runId, {
					verificationStatus: "verified",
					claims: bundle.claims.map((claim) => ({ ...claim, status: "unsupported" as const })),
				});
			},
			expected: "VERIFICATION_STATUS_INCONSISTENT",
		},
	])("rejects a bundle with $name", async ({ mutate, expected }) => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);

		const response = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(lease, mutate(runId)),
		);
		expect(response.status).toBe(422);
		const error = await apiError(response);
		expect(error.code).toBe("INTEGRITY_VIOLATION");
		expect(error.detail).toContain(expected);
		// Nothing was stored and the run is still open for a corrected submission.
		expect((await runState(harness, runId)).state).toBe("publishing");
		const records = await body(
			await harness.call("GET", `/research-runs/${runId}/records`),
			runRecordsResponseSchema,
		);
		expect(records.evidence).toHaveLength(0);
	});

	it("drops invalid display instructions but keeps the verified findings and valid ones", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);

		const valid = bundleFor(runId).uiOperations;
		const bundle = bundleFor(runId, {
			uiOperations: [
				{
					operation: "component.create",
					componentId: "evil",
					componentType: "raw-html",
					schemaVersion: 1,
					props: { html: "<script>alert(1)</script>" },
				},
				{
					operation: "component.create",
					componentId: "badprops",
					componentType: "data-table",
					schemaVersion: 1,
					props: {
						title: "x",
						datasetRef: `${runId}_ds_scenarios`,
						sourceIds: [],
						onclick: "alert(1)",
					},
				},
				{
					operation: "component.create",
					componentId: "foreign",
					componentType: "data-table",
					schemaVersion: 1,
					props: { title: "x", datasetRef: "someone_elses_dataset", sourceIds: [] },
				},
				{
					operation: "component.create",
					componentId: "future",
					componentType: "data-table",
					schemaVersion: 7,
					props: { title: "x", datasetRef: `${runId}_ds_scenarios`, sourceIds: [] },
				},
				...valid,
			],
		});
		const response = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(lease, bundle),
		);
		expect(response.status).toBe(200);

		const view = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		expect(view.state.components.map((component) => component.componentId)).toEqual([
			`${runId}_table`,
			`${runId}_sources`,
		]);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		const answer = conversation.messages.at(-1)?.text ?? "";
		expect(answer).toContain("4 display instruction(s) were rejected");
		expect(answer).toContain("UNKNOWN_COMPONENT_TYPE");
		expect(answer).toContain("INVALID_PROPS");
		expect(answer).toContain("UNKNOWN_DATASET");
		expect(answer).toContain("UNSUPPORTED_SCHEMA_VERSION");
	});
});

describe("completion racing an owner edit (hard gate 8, UI-006)", () => {
	it("keeps both the owner's command and the run's results, at consistent versions", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		// Seed one finished run so the owner has a component to act on.
		const first = await completeRun(harness, token, workspaceId);

		const runId = await queueRun(harness, workspaceId);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);

		// Both requests are computed against workspace version 2 and submitted together.
		const [completed, edited] = await Promise.all([
			harness.runner(token, `/jobs/${runId}/complete`, completion(lease, bundleFor(runId))),
			harness.call("POST", `/workspaces/${workspaceId}/commands`, {
				protocolVersion: 1,
				commandId: `race_${crypto.randomUUID().slice(0, 8)}`,
				workspaceId,
				expectedWorkspaceVersion: 2,
				operation: "component.focus",
				componentId: `${first.runId}_table`,
			}),
		]);
		// The completion always lands (it recomputes on conflict); the owner edit either
		// lands or is told to refetch — it is never silently overwritten.
		expect(completed.status).toBe(200);
		expect([200, 409]).toContain(edited.status);

		const view = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		const ownerApplied = edited.status === 200;
		expect(view.state.version).toBe(ownerApplied ? 5 : 4);
		expect(view.state.focusedComponentId).toBe(ownerApplied ? `${first.runId}_table` : null);
		expect(view.state.components.map((component) => component.componentId)).toEqual([
			`${first.runId}_table`,
			`${first.runId}_sources`,
			`${runId}_table`,
			`${runId}_sources`,
		]);
		// The command log has one entry per version: no gaps and no duplicates.
		const events = await harness.call("GET", `/workspaces/${workspaceId}/events`);
		const versions = z
			.object({ events: z.array(z.object({ version: z.number() })) })
			.parse(await events.json())
			.events.map((event) => event.version);
		expect(versions).toEqual(Array.from({ length: view.state.version }, (_, index) => index + 1));
		expect((await runState(harness, runId)).state).toBe("completed");
	});

	it("serves the run list with a validator that changes when a run changes", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const path = `/research-runs?workspaceId=${workspaceId}`;
		const etag = (await harness.call("GET", path)).headers.get("ETag") ?? "";
		expect(etag).not.toBe("");
		expect((await harness.raw("GET", path, { headers: { "If-None-Match": etag } })).status).toBe(
			304,
		);
		await harness.call("POST", `/research-runs/${runId}/cancel`);
		expect((await harness.raw("GET", path, { headers: { "If-None-Match": etag } })).status).toBe(
			200,
		);
	});
});

describe("a run cannot publish a report that misstates its own claims (AGT-013)", () => {
	it("drops a report operation whose badge disagrees with the bundle's claim, keeping the rest", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);

		const base = bundleFor(runId);
		const statement = (status: string, claimId: string) => ({
			operation: "component.create" as const,
			componentId: `${runId}_report_${status}`,
			componentType: "research-report",
			schemaVersion: 1,
			props: {
				title: "Report",
				generatedAt: "2026-10-11T00:00:00.000Z",
				dataCutoffAt: "2026-10-11T00:00:00.000Z",
				sections: [
					{
						heading: "Findings",
						statements: [{ text: "x", claimId, claimType: "observation", status, sourceIds: [] }],
					},
				],
				disclaimer: "Not investment advice.",
			},
		});
		const bundle = bundleFor(runId, {
			// The bundle's only claim is unsupported...
			claims: base.claims.map((entry) => ({ ...entry, status: "unsupported" as const })),
			verificationStatus: "unverified",
			uiOperations: [
				// ...so a report calling it supported is refused,
				statement("supported", `${runId}_cl1`),
				// one inventing a claim is refused,
				statement("conflicting", `${runId}_cl_invented`),
				// and an honest one is applied.
				statement("unsupported", `${runId}_cl1`),
			],
		});
		const response = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(lease, bundle),
		);
		expect(response.status).toBe(200);

		const view = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		expect(view.state.components.map((component) => component.componentId)).toEqual([
			`${runId}_report_unsupported`,
		]);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		const answer = conversation.messages.at(-1)?.text ?? "";
		expect(answer).toContain("CLAIM_MISMATCH");
		expect(answer).toContain("UNKNOWN_CLAIM");
	});
});

describe("budgets span attempts and approval can come from any spending stage (AGT-008)", () => {
	it("hands the next attempt the usage already recorded for the run", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const first = await claim(harness, token);
		if (first === null || first.kind !== "research") throw new Error("expected a research lease");
		expect(first.priorUsage).toMatchObject({ agentSteps: 0, toolCalls: 0 });

		const spent = {
			...USAGE,
			agentSteps: 4,
			toolCalls: 7,
			knownCostUsd: 0.4,
			hasUnmeteredUsage: false,
		};
		await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: first.leaseGeneration,
			usage: spent,
			failureCode: "PROVIDER_RATE_LIMITED",
			retryable: true,
		});

		const second = await claim(harness, token);
		if (second === null || second.kind !== "research") throw new Error("expected a second lease");
		expect(second.attempt).toBe(2);
		// The retry starts from what the first attempt consumed, so ceilings apply to the run.
		expect(second.priorUsage).toEqual(spent);
		expect((await runState(harness, runId)).usage).toEqual(spent);
	});

	it.each(["analyzing", "verifying"])("lets a run pause for approval from %s", async (stage) => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const upTo = TO_PUBLISHING.slice(0, TO_PUBLISHING.indexOf(stage) + 1);
		await harness.runner(token, `/jobs/${runId}/events`, stateEvents(harness, lease, upTo));
		const parked = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "waiting_approval",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			approvalRequest: { reasonCode: "SPEND_LIMIT_REACHED", detail: "limit reached" },
		});
		expect(parked.status).toBe(200);
		expect((await body(parked, completeJobResponseSchema)).state).toBe("waiting_approval");
	});

	it("does not let a run pause for approval from publishing, where nothing is spent", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);
		const parked = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "waiting_approval",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			approvalRequest: { reasonCode: "SPEND_LIMIT_REACHED", detail: "limit reached" },
		});
		expect(parked.status).toBe(409);
		expect(await errorCode(parked)).toBe("ILLEGAL_TRANSITION");
	});
});

describe("lease hand-back on runner shutdown (ADR-0036)", () => {
	const releaseResponseSchema = z.object({ state: z.enum(["pending", "cancelled"]) });

	it("returns the job to the queue at once with the claim refunded, its usage kept and the old proof fenced", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const first = await claim(harness, token);
		if (first === null) throw new Error("expected a lease");
		await harness.runner(token, `/jobs/${runId}/events`, stateEvents(harness, first, ["planning"]));

		const released = await harness.runner(token, `/jobs/${runId}/release`, {
			leaseGeneration: first.leaseGeneration,
			usage: USAGE,
		});
		expect(released.status).toBe(200);
		expect(await body(released, releaseResponseSchema)).toEqual({ state: "pending" });
		const run = await runState(harness, runId);
		expect(run.state).toBe("pending");
		expect(run.attempt).toBe(0);
		// The attempt's spend stays on the run (AGT-008).
		expect(run.usage).toMatchObject({ agentSteps: 3, toolCalls: 2, inputBytes: 1200 });

		// No lease expiry to wait for: the next claim takes it, as a fresh first attempt.
		const second = await claim(harness, token);
		expect(second?.runId).toBe(runId);
		expect(second?.attempt).toBe(1);
		expect(second?.leaseGeneration).toBe(first.leaseGeneration + 1);
		if (second?.kind !== "research") throw new Error("expected a research lease");
		expect(second.priorUsage).toMatchObject({ agentSteps: 3, toolCalls: 2 });

		// The released proof can never act again.
		for (const path of ["release", "heartbeat"]) {
			const stale = await harness.runner(token, `/jobs/${runId}/${path}`, {
				leaseGeneration: first.leaseGeneration,
				...(path === "release" ? { usage: USAGE } : {}),
			});
			expect(stale.status, path).toBe(409);
			expect(await errorCode(stale), path).toBe("STALE_LEASE");
		}
	});

	it("is refused for another runner, and once nobody holds the lease", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const tokenA = await issueRunnerToken(harness, "runner A");
		const tokenB = await issueRunnerToken(harness, "runner B");
		const lease = await claim(harness, tokenA);
		if (lease === null) throw new Error("expected a lease");
		const request = { leaseGeneration: lease.leaseGeneration, usage: USAGE };

		const impersonation = await harness.runner(tokenB, `/jobs/${runId}/release`, request);
		expect(impersonation.status).toBe(409);
		expect(await apiError(impersonation)).toMatchObject({
			code: "STALE_LEASE",
			detail: "WRONG_RUNNER",
		});
		expect((await runState(harness, runId)).state).toBe("claimed");

		expect((await harness.runner(tokenA, `/jobs/${runId}/release`, request)).status).toBe(200);
		const again = await harness.runner(tokenA, `/jobs/${runId}/release`, request);
		expect(again.status).toBe(409);
		expect(await apiError(again)).toMatchObject({ code: "STALE_LEASE", detail: "NOT_LEASED" });
		expect((await runState(harness, runId)).attempt).toBe(0);

		const missing = await harness.runner(tokenA, "/jobs/run_missing/release", request);
		expect(missing.status).toBe(404);
		const malformed = await harness.runner(tokenA, `/jobs/${runId}/release`, {
			leaseGeneration: lease.leaseGeneration,
		});
		expect(malformed.status).toBe(400);
		expect(await errorCode(malformed)).toBe("VALIDATION_FAILED");
	});

	it("cancels a job whose cancellation was requested instead of requeueing it", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await harness.call("POST", `/research-runs/${runId}/cancel`);
		expect((await runState(harness, runId)).cancelRequested).toBe(true);

		const released = await harness.runner(token, `/jobs/${runId}/release`, {
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
		});
		expect(await body(released, releaseResponseSchema)).toEqual({ state: "cancelled" });
		const run = await runState(harness, runId);
		expect(run.state).toBe("cancelled");
		expect(run.cancelRequested).toBe(false);
		expect(await claim(harness, token)).toBeNull();
	});

	it("never exhausts the retry ceiling however often the runner restarts", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		for (let restart = 0; restart < 5; restart += 1) {
			const lease = await claim(harness, token);
			expect(lease?.runId, `restart ${restart}`).toBe(runId);
			expect(lease?.attempt, `restart ${restart}`).toBe(1);
			if (lease === null) throw new Error("expected a lease");
			const released = await harness.runner(token, `/jobs/${runId}/release`, {
				leaseGeneration: lease.leaseGeneration,
				usage: USAGE,
			});
			expect(released.status, `restart ${restart}`).toBe(200);
		}
		const run = await runState(harness, runId);
		expect(run.state).toBe("pending");
		expect(run.failureCode).toBeNull();
	});
});
