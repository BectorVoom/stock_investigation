import { isoToDayNumber } from "@research/domain";
import { describe, expect, it } from "vitest";
import { seriesColor } from "../src/charts/chartMath.ts";
import {
	buildDetailChartModel,
	buildNavigatorModel,
	type DetailSeriesInput,
	decimateToWidth,
	formatDetailTick,
	tickGranularityForSpan,
} from "../src/charts/detailChartModel.ts";

/** Consecutive daily bars starting at `startIso`, one unit of close per day. */
function dailyBars(startIso: string, closes: readonly number[]) {
	return closes.map((close, index) => {
		const day = isoToDayNumber(startIso);
		if (!day.ok) throw new Error("bad fixture date");
		const current = day.value + index;
		const observedOn = `2026-01-${String(index + 1).padStart(2, "0")}`;
		return {
			observedOn,
			day: current,
			open: close,
			high: close + 1,
			low: close - 1,
			close,
			count: 1,
		};
	});
}

function singleSeries(
	closes: readonly number[],
	startIso = "2026-01-01",
): readonly DetailSeriesInput[] {
	return [
		{
			key: "s1",
			label: "Series one",
			color: seriesColor(0),
			bars: dailyBars(startIso, closes),
		},
	];
}

function windowOf(days: number, lastDay: number): { readonly from: number; readonly to: number } {
	return { from: lastDay - days + 1, to: lastDay };
}

