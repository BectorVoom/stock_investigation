/**
 * Scheduled tasks (ADR-0033 §7): table `scheduled_tasks` of migration 0010.
 * Rows are decoded through the shared contracts on read, and the JSON
 * columns are validated against them on write, so a stored task is always
 * one the API could answer with.
 */
import type {
	ScheduledTaskPatch,
	ScheduledTaskRepository,
	ScheduledTaskRunState,
	StoredScheduledTask,
} from "@research/application";
import {
	idSchema,
	isoDateTimeSchema,
	jobStateSchema,
	marketSchema,
	SCHEDULED_TASK_LIMITS,
	TASK_FIELDS_SHAPE,
	taskResultSchema,
	taskScheduleSchema,
	taskSkipCodeSchema,
	taskSpendConsentSchema,
	taskStatusSchema,
	verificationStatusSchema,
} from "@research/contracts";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { decode, parseJsonColumn, statusBesideCode, storedUpstreamStatus } from "./rows.ts";

const TABLE = "scheduled_tasks";

const nullableText = z.string().nullable();

const taskRowSchema = z.object({
	owner_id: z.string(),
	task_id: z.string(),
	workspace_id: z.string(),
	title: z.string(),
	question: z.string(),
	horizon_years: z.number(),
	markets_json: z.string(),
	schedule_json: z.string(),
	time_zone: z.string(),
	spend_consent_json: nullableText,
	status: z.string(),
	next_run_at: nullableText,
	last_run_id: nullableText,
	last_slot_at: nullableText,
	last_queued_at: nullableText,
	last_skip_code: nullableText,
	last_skip_slot_at: nullableText,
	last_skip_at: nullableText,
	version: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
});

/** The stored task as the contracts define its fields (API-002). */
const storedTaskSchema = z.strictObject({
	ownerId: z.string().min(1),
	taskId: idSchema,
	workspaceId: idSchema,
	...TASK_FIELDS_SHAPE,
	status: taskStatusSchema,
	nextRunAt: isoDateTimeSchema.nullable(),
	lastRunId: idSchema.nullable(),
	lastSlotAt: isoDateTimeSchema.nullable(),
	lastQueuedAt: isoDateTimeSchema.nullable(),
	lastSkip: z
		.strictObject({
			code: taskSkipCodeSchema,
			slotAt: isoDateTimeSchema,
			at: isoDateTimeSchema,
		})
		.nullable(),
	version: z.number().int().nonnegative(),
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
}) satisfies z.ZodType<StoredScheduledTask>;

const marketsSchema = z.array(marketSchema).min(1).max(2);
const consentColumnSchema = taskSpendConsentSchema.nullable();

export function toStoredScheduledTask(row: unknown): StoredScheduledTask {
	const r = decode(TABLE, taskRowSchema, row);
	const skip =
		r.last_skip_code === null
			? null
			: { code: r.last_skip_code, slotAt: r.last_skip_slot_at, at: r.last_skip_at };
	return decode(TABLE, storedTaskSchema, {
		ownerId: r.owner_id,
		taskId: r.task_id,
		workspaceId: r.workspace_id,
		title: r.title,
		question: r.question,
		horizonYears: r.horizon_years,
		markets: parseJsonColumn(TABLE, marketsSchema, r.markets_json),
		schedule: parseJsonColumn(TABLE, taskScheduleSchema, r.schedule_json),
		timeZone: r.time_zone,
		spendConsent:
			r.spend_consent_json === null
				? null
				: parseJsonColumn(TABLE, consentColumnSchema, r.spend_consent_json),
		status: r.status,
		nextRunAt: r.next_run_at,
		lastRunId: r.last_run_id,
		lastSlotAt: r.last_slot_at,
		lastQueuedAt: r.last_queued_at,
		lastSkip: skip,
		version: r.version,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	});
}

/** JSON text of a value that passed its contract; a failure is a defect upstream, not input. */
function encodeJson<T>(schema: z.ZodType<T>, value: unknown): string {
	return JSON.stringify(decode(TABLE, schema, value));
}

const lastRunRowSchema = z.object({
	last_run_state: nullableText,
	last_run_failure_code: nullableText,
	last_run_failure_upstream_status: storedUpstreamStatus,
});

function toRunState(row: unknown): ScheduledTaskRunState | null {
	const r = decode(TABLE, lastRunRowSchema, row);
	if (r.last_run_state === null) return null;
	return {
		state: decode("research_jobs", jobStateSchema, r.last_run_state),
		failureCode: r.last_run_failure_code,
		failureUpstreamStatus: statusBesideCode(
			r.last_run_failure_code,
			r.last_run_failure_upstream_status,
		),
	};
}

const resultRowSchema = z.object({
	run_id: z.string(),
	text: z.string(),
	created_at: z.string(),
	verification_status: nullableText,
});

