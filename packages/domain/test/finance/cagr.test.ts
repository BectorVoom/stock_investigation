import { describe, expect, it } from "vitest";
import { deriveCagr } from "../../src/finance/cagr.ts";
import { expectErr, expectOk } from "../support/result.ts";

/* Hard gate 5: expected growth rates are hand-derived from exact powers, shown per row. */
describe("deriveCagr", () => {
	it.each([
		// 1.1^3 = 1.331, so 1_000 -> 1_331 over 3 years is exactly 10% a year
		{ base: 1000, target: 1331, from: 2025, to: 2028, expected: 0.1 },
		// 1.2^3 = 1.728, so 1_000 -> 1_728 over 3 years is 20% a year
		{ base: 1000, target: 1728, from: 2025, to: 2028, expected: 0.2 },
		// (3/2)^4 = 81/16, so 16 -> 81 over 4 years is 50% a year
		{ base: 16, target: 81, from: 2026, to: 2030, expected: 0.5 },
		// (5/4)^5 = 3125/1024, so 1_024 -> 3_125 over 5 years is 25% a year
		{ base: 1024, target: 3125, from: 2025, to: 2030, expected: 0.25 },
		// cube root of 2 = 1.259921049894873..., so doubling in 3 years is ~25.992% a year
		{ base: 100, target: 200, from: 2025, to: 2028, expected: 0.259921049894873 },
		// fourth root of 2 = 1.189207115002721..., so doubling in 4 years is ~18.921% a year
		{ base: 500, target: 1000, from: 2025, to: 2029, expected: 0.189207115002721 },
		// halving in a single year is -50%
		{ base: 200, target: 100, from: 2025, to: 2026, expected: -0.5 },
		// (1/2)^3 = 1/8, so 800 -> 100 over 3 years is -50% a year
		{ base: 800, target: 100, from: 2025, to: 2028, expected: -0.5 },
		// no change is 0% whatever the horizon
		{ base: 80, target: 80, from: 2025, to: 2030, expected: 0 },
	])("$base -> $target over $from..$to is $expected", ({ base, target, from, to, expected }) => {
		expect(expectOk(deriveCagr(base, target, from, to))).toBeCloseTo(expected, 12);
	});

	it("treats a target of zero as a total decline of -100% a year", () => {
		expect(expectOk(deriveCagr(100, 0, 2025, 2029))).toBe(-1);
	});

	it.each([
		[Number.NaN, 100, 2025, 2028],
		[100, Number.NaN, 2025, 2028],
		[100, 200, Number.NaN, 2028],
		[100, 200, 2025, Number.POSITIVE_INFINITY],
		[Number.POSITIVE_INFINITY, 200, 2025, 2028],
	])("rejects non-finite input (%s, %s, %s, %s)", (base, target, from, to) => {
		expect(expectErr(deriveCagr(base, target, from, to))).toBe("NON_FINITE");
	});

	it("rejects a zero-length horizon instead of dividing by zero", () => {
		expect(deriveCagr(100, 200, 2025, 2025)).toEqual({ ok: false, error: "INVALID_YEARS" });
	});

	it("rejects a target year before the base year", () => {
		expect(expectErr(deriveCagr(100, 200, 2028, 2025))).toBe("INVALID_YEARS");
	});

	it("rejects fractional years", () => {
		expect(expectErr(deriveCagr(100, 200, 2025.5, 2028))).toBe("INVALID_YEARS");
		expect(expectErr(deriveCagr(100, 200, 2025, 2028.25))).toBe("INVALID_YEARS");
	});

	it("rejects a zero or negative base, where growth is undefined", () => {
		expect(deriveCagr(0, 200, 2025, 2028)).toEqual({ ok: false, error: "NON_POSITIVE_BASE" });
		expect(expectErr(deriveCagr(-100, 200, 2025, 2028))).toBe("NON_POSITIVE_BASE");
	});

	it("rejects a negative target instead of returning NaN from a fractional power", () => {
		expect(deriveCagr(100, -1, 2025, 2028)).toEqual({ ok: false, error: "NEGATIVE_TARGET" });
	});
});
