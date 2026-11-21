import { readFileSync } from "node:fs";
import { rectangularizeTableRows, selectVerifiedComparisonRowIndices } from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const vectors = z
	.object({
		tableRectangularize: z.array(
			z.object({
				cols: z.number(),
				maxCols: z.number(),
				maxRows: z.number(),
				rows: z.array(z.array(z.number())),
				result: z.array(z.array(z.number())),
			}),
		),
		comparisonRowSelect: z.array(
			z.object({
				candidates: z.array(
					z.object({
						hasVerifiedSupport: z.boolean(),
						hasStrayNumber: z.boolean(),
					}),
				),
				maxRows: z.number(),
				result: z.array(z.number()),
			}),
		),
	})
	.parse(JSON.parse(readFileSync(new URL("../../formal/vectors.json", import.meta.url), "utf8")));

describe("comparison table Lean conformance", () => {
	it("rectangularizes table rows identically to the Lean model", () => {
		for (const vector of vectors.tableRectangularize) {
			const actual = rectangularizeTableRows(
				vector.cols,
				vector.rows,
				0,
				vector.maxCols,
				vector.maxRows,
			);
			expect(actual).toEqual(vector.result);
			const expectedWidth = Math.min(vector.cols, vector.maxCols);
			for (const row of actual) {
				expect(row).toHaveLength(expectedWidth);
			}
		}
	});

	it("selects verified comparison rows identically to the Lean model", () => {
		for (const vector of vectors.comparisonRowSelect) {
			const actual = selectVerifiedComparisonRowIndices(vector.candidates, vector.maxRows);
			expect(actual).toEqual(vector.result);
			for (const idx of actual) {
				const candidate = vector.candidates[idx];
				expect(candidate?.hasVerifiedSupport).toBe(true);
				expect(candidate?.hasStrayNumber).toBe(false);
			}
		}
	});
});
