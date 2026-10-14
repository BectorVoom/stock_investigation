import { describe, expect, it } from "vitest";
import {
	isWidgetSize,
	WIDGET_GRID_METRICS,
	WIDGET_SIZE_SHAPES,
	WIDGET_SIZE_SPANS,
	WIDGET_SIZES,
	widgetHeightRem,
} from "../../src/core/sizes.ts";

describe("widget grid sizes", () => {
	it("has three sizes, smallest first", () => {
		expect([...WIDGET_SIZES]).toEqual(["small", "medium", "large"]);
	});

	it("uses 2 columns narrowing to 4 at 64rem, 17rem rows and a 1rem gap", () => {
		expect(WIDGET_GRID_METRICS).toEqual({
			narrowColumns: 2,
			wideColumns: 4,
			wideMinWidthRem: 64,
			rowHeightRem: 17,
			gapRem: 1,
		});
	});

	it("spans one cell for small, 2x2 for medium, full width x2 for large at wide", () => {
		expect(WIDGET_SIZE_SPANS.small).toEqual({
			narrow: { columns: 1, rows: 1 },
			wide: { columns: 1, rows: 1 },
		});
		expect(WIDGET_SIZE_SPANS.medium).toEqual({
			narrow: { columns: 2, rows: 2 },
			wide: { columns: 2, rows: 2 },
		});
		expect(WIDGET_SIZE_SPANS.large).toEqual({
			narrow: { columns: 2, rows: 2 },
			wide: { columns: 4, rows: 2 },
		});
	});

	it("names each shape in words", () => {
		expect(WIDGET_SIZE_SHAPES).toEqual({
			small: "1 × 1",
			medium: "2 × 2",
			large: "full width × 2",
		});
	});

	it("recognises only the three sizes", () => {
		expect(isWidgetSize("small")).toBe(true);
		expect(isWidgetSize("medium")).toBe(true);
		expect(isWidgetSize("large")).toBe(true);
		expect(isWidgetSize("huge")).toBe(false);
		expect(isWidgetSize(null)).toBe(false);
	});

	it("measures a widget height as rows plus the gaps between them", () => {
		expect(widgetHeightRem(1)).toBe(17);
		expect(widgetHeightRem(2)).toBe(35);
	});
});
