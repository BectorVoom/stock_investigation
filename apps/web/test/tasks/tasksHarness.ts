import {
	type AgentSettingsResponse,
	agentSettingsResponseSchema,
	SCHEDULED_TASK_LIMITS,
	type ScheduledTask,
	scheduledTaskSchema,
	type TaskResult,
	taskResultSchema,
} from "@research/contracts";
import { createApiClient } from "../../src/api/client.ts";
import {
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
	type RecordedRequest,
} from "../fakeBackend.ts";
import { AGENT_SETTINGS, AGENT_SETTINGS_RESPONSE, AGENTS, makeRun } from "../fixtures.ts";

/** 2026-10-24 09:00 UTC (18:00 in Tokyo): every test's "now". */
export const NOW_MS = Date.UTC(2026, 9, 24, 9, 0);

/** A stored task as the list returns it: daily at 08:00 Tokyo, next run tomorrow 08:00 JST. */
export function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return scheduledTaskSchema.parse({
		taskId: "task_1",
		workspaceId: "ws_task_1",
		title: "Morning storage brief",
		question: "What changed overnight in grid storage demand?",
		horizonYears: 5,
		markets: ["JP", "US"],
		schedule: { kind: "daily", time: "08:00" },
		timeZone: "Asia/Tokyo",
		spendConsent: null,
		status: "active",
		nextRunAt: "2026-10-24T23:00:00Z",
		lastRun: null,
		lastSkip: null,
		version: 1,
		createdAt: "2026-10-20T00:00:00Z",
		updatedAt: "2026-10-20T00:00:00Z",
		...overrides,
	});
}

/** A task's latest answer as the result route returns it: verified, two hours before `NOW_MS`. */
export function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return taskResultSchema.parse({
		runId: "run_9",
		text: "Grid storage demand rose overnight.\nTwo utilities announced new tenders.",
		answeredAt: "2026-10-24T07:00:00Z",
		verificationStatus: "verified",
		...overrides,
	});
}

/** Saved agent settings pointing at the metered OpenRouter backend with a $0.50 ceiling. */
export const METERED_SETTINGS: AgentSettingsResponse = agentSettingsResponseSchema.parse({
	...AGENT_SETTINGS_RESPONSE,
	settings: {
		...AGENT_SETTINGS,
		defaultAgentId: "openrouter",
		models: { openrouter: "anthropic/claude-sonnet" },
		budget: { ...AGENT_SETTINGS.budget, maxSpendUsd: 0.5 },
	},
});

function bodyObject(request: RecordedRequest): Record<string, unknown> {
	const body = request.body;
	if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
	return Object.fromEntries(Object.entries(body));
}

/**
 * An in-memory tasks API (ADR-0033 §6) on the fake backend: the list with
 * an ETag (304 when unchanged), create, edit / pause / resume with
 * compare-and-set, delete and run now, and each task's latest result
 * (ADR-0038) with its own ETag. Tests read and change `tasks` and
 * `results` to play the server's part (a run finishing, another tab's edit).
 */
