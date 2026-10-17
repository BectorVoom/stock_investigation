import { describe, expect, it } from "vitest";
import {
	chartProvenanceAddedTo,
	type Evidence,
	pruneUncitedChartSources,
	widgetCoreSchema,
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

	it("lets an agent keep provenance but never add it", () => {
		const previous = [widgetCoreSchema.parse(chart())];
		expect(chartProvenanceAddedTo(previous, previous)).toBeNull();
		// The same point moved to another chart is still the same point.
		expect(
			chartProvenanceAddedTo(
				[{ ...chart(), title: "Copy" }].map((w) => widgetCoreSchema.parse(w)),
				previous,
			),
		).toBeNull();
		const borrowed = widgetCoreSchema.parse(
			chart({
				title: "Borrowed",
				series: [
					{ name: "Base", points: [{ x: "Grid", y: 99, sourceId: "ev_1", asOf: "2026-10-01" }] },
				],
			}),
		);
		expect(chartProvenanceAddedTo([borrowed], previous)).toBe("Borrowed");
		const cited = widgetCoreSchema.parse(chart({ title: "Cited", sourceIds: ["ev_1"] }));
		expect(chartProvenanceAddedTo([cited], previous)).toBe("Cited");
		// New points without provenance are always fine.
		const plain = widgetCoreSchema.parse(
			chart({
				title: "Plain",
				series: [{ name: "Base", points: [{ x: "AI", y: 1 }] }],
				sources: undefined,
			}),
		);
		expect(chartProvenanceAddedTo([plain], [])).toBeNull();
	});

	it("drops the copies an agent's new series no longer cite", () => {
		const config = {
			series: [{ name: "Base", points: [{ x: "AI", y: 1 }] }],
			sources: [{ ...SOURCE }],
		};
		expect(pruneUncitedChartSources(config)).toEqual({ ...config, sources: [] });
		const stillCited = {
			series: [
				{ name: "Base", points: [{ x: "Grid", y: 4, sourceId: "ev_1", asOf: "2026-10-01" }] },
			],
			sources: [{ ...SOURCE }],
		};
		expect(pruneUncitedChartSources(stillCited)).toEqual(stillCited);
		expect(pruneUncitedChartSources({ text: "not a chart" })).toEqual({ text: "not a chart" });
	});
});
