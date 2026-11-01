import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { businessSectionBounds } from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between `businessSectionBounds`
 * (`packages/domain/src/finance/businessDescription.ts`, ADR-0053 §3) and its
 * Lean 4 model, `formal/ResearchFormal/BusinessSection.lean`.
 *
 * `formal/Export.lean` evaluates the verified `sectionBounds` over every mark
 * sequence of length 0..6 (start / end / other) against four size patterns —
 * equal sizes (ties), zeros (no body anywhere) and two mixed patterns with
 * zero-size blocks inside bodies. Every vector is replayed here.
 */

const markSchema = z.enum(["start", "end", "other"]);
const vectorFile = z.object({
	businessSection: z
		.array(
			z.object({
				marks: z.array(markSchema),
				sizes: z.array(z.number().int().nonnegative()),
				bounds: z
					.object({
						start: z.number().int(),
						end: z.number().int(),
						body: z.number().int(),
					})
					.nullable(),
			}),
		)
		.min(1),
});

const vectors = vectorFile.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

describe("businessSectionBounds matches the Lean model", () => {
	it("covers every mark sequence of length 0..6", () => {
		const lengths = new Set(vectors.businessSection.map((vector) => vector.marks.length));
		expect([...lengths].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
		// 3^0 + … + 3^6 sequences × 4 size patterns.
		expect(vectors.businessSection).toHaveLength(1093 * 4);
	});

	it("on every exported sequence", () => {
		for (const { marks, sizes, bounds } of vectors.businessSection) {
			const expected = bounds === null ? null : { start: bounds.start, end: bounds.end };
			expect(businessSectionBounds(marks, sizes), JSON.stringify({ marks, sizes })).toEqual(
				expected,
			);
		}
	});

	it("whose body is the sum of the sizes strictly between", () => {
		for (const { sizes, bounds } of vectors.businessSection) {
			if (bounds === null) continue;
			const body = sizes.slice(bounds.start + 1, bounds.end).reduce((sum, size) => sum + size, 0);
			expect(body).toBe(bounds.body);
		}
	});
});
