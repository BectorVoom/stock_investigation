import { dayNumberToIso, isoToDayNumber, movingAverage } from "@research/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seriesColor } from "../src/charts/chartMath.ts";
import {
	buildDetailChartModel,
	buildNavigatorModel,
	type DetailChartModel,
	type DetailSeriesInput,
	type DetailXTick,
	decimateToWidth,
	ensureTwoBarWindow,
	formatDetailTick,
	isValueLabelHidden,
	layoutTagCenters,
	logScaleBlocked,
	tickGranularityForSpan,
	unionOverview,
	VALUE_LABEL_HEIGHT,
} from "../src/charts/detailChartModel.ts";

/** Consecutive daily bars starting at `startIso`, one close per day (real calendar dates). */
function dailyBars(startIso: string, closes: readonly number[]) {
	const start = isoToDayNumber(startIso);
	if (!start.ok) throw new Error("bad fixture date");
	return closes.map((close, index) => {
		const day = start.value + index;
		const iso = dayNumberToIso(day);
		if (!iso.ok) throw new Error("bad fixture day");
		return {
			observedOn: iso.value,
			day,
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

const BOUNDARY_MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/** A tick label always names its own boundary day (fix round 5). */
function expectTickLabelMatchesDay(tick: DetailXTick): void {
	const iso = dayNumberToIso(tick.day);
	if (!iso.ok) throw new Error("bad tick day");
	const year = Number(iso.value.slice(0, 4));
	const month = Number(iso.value.slice(5, 7));
	const day = Number(iso.value.slice(8, 10));
	const monthName = BOUNDARY_MONTHS[month - 1] ?? String(month);
	if (/^\d{4}$/.test(tick.label)) {
		// Year starts read as "2026".
		expect(tick.label).toBe(String(year));
		expect(month).toBe(1);
		expect(day).toBe(1);
	} else if (/^[A-Z][a-z]{2}$/.test(tick.label)) {
		// Month and quarter starts read as "Aug".
		expect(tick.label).toBe(monthName);
		expect(day).toBe(1);
	} else if (/^[A-Z][a-z]{2} \d{4}$/.test(tick.label)) {
		// A January or first tick carries its year ("Jan 2026").
		expect(tick.label).toBe(`${monthName} ${year}`);
		expect(day).toBe(1);
	} else {
		// Days and Mondays read as "Oct 16".
		expect(tick.label).toBe(`${monthName} ${day}`);
	}
}

/**
 * Shared date-axis assertions: labels distinct and in ascending x order, no
 * two labels touching, every tick on a calendar boundary inside the window at
 * its time-proportional x (modulo the edge nudge that keeps labels plotted).
 */
function expectBoundaryTicks(
	model: DetailChartModel,
	from: number,
	to: number,
	minTicks: number,
): void {
	const ticks = model.xTicks;
	expect(ticks.length).toBeGreaterThanOrEqual(minTicks);
	expect(new Set(ticks.map((tick) => tick.label)).size).toBe(ticks.length);
	for (let index = 1; index < ticks.length; index += 1) {
		const previous = ticks[index - 1];
		const current = ticks[index];
		if (previous === undefined || current === undefined) continue;
		expect(current.x).toBeGreaterThan(previous.x);
		const need = ((previous.label.length + current.label.length) / 2) * 7.5 + 8;
		expect(current.x - previous.x).toBeGreaterThanOrEqual(need);
	}
	for (const tick of ticks) {
		expect(tick.day).toBeGreaterThanOrEqual(from);
		expect(tick.day).toBeLessThanOrEqual(to);
		expectTickLabelMatchesDay(tick);
		const half = (tick.label.length * 7.5) / 2;
		const expected = Math.min(
			Math.max(model.xForDay(tick.day), model.plot.left + half),
			model.plot.right - half,
		);
		expect(tick.x).toBeCloseTo(expected, 9);
	}
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

	it("puts distinct boundary ticks on 1W–5Y spans at phone and desktop widths", () => {
		const last = isoToDayNumber("2026-10-16");
		if (!last.ok) throw new Error("bad fixture date");
		const lastDay = last.value;
		// 1W, 1M, 3M, 1Y and 5Y in days, each ending on real held closes.
		for (const span of [7, 30, 92, 365, 1826]) {
			const firstDay = lastDay - span + 1;
			const firstIso = dayNumberToIso(firstDay);
			if (!firstIso.ok) throw new Error("bad fixture day");
			const bars = singleSeries(
				Array.from({ length: span }, (_, index) => 100 + index * 0.1),
				firstIso.value,
			);
			for (const width of [390, 1440]) {
				const model = buildDetailChartModel({
					series: bars,
					window: { from: firstDay, to: lastDay },
					plotWidth: width,
					plotHeight: 320,
					scale: "linear",
					mode: "value",
					maPeriods: [],
				});
				if (model === null) throw new Error(`model is null for span ${span}`);
				// Every span here holds enough boundaries for at least two ticks.
				expectBoundaryTicks(model, firstDay, lastDay, 2);
			}
		}
	});

	it("keeps boundary ticks distinct, ordered and non-overlapping for arbitrary windows and widths", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 15000, max: 25000 }),
				fc.integer({ min: 2, max: 2500 }),
				fc.integer({ min: 200, max: 1600 }),
				(from, span, width) => {
					const to = from + span;
					const firstIso = dayNumberToIso(from);
					if (!firstIso.ok) throw new Error("bad fixture day");
					const bars = singleSeries(
						Array.from({ length: span + 1 }, (_, index) => 100 + ((index * 37) % 41) - 20),
						firstIso.value,
					);
					const model = buildDetailChartModel({
						series: bars,
						window: { from, to },
						plotWidth: width,
						plotHeight: 320,
						scale: "linear",
						mode: "value",
						maPeriods: [],
					});
					if (model === null) throw new Error("model is null");
					expectBoundaryTicks(model, from, to, 1);
				},
			),
		);
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

	it("decimates visible points without the offscreen neighbours", () => {
		// A hidden 1000 close before the window must not displace the visible
		// 200 spike when decimation kicks in: the old code folded the
		// neighbour into the boundary pixel column and drew a flat 100 line.
		const closes = [1000, 100, 200, ...Array.from({ length: 47 }, () => 100)];
		const bars = singleSeries(closes);
		const all = bars[0]?.bars ?? [];
		const hidden = all[0];
		const firstVisible = all[1];
		const lastBar = all[all.length - 1];
		if (hidden === undefined || firstVisible === undefined || lastBar === undefined) {
			throw new Error("fixture is empty");
		}
		const model = buildDetailChartModel({
			series: bars,
			window: { from: firstVisible.day, to: lastBar.day },
			plotWidth: 20,
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
		// The 200 spike survives decimation at its plotted height.
		expect(ys.some((y) => Math.abs(y - model.yFor(200)) < 1e-9)).toBe(true);
		// The hidden neighbour still connects the line to the plot edge.
		const firstX = Number(d.slice(1).split(",")[0]);
		expect(firstX).toBeLessThan(model.plot.left);
		expect(model.seriesPaths[0]?.plottedCount).toBe(49);
	});

	it("honours precomputed moving-average overlays without recomputing", () => {
		const closes = Array.from({ length: 30 }, (_, index) => 100 + index);
		const bars = singleSeries(closes);
		const all = bars[0]?.bars ?? [];
		const first = all[0];
		const lastBar = all[all.length - 1];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const window = { from: first.day + 20, to: lastBar.day };
		const expected = buildDetailChartModel({
			series: bars,
			window,
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [20],
		});
		if (expected === null) throw new Error("model is null");
		const averaged = movingAverage(closes, 20);
		if (!averaged.ok) throw new Error("bad fixture average");
		const cached = buildDetailChartModel({
			series: bars,
			window,
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [],
			maOverlays: [
				{
					seriesKey: "s1",
					color: seriesColor(0),
					period: 20,
					label: "MA 20",
					days: all.map((bar) => bar.day),
					values: averaged.value,
				},
			],
		});
		if (cached === null) throw new Error("model is null");
		// The cached overlay draws exactly the computed average's path.
		expect(cached.maPaths).toHaveLength(1);
		expect(cached.maPaths[0]?.d).toBe(expected.maPaths[0]?.d);
		// A sentinel overlay proves the input is honoured, not recomputed.
		const sentinel = buildDetailChartModel({
			series: bars,
			window,
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [],
			maOverlays: [
				{
					seriesKey: "s1",
					color: seriesColor(0),
					period: 20,
					label: "MA 20",
					days: all.map((bar) => bar.day),
					values: all.map(() => 119.5),
				},
			],
		});
		if (sentinel === null) throw new Error("model is null");
		expect(sentinel.maPaths).toHaveLength(1);
		expect(sentinel.maPaths[0]?.d).not.toBe(expected.maPaths[0]?.d);
		const flatYs = (sentinel.maPaths[0]?.d ?? "")
			.split(" ")
			.map((part) => Number(part.slice(1).split(",")[1]))
			.filter((value) => Number.isFinite(value));
		expect(flatYs.length).toBeGreaterThan(0);
		for (const y of flatYs) expect(Math.abs(y - sentinel.yFor(119.5)) < 1e-9).toBe(true);
	});

	it("exposes raw closes alongside rebased display values", () => {
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
		expect(model.mode).toBe("percent");
		expect(model.seriesValues[0]?.values).toEqual([0, 10, 21]);
		expect(model.rawValues[0]?.values).toEqual([100, 110, 121]);
	});

	it("blocks log for non-positive effective values, including percent mode", () => {
		const positive = singleSeries([100, 110, 121]);
		const mixed = singleSeries([0, 100, 110]);
		const first = positive[0]?.bars[0];
		const lastBar = positive[0]?.bars[2];
		if (first === undefined || lastBar === undefined) throw new Error("fixture is empty");
		const window = { from: first.day, to: lastBar.day };
		expect(logScaleBlocked({ series: positive, window, mode: "value" })).toBe(false);
		expect(logScaleBlocked({ series: mixed, window, mode: "value" })).toBe(true);
		// Percent mode rebases to 0 % at the first visible bar, so Log never fits.
		expect(logScaleBlocked({ series: positive, window, mode: "percent" })).toBe(true);
		expect(
			logScaleBlocked({
				series: positive,
				window: { from: first.day, to: first.day + 1 },
				mode: "percent",
			}),
		).toBe(true);
		// No visible bars blocks nothing (the frame states the empty window).
		expect(logScaleBlocked({ series: positive, window: { from: 1, to: 2 }, mode: "value" })).toBe(
			false,
		);
	});

	it("widens a bar-less window to its neighbouring bars", () => {
		// Weekday bars only: a Saturday–Sunday window holds no observations.
		const bars = singleSeries([10, 11, 12, 13, 14], "2026-09-28");
		const all = bars[0]?.bars ?? [];
		const friday = all[4];
		if (friday === undefined) throw new Error("fixture is empty");
		const monday = { ...friday, observedOn: "2026-10-05", day: friday.day + 3 };
		const held = [...all, monday];
		const saturday = friday.day + 1;
		const sunday = friday.day + 2;
		const widened = ensureTwoBarWindow({ from: saturday, to: sunday }, [held], {
			from: all[0]?.day ?? 0,
			to: monday.day,
		});
		// Friday through Monday: the two real bars around the weekend.
		expect(widened).toEqual({ from: friday.day, to: monday.day });
		// A window already holding two bars is untouched.
		const untouched = ensureTwoBarWindow({ from: friday.day - 4, to: friday.day }, [held], {
			from: all[0]?.day ?? 0,
			to: monday.day,
		});
		expect(untouched).toEqual({ from: friday.day - 4, to: friday.day });
		// Data shorter than two bars yields the whole extent.
		const single = ensureTwoBarWindow({ from: saturday, to: sunday }, [[all[0] ?? monday]], {
			from: saturday,
			to: sunday,
		});
		expect(single).toEqual({ from: saturday, to: sunday });
	});

	it("covers the full held extent in the navigator overview", () => {
		// A dense series plus an older short one: the union starts at the
		// older date, with the longest series' closes aligned onto it.
		const dense = singleSeries([50, 51, 52, 53], "2026-01-05");
		const older = singleSeries([9], "2026-01-01");
		const overview = unionOverview([dense[0]?.bars ?? [], older[0]?.bars ?? []]);
		const firstDense = dense[0]?.bars[0];
		if (firstDense === undefined) throw new Error("fixture is empty");
		expect(overview.days[0]).toBeLessThan(firstDense.day);
		expect(overview.days).toContain(firstDense.day);
		expect(overview.values).toHaveLength(overview.days.length);
		// The older day has no dense close: a gap, not an invented value.
		expect(overview.values[0]).toBeNaN();
		expect(overview.values.slice(1)).toEqual([50, 51, 52, 53]);
	});

	it("draws last values as non-overlapping tags and hides the tick behind a tag", () => {
		// Two series closing almost together: the tags must nudge apart to
		// a full label height while the tick between them hides.
		const bars: DetailSeriesInput[] = [
			{
				key: "s1",
				label: "One",
				color: seriesColor(0),
				bars: dailyBars("2026-01-01", [100, 100.01]),
			},
			{
				key: "s2",
				label: "Two",
				color: seriesColor(1),
				bars: dailyBars("2026-01-01", [100.02, 100.03]),
			},
		];
		const first = bars[0]?.bars[0];
		const lastBar = bars[0]?.bars[1];
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
		expect(model.lastValueTags).toHaveLength(2);
		const [upper, lower] = [...model.lastValueTags].sort((a, b) => a.y - b.y);
		if (upper === undefined || lower === undefined) throw new Error("tags are empty");
		// Tags keep one label height apart and stay inside the plot.
		expect(lower.y - upper.y).toBeGreaterThanOrEqual(VALUE_LABEL_HEIGHT);
		for (const tag of model.lastValueTags) {
			expect(tag.y).toBeGreaterThanOrEqual(model.plot.top + VALUE_LABEL_HEIGHT / 2);
			expect(tag.y).toBeLessThanOrEqual(model.plot.bottom - VALUE_LABEL_HEIGHT / 2);
		}
		// A tick label on top of a tag hides; one a full height away shows.
		expect(isValueLabelHidden(upper.y, [upper.y], null)).toBe(true);
		expect(isValueLabelHidden(upper.y + VALUE_LABEL_HEIGHT, [upper.y], null)).toBe(false);
		expect(isValueLabelHidden(upper.y + VALUE_LABEL_HEIGHT - 0.5, [upper.y], null)).toBe(true);
		// The crosshair value label hides ticks too while it is shown.
		expect(isValueLabelHidden(100, [0], 100 + VALUE_LABEL_HEIGHT - 0.5)).toBe(true);
		expect(isValueLabelHidden(100, [0], 100 + VALUE_LABEL_HEIGHT)).toBe(false);
		// The model's own flags agree with the predicate for the tag-only case.
		model.yTicks.forEach((tick, index) => {
			expect(model.yTickHidden[index]).toBe(
				isValueLabelHidden(
					model.yFor(tick),
					model.lastValueTags.map((tag) => tag.y),
					null,
				),
			);
		});
		// At least one tick hides behind the close pair (the defect: the
		// "15.41" text sat on the "15.4" tick).
		expect(model.yTickHidden.some((hidden) => hidden)).toBe(true);
	});

	it("keeps tag centres separated and inside the plot", () => {
		const plot = { left: 8, right: 576, top: 8, bottom: 294 };
		const placed = layoutTagCenters([100, 105, 200], plot);
		const first = placed[0];
		const second = placed[1];
		const third = placed[2];
		if (first === undefined || second === undefined || third === undefined) {
			throw new Error("layout is empty");
		}
		expect(second - first).toBeGreaterThanOrEqual(VALUE_LABEL_HEIGHT);
		expect(third - second).toBeGreaterThanOrEqual(VALUE_LABEL_HEIGHT);
		// Clamping holds a stack at the edges instead of spilling out.
		const clamped = layoutTagCenters([8, 8, 8, 8], plot);
		for (const y of clamped) {
			expect(y).toBeGreaterThanOrEqual(plot.top + VALUE_LABEL_HEIGHT / 2);
			expect(y).toBeLessThanOrEqual(plot.bottom - VALUE_LABEL_HEIGHT / 2);
		}
	});
});
