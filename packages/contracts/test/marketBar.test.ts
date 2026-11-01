/**
 * ADR-0056 §1: an observation may carry the day's bar
 * `[open, high, low, volume]` beside its close, and a bar must be consistent
 * with that close.
 */
import { describe, expect, it } from "vitest";
import { isConsistentBar, marketBarSchema, marketObservationSchema } from "../src/index.ts";

describe("marketBarSchema", () => {
	it("accepts four finite numbers, the volume also null", () => {
		expect(marketBarSchema.parse([410.5, 415.25, 409, 21458123])).toEqual([
			410.5, 415.25, 409, 21458123,
		]);
		expect(marketBarSchema.parse([149.1, 149.9, 148.7, null])).toEqual([149.1, 149.9, 148.7, null]);
		expect(marketBarSchema.safeParse([1, 1, 1, 0]).success).toBe(true);
	});

	it("refuses a negative volume, a missing or extra element and non-numbers", () => {
		for (const input of [
			[1, 2, 0.5, -1],
			[1, 2, 0.5],
			[1, 2, 0.5, 3, 4],
			["1", 2, 0.5, 3],
			[1, 2, 0.5, "3"],
			[null, 2, 0.5, 3],
			[Number.POSITIVE_INFINITY, 2, 0.5, 3],
			[1, 2, 0.5, Number.NaN],
			null,
			{},
		]) {
			expect(marketBarSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
		}
	});
});

describe("isConsistentBar", () => {
	it("holds when low ≤ open, close ≤ high, bounds included", () => {
		expect(isConsistentBar(5, [4, 6, 3, 10])).toBe(true);
		expect(isConsistentBar(6, [3, 6, 3, null])).toBe(true);
		expect(isConsistentBar(1, [1, 1, 1, null])).toBe(true);
	});

	it("fails when the open or the close leaves the low–high range", () => {
		expect(isConsistentBar(7, [4, 6, 3, 10])).toBe(false);
		expect(isConsistentBar(2, [4, 6, 3, 10])).toBe(false);
		expect(isConsistentBar(5, [7, 6, 3, 10])).toBe(false);
		expect(isConsistentBar(5, [2, 6, 3, 10])).toBe(false);
		// high below low can hold no open and close.
		expect(isConsistentBar(5, [5, 3, 6, 10])).toBe(false);
	});
});

describe("marketObservationSchema", () => {
	it("accepts a close alone and a close with a consistent bar", () => {
		expect(marketObservationSchema.parse(["2026-10-09", 17.5])).toEqual(["2026-10-09", 17.5]);
		expect(marketObservationSchema.parse(["2026-10-09", 412, [410.5, 415.25, 409, 1e6]])).toEqual([
			"2026-10-09",
			412,
			[410.5, 415.25, 409, 1e6],
		]);
		expect(
			marketObservationSchema.parse(["2026-10-09", 149.5, [149.1, 149.9, 148.7, null]]),
		).toEqual(["2026-10-09", 149.5, [149.1, 149.9, 148.7, null]]);
	});

	it("never takes null for a missing bar", () => {
		const result = marketObservationSchema.safeParse(["2026-10-09", 1, null]);
		expect(result.success).toBe(false);
		expect(result.error?.issues.map((issue) => [issue.code, issue.path])).toEqual([
			["invalid_type", [2]],
		]);
	});

	it("refuses a bar inconsistent with its close at the tuple itself", () => {
		const result = marketObservationSchema.safeParse(["2026-10-09", 7, [4, 6, 3, 10]]);
		expect(result.success).toBe(false);
		expect(result.error?.issues).toMatchObject([
			{ code: "custom", path: [], message: "a bar needs low ≤ open, close ≤ high" },
		]);
	});

	it("checks consistency even when the volume is negative, but not after an abort", () => {
		const both = marketObservationSchema.safeParse(["2026-10-09", 7, [4, 6, 3, -1]]);
		expect(both.error?.issues.map((issue) => [issue.code, issue.path])).toEqual([
			["too_small", [2, 3]],
			["custom", []],
		]);
		// Too many elements aborts: the refinement does not run.
		const long = marketObservationSchema.safeParse(["2026-10-09", 7, [4, 6, 3, 10], 1]);
		expect(long.error?.issues.map((issue) => [issue.code, issue.path])).toEqual([["too_big", []]]);
	});

	it("refuses a bar of the wrong length and non-finite numbers", () => {
		for (const input of [
			["2026-10-09", 5, [4, 6, 3]],
			["2026-10-09", 5, [4, 6, 3, 10, 1]],
			["2026-10-09", 5, [4, 6, Number.POSITIVE_INFINITY, 10]],
			["2026-10-09", Number.NaN, [4, 6, 3, 10]],
			["2026-10-09"],
		]) {
			expect(marketObservationSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
		}
	});
});
