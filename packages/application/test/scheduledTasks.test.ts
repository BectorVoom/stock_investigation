/**
 * Scheduled tasks (ADR-0033): the service over in-memory stores, with the
 * REAL research-run service underneath, so the claim-time firing is pinned
 * together with the admission and backend rules it relies on.
 */
import type { AgentSettings, CreateScheduledTaskRequest } from "@research/contracts";
import { runBudget, TASK_VALIDATION_DETAILS } from "@research/contracts";
import { emptyWorkspaceState, type JobState } from "@research/domain";
import { describe, expect, it } from "vitest";
import type {
	AuditEntry,
	EnqueueResult,
	JobRecord,
	JobRepository,
	ResearchUnitOfWork,
	ScheduledTaskPatch,
	ScheduledTaskRepository,
	StoredScheduledTask,
	WorkspaceRecord,
	WorkspaceRepository,
} from "../src/ports.ts";
import { createResearchRunService } from "../src/researchRuns.ts";
import { createScheduledTaskService } from "../src/scheduledTasks.ts";
import { MAX_WORKSPACES } from "../src/workspaces.ts";
import { fixedClock } from "./support.ts";

const OWNER = "owner_1";
const START = "2026-10-24T00:00:00.000Z";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const PLAN_SETTINGS: AgentSettings = {
	defaultAgentId: "claude-code",
	models: {},
	effort: "high",
	budget: runBudget(null),
	webAccess: "public-web",
};

/** `openrouter` is metered by default (no runner report needed). */
const METERED_SETTINGS: AgentSettings = {
	defaultAgentId: "openrouter",
	models: { openrouter: "vendor/model" },
	effort: "medium",
	budget: runBudget(2),
	webAccess: "off",
};

function taskRequest(
	overrides: Partial<CreateScheduledTaskRequest> = {},
): CreateScheduledTaskRequest {
	return {
		title: "Morning brief",
		question: "What moved Japanese semiconductor stocks overnight?",
		horizonYears: 3,
		markets: ["JP"],
		schedule: { kind: "daily", time: "06:00" },
		timeZone: "UTC",
		spendConsent: null,
		...overrides,
	};
}

interface StoredJob {
	job: JobRecord;
	readonly key: string;
	readonly fingerprint: string;
}

