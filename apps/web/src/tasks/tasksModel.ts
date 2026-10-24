import {
	type AgentSettings,
	type AgentsResponse,
	BUDGET_LIMITS,
	type CreateScheduledTaskRequest,
	createScheduledTaskRequestSchema,
	isTerminalJobState,
	SCHEDULED_TASK_LIMITS,
	type ScheduledTask,
	TASK_VALIDATION_DETAILS,
	type TaskSchedule,
	type TaskSkip,
	type TaskSpendConsent,
	type WidgetSize,
} from "@research/contracts";
import {
	isValidIsoDate,
	isValidTimeZone,
	nextRunAtMs,
	parseLocalTime,
	type ScheduleWeekday,
} from "@research/domain";
import type { Locale, MessagesOf } from "@research/i18n";
import type { ApiFailure } from "../api/http.ts";
import { type AgentSettingsText, agentOptions } from "../settings/agentSettingsModel.ts";
import type { tasksModelMessages } from "./tasksModel.messages.ts";

/**
 * Pure view-model of scheduled tasks (ADR-0033 §8–§9), shared by the Tasks
 * page and the widget: ordering, the schedule in words, the next-run,
 * last-run and skip lines, the editor draft and its validation, and when a
 * task needs spend consent. No Solid, no network; the clock and the
 * language arrive as parameters.
 */

export type TasksText = MessagesOf<typeof tasksModelMessages>;

const STATUS_RANK: { readonly [S in ScheduledTask["status"]]: number } = {
	active: 0,
	paused: 1,
	completed: 2,
};

function instantMs(iso: string | null): number {
	if (iso === null) return Number.POSITIVE_INFINITY;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The tasks as the list and the widget show them: active first by next run
 * (soonest first), then paused, then completed; newest first within a tie.
 */
export function orderTasks(tasks: readonly ScheduledTask[]): readonly ScheduledTask[] {
	return [...tasks].sort((a, b) => {
		const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
		if (byStatus !== 0) return byStatus;
		if (a.status === "active") {
			const byNext = instantMs(a.nextRunAt) - instantMs(b.nextRunAt);
			if (byNext !== 0 && Number.isFinite(byNext)) return byNext;
			if (a.nextRunAt === null && b.nextRunAt !== null) return 1;
			if (b.nextRunAt === null && a.nextRunAt !== null) return -1;
		}
		const byCreated = instantMs(b.createdAt) - instantMs(a.createdAt);
		if (byCreated !== 0 && Number.isFinite(byCreated)) return byCreated;
		return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
	});
}

/** True while any task's last run is pending or running: the list then polls fast. */
export function hasUnfinishedRun(tasks: readonly ScheduledTask[]): boolean {
	return tasks.some((task) => task.lastRun !== null && !isTerminalJobState(task.lastRun.state));
}

/** How many tasks a widget of each size lists (ADR-0033 §9). */
export const WIDGET_TASK_COUNT: { readonly [S in WidgetSize]: number } = {
	small: 1,
	medium: 4,
	large: 8,
};

/** The tasks a widget shows and how many more there are ("N more" on Large only). */
export function widgetTasks(
	tasks: readonly ScheduledTask[],
	size: WidgetSize,
): { readonly shown: readonly ScheduledTask[]; readonly more: number } {
	const ordered = orderTasks(tasks);
	const shown = ordered.slice(0, WIDGET_TASK_COUNT[size]);
	return { shown, more: size === "large" ? ordered.length - shown.length : 0 };
}

const WEEKDAYS_PRESET: readonly ScheduleWeekday[] = [1, 2, 3, 4, 5];

function isWeekdaysPreset(days: readonly ScheduleWeekday[]): boolean {
	return (
		days.length === WEEKDAYS_PRESET.length &&
		days.every((day, index) => day === WEEKDAYS_PRESET[index])
	);
}

/** The browser's IANA time zone, or UTC when the runtime reports none it knows. */
export function browserTimeZone(): string {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return typeof zone === "string" && isValidTimeZone(zone) ? zone : "UTC";
}

/** The schedule in words, naming its zone when it is not the browser's. */
export function scheduleText(
	schedule: TaskSchedule,
	timeZone: string,
	viewerZone: string,
	text: TasksText,
): string {
	const words = scheduleWords(schedule, text);
	return timeZone === viewerZone ? words : text.inZone(words, timeZone);
}

function scheduleWords(schedule: TaskSchedule, text: TasksText): string {
	switch (schedule.kind) {
		case "once":
			return text.scheduleOnce(schedule.date, schedule.time);
		case "daily":
			return text.scheduleDaily(schedule.time);
		case "weekly":
			return isWeekdaysPreset(schedule.days)
				? text.scheduleWeekdays(schedule.time)
				: text.scheduleWeekly(
						schedule.days.map((day) => text.weekday(day)),
						schedule.time,
					);
		case "monthly":
			return text.scheduleMonthly(schedule.day, schedule.time);
	}
}

const LOCALE_TAGS: { readonly [L in Locale]: string } = { en: "en-US", ja: "ja-JP" };
/** Formatters are costly to build; one per language and zone, bounded. */
const MAX_CACHED_FORMATTERS = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: Locale, timeZone: string): Intl.DateTimeFormat {
	const key = `${locale}\u0000${timeZone}`;
	const cached = formatters.get(key);
	if (cached !== undefined) return cached;
	const created = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
		timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.clear();
	formatters.set(key, created);
	return created;
}

