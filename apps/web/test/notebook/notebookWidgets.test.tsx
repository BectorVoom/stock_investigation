import { createBaselineUiRegistry } from "@research/ui-registry";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetBody } from "../../src/notebook/widgets/WidgetBody.tsx";
import { WORKSPACE_VIEW } from "../fixtures.ts";
import { notebookFixtures } from "./notebookHarness.ts";

const registry = createBaselineUiRegistry();
const BODY_DEFAULTS = {
	market: null,
	editingDisabled: false,
	onSaveText: () => Promise.resolve(true),
} as const;

afterEach(() => {
	cleanup();
});

describe("notebook widget bodies", () => {
	it("renders text paragraphs, compact and clamped when small", () => {
		const fixtures = notebookFixtures();
		const small = { ...fixtures.text, size: "small" as const };
		render(() => <WidgetBody widget={small} view={null} registry={registry} {...BODY_DEFAULTS} />);
		expect(screen.getByText("First paragraph.")).toBeDefined();
		expect(screen.getByText("Second paragraph.")).toBeDefined();
	});

	it("renders a metric value with unit, signed change and as-of date", () => {
		const fixtures = notebookFixtures();
		const { unmount } = render(() => (
			<WidgetBody widget={fixtures.metric} view={null} registry={registry} {...BODY_DEFAULTS} />
		));
		expect(document.body.textContent).toContain("42.5");
		expect(document.body.textContent).toContain("GWh");
		// Status is never colour alone: an arrow plus the word.
		expect(document.body.textContent).toContain("▲");
		expect(document.body.textContent).toContain("up");
		expect(document.body.textContent).toContain("Storage demand");
		expect(document.body.textContent).toContain("2026-10-01");
		expect(document.body.textContent).toContain("Written by the assistant");
		unmount();
	});

	it("renders unavailable when the metric value is null", () => {
		const fixtures = notebookFixtures();
		const empty = { ...fixtures.metric, value: null };
		render(() => <WidgetBody widget={empty} view={null} registry={registry} {...BODY_DEFAULTS} />);
		expect(document.body.textContent).toContain("unavailable");
		expect(document.body.textContent).not.toContain("42.5");
	});

	it("renders a small chart as a sparkline with a summary and a data table", () => {
		const fixtures = notebookFixtures();
		const small = { ...fixtures.chart, size: "small" as const };
		render(() => <WidgetBody widget={small} view={null} registry={registry} {...BODY_DEFAULTS} />);
		const svg = document.querySelector("svg[role='img']");
		if (!(svg instanceof SVGElement)) throw new Error("no chart svg");
		expect(svg.getAttribute("aria-label")).toContain("Line chart");
		expect(svg.getAttribute("aria-label")).toContain("Base");
		// Small: no axes, no legend.
		expect(document.querySelector('[aria-label="Legend"]')).toBeNull();
		expect(svg.querySelector("line")).toBeNull();
		expect(screen.getByText(/Data table:/)).toBeDefined();
	});

	it("renders axes with first/last labels and the unit when medium", () => {
		const fixtures = notebookFixtures();
		render(() => (
			<WidgetBody widget={fixtures.chart} view={null} registry={registry} {...BODY_DEFAULTS} />
		));
		expect(document.body.textContent).toContain("2026");
		expect(document.body.textContent).toContain("2027");
		expect(document.body.textContent).toContain("Unit: GWh");
	});

	it("renders a legend and a live readout when large", () => {
		const fixtures = notebookFixtures();
		const large = { ...fixtures.chart, size: "large" as const };
		render(() => <WidgetBody widget={large} view={null} registry={registry} {...BODY_DEFAULTS} />);
		const legend = document.querySelector('[aria-label="Legend"]');
		if (!(legend instanceof HTMLElement)) throw new Error("no chart legend");
		expect(legend.textContent).toContain("Base");
		expect(legend.textContent).toContain("High");
		expect(document.body.textContent).toContain("data table below lists every value");
	});

	it("renders a table with a caption and right-aligned numbers", () => {
		const fixtures = notebookFixtures();
		render(() => (
			<WidgetBody widget={fixtures.table} view={null} registry={registry} {...BODY_DEFAULTS} />
		));
		const table = screen.getByRole("table");
		expect(table.querySelector("caption")).not.toBeNull();
		expect(table.querySelectorAll("th[scope='col']")).toHaveLength(2);
		const row = within(table).getByRole("row", { name: /2026/ });
		const numberCell = [...row.querySelectorAll("td")].find((cell) =>
			cell.textContent?.includes("120"),
		);
		if (!(numberCell instanceof HTMLElement)) throw new Error("no number cell");
		expect(numberCell.className).toContain("text-right");
	});

	it("renders a research widget through the registry with its content", () => {
		const fixtures = notebookFixtures();
		render(() => (
			<WidgetBody
				widget={fixtures.research}
				view={WORKSPACE_VIEW}
				registry={registry}
				{...BODY_DEFAULTS}
			/>
		));
		expect(document.body.textContent).toContain("Grid storage demand by year");
	});

	it("says when the research component is no longer in the canvas", () => {
		const fixtures = notebookFixtures();
		const gone = { ...fixtures.research, componentId: "missing-component" };
		render(() => (
			<WidgetBody widget={gone} view={WORKSPACE_VIEW} registry={registry} {...BODY_DEFAULTS} />
		));
		expect(document.body.textContent).toContain("This research result is no longer available.");
	});

	it("marks assistant-made widgets with one quiet line, owner widgets with none", () => {
		const fixtures = notebookFixtures();
		const { unmount } = render(() => (
			<WidgetBody widget={fixtures.text} view={null} registry={registry} {...BODY_DEFAULTS} />
		));
		expect(document.body.textContent).not.toContain("Written by the assistant");
		unmount();
	});
});
