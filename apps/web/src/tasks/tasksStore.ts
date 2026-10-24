import type { ScheduledTask, ScheduledTaskListResponse } from "@research/contracts";
import { type Accessor, createSignal } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { createPoller, type PollSchedule, type VisibilitySource } from "../lib/polling.ts";
import { hasUnfinishedRun } from "./tasksModel.ts";

/**
 * Polling of the task list (ADR-0033 §9): 5 s while a task's last run is
 * unfinished, otherwise 30 s; no requests while the tab is hidden. A
 * failed poll waits the slow interval too.
 */
export const TASKS_POLL_SCHEDULE: PollSchedule = {
	activeMs: 5_000,
	idleBaseMs: 30_000,
	idleMaxMs: 30_000,
	queuedMaxMs: 30_000,
	backoffFactor: 2,
};

/**
 * The owner's task list, one per API client: the Tasks page and every
 * scheduled-tasks widget on a page read the same list through one poll with
 * one ETag, so several widgets never multiply requests.
 */
export interface TasksStore {
	/** The last list the server returned, or null before the first answer. */
	readonly list: Accessor<ScheduledTaskListResponse | null>;
	/** The last poll's failure; cleared by the next success. */
	readonly failure: Accessor<ApiFailure | null>;
	/**
	 * A view starts using the list: the first one starts polling (at once,
	 * when visible). Returns the release; the last release stops polling.
	 */
	readonly attach: () => () => void;
	/** Re-reads the list as soon as possible (after a write, or Try again). */
	readonly refresh: () => void;
	/** Puts a task the server just returned into the list (create, edit, run now). */
	readonly putTask: (task: ScheduledTask) => void;
	/** Takes a deleted task out of the list. */
	readonly dropTask: (taskId: string) => void;
}

const stores = new WeakMap<ApiClient, TasksStore>();

/** The one store of `api`, created on first use with the visibility it was first asked with. */
export function tasksStoreFor(api: ApiClient, visibility: VisibilitySource): TasksStore {
	const existing = stores.get(api);
	if (existing !== undefined) return existing;
	const created = createTasksStore(api, visibility);
	stores.set(api, created);
	return created;
}

function createTasksStore(api: ApiClient, visibility: VisibilitySource): TasksStore {
	const [list, setList] = createSignal<ScheduledTaskListResponse | null>(null);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	let etag: string | null = null;
	let users = 0;
	/**
	 * Bumped by every local write. A poll that started before one may carry
	 * the older list, so its answer is dropped and the list read again.
	 */
	let writes = 0;

	const poller = createPoller({
		visibility,
		schedule: TASKS_POLL_SCHEDULE,
		poll: async () => {
			const startedAt = writes;
			const result = await api.listScheduledTasks(etag);
			// The write asked for a poll while this one was in flight; the
			// poller runs that one next, so this stale answer is dropped.
			if (startedAt !== writes) return "changed";
			if (!result.ok) {
				setFailure(result.error);
				return "failed";
			}
			setFailure(null);
			if (result.value.changed) {
				etag = result.value.etag;
				setList(result.value.value);
			}
			const current = list();
			if (current !== null && hasUnfinishedRun(current.tasks)) return "active";
			return result.value.changed ? "changed" : "unchanged";
		},
	});

	const write = (change: (tasks: readonly ScheduledTask[]) => readonly ScheduledTask[]): void => {
		writes += 1;
		etag = null;
		const current = list();
		if (current !== null) setList({ ...current, tasks: [...change(current.tasks)] });
		poller.pollNow();
	};

	return {
		list,
		failure,
		attach: () => {
			users += 1;
			if (users === 1) poller.start();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				users -= 1;
				if (users === 0) poller.stop();
			};
		},
		refresh: () => poller.pollNow(),
		putTask: (task) =>
			write((tasks) =>
				tasks.some((entry) => entry.taskId === task.taskId)
					? tasks.map((entry) => (entry.taskId === task.taskId ? task : entry))
					: [task, ...tasks],
			),
		dropTask: (taskId) => write((tasks) => tasks.filter((entry) => entry.taskId !== taskId)),
	};
}
