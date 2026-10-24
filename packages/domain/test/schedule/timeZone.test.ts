import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	decideTaskTick,
	localMinuteOf,
	nextLocalSlot,
	type TaskSchedule,
} from "../../src/schedule/schedule.ts";
import {
	isValidTimeZone,
	localMinuteToUtcMs,
	nextRunAtMs,
	utcMsToLocalMinute,
} from "../../src/schedule/timeZone.ts";
import "../support/seededProperties.ts";

/**
 * ADR-0033 §2: local wall-clock schedules in IANA zones, with Temporal's
 * `compatible` disambiguation. Expected instants are written out by hand from
 * the zones' published rules for 2026:
 *
 * - Asia/Tokyo: UTC+9, no daylight saving.
 * - America/New_York: EST (UTC−5) → EDT (UTC−4) on Sunday 2026-03-08 at
 *   02:00 local (07:00Z), back on Sunday 2026-11-01 at 02:00 EDT (06:00Z).
 * - Europe/London: GMT → BST (UTC+1) on Sunday 2026-03-29 at 01:00Z, back on
 *   Sunday 2026-10-25 at 01:00Z.
 */

const at = (iso: string): number => Date.parse(iso);
const local = (date: string, time: string): number => {
	const minute = localMinuteOf(date, time);
	if (minute === null) throw new Error(`bad local time ${date} ${time}`);
	return minute;
};

const NY = "America/New_York";
const daily = (time: string): TaskSchedule => ({ kind: "daily", time });

describe("isValidTimeZone", () => {
	it("knows IANA zones and refuses anything else", () => {
		for (const zone of ["Asia/Tokyo", "UTC", NY, "Europe/London"]) {
			expect(isValidTimeZone(zone), zone).toBe(true);
		}
		for (const zone of ["Mars/Olympus", "", "Asia/Tokyo ", "x".repeat(65), "+25:00"]) {
			expect(isValidTimeZone(zone), zone).toBe(false);
		}
	});

	it("leaves an unknown zone to the caller to refuse: the conversions throw RangeError", () => {
		expect(() => nextRunAtMs(daily("09:00"), "Mars/Olympus", at("2026-10-24T00:00:00Z"))).toThrow(
			RangeError,
		);
	});
});

describe("utcMsToLocalMinute / localMinuteToUtcMs", () => {
	it("reads a UTC instant as the zone's wall-clock minute, seconds dropped", () => {
		expect(utcMsToLocalMinute(at("2026-10-24T00:00:59.999Z"), "Asia/Tokyo")).toBe(
			local("2026-10-24", "09:00"),
		);
		expect(utcMsToLocalMinute(at("2026-10-24T00:00:00Z"), "UTC")).toBe(
			local("2026-10-24", "00:00"),
		);
		expect(utcMsToLocalMinute(at("2026-07-01T12:00:00Z"), NY)).toBe(local("2026-07-01", "08:00"));
		expect(utcMsToLocalMinute(at("2026-01-01T12:00:00Z"), NY)).toBe(local("2026-01-01", "07:00"));
		expect(utcMsToLocalMinute(at("2026-07-01T12:00:00Z"), "Europe/London")).toBe(
			local("2026-07-01", "13:00"),
		);
	});

	it("resolves a skipped minute later by the jump and a repeated one to its first pass", () => {
		// 02:30 does not exist on 2026-03-08 in New York: it runs at 03:30 EDT.
		expect(localMinuteToUtcMs(local("2026-03-08", "02:30"), NY)).toBe(at("2026-03-08T07:30:00Z"));
		// 01:30 happens twice on 2026-11-01: first at 01:30 EDT (05:30Z).
		expect(localMinuteToUtcMs(local("2026-11-01", "01:30"), NY)).toBe(at("2026-11-01T05:30:00Z"));
		// London: 01:30 is skipped on 2026-03-29 (→ 02:30 BST = 01:30Z) and repeated on 2026-10-25.
		expect(localMinuteToUtcMs(local("2026-03-29", "01:30"), "Europe/London")).toBe(
			at("2026-03-29T01:30:00Z"),
		);
		expect(localMinuteToUtcMs(local("2026-10-25", "01:30"), "Europe/London")).toBe(
			at("2026-10-25T00:30:00Z"),
		);
		expect(localMinuteToUtcMs(local("2026-10-24", "09:00"), "Asia/Tokyo")).toBe(
			at("2026-10-24T00:00:00Z"),
		);
	});
});

