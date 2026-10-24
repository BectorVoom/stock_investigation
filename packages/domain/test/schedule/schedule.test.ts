import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	decideTaskTick,
	isValidSchedule,
	localMinuteOf,
	nextLocalSlot,
	parseLocalTime,
	type ScheduleWeekday,
	type TaskSchedule,
	type TaskTickInput,
} from "../../src/schedule/schedule.ts";
import "../support/seededProperties.ts";

/**
 * ADR-0033 §2. Expected values come from `Date.UTC` (local wall-clock time
 * read as if it were UTC), an oracle independent of the implementation's
 * Hinnant arithmetic, and from dates worked out by hand (2026-10-24 is a
 * Saturday; 2024 and 2000 are leap years, 2100 is not).
 */

const MINUTE_MS = 60_000;

/** The local minute of `YYYY-MM-DDTHH:MM`, via `Date.UTC`. */
function lm(text: string): number {
	return Date.parse(`${text}:00.000Z`) / MINUTE_MS;
}

/** Whether `schedule` names local minute `minute`, decided with `Date` only. */
function namesMinute(schedule: TaskSchedule, minute: number): boolean {
	const time = parseLocalTime(schedule.time);
	if (time === null || ((minute % 1440) + 1440) % 1440 !== time) return false;
	const date = new Date(minute * MINUTE_MS);
	switch (schedule.kind) {
		case "once":
			return date.toISOString().slice(0, 10) === schedule.date;
		case "daily":
			return true;
		case "weekly":
			return schedule.days.some((day) => day === date.getUTCDay());
		case "monthly": {
			const lastDay = new Date(
				Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
			).getUTCDate();
			return date.getUTCDate() === Math.min(schedule.day, lastDay);
		}
	}
}

const weekdays: readonly ScheduleWeekday[] = [0, 1, 2, 3, 4, 5, 6];
const MON_FRI: readonly ScheduleWeekday[] = [1, 2, 3, 4, 5];

describe("localMinuteOf / parseLocalTime", () => {
	it("counts minutes from 1970-01-01 00:00 local, before 1970 too", () => {
		expect(localMinuteOf("1970-01-01", "00:00")).toBe(0);
		expect(localMinuteOf("1970-01-02", "00:01")).toBe(1441);
		expect(localMinuteOf("1969-12-31", "23:59")).toBe(-1);
		expect(localMinuteOf("2026-10-24", "09:00")).toBe(lm("2026-10-24T09:00"));
		expect(localMinuteOf("2024-02-29", "12:00")).toBe(lm("2024-02-29T12:00"));
	});

	it("rejects text that is not a real date or a 24 h time", () => {
		expect(localMinuteOf("2026-02-29", "09:00")).toBeNull();
		expect(localMinuteOf("2026-10-24", "24:00")).toBeNull();
		for (const bad of ["9:00", "09:60", "24:00", "0900", "09:00:00", "", " 09:00"]) {
			expect(parseLocalTime(bad), bad).toBeNull();
		}
		expect(parseLocalTime("23:59")).toBe(1439);
		expect(parseLocalTime("00:00")).toBe(0);
	});
});