/** An instant in the task's own zone ("Mon, Oct 26, 08:00"), naming the zone when not the viewer's. */
export function taskTimeText(
	iso: string,
	timeZone: string,
	viewerZone: string,
	locale: Locale,
	text: TasksText,
): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return iso;
	const formatted = formatterFor(locale, timeZone).format(ms);
	return timeZone === viewerZone ? formatted : text.inZone(formatted, timeZone);
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** "25 min", "3 h 20 min", rounded up so "in 0 min" never shows. */
export function relativeText(deltaMs: number, text: TasksText): string {
	const minutes = Math.ceil(deltaMs / MS_PER_MINUTE);
	if (minutes <= 1 && deltaMs < MS_PER_MINUTE) return text.lessThanMinute;
	if (minutes < 60) return text.minutes(minutes);
	return text.hoursMinutes(Math.floor(minutes / 60), minutes % 60);
}

/**
 * When the task runs next: relative within a day, the local date and time
 * beyond it, "due now" once its time came (it starts when the runner next
 * asks for work), and the paused / completed states in words.
 */
export function nextRunText(
	task: ScheduledTask,
	nowMs: number,
	viewerZone: string,
	locale: Locale,
	text: TasksText,
): string {
	if (task.status === "paused") return text.pausedLine;
	if (task.status === "completed" || task.nextRunAt === null)
		// A one-time task whose only occurrence was skipped never ran: saying it "has run" would contradict the skip line.
		return currentSkip(task) === null ? text.completedLine : text.completedSkippedLine;
	const nextMs = Date.parse(task.nextRunAt);
	if (!Number.isFinite(nextMs)) return text.nextRunAt(task.nextRunAt);
	const delta = nextMs - nowMs;
	if (delta <= 0) return text.dueNow;
	if (delta < MS_PER_DAY) return text.nextRunIn(relativeText(delta, text));
	return text.nextRunAt(taskTimeText(task.nextRunAt, task.timeZone, viewerZone, locale, text));
}

/** The last run's state in words, with its failure code; "Not run yet" without one. */
export function lastRunText(
	task: ScheduledTask,
	stateName: (state: string) => string,
	text: TasksText,
): string {
	const run = task.lastRun;
	if (run === null) return text.notRunYet;
	if (run.failureCode !== null) return text.lastRunFailed(stateName(run.state), run.failureCode);
	return text.lastRun(stateName(run.state));
}

