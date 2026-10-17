import {
	type ChatMessage,
	NOTEBOOK_LIMITS,
	type WorkspaceView,
	widgetCoreSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import { widgetFromAnswer, widgetFromComponent } from "../../src/notebook/notebookModel.ts";
import {
	duplicateWidget,
	moveWidget,
	newWidgetId,
	removeWidgets,
	reorderWidgets,
	resizeWidget,
} from "../../src/widgets/widgetModel.ts";
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
		expect(newWidgetId()).not.toBe(newWidgetId());
		expect(newWidgetId().startsWith("w-")).toBe(true);
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
		expect(widgetCoreSchema.safeParse(core).success).toBe(true);
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
		expect(widgetCoreSchema.safeParse(core).success).toBe(true);
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
							msft: { v: 532.1, basis: "derived" },
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
		// Each value keeps its provenance, and the chart its cited record (ADR-0026).
		expect(core.series[0]?.points[0]).toEqual({
			x: "2026-10-07",
			y: 336.67,
			sourceId: "ev_a",
			asOf: "2026-10-07",
		});
		expect(core.series[1]?.points[1]).toEqual({ x: "2026-10-08", y: 532.1, basis: "derived" });
		expect(core.sourceIds).toEqual(["ev_a"]);
		expect(core.sources?.map((source) => source.evidenceId)).toEqual(["ev_a"]);

		// A stated gap ("market closed") cannot be carried by a widget point.
		const gapped: WorkspaceView = {
			...view,
			datasets: view.datasets.map((dataset) => ({
				...dataset,
				rows: dataset.rows.map((row, index) =>
					index === 1 ? { ...row, msft: { v: null, reason: "market closed" } } : row,
				),
			})),
		};
		expect(widgetFromComponent(component, gapped)?.type).toBe("research");
		expect(widgetCoreSchema.safeParse(core).success).toBe(true);
	});

	it("keeps a bar chart as a research widget when the registry would refuse its props or cut its unit", () => {
		const viewWith = (
			props: WorkspaceView["state"]["components"][number]["props"],
		): WorkspaceView => ({
			...WORKSPACE_VIEW,
			datasets: [
				{
					datasetId: "ds_bar",
					title: "Growth",
					createdAt: "2026-10-03T00:00:00Z",
					columns: [
						{ key: "scenario", label: "Scenario", kind: "text" },
						{ key: "base", label: "Base", kind: "number", unit: "%" },
					],
					rows: [{ scenario: { v: "AI" }, base: { v: 16.5, basis: "derived" } }],
				},
			],
			state: {
				...WORKSPACE_VIEW.state,
				components: [{ componentId: "bar_1", componentType: "bar-chart", schemaVersion: 1, props }],
			},
		});
		const props = {
			title: "Growth",
			datasetRef: "ds_bar",
			categoryKey: "scenario",
			series: [{ key: "base", label: "Base" }],
			xLabel: "Scenario",
			yLabel: "Growth",
			yUnit: "% per year",
			sourceIds: [],
		};
		const typeOf = (view: WorkspaceView): string | undefined => {
			const component = view.state.components[0];
			if (component === undefined) throw new Error("bar_1 is missing");
			return widgetFromComponent(component, view)?.type;
		};
		expect(typeOf(viewWith(props))).toBe("chart");
		// No yUnit: the registry shows "cannot render", so no chart widget may claim the same picture.
		const { yUnit: _dropped, ...withoutUnit } = props;
		expect(typeOf(viewWith(withoutUnit))).toBe("research");
		// 30 characters fit the chart props (40) but not a widget unit (24).
		expect(typeOf(viewWith({ ...props, yUnit: "percent per year, compounded" }))).toBe("research");
	});

	it("keeps a candlestick component as a research widget (candles are not a close-price line)", () => {
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
		if (core?.type !== "research") throw new Error("expected a research widget");
		expect(core.componentId).toBe("candle_1");
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
		expect(widgetCoreSchema.safeParse(core).success).toBe(true);
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
		const copy = duplicateWidget(core);
		expect(copy.widgetId).not.toBe(chart.widgetId);
		if (copy.type !== "chart") throw new Error("expected a chart copy");
		expect(copy.series).toEqual(chart.series);
		copy.series[0]?.points.push({ x: "2028", y: 160 });
		expect(chart.series[0]?.points).toHaveLength(2);
		expect(widgetCoreSchema.safeParse(copy).success).toBe(true);
	});

	it("duplicates under a fresh id, and moves, reorders, resizes and removes", () => {
		const fixtures = notebookFixtures();
		const widgets = [fixtures.text, fixtures.metric, fixtures.chart];
		const copy = duplicateWidget(fixtures.text);
		expect(copy.widgetId).not.toBe(fixtures.text.widgetId);
		// A stored widget's metadata never travels into the copy.
		expect(widgetCoreSchema.safeParse(copy).success).toBe(true);
		expect("origin" in copy).toBe(false);
		if (copy.type !== "text") throw new Error("expected a text copy");
		const original = fixtures.text;
		if (original.type !== "text") throw new Error("expected a text fixture");
		expect(copy.text).toBe(original.text);

		expect(moveWidget(widgets, "nb-metric", "earlier").map((widget) => widget.widgetId)).toEqual([
			"nb-metric",
			"nb-text",
			"nb-chart",
		]);
		expect(reorderWidgets(widgets, "nb-text", 2).map((widget) => widget.widgetId)).toEqual([
			"nb-metric",
			"nb-chart",
			"nb-text",
		]);
		expect(
			resizeWidget(widgets, "nb-text", "large").find((widget) => widget.widgetId === "nb-text")
				?.size,
		).toBe("large");
		expect(
			removeWidgets(widgets, ["nb-text", "nb-chart"]).map((widget) => widget.widgetId),
		).toEqual(["nb-metric"]);
		// Unknown ids change nothing.
		expect(moveWidget(widgets, "nb-missing", "earlier")).toBe(widgets);
	});
});
