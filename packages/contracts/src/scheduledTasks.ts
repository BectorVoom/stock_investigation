import {
	isValidSchedule,
	isValidTimeZone,
	SCHEDULED_TASK_LIMITS,
	type ScheduleWeekday,
	type TaskSchedule,
} from "@research/domain";
import { z } from "zod";
import { agentIdSchema } from "./agent.ts";
import { BUDGET_LIMITS, jobStateSchema, researchRunSchema } from "./jobs.ts";
import {
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	marketSchema,
	upstreamStatusSchema,
} from "./primitives.ts";

/**
 * Scheduled tasks (ADR-0033): a research question that runs on a schedule
 * in its own conversation. The bounds come from the domain's
 * `SCHEDULED_TASK_LIMITS`, so the two can never drift.
 */
export { SCHEDULED_TASK_LIMITS };

/** `HH:MM`, 24 h. */
export const scheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM expected");

export const scheduleWeekdaySchema = z.union([
	z.literal(0),
	z.literal(1),
	z.literal(2),
	z.literal(3),
	z.literal(4),
	z.literal(5),
	z.literal(6),
]) satisfies z.ZodType<ScheduleWeekday>;

export const taskScheduleSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("once"), date: isoDateSchema, time: scheduleTimeSchema }),
		z.strictObject({ kind: z.literal("daily"), time: scheduleTimeSchema }),
		z.strictObject({
			kind: z.literal("weekly"),
			/** Ascending, no repeats; 0 = Sunday. */
			days: z.array(scheduleWeekdaySchema).min(1).max(7),
			time: scheduleTimeSchema,
		}),
		z.strictObject({
			kind: z.literal("monthly"),
			/** 1–31; a month without this day runs on its last day. */
			day: z.number().int().min(1).max(31),
			time: scheduleTimeSchema,
		}),
	])
	.refine((schedule) => isValidSchedule(schedule), {
		message: "weekly days must be ascending without repeats",
		path: ["days"],
	}) satisfies z.ZodType<TaskSchedule>;
export type { TaskSchedule };
export type ScheduleKind = TaskSchedule["kind"];

/** An IANA time zone the runtime knows (`Asia/Tokyo`, `America/New_York`, `UTC`). */
export const timeZoneSchema = z
	.string()
	.min(1)
	.max(64)
	.refine((zone) => isValidTimeZone(zone), { message: "unknown time zone" });