/** In-memory stores with the storage semantics the ports document (CAS, guarded limits). */
function world(options: { settings?: AgentSettings | null; allowance?: number } = {}) {
	const time = fixedClock(START);
	let settings = options.settings === undefined ? PLAN_SETTINGS : options.settings;
	let allowance = options.allowance ?? 100;
	const tasks = new Map<string, StoredScheduledTask>();
	const workspaces = new Map<string, WorkspaceRecord>();
	const jobs = new Map<string, StoredJob>();
	const audits: AuditEntry[] = [];
	/** Number of upcoming task writes to lose (a crash or a concurrent claim). */
	let loseWrites = 0;
	let idCounter = 0;

	const unused = (): never => {
		throw new Error("not used by this test");
	};

	const taskRepository: ScheduledTaskRepository = {
		async latestResult() {
			return null;
		},
		async list() {
			const rank = { active: 0, paused: 1, completed: 2 };
			return [...tasks.values()]
				.sort(
					(a, b) =>
						rank[a.status] - rank[b.status] ||
						(a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "") ||
						b.createdAt.localeCompare(a.createdAt),
				)
				.map((task) => {
					const job = task.lastRunId === null ? undefined : jobs.get(task.lastRunId)?.job;
					return {
						task,
						lastRun:
							job === undefined
								? null
								: {
										state: job.state,
										failureCode: job.failureCode,
										failureUpstreamStatus: job.failureUpstreamStatus,
									},
					};
				});
		},
		get: async (_owner, taskId) => tasks.get(taskId) ?? null,
		async listDue(_owner, nowIso, limit) {
			return [...tasks.values()]
				.filter(
					(task) => task.status === "active" && task.nextRunAt !== null && task.nextRunAt <= nowIso,
				)
				.sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""))
				.slice(0, limit);
		},
		async counts() {
			const all = [...tasks.values()];
			return { total: all.length, active: all.filter((task) => task.status === "active").length };
		},
		async write(_owner, taskId, expectedVersion, patch: ScheduledTaskPatch, at, maxActive) {
			const task = tasks.get(taskId);
			if (task === undefined || task.version !== expectedVersion) return false;
			if (loseWrites > 0) {
				loseWrites -= 1;
				return false;
			}
			const active = [...tasks.values()].filter((other) => other.status === "active").length;
			if (patch.status === "active" && task.status !== "active" && active >= maxActive)
				return false;
			const defined = Object.fromEntries(
				Object.entries(patch).filter(([, value]) => value !== undefined),
			);
			tasks.set(taskId, { ...task, ...defined, version: task.version + 1, updatedAt: at });
			return true;
		},
		delete: async (_owner, taskId) => tasks.delete(taskId),
	};

	const unitOfWork: ResearchUnitOfWork = {
		async enqueueResearch({ job, idempotencyKey, requestFingerprint, maxUnfinished }) {
			const existing = [...jobs.values()].find((stored) => stored.key === idempotencyKey);
			if (existing !== undefined) {
				const outcome: EnqueueResult = {
					kind: "existing",
					job: existing.job,
					sameRequest: existing.fingerprint === requestFingerprint,
				};
				return outcome;
			}
			const unfinished = [...jobs.values()].filter(
				(stored) => !["completed", "failed", "cancelled", "partial"].includes(stored.job.state),
			).length;
			if (unfinished >= maxUnfinished) return { kind: "at-capacity" };
			jobs.set(job.runId, { job, key: idempotencyKey, fingerprint: requestFingerprint });
			return { kind: "inserted" };
		},
		commitCompletion: unused,
		importWorkspace: unused,
		deleteWorkspace: unused,
		async createScheduledTask({ workspace, task, maxTasks, maxActive }) {
			const all = [...tasks.values()];
			const active = all.filter((other) => other.status === "active").length;
			if (
				tasks.has(task.taskId) ||
				all.length >= maxTasks ||
				(task.status === "active" && active >= maxActive)
			) {
				return "full";
			}
			workspaces.set(workspace.summary.workspaceId, workspace);
			tasks.set(task.taskId, task);
			return "created";
		},
	};

	const jobRepository: JobRepository = {
		insert: unused,
		async findByIdempotencyKey(_owner, key) {
			const stored = [...jobs.values()].find((entry) => entry.key === key);
			return stored === undefined
				? null
				: { job: stored.job, requestFingerprint: stored.fingerprint };
		},
		get: async (_owner, runId) => jobs.get(runId)?.job ?? null,
		list: unused,
		findLatestResearchRequest: unused,
		listClaimCandidates: unused,
		write: unused,
		writeWithEvents: unused,
		listProgress: async () => [],
		findActiveByKind: unused,
		findActiveNotebookAssist: unused,
		findLatestSuccessAtByKind: unused,
		findLatestFailureByKind: unused,
		findLatestFailedByKind: unused,
		countUnfinished: unused,
	};

	const workspaceRepository: WorkspaceRepository = {
		list: unused,
		get: async (_owner, workspaceId) => workspaces.get(workspaceId) ?? null,
		insert: unused,
		rename: unused,
		listRecords: unused,
		findCommand: unused,
		listCommandsAfter: unused,
		write: unused,
	};

	const ids = { newId: (prefix: string) => `${prefix}_${++idCounter}` };
	const hasher = {
		// Deterministic and input-sensitive, like SHA-256 (tests need distinct keys per slot).
		async sha256Hex(text: string) {
			let hash = 0;
			for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
			return hash.toString(16).padStart(8, "0").repeat(8);
		},
	};
	const audit = { record: async (entry: AuditEntry) => void audits.push(entry) };
	const runs = createResearchRunService({
		jobs: jobRepository,
		workspaces: workspaceRepository,
		records: {
			resolve: unused,
			recordsForRuns: unused,
			claimsByIds: unused,
			runIdsForWorkspace: unused,
			datasetsForWorkspace: unused,
		},
		runnerStatus: { get: async () => null, put: unused },
		settings: {
			getAgentSettings: async () => (settings === null ? null : { settings, updatedAt: START }),
		},
		unitOfWork,
		clock: time.clock,
		ids,
		hasher,
		rateLimiter: {
			consume: async () => {
				allowance -= 1;
				return allowance >= 0;
			},
		},
		audit,
		googleCalendar: {
			get: unused,
			setConnecting: unused,
			setPendingAuthUrl: unused,
			apply: unused,
		},
	});
	const service = createScheduledTaskService({
		scheduledTasks: taskRepository,
		unitOfWork,
		jobs: jobRepository,
		runs,
		workspaces: {
			list: async () => [...workspaces.values()].map((record) => record.summary),
		},
		clock: time.clock,
		ids,
		hasher,
		audit,
	});

	return {
		service,
		time,
		tasks,
		jobs,
		workspaces,
		audits,
		setSettings(next: AgentSettings | null) {
			settings = next;
		},
		setAllowance(next: number) {
			allowance = next;
		},
		loseNextWrite() {
			loseWrites += 1;
		},
		finishRun(runId: string, state: JobState = "completed") {
			const stored = jobs.get(runId);
			if (stored === undefined) throw new Error(`no run ${runId}`);
			stored.job = { ...stored.job, state };
		},
		researchJobs: () => [...jobs.values()].map((stored) => stored.job),
	};
}

