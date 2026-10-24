import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	decideTaskTick,
	isValidSchedule,
	localMinuteOf,
	nextLocalSlot,
	type ScheduleWeekday,
	type TaskSchedule,
	type TaskTick,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between the scheduled-task algorithms
 * (`packages/domain/src/schedule/schedule.ts`, ADR-0033) and the Lean 4
 * model in `formal/ResearchFormal/Schedule.lean`.
 *
 * `formal/Export.lean` evaluates the verified `nextLocalSlot` over 31
 * schedules (every kind, monthly days 28–31 for last-day clamping, malformed
 * ones) × 22 local instants around month ends, leap days (2024, 2000) and a
 * non-leap century (2100) — 682 vectors — and the verified `decideTaskTick`
 * over 360 task states (status × next run missed / due / not yet due ×
 * unfinished run, five schedules, three instants). Each vector is replayed
 * here. The Lean calendar is its own (month lengths summed from 1970); the
 * TypeScript uses Hinnant's closed form, so `localMinuteOf` is checked
 * against the model's minute for every sample instant as well.
 */

const WEEKDAYS: readonly ScheduleWeekday[] = [0, 1, 2, 3, 4, 5, 6];

/** A weekday the contract type can hold, or null for one it cannot (e.g. 7). */
function weekdayOf(value: number): ScheduleWeekday | null {
	return WEEKDAYS.find((day) => day === value) ?? null;
}

const scheduleVector = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("once"), date: z.string(), time: z.string() }),
	z.object({ kind: z.literal("daily"), time: z.string() }),
	z.object({ kind: z.literal("weekly"), days: z.array(z.number().int()), time: z.string() }),
	z.object({ kind: z.literal("monthly"), day: z.number().int(), time: z.string() }),
]);
type ScheduleVector = z.infer<typeof scheduleVector>;

const statusSchema = z.enum(["active", "paused", "completed"]);

const scheduleVectors = z.object({
	nextLocalSlot: z.array(
		z.object({
			schedule: scheduleVector,
			afterDate: z.string(),
			afterTime: z.string(),
			after: z.number().int(),
			valid: z.boolean(),
			slot: z.number().int().nullable(),
		}),
	),
	taskTick: z.array(
		z.object({
			schedule: scheduleVector,
			now: z.number().int(),
			status: statusSchema,
			nextRunAt: z.number().int().nullable(),
			hasUnfinishedRun: z.boolean(),
			tick: z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("idle") }),
				z.object({ kind: z.literal("wait") }),
				z.object({
					kind: z.literal("fire"),
					slot: z.number().int(),
					nextRunAt: z.number().int().nullable(),
					status: statusSchema,
				}),
			]),
		}),
	),
});

const vectors = scheduleVectors.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

/** The vector's schedule as the domain type, or null when the type cannot express it. */
function toSchedule(vector: ScheduleVector): TaskSchedule | null {
	switch (vector.kind) {
		case "once":
		case "daily":
		case "monthly":
			return vector;
		case "weekly": {
			const days: ScheduleWeekday[] = [];
			for (const value of vector.days) {
				const day = weekdayOf(value);
				if (day === null) return null;
				days.push(day);
			}
			return { kind: "weekly", days, time: vector.time };
		}
	}
}

function scheduleOf(vector: ScheduleVector): TaskSchedule {
	const schedule = toSchedule(vector);
	if (schedule === null) throw new Error(`unrepresentable schedule ${JSON.stringify(vector)}`);
	return schedule;
}

describe("Lean conformance: scheduled tasks (ADR-0033)", () => {
	it("exports the expected vector counts", () => {
		expect(vectors.nextLocalSlot).toHaveLength(682);
		expect(vectors.taskTick).toHaveLength(360);
		// The grid exercises every outcome, not only the common one.
		expect(vectors.nextLocalSlot.filter((v) => v.slot === null).length).toBeGreaterThan(0);
		expect(vectors.taskTick.filter((v) => v.tick.kind === "fire").length).toBeGreaterThan(0);
		expect(vectors.taskTick.filter((v) => v.tick.kind === "wait").length).toBeGreaterThan(0);
	});

	it("agrees with localMinuteOf on every sample instant (the two calendars)", () => {
		for (const vector of vectors.nextLocalSlot) {
			expect(localMinuteOf(vector.afterDate, vector.afterTime)).toBe(vector.after);
		}
	});

	it(`agrees with nextLocalSlot and isValidSchedule on all ${vectors.nextLocalSlot.length} vectors`, () => {
		for (const vector of vectors.nextLocalSlot) {
			const schedule = toSchedule(vector.schedule);
			if (schedule === null) {
				// A weekday outside 0–6 cannot even be written as a TaskSchedule;
				// the model rejects it too.
				expect(vector.valid).toBe(false);
				expect(vector.slot).toBeNull();
				continue;
			}
			const label = `${JSON.stringify(vector.schedule)} after ${vector.afterDate} ${vector.afterTime}`;
			expect(isValidSchedule(schedule), label).toBe(vector.valid);
			expect(nextLocalSlot(schedule, vector.after), label).toBe(vector.slot);
		}
	});

	it(`agrees with decideTaskTick on all ${vectors.taskTick.length} vectors`, () => {
		for (const vector of vectors.taskTick) {
			const schedule = scheduleOf(vector.schedule);
			const expected: TaskTick =
				vector.tick.kind === "fire"
					? {
							kind: "fire",
							slotMs: vector.tick.slot,
							nextRunAtMs: vector.tick.nextRunAt,
							status: vector.tick.status,
						}
					: { kind: vector.tick.kind };
			const actual = decideTaskTick(
				{
					status: vector.status,
					nextRunAtMs: vector.nextRunAt,
					hasUnfinishedRun: vector.hasUnfinishedRun,
				},
				vector.now,
				(after) => nextLocalSlot(schedule, after),
			);
			expect(actual, JSON.stringify(vector)).toEqual(expected);
		}
	});
});