/**
 * The newest research answer of a conversation (ADR-0038 §2). The answer's
 * message id is `<runId>_answer` (the completion writes it so); the join
 * keeps only `research` runs, so a notebook-assistant reply never counts.
 * The walk runs newest first on the `(owner_id, workspace_id, seq)` key.
 */
const LATEST_RESULT_SQL = `SELECT m.run_id, m.text, m.created_at, j.verification_status
	FROM chat_messages m
	JOIN research_jobs j ON j.owner_id = m.owner_id AND j.run_id = m.run_id
	WHERE m.owner_id = ? AND m.workspace_id = ? AND m.role = 'assistant'
		AND m.message_id = m.run_id || '_answer' AND j.kind = 'research'
	ORDER BY m.seq DESC
	LIMIT 1`;

/**
 * The guarded INSERT of a new task (ADR-0033 §7), written only when the
 * guard holds — the caller's batch makes the guard the workspace insert
 * that checked the limits.
 */
export function insertScheduledTaskStatement(
	db: SqlDatabase,
	task: StoredScheduledTask,
	guard: { readonly sql: string; readonly values: readonly SqlValue[] },
): SqlStatement {
	const checked = decode(TABLE, storedTaskSchema, task);
	return db
		.prepare(
			`INSERT INTO scheduled_tasks
				(owner_id, task_id, workspace_id, title, question, horizon_years, markets_json, schedule_json,
				time_zone, spend_consent_json, status, next_run_at, last_run_id, last_slot_at, last_queued_at,
				last_skip_code, last_skip_slot_at, last_skip_at, version, created_at, updated_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE ${guard.sql}`,
		)
		.bind(
			checked.ownerId,
			checked.taskId,
			checked.workspaceId,
			checked.title,
			checked.question,
			checked.horizonYears,
			encodeJson(marketsSchema, checked.markets),
			encodeJson(taskScheduleSchema, checked.schedule),
			checked.timeZone,
			checked.spendConsent === null ? null : encodeJson(consentColumnSchema, checked.spendConsent),
			checked.status,
			checked.nextRunAt,
			checked.lastRunId,
			checked.lastSlotAt,
			checked.lastQueuedAt,
			checked.lastSkip?.code ?? null,
			checked.lastSkip?.slotAt ?? null,
			checked.lastSkip?.at ?? null,
			checked.version,
			checked.createdAt,
			checked.updatedAt,
			...guard.values,
		);
}

/** SQL for "the owner has fewer than `?` tasks [with status 'active']" (bind ownerId, limit). */
export const TASK_COUNT_BELOW_SQL = "(SELECT COUNT(*) FROM scheduled_tasks WHERE owner_id = ?) < ?";
export const ACTIVE_TASK_COUNT_BELOW_SQL =
	"(SELECT COUNT(*) FROM scheduled_tasks WHERE owner_id = ? AND status = 'active') < ?";

const patchFieldSchema = z.strictObject({
	title: TASK_FIELDS_SHAPE.title.optional(),
	question: TASK_FIELDS_SHAPE.question.optional(),
	horizonYears: TASK_FIELDS_SHAPE.horizonYears.optional(),
	markets: marketsSchema.optional(),
	schedule: taskScheduleSchema.optional(),
	timeZone: TASK_FIELDS_SHAPE.timeZone.optional(),
	spendConsent: consentColumnSchema.optional(),
	status: taskStatusSchema.optional(),
	nextRunAt: isoDateTimeSchema.nullable().optional(),
	lastRunId: idSchema.nullable().optional(),
	lastSlotAt: isoDateTimeSchema.nullable().optional(),
	lastQueuedAt: isoDateTimeSchema.nullable().optional(),
	lastSkip: storedTaskSchema.shape.lastSkip.optional(),
	updatedAt: isoDateTimeSchema.optional(),
});

/** `SET` assignments of a patch; an absent (undefined) field keeps its column, null clears it. */
function patchAssignments(patch: ScheduledTaskPatch): { sql: string[]; values: SqlValue[] } {
	const checked = decode(TABLE, patchFieldSchema, patch);
	const sql: string[] = [];
	const values: SqlValue[] = [];
	const set = (column: string, value: SqlValue): void => {
		sql.push(`${column} = ?`);
		values.push(value);
	};
	if (checked.title !== undefined) set("title", checked.title);
	if (checked.question !== undefined) set("question", checked.question);
	if (checked.horizonYears !== undefined) set("horizon_years", checked.horizonYears);
	if (checked.markets !== undefined) set("markets_json", JSON.stringify(checked.markets));
	if (checked.schedule !== undefined) set("schedule_json", JSON.stringify(checked.schedule));
	if (checked.timeZone !== undefined) set("time_zone", checked.timeZone);
	if (checked.spendConsent !== undefined) {
		set(
			"spend_consent_json",
			checked.spendConsent === null ? null : JSON.stringify(checked.spendConsent),
		);
	}
	if (checked.status !== undefined) set("status", checked.status);
	if (checked.nextRunAt !== undefined) set("next_run_at", checked.nextRunAt);
	if (checked.lastRunId !== undefined) set("last_run_id", checked.lastRunId);
	if (checked.lastSlotAt !== undefined) set("last_slot_at", checked.lastSlotAt);
	if (checked.lastQueuedAt !== undefined) set("last_queued_at", checked.lastQueuedAt);
	if (checked.lastSkip !== undefined) {
		set("last_skip_code", checked.lastSkip?.code ?? null);
		set("last_skip_slot_at", checked.lastSkip?.slotAt ?? null);
		set("last_skip_at", checked.lastSkip?.at ?? null);
	}
	return { sql, values };
}