type World = ReturnType<typeof world>;

let keyCounter = 0;
const freshKey = () => `key_${(++keyCounter).toString().padStart(8, "0")}`;

async function createTask(w: World, overrides: Partial<CreateScheduledTaskRequest> = {}) {
	const created = await w.service.create(OWNER, taskRequest(overrides), freshKey());
	if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
	return created.value.task;
}

function stored(w: World, taskId: string): StoredScheduledTask {
	const task = w.tasks.get(taskId);
	if (task === undefined) throw new Error(`no task ${taskId}`);
	return task;
}

describe("creating a task (ADR-0033 §1)", () => {
	it("stores an active task with its own titled conversation and its next run", async () => {
		const w = world();
		const task = await createTask(w, {
			schedule: { kind: "daily", time: "09:00" },
			timeZone: "Asia/Tokyo",
		});
		expect(task.status).toBe("active");
		// 09:00 in Tokyo (UTC+9) is 00:00 UTC — strictly after now, so tomorrow's.
		expect(task.nextRunAt).toBe("2026-10-25T00:00:00.000Z");
		expect(w.workspaces.get(task.workspaceId)?.summary.title).toBe("Morning brief");
		expect(task.lastRun).toBe(null);
		expect(w.audits.map((entry) => entry.action)).toEqual(["scheduled_task.create"]);
	});

	it("answers a repeated idempotency key with the task it created", async () => {
		const w = world();
		const key = freshKey();
		const first = await w.service.create(OWNER, taskRequest(), key);
		const second = await w.service.create(OWNER, taskRequest(), key);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.value).toEqual({ task: first.value.task, replayed: true });
		expect(w.workspaces.size).toBe(1);
	});

	it("refuses a once task whose time has passed", async () => {
		const w = world();
		const created = await w.service.create(
			OWNER,
			taskRequest({ schedule: { kind: "once", date: "2026-10-23", time: "09:00" } }),
			freshKey(),
		);
		expect(created).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", detail: TASK_VALIDATION_DETAILS.inPast },
		});
		expect(w.tasks.size).toBe(0);
	});

	it("refuses an eleventh active task", async () => {
		const w = world();
		for (let index = 0; index < 10; index += 1) await createTask(w);
		const created = await w.service.create(OWNER, taskRequest(), freshKey());
		expect(created).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", detail: TASK_VALIDATION_DETAILS.full },
		});
		expect(w.workspaces.size).toBe(10);
	});
});

