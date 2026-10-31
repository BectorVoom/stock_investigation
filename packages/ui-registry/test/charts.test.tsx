import type { Dataset } from "@research/contracts";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { BarPlot } from "../src/charts/BarPlot.tsx";
import { buildBarModel } from "../src/charts/barModel.ts";
import {
	barPath,
	buildXTicks,
	contiguousRuns,
	DEFAULT_PLOT,
	extractCandles,
	extractSeries,
	FONT_SIZE,
	fitAxisTitle,
	linearScale,
	MAX_TICKS,
	nearestIndex,
	niceTicks,
	numericCell,
	thinnedIndexes,
	xAxisModel,
} from "../src/charts/chartMath.ts";
import { guardDataset } from "../src/datasetGuard.ts";
import { formatNumber } from "../src/format.ts";
import { component, DEMAND_DATASET, PRICE_DATASET, VALID_PROPS } from "./fixtures.ts";
import { renderComponent, texts } from "./helpers.tsx";

afterEach(cleanup);

describe("chart math", () => {
	it("fits an axis title along the plot: full size, then smaller type, then shortened", () => {
		const plotHeight = DEFAULT_PLOT.bottom - DEFAULT_PLOT.top;
		expect(fitAxisTitle("Price (USD)", plotHeight)).toEqual({
			text: "Price (USD)",
			fontSize: FONT_SIZE,
			truncated: false,
		});
		// 35 characters overrun the 248-unit plot at full size: smaller type, same words.
		const longer = fitAxisTitle("Compound annual growth (% per year)", plotHeight);
		expect(longer.text).toBe("Compound annual growth (% per year)");
		expect(longer.fontSize).toBeLessThan(FONT_SIZE);
		expect(longer.fontSize).toBeGreaterThanOrEqual(10);
		expect(longer.truncated).toBe(false);
		// Too long even at the smallest type: shortened with an ellipsis, never past the plot.
		const longest = fitAxisTitle("x".repeat(120), plotHeight);
		expect(longest.truncated).toBe(true);
		expect(longest.fontSize).toBe(10);
		expect(longest.text.endsWith("…")).toBe(true);
		expect(longest.text.length * 7.5 * (10 / FONT_SIZE)).toBeLessThanOrEqual(plotHeight);
	});

	it("treats only finite numbers as plottable", () => {
		expect(numericCell({ v: 0 })).toBe(0);
		expect(numericCell({ v: -3.5 })).toBe(-3.5);
		expect(numericCell({ v: "12" })).toBeNull();
		expect(numericCell({ v: null, reason: "missing" })).toBeNull();
		expect(numericCell(undefined)).toBeNull();
	});

	it("terminates with a usable axis for denormal, huge and flat ranges", () => {
		// Each of these either hung the old loop or produced an empty/NaN axis.
		expect(niceTicks(5e-324, 5e-324)).toEqual([5e-324]);
		expect(niceTicks(0, 5e-324)).toEqual([0, 5e-324]);
		expect(niceTicks(Number.MAX_VALUE, Number.MAX_VALUE)).toEqual([Number.MAX_VALUE]);
		expect(niceTicks(-Number.MAX_VALUE, Number.MAX_VALUE)).toEqual([
			-Number.MAX_VALUE,
			Number.MAX_VALUE,
		]);
		expect(niceTicks(1e300, 1e308)).toEqual([0, 2e307, 4e307, 6e307, 8e307, 1e308]);
		// A span far below the numbers' own precision cannot be ticked; the bounds are the axis.
		expect(niceTicks(1e20, 1e20 + 16384)).toEqual([1e20, 1e20 + 16384]);
		expect(niceTicks(0, 0)).toEqual([-1, -0.5, 0, 0.5, 1]);
		expect(niceTicks(7, 3)).toEqual(niceTicks(3, 7));
		expect(niceTicks(0, 100, Number.NaN)).toEqual(niceTicks(0, 100));
		expect(niceTicks(0, 100, 1e9).length).toBeLessThanOrEqual(MAX_TICKS);
		expect(niceTicks(1, Number.POSITIVE_INFINITY)).toEqual([]);
	});

	it("always returns a bounded, finite, strictly ascending axis that contains the data", () => {
		const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
		fc.assert(
			fc.property(finite, finite, fc.integer({ min: -3, max: 40 }), (a, b, target) => {
				const ticks = niceTicks(a, b, target);
				expect(ticks.length).toBeGreaterThanOrEqual(1);
				expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
				expect(ticks.every(Number.isFinite)).toBe(true);
				expect(ticks.every((tick, index) => index === 0 || tick > (ticks[index - 1] ?? tick))).toBe(
					true,
				);
				expect(ticks[0]).toBeLessThanOrEqual(Math.min(a, b));
				expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(Math.max(a, b));
				// The scale built on those ticks places every data value at a finite position inside the plot.
				const scale = linearScale(ticks[0] ?? 0, ticks[ticks.length - 1] ?? 0, 262, 14);
				for (const value of [a, b]) {
					expect(scale(value)).toBeGreaterThanOrEqual(14);
					expect(scale(value)).toBeLessThanOrEqual(262);
				}
			}),
			{ numRuns: 2000 },
		);
	});

	it("keeps a bound that sits a rounding error away from a tick inside the axis", () => {
		const ticks = niceTicks(0.1 + 0.2, 0.9);
		expect(ticks[0]).toBeLessThanOrEqual(0.1 + 0.2);
		expect(ticks).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
	});

	it("scales without overflow or NaN, and never loops when thinning labels", () => {
		const wide = linearScale(-Number.MAX_VALUE, Number.MAX_VALUE, 0, 100);
		expect(wide(-Number.MAX_VALUE)).toBe(0);
		expect(wide(0)).toBe(50);
		expect(wide(Number.MAX_VALUE)).toBe(100);
		expect(linearScale(5e-324, 5e-324, 0, 100)(5e-324)).toBe(50);
		expect(linearScale(Number.NaN, 1, 0, 100)(0.5)).toBe(50);

		expect(thinnedIndexes(300, 1)).toEqual([0]);
		expect(thinnedIndexes(300, 0)).toEqual([]);
		expect(thinnedIndexes(300, Number.POSITIVE_INFINITY)).toEqual([]);
		expect(thinnedIndexes(Number.NaN, 5)).toEqual([]);
		expect(thinnedIndexes(3, 2.5)).toEqual([]);
		const capped = thinnedIndexes(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1);
		expect(capped).toHaveLength(64);
		expect(capped[0]).toBe(0);
		expect(capped[63]).toBe(Number.MAX_SAFE_INTEGER - 1);
	});

	it("produces round ticks that bound the data", () => {
		expect(niceTicks(120, 310)).toEqual([100, 150, 200, 250, 300, 350]);
		expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
		expect(niceTicks(-40, 60)).toEqual([-40, -20, 0, 20, 40, 60]);
		expect(niceTicks(0.1, 0.3)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3]);
		// A flat series still gets a non-degenerate axis around the value.
		expect(niceTicks(50, 50)).toEqual([44, 46, 48, 50, 52, 54, 56]);
		expect(niceTicks(Number.NaN, 1)).toEqual([]);
	});

	it("maps a domain linearly onto a pixel range", () => {
		const scale = linearScale(0, 200, 300, 100);
		expect(scale(0)).toBe(300);
		expect(scale(100)).toBe(200);
		expect(scale(200)).toBe(100);
		expect(linearScale(5, 5, 0, 10)(5)).toBe(5);
	});

	it("thins labels evenly and keeps both ends", () => {
		expect(thinnedIndexes(4, 7)).toEqual([0, 1, 2, 3]);
		expect(thinnedIndexes(11, 3)).toEqual([0, 5, 10]);
		expect(thinnedIndexes(0, 3)).toEqual([]);
	});

	it("counts null and text cells as unavailable instead of plotting them", () => {
		const [base, bull] = extractSeries(
			DEMAND_DATASET,
			[
				{ key: "base", label: "Base" },
				{ key: "bull", label: "Bull" },
			],
			() => true,
		);
		expect(base?.points.map((point) => point.value)).toEqual([120, 150, 185, 230]);
		expect(base?.unavailableCount).toBe(0);
		expect(bull?.points).toEqual([
			{ rowIndex: 0, value: 140 },
			{ rowIndex: 3, value: 310 },
		]);
		expect(bull?.unavailableCount).toBe(2);
	});

	it("counts every row of an undeclared series column as unavailable", () => {
		const [ghost] = extractSeries(DEMAND_DATASET, [{ key: "ghost", label: "Ghost" }], () => true);
		expect(ghost?.points).toEqual([]);
		expect(ghost?.unavailableCount).toBe(4);
	});

	it("does not bridge a gap in a line", () => {
		const points = [
			{ rowIndex: 0, value: 1 },
			{ rowIndex: 1, value: 2 },
			{ rowIndex: 3, value: 4 },
		];
		expect(contiguousRuns(points, [0, 1, 2, 3])).toEqual([[points[0], points[1]], [points[2]]]);
	});

	it("places text categories evenly and numeric x values proportionally", () => {
		const ordinal = xAxisModel(DEMAND_DATASET, "year");
		expect(ordinal.mode).toBe("ordinal");
		expect(ordinal.positions).toEqual([0.125, 0.375, 0.625, 0.875]);

		const numeric = xAxisModel(
			{
				...DEMAND_DATASET,
				columns: [{ key: "x", label: "X", kind: "number", unit: "yr" }],
				rows: [
					{ x: { v: 2020 } },
					{ x: { v: 2021 } },
					{ x: { v: 2030 } },
					{ x: { v: null, reason: "?" } },
				],
			},
			"x",
		);
		expect(numeric.mode).toBe("linear");
		expect(numeric.positions).toEqual([0, 0.1, 1, null]);

		const dated = xAxisModel(PRICE_DATASET, "day");
		expect(dated.mode).toBe("time");
		expect(dated.positions).toEqual([0, 0.5, 1]);
		expect(dated.labels).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
	});

	it("skips candles with a missing or inconsistent price", () => {
		const keys = { openKey: "o", highKey: "h", lowKey: "l", closeKey: "c" };
		const { candles, unavailableCount } = extractCandles(PRICE_DATASET, keys, () => true);
		expect(candles).toEqual([
			{ rowIndex: 0, open: 1000, high: 1050, low: 990, close: 1040 },
			{ rowIndex: 1, open: 1040, high: 1045, low: 1001, close: 1010 },
		]);
		expect(unavailableCount).toBe(1);

		const inconsistent = extractCandles(
			{
				...PRICE_DATASET,
				rows: [{ day: { v: "2026-10-01" }, o: { v: 10 }, h: { v: 9 }, l: { v: 8 }, c: { v: 9 } }],
			},
			keys,
			() => true,
		);
		expect(inconsistent.candles).toEqual([]);
		expect(inconsistent.unavailableCount).toBe(1);
	});

	it("draws bars from the baseline with the rounded end at the value", () => {
		expect(barPath(10, 20, 100, 40)).toBe(
			"M10,100 L10,44 A4,4 0 0 1 14,40 L26,40 A4,4 0 0 1 30,44 L30,100 Z",
		);
		// Negative bar hangs below the baseline.
		expect(barPath(10, 20, 100, 130)).toBe(
			"M10,100 L10,126 A4,4 0 0 0 14,130 L26,130 A4,4 0 0 0 30,126 L30,100 Z",
		);
	});

	it("thins x labels to what fits, truncates them and keeps them inside the drawing", () => {
		const rows = Array.from({ length: 20 }, (_, index) => index);
		const xs = rows.map((index) => 64 + 28 * (index + 0.5));
		const labels = rows.map((index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
		const ticks = buildXTicks(rows, xs, labels, DEFAULT_PLOT, { maxLabels: 6, maxChars: 12 });
		// 10 characters need about 89 units each (75 + a 14-unit gap): 560 / 89 = 6 labels at most.
		expect(ticks.map((tick) => tick.label)).toEqual([
			"2026-09-01",
			"2026-09-05",
			"2026-09-09",
			"2026-09-12",
			"2026-09-16",
			"2026-09-20",
		]);
		// The last row sits at x = 610; its 75-unit label is pulled left to end at the edge (640 - 2).
		expect(ticks[5]?.x).toBe(600.5);
		expect(ticks[0]?.x).toBe(78);

		const long = buildXTicks(
			[0, 1],
			[200, 400],
			["A very long category name", null],
			DEFAULT_PLOT,
			{
				maxLabels: 10,
				maxChars: 12,
			},
		);
		expect(long).toEqual([{ x: 200, label: "A very long…" }]);
	});

	it("finds the nearest plotted position for the crosshair", () => {
		expect(nearestIndex([10, null, 50, 90], 45)).toBe(2);
		expect(nearestIndex([null, null], 45)).toBeNull();
	});
});

describe("charts with extreme values", () => {
	const EXTREMES: readonly (readonly [string, readonly number[]])[] = [
		["denormal", [5e-324, 5e-324, 5e-324]],
		["denormal range", [0, 5e-324, 1e-323]],
		["largest double", [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]],
		["full double range", [-Number.MAX_VALUE, 0, Number.MAX_VALUE]],
		["below precision", [1e20, 1e20 + 16384, 1e20 + 32768]],
	];

	function extremeContext(values: readonly number[]) {
		return {
			datasets: new Map([
				[
					"ds_extreme",
					{
						datasetId: "ds_extreme",
						title: "Extreme values",
						createdAt: "2026-10-03T00:00:00Z",
						columns: [
							{ key: "x", label: "X", kind: "number" as const, unit: "n" },
							{ key: "day", label: "Day", kind: "date" as const },
							{ key: "value", label: "Value", kind: "number" as const, unit: "u" },
							{ key: "top", label: "Top", kind: "number" as const, unit: "u" },
						],
						rows: values.map((value, index) => ({
							x: { v: value },
							day: { v: `2026-09-0${index + 1}` },
							value: { v: value },
							top: { v: value },
						})),
					},
				],
			]),
		};
	}

	/** Every geometry attribute the renderers compute must be a finite number. */
	function expectFiniteGeometry(container: HTMLElement) {
		for (const element of container.querySelectorAll("svg[role='img'] *")) {
			for (const name of ["x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "width", "height", "d"]) {
				const value = element.getAttribute(name);
				if (value !== null) expect(value).not.toMatch(/NaN|Infinity|undefined/);
			}
		}
	}

	it.each(EXTREMES)("line chart renders %s data and stays finite", (_name, values) => {
		const container = renderComponent(
			component("line-chart", {
				...VALID_PROPS["line-chart"],
				datasetRef: "ds_extreme",
				xKey: "x",
				series: [{ key: "value", label: "Value" }],
			}),
			extremeContext(values),
		);
		expect(container.querySelectorAll("circle[data-point]")).toHaveLength(3);
		expect(
			container.querySelectorAll('[data-chart-part="y-axis"] line').length,
		).toBeLessThanOrEqual(MAX_TICKS);
		expectFiniteGeometry(container);
	});

	it.each(EXTREMES)("bar chart renders %s data and stays finite", (_name, values) => {
		const container = renderComponent(
			component("bar-chart", {
				...VALID_PROPS["bar-chart"],
				datasetRef: "ds_extreme",
				categoryKey: "day",
				series: [{ key: "value", label: "Value" }],
			}),
			extremeContext(values),
		);
		expect(container.querySelectorAll("path[data-bar]")).toHaveLength(3);
		expectFiniteGeometry(container);
	});

	it.each(EXTREMES)("candlestick chart renders %s data and stays finite", (_name, values) => {
		const container = renderComponent(
			component("candlestick-chart", {
				...VALID_PROPS["candlestick-chart"],
				datasetRef: "ds_extreme",
				dateKey: "day",
				openKey: "value",
				highKey: "top",
				lowKey: "value",
				closeKey: "value",
			}),
			extremeContext(values),
		);
		expect(container.querySelectorAll("g[data-candle]")).toHaveLength(3);
		expectFiniteGeometry(container);
	});
});

describe("line-chart", () => {
	it("is a labelled image with axis titles, units and a legend", () => {
		const container = renderComponent(component("line-chart", VALID_PROPS["line-chart"]));
		const chart = screen.getByRole("img", { name: /^Line chart: Demand trajectory\./ });
		expect(chart.getAttribute("aria-label")).toContain("Installed demand (GWh) by Year");
		expect(chart.querySelector("title")?.textContent).toContain("Demand trajectory");
		expect(chart.querySelector('[data-axis-title="y"]')?.textContent).toBe(
			"Installed demand (GWh)",
		);
		expect(chart.querySelector('[data-axis-title="x"]')?.textContent).toBe("Year");
		expect(texts(container, 'ul[aria-label="Legend"] li')).toEqual(["Base case", "Bull case"]);
	});

	it("plots only numeric points and reports the rest", () => {
		const container = renderComponent(component("line-chart", VALID_PROPS["line-chart"]));
		// base: 4 numeric points; bull: 140 and 310 only (null and text are skipped).
		expect(container.querySelectorAll("circle[data-point]")).toHaveLength(6);
		expect(
			container.querySelector("[data-unavailable-count]")?.getAttribute("data-unavailable-count"),
		).toBe("2");
		// Bull has two isolated points, so no line may connect across the gap.
		const bull = container.querySelector('[data-series="Bull case"]');
		expect(bull?.querySelectorAll("path")).toHaveLength(0);
		expect(bull?.querySelectorAll("circle")).toHaveLength(2);
		const base = container.querySelector('[data-series="Base case"]');
		expect(base?.querySelectorAll("path")).toHaveLength(1);
	});

	it("never places an unavailable point on the zero line", () => {
		const container = renderComponent(component("line-chart", VALID_PROPS["line-chart"]));
		// The y axis spans 100..350, so nothing can sit at the pixel a value of 0 would map to,
		// and every marker must lie inside the plot area.
		for (const circle of container.querySelectorAll("circle[data-point]")) {
			const cy = Number(circle.getAttribute("cy"));
			expect(cy).toBeGreaterThanOrEqual(14);
			expect(cy).toBeLessThanOrEqual(262);
		}
		expect(texts(container, '[data-chart-part="y-axis"] text').slice(0, 6)).toEqual([
			"100",
			"150",
			"200",
			"250",
			"300",
			"350",
		]);
	});

	it("offers the numbers as a data table with the reasons for missing values", () => {
		const container = renderComponent(component("line-chart", VALID_PROPS["line-chart"]));
		const details = container.querySelector("details");
		expect(details?.querySelector("summary")?.textContent).toBe("Data table: Demand trajectory");
		const table = details?.querySelector("table");
		expect(table?.querySelector("caption")?.textContent).toBe(
			'Values plotted in "Demand trajectory"',
		);
		expect(texts(table ?? container, "thead th")).toEqual([
			"Year",
			"Base case (GWh)",
			"Bull case (GWh)",
		]);
		expect(table?.textContent).toContain("N/A — not yet published");
		expect(table?.textContent).toContain("N/A — estimate withheld");
	});

	it("shows an empty state rather than an empty plot", () => {
		const container = renderComponent(
			component("line-chart", { ...VALID_PROPS["line-chart"], datasetRef: "ds_empty" }),
		);
		expect(container.querySelector("svg[role='img']")).toBeNull();
		expect(container.textContent).toContain("No data — this dataset has no rows.");
	});

	it("names series columns that the dataset does not declare", () => {
		const container = renderComponent(
			component("line-chart", {
				...VALID_PROPS["line-chart"],
				series: [
					{ key: "base", label: "Base case" },
					{ key: "ghost", label: "Ghost" },
				],
			}),
		);
		expect(container.querySelector('[data-state="missing-columns"]')?.textContent).toContain(
			"ghost",
		);
		expect(
			container.querySelector("[data-unavailable-count]")?.getAttribute("data-unavailable-count"),
		).toBe("4");
	});

	it("reads out every series at the pointed position, including unavailable ones", () => {
		const container = renderComponent(component("line-chart", VALID_PROPS["line-chart"]));
		const chart = screen.getByRole("img", { name: /^Line chart/ });
		chart.getBoundingClientRect = () => new DOMRect(0, 0, 640, 320);
		// Row 1 (2027) sits at 0.375 of the plot width: 64 + 0.375 * (520 - 64) = 235.
		fireEvent.pointerMove(chart, { clientX: 236, clientY: 100 });
		expect(container.querySelector('[data-chart-part="readout"]')?.textContent).toBe(
			"Year 2027 — Base case: 150 GWh · Bull case: unavailable",
		);
		expect(container.querySelector('[data-chart-part="crosshair"]')?.getAttribute("x1")).toBe(
			"235",
		);
		fireEvent.pointerLeave(chart);
		expect(container.querySelector('[data-chart-part="crosshair"]')).toBeNull();
	});
});

describe("bar-chart", () => {
	it("draws one bar per numeric value on an axis that includes zero", () => {
		const container = renderComponent(component("bar-chart", VALID_PROPS["bar-chart"]));
		expect(screen.getByRole("img", { name: /^Bar chart: Demand by year\./ })).toBeDefined();
		expect(container.querySelectorAll("path[data-bar]")).toHaveLength(2);
		expect(texts(container, '[data-chart-part="y-axis"] text')[0]).toBe("0");
		expect(texts(container, "path[data-bar] title")).toEqual([
			"2026 — Bull case: 140 GWh",
			"2029 — Bull case: 310 GWh",
		]);
		expect(container.querySelector('[data-axis-title="y"]')?.textContent).toBe(
			"Installed demand (GWh)",
		);
	});

	it("omits the legend for a single series and shows it for several", () => {
		const single = renderComponent(component("bar-chart", VALID_PROPS["bar-chart"]));
		expect(single.querySelector('ul[aria-label="Legend"]')).toBeNull();
		cleanup();
		const multi = renderComponent(
			component("bar-chart", {
				...VALID_PROPS["bar-chart"],
				series: [
					{ key: "base", label: "Base case" },
					{ key: "bull", label: "Bull case" },
				],
			}),
		);
		expect(texts(multi, 'ul[aria-label="Legend"] li')).toEqual(["Base case", "Bull case"]);
		expect(multi.querySelectorAll("path[data-bar]")).toHaveLength(6);
	});
});

describe("candlestick-chart", () => {
	it("draws complete candles only and labels the price unit", () => {
		const container = renderComponent(
			component("candlestick-chart", VALID_PROPS["candlestick-chart"]),
		);
		const chart = screen.getByRole("img", {
			name: /^Candlestick chart: Example Electric daily price\./,
		});
		expect(chart.getAttribute("aria-label")).toContain("(JPY)");
		expect(container.querySelectorAll("g[data-candle]")).toHaveLength(2);
		expect(texts(container, "g[data-candle] title")[0]).toBe(
			"2026-09-28 — open 1,000, high 1,050, low 990, close 1,040 JPY",
		);
		expect(texts(container, 'ul[aria-label="Legend"] li')).toEqual([
			"Close at or above open",
			"Close below open",
		]);
		expect(container.querySelector("details table")?.textContent).toContain(
			"N/A — market closed early",
		);
	});

	it("distinguishes rising and falling sessions by more than position", () => {
		const container = renderComponent(
			component("candlestick-chart", VALID_PROPS["candlestick-chart"]),
		);
		const fills = [...container.querySelectorAll("g[data-candle] rect")].map((rect) =>
			rect.getAttribute("fill"),
		);
		expect(fills).toEqual(["#2a78d6", "#e34948"]);
	});
});

describe("bar plot tick text", () => {
	const scaled: Dataset = {
		datasetId: "revenue",
		title: "Revenue",
		createdAt: "2026-10-31T00:00:00Z",
		columns: [
			{ key: "year", label: "Fiscal year", kind: "text" },
			{ key: "value", label: "Revenue", kind: "number", unit: "USD millions" },
		],
		rows: [
			{ year: { v: "FY2023" }, value: { v: 383285 } },
			{ year: { v: "FY2024" }, value: { v: 391035 } },
		],
	};
	const model = () =>
		buildBarModel(guardDataset(scaled), {
			categoryKey: "year",
			series: [{ key: "value", label: "Revenue" }],
			yUnit: "USD millions",
		});
	const ticks = (root: ParentNode) =>
		texts(root, '[data-chart-part="y-axis"] text').filter(
			(text) => text !== "Revenue (USD millions)",
		);

	it("keeps the compact default (400K) for a chart that names no scale", () => {
		const { container } = render(() => (
			<BarPlot model={model()} xLabel="Fiscal year" yLabel="Revenue" yUnit="" title="Revenue" />
		));
		expect(ticks(container)).toContain("400K");
	});

	it("writes ticks with the caller's formatter, so a scaled unit is never scaled twice", () => {
		const { container } = render(() => (
			<BarPlot
				model={model()}
				xLabel="Fiscal year"
				yLabel="Revenue"
				yUnit="USD millions"
				title="Revenue"
				formatYTick={formatNumber}
			/>
		));
		expect(ticks(container)).toContain("400,000");
		expect(ticks(container).some((text) => /[KMB]$/.test(text))).toBe(false);
	});
});
