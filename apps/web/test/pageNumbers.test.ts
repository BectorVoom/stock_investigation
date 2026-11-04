import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type PageItem, pageNumbers } from "../src/stocks/pageNumbers.ts";

const text = (items: readonly PageItem[]): string =>
	items.map((item) => (item === "gap" ? "…" : String(item))).join(" ");

describe("pageNumbers (ADR-0070 §3)", () => {
	it("shows every page up to seven", () => {
		expect(text(pageNumbers(1, 1))).toBe("1");
		expect(text(pageNumbers(3, 7))).toBe("1 2 3 4 5 6 7");
	});

	it("shows 1 2 3 4 … at the start, … and the last four at the end", () => {
		expect(text(pageNumbers(1, 10))).toBe("1 2 3 4 … 10");
		expect(text(pageNumbers(3, 10))).toBe("1 2 3 4 … 10");
		expect(text(pageNumbers(10, 10))).toBe("1 … 7 8 9 10");
		expect(text(pageNumbers(8, 10))).toBe("1 … 7 8 9 10");
	});

	it("shows the current page and its neighbours in the middle", () => {
		expect(text(pageNumbers(6, 12))).toBe("1 … 5 6 7 … 12");
		// A gap of one page shows that page, never "…".
		expect(text(pageNumbers(4, 10))).toBe("1 2 3 4 5 … 10");
		expect(text(pageNumbers(7, 10))).toBe("1 … 6 7 8 9 10");
	});

	it("clamps a page outside 1…count", () => {
		expect(text(pageNumbers(0, 10))).toBe("1 2 3 4 … 10");
		expect(text(pageNumbers(99, 10))).toBe("1 … 7 8 9 10");
	});

	it("always shows 1, the last page and the current page, ascending, with gaps of 2+", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 500 }), (a, b) => {
				const count = Math.max(a, b);
				const page = Math.min(a, b);
				const items = pageNumbers(page, count);
				const numbers = items.filter((item): item is number => item !== "gap");
				expect(numbers[0]).toBe(1);
				expect(numbers.at(-1)).toBe(count);
				expect(numbers).toContain(page);
				expect(items.length).toBeLessThanOrEqual(7);
				for (let index = 1; index < items.length; index += 1) {
					const before = items[index - 1];
					const item = items[index];
					if (item === "gap") {
						expect(before).not.toBe("gap");
						const after = items[index + 1];
						if (typeof before !== "number" || typeof after !== "number")
							throw new Error("a gap sits between two numbers");
						expect(after - before).toBeGreaterThan(2);
					} else if (typeof before === "number") {
						expect(item).toBe(before + 1);
					}
				}
			}),
		);
	});
});