describe("firing at claim time (ADR-0033 §2)", () => {
	it("does nothing before the task is due", async () => {
		const w = world();
		await createTask(w);
		expect(await w.service.materializeDue(OWNER)).toEqual({
			fired: 0,
			skipped: 0,
			waiting: 0,
			failed: 0,
		});
		expect(w.researchJobs()).toEqual([]);
	});

	it("queues the task's question in its conversation on the saved agent, once per slot", async () => {
		const w = world();
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS + 1_000);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		const [run] = w.researchJobs();
		expect(run?.request).toMatchObject({
			workspaceId: task.workspaceId,
			question: task.question,
			horizonYears: 3,
			markets: ["JP"],
			agentId: "claude-code",
			effort: "high",
			webAccess: "public-web",
			budget: { maxSpendUsd: null },
		});
		expect(stored(w, task.taskId)).toMatchObject({
			nextRunAt: "2026-10-25T06:00:00.000Z",
			lastRunId: run?.runId,
			lastSlotAt: "2026-10-24T06:00:00.000Z",
			status: "active",
		});
		// The next claim, even after the run finished, finds nothing due.
		if (run !== undefined) w.finishRun(run.runId);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(0);
		expect(w.researchJobs()).toHaveLength(1);
		expect(w.audits.map((entry) => entry.action)).toContain("scheduled_task.fire");
	});

	it("collapses every slot missed while no runner polled into one run", async () => {
		const w = world();
		const task = await createTask(w);
		w.time.advance(3 * DAY_MS + 7 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(w.researchJobs()).toHaveLength(1);
		// Next run strictly after now (2026-10-27T07:00Z): tomorrow's 06:00, not a missed one.
		expect(stored(w, task.taskId).nextRunAt).toBe("2026-10-28T06:00:00.000Z");
		expect(stored(w, task.taskId).lastSlotAt).toBe("2026-10-24T06:00:00.000Z");
	});

	it("waits while the last run is unfinished and fires once it has finished", async () => {
		const w = world();
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS);
		await w.service.materializeDue(OWNER);
		const first = stored(w, task.taskId).lastRunId;
		w.time.advance(DAY_MS);
		expect(await w.service.materializeDue(OWNER)).toMatchObject({ fired: 0, waiting: 1 });
		expect(w.researchJobs()).toHaveLength(1);
		if (first !== null) w.finishRun(first, "failed");
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(w.researchJobs()).toHaveLength(2);
	});

	it("replays the occurrence's run when the advance after it was lost", async () => {
		const w = world();
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS);
		w.loseNextWrite();
		await w.service.materializeDue(OWNER);
		expect(w.researchJobs()).toHaveLength(1);
		expect(stored(w, task.taskId).nextRunAt).toBe("2026-10-24T06:00:00.000Z");
		// The run exists but is pending, and the task did not record it: the
		// same slot replays its key instead of queuing a second run.
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(w.researchJobs()).toHaveLength(1);
		expect(stored(w, task.taskId).lastRunId).toBe(w.researchJobs()[0]?.runId);
	});

	it("completes a once task when it fires", async () => {
		const w = world();
		const task = await createTask(w, {
			schedule: { kind: "once", date: "2026-10-24", time: "12:00" },
		});
		w.time.advance(12 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(stored(w, task.taskId)).toMatchObject({ status: "completed", nextRunAt: null });
	});
});

