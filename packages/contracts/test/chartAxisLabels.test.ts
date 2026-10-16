import { describe, expect, it } from "vitest";
import { homeWidgetSchema, WIDGET_LIMITS, widgetCoreSchema } from "../src/index.ts";
import { expectAccepted, expectRejected } from "./support.ts";

const baseChart = {
	widgetId: "w-chart",
	type: "chart",
	title: "Growth",
	size: "medium",
	chartType: "bar",
	unit: "% per year",
	series: [{ name: "Bear", points: [{ x: "S", y: 7 }] }],
} as const;

describe("chart axis labels", () => {
	it("accepts optional axis labels", () => {
		expectAccepted(widgetCoreSchema, { ...baseChart, xLabel: "Scenario", yLabel: "Growth" });
		expectAccepted(homeWidgetSchema, { ...baseChart, xLabel: "Scenario", yLabel: "Growth" });
	});

	it("parses stored widgets without them", () => {
		const parsed = widgetCoreSchema.parse(baseChart);
		if (parsed.type !== "chart") throw new Error("expected a chart widget");
		expect("xLabel" in parsed).toBe(false);
		expect("yLabel" in parsed).toBe(false);
	});

	it("rejects axis labels that are too long", () => {
		const long = "x".repeat(WIDGET_LIMITS.maxTitleChars + 1);
		expectRejected(widgetCoreSchema, { ...baseChart, xLabel: long });
		expectRejected(widgetCoreSchema, { ...baseChart, yLabel: long });
		expectRejected(homeWidgetSchema, { ...baseChart, xLabel: long });
	});

	it("rejects blank axis labels", () => {
		expectRejected(widgetCoreSchema, { ...baseChart, xLabel: "   " });
		expectRejected(widgetCoreSchema, { ...baseChart, yLabel: "" });
	});

	it("accepts an optional x kind, absent means text", () => {
		expectAccepted(widgetCoreSchema, { ...baseChart, xKind: "date" });
		expectAccepted(widgetCoreSchema, { ...baseChart, xKind: "number" });
		expectAccepted(homeWidgetSchema, { ...baseChart, xKind: "date" });
		const parsed = widgetCoreSchema.parse(baseChart);
		if (parsed.type !== "chart") throw new Error("expected a chart widget");
		expect("xKind" in parsed).toBe(false);
	});

	it("rejects an unknown x kind", () => {
		expectRejected(widgetCoreSchema, { ...baseChart, xKind: "datetime" });
		expectRejected(homeWidgetSchema, { ...baseChart, xKind: "number-ish" });
	});
});
