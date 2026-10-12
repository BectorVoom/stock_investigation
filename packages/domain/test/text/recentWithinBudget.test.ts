import { describe, expect, it } from "vitest";
import { recentCountWithinBudget } from "../../src/text/recentWithinBudget.ts";
import { deepFreeze } from "../support/deepFreeze.ts";

/*
 * Every expected count below is hand-computed by walking from the newest
 * (last) element backwards. None is derived by calling the implementation.
 */
describe("recentCountWithinBudget", () => {
	it("keeps nothing when there is nothing", () => {
		expect(recentCountWithinBudget([], 100, 6)).toBe(0);
	});

	it("keeps everything when it all fits", () => {
		// 2 + 3 + 1 = 6 <= 10, 3 items <= 5
		expect(recentCountWithinBudget([2, 3, 1], 10, 5)).toBe(3);
	});

	it("keeps nothing when the newest item alone exceeds the budget", () => {
		// newest is 6 > 5
		expect(recentCountWithinBudget([5, 5, 6], 5, 3)).toBe(0);
	});

	it("stops at the first item that does not fit", () => {
		// newest 2 (total 2), then 1 (total 3), then 4 (total 7 > 5): stop
		expect(recentCountWithinBudget([4, 1, 2], 5, 5)).toBe(2);
	});

	it("never skips an item to squeeze in an older one", () => {
		// newest 1 (total 1), then 1 (total 2), then 5 (total 7 > 6): stop,
		// even though the oldest 1 would fit in the remaining 4.
		expect(recentCountWithinBudget([1, 5, 1, 1], 6, 6)).toBe(2);
	});

	it("caps the count at maxItems", () => {
		// 1 + 1 = 2 <= 100 but at most 2 items
		expect(recentCountWithinBudget([1, 1, 1, 1], 100, 2)).toBe(2);
	});

	it("keeps nothing when maxItems is zero", () => {
		expect(recentCountWithinBudget([1, 2, 3], 100, 0)).toBe(0);
	});

	it("keeps zero-byte items within a zero budget", () => {
		// 0 + 0 + 0 = 0 <= 0
		expect(recentCountWithinBudget([0, 0, 0], 0, 3)).toBe(3);
	});

	it("treats an exact fit as fitting", () => {
		// 2 + 3 = 5 <= 5
		expect(recentCountWithinBudget([2, 3], 5, 5)).toBe(2);
	});

	it.each([
		[Number.NaN],
		[-1],
		[1.5],
		[Number.POSITIVE_INFINITY],
	])("fails closed when a size is %s", (size) => {
		expect(recentCountWithinBudget([1, size, 1], 100, 6)).toBe(0);
	});

	it("fails closed when an old size outside the kept suffix is invalid", () => {
		expect(recentCountWithinBudget([Number.NaN, 1, 1], 100, 6)).toBe(0);
	});

	it("fails closed when the size exceeds the safe-integer range", () => {
		expect(recentCountWithinBudget([Number.MAX_SAFE_INTEGER + 1], 100, 6)).toBe(0);
	});

	it.each([
		[Number.NaN],
		[-1],
		[1.5],
		[Number.POSITIVE_INFINITY],
		[Number.NEGATIVE_INFINITY],
		[Number.MAX_SAFE_INTEGER + 1],
	])("fails closed when the budget is %s", (budget) => {
		expect(recentCountWithinBudget([1, 2], budget, 6)).toBe(0);
	});

	it.each([
		[Number.NaN],
		[-1],
		[1.5],
		[Number.POSITIVE_INFINITY],
		[Number.NEGATIVE_INFINITY],
		[Number.MAX_SAFE_INTEGER + 1],
	])("fails closed when maxItems is %s", (maxItems) => {
		expect(recentCountWithinBudget([1, 2], 100, maxItems)).toBe(0);
	});

	it("does not mutate its input", () => {
		const sizes = deepFreeze([4, 1, 2]);
		expect(recentCountWithinBudget(sizes, 5, 5)).toBe(2);
		expect(sizes).toEqual([4, 1, 2]);
	});
});
