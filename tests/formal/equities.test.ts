import { readFileSync } from "node:fs";
import { compareEquityDecimals, equityFactVisible, equityVersionVisible } from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const vectors = z
	.object({
		equityVersionVisibility: z.array(
			z.object({ version: z.number().int(), cutoff: z.number().int(), visible: z.boolean() }),
		),
		equityVisibility: z.array(
			z.object({
				availableAt: z.number().nullable(),
				committedAt: z.number(),
				informationCutoff: z.number().nullable(),
				ingestionCutoff: z.number().nullable(),
				visible: z.boolean(),
			}),
		),
		equityDecimalCompare: z.array(
			z.object({
				leftCoefficient: z.number().int(),
				leftScale: z.number().int(),
				rightCoefficient: z.number().int(),
				rightScale: z.number().int(),
				ordering: z.number().int(),
			}),
		),
	})
	.parse(JSON.parse(readFileSync(new URL("../../formal/vectors.json", import.meta.url), "utf8")));

function decimal(coefficient: number, scale: number): string {
	const digits = Math.abs(coefficient)
		.toString()
		.padStart(scale + 1, "0");
	const magnitude = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
	return `${coefficient < 0 ? "-" : ""}${magnitude}`;
}
describe("equities Lean conformance", () => {
	it("excludes all later commits from a pinned ingestion version", () => {
		for (const v of vectors.equityVersionVisibility)
			expect(equityVersionVisible(v.version, v.cutoff)).toBe(v.visible);
	});
	it("matches every visibility vector, including unknown availability and pre-epoch timestamps", () => {
		for (const vector of vectors.equityVisibility)
			expect(equityFactVisible(vector)).toBe(vector.visible);
	});
	it("matches exact signed cross-scale ordering without floating point arithmetic", () => {
		for (const v of vectors.equityDecimalCompare)
			expect(
				compareEquityDecimals(
					decimal(v.leftCoefficient, v.leftScale),
					decimal(v.rightCoefficient, v.rightScale),
				),
			).toBe(v.ordering);
	});
});