describe("detail chart model", () => {
	it("draws the visible bars plus one either side", () => {
		const bars = singleSeries([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
		const first = bars[0]?.bars[0];
		const last = bars[0]?.bars[9];
		if (first === undefined || last === undefined) throw new Error("fixture is empty");
		const model = buildDetailChartModel({
			series: bars,
			window: { from: first.day + 3, to: first.day + 5 },
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [],
		});
		if (model === null) throw new Error("model is null");
		expect(model.dayAt).toHaveLength(3);
		expect(model.seriesValues[0]?.values).toHaveLength(3);
		// The path covers 5 points: 3 visible plus one either side.
		const segments = (model.seriesPaths[0]?.d ?? "").split(" ").filter((part) => part !== "");
		expect(segments).toHaveLength(5);
		expect(model.seriesPaths[0]?.plottedCount).toBe(3);
		// Last-value marker sits on the last visible close.
		expect(model.lastMarkers[0]?.displayValue).toBe(15);
		expect(last.day).toBeGreaterThan(0);
	});

	it("returns null for an empty window", () => {
		const bars = singleSeries([10, 11, 12]);
		const model = buildDetailChartModel({
			series: bars,
			window: { from: 1, to: 2 },
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [],
		});
		expect(model).toBeNull();
	});

	it("decimation keeps the min and max of every pixel column", () => {
		const closes = Array.from({ length: 1500 }, (_, index) => 100 + ((index * 37) % 41) - 20);
		const bars = singleSeries(closes);
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[1499];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const model = buildDetailChartModel({
			series: bars,
			window: { from: first.day, to: lastBar.day },
			plotWidth: 200,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [],
		});
		if (model === null) throw new Error("model is null");
		const d = model.seriesPaths[0]?.d ?? "";
		const ys = d
			.split(" ")
			.map((part) => Number(part.slice(1).split(",")[1]))
			.filter((value) => Number.isFinite(value));
		// The extremes of the data reach the plot edges: the largest value
		// maps near the top (small pixel y), the smallest near the bottom.
		expect(Math.min(...ys)).toBeLessThanOrEqual(model.plot.top + 1);
		expect(Math.max(...ys)).toBeGreaterThanOrEqual(model.plot.bottom - 1);
		// Far fewer points than bars, but more than a bare per-column sample.
		expect(ys.length).toBeLessThan(1500);
		expect(ys.length).toBeGreaterThan(200);
	});

	it("decimateToWidth keeps extremes per column and passes small inputs through", () => {
		// Two pixel columns over x in [0, 2): the first column holds three
		// points, so only its min and max survive; the second keeps its one.
		const points = [
			{ x: 0, y: 5 },
			{ x: 0.4, y: 100 },
			{ x: 0.6, y: -100 },
			{ x: 1.9, y: 6 },
		];
		const kept = decimateToWidth(points, 0, 2);
		expect(kept).toEqual([
			{ x: 0.4, y: 100 },
			{ x: 0.6, y: -100 },
			{ x: 1.9, y: 6 },
		]);
		expect(decimateToWidth(points, 0, 40)).toEqual(points);
	});

	it("puts log ticks at nice values in log space", () => {
		const bars = singleSeries([8, 20, 90, 400, 1500]);
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[4];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const model = buildDetailChartModel({
			series: bars,
			window: { from: first.day, to: lastBar.day },
			plotWidth: 640,
			plotHeight: 320,
			scale: "log",
			mode: "value",
			maPeriods: [],
		});
		if (model === null) throw new Error("model is null");
		// Nice in log space: every tick is 1/2/5 × 10^n.
		for (const tick of model.yTicks) {
			const exponent = Math.floor(Math.log10(tick));
			const mantissa = tick / 10 ** exponent;
			expect([1, 2, 5, 10].some((nice) => Math.abs(mantissa - nice) < 1e-9)).toBe(true);
		}
		expect(model.yTicks[0]).toBeLessThanOrEqual(8);
		expect(model.yTicks[model.yTicks.length - 1]).toBeGreaterThanOrEqual(1500);
		// Log y is monotone: a larger value sits higher (smaller pixel y).
		expect(model.yFor(1500)).toBeLessThan(model.yFor(8));
	});

	it("renders nothing on a log scale without a positive value", () => {
		const bars = singleSeries([-4, 0, -1]);
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[2];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		expect(
			buildDetailChartModel({
				series: bars,
				window: { from: first.day, to: lastBar.day },
				plotWidth: 640,
				plotHeight: 320,
				scale: "log",
				mode: "value",
				maPeriods: [],
			}),
		).toBeNull();
	});

	it("rebases percent mode to zero at the first visible bar", () => {
		const bars = singleSeries([100, 110, 121]);
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[2];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const model = buildDetailChartModel({
			series: bars,
			window: { from: first.day, to: lastBar.day },
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "percent",
			maPeriods: [],
		});
		if (model === null) throw new Error("model is null");
		expect(model.seriesValues[0]?.values).toEqual([0, 10, 21]);
		expect(model.yTickLabels.every((label) => label.endsWith("%"))).toBe(true);
	});

	it("reports a zero percent base instead of inventing percents", () => {
		const bars = singleSeries([0, 5, 10]);
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[2];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const model = buildDetailChartModel({
			series: bars,
			window: { from: first.day, to: lastBar.day },
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "percent",
			maPeriods: [],
		});
		if (model === null) throw new Error("model is null");
		expect(model.zeroBaseKeys).toEqual(["s1"]);
		expect(model.seriesValues[0]?.values).toEqual([null, null, null]);
	});

	it("adapts x labels to the span and never overlaps them", () => {
		const spans = [7, 30, 200, 900, 2000];
		for (const span of spans) {
			const closes = Array.from({ length: span }, (_, index) => 100 + index * 0.1);
			const bars = singleSeries(closes);
			const first = bars[0]?.bars[0];
			const lastBar = bars[0]?.bars[span - 1];
			if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
			for (const width of [320, 640, 1200]) {
				const model = buildDetailChartModel({
					series: bars,
					window: windowOf(span, lastBar.day),
					plotWidth: width,
					plotHeight: 320,
					scale: "linear",
					mode: "value",
					maPeriods: [],
				});
				if (model === null) throw new Error(`model is null for span ${span}`);
				const ticks = model.xTicks;
				expect(ticks.length).toBeGreaterThanOrEqual(1);
				const ordered = [...ticks].sort((a, b) => a.x - b.x);
				for (let index = 1; index < ordered.length; index += 1) {
					const previous = ordered[index - 1];
					const current = ordered[index];
					if (previous === undefined || current === undefined) continue;
					const need = ((previous.label.length + current.label.length) / 2) * 7.5 + 8;
					expect(current.x - previous.x).toBeGreaterThanOrEqual(need);
				}
			}
			void first;
		}
	});

	it("picks day, month and year labels by span", () => {
		expect(tickGranularityForSpan(10)).toBe("day");
		expect(tickGranularityForSpan(400)).toBe("month");
		expect(tickGranularityForSpan(2000)).toBe("year");
		expect(formatDetailTick("2026-10-16", "day")).toBe("Oct 16");
		expect(formatDetailTick("2026-10-16", "month")).toBe("Oct 2026");
		expect(formatDetailTick("2026-10-16", "year")).toBe("2026");
	});

	it("finds the nearest bar by binary search", () => {
		const bars = singleSeries([10, 11, 12, 13, 14]);
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[4];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const model = buildDetailChartModel({
			series: bars,
			window: { from: first.day, to: lastBar.day },
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [],
		});
		if (model === null) throw new Error("model is null");
		expect(model.nearestBar(-1000)).toBe(0);
		expect(model.nearestBar(100000)).toBe(4);
		const middle = model.xForDay(model.dayAt[2] ?? 0);
		expect(model.nearestBar(middle)).toBe(2);
		expect(model.nearestBar(middle + 0.4)).toBe(2);
	});

	it("overlays moving averages as their own dashed paths", () => {
		const closes = Array.from({ length: 30 }, (_, index) => 100 + index);
		const bars = singleSeries(closes);
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[29];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const model = buildDetailChartModel({
			series: bars,
			window: { from: first.day + 20, to: lastBar.day },
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [20],
		});
		if (model === null) throw new Error("model is null");
		expect(model.maPaths).toHaveLength(1);
		expect(model.maPaths[0]?.label).toBe("MA 20");
		// The average runs over all held bars, so the first visible bar has one.
		expect(model.maPaths[0]?.d).not.toBe("");
	});

	it("builds the navigator window rectangle inside the overview", () => {
		const bars = singleSeries(Array.from({ length: 100 }, (_, index) => 50 + index));
		const all = bars[0]?.bars ?? [];
		const days = all.map((bar) => bar.day);
		const first = days[0];
		const lastDay = days[days.length - 1];
		if (first === undefined || lastDay === undefined) throw new Error("fixture is empty");
		const nav = buildNavigatorModel({
			days,
			values: all.map((bar) => bar.close),
			window: { from: first + 20, to: first + 39 },
			width: 600,
			height: 64,
		});
		if (nav === null) throw new Error("navigator is null");
		expect(nav.d).not.toBe("");
		expect(nav.windowLeft).toBeGreaterThanOrEqual(0);
		expect(nav.windowLeft + nav.windowWidth).toBeLessThanOrEqual(600);
		expect(nav.windowWidth).toBeGreaterThan(0);
	});
});
