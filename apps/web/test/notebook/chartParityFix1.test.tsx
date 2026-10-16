import { DATASET_LIMITS, widgetCoreSchema } from "@research/contracts";
import {
	buildLineModel,
	ChartNotices,
	guardDataset,
	LinePlot,
	xAxisModel,
} from "@research/ui-registry";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { chartWidgetToGuardedDataset } from "../../src/notebook/chartDataset.ts";
import { losslessChartWidget, widgetFromComponent } from "../../src/notebook/notebookModel.ts";
import { ChartWidget } from "../../src/notebook/widgets/ChartWidget.tsx";
import { duplicateWidget } from "../../src/widgets/widgetModel.ts";
import { WORKSPACE_VIEW } from "../fixtures.ts";

afterEach(cleanup);

function chartWidget(
	series: readonly {
		readonly name: string;
		readonly points: { readonly x: string; readonly y: number }[];
	}[],
	extra: Record<string, unknown> = {},
) {
	const parsed = widgetCoreSchema.parse({
		widgetId: "w-test",
		type: "chart",
		title: "Test",
		size: "medium",
		chartType: "line",
		unit: "USD",
		series,
		...extra,
	});
	if (parsed.type !== "chart") throw new Error("expected a chart widget");
	return parsed;
}

describe("fix round 1: chart parity defects", () => {
	it("D1: the data table never shows a withheld value, only its reason", () => {
		const widget = chartWidget(
			[{ name: "US margin buy balance", points: [{ x: "2026", y: 12345 }] }],
			{ unit: "shares" },
		);
		const { container } = render(() => <ChartWidget widget={widget} />);
		const cells = [...container.querySelectorAll("table td, table th[scope='row']")].map(
			(element) => element.textContent ?? "",
		);
		expect(cells.some((text) => text.includes("12345"))).toBe(false);
		expect(cells.some((text) => text.includes("no security-level"))).toBe(true);
		expect(container.querySelector("[data-withheld-series]")?.textContent).toContain(
			"no security-level",
		);
	});

	it("D2: xKind is stored, fills from the source column, and drives date positioning", () => {
		// Stored widgets without xKind still parse (absent = text).
		const parsed = widgetCoreSchema.parse({
			widgetId: "w-old",
			type: "chart",
			title: "Old",
			size: "medium",
			chartType: "line",
			unit: "USD",
			series: [{ name: "A", points: [{ x: "2026-01-01", y: 1 }] }],
		});
		if (parsed.type !== "chart") throw new Error("expected a chart widget");
		expect("xKind" in parsed).toBe(false);
		// The guarded dataset defaults to a text x column.
		expect(chartWidgetToGuardedDataset(parsed).dataset.columns[0]?.kind).toBe("text");

		// An explicit date kind survives and positions by elapsed time.
		const dated = chartWidget([{ name: "A", points: [{ x: "2026-01-01", y: 1 }] }], {
			xKind: "date",
		});
		const guarded = chartWidgetToGuardedDataset(dated);
		expect(guarded.dataset.columns[0]?.kind).toBe("date");

		const timed = chartWidgetToGuardedDataset(
			chartWidget(
				[
					{
						name: "A",
						points: [
							{ x: "2026-01-01", y: 1 },
							{ x: "2026-01-10", y: 2 },
							{ x: "2026-01-11", y: 3 },
						],
					},
				],
				{ xKind: "date" },
			),
		);
		const timeAxis = xAxisModel(timed.dataset, "x");
		expect(timeAxis.mode).toBe("time");
		const ordinal = chartWidgetToGuardedDataset(
			chartWidget([
				{
					name: "A",
					points: [
						{ x: "2026-01-01", y: 1 },
						{ x: "2026-01-10", y: 2 },
						{ x: "2026-01-11", y: 3 },
					],
				},
			]),
		);
		expect(xAxisModel(ordinal.dataset, "x").mode).toBe("ordinal");
		// By elapsed time Jan 10 sits near Jan 11 (9 of 10 days); ordinally it sits midway.
		const timePositions = timeAxis.positions;
		const first = timePositions[0] ?? null;
		const middle = timePositions[1] ?? null;
		const last = timePositions[2] ?? null;
		if (first === null || middle === null || last === null)
			throw new Error("expected placeable rows");
		expect(middle - first).toBeGreaterThan(last - middle);

		// widgetFromComponent fills xKind from the source x column.
		const view = {
			...WORKSPACE_VIEW,
			datasets: [
				{
					datasetId: "ds_date",
					title: "Dated",
					createdAt: "2026-10-03T00:00:00Z",
					columns: [
						{ key: "day", label: "Day", kind: "date" },
						{ key: "a", label: "A", kind: "number", unit: "USD" },
					],
					rows: [
						{
							day: { v: "2026-01-01" },
							a: { v: 1, basis: "assumption" },
						},
						{
							day: { v: "2026-01-10" },
							a: { v: 2, basis: "assumption" },
						},
					],
				},
			],
			state: {
				...WORKSPACE_VIEW.state,
				components: [
					{
						componentId: "line_date",
						componentType: "line-chart",
						schemaVersion: 1,
						props: {
							title: "Dated",
							datasetRef: "ds_date",
							xKey: "day",
							series: [{ key: "a", label: "A" }],
							xLabel: "Day",
							yLabel: "Price",
							yUnit: "USD",
							sourceIds: [],
						},
					},
				],
			},
		} as typeof WORKSPACE_VIEW;
		const component = view.state.components[0];
		if (component === undefined) throw new Error("line_date is missing");
		const core = widgetFromComponent(component, view);
		if (core?.type !== "chart") throw new Error("expected a chart widget");
		expect(core.xKind).toBe("date");

		// duplicateWidget preserves xKind alongside the axis labels.
		const copy = duplicateWidget(core);
		if (copy.type !== "chart") throw new Error("expected a chart copy");
		expect(copy.xKind).toBe("date");
		expect(copy.xLabel).toBe("Day");
	});

	it("D3: row order keeps every series' own order (Jan, Mar + Jan, Feb, Mar -> Jan, Feb, Mar)", () => {
		const widget = chartWidget([
			{
				name: "A",
				points: [
					{ x: "Jan", y: 1 },
					{ x: "Mar", y: 3 },
				],
			},
			{
				name: "B",
				points: [
					{ x: "Jan", y: 10 },
					{ x: "Feb", y: 20 },
					{ x: "Mar", y: 30 },
				],
			},
		]);
		const guarded = chartWidgetToGuardedDataset(widget);
		const labels = guarded.dataset.rows.map((row) => {
			const cell = row.x;
			return cell === undefined ? null : cell.v;
		});
		expect(labels).toEqual(["Jan", "Feb", "Mar"]);
	});

	it("D4: repeated x labels are separate rows", () => {
		const widget = chartWidget([
			{
				name: "A",
				points: [
					{ x: "Q1", y: 10 },
					{ x: "Q1", y: 20 },
				],
			},
		]);
		const guarded = chartWidgetToGuardedDataset(widget);
		expect(guarded.dataset.rows).toHaveLength(2);
		const values = guarded.dataset.rows.map((row) => row.s0?.v);
		expect(values).toEqual([10, 20]);
		const { container } = render(() => <ChartWidget widget={widget} />);
		expect(container.querySelectorAll("table tbody tr")).toHaveLength(2);
	});

	it("D5a: a gap in the first series stays a chart with the same picture", () => {
		const dataset = {
			datasetId: "ds_gap",
			title: "Gap",
			createdAt: "2026-10-03T00:00:00Z",
			columns: [
				{ key: "d", label: "Date", kind: "text" },
				{ key: "a", label: "A", kind: "number", unit: "USD" },
				{ key: "b", label: "B", kind: "number", unit: "USD" },
			],
			rows: [
				{
					d: { v: "2026-10-07" },
					a: { v: 1, basis: "assumption" },
					b: { v: 10, basis: "assumption" },
				},
				{
					d: { v: "2026-10-08" },
					a: { v: null, reason: "market closed" },
					b: { v: 11, basis: "assumption" },
				},
				{
					d: { v: "2026-10-09" },
					a: { v: 3, basis: "assumption" },
					b: { v: 12, basis: "assumption" },
				},
			],
		} as const;
		const converted = losslessChartWidget({
			dataset: dataset as never,
			xKey: "d",
			series: [
				{ key: "a", label: "A" },
				{ key: "b", label: "B" },
			],
			chartType: "line",
			title: "Gap",
			unit: "USD",
			xLabel: "Date",
			yLabel: "Price",
			widgetId: "w-gap",
		});
		expect(converted?.type).toBe("chart");
		// The rebuilt rows keep the source order, so the gap stays in the middle.
		if (converted?.type !== "chart") throw new Error("expected a chart widget");
		const rebuilt = chartWidgetToGuardedDataset(converted);
		expect(
			rebuilt.dataset.rows.map((row) => {
				const cell = row.x;
				return cell === undefined ? null : cell.v;
			}),
		).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
	});

	it("D5b: a row empty in every series falls back to research", () => {
		const dataset = {
			datasetId: "ds_empty",
			title: "Empty row",
			createdAt: "2026-10-03T00:00:00Z",
			columns: [
				{ key: "d", label: "Date", kind: "text" },
				{ key: "a", label: "A", kind: "number", unit: "USD" },
			],
			rows: [
				{
					d: { v: "2026-10-07" },
					a: { v: 1, basis: "assumption" },
				},
				{
					d: { v: "2026-10-08" },
					a: { v: null, reason: "market closed" },
				},
			],
		} as const;
		const converted = losslessChartWidget({
			dataset: dataset as never,
			xKey: "d",
			series: [{ key: "a", label: "A" }],
			chartType: "line",
			title: "Empty row",
			unit: "USD",
			xLabel: undefined,
			yLabel: undefined,
			widgetId: "w-empty",
		});
		expect(converted).toBeNull();
	});

	it("D5c: repeated labels convert without dropping observations", () => {
		const dataset = {
			datasetId: "ds_repeat",
			title: "Repeat",
			createdAt: "2026-10-03T00:00:00Z",
			columns: [
				{ key: "q", label: "Q", kind: "text" },
				{ key: "a", label: "A", kind: "number", unit: "USD" },
			],
			rows: [
				{
					q: { v: "Q1" },
					a: { v: 10, basis: "assumption" },
				},
				{
					q: { v: "Q1" },
					a: { v: 20, basis: "assumption" },
				},
			],
		} as const;
		const converted = losslessChartWidget({
			dataset: dataset as never,
			xKey: "q",
			series: [{ key: "a", label: "A" }],
			chartType: "line",
			title: "Repeat",
			unit: "USD",
			xLabel: undefined,
			yLabel: undefined,
			widgetId: "w-repeat",
		});
		if (converted?.type !== "chart") throw new Error("expected a chart widget");
		expect(converted.series[0]?.points).toEqual([
			{ x: "Q1", y: 10 },
			{ x: "Q1", y: 20 },
		]);
	});

	it("D5d: a column withheld by presentation falls back to research", () => {
		const dataset = {
			datasetId: "ds_withheld",
			title: "Withheld",
			createdAt: "2026-10-03T00:00:00Z",
			columns: [
				{ key: "d", label: "Date", kind: "text" },
				{ key: "m", label: "US margin buy balance", kind: "number", unit: "shares" },
			],
			rows: [
				{
					d: { v: "2026-10-07" },
					m: { v: 5, basis: "assumption" },
				},
			],
		} as const;
		const converted = losslessChartWidget({
			dataset: dataset as never,
			xKey: "d",
			series: [{ key: "m", label: "Balance" }],
			chartType: "line",
			title: "Withheld",
			unit: "shares",
			xLabel: undefined,
			yLabel: undefined,
			widgetId: "w-withheld",
		});
		expect(converted).toBeNull();
		// And the guarded source really does withhold it (so Chat withholds too).
		const guarded = guardDataset(dataset as never, new Map([["m", ["Balance"]]]));
		expect(guarded.withheldColumns.size).toBe(1);
	});

	it("D5e: an all-null first series falls back (it would shift colour slots)", () => {
		const dataset = {
			datasetId: "ds_nullfirst",
			title: "Null first",
			createdAt: "2026-10-03T00:00:00Z",
			columns: [
				{ key: "d", label: "Date", kind: "text" },
				{ key: "a", label: "A", kind: "number", unit: "USD" },
				{ key: "b", label: "B", kind: "number", unit: "USD" },
			],
			rows: [
				{
					d: { v: "2026-10-07" },
					a: { v: null, reason: "market closed" },
					b: { v: 10, basis: "assumption" },
				},
			],
		} as const;
		const converted = losslessChartWidget({
			dataset: dataset as never,
			xKey: "d",
			series: [
				{ key: "a", label: "A" },
				{ key: "b", label: "B" },
			],
			chartType: "line",
			title: "Null first",
			unit: "USD",
			xLabel: undefined,
			yLabel: undefined,
			widgetId: "w-nullfirst",
		});
		expect(converted).toBeNull();
	});

	it("D6: plots take a prebuilt model (one build per render)", () => {
		const widget = chartWidget([
			{
				name: "A",
				points: [
					{ x: "2026", y: 1 },
					{ x: "2027", y: 2 },
				],
			},
		]);
		const data = chartWidgetToGuardedDataset(widget);
		const model = buildLineModel(data, { xKey: "x", series: [{ key: "s0", label: "A" }] });
		const { container } = render(() => (
			<LinePlot model={model} xLabel="" yLabel="" yUnit="USD" title="Test" />
		));
		expect(container.querySelector('svg[role="img"]')).not.toBeNull();
		expect(container.querySelector('[data-chart-part="marks"]')?.innerHTML.length).toBeGreaterThan(
			0,
		);
	});

	it("D7: ChartNotices shares the shell's notices", () => {
		const { container } = render(() => (
			<ChartNotices
				withheldSeries={[{ label: "W", reason: "withheld for testing" }]}
				missingColumns={["gone"]}
				plottedCount={0}
				unavailableCount={2}
				emptyMessage="No plottable data — every requested value is unavailable."
			>
				<p>plot</p>
			</ChartNotices>
		));
		expect(container.querySelector("[data-withheld-series='W']")?.textContent).toContain(
			"withheld for testing",
		);
		expect(container.querySelector("[data-state='missing-columns']")?.textContent).toContain(
			"gone",
		);
		expect(container.textContent).toContain("No plottable data");
		expect(container.querySelector("[data-unavailable-count='2']")).not.toBeNull();
	});

	it("D8: widget rebuild respects the dataset limits", () => {
		const longName = "n".repeat(DATASET_LIMITS.maxColumnLabelChars + 10);
		const widget = chartWidget([{ name: longName, points: [{ x: "A", y: 1 }] }]);
		const guarded = chartWidgetToGuardedDataset(widget);
		const labels = guarded.dataset.columns.map((column) => column.label);
		for (const label of labels) {
			expect(label.length).toBeLessThanOrEqual(DATASET_LIMITS.maxColumnLabelChars);
		}
		for (const column of guarded.dataset.columns) {
			if (column.kind === "number" && column.unit !== undefined) {
				expect(column.unit.length).toBeLessThanOrEqual(DATASET_LIMITS.maxColumnUnitChars);
			}
		}
	});
});