describe("nextLocalSlot", () => {
	it("daily: today's time when it is still ahead, else tomorrow's — strictly after", () => {
		const daily: TaskSchedule = { kind: "daily", time: "09:00" };
		expect(nextLocalSlot(daily, lm("2026-10-24T08:59"))).toBe(lm("2026-10-24T09:00"));
		expect(nextLocalSlot(daily, lm("2026-10-24T09:00"))).toBe(lm("2026-10-25T09:00"));
		expect(nextLocalSlot(daily, lm("2026-12-31T23:59"))).toBe(lm("2027-01-01T09:00"));
		expect(nextLocalSlot({ kind: "daily", time: "00:00" }, lm("2026-10-24T00:00"))).toBe(
			lm("2026-10-25T00:00"),
		);
		// Before 1970 the day still floors (negative local minutes).
		expect(nextLocalSlot(daily, lm("1969-12-31T08:00"))).toBe(lm("1969-12-31T09:00"));
	});

	it("weekly: the next listed weekday (the Weekdays preset skips the weekend)", () => {
		const weekdaysAt8: TaskSchedule = { kind: "weekly", days: MON_FRI, time: "08:00" };
		// Saturday → Monday.
		expect(nextLocalSlot(weekdaysAt8, lm("2026-10-24T12:00"))).toBe(lm("2026-10-26T08:00"));
		// Friday at the slot → Monday.
		expect(nextLocalSlot(weekdaysAt8, lm("2026-10-23T08:00"))).toBe(lm("2026-10-26T08:00"));
		expect(nextLocalSlot(weekdaysAt8, lm("2026-10-23T07:59"))).toBe(lm("2026-10-23T08:00"));
		// A single weekday at its own slot moves a whole week.
		const sundays: TaskSchedule = { kind: "weekly", days: [0], time: "23:59" };
		expect(nextLocalSlot(sundays, lm("2026-10-25T23:59"))).toBe(lm("2026-11-01T23:59"));
		// 1969-12-31 was a Wednesday.
		expect(
			nextLocalSlot({ kind: "weekly", days: [3], time: "09:00" }, lm("1969-12-30T09:00")),
		).toBe(lm("1969-12-31T09:00"));
	});

	it("monthly: the day of the month, clamped to a shorter month's last day", () => {
		const on31: TaskSchedule = { kind: "monthly", day: 31, time: "09:00" };
		expect(nextLocalSlot(on31, lm("2026-01-31T09:00"))).toBe(lm("2026-02-28T09:00"));
		expect(nextLocalSlot(on31, lm("2024-01-31T09:00"))).toBe(lm("2024-02-29T09:00"));
		expect(nextLocalSlot(on31, lm("2026-04-15T00:00"))).toBe(lm("2026-04-30T09:00"));
		expect(nextLocalSlot(on31, lm("2026-04-30T09:00"))).toBe(lm("2026-05-31T09:00"));
		expect(nextLocalSlot(on31, lm("2026-12-31T09:00"))).toBe(lm("2027-01-31T09:00"));
		expect(nextLocalSlot(on31, lm("2100-02-01T00:00"))).toBe(lm("2100-02-28T09:00"));
		expect(nextLocalSlot(on31, lm("2000-02-01T00:00"))).toBe(lm("2000-02-29T09:00"));
		const on30: TaskSchedule = { kind: "monthly", day: 30, time: "09:00" };
		expect(nextLocalSlot(on30, lm("2026-02-01T00:00"))).toBe(lm("2026-02-28T09:00"));
		// After the clamped day, the next month runs on the real day again.
		expect(nextLocalSlot(on30, lm("2026-02-28T09:00"))).toBe(lm("2026-03-30T09:00"));
		const on1: TaskSchedule = { kind: "monthly", day: 1, time: "00:00" };
		expect(nextLocalSlot(on1, lm("2026-10-01T00:00"))).toBe(lm("2026-11-01T00:00"));
	});

	it("once: its own minute while ahead, then none", () => {
		const once: TaskSchedule = { kind: "once", date: "2026-10-24", time: "09:00" };
		expect(nextLocalSlot(once, lm("2026-10-24T08:59"))).toBe(lm("2026-10-24T09:00"));
		expect(nextLocalSlot(once, lm("2026-10-24T09:00"))).toBeNull();
		expect(nextLocalSlot(once, lm("2027-01-01T00:00"))).toBeNull();
	});

	it("answers none for a malformed schedule or a fractional minute", () => {
		const after = lm("2026-10-24T00:00");
		const malformed: readonly TaskSchedule[] = [
			{ kind: "daily", time: "24:00" },
			{ kind: "daily", time: "9:00" },
			{ kind: "weekly", days: [], time: "09:00" },
			{ kind: "weekly", days: [3, 1], time: "09:00" },
			{ kind: "weekly", days: [2, 2], time: "09:00" },
			{ kind: "monthly", day: 0, time: "09:00" },
			{ kind: "monthly", day: 32, time: "09:00" },
			{ kind: "monthly", day: 1.5, time: "09:00" },
			{ kind: "once", date: "2026-02-30", time: "09:00" },
			{ kind: "once", date: "2026-13-01", time: "09:00" },
		];
		for (const schedule of malformed) {
			expect(isValidSchedule(schedule), JSON.stringify(schedule)).toBe(false);
			expect(nextLocalSlot(schedule, after), JSON.stringify(schedule)).toBeNull();
		}
		expect(nextLocalSlot({ kind: "daily", time: "09:00" }, after + 0.5)).toBeNull();
	});

	const timeArb = fc
		.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
		.map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
	const daysArb = fc
		.subarray([...weekdays], { minLength: 1 })
		.map((days) => [...days].sort((a, b) => a - b));
	// 1960–2110: covers negative local minutes, leap days and the 2100 non-leap year.
	const minuteArb = fc.integer({ min: lm("1960-01-01T00:00"), max: lm("2110-01-01T00:00") });
	const recurringArb: fc.Arbitrary<TaskSchedule> = fc.oneof(
		timeArb.map((time): TaskSchedule => ({ kind: "daily", time })),
		fc
			.tuple(daysArb, timeArb)
			.map(([days, time]): TaskSchedule => ({ kind: "weekly", days, time })),
		fc
			.tuple(fc.integer({ min: 1, max: 31 }), timeArb)
			.map(([day, time]): TaskSchedule => ({ kind: "monthly", day, time })),
	);
	/** A `once` within a few days of the input, so both outcomes occur. */
	const onceNear = (after: number) =>
		fc.tuple(fc.integer({ min: -3 * 1440, max: 3 * 1440 }), timeArb).map(([offset, time]) => {
			const date = new Date((after + offset) * MINUTE_MS).toISOString().slice(0, 10);
			return { schedule: { kind: "once", date, time } satisfies TaskSchedule, after };
		});

	/** The first named minute after `after`, by checking every minute (62 days cover a month). */
	function bruteForceNext(schedule: TaskSchedule, after: number): number | null {
		for (let minute = after + 1; minute <= after + 62 * 1440; minute += 1) {
			if (namesMinute(schedule, minute)) return minute;
		}
		return null;
	}

	it("is the least named minute strictly after its input (brute force over minutes)", () => {
		fc.assert(
			fc.property(recurringArb, minuteArb, (schedule, after) => {
				const slot = nextLocalSlot(schedule, after);
				expect(slot).not.toBeNull();
				expect(slot ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(after);
				expect(slot).toBe(bruteForceNext(schedule, after));
			}),
			{ numRuns: 150 },
		);
	});

	it("gives a once schedule its own minute exactly while it is ahead", () => {
		fc.assert(
			fc.property(
				minuteArb.chain((after) => onceNear(after)),
				({ schedule, after }) => {
					const own = localMinuteOf(schedule.date, schedule.time);
					expect(nextLocalSlot(schedule, after)).toBe(own !== null && own > after ? own : null);
					expect(nextLocalSlot(schedule, after)).toBe(bruteForceNext(schedule, after));
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe("decideTaskTick", () => {
	const daily: TaskSchedule = { kind: "daily", time: "09:00" };
	const nextDaily = (after: number) => nextLocalSlot(daily, after);
	const now = lm("2026-10-24T09:05");
	const due = lm("2026-10-24T09:00");

	it("does nothing for a paused, completed, unscheduled or not-yet-due task", () => {
		const idle: readonly TaskTickInput[] = [
			{ status: "paused", nextRunAtMs: due, hasUnfinishedRun: false },
			{ status: "completed", nextRunAtMs: due, hasUnfinishedRun: false },
			{ status: "active", nextRunAtMs: null, hasUnfinishedRun: false },
			{ status: "active", nextRunAtMs: now + 1, hasUnfinishedRun: false },
		];
		for (const task of idle) {
			expect(decideTaskTick(task, now, nextDaily), JSON.stringify(task)).toEqual({ kind: "idle" });
		}
	});

	it("waits while the task's last run is unfinished", () => {
		expect(
			decideTaskTick(
				{ status: "active", nextRunAtMs: due, hasUnfinishedRun: true },
				now,
				nextDaily,
			),
		).toEqual({ kind: "wait" });
	});

	it("fires at its slot (inclusive) and schedules the next one", () => {
		expect(
			decideTaskTick(
				{ status: "active", nextRunAtMs: due, hasUnfinishedRun: false },
				due,
				nextDaily,
			),
		).toEqual({
			kind: "fire",
			slotMs: due,
			nextRunAtMs: lm("2026-10-25T09:00"),
			status: "active",
		});
	});

	it("runs once on return: three missed days collapse into one run, next after now", () => {
		const missed = lm("2026-10-21T09:00");
		const tick = decideTaskTick(
			{ status: "active", nextRunAtMs: missed, hasUnfinishedRun: false },
			now,
			nextDaily,
		);
		expect(tick).toEqual({
			kind: "fire",
			slotMs: missed,
			nextRunAtMs: lm("2026-10-25T09:00"),
			status: "active",
		});
		// The stored result does not fire again before its next slot.
		if (tick.kind !== "fire") throw new Error("expected a fire");
		expect(
			decideTaskTick(
				{ status: tick.status, nextRunAtMs: tick.nextRunAtMs, hasUnfinishedRun: false },
				now + 60,
				nextDaily,
			),
		).toEqual({ kind: "idle" });
	});

	it("completes a once task when it fires, and when the schedule answers no time after now", () => {
		const once: TaskSchedule = { kind: "once", date: "2026-10-24", time: "09:00" };
		expect(
			decideTaskTick(
				{ status: "active", nextRunAtMs: due, hasUnfinishedRun: false },
				now,
				(after) => nextLocalSlot(once, after),
			),
		).toEqual({ kind: "fire", slotMs: due, nextRunAtMs: null, status: "completed" });
		// A schedule function that answers a time not after now cannot keep the task due.
		expect(
			decideTaskTick(
				{ status: "active", nextRunAtMs: due, hasUnfinishedRun: false },
				now,
				() => now,
			),
		).toEqual({ kind: "fire", slotMs: due, nextRunAtMs: null, status: "completed" });
	});

	it("never fires an inactive, undue or busy task, and a fire's next run is after now", () => {
		const taskArb = fc.record({
			status: fc.constantFrom("active" as const, "paused" as const, "completed" as const),
			nextRunAtMs: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }),
			hasUnfinishedRun: fc.boolean(),
		});
		fc.assert(
			fc.property(
				taskArb,
				fc.integer({ min: 0, max: 10_000 }),
				fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
				(task, nowMs, answer) => {
					const tick = decideTaskTick(task, nowMs, () => answer);
					const fires =
						task.status === "active" &&
						task.nextRunAtMs !== null &&
						task.nextRunAtMs <= nowMs &&
						!task.hasUnfinishedRun;
					expect(tick.kind === "fire").toBe(fires);
					if (tick.kind !== "fire") return;
					expect(tick.slotMs).toBe(task.nextRunAtMs);
					if (tick.nextRunAtMs === null) expect(tick.status).toBe("completed");
					else {
						expect(tick.nextRunAtMs).toBeGreaterThan(nowMs);
						expect(tick.status).toBe("active");
					}
				},
			),
		);
	});
});
