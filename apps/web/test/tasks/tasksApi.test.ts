import { type CreateScheduledTaskRequest, IDEMPOTENCY_KEY_HEADER } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.ts";
import { createFakeBackend, errorResponse, jsonResponse } from "../fakeBackend.ts";
import { makeRun } from "../fixtures.ts";
import { makeTask } from "./tasksHarness.ts";

const KEY_HEADER = IDEMPOTENCY_KEY_HEADER.toLowerCase();
const LIST = { tasks: [makeTask()], limits: { maxActive: 10, maxTasks: 30 } };
const CREATE: CreateScheduledTaskRequest = {
	title: "Morning brief",
	question: "What changed overnight?",
	horizonYears: 5,
	markets: ["JP"],
	schedule: { kind: "daily", time: "08:00" },
	timeZone: "Asia/Tokyo",
	spendConsent: null,
};

describe("scheduled tasks API client (ADR-0033 §6)", () => {
	it("lists conditionally: the ETag first, then If-None-Match with a 304 as unchanged", async () => {
		const backend = createFakeBackend();
		backend.on("GET", /^\/api\/v1\/scheduled-tasks$/, (request) =>
			request.headers["if-none-match"] === '"v1"'
				? new Response(null, { status: 304 })
				: jsonResponse(LIST, { headers: { ETag: '"v1"' } }),
		);
		const api = createApiClient({ fetch: backend.fetch });
		const first = await api.listScheduledTasks();
		expect(first).toEqual({ ok: true, value: { changed: true, value: LIST, etag: '"v1"' } });
		expect(backend.requests[0]?.headers["if-none-match"]).toBeUndefined();
		const second = await api.listScheduledTasks('"v1"');
		expect(second).toEqual({ ok: true, value: { changed: false } });
	});

	it("refuses a list that breaks the contract instead of showing it", async () => {
		const backend = createFakeBackend();
		backend.on("GET", /^\/api\/v1\/scheduled-tasks$/, () =>
			jsonResponse({ ...LIST, limits: { maxActive: 99, maxTasks: 30 } }),
		);
		const result = await createApiClient({ fetch: backend.fetch }).listScheduledTasks();
		expect(result.ok ? null : result.error.code).toBe("INVALID_RESPONSE");
	});

	it("creates with an Idempotency-Key and returns the task with its conversation", async () => {
		const backend = createFakeBackend();
		backend.on("POST", /^\/api\/v1\/scheduled-tasks$/, () =>
			jsonResponse({ task: makeTask({ taskId: "task_9", workspaceId: "ws_9" }) }, { status: 201 }),
		);
		const api = createApiClient({ fetch: backend.fetch });
		const result = await api.createScheduledTask(CREATE, "idem-create-1");
		expect(result.ok ? result.value.workspaceId : null).toBe("ws_9");
		expect(backend.requests[0]?.headers[KEY_HEADER]).toBe("idem-create-1");
		expect(backend.requests[0]?.body).toEqual(CREATE);
	});

	it("sends nothing for an invalid create or a malformed key", async () => {
		const backend = createFakeBackend();
		const api = createApiClient({ fetch: backend.fetch });
		const invalid = await api.createScheduledTask(
			{ ...CREATE, schedule: { kind: "weekly", days: [3, 1], time: "08:00" } },
			"idem-create-2",
		);
		expect(invalid.ok ? null : invalid.error.kind).toBe("invalid-request");
		const badKey = await api.createScheduledTask(CREATE, "no spaces allowed");
		expect(badKey.ok ? null : badKey.error.kind).toBe("invalid-request");
		expect(backend.requests).toHaveLength(0);
	});

	it("pauses with PATCH and expectedVersion, and carries a 409 as VERSION_CONFLICT", async () => {
		const backend = createFakeBackend();
		backend.on("PATCH", /^\/api\/v1\/scheduled-tasks\/task_1$/, (request) => {
			const body = request.body;
			const version =
				typeof body === "object" && body !== null && "expectedVersion" in body
					? body.expectedVersion
					: null;
			return version === 1
				? jsonResponse({ task: makeTask({ status: "paused", nextRunAt: null, version: 2 }) })
				: errorResponse(409, "VERSION_CONFLICT", "the task changed");
		});
		const api = createApiClient({ fetch: backend.fetch });
		const paused = await api.updateScheduledTask("task_1", {
			expectedVersion: 1,
			status: "paused",
		});
		expect(paused.ok ? paused.value.status : null).toBe("paused");
		expect(backend.requests[0]?.body).toEqual({ expectedVersion: 1, status: "paused" });
		const stale = await api.updateScheduledTask("task_1", { expectedVersion: 0, status: "active" });
		expect(stale.ok ? null : stale.error.code).toBe("VERSION_CONFLICT");
	});

	it("refuses an edit that changes nothing before sending it", async () => {
		const backend = createFakeBackend();
		const result = await createApiClient({ fetch: backend.fetch }).updateScheduledTask("task_1", {
			expectedVersion: 1,
		});
		expect(result.ok ? null : result.error.kind).toBe("invalid-request");
		expect(backend.requests).toHaveLength(0);
	});

	it("deletes by encoded id and runs now with an Idempotency-Key", async () => {
		const backend = createFakeBackend();
		backend.on(
			"DELETE",
			/^\/api\/v1\/scheduled-tasks\/task%2F1$/,
			() => new Response(null, { status: 204 }),
		);
		backend.on("POST", /^\/api\/v1\/scheduled-tasks\/task_1\/run$/, () =>
			jsonResponse({ task: makeTask(), run: makeRun({ state: "pending" }), replayed: true }),
		);
		const api = createApiClient({ fetch: backend.fetch });
		expect(await api.deleteScheduledTask("task/1")).toEqual({ ok: true, value: null });
		const run = await api.runScheduledTask("task_1", "idem-run-1");
		expect(run.ok ? run.value.replayed : null).toBe(true);
		expect(backend.requests[1]?.headers[KEY_HEADER]).toBe("idem-run-1");
	});
});
