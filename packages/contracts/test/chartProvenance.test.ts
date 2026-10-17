import { describe, expect, it } from "vitest";
import {
	type Evidence,
	reconcileChartDraft,
	type WidgetCore,
	widgetCoreSchema,
	withEarnedChartProvenance,
} from "../src/index.ts";

const SOURCE: Evidence = {
	evidenceId: "ev_1",
	sourceUrl: "https://example.com/a",
	title: "Outlook",
	publisher: "Example",
	publishedAt: null,
	retrievedAt: "2026-10-01T00:00:00.000Z",
	effectiveAt: null,
	excerpt: null,
	checksum: "c".repeat(64),
	sourceClass: "news",
};

const chart = (overrides: Record<string, unknown> = {}) => ({
	widgetId: "w_1",
	type: "chart",
	title: "Growth",
	size: "medium",
	chartType: "bar",
	unit: "%",
	series: [
		{
			name: "Base",
			points: [
				{ x: "AI", y: 16.5, basis: "assumption" },
				{ x: "Grid", y: 4, sourceId: "ev_1", asOf: "2026-10-01" },
			],
		},
	],
	sources: [SOURCE],
	...overrides,
});

describe("chart widget provenance (ADR-0026)", () => {
	it("accepts points with a basis or a dated source, plus one copy per cited source", () => {
		expect(widgetCoreSchema.safeParse(chart()).success).toBe(true);
		expect(widgetCoreSchema.safeParse(chart({ sourceIds: ["ev_1"] })).success).toBe(true);
	});

	it("refuses a source without an as-of date, a cited id without a copy, and an uncited copy", () => {
		const undated = chart({
			series: [{ name: "Base", points: [{ x: "Grid", y: 4, sourceId: "ev_1" }] }],
		});
		expect(widgetCoreSchema.safeParse(undated).success).toBe(false);
		expect(widgetCoreSchema.safeParse(chart({ sources: [] })).success).toBe(false);
		expect(
			widgetCoreSchema.safeParse(chart({ sources: [SOURCE, { ...SOURCE, evidenceId: "ev_2" }] }))
				.success,
		).toBe(false);
		expect(widgetCoreSchema.safeParse(chart({ sources: [SOURCE, SOURCE] })).success).toBe(false);
	});

	it("still parses a chart saved before provenance existed", () => {
		const { sources: _s, ...plain } = chart({
			series: [{ name: "Base", points: [{ x: "AI", y: 16.5 }] }],
		});
		expect(widgetCoreSchema.safeParse(plain).success).toBe(true);
	});

	it("keeps an agent's provenance only where it carried a point over unchanged", () => {
		const previous = [widgetCoreSchema.parse(chart({ sourceIds: ["ev_1"] }))];
		const pointsOf = (widgets: readonly WidgetCore[]) =>
			widgets.flatMap((widget) =>
				widget.type === "chart" ? widget.series.flatMap((entry) => entry.points) : [],
			);
		// Untouched, and an exact duplicate under a new id: everything stays.
		expect(withEarnedChartProvenance(previous, previous)).toEqual(previous);
		const duplicate = widgetCoreSchema.parse(chart({ widgetId: "w_2", sourceIds: ["ev_1"] }));
		expect(withEarnedChartProvenance([duplicate], previous)).toEqual([duplicate]);

		// A changed value, a changed unit, a renamed series, another chart: stripped.
		const changedValue = widgetCoreSchema.parse(
			chart({
				sourceIds: ["ev_1"],
				series: [
					{
						name: "Base",
						points: [
							{ x: "AI", y: 16.5, basis: "assumption" },
							{ x: "Grid", y: 40, sourceId: "ev_1", asOf: "2026-10-01" },
						],
					},
				],
			}),
		);
		const [kept] = withEarnedChartProvenance([changedValue], previous);
		expect(pointsOf(kept === undefined ? [] : [kept])).toEqual([
			{ x: "AI", y: 16.5, basis: "assumption" },
			{ x: "Grid", y: 40 },
		]);
		if (kept?.type !== "chart") throw new Error("expected a chart");
		// A point carried over keeps the chart's own citation, so its copy stays.
		expect(kept.sourceIds).toEqual(["ev_1"]);
		expect(kept.sources).toEqual([SOURCE]);

		for (const changed of [
			chart({ unit: "USD", sourceIds: ["ev_1"] }),
			chart({
				sourceIds: ["ev_1"],
				series: [{ name: "Bear", points: [{ x: "AI", y: 16.5, basis: "assumption" }] }],
			}),
			chart({ widgetId: "w_other", title: "Other", unit: "USD", sourceIds: ["ev_1"] }),
		]) {
			const [result] = withEarnedChartProvenance([widgetCoreSchema.parse(changed)], previous);
			if (result?.type !== "chart") throw new Error("expected a chart");
			expect(pointsOf([result]).every((point) => Object.keys(point).length === 2)).toBe(true);
			expect(result.sourceIds).toBeUndefined();
			expect(result.sources).toBeUndefined();
			expect(widgetCoreSchema.safeParse(result).success).toBe(true);
		}
	});

	it("reconciles an agent's draft: copies nobody cites go, citations without a copy lose their source", () => {
		const draft = reconcileChartDraft(
			chart({
				series: [{ name: "Base", points: [{ x: "AI", y: 1 }] }],
				sources: [SOURCE],
			}),
		);
		expect(widgetCoreSchema.parse(draft)).not.toHaveProperty("sources");
		const added = reconcileChartDraft(
			chart({
				sourceIds: ["ev_9"],
				series: [
					{ name: "Base", points: [{ x: "Grid", y: 4, sourceId: "ev_9", asOf: "2026-10-01" }] },
				],
				sources: undefined,
			}),
		);
		const parsed = widgetCoreSchema.parse(added);
		if (parsed.type !== "chart") throw new Error("expected a chart");
		expect(parsed.series[0]?.points).toEqual([{ x: "Grid", y: 4 }]);
		expect(parsed.sourceIds).toBeUndefined();
		expect(reconcileChartDraft({ type: "text" })).toEqual({ type: "text" });
	});
});
