import { datasetSchema, widgetCoreSchema, workspaceViewSchema } from "@research/contracts";
import {
	createBaselineUiRegistry,
	type RenderContext,
	WorkspaceComponentView,
} from "@research/ui-registry";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { widgetFromComponent } from "../../src/notebook/notebookModel.ts";
import { ChartWidget } from "../../src/notebook/widgets/ChartWidget.tsx";
import { WORKSPACE_VIEW } from "../fixtures.ts";
import { notebookFixtures } from "./notebookHarness.ts";

const registry = createBaselineUiRegistry();

afterEach(cleanup);

function texts(root: ParentNode, selector: string): string[] {
	return [...root.querySelectorAll(selector)].map((element) => element.textContent ?? "");
}

function yTickLabels(root: ParentNode): string[] {
	return [...root.querySelectorAll('[data-chart-part="y-axis"] text')]
		.filter((element) => element.getAttribute("data-axis-title") === null)
		.map((element) => element.textContent ?? "");
}

function axisTitles(root: ParentNode): { readonly x: string | null; readonly y: string | null } {
	return {
		x: root.querySelector('[data-axis-title="x"]')?.textContent ?? null,
		y: root.querySelector('[data-axis-title="y"]')?.textContent ?? null,
	};
}

const growthDataset = datasetSchema.parse({
	datasetId: "ds_growth",
	title: "Derived scenario growth",
	createdAt: "2026-10-17T00:00:00Z",
	columns: [
		{ key: "scenario", label: "Scenario", kind: "text" },
		{ key: "bear", label: "Bear", kind: "number", unit: "% per year" },
		{ key: "base", label: "Base", kind: "number", unit: "% per year" },
		{ key: "bull", label: "Bull", kind: "number", unit: "% per year" },
	],
	rows: [
		{
			scenario: { v: "AI data center services" },
			bear: { v: 7, basis: "assumption" },
			base: { v: 16.5, basis: "assumption" },
			bull: { v: 27, basis: "assumption" },
		},
	],
});

const growthComponent = {
	componentId: "run_1_growth",
	componentType: "bar-chart",
	schemaVersion: 1,
	props: {
		title: "Derived compound annual growth by scenario",
		datasetRef: "ds_growth",
		categoryKey: "scenario",
		series: [
			{ key: "bear", label: "Bear" },
			{ key: "base", label: "Base" },
			{ key: "bull", label: "Bull" },
		],
		xLabel: "Scenario",
		yLabel: "Compound annual growth",
		yUnit: "% per year",
		sourceIds: [],
	},
} as const;

const growthView = workspaceViewSchema.parse({
	...WORKSPACE_VIEW,
	datasets: [growthDataset],
	state: {
		...WORKSPACE_VIEW.state,
		components: [growthComponent],
		layout: { order: ["run_1_growth"], columns: 1 },
	},
});

function growthContext(): RenderContext {
	return {
		datasets: new Map([[growthDataset.datasetId, growthDataset]]),
		sources: new Map(),
		selection: null,
		onSelect: () => {},
	};
}

const lineDataset = datasetSchema.parse({
	datasetId: "ds_line_gap",
	title: "Prices with a gap",
	createdAt: "2026-10-17T00:00:00Z",
	columns: [
		{ key: "date", label: "Date", kind: "text" },
		{ key: "aapl", label: "AAPL", kind: "number", unit: "USD" },
		{ key: "msft", label: "MSFT", kind: "number", unit: "USD" },
	],
	rows: [
		{
			date: { v: "2026-10-07" },
			aapl: { v: 336.67, basis: "assumption" },
			msft: { v: 531.2, basis: "assumption" },
		},
		{
			date: { v: "2026-10-08" },
			aapl: { v: 340.42, basis: "assumption" },
			msft: { v: null, reason: "market closed" },
		},
		{
			date: { v: "2026-10-09" },
			aapl: { v: 342.1, basis: "assumption" },
			msft: { v: 535.0, basis: "assumption" },
		},
	],
});

const lineComponent = {
	componentId: "run_1_line_gap",
	componentType: "line-chart",
	schemaVersion: 1,
	props: {
		title: "Prices with a gap",
		datasetRef: "ds_line_gap",
		xKey: "date",
		series: [
			{ key: "aapl", label: "AAPL" },
			{ key: "msft", label: "MSFT" },
		],
		xLabel: "Date",
		yLabel: "Price",
		yUnit: "USD",
		sourceIds: [],
	},
} as const;

const lineView = workspaceViewSchema.parse({
	...WORKSPACE_VIEW,
	datasets: [lineDataset],
	state: {
		...WORKSPACE_VIEW.state,
		components: [lineComponent],
		layout: { order: ["run_1_line_gap"], columns: 1 },
	},
});