/** Status order of the list: active, then paused, then completed. */
const STATUS_RANK_SQL = "CASE t.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END";

export function createScheduledTaskRepository(db: SqlDatabase): ScheduledTaskRepository {
	return {
		async list(ownerId) {
			// One query with the last run's state joined in (no N+1). The
			// guarded insert keeps an owner at `maxTasks`; the LIMIT is the
			// same bound, so a list can never outgrow its response schema.
			const { results } = await db
				.prepare(
					`SELECT t.*, j.state AS last_run_state, j.failure_code AS last_run_failure_code,
						j.failure_upstream_status AS last_run_failure_upstream_status
					FROM scheduled_tasks t
					LEFT JOIN research_jobs j ON j.owner_id = t.owner_id AND j.run_id = t.last_run_id
					WHERE t.owner_id = ?
					ORDER BY ${STATUS_RANK_SQL},
						CASE WHEN t.status = 'active' THEN t.next_run_at END,
						t.created_at DESC, t.task_id
					LIMIT ?`,
				)
				.bind(ownerId, SCHEDULED_TASK_LIMITS.maxTasks)
				.all();
			return results.map((row) => ({ task: toStoredScheduledTask(row), lastRun: toRunState(row) }));
		},
		async get(ownerId, taskId) {
			const row = await db
				.prepare("SELECT * FROM scheduled_tasks WHERE owner_id = ? AND task_id = ?")
				.bind(ownerId, taskId)
				.first();
			return row === null ? null : toStoredScheduledTask(row);
		},
		async listDue(ownerId, nowIso, limit) {
			// The claim's due scan: a range over `scheduled_tasks_due`.
			// `next_run_at` is NULL unless active and every stored instant is
			// `toISOString()` text, so text order is time order.
			const { results } = await db
				.prepare(
					`SELECT * FROM scheduled_tasks
					WHERE owner_id = ? AND next_run_at <= ? AND status = 'active'
					ORDER BY next_run_at, task_id
					LIMIT ?`,
				)
				.bind(ownerId, nowIso, limit)
				.all();
			return results.map(toStoredScheduledTask);
		},
		async counts(ownerId) {
			const row = await db
				.prepare(
					`SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'active' THEN 1 END) AS active
					FROM scheduled_tasks WHERE owner_id = ?`,
				)
				.bind(ownerId)
				.first();
			const counts = decode(TABLE, z.object({ total: z.number(), active: z.number() }), row);
			return { total: counts.total, active: counts.active };
		},
		async write(ownerId, taskId, expectedVersion, patch, at, maxActive) {
			const assignments = patchAssignments(patch);
			// Making a task active is refused inside the same UPDATE when the
			// owner is at the active limit — unless it already is active, so
			// an edit of an active task never trips over its own row.
			const activeGuard =
				patch.status === "active"
					? {
							sql: ` AND (status = 'active' OR ${ACTIVE_TASK_COUNT_BELOW_SQL})`,
							values: [ownerId, maxActive],
						}
					: { sql: "", values: [] };
			const result = await db
				.prepare(
					`UPDATE scheduled_tasks
					SET ${[...assignments.sql, "version = version + 1", "updated_at = ?"].join(", ")}
					WHERE owner_id = ? AND task_id = ? AND version = ?${activeGuard.sql}`,
				)
				.bind(...assignments.values, at, ownerId, taskId, expectedVersion, ...activeGuard.values)
				.run();
			return result.meta.changes === 1;
		},
		async delete(ownerId, taskId) {
			const result = await db
				.prepare("DELETE FROM scheduled_tasks WHERE owner_id = ? AND task_id = ?")
				.bind(ownerId, taskId)
				.run();
			return result.meta.changes === 1;
		},
		async latestResult(ownerId, workspaceId) {
			const row = await db.prepare(LATEST_RESULT_SQL).bind(ownerId, workspaceId).first();
			if (row === null) return null;
			const r = decode("chat_messages", resultRowSchema, row);
			return decode("chat_messages", taskResultSchema, {
				runId: r.run_id,
				text: r.text,
				answeredAt: r.created_at,
				verificationStatus:
					r.verification_status === null
						? null
						: decode("research_jobs", verificationStatusSchema, r.verification_status),
			});
		},
	};
}
