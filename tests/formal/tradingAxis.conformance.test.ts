import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { axisDay, axisPosition, axisSegment } from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between the trading-day axis
 * (`packages/domain/src/market/tradingAxis.ts`, ADR-0057) and the Lean 4
 * model in `formal/ResearchFormal/TradingAxis.lean`.
 *
 * `formal/Export.lean` evaluates the verified definitions, over exact
 * rationals, on every strictly ascending list of 0 … 4 days drawn from
 * {0, 1, 2, 5, 6, 10} (uneven gaps of 1, 1, 3, 1 and 4 days: 57 lists),
 * against 29 days (−2 … 12 in halves: on, between, before and after the bar
 * days) and 29 positions (−2 … 5 in quarters) each: 3,306 vectors. The
 * inputs are exact in binary floating point; the implementation computes in
 * floating point, so outputs are compared within 1e−9 relative, and the
 * segment index exactly.
 */
const rational = z.object({ num: z.number().int(), den: z.number().int().positive() });

const tradingAxisVectors = z.object({
	tradingAxis: z.array(
		z.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("day"),
				days: z.array(z.number().int()),
				day: rational,
				segment: z.number().int(),
				position: rational,
			}),
			z.object({
				kind: z.literal("position"),
				days: z.array(z.number().int()),
				position: rational,
				day: rational,
			}),
		]),
	),
});

const vectors = tradingAxisVectors.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

type Rational = z.infer<typeof rational>;

const value = (r: Rational): number => r.num / r.den;

/** |actual − expected| ≤ 1e−9 × max(1, |expected|). */
function expectClose(actual: number, expected: Rational, label: string): void {
	const exact = value(expected);
	expect(Math.abs(actual - exact), label).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(exact)));
}

describe("Lean model conformance: trading-day axis", () => {
	it(`agrees with axisSegment, axisPosition and axisDay on all ${vectors.tradingAxis.length} vectors`, () => {
		expect(vectors.tradingAxis.length).toBe(3306);
		const lists = new Set(vectors.tradingAxis.map((vector) => vector.days.join(",")));
		expect(lists.size).toBe(57);
		for (const vector of vectors.tradingAxis) {
			const label = JSON.stringify(vector);
			if (vector.kind === "day") {
				const day = value(vector.day);
				expect(axisSegment(vector.days, day), label).toBe(vector.segment);
				expectClose(axisPosition(vector.days, day), vector.position, label);
			} else {
				expectClose(axisDay(vector.days, value(vector.position)), vector.day, label);
			}
		}
	});

	it("pins the proved properties on the vectors' integer bar days", () => {
		for (const days of new Set(vectors.tradingAxis.map((vector) => vector.days.join(",")))) {
			const list = days === "" ? [] : days.split(",").map(Number);
			list.forEach((day, index) => {
				expect(axisPosition(list, day), days).toBe(index);
				expect(axisDay(list, index), days).toBe(day);
			});
		}
	});
});
