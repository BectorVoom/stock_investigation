import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recentCountWithinBudget } from "../../src/text/recentWithinBudget.ts";

const sizes = fc.array(fc.nat({ max: 1000 }), { maxLength: 12 });
const budget = fc.nat({ max: 6000 });
const maxItems = fc.nat({ max: 12 });

function keptTotal(all: readonly number[], count: number): number {
	return all.slice(all.length - count).reduce((total, size) => total + size, 0);
}

describe("recentCountWithinBudget properties (the four Lean theorems)", () => {
	it("never exceeds maxItems", () => {
		fc.assert(
			fc.property(sizes, budget, maxItems, (all, limit, cap) => {
				expect(recentCountWithinBudget(all, limit, cap)).toBeLessThanOrEqual(cap);
			}),
			{ numRuns: 500 },
		);
	});

	it("never exceeds the number of items", () => {
		fc.assert(
			fc.property(sizes, budget, maxItems, (all, limit, cap) => {
				expect(recentCountWithinBudget(all, limit, cap)).toBeLessThanOrEqual(all.length);
			}),
			{ numRuns: 500 },
		);
	});

	it("keeps a suffix whose total never exceeds the budget", () => {
		fc.assert(
			fc.property(sizes, budget, maxItems, (all, limit, cap) => {
				const count = recentCountWithinBudget(all, limit, cap);
				expect(keptTotal(all, count)).toBeLessThanOrEqual(limit);
			}),
			{ numRuns: 500 },
		);
	});

	it("is maximal: one more older item would exceed the budget", () => {
		fc.assert(
			fc.property(sizes, budget, maxItems, (all, limit, cap) => {
				const count = recentCountWithinBudget(all, limit, cap);
				if (count < cap && count < all.length) {
					expect(keptTotal(all, count + 1)).toBeGreaterThan(limit);
				}
			}),
			{ numRuns: 500 },
		);
	});
});