export interface SkipView {
	/** "The run due Mon, Oct 26, 08:00 was skipped:" */
	readonly headline: string;
	readonly reason: string;
	readonly fix: string;
	/** True when the fix lives in Settings → AI agent (the view links there). */
	readonly settingsFix: boolean;
}

/** The task's last skip unless a run queued after it superseded it. */
function currentSkip(task: ScheduledTask): TaskSkip | null {
	const skip = task.lastSkip;
	if (skip === null) return null;
	if (task.lastRun !== null && instantMs(task.lastRun.queuedAt) > instantMs(skip.at)) return null;
	return skip;
}

/**
 * The last skipped occurrence with its reason and the fix (ADR-0033 §3),
 * or null when it is older than the last queued run (that run superseded it).
 */
export function skipView(
	task: ScheduledTask,
	viewerZone: string,
	locale: Locale,
	text: TasksText,
): SkipView | null {
	const skip = currentSkip(task);
	if (skip === null) return null;
	return {
		headline: text.skipped(taskTimeText(skip.slotAt, task.timeZone, viewerZone, locale, text)),
		reason: text.skipReason(skip.code),
		fix: text.skipFix(skip.code),
		settingsFix: skip.code !== "RATE_LIMITED" && skip.code !== "NOT_FOUND",
	};
}

/* ---------- Spend consent (ADR-0033 §4) ---------- */

/**
 * Whether the backend saved in Settings → AI agent needs this task's spend
 * consent, by the composer's rule (AGT-012): a backend that is not
 * plan-limited with a positive spend ceiling asks for it; a metered one
 * without a ceiling cannot run until Settings has one.
 */
export type TaskConsentNeed =
	| { readonly kind: "loading" }
	| { readonly kind: "none" }
	| {
			readonly kind: "needed";
			readonly consent: TaskSpendConsent;
			readonly backendName: string;
	  }
	| { readonly kind: "no-ceiling"; readonly backendName: string };

export function taskConsentNeed(
	agents: AgentsResponse | null,
	settings: AgentSettings | null,
	agentText: AgentSettingsText,
): TaskConsentNeed {
	if (agents === null || settings === null) return { kind: "loading" };
	const agentId = settings.defaultAgentId;
	if (agentId === null) return { kind: "none" };
	const option = agentOptions(agents, agentText).find((entry) => entry.agentId === agentId);
	if (option === undefined || option.costModel === "plan-limited") return { kind: "none" };
	const spend = settings.budget.maxSpendUsd;
	if (spend === null || spend <= 0 || spend > BUDGET_LIMITS.maxSpendUsd.max) {
		return option.costModel === "metered"
			? { kind: "no-ceiling", backendName: option.displayName }
			: { kind: "none" };
	}
	return {
		kind: "needed",
		consent: { agentId, model: settings.models[agentId] ?? null, maxSpendUsd: spend },
		backendName: option.displayName,
	};
}

export function sameConsent(a: TaskSpendConsent | null, b: TaskSpendConsent | null): boolean {
	if (a === null || b === null) return a === b;
	return a.agentId === b.agentId && a.model === b.model && a.maxSpendUsd === b.maxSpendUsd;
}

/* ---------- The editor draft ---------- */

/** The editor's "Repeat" choices: `weekdays` is `weekly` Monday–Friday. */
export const SCHEDULE_CHOICES = ["once", "daily", "weekdays", "weekly", "monthly"] as const;
export type ScheduleChoice = (typeof SCHEDULE_CHOICES)[number];

export const WEEKDAYS: readonly ScheduleWeekday[] = [0, 1, 2, 3, 4, 5, 6];

export interface TaskDraft {
	readonly title: string;
	readonly question: string;
	readonly horizonYears: 3 | 4 | 5;
	readonly markets: { readonly JP: boolean; readonly US: boolean };
	readonly choice: ScheduleChoice;
	/** `YYYY-MM-DD`, for `once`. */
	readonly date: string;
	/** `HH:MM`. */
	readonly time: string;
	/** For `weekly`; ascending. */
	readonly days: readonly ScheduleWeekday[];
	/** 1–31 as typed, for `monthly`. */
	readonly dayOfMonth: string;
	readonly timeZone: string;
	readonly consent: boolean;
}

