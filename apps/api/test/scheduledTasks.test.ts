/**
 * Scheduled tasks over HTTP (ADR-0033 §6) against the real migrations, on
 * workerd + D1 and on node:sqlite: the five routes, their auth and CSRF
 * refusals, and the claim-time firing end to end.
 */
import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import {
	type AgentSettings,
	agentSettingsResponseSchema,
	type CreateScheduledTaskRequest,
	conversationResponseSchema,
	runBudget,
	runScheduledTaskResponseSchema,
	scheduledTaskListResponseSchema,
	scheduledTaskResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	apiError,
	body,
	claim,
	createHarness,
	errorCode,
	type Harness,
	idempotencyKey,
	issueRunnerToken,
	queueRun,
} from "./helpers.ts";

/** The harness clock starts at 2026-10-11T00:00:00Z. */
const HOUR_MS = 3_600_000;

const SETTINGS: AgentSettings = {
	defaultAgentId: "claude-code",
	models: {},
	effort: "medium",
	budget: runBudget(null),
	webAccess: "off",
};

function taskBody(overrides: Partial<CreateScheduledTaskRequest> = {}): CreateScheduledTaskRequest {
	return {
		title: "Morning brief",
		question: "What moved grid-storage suppliers overnight?",
		horizonYears: 4,
		markets: ["JP", "US"],
		schedule: { kind: "daily", time: "06:00" },
		timeZone: "UTC",
		spendConsent: null,
		...overrides,
	};
}

async function saveSettings(harness: Harness, settings: AgentSettings = SETTINGS): Promise<void> {
	const response = await harness.call("PUT", "/settings/agent", settings);
	expect(response.status).toBe(200);
	await body(response, agentSettingsResponseSchema);
}

async function createTask(harness: Harness, overrides: Partial<CreateScheduledTaskRequest> = {}) {
	const response = await harness.call(
		"POST",
		"/scheduled-tasks",
		taskBody(overrides),
		idempotencyKey(),
	);
	expect(response.status).toBe(201);
	return (await body(response, scheduledTaskResponseSchema)).task;
}

async function listTasks(harness: Harness) {
	const response = await harness.call("GET", "/scheduled-tasks");
	expect(response.status).toBe(200);
	return body(response, scheduledTaskListResponseSchema);
}

