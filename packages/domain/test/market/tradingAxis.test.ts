import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { axisDay, axisPosition, axisSegment } from "../../src/market/tradingAxis.ts";

/** Day numbers of one trading fortnight: Mon 2026-10-19 (20,745) … Fri 10-30, no weekend. */
const MONDAY = 20_745;
const FORTNIGHT = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11].map((offset) => MONDAY + offset);
const FRIDAY = MONDAY + 4;
const SATURDAY = MONDAY + 5;
const SUNDAY = MONDAY + 6;
const NEXT_MONDAY = MONDAY + 7;

/** Float tolerance for values that are exact over the rationals. */
const close = (actual: number, expected: number) =>
	expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));

describe("axisSegment", () => {
	it("finds the last day ≤ the day, −1 before them all", () => {
		const days = [10, 12, 15];
		expect(axisSegment(days, 9)).toBe(-1);
		expect(axisSegment(days, 10)).toBe(0);
		expect(axisSegment(days, 11.5)).toBe(0);
		expect(axisSegment(days, 12)).toBe(1);
		expect(axisSegment(days, 14)).toBe(1);
		expect(axisSegment(days, 15)).toBe(2);
		expect(axisSegment(days, 99)).toBe(2);
		expect(axisSegment([], 5)).toBe(-1);
	});
});

describe("axisPosition / axisDay", () => {
	it("puts bar days on their index, so Monday follows Friday directly", () => {
		FORTNIGHT.forEach((day, index) => {
			expect(axisPosition(FORTNIGHT, day)).toBe(index);
			expect(axisDay(FORTNIGHT, index)).toBe(day);
		});
		expect(axisPosition(FORTNIGHT, NEXT_MONDAY) - axisPosition(FORTNIGHT, FRIDAY)).toBe(1);
	});

	it("places a weekend between Friday and Monday in proportion to calendar days (ADR-0057's 4 + 1/3)", () => {
		close(axisPosition(FORTNIGHT, SATURDAY), 4 + 1 / 3);
		close(axisPosition(FORTNIGHT, SUNDAY), 4 + 2 / 3);
		close(axisDay(FORTNIGHT, 4 + 1 / 3), SATURDAY);
		close(axisDay(FORTNIGHT, 4.5), FRIDAY + 1.5);
	});

	it("continues the outer gaps' slopes before the first and after the last day", () => {
		const days = [10, 12, 15];
		expect(axisPosition(days, 8)).toBe(-1);
		expect(axisPosition(days, 18)).toBe(3);
		expect(axisDay(days, -1)).toBe(8);
		expect(axisDay(days, 3)).toBe(18);
	});

	it("uses one position a day with one axis day and the identity with none", () => {
		expect(axisPosition([10], 13)).toBe(3);
		expect(axisDay([10], -2)).toBe(8);
		expect(axisPosition([], 13)).toBe(13);
		expect(axisDay([], 13)).toBe(13);
	});

	it("gives NaN for a non-finite day or position, never a throw", () => {
		for (const days of [[], [10], FORTNIGHT]) {
			for (const input of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
				expect(axisPosition(days, input)).toBeNaN();
				expect(axisDay(days, input)).toBeNaN();
			}
		}
	});

	it("still returns a finite number for days that are not strictly ascending (documented fallback)", () => {
		for (const days of [
			[5, 5, 9],
			[9, 5, 7],
			[3, 3],
		]) {
			for (const input of [-4, 0, 5, 6.5, 9, 20]) {
				expect(Number.isFinite(axisPosition(days, input))).toBe(true);
				expect(Number.isFinite(axisDay(days, input))).toBe(true);
			}
		}
	});
});

/** A strictly ascending list of integer day numbers with uneven gaps (1 … 10 days). */
const axisDays = fc
	.tuple(
		fc.integer({ min: 18_000, max: 21_000 }),
		fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 0, maxLength: 60 }),
	)
	.map(([first, gaps]) => {
		const days = [first];
		for (const gap of gaps) days.push((days[days.length - 1] ?? first) + gap);
		return days;
	});

/** A day around the list: on, between, before or after its days (quarter days). */
const dayAround = (days: readonly number[]) => {
	const first = days[0] ?? 0;
	const last = days[days.length - 1] ?? 0;
	return fc.integer({ min: (first - 20) * 4, max: (last + 20) * 4 }).map((quarter) => quarter / 4);
};

describe("trading-day axis properties", () => {
	it("strictly increases with the day", () => {
		fc.assert(
			fc.property(
				axisDays.chain((days) => fc.tuple(fc.constant(days), dayAround(days), dayAround(days))),
				([days, a, b]) => {
					fc.pre(a !== b);
					const [lo, hi] = a < b ? [a, b] : [b, a];
					expect(axisPosition(days, lo)).toBeLessThan(axisPosition(days, hi));
				},
			),
		);
	});

	it("round-trips day → position → day and position → day → position within float tolerance", () => {
		fc.assert(
			fc.property(
				axisDays.chain((days) =>
					fc.tuple(
						fc.constant(days),
						dayAround(days),
						fc.integer({ min: -80, max: (days.length + 20) * 8 }).map((eighth) => eighth / 8),
					),
				),
				([days, day, position]) => {
					close(axisDay(days, axisPosition(days, day)), day);
					close(axisPosition(days, axisDay(days, position)), position);
				},
			),
		);
	});

	it("maps bar days to their index exactly and is continuous there", () => {
		fc.assert(
			fc.property(axisDays, (days) => {
				const epsilon = 1e-6;
				days.forEach((day, index) => {
					expect(axisPosition(days, day)).toBe(index);
					expect(axisDay(days, index)).toBe(day);
					// Both sides of a bar day approach its index (no jump between segments).
					expect(Math.abs(axisPosition(days, day - epsilon) - index)).toBeLessThan(1e-5);
					expect(Math.abs(axisPosition(days, day + epsilon) - index)).toBeLessThan(1e-5);
				});
			}),
		);
	});

	it("puts a weekend between Friday's and Monday's positions", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 400 }),
				fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 0, maxLength: 5 }),
				(week, extraBefore) => {
					// Weekdays of a few weeks from Mon 2026-10-19, some earlier bars, then Fri → Mon.
					const friday = MONDAY + 7 * week + 4;
					const days = [...extraBefore.map((back, index) => friday - 30 - index * 5 - back)]
						.sort((a, b) => a - b)
						.filter((day, index, all) => index === 0 || day !== all[index - 1]);
					days.push(friday, friday + 3);
					const fridayAt = axisPosition(days, friday);
					const mondayAt = axisPosition(days, friday + 3);
					expect(mondayAt - fridayAt).toBe(1);
					for (const weekend of [friday + 1, friday + 2]) {
						const at = axisPosition(days, weekend);
						expect(at).toBeGreaterThan(fridayAt);
						expect(at).toBeLessThan(mondayAt);
					}
				},
			),
		);
	});
});
