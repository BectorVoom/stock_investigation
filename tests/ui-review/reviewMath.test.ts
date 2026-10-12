import { describe, expect, it } from "vitest";
import {
	contrastRatioOf,
	countByRule,
	formatSummaryTable,
	isSmallTarget,
	relativeLuminance,
} from "./reviewMath.ts";

describe("reviewMath", () => {
	it("computes WCAG contrast ratios with margin for the allowed pairs", () => {
		// Guideline section 2: body text slate-900 on white is ~17.8:1.
		expect(contrastRatioOf([15, 23, 42], [255, 255, 255])).toBeGreaterThan(4.5);
		// White on blue-700 (primary button) passes AA at ~6.8:1.
		expect(contrastRatioOf([255, 255, 255], [29, 78, 216])).toBeGreaterThan(4.5);
		// Identical colours have ratio 1.
		expect(contrastRatioOf([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
		expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
		expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
	});

	it("flags targets below the 24 px minimum", () => {
		expect(isSmallTarget(23, 24)).toBe(true);
		expect(isSmallTarget(24, 23)).toBe(true);
		expect(isSmallTarget(24, 24)).toBe(false);
		expect(isSmallTarget(48, 32)).toBe(false);
	});

	it("counts findings per rule and formats the summary table", () => {
		const counts = countByRule([
			{ state: "A", rule: "obscured", detail: "x" },
			{ state: "A", rule: "obscured", detail: "y" },
			{ state: "B", rule: "low-contrast", detail: "z" },
		]);
		expect(counts).toEqual({ obscured: 2, "low-contrast": 1 });
		expect(countByRule([])).toEqual({});
		const lines = formatSummaryTable(counts);
		expect(lines[0]).toContain("rule -> count");
		expect(lines.join("\n")).toContain("obscured");
		expect(lines.join("\n")).toContain("total");
		expect(formatSummaryTable({})).toEqual(["ui-review: no findings"]);
	});
});
