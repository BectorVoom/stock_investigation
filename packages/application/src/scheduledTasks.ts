import {
	type CreateScheduledTaskRequest,
	type ResearchRun,
	SCHEDULED_TASK_LIMITS,
	type ScheduledTask,
	type ScheduledTaskListResponse,
	TASK_VALIDATION_DETAILS,
	type TaskSchedule,
	taskSkipCodeSchema,
	type UpdateScheduledTaskRequest,
} from "@research/contracts";
import {
	decideTaskTick,
	emptyWorkspaceState,
	epochMsToIso,
	isoToEpochMs,
	isTerminalJobState,
	nextRunAtMs,
	ok,
} from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AuditLog,
	Clock,
	Hasher,
	IdGenerator,
	JobRepository,
	ResearchUnitOfWork,
	ScheduledTaskPatch,
	ScheduledTaskRepository,
	ScheduledTaskRunState,
	StoredScheduledTask,
	WorkspaceRecord,
	WorkspaceRepository,
} from "./ports.ts";
import type { ResearchRunService } from "./researchRuns.ts";
import { MAX_WORKSPACES } from "./workspaces.ts";

/**
 * Scheduled tasks (ADR-0033): a research question that runs on a schedule
 * in its own conversation. No cron: due tasks fire when a runner claims
 * work (`materializeDue`, called from `runnerJobs.claim`).
 */

const CAS_RETRIES = 4;
/** `idempotencyKeySchema` allows at most 64 characters; `task_` takes five. */
const OCCURRENCE_KEY_HEX_CHARS = 59;
/** Hex characters of the key digest a create derives its task id from. */
const TASK_ID_HEX_CHARS = 32;

export interface ScheduledTaskServiceDeps {
	readonly scheduledTasks: ScheduledTaskRepository;
	readonly unitOfWork: Pick<ResearchUnitOfWork, "createScheduledTask">;
	/** The last run's state (the "wait" rule and single-task views). */
	readonly jobs: Pick<JobRepository, "get">;
	/** Queues the runs, under the same admission rules as the owner's own questions. */
	readonly runs: Pick<ResearchRunService, "createForTask" | "get">;
	/** The conversation cap a task's own conversation counts against. */
	readonly workspaces: Pick<WorkspaceRepository, "list">;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly hasher: Hasher;
	readonly audit: AuditLog;
}

/** A created task, and whether its idempotency key answered an earlier create. */
export interface CreatedTask {
	readonly task: ScheduledTask;
	readonly replayed: boolean;
}

/** "Run now": the task, the run it queued (or its unfinished one), and whether that run already existed. */
export interface RanTask {
	readonly task: ScheduledTask;
	readonly run: ResearchRun;
	readonly replayed: boolean;
}

/** What one claim-time pass did, for tests and callers that count. */
export interface MaterializeSummary {
	readonly fired: number;
	readonly skipped: number;
	readonly waiting: number;
	/** Refused for a reason that is not a skip (left due; the next claim tries again). */
	readonly failed: number;
}

/** Mutable copy of a stored schedule for the response shape. */
function scheduleView(schedule: TaskSchedule): ScheduledTask["schedule"] {
	return schedule.kind === "weekly" ? { ...schedule, days: [...schedule.days] } : { ...schedule };
}