/** Today's civil date in a zone (`en-CA` formats dates as `YYYY-MM-DD`). */
export function localDateIn(nowMs: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(nowMs);
}

export function defaultTaskDraft(nowMs: number, timeZone: string): TaskDraft {
	return {
		title: "",
		question: "",
		horizonYears: 5,
		markets: { JP: true, US: true },
		choice: "daily",
		date: localDateIn(nowMs + MS_PER_DAY, timeZone),
		time: "08:00",
		days: [1],
		dayOfMonth: "1",
		timeZone,
		consent: false,
	};
}

/** The draft of an existing task; its consent counts only while it still matches the need. */
export function draftFromTask(
	task: ScheduledTask,
	need: TaskConsentNeed,
	nowMs: number,
): TaskDraft {
	const base = defaultTaskDraft(nowMs, task.timeZone);
	const schedule = task.schedule;
	const scheduleFields = ((): Pick<TaskDraft, "choice" | "date" | "days" | "dayOfMonth"> => {
		switch (schedule.kind) {
			case "once":
				return { choice: "once", date: schedule.date, days: base.days, dayOfMonth: "1" };
			case "daily":
				return { choice: "daily", date: base.date, days: base.days, dayOfMonth: "1" };
			case "weekly":
				return {
					choice: isWeekdaysPreset(schedule.days) ? "weekdays" : "weekly",
					date: base.date,
					days: [...schedule.days],
					dayOfMonth: "1",
				};
			case "monthly":
				return {
					choice: "monthly",
					date: base.date,
					days: base.days,
					dayOfMonth: String(schedule.day),
				};
		}
	})();
	return {
		title: task.title,
		question: task.question,
		horizonYears: task.horizonYears,
		markets: { JP: task.markets.includes("JP"), US: task.markets.includes("US") },
		...scheduleFields,
		time: schedule.time,
		timeZone: task.timeZone,
		consent: need.kind === "needed" && sameConsent(task.spendConsent, need.consent),
	};
}

/** Adds or removes one weekday, keeping the days ascending without repeats. */
export function toggleWeekday(
	days: readonly ScheduleWeekday[],
	day: ScheduleWeekday,
): readonly ScheduleWeekday[] {
	const next = days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day];
	return [...next].sort((a, b) => a - b);
}

/** The draft's schedule, or null with the problem that stops it. */
function draftSchedule(
	draft: TaskDraft,
	text: TasksText,
): { readonly schedule: TaskSchedule | null; readonly problems: readonly string[] } {
	const problems: string[] = [];
	if (parseLocalTime(draft.time) === null) problems.push(text.timeInvalid);
	const time = draft.time;
	switch (draft.choice) {
		case "once":
			if (!isValidIsoDate(draft.date)) problems.push(text.dateInvalid);
			return {
				schedule: problems.length === 0 ? { kind: "once", date: draft.date, time } : null,
				problems,
			};
		case "daily":
			return { schedule: problems.length === 0 ? { kind: "daily", time } : null, problems };
		case "weekdays":
			return {
				schedule: problems.length === 0 ? { kind: "weekly", days: WEEKDAYS_PRESET, time } : null,
				problems,
			};
		case "weekly":
			if (draft.days.length === 0) problems.push(text.chooseDay);
			return {
				schedule: problems.length === 0 ? { kind: "weekly", days: draft.days, time } : null,
				problems,
			};
		case "monthly": {
			const day = /^\d{1,2}$/.test(draft.dayOfMonth.trim()) ? Number(draft.dayOfMonth) : Number.NaN;
			if (!Number.isInteger(day) || day < 1 || day > 31) problems.push(text.dayOfMonthInvalid);
			return {
				schedule: problems.length === 0 ? { kind: "monthly", day, time } : null,
				problems,
			};
		}
	}
}

