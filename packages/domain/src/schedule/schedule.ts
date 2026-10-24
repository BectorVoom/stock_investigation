import { isValidIsoDate } from "../calendar/civilDate.ts";
import { civilFromDays, daysFromCivil, daysInMonth } from "../calendar/monthGrid.ts";

/**
 * Scheduled tasks (ADR-0033): when a research question saved with a
 * schedule runs next, and whether a due task fires now. Pure: time zones
 * enter through `timeZone.ts`, the clock through the caller.
 */

/** Every bound of a scheduled task; contracts builds its schemas from this object. */
export const SCHEDULED_TASK_LIMITS = {
	/** Tasks with status `active` at once (ChatGPT's own limit). */
	maxActive: 10,
	/** Tasks stored in all (active, paused and completed). */
	maxTasks: 30,
	minTitleChars: 1,
	maxTitleChars: 120,
	minQuestionChars: 3,
	maxQuestionChars: 2000,
} as const;

export const MINUTES_PER_DAY = 1440;

/** 0 = Sunday … 6 = Saturday (the `Date#getUTCDay` numbering). */
export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * When a task runs, in the owner's local wall-clock time. `time` is `HH:MM`
 * (24 h); `date` is `YYYY-MM-DD`; `days` are ascending without repeats; a
 * `monthly` day a month lacks runs on that month's last day.
 */
export type TaskSchedule =
	| { readonly kind: "once"; readonly date: string; readonly time: string }
	| { readonly kind: "daily"; readonly time: string }
	| {
			readonly kind: "weekly";
			readonly days: readonly ScheduleWeekday[];
			readonly time: string;
	  }
	| { readonly kind: "monthly"; readonly day: number; readonly time: string };

export type TaskStatus = "active" | "paused" | "completed";

/**
 * A local wall-clock minute as one integer: the civil day number since
 * 1970-01-01 times 1440 plus the minute of the day. Ordering these is
 * ordering local times; no time zone is involved.
 */
export type LocalMinute = number;

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for `HH:MM`, or null when the text is not a 24 h time. */
export function parseLocalTime(time: string): number | null {
	const match = LOCAL_TIME.exec(time);
	if (match === null) return null;
	return Number(match[1]) * 60 + Number(match[2]);
}

/** The local minute of a civil date and `HH:MM`, or null when either is invalid. */
export function localMinuteOf(date: string, time: string): LocalMinute | null {
	const minuteOfDay = parseLocalTime(time);
	if (minuteOfDay === null || !isValidIsoDate(date)) return null;
	const day = daysFromCivil(
		Number(date.slice(0, 4)),
		Number(date.slice(5, 7)),
		Number(date.slice(8, 10)),
	);
	return day * MINUTES_PER_DAY + minuteOfDay;
}

function weekdayOfDay(day: number): ScheduleWeekday {
	const index = (((4 + day) % 7) + 7) % 7;
	const weekdays: readonly ScheduleWeekday[] = [0, 1, 2, 3, 4, 5, 6];
	return weekdays[index] ?? 0;
}

/** Whether a schedule is well formed: a valid time, date, ascending distinct days, a day 1–31. */
export function isValidSchedule(schedule: TaskSchedule): boolean {
	if (parseLocalTime(schedule.time) === null) return false;
	switch (schedule.kind) {
		case "once":
			return isValidIsoDate(schedule.date);
		case "daily":
			return true;
		case "weekly":
			return (
				schedule.days.length >= 1 &&
				schedule.days.every(
					(day, index) =>
						Number.isInteger(day) &&
						day >= 0 &&
						day <= 6 &&
						(index === 0 || day > (schedule.days[index - 1] ?? 7)),
				)
			);
		case "monthly":
			return Number.isInteger(schedule.day) && schedule.day >= 1 && schedule.day <= 31;
	}
}

/**
 * The first local minute strictly after `after` that the schedule names, or
 * null when there is none (a `once` already passed, or a malformed
 * schedule). Daily, weekly and monthly schedules always have one: a weekly
 * slot lies within the next 7 days and a monthly one (clamped to the last
 * day) within this month or the next.
 */
export function nextLocalSlot(schedule: TaskSchedule, after: LocalMinute): LocalMinute | null {
	if (!isValidSchedule(schedule) || !Number.isInteger(after)) return null;
	const minuteOfDay = parseLocalTime(schedule.time) ?? 0;
	const afterDay = Math.floor(after / MINUTES_PER_DAY);
	switch (schedule.kind) {
		case "once": {
			const slot = localMinuteOf(schedule.date, schedule.time);
			return slot !== null && slot > after ? slot : null;
		}
		case "daily": {
			const today = afterDay * MINUTES_PER_DAY + minuteOfDay;
			return today > after ? today : today + MINUTES_PER_DAY;
		}
		case "weekly": {
			for (let offset = 0; offset <= 7; offset += 1) {
				const day = afterDay + offset;
				const slot = day * MINUTES_PER_DAY + minuteOfDay;
				if (slot > after && schedule.days.includes(weekdayOfDay(day))) return slot;
			}
			return null;
		}
		case "monthly": {
			const start = civilFromDays(afterDay);
			for (let step = 0; step <= 1; step += 1) {
				const monthIndex = start.year * 12 + (start.month - 1) + step;
				const year = Math.floor(monthIndex / 12);
				const month = monthIndex - year * 12 + 1;
				const day = Math.min(schedule.day, daysInMonth(year, month));
				const slot = daysFromCivil(year, month, day) * MINUTES_PER_DAY + minuteOfDay;
				if (slot > after) return slot;
			}
			return null;
		}
	}
}

/** What a task does at one claim (ADR-0033 §2). */
export type TaskTick =
	/** Paused, completed, or not yet due: nothing to do. */
	| { readonly kind: "idle" }
	/** Due, but the task's last run has not finished: fire once it has. */
	| { readonly kind: "wait" }
	/**
	 * Queue one run for `slotMs`, then store `nextRunAtMs` (strictly after
	 * now, so every missed slot collapses into this run) and `status`.
	 */
	| {
			readonly kind: "fire";
			readonly slotMs: number;
			readonly nextRunAtMs: number | null;
			readonly status: TaskStatus;
	  };

export interface TaskTickInput {
	readonly status: TaskStatus;
	readonly nextRunAtMs: number | null;
	readonly hasUnfinishedRun: boolean;
}

/**
 * Whether a task fires at `nowMs`. `nextAfter(ms)` is the schedule's next
 * instant strictly after `ms` (`nextRunAtMs` bound to the task's schedule
 * and zone). A fire's next run is computed from now, never from the slot,
 * so a task that was due many times while no runner polled runs once.
 */
export function decideTaskTick(
	task: TaskTickInput,
	nowMs: number,
	nextAfter: (afterMs: number) => number | null,
): TaskTick {
	if (task.status !== "active" || task.nextRunAtMs === null || task.nextRunAtMs > nowMs) {
		return { kind: "idle" };
	}
	if (task.hasUnfinishedRun) return { kind: "wait" };
	const next = nextAfter(nowMs);
	const nextRunAtMs = next !== null && next > nowMs ? next : null;
	return {
		kind: "fire",
		slotMs: task.nextRunAtMs,
		nextRunAtMs,
		status: nextRunAtMs === null ? "completed" : "active",
	};
}
