import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { truncateText } from "../../src/text/truncate.ts";

const text = fc.string({ maxLength: 40 });
const limit = fc.integer({ min: 0, max: 50 });

describe("truncateText properties", () => {
	it("never exceeds the limit", () => {
		fc.assert(
			fc.property(text, limit, (input, maxLength) => {
				expect(truncateText(input, maxLength).length).toBeLessThanOrEqual(maxLength);
			}),
			{ numRuns: 500 },
		);
	});

	it("returns the input unchanged or a code-point prefix plus the ellipsis", () => {
		fc.assert(
			fc.property(text, limit, (input, maxLength) => {
				const result = truncateText(input, maxLength);
				// Cutting at a code-point boundary means the kept part is a
				// string prefix with no split surrogate pair.
				const kept = result === input ? result : result.slice(0, -1);
				expect([...input].slice(0, [...kept].length).join("")).toBe(kept);
				expect(input.startsWith(kept)).toBe(true);
			}),
			{ numRuns: 500 },
		);
	});
});