describe("refused occurrences are skipped (ADR-0033 §3)", () => {
	it("records the hourly allowance refusal and advances the schedule", async () => {
		const w = world({ allowance: 0 });
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).skipped).toBe(1);
		expect(w.researchJobs()).toEqual([]);
		expect(stored(w, task.taskId)).toMatchObject({
			nextRunAt: "2026-10-25T06:00:00.000Z",
			lastSkip: {
				code: "RATE_LIMITED",
				slotAt: "2026-10-24T06:00:00.000Z",
				at: "2026-10-24T06:00:00.000Z",
			},
		});
		// Not retried on the next claim, and the next fire clears the skip.
		expect((await w.service.materializeDue(OWNER)).skipped).toBe(0);
		w.setAllowance(10);
		w.time.advance(DAY_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(stored(w, task.taskId).lastSkip).toBe(null);
	});

	it("skips while no backend is saved in Settings → AI agent", async () => {
		const w = world({ settings: null });
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS);
		await w.service.materializeDue(OWNER);
		expect(stored(w, task.taskId).lastSkip?.code).toBe("AGENT_NOT_CONFIGURED");
	});

	it("skips a backend that needs a model when none is saved", async () => {
		const w = world({ settings: { ...PLAN_SETTINGS, defaultAgentId: "opencode" } });
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS);
		await w.service.materializeDue(OWNER);
		expect(stored(w, task.taskId).lastSkip?.code).toBe("VALIDATION_FAILED");
	});

	it("skips a backend no runner has reported", async () => {
		const w = world({ settings: { ...PLAN_SETTINGS, defaultAgentId: "mystery-agent" } });
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS);
		await w.service.materializeDue(OWNER);
		expect(stored(w, task.taskId).lastSkip?.code).toBe("UNKNOWN_AGENT");
	});
});

