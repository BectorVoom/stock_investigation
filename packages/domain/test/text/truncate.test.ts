import { describe, expect, it } from "vitest";
import { truncateText } from "../../src/text/truncate.ts";

/*
 * Every expected string below is hand-computed by walking the input one code
 * point at a time. None is derived by calling the implementation.
 */
describe("truncateText", () => {
	it("returns text at or below the limit unchanged", () => {
		expect(truncateText("", 0)).toBe("");
		expect(truncateText("short", 10)).toBe("short");
		expect(truncateText("abcde", 5)).toBe("abcde");
		expect(truncateText("😀😀", 4)).toBe("😀😀");
	});

	it("cuts longer text with an ellipsis within the limit", () => {
		// Four kept characters plus the ellipsis fill the budget of five.
		expect(truncateText("abcdefghij", 5)).toBe("abcd…");
		expect(truncateText("abcdef", 6)).toBe("abcdef");
		expect(truncateText("abcdefg", 6)).toBe("abcde…");
	});

	it("never splits a surrogate pair", () => {
		// "a" plus "😀" (two UTF-16 units) would exceed the budget of two, so
		// only "a" is kept.
		expect(truncateText("a😀b", 2)).toBe("a…");
		expect(truncateText("😀".repeat(10), 6)).toBe("😀😀…");
		const cut = truncateText("a😀b😀c", 4);
		expect(cut.length).toBeLessThanOrEqual(4);
		expect([...cut].join("")).toBe(cut);
		for (const character of cut) {
			expect(character.length).toBeLessThanOrEqual(2);
		}
	});

	it("handles limit 0 and 1", () => {
		// A zero budget keeps nothing — not even the ellipsis.
		expect(truncateText("hello", 0)).toBe("");
		expect(truncateText("😀hi", 0)).toBe("");
		expect(truncateText("hello", 1)).toBe("…");
		expect(truncateText("😀hi", 1)).toBe("…");
		expect(truncateText("", 1)).toBe("");
	});
});
