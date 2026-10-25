/**
 * Scheduled-task storage (ADR-0033 §7): the repository and the unit of
 * work's guarded create and conversation-delete cascade, pinned against the
 * real migrations on `node:sqlite`; D1 runs the same SQL text through the
 * API suite (`apps/api/test/scheduledTasks.test.ts`).
 */
import { fileURLToPath } from "node:url";
import type { JobRecord, StoredScheduledTask, WorkspaceRecord } from "@research/application";
import { EMPTY_USAGE, emptyWorkspaceState } from "@research/domain";
import { describe, expect, it } from "vitest";
import { insertJobStatement } from "../../src/sql/repositories.ts";
import { StoredDataError } from "../../src/sql/rows.ts";
import { createScheduledTaskRepository, LATEST_RESULT_SQL } from "../../src/sql/scheduledTasks.ts";
import { createResearchUnitOfWork } from "../../src/sql/unitOfWork.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

const OWNER = "owner_1";
const AT = "2026-10-24T00:00:00.000Z";

function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

function workspace(workspaceId: string, title = "Morning brief"): WorkspaceRecord {
	return {
		summary: { workspaceId, title, version: 0, createdAt: AT, updatedAt: AT },
		state: emptyWorkspaceState(workspaceId),
	};
}

function task(overrides: Partial<StoredScheduledTask> = {}): StoredScheduledTask {
	return {
		ownerId: OWNER,
		taskId: "task_1",
		workspaceId: "ws_1",
		title: "Morning brief",
		question: "What moved Japanese semiconductor stocks overnight?",
		horizonYears: 3,
		markets: ["JP"],
		schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
		timeZone: "Asia/Tokyo",
		spendConsent: { agentId: "claude-api", model: "claude-sonnet", maxSpendUsd: 2 },
		status: "active",
		nextRunAt: "2026-10-25T23:00:00.000Z",
		lastRunId: null,
		lastSlotAt: null,
		lastQueuedAt: null,
		lastSkip: null,
		version: 0,
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	};
}

function job(runId: string, workspaceId: string, state: JobRecord["state"]): JobRecord {
	return {
		runId,
		ownerId: OWNER,
		kind: "research",
		state,
		request: null,
		workspaceId,
		usage: EMPTY_USAGE,
		attempt: 0,
		maxAttempts: 3,
		leaseGeneration: 0,
		leaseOwnerId: null,
		leaseExpiresAt: null,
		lastEventSeq: -1,
		cancelRequested: false,
		failureCode: state === "failed" ? "AGENT_TIMEOUT" : null,
		failureDetail: null,
		failureUpstreamStatus: state === "failed" ? 504 : null,
		approvalRequest: null,
		retryOfRunId: null,
		contextAnchorSeq: null,
		verificationStatus: null,
		providerModel: null,
		providerSessionRef: null,
		completedGeneration: null,
		provenance: null,
		version: 0,
		createdAt: AT,
		updatedAt: AT,
	};
}

type Db = ReturnType<typeof openMigrated>;

async function create(
	db: Db,
	stored: StoredScheduledTask,
	limits: { maxTasks?: number; maxActive?: number } = {},
) {
	return createResearchUnitOfWork(db).createScheduledTask({
		ownerId: stored.ownerId,
		workspace: workspace(stored.workspaceId, stored.title),
		task: stored,
		maxTasks: limits.maxTasks ?? 30,
		maxActive: limits.maxActive ?? 10,
	});
}

async function count(db: Db, table: "workspaces" | "scheduled_tasks"): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
	return typeof row?.n === "number" ? row.n : -1;
}

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
	const db = openMigrated();
	try {
		await run(db);
	} finally {
		db.close();
	}
}

