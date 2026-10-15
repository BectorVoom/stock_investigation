import {
	type ChatMessage,
	NOTEBOOK_LIMITS,
	notebookWidgetCoreSchema,
	type WorkspaceView,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	duplicateNotebookWidget,
	moveNotebookWidget,
	newNotebookWidgetId,
	removeNotebookWidgets,
	reorderNotebookWidgets,
	resizeNotebookWidget,
	widgetFromAnswer,
	widgetFromComponent,
} from "../../src/notebook/notebookModel.ts";
import { WORKSPACE_VIEW } from "../fixtures.ts";
import { notebookFixtures } from "./notebookHarness.ts";

function chatMessage(text: string): ChatMessage {
	return {
		messageId: "msg_9",
		seq: 3,
		role: "assistant",
		text,
		runId: "run_9",
		claimIds: [],
		createdAt: "2026-10-04T00:10:00Z",
	};
}

describe("notebook model", () => {
	it("makes unique widget ids", () => {
		expect(newNotebookWidgetId()).not.toBe(newNotebookWidgetId());
		expect(newNotebookWidgetId().startsWith("nb-")).toBe(true);
	});

	it("converts an answer to editable text with a title from its first words", () => {
		const core = widgetFromAnswer(
			chatMessage("Utility tenders are rising across the region this year."),
		);
		expect(core.type).toBe("text");
		if (core.type !== "text") throw new Error("expected a text widget");
		expect(core.text).toContain("Utility tenders are rising");
		expect(core.title).toContain("Utility");
		expect(core.title.length).toBeLessThanOrEqual(NOTEBOOK_LIMITS.maxTitleChars);
		expect(notebookWidgetCoreSchema.safeParse(core).success).toBe(true);
	});

	it("falls back for an empty answer", () => {
		const core = widgetFromAnswer(chatMessage(""));
		expect(core.type).toBe("text");
		if (core.type !== "text") throw new Error("expected a text widget");
		expect(core.text).toBe("(empty answer)");
		expect(core.title).toBe("Answer");
	});

	it("converts a data-table component to a table carrying the dataset rows", () => {
		const component = WORKSPACE_VIEW.state.components.find(
			(entry) => entry.componentId === "run_1_table",
		);
		if (component === undefined) throw new Error("run_1_table fixture is missing");
		const core = widgetFromComponent(component, WORKSPACE_VIEW);
		expect(core?.type).toBe("table");
		if (core?.type !== "table") throw new Error("expected a table widget");
		expect(core.title).toBe("Demand scenarios");
		expect(core.columns).toEqual(["Year", "Base case"]);
		expect(core.rows).toEqual([
			["2026", 120],
			["2027", null],
		]);
		expect(notebookWidgetCoreSchema.safeParse(core).success).toBe(true);
	});

	it("returns null when the dataset is missing from the view", () => {
		const component = WORKSPACE_VIEW.state.components.find(
			(entry) => entry.componentId === "run_1_table",
		);
		if (component === undefined) throw new Error("run_1_table fixture is missing");
		const view: WorkspaceView = { ...WORKSPACE_VIEW, datasets: [] };
		expect(widgetFromComponent(component, view)).toBeNull();
	});

	it("converts a line-chart component to a chart with the same series", () => {
		const view: WorkspaceView = {
			...WORKSPACE_VIEW,
			datasets: [
				{
					datasetId: "ds_line",
					title: "Prices",
					createdAt: "2026-10-03T00:00:00Z",
					columns: [
						{ key: "date", label: "Date", kind: "text" },
						{ key: "aapl", label: "AAPL", kind: "number", unit: "USD" },
						{ key: "msft", label: "MSFT", kind: "number", unit: "USD" },
					],
					rows: [
						{
							date: { v: "2026-10-07" },
							aapl: { v: 336.67, sourceId: "ev_a", asOf: "2026-10-07" },
							msft: { v: 531.2, sourceId: "ev_a", asOf: "2026-10-07" },
						},
						{
							date: { v: "2026-10-08" },
							aapl: { v: 340.42, sourceId: "ev_a", asOf: "2026-10-08" },
							msft: { v: null, reason: "market closed" },
						},
					],
				},
			],
			state: {
				...WORKSPACE_VIEW.state,
				components: [
					{
						componentId: "line_1",
						componentType: "line-chart",
						schemaVersion: 1,
						props: {
							title: "Prices",
							datasetRef: "ds_line",
							xKey: "date",
							series: [
								{ key: "aapl", label: "AAPL" },
								{ key: "msft", label: "MSFT" },
							],
							xLabel: "Date",
							yLabel: "Price",
							yUnit: "USD",
							sourceIds: ["ev_a"],
						},
					},
				],
			},
		};
		const component = view.state.components[0];
		if (component === undefined) throw new Error("line_1 is missing");
		const core = widgetFromComponent(component, view);
		expect(core?.type).toBe("chart");
		if (core?.type !== "chart") throw new Error("expected a chart widget");
		expect(core.chartType).toBe("line");
		expect(core.unit).toBe("USD");
		expect(core.series.map((entry) => entry.name)).toEqual(["AAPL", "MSFT"]);
		// A null cell is not plotted, never drawn as 0.
		expect(core.series[0]?.points).toHaveLength(2);
		expect(core.series[1]?.points).toHaveLength(1);
		expect(notebookWidgetCoreSchema.safeParse(core).success).toBe(true);
	});

	it("converts a candlestick component to a line chart of the close", () => {
		const view: WorkspaceView = {
			...WORKSPACE_VIEW,
			datasets: [
				{
					datasetId: "ds_candle",
					title: "AAPL bars",
					createdAt: "2026-10-03T00:00:00Z",
					columns: [
						{ key: "date", label: "Date", kind: "text" },
						{ key: "open", label: "Open", kind: "number", unit: "USD" },
						{ key: "high", label: "High", kind: "number", unit: "USD" },
						{ key: "low", label: "Low", kind: "number", unit: "USD" },
						{ key: "close", label: "Close", kind: "number", unit: "USD" },
					],
					rows: [
						{
							date: { v: "2026-10-07" },
							open: { v: 335, sourceId: "ev_a", asOf: "2026-10-07" },
							high: { v: 337, sourceId: "ev_a", asOf: "2026-10-07" },
							low: { v: 334, sourceId: "ev_a", asOf: "2026-10-07" },
							close: { v: 336.67, sourceId: "ev_a", asOf: "2026-10-07" },
						},
					],
				},
			],
			state: {
				...WORKSPACE_VIEW.state,
				components: [
					{
						componentId: "candle_1",
						componentType: "candlestick-chart",
						schemaVersion: 1,
						props: {
							title: "AAPL bars",
							datasetRef: "ds_candle",
							dateKey: "date",
							openKey: "open",
							highKey: "high",
							lowKey: "low",
							closeKey: "close",
							priceUnit: "USD",
							sourceIds: ["ev_a"],
						},
					},
				],
			},
		};
		const component = view.state.components[0];
		if (component === undefined) throw new Error("candle_1 is missing");
		const core = widgetFromComponent(component, view);
		if (core?.type !== "chart") throw new Error("expected a chart widget");
		expect(core.chartType).toBe("line");
		expect(core.series).toHaveLength(1);
		expect(core.series[0]?.points).toEqual([{ x: "2026-10-07", y: 336.67 }]);
	});

	it("keeps any other component as a research widget with its title", () => {
		const component = WORKSPACE_VIEW.state.components.find(
			(entry) => entry.componentId === "run_1_news",
		);
		if (component === undefined) throw new Error("run_1_news fixture is missing");
		const core = widgetFromComponent(component, WORKSPACE_VIEW);
		expect(core).toMatchObject({ type: "research", componentId: "run_1_news" });
	});

	it("truncates large datasets instead of failing", () => {
		const component = WORKSPACE_VIEW.state.components.find(
			(entry) => entry.componentId === "run_1_table",
		);
		if (component === undefined) throw new Error("run_1_table fixture is missing");
		const rows = Array.from({ length: NOTEBOOK_LIMITS.maxTableRows + 50 }, (_, index) => ({
			year: { v: `y${index}` },
			base: { v: index, sourceId: "ev_a", asOf: "2026-06-30" },
		}));
		const demand = WORKSPACE_VIEW.datasets[0];
		if (demand === undefined) throw new Error("ds_demand fixture is missing");
		const view: WorkspaceView = {
			...WORKSPACE_VIEW,
			datasets: [{ ...demand, rows }],
		};
		const core = widgetFromComponent(component, view);
		if (core?.type !== "table") throw new Error("expected a table widget");
		expect(core.rows).toHaveLength(NOTEBOOK_LIMITS.maxTableRows);
		expect(notebookWidgetCoreSchema.safeParse(core).success).toBe(true);
	});

	it("duplicates a bare core under a fresh id, deeply copied", () => {
		const fixtures = notebookFixtures();
		const chart = fixtures.chart;
		if (chart.type !== "chart") throw new Error("expected a chart fixture");
		const { createdAt, updatedAt, revision, origin, ...core } = chart;
		void createdAt;
		void updatedAt;
		void revision;
		void origin;
		const copy = duplicateNotebookWidget(core);
		expect(copy.widgetId).not.toBe(chart.widgetId);
		if (copy.type !== "chart") throw new Error("expected a chart copy");
		expect(copy.series).toEqual(chart.series);
		copy.series[0]?.points.push({ x: "2028", y: 160 });
		expect(chart.series[0]?.points).toHaveLength(2);
		expect(notebookWidgetCoreSchema.safeParse(copy).success).toBe(true);
	});

	it("duplicates under a fresh id, and moves, reorders, resizes and removes", () => {
		const fixtures = notebookFixtures();
		const widgets = [fixtures.text, fixtures.metric, fixtures.chart];
		const copy = duplicateNotebookWidget(fixtures.text);
		expect(copy.widgetId).not.toBe(fixtures.text.widgetId);
		if (copy.type !== "text") throw new Error("expected a text copy");
		const original = fixtures.text;
		if (original.type !== "text") throw new Error("expected a text fixture");
		expect(copy.text).toBe(original.text);

		expect(
			moveNotebookWidget(widgets, "nb-metric", "earlier").map((widget) => widget.widgetId),
		).toEqual(["nb-metric", "nb-text", "nb-chart"]);
		expect(reorderNotebookWidgets(widgets, "nb-text", 2).map((widget) => widget.widgetId)).toEqual([
			"nb-metric",
			"nb-chart",
			"nb-text",
		]);
		expect(
			resizeNotebookWidget(widgets, "nb-text", "large").find(
				(widget) => widget.widgetId === "nb-text",
			)?.size,
		).toBe("large");
		expect(
			removeNotebookWidgets(widgets, ["nb-text", "nb-chart"]).map((widget) => widget.widgetId),
		).toEqual(["nb-metric"]);
		// Unknown ids change nothing.
		expect(moveNotebookWidget(widgets, "nb-missing", "earlier")).toBe(widgets);
	});
});