export function toScheduledTaskView(
	task: StoredScheduledTask,
	lastRun: ScheduledTaskRunState | null,
): ScheduledTask {
	return {
		taskId: task.taskId,
		workspaceId: task.workspaceId,
		title: task.title,
		question: task.question,
		horizonYears: task.horizonYears,
		markets: [...task.markets],
		schedule: scheduleView(task.schedule),
		timeZone: task.timeZone,
		spendConsent: task.spendConsent,
		status: task.status,
		nextRunAt: task.nextRunAt,
		lastRun:
			task.lastRunId === null || lastRun === null
				? null
				: {
						runId: task.lastRunId,
						state: lastRun.state,
						slotAt: task.lastSlotAt,
						queuedAt: task.lastQueuedAt ?? task.updatedAt,
						failureCode: lastRun.failureCode,
						failureUpstreamStatus: lastRun.failureUpstreamStatus,
					},
		lastSkip: task.lastSkip,
		version: task.version,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
}

const notFound = (): UseCaseResult<never> => fail("NOT_FOUND", "Scheduled task not found.");

const inPast = (): UseCaseResult<never> =>
	fail(
		"VALIDATION_FAILED",
		"The task's time has already passed; choose a later date or time.",
		TASK_VALIDATION_DETAILS.inPast,
	);

const tasksFull = (): UseCaseResult<never> =>
	fail(
		"VALIDATION_FAILED",
		`At most ${SCHEDULED_TASK_LIMITS.maxActive} active and ${SCHEDULED_TASK_LIMITS.maxTasks} scheduled tasks are allowed.`,
		TASK_VALIDATION_DETAILS.full,
	);

const versionConflict = (): UseCaseResult<never> =>
	fail("VERSION_CONFLICT", "The task changed since it was loaded; reload it and try again.");

export function createScheduledTaskService(deps: ScheduledTaskServiceDeps) {
	async function runStateOf(
		ownerId: string,
		task: StoredScheduledTask,
	): Promise<ScheduledTaskRunState | null> {
		if (task.lastRunId === null) return null;
		const job = await deps.jobs.get(ownerId, task.lastRunId);
		return job === null
			? null
			: {
					state: job.state,
					failureCode: job.failureCode,
					failureUpstreamStatus: job.failureUpstreamStatus,
				};
	}

	async function viewOf(ownerId: string, task: StoredScheduledTask): Promise<ScheduledTask> {
		return toScheduledTaskView(task, await runStateOf(ownerId, task));
	}

	/** The idempotency key of one occurrence: the same task and slot always yield the same key. */
	async function occurrenceKey(taskId: string, slotAt: string): Promise<string> {
		const digest = await deps.hasher.sha256Hex(`${taskId}\n${slotAt}`);
		return `task_${digest.slice(0, OCCURRENCE_KEY_HEX_CHARS)}`;
	}

	function questionOf(task: StoredScheduledTask) {
		return {
			workspaceId: task.workspaceId,
			question: task.question,
			horizonYears: task.horizonYears,
			markets: [...task.markets],
		};
	}

	/**
	 * One due task at one claim (ADR-0033 §2, §3). The run is created first
	 * under the occurrence's key, then the task advances by compare-and-set:
	 * a crash between the two replays the key on the next claim (no second
	 * run), and of two concurrent claims one inserts and one advances.
	 */
	async function tick(
		ownerId: string,
		task: StoredScheduledTask,
		nowMs: number,
		nowIso: string,
	): Promise<keyof MaterializeSummary | null> {
		const lastRun = await runStateOf(ownerId, task);
		const decision = decideTaskTick(
			{
				status: task.status,
				nextRunAtMs: task.nextRunAt === null ? null : isoToEpochMs(task.nextRunAt),
				hasUnfinishedRun: lastRun !== null && !isTerminalJobState(lastRun.state),
			},
			nowMs,
			(afterMs) => nextRunAtMs(task.schedule, task.timeZone, afterMs),
		);
		if (decision.kind === "idle") return null;
		if (decision.kind === "wait") return "waiting";
		const slotAt = epochMsToIso(decision.slotMs);
		const advance: ScheduledTaskPatch = {
			status: decision.status,
			nextRunAt: decision.nextRunAtMs === null ? null : epochMsToIso(decision.nextRunAtMs),
		};
		const created = await deps.runs.createForTask(ownerId, {
			taskId: task.taskId,
			question: questionOf(task),
			spendConsent: task.spendConsent,
			idempotencyKey: await occurrenceKey(task.taskId, slotAt),
			requestFingerprint: `task:${task.taskId}:${slotAt}`,
			actor: "scheduler",
		});
		if (created.ok) {
			const { run } = created.value;
			const written = await deps.scheduledTasks.write(
				ownerId,
				task.taskId,
				task.version,
				// A queued run clears an older skip: whatever stopped that
				// occurrence no longer stops this one.
				{
					...advance,
					lastRunId: run.runId,
					lastSlotAt: slotAt,
					lastQueuedAt: run.createdAt,
					lastSkip: null,
				},
				nowIso,
				SCHEDULED_TASK_LIMITS.maxActive,
			);
			if (written) {
				await deps.audit.record({
					ownerId,
					actor: "scheduler",
					action: "scheduled_task.fire",
					resource: task.taskId,
					detail: `run=${run.runId} slot=${slotAt}`,
					at: nowIso,
				});
			}
			return "fired";
		}
		const skip = taskSkipCodeSchema.safeParse(created.error.code);
		if (!skip.success) return "failed";
		// §3: a refused occurrence is skipped and the schedule advances as
		// if it had fired; retrying on every claim would burn the hourly
		// allowance the owner's own questions need.
		const written = await deps.scheduledTasks.write(
			ownerId,
			task.taskId,
			task.version,
			{ ...advance, lastSkip: { code: skip.data, slotAt, at: nowIso } },
			nowIso,
			SCHEDULED_TASK_LIMITS.maxActive,
		);
		if (written) {
			await deps.audit.record({
				ownerId,
				actor: "scheduler",
				action: "scheduled_task.skip",
				resource: task.taskId,
				detail: `code=${skip.data} slot=${slotAt}`,
				at: nowIso,
			});
		}
		return "skipped";
	}

	return {
		/** Every task of the owner with its last run's state (one query) and the limits. */
		async list(ownerId: string): Promise<UseCaseResult<ScheduledTaskListResponse>> {
			const rows = await deps.scheduledTasks.list(ownerId);
			return ok({
				tasks: rows.map((row) => toScheduledTaskView(row.task, row.lastRun)),
				limits: {
					maxActive: SCHEDULED_TASK_LIMITS.maxActive,
					maxTasks: SCHEDULED_TASK_LIMITS.maxTasks,
				},
			});
		},

		/**
		 * Creates an active task and its conversation (ADR-0033 §1, §7). The
		 * task id derives from the idempotency key, so a repeated key answers
		 * the task it created. Errors: `VALIDATION_FAILED` with
		 * `SCHEDULE_IN_PAST` (a `once` whose time has passed) or `TASKS_FULL`.
		 */
		async create(
			ownerId: string,
			request: CreateScheduledTaskRequest,
			idempotencyKey: string,
		): Promise<UseCaseResult<CreatedTask>> {
			const digest = await deps.hasher.sha256Hex(`scheduled-task\n${idempotencyKey}`);
			const taskId = `task_${digest.slice(0, TASK_ID_HEX_CHARS)}`;
			const existing = await deps.scheduledTasks.get(ownerId, taskId);
			if (existing !== null) return ok({ task: await viewOf(ownerId, existing), replayed: true });

			const nowMs = deps.clock.nowMs();
			const now = deps.clock.nowIso();
			const next = nextRunAtMs(request.schedule, request.timeZone, nowMs);
			if (next === null) return inPast();
			if ((await deps.workspaces.list(ownerId)).length >= MAX_WORKSPACES) {
				return fail(
					"CONFLICT",
					`At most ${MAX_WORKSPACES} conversations are allowed; delete one to add a task.`,
				);
			}
			const workspaceId = deps.ids.newId("ws");
			const workspace: WorkspaceRecord = {
				summary: { workspaceId, title: request.title, version: 0, createdAt: now, updatedAt: now },
				state: emptyWorkspaceState(workspaceId),
			};
			const task: StoredScheduledTask = {
				ownerId,
				taskId,
				workspaceId,
				title: request.title,
				question: request.question,
				horizonYears: request.horizonYears,
				markets: request.markets,
				schedule: request.schedule,
				timeZone: request.timeZone,
				spendConsent: request.spendConsent,
				status: "active",
				nextRunAt: epochMsToIso(next),
				lastRunId: null,
				lastSlotAt: null,
				lastQueuedAt: null,
				lastSkip: null,
				version: 0,
				createdAt: now,
				updatedAt: now,
			};
			const outcome = await deps.unitOfWork.createScheduledTask({
				ownerId,
				workspace,
				task,
				maxTasks: SCHEDULED_TASK_LIMITS.maxTasks,
				maxActive: SCHEDULED_TASK_LIMITS.maxActive,
			});
			if (outcome === "full") {
				// The guarded insert also refuses a task id that already
				// exists: a concurrent create with the same key won.
				const raced = await deps.scheduledTasks.get(ownerId, taskId);
				if (raced !== null) return ok({ task: await viewOf(ownerId, raced), replayed: true });
				return tasksFull();
			}
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "scheduled_task.create",
				resource: taskId,
				detail: `kind=${request.schedule.kind} workspace=${workspaceId}`,
				at: now,
			});
			return ok({ task: toScheduledTaskView(task, null), replayed: false });
		},

		/**
		 * Edit, pause (`status: "paused"`) or resume (`status: "active"`),
		 * compare-and-set on `expectedVersion` (ADR-0033 §5). An active task
		 * whose schedule, zone or status changed gets its next run from now;
		 * pausing clears it. Errors: `NOT_FOUND`, `VERSION_CONFLICT`,
		 * `VALIDATION_FAILED` with `SCHEDULE_IN_PAST`, `TASKS_FULL` (resume
		 * over the active limit) or `TASK_COMPLETED` (pausing a completed task).
		 */
		async update(
			ownerId: string,
			taskId: string,
			request: UpdateScheduledTaskRequest,
		): Promise<UseCaseResult<ScheduledTask>> {
			const task = await deps.scheduledTasks.get(ownerId, taskId);
			if (task === null) return notFound();
			if (task.version !== request.expectedVersion) return versionConflict();
			if (task.status === "completed" && request.status === "paused") {
				return fail(
					"VALIDATION_FAILED",
					"A completed task cannot be paused; edit its schedule and resume it instead.",
					TASK_VALIDATION_DETAILS.completed,
				);
			}
			const status = request.status ?? task.status;
			const schedule = request.schedule ?? task.schedule;
			const timeZone = request.timeZone ?? task.timeZone;
			const timingChanged =
				request.schedule !== undefined ||
				request.timeZone !== undefined ||
				status !== task.status ||
				task.nextRunAt === null;
			let nextRunAt: string | null = null;
			if (status === "active") {
				// An edit that leaves the timing alone keeps the pending
				// occurrence (a due task waiting for its last run still fires).
				nextRunAt = task.nextRunAt;
				if (timingChanged) {
					const next = nextRunAtMs(schedule, timeZone, deps.clock.nowMs());
					if (next === null) return inPast();
					nextRunAt = epochMsToIso(next);
				}
			}
			const patch: ScheduledTaskPatch = {
				title: request.title,
				question: request.question,
				horizonYears: request.horizonYears,
				markets: request.markets,
				schedule: request.schedule,
				timeZone: request.timeZone,
				spendConsent: request.spendConsent,
				status,
				nextRunAt,
			};
			const now = deps.clock.nowIso();
			const written = await deps.scheduledTasks.write(
				ownerId,
				taskId,
				task.version,
				patch,
				now,
				SCHEDULED_TASK_LIMITS.maxActive,
			);
			const current = await deps.scheduledTasks.get(ownerId, taskId);
			if (current === null) return notFound();
			if (!written) return current.version !== task.version ? versionConflict() : tasksFull();
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "scheduled_task.update",
				resource: taskId,
				detail: `status=${status}`,
				at: now,
			});
			return ok(await viewOf(ownerId, current));
		},

		/** Deletes the task; its conversation (the answers) stays. Errors: `NOT_FOUND`. */
		async remove(ownerId: string, taskId: string): Promise<UseCaseResult<void>> {
			if (!(await deps.scheduledTasks.delete(ownerId, taskId))) return notFound();
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "scheduled_task.delete",
				resource: taskId,
				detail: "",
				at: deps.clock.nowIso(),
			});
			return ok(undefined);
		},

		/**
		 * Queues one run now without moving the schedule (ADR-0033 §5). While
		 * the task's last run is unfinished it answers that run instead of a
		 * second one. Errors: `NOT_FOUND` and the run service's refusals
		 * (`AGENT_NOT_CONFIGURED`, `RATE_LIMITED`, …).
		 */
		async runNow(
			ownerId: string,
			taskId: string,
			idempotencyKey: string,
		): Promise<UseCaseResult<RanTask>> {
			const task = await deps.scheduledTasks.get(ownerId, taskId);
			if (task === null) return notFound();
			const lastRun = await runStateOf(ownerId, task);
			if (task.lastRunId !== null && lastRun !== null && !isTerminalJobState(lastRun.state)) {
				const unfinished = await deps.runs.get(ownerId, task.lastRunId);
				if (unfinished.ok) {
					return ok({
						task: toScheduledTaskView(task, lastRun),
						run: unfinished.value,
						replayed: true,
					});
				}
			}
			const created = await deps.runs.createForTask(ownerId, {
				taskId,
				question: questionOf(task),
				spendConsent: task.spendConsent,
				idempotencyKey,
				requestFingerprint: `task-run:${taskId}`,
				actor: "owner",
			});
			if (!created.ok) return created;
			const { run, replayed } = created.value;
			// Record the run as the task's last one. The claim-time firing may
			// advance the task concurrently, so the compare-and-set retries.
			let current: StoredScheduledTask | null = task;
			for (let attempt = 0; attempt < CAS_RETRIES && current !== null; attempt += 1) {
				if (current.lastRunId === run.runId) break;
				const written = await deps.scheduledTasks.write(
					ownerId,
					taskId,
					current.version,
					{ lastRunId: run.runId, lastSlotAt: null, lastQueuedAt: run.createdAt },
					deps.clock.nowIso(),
					SCHEDULED_TASK_LIMITS.maxActive,
				);
				current = await deps.scheduledTasks.get(ownerId, taskId);
				if (written) break;
			}
			if (current === null) return notFound();
			if (!replayed) {
				await deps.audit.record({
					ownerId,
					actor: "owner",
					action: "scheduled_task.run_now",
					resource: taskId,
					detail: `run=${run.runId}`,
					at: deps.clock.nowIso(),
				});
			}
			return ok({ task: await viewOf(ownerId, current), run, replayed });
		},

		/**
		 * The claim-time firing (ADR-0033 §2): one indexed read of the
		 * owner's due tasks, and writes only for those. Called by
		 * `runnerJobs.claim` before it scans claim candidates, so a fired
		 * task's run is claimed in the same request.
		 */
		async materializeDue(ownerId: string): Promise<MaterializeSummary> {
			const nowMs = deps.clock.nowMs();
			const nowIso = deps.clock.nowIso();
			const due = await deps.scheduledTasks.listDue(
				ownerId,
				nowIso,
				SCHEDULED_TASK_LIMITS.maxActive,
			);
			const summary = { fired: 0, skipped: 0, waiting: 0, failed: 0 };
			for (const task of due) {
				const outcome = await tick(ownerId, task, nowMs, nowIso);
				if (outcome !== null) summary[outcome] += 1;
			}
			return summary;
		},
	};
}

export type ScheduledTaskService = ReturnType<typeof createScheduledTaskService>;