describe("optional spending caps on a metered backend (ADR-0035)", () => {
	it("fires without consent or a spending cap", async () => {
		const w = world({ settings: { ...METERED_SETTINGS, budget: runBudget(null) } });
		const task = await createTask(w);
		w.time.advance(6 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(stored(w, task.taskId).lastSkip).toBeNull();
		expect(w.researchJobs()[0]?.request).toMatchObject({ budget: { maxSpendUsd: null } });
	});

	it("fires under a consent equal to the saved backend, model and ceiling", async () => {
		const w = world({ settings: METERED_SETTINGS });
		await createTask(w, {
			spendConsent: { agentId: "openrouter", model: "vendor/model", maxSpendUsd: 2 },
		});
		w.time.advance(6 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(w.researchJobs()[0]?.request).toMatchObject({
			agentId: "openrouter",
			model: "vendor/model",
			budget: { maxSpendUsd: 2 },
		});
	});

	it("uses the current saved model and cap regardless of legacy consent", async () => {
		const w = world({ settings: METERED_SETTINGS });
		await createTask(w, {
			spendConsent: { agentId: "openrouter", model: "vendor/model", maxSpendUsd: 2 },
		});
		w.setSettings({
			...METERED_SETTINGS,
			models: { openrouter: "vendor/other" },
			budget: runBudget(5),
		});
		w.time.advance(6 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		expect(w.researchJobs()[0]?.request).toMatchObject({
			model: "vendor/other",
			budget: { maxSpendUsd: 5 },
		});
	});

	it("needs no consent on a plan-limited backend", async () => {
		const w = world({ settings: { ...PLAN_SETTINGS, budget: runBudget(3) } });
		await createTask(w);
		w.time.advance(6 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(1);
		// A plan-limited backend never carries a spend allowance.
		expect(w.researchJobs()[0]?.request).toMatchObject({ budget: { maxSpendUsd: null } });
	});
});

describe("pause, resume and edit (ADR-0033 §5)", () => {
	it("pauses (no next run, never fires) and resumes from now, skipping what was missed", async () => {
		const w = world();
		const task = await createTask(w);
		const paused = await w.service.update(OWNER, task.taskId, {
			expectedVersion: 0,
			status: "paused",
		});
		expect(paused).toMatchObject({
			ok: true,
			value: { status: "paused", nextRunAt: null, version: 1 },
		});
		w.time.advance(2 * DAY_MS + 7 * HOUR_MS);
		expect((await w.service.materializeDue(OWNER)).fired).toBe(0);
		const resumed = await w.service.update(OWNER, task.taskId, {
			expectedVersion: 1,
			status: "active",
		});
		expect(resumed).toMatchObject({
			ok: true,
			value: { status: "active", nextRunAt: "2026-10-27T06:00:00.000Z" },
		});
		expect((await w.service.materializeDue(OWNER)).fired).toBe(0);
	});

	it("refuses a resume over the active limit", async () => {
		const w = world();
		const task = await createTask(w);
		await w.service.update(OWNER, task.taskId, { expectedVersion: 0, status: "paused" });
		for (let index = 0; index < 10; index += 1) await createTask(w);
		const resumed = await w.service.update(OWNER, task.taskId, {
			expectedVersion: 1,
			status: "active",
		});
		expect(resumed).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", detail: TASK_VALIDATION_DETAILS.full },
		});
	});

	it("answers VERSION_CONFLICT for a stale expected version", async () => {
		const w = world();
		const task = await createTask(w);
		await w.service.update(OWNER, task.taskId, { expectedVersion: 0, title: "Renamed" });
		const stale = await w.service.update(OWNER, task.taskId, {
			expectedVersion: 0,
			title: "Again",
		});
		expect(stale).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });
		expect(stored(w, task.taskId).title).toBe("Renamed");
	});

	it("recomputes the next run when the schedule changes and keeps it otherwise", async () => {
		const w = world();
		const task = await createTask(w);
		const retitled = await w.service.update(OWNER, task.taskId, {
			expectedVersion: 0,
			title: "Renamed",
		});
		expect(retitled).toMatchObject({ ok: true, value: { nextRunAt: "2026-10-24T06:00:00.000Z" } });
		const moved = await w.service.update(OWNER, task.taskId, {
			expectedVersion: 1,
			schedule: { kind: "weekly", days: [1], time: "07:30" },
			timeZone: "America/New_York",
		});
		// Monday 2026-10-26 07:30 EDT (UTC-4) = 11:30 UTC.
		expect(moved).toMatchObject({ ok: true, value: { nextRunAt: "2026-10-26T11:30:00.000Z" } });
	});

	it("refuses resuming a completed once task whose time passed, and pausing it", async () => {
		const w = world();
		const task = await createTask(w, {
			schedule: { kind: "once", date: "2026-10-24", time: "01:00" },
		});
		w.time.advance(2 * HOUR_MS);
		await w.service.materializeDue(OWNER);
		const version = stored(w, task.taskId).version;
		expect(stored(w, task.taskId).status).toBe("completed");
		expect(
			await w.service.update(OWNER, task.taskId, { expectedVersion: version, status: "active" }),
		).toMatchObject({ ok: false, error: { detail: TASK_VALIDATION_DETAILS.inPast } });
		expect(
			await w.service.update(OWNER, task.taskId, { expectedVersion: version, status: "paused" }),
		).toMatchObject({ ok: false, error: { detail: TASK_VALIDATION_DETAILS.completed } });
		// A new date brings it back.
		expect(
			await w.service.update(OWNER, task.taskId, {
				expectedVersion: version,
				status: "active",
				schedule: { kind: "once", date: "2026-10-30", time: "01:00" },
			}),
		).toMatchObject({
			ok: true,
			value: { status: "active", nextRunAt: "2026-10-30T01:00:00.000Z" },
		});
	});

	it("answers NOT_FOUND for an unknown task", async () => {
		const w = world();
		expect(
			await w.service.update(OWNER, "task_missing", { expectedVersion: 0, title: "x" }),
		).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
		expect(await w.service.remove(OWNER, "task_missing")).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
	});

	it("deletes the task and keeps its conversation", async () => {
		const w = world();
		const task = await createTask(w);
		expect((await w.service.remove(OWNER, task.taskId)).ok).toBe(true);
		expect(w.tasks.size).toBe(0);
		expect(w.workspaces.has(task.workspaceId)).toBe(true);
	});
});