function lineContext(): RenderContext {
	return {
		datasets: new Map([[lineDataset.datasetId, lineDataset]]),
		sources: new Map(),
		selection: null,
		onSelect: () => {},
	};
}

describe("chart parity between Chat previews and Notebook widgets", () => {
	it("draws the owner's bar case through the same svg, marks, axis titles and y ticks", () => {
		const component = growthView.state.components[0];
		if (component === undefined) throw new Error("growth component is missing");
		const chat = render(() => (
			<WorkspaceComponentView component={component} context={growthContext()} registry={registry} />
		));
		const chatSvg = chat.container.querySelector('svg[role="img"]');
		if (!(chatSvg instanceof SVGElement)) throw new Error("no chat chart svg");
		const chatMarks = chatSvg.querySelector('[data-chart-part="marks"]')?.innerHTML ?? "";
		const chatTitles = axisTitles(chat.container);
		const chatTicks = yTickLabels(chat.container);
		const chatBars = chat.container.querySelectorAll("path[data-bar]");
		expect(chatBars).toHaveLength(3);
		// Three bars side by side: distinct x positions from their path starts.
		const xs = [...chatBars].map((bar) => /^M([^,]+),/.exec(bar.getAttribute("d") ?? "")?.[1]);
		expect(new Set(xs).size).toBe(3);
		cleanup();

		const core = widgetFromComponent(component, growthView);
		if (core?.type !== "chart") throw new Error("expected a chart widget");
		expect(core.xLabel).toBe("Scenario");
		expect(core.yLabel).toBe("Compound annual growth");
		const notebook = render(() => <ChartWidget widget={core} />);
		const notebookSvg = notebook.container.querySelector('svg[role="img"]');
		if (!(notebookSvg instanceof SVGElement)) throw new Error("no notebook chart svg");
		expect(notebookSvg.getAttribute("viewBox")).toBe(chatSvg.getAttribute("viewBox"));
		expect(notebookSvg.querySelector('[data-chart-part="marks"]')?.innerHTML).toBe(chatMarks);
		expect(axisTitles(notebook.container)).toEqual(chatTitles);
		expect(yTickLabels(notebook.container)).toEqual(chatTicks);
		expect(notebook.container.querySelectorAll("path[data-bar]")).toHaveLength(3);
	});

	it("draws a two-series line chart with a gap through the same svg without bridging it", () => {
		const component = lineView.state.components[0];
		if (component === undefined) throw new Error("line component is missing");
		const chat = render(() => (
			<WorkspaceComponentView component={component} context={lineContext()} registry={registry} />
		));
		const chatSvg = chat.container.querySelector('svg[role="img"]');
		if (!(chatSvg instanceof SVGElement)) throw new Error("no chat chart svg");
		const chatMarks = chatSvg.querySelector('[data-chart-part="marks"]')?.innerHTML ?? "";
		const chatTitles = axisTitles(chat.container);
		const chatTicks = yTickLabels(chat.container);
		// MSFT has two isolated points around a gap, so no line may connect across it.
		const msft = chat.container.querySelector('[data-series="MSFT"]');
		expect(msft?.querySelectorAll("path")).toHaveLength(0);
		expect(msft?.querySelectorAll("circle")).toHaveLength(2);
		cleanup();

		const core = widgetFromComponent(component, lineView);
		if (core?.type !== "chart") throw new Error("expected a chart widget");
		const notebook = render(() => <ChartWidget widget={core} />);
		const notebookSvg = notebook.container.querySelector('svg[role="img"]');
		if (!(notebookSvg instanceof SVGElement)) throw new Error("no notebook chart svg");
		expect(notebookSvg.getAttribute("viewBox")).toBe(chatSvg.getAttribute("viewBox"));
		expect(notebookSvg.querySelector('[data-chart-part="marks"]')?.innerHTML).toBe(chatMarks);
		expect(axisTitles(notebook.container)).toEqual(chatTitles);
		expect(yTickLabels(notebook.container)).toEqual(chatTicks);
		const notebookMsft = notebook.container.querySelector('[data-series="MSFT"]');
		expect(notebookMsft?.querySelectorAll("path")).toHaveLength(0);
		expect(notebookMsft?.querySelectorAll("circle")).toHaveLength(2);
	});

	it("carries provenance: the same basis note, cell markers, citations and Sources as Chat (ADR-0026)", () => {
		const evidence = WORKSPACE_VIEW.sources[0];
		if (evidence === undefined) throw new Error("the fixture has no evidence");
		const dataset = datasetSchema.parse({
			datasetId: "ds_sourced",
			title: "Sourced prices",
			createdAt: "2026-10-17T00:00:00Z",
			columns: [
				{ key: "date", label: "Date", kind: "date" },
				{ key: "px", label: "Price", kind: "number", unit: "USD" },
			],
			rows: [
				{
					date: { v: "2026-10-07" },
					px: { v: 10, sourceId: evidence.evidenceId, asOf: "2026-10-07" },
				},
				{ date: { v: "2026-10-08" }, px: { v: 11, basis: "assumption" } },
				{ date: { v: "2026-10-09" }, px: { v: 12, basis: "derived" } },
			],
		});
		const component = {
			componentId: "run_1_sourced",
			componentType: "line-chart",
			schemaVersion: 1,
			props: {
				title: "Sourced prices",
				datasetRef: "ds_sourced",
				xKey: "date",
				series: [{ key: "px", label: "Price" }],
				xLabel: "Date",
				yLabel: "Price",
				yUnit: "USD",
				sourceIds: [evidence.evidenceId],
			},
		} as const;
		const view = workspaceViewSchema.parse({
			...WORKSPACE_VIEW,
			datasets: [dataset],
			state: {
				...WORKSPACE_VIEW.state,
				components: [component],
				layout: { order: ["run_1_sourced"], columns: 1 },
			},
		});
		const parsedComponent = view.state.components[0];
		if (parsedComponent === undefined) throw new Error("sourced component is missing");
		const context: RenderContext = {
			datasets: new Map([[dataset.datasetId, dataset]]),
			sources: new Map([[evidence.evidenceId, evidence]]),
			selection: null,
			onSelect: () => {},
		};
		const provenanceOf = (root: ParentNode) => ({
			basisNote: root.querySelector("[data-chart-basis-note]")?.textContent ?? null,
			sources: root.querySelector('section[aria-label="Sources"]')?.textContent ?? null,
			marks: root.querySelector('[data-chart-part="marks"]')?.innerHTML ?? null,
			tableCells: texts(root, "details td"),
		});
		const chat = render(() => (
			<WorkspaceComponentView component={parsedComponent} context={context} registry={registry} />
		));
		const inChat = provenanceOf(chat.container);
		expect(inChat.basisNote).toContain("1 assumption");
		expect(inChat.sources).toContain("1 source");
		cleanup();

		const core = widgetFromComponent(parsedComponent, view);
		if (core?.type !== "chart") throw new Error("expected a chart widget");
		expect(core.sources?.map((source) => source.evidenceId)).toEqual([evidence.evidenceId]);
		const notebook = render(() => <ChartWidget widget={core} />);
		expect(provenanceOf(notebook.container)).toEqual(inChat);
		cleanup();

		// A citation the conversation cannot resolve stays a research widget.
		const missing = workspaceViewSchema.parse({ ...view, sources: [] });
		expect(widgetFromComponent(parsedComponent, missing)?.type).toBe("research");
	});

	it("lines up series with different x labels by label and never draws a missing value as 0", () => {
		const widget = widgetCoreSchema.parse({
			widgetId: "w-mixed",
			type: "chart",
			title: "Mixed labels",
			size: "medium",
			chartType: "bar",
			unit: "GWh",
			series: [
				{
					name: "A",
					points: [
						{ x: "2026", y: 10 },
						{ x: "2027", y: 20 },
					],
				},
				{
					name: "B",
					points: [
						{ x: "2027", y: 30 },
						{ x: "2028", y: 40 },
					],
				},
			],
			xLabel: "Year",
			yLabel: "Demand",
		});
		if (widget.type !== "chart") throw new Error("expected a chart widget");
		const { unmount } = render(() => <ChartWidget widget={widget} />);
		// Union of labels in first-seen order: 2026, 2027, 2028.
		expect(texts(document, '[data-chart-part="x-axis"] text')).toContain("2026");
		expect(document.body.textContent).toContain("2028");
		// Four plotted bars (two per series); the two missing cells are unavailable, never 0.
		expect(document.querySelectorAll("path[data-bar]")).toHaveLength(4);
		expect(
			document.querySelector("[data-unavailable-count]")?.getAttribute("data-unavailable-count"),
		).toBe("2");
		expect(document.body.textContent).toContain("—");
		unmount();
	});

	it("renders old stored widgets without axis labels", () => {
		const fixtures = notebookFixtures();
		if (fixtures.chart.type !== "chart") throw new Error("expected a chart fixture");
		expect("xLabel" in fixtures.chart).toBe(false);
		const { createdAt, updatedAt, revision, origin, ...core } = fixtures.chart;
		void createdAt;
		void updatedAt;
		void revision;
		void origin;
		const parsed = widgetCoreSchema.parse(core);
		if (parsed.type !== "chart") throw new Error("expected a chart widget");
		render(() => <ChartWidget widget={parsed} />);
		const svg = document.querySelector("svg[role='img']");
		if (!(svg instanceof SVGElement)) throw new Error("no chart svg");
		expect(svg.getAttribute("viewBox")).toBe("0 0 640 320");
		expect(svg.querySelector('[data-chart-part="marks"]')?.innerHTML.length).toBeGreaterThan(0);
	});
});