describe("scheduled task routes (ADR-0033 §6)", () => {
	it("creates a task with its own conversation and lists it with the limits", async () => {
		const harness = createHarness();
		expect(await listTasks(harness)).toEqual({
			tasks: [],
			limits: { maxActive: 10, maxTasks: 30 },
		});
		const task = await createTask(harness);
		expect(task).toMatchObject({
			title: "Morning brief",
			status: "active",
			nextRunAt: "2026-10-11T06:00:00.000Z",
			lastRun: null,
			lastSkip: null,
			version: 0,
		});
		const conversations = await harness.call("GET", "/workspaces");
		expect(JSON.stringify(await conversations.json())).toContain(task.workspaceId);
		expect((await listTasks(harness)).tasks).toEqual([task]);
	});

	it("needs an Idempotency-Key, replays a repeated one, and validates the body", async () => {
		const harness = createHarness();
		const missing = await harness.call("POST", "/scheduled-tasks", taskBody());
		expect(missing.status).toBe(400);
		expect(await errorCode(missing)).toBe("VALIDATION_FAILED");
		const key = idempotencyKey();
		const first = await harness.call("POST", "/scheduled-tasks", taskBody(), key);
		expect(first.status).toBe(201);
		const replay = await harness.call("POST", "/scheduled-tasks", taskBody(), key);
		expect(replay.status).toBe(200);
		expect((await body(replay, scheduledTaskResponseSchema)).task).toEqual(
			(await body(first, scheduledTaskResponseSchema)).task,
		);
		expect((await listTasks(harness)).tasks).toHaveLength(1);
		const unordered = await harness.call(
			"POST",
			"/scheduled-tasks",
			taskBody({ schedule: { kind: "weekly", days: [5, 1], time: "08:00" } }),
			idempotencyKey(),
		);
		expect(unordered.status).toBe(400);
		expect((await apiError(unordered)).detail).toContain("schedule");
		const badZone = await harness.call(
			"POST",
			"/scheduled-tasks",
			taskBody({ timeZone: "Mars/Olympus" }),
			idempotencyKey(),
		);
		expect(badZone.status).toBe(400);
		const past = await harness.call(
			"POST",
			"/scheduled-tasks",
			taskBody({ schedule: { kind: "once", date: "2026-10-10", time: "09:00" } }),
			idempotencyKey(),
		);
		expect(past.status).toBe(400);
		expect(await apiError(past)).toMatchObject({
			code: "VALIDATION_FAILED",
			detail: "SCHEDULE_IN_PAST",
		});
	});

	it("answers 304 for an unchanged list and a new ETag after an edit", async () => {
		const harness = createHarness();
		const task = await createTask(harness);
		const first = await harness.call("GET", "/scheduled-tasks");
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		const cached = await harness.call("GET", "/scheduled-tasks", undefined, {
			"If-None-Match": etag ?? "",
		});
		expect(cached.status).toBe(304);
		const edited = await harness.call("PATCH", `/scheduled-tasks/${task.taskId}`, {
			expectedVersion: 0,
			title: "Evening brief",
		});
		expect(edited.status).toBe(200);
		const after = await harness.call("GET", "/scheduled-tasks", undefined, {
			"If-None-Match": etag ?? "",
		});
		expect(after.status).toBe(200);
		expect(after.headers.get("ETag")).not.toBe(etag);
	});

	it("pauses, resumes, edits by compare-and-set and deletes (keeping the conversation)", async () => {
		const harness = createHarness();
		const task = await createTask(harness);
		const paused = await harness.call("PATCH", `/scheduled-tasks/${task.taskId}`, {
			expectedVersion: 0,
			status: "paused",
		});
		expect((await body(paused, scheduledTaskResponseSchema)).task).toMatchObject({
			status: "paused",
			nextRunAt: null,
			version: 1,
		});
		const stale = await harness.call("PATCH", `/scheduled-tasks/${task.taskId}`, {
			expectedVersion: 0,
			status: "active",
		});
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("VERSION_CONFLICT");
		harness.time.advance(7 * HOUR_MS);
		const resumed = await harness.call("PATCH", `/scheduled-tasks/${task.taskId}`, {
			expectedVersion: 1,
			status: "active",
		});
		// Resumed from now (07:00): today's 06:00 passed while paused and never runs.
		expect((await body(resumed, scheduledTaskResponseSchema)).task).toMatchObject({
			status: "active",
			nextRunAt: "2026-10-12T06:00:00.000Z",
		});
		const empty = await harness.call("PATCH", `/scheduled-tasks/${task.taskId}`, {
			expectedVersion: 2,
		});
		expect(empty.status).toBe(400);
		const removed = await harness.call("DELETE", `/scheduled-tasks/${task.taskId}`);
		expect(removed.status).toBe(204);
		expect((await listTasks(harness)).tasks).toEqual([]);
		const again = await harness.call("DELETE", `/scheduled-tasks/${task.taskId}`);
		expect(again.status).toBe(404);
		expect((await harness.call("GET", `/workspaces/${task.workspaceId}`)).status).toBe(200);
	});

	it("deleting the conversation deletes its tasks", async () => {
		const harness = createHarness();
		const task = await createTask(harness);
		const kept = await createTask(harness, { title: "Other" });
		expect((await harness.call("DELETE", `/workspaces/${task.workspaceId}`)).status).toBe(204);
		expect((await listTasks(harness)).tasks.map((entry) => entry.taskId)).toEqual([kept.taskId]);
	});

	it("refuses anonymous reads, unprotected writes and another owner's task", async () => {
		const harness = createHarness();
		const other = createHarness();
		const task = await createTask(harness);
		const anonymous = await harness.raw("GET", "/scheduled-tasks", {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect(anonymous.status).toBe(401);
		const csrf = await harness.raw("POST", "/scheduled-tasks", {
			body: taskBody(),
			headers: { Origin: "http://localhost", ...idempotencyKey() },
		});
		expect(csrf.status).toBe(403);
		expect(await errorCode(csrf)).toBe("CSRF_REJECTED");
		const crossSite = await harness.raw("DELETE", `/scheduled-tasks/${task.taskId}`, {
			headers: { Origin: "https://evil.example" },
		});
		expect(await errorCode(crossSite)).toBe("CSRF_REJECTED");
		expect((await listTasks(other)).tasks).toEqual([]);
		const foreign = [
			await other.call("PATCH", `/scheduled-tasks/${task.taskId}`, {
				expectedVersion: 0,
				title: "Mine",
			}),
			await other.call("DELETE", `/scheduled-tasks/${task.taskId}`),
			await other.call("POST", `/scheduled-tasks/${task.taskId}/run`, undefined, idempotencyKey()),
		];
		for (const response of foreign) {
			expect(response.status).toBe(404);
			expect(await errorCode(response)).toBe("NOT_FOUND");
		}
		expect((await listTasks(harness)).tasks).toEqual([task]);
	});
});

describe("firing on runner claim (ADR-0033 §2)", () => {
	it("queues the task's question when a runner claims after its time, once", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const task = await createTask(harness);
		expect(await claim(harness, token)).toBe(null);
		harness.time.advance(6 * HOUR_MS + 30_000);
		const lease = await claim(harness, token);
		expect(lease).toMatchObject({
			kind: "research",
			request: {
				workspaceId: task.workspaceId,
				question: task.question,
				agentId: "claude-code",
				horizonYears: 4,
				markets: ["JP", "US"],
			},
		});
		// The same claim window again: the slot already fired, nothing new.
		expect(await claim(harness, token)).toBe(null);
		const [listed] = (await listTasks(harness)).tasks;
		expect(listed).toMatchObject({
			nextRunAt: "2026-10-12T06:00:00.000Z",
			lastRun: { runId: lease?.runId, state: "claimed", slotAt: "2026-10-11T06:00:00.000Z" },
		});
		// The question landed in the task's own conversation.
		const conversation = await body(
			await harness.call("GET", `/workspaces/${task.workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages.map((message) => message.text)).toEqual([task.question]);
	});

	it("records a skipped occurrence when no backend is saved, and does not retry it", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const task = await createTask(harness);
		harness.time.advance(6 * HOUR_MS);
		expect(await claim(harness, token)).toBe(null);
		const [listed] = (await listTasks(harness)).tasks;
		expect(listed).toMatchObject({
			taskId: task.taskId,
			nextRunAt: "2026-10-12T06:00:00.000Z",
			lastRun: null,
			lastSkip: { code: "AGENT_NOT_CONFIGURED", slotAt: "2026-10-11T06:00:00.000Z" },
		});
	});

	it("never fails the claim when firing throws", async () => {
		const ownerHarness = createHarness();
		await saveSettings(ownerHarness);
		const token = await issueRunnerToken(ownerHarness);
		const task = await createTask(ownerHarness);
		const runId = await queueRun(ownerHarness, task.workspaceId);
		const persistence = createD1Adapters(env.DB);
		const failing = createHarness({
			ownerId: ownerHarness.ownerId,
			time: ownerHarness.time,
			persistence: {
				...persistence,
				scheduledTasks: {
					...persistence.scheduledTasks,
					listDue: () => Promise.reject(new Error("due scan blew up")),
				},
			},
		});
		const lines: string[] = [];
		const errors = console.error;
		console.error = (line: unknown) => {
			lines.push(String(line));
		};
		try {
			const lease = await claim(failing, token);
			expect(lease?.runId).toBe(runId);
		} finally {
			console.error = errors;
		}
		const logged = lines.filter((line) => line.includes("scheduled_tasks_materialize_failed"));
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain('"name":"Error"');
		expect(logged[0]).not.toContain("blew up");
	});
});

describe("run now (ADR-0033 §5)", () => {
	it("queues a run without moving the schedule and answers the unfinished one", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const task = await createTask(harness);
		const missingKey = await harness.call("POST", `/scheduled-tasks/${task.taskId}/run`);
		expect(missingKey.status).toBe(400);
		const first = await harness.call(
			"POST",
			`/scheduled-tasks/${task.taskId}/run`,
			undefined,
			idempotencyKey(),
		);
		expect(first.status).toBe(202);
		const ran = await body(first, runScheduledTaskResponseSchema);
		expect(ran).toMatchObject({
			replayed: false,
			run: { state: "pending", workspaceId: task.workspaceId },
			task: { nextRunAt: task.nextRunAt, lastRun: { runId: ran.run.runId, slotAt: null } },
		});
		const second = await body(
			await harness.call(
				"POST",
				`/scheduled-tasks/${task.taskId}/run`,
				undefined,
				idempotencyKey(),
			),
			runScheduledTaskResponseSchema,
		);
		expect(second).toMatchObject({ replayed: true, run: { runId: ran.run.runId } });
		// Its time comes while that run is still unfinished: the occurrence
		// waits, and the claim hands out the run-now run, not a second one.
		harness.time.advance(6 * HOUR_MS);
		expect((await claim(harness, token))?.runId).toBe(ran.run.runId);
		expect(await claim(harness, token)).toBe(null);
		expect((await listTasks(harness)).tasks[0]?.nextRunAt).toBe("2026-10-11T06:00:00.000Z");
	});

	it("answers the run service's refusal when no backend is saved", async () => {
		const harness = createHarness();
		const task = await createTask(harness);
		const refused = await harness.call(
			"POST",
			`/scheduled-tasks/${task.taskId}/run`,
			undefined,
			idempotencyKey(),
		);
		expect(refused.status).toBe(422);
		expect(await errorCode(refused)).toBe("AGENT_NOT_CONFIGURED");
	});
});
