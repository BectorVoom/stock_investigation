import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isoDateOfDayNumber, isoDayNumber } from "../../src/finance/financialStatements.ts";
import { type KnownSyncDay, planSyncDays } from "../../src/sync/syncDays.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

describe("planSyncDays", () => {
	it("takes the weekdays of the window newest first", () => {
		// 2026-10-26 is a Monday; 10-31 / 11-01 are a weekend.
		expect(
			planSyncDays({ newest: "2026-11-02", oldest: "2026-10-26", known: [], nowMs: NOW, max: 10 }),
		).toEqual(["2026-11-02", "2026-10-30", "2026-10-29", "2026-10-28", "2026-10-27", "2026-10-26"]);
	});

	it("caps the plan at max, keeping the newest days", () => {
		expect(
			planSyncDays({ newest: "2026-11-02", oldest: "2026-10-01", known: [], nowMs: NOW, max: 3 }),
		).toEqual(["2026-11-02", "2026-10-30", "2026-10-29"]);
	});

	it("returns nothing for an empty window, max 0 or an invalid date", () => {
		const base = { known: [], nowMs: NOW };
		expect(planSyncDays({ ...base, newest: "2026-10-01", oldest: "2026-10-02", max: 5 })).toEqual(
			[],
		);
		expect(planSyncDays({ ...base, newest: "2026-10-02", oldest: "2026-10-01", max: 0 })).toEqual(
			[],
		);
		expect(planSyncDays({ ...base, newest: "2026-10-02", oldest: "2026-10-01", max: -1 })).toEqual(
			[],
		);
		expect(planSyncDays({ ...base, newest: "2026-02-30", oldest: "2026-02-01", max: 5 })).toEqual(
			[],
		);
		expect(planSyncDays({ ...base, newest: "2026-11-01", oldest: "2026-10-31", max: 5 })).toEqual(
			[],
		);
	});

	it("keeps out final days and days whose retry time has not come", () => {
		const known: KnownSyncDay[] = [
			{ day: "2026-11-02", final: false, retryAtMs: NOW + 1 }, // not yet
			{ day: "2026-10-30", final: false, retryAtMs: NOW }, // due exactly now
			{ day: "2026-10-29", final: true, retryAtMs: 0 }, // stored
			{ day: "2026-10-28", final: false, retryAtMs: NOW - 1 }, // retry came
		];
		expect(
			planSyncDays({ newest: "2026-11-02", oldest: "2026-10-26", known, nowMs: NOW, max: 10 }),
		).toEqual(["2026-10-30", "2026-10-28", "2026-10-27", "2026-10-26"]);
	});

	it("skips blocked days without counting them against max", () => {
		const known: KnownSyncDay[] = [
			{ day: "2026-11-02", final: true, retryAtMs: 0 },
			{ day: "2026-10-30", final: true, retryAtMs: 0 },
		];
		expect(
			planSyncDays({ newest: "2026-11-02", oldest: "2026-10-01", known, nowMs: NOW, max: 2 }),
		).toEqual(["2026-10-29", "2026-10-28"]);
	});

	it("keeps a day out when any of its duplicate entries blocks it, and ignores invalid entries", () => {
		const known: KnownSyncDay[] = [
			{ day: "2026-10-30", final: false, retryAtMs: 0 },
			{ day: "2026-10-30", final: true, retryAtMs: 0 },
			{ day: "not-a-day", final: true, retryAtMs: 0 },
		];
		expect(
			planSyncDays({ newest: "2026-10-30", oldest: "2026-10-29", known, nowMs: NOW, max: 5 }),
		).toEqual(["2026-10-29"]);
	});

	it("walks across a leap day and a year boundary", () => {
		expect(
			planSyncDays({ newest: "2024-03-01", oldest: "2024-02-28", known: [], nowMs: NOW, max: 5 }),
		).toEqual(["2024-03-01", "2024-02-29", "2024-02-28"]);
		expect(
			planSyncDays({ newest: "2026-01-02", oldest: "2025-12-31", known: [], nowMs: NOW, max: 5 }),
		).toEqual(["2026-01-02", "2026-01-01", "2025-12-31"]);
	});
});

/** The reference: every due weekday of the window, newest first (no cap). */
function dueDays(
	newest: number,
	oldest: number,
	known: readonly KnownSyncDay[],
	nowMs: number,
): number[] {
	const due: number[] = [];
	for (let day = newest; day >= oldest; day -= 1) {
		const weekday = (((day + 4) % 7) + 7) % 7;
		if (weekday === 0 || weekday === 6) continue;
		const text = isoDateOfDayNumber(day);
		const blocks = known.some(
			(entry) => entry.day === text && (entry.final || nowMs < entry.retryAtMs),
		);
		if (!blocks) due.push(day);
	}
	return due;
}

describe("planSyncDays properties", () => {
	const BASE = 20_400; // 2025-11-08
	const scenario = fc
		.record({
			start: fc.integer({ min: 0, max: 60 }),
			length: fc.integer({ min: -3, max: 60 }),
			max: fc.integer({ min: -1, max: 15 }),
			nowOffset: fc.integer({ min: -5, max: 5 }),
			known: fc.array(
				fc.record({
					offset: fc.integer({ min: -5, max: 70 }),
					final: fc.boolean(),
					retryOffset: fc.integer({ min: -5, max: 5 }),
				}),
				{ maxLength: 40 },
			),
		})
		.map(({ start, length, max, nowOffset, known }) => {
			const oldest = BASE + start;
			const newest = oldest + length;
			const nowMs = 1_000_000 + nowOffset;
			return {
				oldest,
				newest,
				max,
				nowMs,
				known: known.map(
					(entry): KnownSyncDay => ({
						day: isoDateOfDayNumber(BASE + entry.offset),
						final: entry.final,
						retryAtMs: 1_000_000 + entry.retryOffset,
					}),
				),
			};
		});

	it("is exactly the first max due weekdays, newest first (subset, order, completeness, cap)", () => {
		fc.assert(
			fc.property(scenario, ({ oldest, newest, max, nowMs, known }) => {
				const plan = planSyncDays({
					newest: isoDateOfDayNumber(newest),
					oldest: isoDateOfDayNumber(oldest),
					known,
					nowMs,
					max,
				});
				const numbers = plan.map((day) => isoDayNumber(day));
				const due = dueDays(newest, oldest, known, nowMs);
				// Cap.
				expect(plan.length).toBeLessThanOrEqual(Math.max(0, max));
				// Strictly decreasing.
				for (let index = 1; index < numbers.length; index += 1) {
					expect(numbers[index] ?? 0).toBeLessThan(numbers[index - 1] ?? 0);
				}
				// Subset of the due weekdays.
				for (const day of numbers) expect(due).toContain(day);
				// Complete: a due day is missing only when max newer days were chosen.
				expect(numbers).toEqual(due.slice(0, Math.max(0, max)));
			}),
		);
	});
});
