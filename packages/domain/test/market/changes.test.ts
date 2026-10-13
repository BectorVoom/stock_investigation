import { describe, expect, it } from "vitest";
import {
	changeOverOneYear,
	latestChange,
	type MarketPoint,
	selectRange,
} from "../../src/market/changes.ts";
import { expectErr, expectOk } from "../support/result.ts";

const point = (observedOn: string, value: number): MarketPoint => ({ observedOn, value });

/*
 * Hard gate 5: every expected number below is hand-worked with the arithmetic
 * shown. None is derived by calling the implementation.
 */
describe("latestChange", () => {
	it("computes absolute and percent change of the newest two observations", () => {
		// 105 − 100 = 5; 5 / |100| × 100 = 5.
		const change = expectOk(latestChange([point("2026-09-30", 100), point("2026-10-01", 105)]));
		expect(change.absoluteChange).toBe(5);
		expect(change.percentChange).toBeCloseTo(5, 10);
		expect(change.previous).toEqual(point("2026-09-30", 100));
		expect(change.latest).toEqual(point("2026-10-01", 105));
	});

	it("handles falls and negative bases with |previous| in the denominator", () => {
		// 150 − 200 = −50; −50 / 200 × 100 = −25.
		const fall = expectOk(latestChange([point("2026-09-30", 200), point("2026-10-01", 150)]));
		expect(fall.absoluteChange).toBe(-50);
		expect(fall.percentChange).toBeCloseTo(-25, 10);
		// −90 − (−100) = 10; 10 / |−100| × 100 = 10.
		const negative = expectOk(latestChange([point("2026-09-30", -100), point("2026-10-01", -90)]));
		expect(negative.absoluteChange).toBe(10);
		expect(negative.percentChange).toBeCloseTo(10, 10);
	});

	it("uses only the newest two of a longer series", () => {
		// 12 − 11 = 1; 1 / 11 × 100 = 9.0909….
		const change = expectOk(
			latestChange([point("2026-09-28", 999), point("2026-09-30", 11), point("2026-10-01", 12)]),
		);
		expect(change.absoluteChange).toBe(1);
		expect(change.percentChange).toBeCloseTo(100 / 11, 10);
	});

	it("returns a null percent change (not an error) on a zero base", () => {
		const change = expectOk(latestChange([point("2026-09-30", 0), point("2026-10-01", 7)]));
		expect(change.absoluteChange).toBe(7);
		expect(change.percentChange).toBeNull();
	});

	it("rejects fewer than 2 observations and non-finite inputs", () => {
		expect(expectErr(latestChange([]))).toBe("NOT_ENOUGH_OBSERVATIONS");
		expect(expectErr(latestChange([point("2026-10-01", 5)]))).toBe("NOT_ENOUGH_OBSERVATIONS");
		expect(expectErr(latestChange([point("2026-09-30", Number.NaN), point("2026-10-01", 5)]))).toBe(
			"NON_FINITE",
		);
		expect(
			expectErr(
				latestChange([point("2026-09-30", 5), point("2026-10-01", Number.POSITIVE_INFINITY)]),
			),
		).toBe("NON_FINITE");
	});
});

describe("changeOverOneYear", () => {
	it("compares against the newest observation on or before the 1-year mark", () => {
		// Latest 2026-10-01, mark 2025-10-01. Newest on/before the mark is
		// 2025-09-30 at 101; 120 − 101 = 19; 19 / 101 × 100 = 18.8118….
		const change = expectOk(
			changeOverOneYear([
				point("2025-06-01", 50),
				point("2025-09-15", 100),
				point("2025-09-30", 101),
				point("2026-10-01", 120),
			]),
		);
		expect(change.previous).toEqual(point("2025-09-30", 101));
		expect(change.absoluteChange).toBe(19);
		expect(change.percentChange).toBeCloseTo((19 / 101) * 100, 10);
	});

	it("rejects a base more than 45 days older than the mark", () => {
		// Mark 2025-10-01; base 2025-08-01 is 61 days before it.
		expect(expectErr(changeOverOneYear([point("2025-08-01", 100), point("2026-10-01", 120)]))).toBe(
			"BASE_TOO_OLD",
		);
	});

	it("accepts a base exactly 45 days before the mark", () => {
		// Mark 2025-10-01; 2025-08-17 is exactly 45 days before it.
		// 120 − 80 = 40; 40 / 80 × 100 = 50.
		const change = expectOk(changeOverOneYear([point("2025-08-17", 80), point("2026-10-01", 120)]));
		expect(change.absoluteChange).toBe(40);
		expect(change.percentChange).toBeCloseTo(50, 10);
	});

	it("reports a missing base and a zero base", () => {
		expect(expectErr(changeOverOneYear([point("2026-10-01", 120)]))).toBe("NO_BASE_OBSERVATION");
		expect(expectErr(changeOverOneYear([point("2026-09-01", 100), point("2026-10-01", 120)]))).toBe(
			"NO_BASE_OBSERVATION",
		);
		const zero = expectOk(changeOverOneYear([point("2025-09-15", 0), point("2026-10-01", 5)]));
		expect(zero.absoluteChange).toBe(5);
		expect(zero.percentChange).toBeNull();
	});

	it("clamps Feb 29 to Feb 28 in a non-leap target year", () => {
		// Latest 2024-02-29, mark 2023-02-28. Base 2023-02-28 at 40;
		// 60 − 40 = 20; 20 / 40 × 100 = 50.
		const change = expectOk(changeOverOneYear([point("2023-02-28", 40), point("2024-02-29", 60)]));
		expect(change.absoluteChange).toBe(20);
		expect(change.percentChange).toBeCloseTo(50, 10);
	});
});

describe("selectRange", () => {
	const series = [
		point("2026-07-15", 1),
		point("2026-08-15", 2),
		point("2026-09-01", 3),
		point("2026-09-15", 4),
		point("2026-10-01", 5),
	];

	it("returns the suffix in the range counted back from the newest date", () => {
		// Newest 2026-10-01; 1m cutoff 2026-09-01 (inclusive).
		expect(selectRange(series, "1m").map((entry) => entry.observedOn)).toEqual([
			"2026-09-01",
			"2026-09-15",
			"2026-10-01",
		]);
		// 3m cutoff 2026-07-01: everything here.
		expect(selectRange(series, "3m")).toHaveLength(5);
		expect(selectRange(series, "max")).toHaveLength(5);
	});

	it("returns an empty suffix when nothing falls in the range", () => {
		expect(
			selectRange([point("2020-01-01", 1), point("2026-10-01", 5)], "1m").map(
				(entry) => entry.observedOn,
			),
		).toEqual(["2026-10-01"]);
	});

	it("handles empty input and clamps month ends", () => {
		expect(selectRange([], "1y")).toEqual([]);
		// Newest 2026-03-31; 1m back clamps Feb to 2026-02-28, keeping both.
		expect(
			selectRange([point("2026-02-28", 1), point("2026-03-31", 2)], "1m").map(
				(entry) => entry.observedOn,
			),
		).toEqual(["2026-02-28", "2026-03-31"]);
	});
});
