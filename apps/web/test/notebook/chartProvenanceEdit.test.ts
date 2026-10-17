import { widgetCoreSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { carryChartProvenance, duplicateWidget } from "../../src/widgets/widgetModel.ts";
import { WORKSPACE_VIEW } from "../fixtures.ts";

const evidence = WORKSPACE_VIEW.sources[0];
if (evidence === undefined) throw new Error("the fixture has no evidence");

const parsed = widgetCoreSchema.parse({
	widgetId: "w_c",
	type: "chart",
	title: "Prices",
	size: "medium",
	chartType: "line",
	unit: "USD",
	series: [
		{
			name: "Price",
			points: [
				{ x: "Mon", y: 10, sourceId: evidence.evidenceId, asOf: "2026-10-07" },
				{ x: "Tue", y: 11, basis: "assumption" },
			],
		},
	],
	sources: [evidence],
});
if (parsed.type !== "chart") throw new Error("expected a chart widget");
const chart = parsed;

describe("chart provenance through edits and copies (ADR-0026)", () => {
	it("keeps provenance on unchanged points and drops it from changed or new ones", () => {
		const edited = carryChartProvenance(
			chart,
			[
				{
					name: "Price",
					points: [
						{ x: "Mon", y: 10 },
						{ x: "Tue", y: 12 },
						{ x: "Wed", y: 13 },
					],
				},
			],
			"USD",
		);
		expect(edited.series[0]?.points).toEqual([
			{ x: "Mon", y: 10, sourceId: evidence.evidenceId, asOf: "2026-10-07" },
			{ x: "Tue", y: 12 },
			{ x: "Wed", y: 13 },
		]);
		expect(edited.sources).toEqual([evidence]);
		expect(widgetCoreSchema.safeParse({ ...chart, ...edited }).success).toBe(true);
	});

	it("drops the copy of a source no point cites any more", () => {
		const edited = carryChartProvenance(
			chart,
			[{ name: "Price", points: [{ x: "Mon", y: 99 }] }],
			"USD",
		);
		expect(edited.sources).toBeUndefined();
		expect(widgetCoreSchema.safeParse({ ...chart, sources: undefined, ...edited }).success).toBe(
			true,
		);
	});

	it("drops every point's provenance when the unit changes: the numbers mean something else", () => {
		const edited = carryChartProvenance(
			chart,
			[
				{
					name: "Price",
					points: [
						{ x: "Mon", y: 10 },
						{ x: "Tue", y: 11 },
					],
				},
			],
			"%",
		);
		expect(edited.series[0]?.points).toEqual([
			{ x: "Mon", y: 10 },
			{ x: "Tue", y: 11 },
		]);
		expect(edited.sources).toBeUndefined();
		expect(edited.sourceIds).toBeUndefined();
	});

	it("duplicates a chart with its provenance and source copies", () => {
		const copy = duplicateWidget(chart, "w_copy");
		if (copy.type !== "chart") throw new Error("expected a chart widget");
		expect(copy.series).toEqual(chart.series);
		expect(copy.sources).toEqual(chart.sources);
		expect(copy.sources).not.toBe(chart.sources);
	});
});
