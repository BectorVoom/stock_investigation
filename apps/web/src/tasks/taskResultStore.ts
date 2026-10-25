import { isTerminalJobState, type ScheduledTask, type TaskResult } from "@research/contracts";
import { type Accessor, createSignal } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";

/**
 * What of a task's last run decides whether its answer may have changed
 * (ADR-0038 §3): the run id, and whether that run has ended. The steps of an
 * unfinished run (claimed, collecting, verifying…) share one stamp — a run
 * posts its answer as it ends — so a run in progress costs one re-read when
 * it starts and one when it ends, not one per step. "" before any run.
 */
export function resultStamp(task: ScheduledTask): string {
	const run = task.lastRun;
	if (run === null) return "";
	return `${run.runId}:${isTerminalJobState(run.state) ? run.state : "unfinished"}`;
}

/** One task's latest answer as every widget of that task on the page reads it. */
export interface TaskResultEntry {
	/** The answer, null when no run has answered yet, undefined before the first read. */
	readonly result: Accessor<TaskResult | null | undefined>;
	/** The last read's failure (not a 404); cleared by the next success. */
	readonly failure: Accessor<ApiFailure | null>;
	/** True once the server answered 404: the task is gone. */
	readonly missing: Accessor<boolean>;
	/**
	 * A widget starts showing the task. The first one after none makes the
	 * next `sync` read again (the answer may have changed while no widget
	 * showed it — a follow-up asked in the chat). Returns the release.
	 */
	readonly attach: () => () => void;
	/**
	 * The task's current stamp from the shared list (null while the list has
	 * not loaded). Reads the answer when none was read since the first
	 * attach, or when the stamp moved on from the one the last read saw.
	 * Several widgets passing the same stamp cause one read.
	 */
	readonly sync: (stamp: string | null) => void;
	/** Reads again now (Try again). */
	readonly retry: () => void;
}

const caches = new WeakMap<ApiClient, Map<string, TaskResultEntry>>();

/**
 * The one entry of `taskId` for `api`, created on first use: every Task
 * result widget of that task on a page shares one read and one ETag, as the
 * scheduled-tasks widgets share one list (`tasksStoreFor`). At most one
 * entry per task, so the cache is bounded by the owner's task count.
 */
export function taskResultFor(api: ApiClient, taskId: string): TaskResultEntry {
	let cache = caches.get(api);
	if (cache === undefined) {
		cache = new Map();
		caches.set(api, cache);
	}
	const existing = cache.get(taskId);
	if (existing !== undefined) return existing;
	const created = createEntry(api, taskId);
	cache.set(taskId, created);
	return created;
}

function createEntry(api: ApiClient, taskId: string): TaskResultEntry {
	const [result, setResult] = createSignal<TaskResult | null | undefined>(undefined);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [missing, setMissing] = createSignal(false);
	let etag: string | null = null;
	let users = 0;
	/** True until a read was asked for since the first widget attached. */
	let stale = true;
	/** The stamp the last read was asked for; null when the list was not loaded then. */
	let readFor: string | null = null;
	/** The stamp the next read is for, while a read is in flight (one read at a time). */
	let queued: string | null | undefined;
	let inFlight = false;

	const read = async (stamp: string | null): Promise<void> => {
		if (inFlight) {
			queued = stamp;
			return;
		}
		inFlight = true;
		stale = false;
		readFor = stamp;
		const answer = await api.getScheduledTaskResult(taskId, etag);
		inFlight = false;
		if (answer.ok) {
			setFailure(null);
			setMissing(false);
			if (answer.value.changed) {
				etag = answer.value.etag;
				setResult(answer.value.value.result);
			}
		} else if (answer.error.code === "NOT_FOUND") {
			etag = null;
			setFailure(null);
			setMissing(true);
		} else {
			setFailure(answer.error);
		}
		const next = queued;
		queued = undefined;
		if (next !== undefined) void read(next);
	};

	return {
		result,
		failure,
		missing,
		attach: () => {
			users += 1;
			if (users === 1) stale = true;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				users -= 1;
			};
		},
		sync: (stamp) => {
			if (stale) {
				void read(stamp);
				return;
			}
			if (stamp === null) return;
			// The first stamp after a read made before the list loaded: that
			// read already saw this run, so it is adopted, not read again.
			if (readFor === null) {
				readFor = stamp;
				return;
			}
			if (stamp !== readFor) void read(stamp);
		},
		retry: () => void read(readFor),
	};
}