describe("scheduled task repository (ADR-0033 §7)", () => {
	it("creates the task with its conversation and reads it back unchanged", () =>
		withDb(async (db) => {
			expect(await create(db, task())).toBe("created");
			const repository = createScheduledTaskRepository(db);
			expect(await repository.get(OWNER, "task_1")).toEqual(task());
			expect(await repository.get("someone_else", "task_1")).toBe(null);
			const conversation = await db
				.prepare("SELECT title FROM workspaces WHERE owner_id = ? AND workspace_id = ?")
				.bind(OWNER, "ws_1")
				.first();
			expect(conversation?.title).toBe("Morning brief");
			expect(await repository.counts(OWNER)).toEqual({ total: 1, active: 1 });
		}));

	it("refuses a create over either limit inside the insert and writes nothing", () =>
		withDb(async (db) => {
			expect(await create(db, task(), { maxTasks: 1 })).toBe("created");
			expect(
				await create(db, task({ taskId: "task_2", workspaceId: "ws_2" }), { maxTasks: 1 }),
			).toBe("full");
			// The active limit only binds an active task: a paused one still fits.
			expect(
				await create(db, task({ taskId: "task_3", workspaceId: "ws_3" }), { maxActive: 1 }),
			).toBe("full");
			expect(
				await create(
					db,
					task({ taskId: "task_4", workspaceId: "ws_4", status: "paused", nextRunAt: null }),
					{ maxActive: 1 },
				),
			).toBe("created");
			expect(await count(db, "workspaces")).toBe(2);
			expect(await count(db, "scheduled_tasks")).toBe(2);
		}));

	it("answers full for an existing task id without a second conversation", () =>
		withDb(async (db) => {
			expect(await create(db, task())).toBe("created");
			expect(await create(db, task({ workspaceId: "ws_other" }))).toBe("full");
			expect(await count(db, "workspaces")).toBe(1);
		}));

	it("writes by compare-and-set and bumps the version", () =>
		withDb(async (db) => {
			await create(db, task());
			const repository = createScheduledTaskRepository(db);
			const later = "2026-10-24T01:00:00.000Z";
			expect(await repository.write(OWNER, "task_1", 5, { title: "Stale" }, later, 10)).toBe(false);
			expect(
				await repository.write(
					OWNER,
					"task_1",
					0,
					{ title: "Evening brief", spendConsent: null, status: "paused", nextRunAt: null },
					later,
					10,
				),
			).toBe(true);
			expect(await repository.get(OWNER, "task_1")).toEqual(
				task({
					title: "Evening brief",
					spendConsent: null,
					status: "paused",
					nextRunAt: null,
					version: 1,
					updatedAt: later,
				}),
			);
			// Absent fields keep their columns; the skip is stored and cleared as one.
			const skip = { code: "RATE_LIMITED" as const, slotAt: AT, at: later };
			expect(await repository.write(OWNER, "task_1", 1, { lastSkip: skip }, later, 10)).toBe(true);
			expect(await repository.get(OWNER, "task_1")).toMatchObject({
				title: "Evening brief",
				lastSkip: skip,
				version: 2,
			});
			expect(await repository.write(OWNER, "task_1", 2, { lastSkip: null }, later, 10)).toBe(true);
			expect((await repository.get(OWNER, "task_1"))?.lastSkip).toBe(null);
		}));

	it("refuses to make a task active over the active limit, but edits an active one at it", () =>
		withDb(async (db) => {
			await create(db, task());
			await create(
				db,
				task({ taskId: "task_2", workspaceId: "ws_2", status: "paused", nextRunAt: null }),
			);
			const repository = createScheduledTaskRepository(db);
			const resume = { status: "active" as const, nextRunAt: "2026-10-26T23:00:00.000Z" };
			expect(await repository.write(OWNER, "task_2", 0, resume, AT, 1)).toBe(false);
			expect((await repository.get(OWNER, "task_2"))?.status).toBe("paused");
			expect(
				await repository.write(OWNER, "task_1", 0, { ...resume, title: "Edited" }, AT, 1),
			).toBe(true);
			expect(await repository.write(OWNER, "task_2", 0, resume, AT, 2)).toBe(true);
			expect(await repository.counts(OWNER)).toEqual({ total: 2, active: 2 });
		}));

	it("lists due active tasks earliest first, bounded", () =>
		withDb(async (db) => {
			await create(
				db,
				task({ taskId: "task_late", workspaceId: "ws_a", nextRunAt: "2026-10-24T03:00:00.000Z" }),
			);
			await create(
				db,
				task({ taskId: "task_early", workspaceId: "ws_b", nextRunAt: "2026-10-24T01:00:00.000Z" }),
			);
			await create(
				db,
				task({ taskId: "task_future", workspaceId: "ws_c", nextRunAt: "2026-10-25T00:00:00.000Z" }),
			);
			await create(
				db,
				task({ taskId: "task_paused", workspaceId: "ws_d", status: "paused", nextRunAt: null }),
			);
			const repository = createScheduledTaskRepository(db);
			const now = "2026-10-24T03:00:00.000Z";
			expect((await repository.listDue(OWNER, now, 10)).map((due) => due.taskId)).toEqual([
				"task_early",
				"task_late",
			]);
			expect((await repository.listDue(OWNER, now, 1)).map((due) => due.taskId)).toEqual([
				"task_early",
			]);
			expect(await repository.listDue("someone_else", now, 10)).toEqual([]);
		}));

	it("lists active by next run, then paused, then completed, with the last run joined", () =>
		withDb(async (db) => {
			await create(
				db,
				task({
					taskId: "task_done",
					workspaceId: "ws_a",
					status: "completed",
					nextRunAt: null,
					schedule: { kind: "once", date: "2026-10-23", time: "09:00" },
				}),
			);
			await create(
				db,
				task({ taskId: "task_paused", workspaceId: "ws_b", status: "paused", nextRunAt: null }),
			);
			await create(
				db,
				task({ taskId: "task_second", workspaceId: "ws_c", nextRunAt: "2026-10-26T00:00:00.000Z" }),
			);
			await create(
				db,
				task({ taskId: "task_first", workspaceId: "ws_d", nextRunAt: "2026-10-25T00:00:00.000Z" }),
			);
			await db.batch([
				insertJobStatement(db, job("run_failed", "ws_c", "failed"), "key_failed_1", "fp", "m1", 5),
			]);
			const repository = createScheduledTaskRepository(db);
			await repository.write(
				OWNER,
				"task_second",
				0,
				{ lastRunId: "run_failed", lastSlotAt: AT, lastQueuedAt: AT },
				AT,
				10,
			);
			// A last run that is gone (deleted elsewhere) lists as none.
			await repository.write(
				OWNER,
				"task_first",
				0,
				{ lastRunId: "run_gone", lastQueuedAt: AT },
				AT,
				10,
			);
			const rows = await repository.list(OWNER);
			expect(rows.map((row) => row.task.taskId)).toEqual([
				"task_first",
				"task_second",
				"task_paused",
				"task_done",
			]);
			// The join carries the run's upstream status beside its code (§4a).
			expect(rows[1]?.lastRun).toEqual({
				state: "failed",
				failureCode: "AGENT_TIMEOUT",
				failureUpstreamStatus: 504,
			});
			expect(rows[0]?.lastRun).toBe(null);
			expect(rows[2]?.lastRun).toBe(null);
		}));

	it("deletes one task and keeps its conversation", () =>
		withDb(async (db) => {
			await create(db, task());
			const repository = createScheduledTaskRepository(db);
			expect(await repository.delete(OWNER, "task_1")).toBe(true);
			expect(await repository.delete(OWNER, "task_1")).toBe(false);
			expect(await count(db, "workspaces")).toBe(1);
		}));

	it("deletes a conversation's tasks in the conversation's delete batch", () =>
		withDb(async (db) => {
			await create(db, task());
			await create(db, task({ taskId: "task_2", workspaceId: "ws_2" }));
			const outcome = await createResearchUnitOfWork(db).deleteWorkspace({
				ownerId: OWNER,
				workspaceId: "ws_1",
				keepEvidenceIds: [],
				keepDatasetIds: [],
				keepClaimIds: [],
			});
			expect(outcome).toBe("deleted");
			const repository = createScheduledTaskRepository(db);
			expect(await repository.get(OWNER, "task_1")).toBe(null);
			expect(await repository.get(OWNER, "task_2")).not.toBe(null);
		}));

	it("keeps the task when the conversation delete refuses (an unfinished run)", () =>
		withDb(async (db) => {
			await create(db, task());
			await db.batch([
				insertJobStatement(db, job("run_live", "ws_1", "pending"), "key_live_1", "fp", "m1", 5),
			]);
			const outcome = await createResearchUnitOfWork(db).deleteWorkspace({
				ownerId: OWNER,
				workspaceId: "ws_1",
				keepEvidenceIds: [],
				keepDatasetIds: [],
				keepClaimIds: [],
			});
			expect(outcome).toBe("has-unfinished");
			expect(await createScheduledTaskRepository(db).get(OWNER, "task_1")).not.toBe(null);
		}));

	it("fails a read of stored JSON that no longer matches the contract", () =>
		withDb(async (db) => {
			await create(db, task());
			await db
				.prepare("UPDATE scheduled_tasks SET schedule_json = ? WHERE task_id = ?")
				.bind(JSON.stringify({ kind: "weekly", days: [3, 1], time: "08:00" }), "task_1")
				.run();
			await expect(createScheduledTaskRepository(db).get(OWNER, "task_1")).rejects.toBeInstanceOf(
				StoredDataError,
			);
		}));

	it("refuses to store a task that breaks the contract", () =>
		withDb(async (db) => {
			await expect(create(db, task({ timeZone: "Mars/Olympus" }))).rejects.toBeInstanceOf(
				StoredDataError,
			);
			expect(await count(db, "workspaces")).toBe(0);
		}));
});