export const taskStatusSchema = z.enum(["active", "paused", "completed"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskTitleSchema = z
	.string()
	.trim()
	.min(SCHEDULED_TASK_LIMITS.minTitleChars)
	.max(SCHEDULED_TASK_LIMITS.maxTitleChars);

export const taskQuestionSchema = z
	.string()
	.trim()
	.min(SCHEDULED_TASK_LIMITS.minQuestionChars)
	.max(SCHEDULED_TASK_LIMITS.maxQuestionChars);

/**
 * The owner's consent for a task to run on a metered backend (AGT-012,
 * ADR-0033 §4): a metered occurrence fires only while the backend saved in
 * Settings → AI agent, its model and the spend ceiling equal these.
 */
export const taskSpendConsentSchema = z.strictObject({
	agentId: agentIdSchema,
	model: z.string().min(1).max(100).nullable(),
	maxSpendUsd: z.number().gt(BUDGET_LIMITS.maxSpendUsd.min).max(BUDGET_LIMITS.maxSpendUsd.max),
});
export type TaskSpendConsent = z.infer<typeof taskSpendConsentSchema>;

/**
 * Why a due occurrence was skipped instead of queued (ADR-0033 §3): the
 * run service's refusal code. The schedule advanced past it.
 */
export const TASK_SKIP_CODES = [
	"RATE_LIMITED",
	"AGENT_NOT_CONFIGURED",
	"VALIDATION_FAILED",
	"SPEND_CONSENT_REQUIRED",
	"UNKNOWN_AGENT",
	"NOT_FOUND",
] as const;
export const taskSkipCodeSchema = z.enum(TASK_SKIP_CODES);
export type TaskSkipCode = z.infer<typeof taskSkipCodeSchema>;

export const taskSkipSchema = z.strictObject({
	code: taskSkipCodeSchema,
	/** The occurrence that was skipped. */
	slotAt: isoDateTimeSchema,
	/** When it was skipped (the claim that found it due). */
	at: isoDateTimeSchema,
});
export type TaskSkip = z.infer<typeof taskSkipSchema>;

/** The task's latest queued run as the list shows it (one join, no N+1). */
export const taskLastRunSchema = z.strictObject({
	runId: idSchema,
	state: jobStateSchema,
	/** The scheduled slot it ran for, or null for a "Run now". */
	slotAt: isoDateTimeSchema.nullable(),
	queuedAt: isoDateTimeSchema,
	failureCode: z.string().max(80).nullable(),
	/** The run's `failureUpstreamStatus`: an external service's status, unchanged. */
	failureUpstreamStatus: upstreamStatusSchema.nullable(),
});
export type TaskLastRun = z.infer<typeof taskLastRunSchema>;

/** The editable fields of a task: what the editor dialog sends. */
export const TASK_FIELDS_SHAPE = {
	title: taskTitleSchema,
	question: taskQuestionSchema,
	horizonYears: z.union([z.literal(3), z.literal(4), z.literal(5)]),
	markets: z.array(marketSchema).min(1).max(2),
	schedule: taskScheduleSchema,
	timeZone: timeZoneSchema,
	spendConsent: taskSpendConsentSchema.nullable(),
};

export const scheduledTaskSchema = z.strictObject({
	taskId: idSchema,
	/** The task's own conversation; every run's question and answer land there. */
	workspaceId: idSchema,
	...TASK_FIELDS_SHAPE,
	status: taskStatusSchema,
	/** The next instant it fires; null unless active. */
	nextRunAt: isoDateTimeSchema.nullable(),
	lastRun: taskLastRunSchema.nullable(),
	lastSkip: taskSkipSchema.nullable(),
	/** Compare-and-set version for edits. */
	version: z.number().int().nonnegative(),
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
});
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export const scheduledTaskListResponseSchema = z.strictObject({
	/** Active first by next run, then paused, then completed; newest first within each. */
	tasks: z.array(scheduledTaskSchema).max(SCHEDULED_TASK_LIMITS.maxTasks),
	limits: z.strictObject({
		maxActive: z.literal(SCHEDULED_TASK_LIMITS.maxActive),
		maxTasks: z.literal(SCHEDULED_TASK_LIMITS.maxTasks),
	}),
});
export type ScheduledTaskListResponse = z.infer<typeof scheduledTaskListResponseSchema>;

export const createScheduledTaskRequestSchema = z.strictObject(TASK_FIELDS_SHAPE);
export type CreateScheduledTaskRequest = z.infer<typeof createScheduledTaskRequestSchema>;

/**
 * An edit: any subset of the fields, or a status change (pause = `paused`,
 * resume = `active`; `completed` is the server's). Compare-and-set on
 * `expectedVersion`.
 */
export const updateScheduledTaskRequestSchema = z
	.strictObject({
		expectedVersion: z.number().int().nonnegative(),
		title: TASK_FIELDS_SHAPE.title.optional(),
		question: TASK_FIELDS_SHAPE.question.optional(),
		horizonYears: TASK_FIELDS_SHAPE.horizonYears.optional(),
		markets: TASK_FIELDS_SHAPE.markets.optional(),
		schedule: TASK_FIELDS_SHAPE.schedule.optional(),
		timeZone: TASK_FIELDS_SHAPE.timeZone.optional(),
		spendConsent: TASK_FIELDS_SHAPE.spendConsent.optional(),
		status: z.enum(["active", "paused"]).optional(),
	})
	.refine((request) => Object.keys(request).length > 1, {
		message: "nothing to change",
	});
export type UpdateScheduledTaskRequest = z.infer<typeof updateScheduledTaskRequestSchema>;

export const scheduledTaskResponseSchema = z.strictObject({ task: scheduledTaskSchema });
export type ScheduledTaskResponse = z.infer<typeof scheduledTaskResponseSchema>;

/** "Run now": the task with its new last run, and that run (or the unfinished one it answered with). */
export const runScheduledTaskResponseSchema = z.strictObject({
	task: scheduledTaskSchema,
	run: researchRunSchema,
	/** True when the task's unfinished run was answered instead of a new one. */
	replayed: z.boolean(),
});
export type RunScheduledTaskResponse = z.infer<typeof runScheduledTaskResponseSchema>;

/** `VALIDATION_FAILED` details the task routes answer with. */
export const TASK_VALIDATION_DETAILS = {
	full: "TASKS_FULL",
	inPast: "SCHEDULE_IN_PAST",
	completed: "TASK_COMPLETED",
} as const;