describe("run now (ADR-0033 §5)", () => {
	it("queues one run without moving the schedule and answers it while unfinished", async () => {
		const w = world();
		const task = await createTask(w);
		const ran = await w.service.runNow(OWNER, task.taskId, freshKey());
		expect(ran).toMatchObject({ ok: true, value: { replayed: false } });
		if (!ran.ok) return;
		expect(ran.value.task).toMatchObject({
			nextRunAt: "2026-10-24T06:00:00.000Z",
			lastRun: { runId: ran.value.run.runId, state: "pending", slotAt: null },
		});
		const again = await w.service.runNow(OWNER, task.taskId, freshKey());
		expect(again).toMatchObject({
			ok: true,
			value: { replayed: true, run: { runId: ran.value.run.runId } },
		});
		expect(w.researchJobs()).toHaveLength(1);
		// Its unfinished run makes the due occurrence wait, too.
		w.time.advance(6 * HOUR_MS);
		expect(await w.service.materializeDue(OWNER)).toMatchObject({ waiting: 1, fired: 0 });
	});

	it("replays a repeated key after the run finished, and queues anew with a new key", async () => {
		const w = world();
		const task = await createTask(w);
		const key = freshKey();
		const ran = await w.service.runNow(OWNER, task.taskId, key);
		if (!ran.ok) throw new Error("run now failed");
		w.finishRun(ran.value.run.runId);
		expect(await w.service.runNow(OWNER, task.taskId, key)).toMatchObject({
			ok: true,
			value: { replayed: true, run: { runId: ran.value.run.runId } },
		});
		expect((await w.service.runNow(OWNER, task.taskId, freshKey())).ok).toBe(true);
		expect(w.researchJobs()).toHaveLength(2);
	});

	it("runs a metered task now without consent or a spending cap", async () => {
		const w = world({ settings: { ...METERED_SETTINGS, budget: runBudget(null) } });
		const task = await createTask(w);
		expect(await w.service.runNow(OWNER, task.taskId, freshKey())).toMatchObject({ ok: true });
		expect(w.researchJobs()[0]?.request).toMatchObject({
			agentId: "openrouter",
			budget: { maxSpendUsd: null },
		});
	});

	it("answers the run service's refusal", async () => {
		const w = world({ settings: null });
		const task = await createTask(w);
		expect(await w.service.runNow(OWNER, task.taskId, freshKey())).toMatchObject({
			ok: false,
			error: { code: "AGENT_NOT_CONFIGURED" },
		});
		expect(await w.service.runNow(OWNER, "task_missing", freshKey())).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
	});
});

describe("the list (ADR-0033 §6)", () => {
	it("orders active by next run, then paused, and carries the last run's state and the limits", async () => {
		const w = world();
		const late = await createTask(w, { title: "Late", schedule: { kind: "daily", time: "20:00" } });
		const early = await createTask(w, {
			title: "Early",
			schedule: { kind: "daily", time: "03:00" },
		});
		const paused = await createTask(w, { title: "Paused" });
		await w.service.update(OWNER, paused.taskId, { expectedVersion: 0, status: "paused" });
		const ran = await w.service.runNow(OWNER, late.taskId, freshKey());
		if (!ran.ok) throw new Error("run now failed");
		w.finishRun(ran.value.run.runId, "failed");
		const list = await w.service.list(OWNER);
		if (!list.ok) throw new Error("list failed");
		expect(list.value.tasks.map((task) => task.title)).toEqual(["Early", "Late", "Paused"]);
		expect(list.value.tasks[1]?.lastRun).toMatchObject({
			runId: ran.value.run.runId,
			state: "failed",
		});
		expect(list.value.limits).toEqual({ maxActive: 10, maxTasks: 30 });
		expect(early.taskId).not.toBe(late.taskId);
	});
});

describe("conversation cap", () => {
	it("refuses a task once the owner keeps the maximum number of conversations", async () => {
		const w = world();
		for (let index = 0; index < MAX_WORKSPACES; index += 1) {
			w.workspaces.set(`ws_fill_${index}`, {
				summary: {
					workspaceId: `ws_fill_${index}`,
					title: "Filler",
					version: 0,
					createdAt: "2026-10-10T00:00:00.000Z",
					updatedAt: "2026-10-10T00:00:00.000Z",
				},
				state: emptyWorkspaceState(`ws_fill_${index}`),
			});
		}
		const created = await w.service.create(OWNER, taskRequest(), "cap-key-0001");
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.error.code).toBe("CONFLICT");
	});
});