/** One chat message as the completion (or the owner's question) stores it. */
async function postMessage(
	db: Db,
	message: {
		readonly ownerId?: string;
		readonly messageId: string;
		readonly workspaceId: string;
		readonly seq: number;
		readonly role: "owner" | "assistant";
		readonly text: string;
		readonly runId: string | null;
		readonly at: string;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO chat_messages (owner_id, message_id, workspace_id, seq, role, text, run_id, claim_ids_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
		)
		.bind(
			message.ownerId ?? OWNER,
			message.messageId,
			message.workspaceId,
			message.seq,
			message.role,
			message.text,
			message.runId,
			message.at,
		)
		.run();
}

/** A finished run of `kind`, stored through the production insert. */
async function storeRun(
	db: Db,
	runId: string,
	workspaceId: string,
	overrides: Partial<JobRecord> = {},
): Promise<void> {
	await db.batch([
		insertJobStatement(
			db,
			{ ...job(runId, workspaceId, "completed"), ...overrides },
			`key_${runId}`,
			"fp",
			`m_${runId}`,
			5,
		),
	]);
}

describe("a task's latest result (ADR-0038 §2)", () => {
	it("is null for a conversation no run has answered", () =>
		withDb(async (db) => {
			await create(db, task());
			await postMessage(db, {
				messageId: "msg_q",
				workspaceId: "ws_1",
				seq: 0,
				role: "owner",
				text: "What moved?",
				runId: null,
				at: AT,
			});
			expect(await createScheduledTaskRepository(db).latestResult(OWNER, "ws_1")).toBe(null);
		}));

	it("answers the newest research answer, its time and verification status", () =>
		withDb(async (db) => {
			await create(db, task());
			await storeRun(db, "run_old", "ws_1", { verificationStatus: "verified" });
			await storeRun(db, "run_new", "ws_1");
			await postMessage(db, {
				messageId: "run_old_answer",
				workspaceId: "ws_1",
				seq: 1,
				role: "assistant",
				text: "Older answer.",
				runId: "run_old",
				at: "2026-10-24T06:05:00.000Z",
			});
			const repository = createScheduledTaskRepository(db);
			expect(await repository.latestResult(OWNER, "ws_1")).toEqual({
				runId: "run_old",
				text: "Older answer.",
				answeredAt: "2026-10-24T06:05:00.000Z",
				verificationStatus: "verified",
			});
			await postMessage(db, {
				messageId: "run_new_answer",
				workspaceId: "ws_1",
				seq: 3,
				role: "assistant",
				text: "Newer answer.",
				runId: "run_new",
				at: "2026-10-25T06:05:00.000Z",
			});
			expect(await repository.latestResult(OWNER, "ws_1")).toEqual({
				runId: "run_new",
				text: "Newer answer.",
				answeredAt: "2026-10-25T06:05:00.000Z",
				verificationStatus: null,
			});
		}));

	it("skips notebook-assistant replies and owner messages posted after the answer", () =>
		withDb(async (db) => {
			await create(db, task());
			await storeRun(db, "run_research", "ws_1", { verificationStatus: "partially-verified" });
			await storeRun(db, "run_assist", "ws_1", { kind: "notebook-assist" });
			await postMessage(db, {
				messageId: "run_research_answer",
				workspaceId: "ws_1",
				seq: 0,
				role: "assistant",
				text: "The research answer.",
				runId: "run_research",
				at: AT,
			});
			// The notebook assistant's reply has the same `<runId>_answer` shape.
			await postMessage(db, {
				messageId: "run_assist_answer",
				workspaceId: "ws_1",
				seq: 1,
				role: "assistant",
				text: "I moved the chart.",
				runId: "run_assist",
				at: AT,
			});
			await postMessage(db, {
				messageId: "msg_followup",
				workspaceId: "ws_1",
				seq: 2,
				role: "owner",
				text: "And yesterday?",
				runId: "run_research",
				at: AT,
			});
			expect(await createScheduledTaskRepository(db).latestResult(OWNER, "ws_1")).toEqual({
				runId: "run_research",
				text: "The research answer.",
				answeredAt: AT,
				verificationStatus: "partially-verified",
			});
		}));

	it("never answers another conversation's or another owner's answer", () =>
		withDb(async (db) => {
			await create(db, task());
			await create(db, task({ taskId: "task_2", workspaceId: "ws_2" }));
			await create(db, task({ ownerId: "owner_2", taskId: "task_3", workspaceId: "ws_1" }));
			await storeRun(db, "run_other_ws", "ws_2");
			await storeRun(db, "run_other_owner", "ws_1", { ownerId: "owner_2" });
			await postMessage(db, {
				messageId: "run_other_ws_answer",
				workspaceId: "ws_2",
				seq: 0,
				role: "assistant",
				text: "Another conversation's answer.",
				runId: "run_other_ws",
				at: AT,
			});
			await postMessage(db, {
				ownerId: "owner_2",
				messageId: "run_other_owner_answer",
				workspaceId: "ws_1",
				seq: 0,
				role: "assistant",
				text: "Another owner's answer.",
				runId: "run_other_owner",
				at: AT,
			});
			const repository = createScheduledTaskRepository(db);
			expect(await repository.latestResult(OWNER, "ws_1")).toBe(null);
			expect((await repository.latestResult(OWNER, "ws_2"))?.runId).toBe("run_other_ws");
			expect((await repository.latestResult("owner_2", "ws_1"))?.runId).toBe("run_other_owner");
		}));

	it("fails a read of an answer that no longer matches the contract", () =>
		withDb(async (db) => {
			await create(db, task());
			await storeRun(db, "run_1", "ws_1");
			await postMessage(db, {
				messageId: "run_1_answer",
				workspaceId: "ws_1",
				seq: 0,
				role: "assistant",
				text: "An answer.",
				runId: "run_1",
				at: AT,
			});
			await db
				.prepare("UPDATE research_jobs SET verification_status = 'maybe' WHERE run_id = 'run_1'")
				.run();
			await expect(
				createScheduledTaskRepository(db).latestResult(OWNER, "ws_1"),
			).rejects.toBeInstanceOf(StoredDataError);
		}));

	it("walks the conversation's seq key newest first and joins the run by primary key", () =>
		withDb(async (db) => {
			const plan = await db
				.prepare(`EXPLAIN QUERY PLAN ${LATEST_RESULT_SQL}`)
				.bind(OWNER, "ws_1")
				.all();
			const details = plan.results.map((row) => String(row.detail));
			// The unique (owner_id, workspace_id, seq) key and the research_jobs
			// primary key: no scan and no sort, whatever the conversation's size.
			expect(details).toEqual([
				"SEARCH m USING INDEX sqlite_autoindex_chat_messages_2 (owner_id=? AND workspace_id=?)",
				"SEARCH j USING INDEX sqlite_autoindex_research_jobs_1 (owner_id=? AND run_id=?)",
			]);
		}));
});