export function createTasksServer(
	options: {
		readonly tasks?: readonly ScheduledTask[];
		readonly agentSettings?: AgentSettingsResponse;
		readonly backend?: FakeBackend;
	} = {},
) {
	const backend = options.backend ?? createFakeBackend();
	const state = {
		tasks: [...(options.tasks ?? [])],
		/** Bumped by every change; the list's ETag. */
		revision: 1,
		agentSettings: options.agentSettings ?? AGENT_SETTINGS_RESPONSE,
		created: 0,
		/** Each task's latest answer; absent = no run has answered. */
		results: new Map<string, TaskResult>(),
		/** Bumped by every result change; part of the result's ETag. */
		resultRevision: 1,
	};
	const etag = () => `"tasks-${state.revision}"`;
	const listBody = () => ({
		tasks: state.tasks,
		limits: {
			maxActive: SCHEDULED_TASK_LIMITS.maxActive,
			maxTasks: SCHEDULED_TASK_LIMITS.maxTasks,
		},
	});
	const replace = (task: ScheduledTask) => {
		state.tasks = state.tasks.map((entry) => (entry.taskId === task.taskId ? task : entry));
		state.revision += 1;
	};

	backend.on("GET", /^\/api\/v1\/agents$/, () => jsonResponse(AGENTS));
	backend.on("GET", /^\/api\/v1\/settings\/agent$/, () => jsonResponse(state.agentSettings));
	backend.on("GET", /^\/api\/v1\/scheduled-tasks$/, (request) => {
		if (request.headers["if-none-match"] === etag()) return new Response(null, { status: 304 });
		return jsonResponse(listBody(), { headers: { ETag: etag() } });
	});
	backend.on("GET", /^\/api\/v1\/scheduled-tasks\/([^/]+)\/result$/, (request, match) => {
		const taskId = match[1] ?? "";
		if (!state.tasks.some((task) => task.taskId === taskId)) {
			return errorResponse(404, "NOT_FOUND", "no such task");
		}
		const resultEtag = `"result-${taskId}-${state.resultRevision}"`;
		if (request.headers["if-none-match"] === resultEtag) {
			return new Response(null, { status: 304 });
		}
		return jsonResponse(
			{ result: state.results.get(taskId) ?? null },
			{ headers: { ETag: resultEtag } },
		);
	});
	backend.on("POST", /^\/api\/v1\/scheduled-tasks$/, (request) => {
		state.created += 1;
		const body = bodyObject(request);
		const task = scheduledTaskSchema.parse({
			...body,
			taskId: `task_new_${state.created}`,
			workspaceId: `ws_new_${state.created}`,
			status: "active",
			nextRunAt: "2026-10-25T00:00:00Z",
			lastRun: null,
			lastSkip: null,
			version: 1,
			createdAt: "2026-10-24T09:00:00Z",
			updatedAt: "2026-10-24T09:00:00Z",
		});
		state.tasks = [task, ...state.tasks];
		state.revision += 1;
		return jsonResponse({ task }, { status: 201 });
	});
	backend.on("PATCH", /^\/api\/v1\/scheduled-tasks\/([^/]+)$/, (request, match) => {
		const current = state.tasks.find((task) => task.taskId === match[1]);
		if (current === undefined) return errorResponse(404, "NOT_FOUND", "no such task");
		const { expectedVersion, status, ...fields } = bodyObject(request);
		if (expectedVersion !== current.version) {
			return errorResponse(409, "VERSION_CONFLICT", "the task changed");
		}
		const nextStatus = status === "paused" || status === "active" ? status : current.status;
		const task = scheduledTaskSchema.parse({
			...current,
			...fields,
			status: nextStatus,
			nextRunAt: nextStatus === "paused" ? null : (current.nextRunAt ?? "2026-10-25T00:00:00Z"),
			version: current.version + 1,
			updatedAt: "2026-10-24T09:00:00Z",
		});
		replace(task);
		return jsonResponse({ task });
	});
	backend.on("DELETE", /^\/api\/v1\/scheduled-tasks\/([^/]+)$/, (_request, match) => {
		state.tasks = state.tasks.filter((task) => task.taskId !== match[1]);
		state.revision += 1;
		return new Response(null, { status: 204 });
	});
	backend.on("POST", /^\/api\/v1\/scheduled-tasks\/([^/]+)\/run$/, (_request, match) => {
		const current = state.tasks.find((task) => task.taskId === match[1]);
		if (current === undefined) return errorResponse(404, "NOT_FOUND", "no such task");
		const unfinished =
			current.lastRun !== null &&
			current.lastRun.state !== "completed" &&
			current.lastRun.state !== "failed";
		const runId = unfinished && current.lastRun !== null ? current.lastRun.runId : "run_task_now";
		const task = unfinished
			? current
			: scheduledTaskSchema.parse({
					...current,
					lastRun: {
						runId,
						state: "pending",
						slotAt: null,
						queuedAt: "2026-10-24T09:00:00Z",
						failureCode: null,
						failureUpstreamStatus: null,
					},
					version: current.version + 1,
				});
		if (!unfinished) replace(task);
		return jsonResponse({
			task,
			run: makeRun({ runId, workspaceId: current.workspaceId, state: "pending" }),
			replayed: unfinished,
		});
	});

	return {
		backend,
		state,
		api: createApiClient({ fetch: backend.fetch }),
		/** Changes a task the way the server would (a run ending, an edit elsewhere). */
		update: (task: ScheduledTask) => replace(task),
		listRequests: () => backend.requestsTo("GET", /^\/api\/v1\/scheduled-tasks$/),
		/** Sets (or, with null, clears) a task's latest answer, as a run answering would. */
		setResult: (taskId: string, result: TaskResult | null) => {
			if (result === null) state.results.delete(taskId);
			else state.results.set(taskId, result);
			state.resultRevision += 1;
		},
		resultRequests: (taskId = "task_1") =>
			backend.requestsTo("GET", new RegExp(`^/api/v1/scheduled-tasks/${taskId}/result$`)),
	};
}

export type TasksServer = ReturnType<typeof createTasksServer>;
