import type { HomeCapacityProblem, ScheduledTask } from "@research/contracts";
import { createSignal } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import type { TasksStore } from "./tasksStore.ts";

/**
 * The task a success notice is about, as the server answered: once the list
 * shows that task changed (it fired, was skipped, its run moved on) or gone,
 * the notice is stale and is no longer shown.
 */
export interface OutcomeSubject {
	readonly taskId: string;
	readonly stamp: string;
}

/** What one action on a task ended with, for the view's notice. */
export type TaskActionOutcome =
	| {
			readonly kind: "created" | "saved" | "paused" | "resumed";
			readonly title: string;
			readonly subject: OutcomeSubject;
	  }
	| { readonly kind: "deleted"; readonly title: string }
	/** Show result on Home (ADR-0038 §5): added, or one was already there. */
	| { readonly kind: "on-home"; readonly title: string; readonly already: boolean }
	/** Home is at one of its bounds, so nothing was added. */
	| {
			readonly kind: "home-full";
			readonly title: string;
			readonly problem: HomeCapacityProblem["code"];
	  }
	| {
			readonly kind: "run";
			readonly title: string;
			readonly replayed: boolean;
			readonly subject: OutcomeSubject;
	  }
	| {
			readonly kind: "failed";
			readonly action: "pause" | "resume" | "run" | "delete" | "show-on-home";
			readonly failure: ApiFailure;
	  };

/** What of a task a notice reflects: its version, status, last run and last skip. */
export function subjectOf(task: ScheduledTask): OutcomeSubject {
	const run = task.lastRun === null ? "" : `${task.lastRun.runId}:${task.lastRun.state}`;
	return {
		taskId: task.taskId,
		stamp: `${task.version}|${task.status}|${run}|${task.lastSkip?.at ?? ""}`,
	};
}

/**
 * Whether a notice still describes the list: a success about a task stops
 * showing once the list holds that task in another state (or not at all).
 * Failures and the outcomes about no task state ("deleted", Home's) stay
 * until the next action replaces them.
 */
export function outcomeStillCurrent(
	outcome: TaskActionOutcome,
	tasks: readonly ScheduledTask[] | null,
): boolean {
	if (!("subject" in outcome) || tasks === null) return true;
	const task = tasks.find((entry) => entry.taskId === outcome.subject.taskId);
	return task !== undefined && subjectOf(task).stamp === outcome.subject.stamp;
}

/**
 * Pause / Resume, Run now and Delete as the Tasks page and the widget both
 * use them (ADR-0033 §5): one request per task at a time, the store updated
 * from the server's answer, and a refused write (another tab changed the
 * task) re-reading the list. A Run now that never got an answer reuses its
 * idempotency key on the next press, so a retry cannot queue a second run.
 */
export function createTaskActions(api: ApiClient, store: TasksStore) {
	const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
	const runKeys = new Map<string, string>();

	const track = async <T>(
		taskId: string,
		send: () => Promise<ApiResult<T>>,
	): Promise<ApiResult<T> | null> => {
		if (busy().has(taskId)) return null;
		setBusy((current) => new Set([...current, taskId]));
		try {
			return await send();
		} finally {
			setBusy((current) => new Set([...current].filter((id) => id !== taskId)));
		}
	};

	const afterFailure = (failure: ApiFailure): void => {
		if (failure.code === "VERSION_CONFLICT" || failure.code === "NOT_FOUND") store.refresh();
	};

	const setPaused = async (
		task: ScheduledTask,
		paused: boolean,
	): Promise<TaskActionOutcome | null> => {
		const result = await track(task.taskId, () =>
			api.updateScheduledTask(task.taskId, {
				expectedVersion: task.version,
				status: paused ? "paused" : "active",
			}),
		);
		if (result === null) return null;
		if (!result.ok) {
			afterFailure(result.error);
			return { kind: "failed", action: paused ? "pause" : "resume", failure: result.error };
		}
		store.putTask(result.value);
		return {
			kind: paused ? "paused" : "resumed",
			title: result.value.title,
			subject: subjectOf(result.value),
		};
	};

	const runNow = async (task: ScheduledTask): Promise<TaskActionOutcome | null> => {
		const key = runKeys.get(task.taskId) ?? api.newIdempotencyKey();
		runKeys.set(task.taskId, key);
		const result = await track(task.taskId, () => api.runScheduledTask(task.taskId, key));
		if (result === null) return null;
		// Only a request that never got an answer may have queued a run: keep
		// its key then, so the retry answers that run instead of a second one.
		if (result.ok || result.error.kind !== "network") runKeys.delete(task.taskId);
		if (!result.ok) {
			afterFailure(result.error);
			return { kind: "failed", action: "run", failure: result.error };
		}
		store.putTask(result.value.task);
		return {
			kind: "run",
			title: result.value.task.title,
			replayed: result.value.replayed,
			subject: subjectOf(result.value.task),
		};
	};

	const remove = async (task: ScheduledTask): Promise<TaskActionOutcome | null> => {
		const result = await track(task.taskId, () => api.deleteScheduledTask(task.taskId));
		if (result === null) return null;
		if (!result.ok && result.error.code !== "NOT_FOUND") {
			return { kind: "failed", action: "delete", failure: result.error };
		}
		// Already gone (deleted in another tab) is what the owner asked for.
		store.dropTask(task.taskId);
		return { kind: "deleted", title: task.title };
	};

	/** True while one of the task's actions is in flight (its buttons are disabled). */
	const isBusy = (taskId: string): boolean => busy().has(taskId);

	return { setPaused, runNow, remove, isBusy };
}

export type TaskActions = ReturnType<typeof createTaskActions>;