export interface TaskDraftEvaluation {
	/** Why Save is disabled, each with what to do; empty when `request` is set. */
	readonly problems: readonly string[];
	readonly request: CreateScheduledTaskRequest | null;
	readonly consentNeed: TaskConsentNeed;
}

/**
 * Checks the draft as the server will (the contract's bounds, a `once` in
 * the future, consent while the saved backend needs it) and builds the
 * request. The request is finally parsed with the contract's own schema,
 * so the editor can never send what the server would refuse as malformed.
 */
export function evaluateTaskDraft(
	draft: TaskDraft,
	need: TaskConsentNeed,
	nowMs: number,
	text: TasksText,
): TaskDraftEvaluation {
	const problems: string[] = [];
	const title = draft.title.trim();
	if (title.length < SCHEDULED_TASK_LIMITS.minTitleChars) problems.push(text.titleMissing);
	if (title.length > SCHEDULED_TASK_LIMITS.maxTitleChars) {
		problems.push(text.titleTooLong(SCHEDULED_TASK_LIMITS.maxTitleChars));
	}
	const question = draft.question.trim();
	if (question.length < SCHEDULED_TASK_LIMITS.minQuestionChars) {
		problems.push(text.questionTooShort(SCHEDULED_TASK_LIMITS.minQuestionChars));
	}
	if (question.length > SCHEDULED_TASK_LIMITS.maxQuestionChars) {
		problems.push(text.questionTooLong(SCHEDULED_TASK_LIMITS.maxQuestionChars));
	}
	const markets = (["JP", "US"] as const).filter((market) => draft.markets[market]);
	if (markets.length === 0) problems.push(text.chooseMarket);
	const scheduled = draftSchedule(draft, text);
	problems.push(...scheduled.problems);
	const zoneKnown = isValidTimeZone(draft.timeZone.trim());
	if (!zoneKnown) problems.push(text.zoneUnknown);
	if (
		scheduled.schedule !== null &&
		scheduled.schedule.kind === "once" &&
		zoneKnown &&
		nextRunAtMs(scheduled.schedule, draft.timeZone.trim(), nowMs) === null
	) {
		problems.push(text.inPast);
	}
	if (need.kind === "loading") problems.push(text.agentsLoading);
	if (need.kind === "no-ceiling") problems.push(text.meteredNeedsSpend(need.backendName));
	if (need.kind === "needed" && !draft.consent) problems.push(text.confirmConsent);
	if (problems.length > 0 || scheduled.schedule === null) {
		return { problems, request: null, consentNeed: need };
	}
	const parsed = createScheduledTaskRequestSchema.safeParse({
		title,
		question,
		horizonYears: draft.horizonYears,
		markets,
		schedule: scheduled.schedule,
		timeZone: draft.timeZone.trim(),
		spendConsent: need.kind === "needed" ? need.consent : null,
	});
	if (!parsed.success) {
		return {
			problems: parsed.error.issues.map((issue) => issue.message),
			request: null,
			consentNeed: need,
		};
	}
	return { problems: [], request: parsed.data, consentNeed: need };
}

/** The sentence a refused task write adds beside its error code, when it has one. */
export function taskFailureHint(failure: ApiFailure, text: TasksText): string | null {
	if (failure.code === "VERSION_CONFLICT") return text.versionConflict;
	if (failure.code !== "VALIDATION_FAILED") return null;
	if (failure.detail === TASK_VALIDATION_DETAILS.full) {
		return text.tasksFull(SCHEDULED_TASK_LIMITS.maxActive, SCHEDULED_TASK_LIMITS.maxTasks);
	}
	if (failure.detail === TASK_VALIDATION_DETAILS.inPast) return text.scheduleInPast;
	if (failure.detail === TASK_VALIDATION_DETAILS.completed) return text.taskCompleted;
	return null;
}
