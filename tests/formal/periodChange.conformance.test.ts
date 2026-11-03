import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	changeOverMonths,
	changeOverOneMonth,
	changeOverOneYear,
	dayNumberToIso,
	type MarketPoint,
	MONTH_BASE_TOLERANCE_DAYS,
	YEAR_BASE_TOLERANCE_DAYS,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between `changeOverMonths`
 * (`packages/domain/src/market/changes.ts`: the indicator table's 前月比 and
 * every widget's 前年比) and its Lean 4 model,
 * `formal/ResearchFormal/PeriodChange.lean`.
 *
 * `formal/Export.lean` evaluates the verified `periodChange` for six latest
 * days around month ends and leap days, each against the two real
 * configurations (1 month with 15 days' tolerance, 1 year with 45), with
 * every arrangement of up to three earlier observations at offsets around
 * the mark (in and out of date order). Every vector is replayed here through
 * real ISO dates.
 */

const pointSchema = z.object({ day: z.number().int(), value: z.number().int() });
const vectorFile = z.object({
	periodChange: z
		.array(
			z.object({
				months: z.number().int().positive(),
				toleranceDays: z.number().int().nonnegative(),
				points: z.array(pointSchema).min(1),
				base: pointSchema.optional(),
				latest: pointSchema.optional(),
				error: z.enum(["NO_BASE_OBSERVATION", "BASE_TOO_OLD"]).optional(),
			}),
		)
		.min(1),
});

const vectors = vectorFile.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

function isoOf(day: number): string {
	const iso = dayNumberToIso(day);
	if (!iso.ok) throw new Error(`day ${day} has no ISO date`);
	return iso.value;
}

const toPoint = (point: z.infer<typeof pointSchema>): MarketPoint => ({
	observedOn: isoOf(point.day),
	value: point.value,
});

describe("changeOverMonths matches the Lean model", () => {
	it("covers both configurations, every outcome and up to three earlier observations", () => {
		// 6 latest days × 2 configurations × (1 + 7 + 42 + 210) arrangements.
		expect(vectors.periodChange).toHaveLength(6 * 2 * 260);
		const configurations = new Set(
			vectors.periodChange.map((v) => `${v.months}/${v.toleranceDays}`),
		);
		expect([...configurations].sort()).toEqual([
			`1/${MONTH_BASE_TOLERANCE_DAYS}`,
			`12/${YEAR_BASE_TOLERANCE_DAYS}`,
		]);
		const outcomes = new Set(vectors.periodChange.map((v) => v.error ?? "ok"));
		expect([...outcomes].sort()).toEqual(["BASE_TOO_OLD", "NO_BASE_OBSERVATION", "ok"]);
	});

	it("on every exported series", () => {
		for (const vector of vectors.periodChange) {
			const points = vector.points.map(toPoint);
			const result = changeOverMonths(points, vector.months, vector.toleranceDays);
			const label = JSON.stringify(vector);
			if (vector.error !== undefined) {
				expect(result.ok, label).toBe(false);
				if (!result.ok) expect(result.error, label).toBe(vector.error);
				continue;
			}
			if (vector.base === undefined || vector.latest === undefined) {
				throw new Error(`vector without a result: ${label}`);
			}
			expect(result.ok, label).toBe(true);
			if (!result.ok) continue;
			expect(result.value.previous, label).toEqual(toPoint(vector.base));
			expect(result.value.latest, label).toEqual(toPoint(vector.latest));
			expect(result.value.absoluteChange, label).toBe(vector.latest.value - vector.base.value);
		}
	});

	it("through the named 1-month and 1-year functions", () => {
		for (const vector of vectors.periodChange) {
			const named = vector.months === 1 ? changeOverOneMonth : changeOverOneYear;
			const points = vector.points.map(toPoint);
			expect(named(points), JSON.stringify(vector)).toEqual(
				changeOverMonths(points, vector.months, vector.toleranceDays),
			);
		}
	});
});