describe("nextRunAtMs", () => {
	it("Asia/Tokyo: local times nine hours ahead, across the UTC date line", () => {
		expect(nextRunAtMs(daily("08:00"), "Asia/Tokyo", at("2026-10-24T00:00:00Z"))).toBe(
			at("2026-10-24T23:00:00Z"),
		);
		// Monday 08:00 JST is Sunday 23:00Z.
		const mondays: TaskSchedule = { kind: "weekly", days: [1], time: "08:00" };
		expect(nextRunAtMs(mondays, "Asia/Tokyo", at("2026-10-24T00:00:00Z"))).toBe(
			at("2026-10-25T23:00:00Z"),
		);
		const on31: TaskSchedule = { kind: "monthly", day: 31, time: "09:00" };
		expect(nextRunAtMs(on31, "Asia/Tokyo", at("2026-02-01T00:00:00Z"))).toBe(
			at("2026-02-28T00:00:00Z"),
		);
	});

	it("UTC: the local minute is the instant", () => {
		expect(nextRunAtMs(daily("09:00"), "UTC", at("2026-10-24T09:00:00Z"))).toBe(
			at("2026-10-25T09:00:00Z"),
		);
		expect(nextRunAtMs(daily("09:00"), "UTC", at("2026-10-24T08:59:59.999Z"))).toBe(
			at("2026-10-24T09:00:00Z"),
		);
		const once: TaskSchedule = { kind: "once", date: "2026-10-24", time: "09:00" };
		expect(nextRunAtMs(once, "UTC", at("2026-10-24T09:00:00Z"))).toBeNull();
	});

	it("America/New_York spring forward: 02:30 runs at 03:30 EDT, then 02:30 EDT", () => {
		const at0230 = daily("02:30");
		expect(nextRunAtMs(at0230, NY, at("2026-03-08T05:00:00Z"))).toBe(at("2026-03-08T07:30:00Z"));
		expect(nextRunAtMs(at0230, NY, at("2026-03-08T07:30:00Z"))).toBe(at("2026-03-09T06:30:00Z"));
		const once: TaskSchedule = { kind: "once", date: "2026-03-08", time: "02:30" };
		expect(nextRunAtMs(once, NY, at("2026-03-08T07:00:00Z"))).toBe(at("2026-03-08T07:30:00Z"));
	});

	it("America/New_York spring forward: an instant between 03:00 and 03:30 EDT still gets that day's 03:30", () => {
		// 03:10 EDT (07:10Z): the day's 02:30 resolves to 03:30 EDT (07:30Z),
		// the schedule's first instant strictly after it.
		expect(nextRunAtMs(daily("02:30"), NY, at("2026-03-08T07:10:00Z"))).toBe(
			at("2026-03-08T07:30:00Z"),
		);
	});

	it("America/New_York fall back: 01:30 runs at its first pass only", () => {
		const at0130 = daily("01:30");
		expect(nextRunAtMs(at0130, NY, at("2026-11-01T04:00:00Z"))).toBe(at("2026-11-01T05:30:00Z"));
		// After the first pass the next run is the next day's 01:30 EST, not the second pass (06:30Z).
		expect(nextRunAtMs(at0130, NY, at("2026-11-01T05:30:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
		// From inside the repeated hour (01:00 EST, second pass) the first pass is behind.
		expect(nextRunAtMs(at0130, NY, at("2026-11-01T06:00:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
	});

	it("America/New_York fall back: the second pass does not fire the task again", () => {
		const at0130 = daily("01:30");
		const nextAfter = (ms: number) => nextRunAtMs(at0130, NY, ms);
		const first = decideTaskTick(
			{ status: "active", nextRunAtMs: at("2026-11-01T05:30:00Z"), hasUnfinishedRun: false },
			at("2026-11-01T05:30:30Z"),
			nextAfter,
		);
		expect(first).toEqual({
			kind: "fire",
			slotMs: at("2026-11-01T05:30:00Z"),
			nextRunAtMs: at("2026-11-02T06:30:00Z"),
			status: "active",
		});
		if (first.kind !== "fire") throw new Error("expected a fire");
		// 06:31Z is 01:31 EST, the second 01:31 of the day.
		expect(
			decideTaskTick(
				{ status: first.status, nextRunAtMs: first.nextRunAtMs, hasUnfinishedRun: false },
				at("2026-11-01T06:31:00Z"),
				nextAfter,
			),
		).toEqual({ kind: "idle" });
	});

	it("Europe/London: wall-clock time holds across both changes", () => {
		expect(nextRunAtMs(daily("09:00"), "Europe/London", at("2026-10-24T12:00:00Z"))).toBe(
			at("2026-10-25T09:00:00Z"),
		);
		expect(nextRunAtMs(daily("09:00"), "Europe/London", at("2026-10-24T07:00:00Z"))).toBe(
			at("2026-10-24T08:00:00Z"),
		);
		expect(nextRunAtMs(daily("01:30"), "Europe/London", at("2026-03-29T00:00:00Z"))).toBe(
			at("2026-03-29T01:30:00Z"),
		);
	});

	const zones = ["UTC", "Asia/Tokyo", NY, "Europe/London"] as const;
	const timeArb = fc
		.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
		.map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
	// 2025–2028, so every daylight-saving change of those years is in range.
	const instantArb = fc.integer({
		min: at("2025-01-01T00:00:00Z"),
		max: at("2028-12-31T00:00:00Z"),
	});

	it("is strictly after its input, on the schedule's wall-clock time unless skipped", () => {
		fc.assert(
			fc.property(fc.constantFrom(...zones), timeArb, instantArb, (zone, time, afterMs) => {
				const next = nextRunAtMs(daily(time), zone, afterMs);
				if (next === null) throw new Error("a daily schedule always has a next run");
				expect(next).toBeGreaterThan(afterMs);
				const wall = utcMsToLocalMinute(next, zone);
				const wanted = Math.floor(wall / 1440) * 1440 + (localMinuteOf("1970-01-01", time) ?? 0);
				// Exactly the time, or (in a forward jump) later by at most the jump.
				expect(wall - wanted).toBeGreaterThanOrEqual(0);
				expect(wall - wanted).toBeLessThanOrEqual(60);
				// Within a day and a jump of its input: no day is skipped.
				expect(next - afterMs).toBeLessThanOrEqual((1440 + 60) * 60_000);
			}),
			{ numRuns: 300 },
		);
	});

	it("is the earliest resolved slot after its input, also next to a daylight-saving change", () => {
		const transitions = [
			at("2026-03-08T07:00:00Z"),
			at("2026-11-01T06:00:00Z"),
			at("2026-03-29T01:00:00Z"),
			at("2026-10-25T01:00:00Z"),
		];
		const nearChange = fc
			.tuple(fc.constantFrom(...transitions), fc.integer({ min: -180, max: 180 }))
			.map(([change, minutes]) => change + minutes * 60_000);
		fc.assert(
			fc.property(
				fc.constantFrom(NY, "Europe/London"),
				timeArb,
				fc.oneof(nearChange, instantArb),
				(zone, time, afterMs) => {
					const minuteOfDay = localMinuteOf("1970-01-01", time) ?? 0;
					const day = Math.floor(utcMsToLocalMinute(afterMs, zone) / 1440);
					// Every day's slot, resolved on its own; the earliest one ahead is the answer.
					const ahead = [-1, 0, 1, 2]
						.map((offset) => localMinuteToUtcMs((day + offset) * 1440 + minuteOfDay, zone))
						.filter((utcMs) => utcMs > afterMs);
					expect(nextRunAtMs(daily(time), zone, afterMs)).toBe(Math.min(...ahead));
				},
			),
			{ numRuns: 400 },
		);
	});

	it("in a zone without daylight saving, is the local slot read back as UTC", () => {
		fc.assert(
			fc.property(timeArb, instantArb, (time, afterMs) => {
				const slot = nextLocalSlot(daily(time), utcMsToLocalMinute(afterMs, "Asia/Tokyo"));
				expect(slot).not.toBeNull();
				expect(nextRunAtMs(daily(time), "Asia/Tokyo", afterMs)).toBe(
					((slot ?? 0) - 9 * 60) * 60_000,
				);
			}),
		);
	});
});
