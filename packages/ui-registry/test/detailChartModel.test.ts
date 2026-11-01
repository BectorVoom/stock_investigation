import { dayNumberToIso, isoToDayNumber, movingAverage } from "@research/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seriesColor } from "../src/charts/chartMath.ts";
import {
	buildDetailChartModel,
	buildNavigatorModel,
	buildNavigatorOverview,
	candleBodyWidth,
	type DetailChartModel,
	type DetailSeriesInput,
	type DetailXTick,
	decimateToWidth,
	ensureTwoBarWindow,
	isValueLabelHidden,
	layoutTagCenters,
	logScaleBlocked,
	navigatorWindowRect,
	unionBarDays,
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
			volume: null,
			fromBars: false,
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

/**
 * A tick label always names the day it sits on (fix round 5): since ADR-0057
 * that is the first bar day of its boundary's period, so a month or year
 * tick may sit after the 1st (a weekend or holiday start) but stays in the
 * month or year it names.
 */
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
	} else if (/^[A-Z][a-z]{2}$/.test(tick.label)) {
		// Month and quarter starts read as "Aug".
		expect(tick.label).toBe(monthName);
	} else if (/^[A-Z][a-z]{2} \d{4}$/.test(tick.label)) {
		// A January or first tick carries its year ("Jan 2026").
		expect(tick.label).toBe(`${monthName} ${year}`);
	} else if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(tick.label)) {
		// A day or Monday tick that opens a year carries it ("Jan 4, 2026").
		expect(tick.label).toBe(`${monthName} ${day}, ${year}`);
	} else {
		// Days and Mondays read as "Oct 16".
		expect(tick.label).toBe(`${monthName} ${day}`);
	}
}

/**
 * Shared date-axis assertions: labels distinct and in ascending x order, no
 * two labels touching, every tick on a visible bar inside the window at that
 * bar's x (modulo the edge nudge that keeps labels plotted), no two on one bar.
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
	expect(new Set(ticks.map((tick) => tick.day)).size).toBe(ticks.length);
	for (const tick of ticks) {
		expect(tick.day).toBeGreaterThanOrEqual(from);
		expect(tick.day).toBeLessThanOrEqual(to);
		expect(model.dayAt).toContain(tick.day);
		expectTickLabelMatchesDay(tick);
		const half = (tick.label.length * 7.5) / 2;
		const expected = Math.min(
			Math.max(model.xForDay(tick.day), model.plot.left + half),
			model.plot.right - half,
		);
		expect(tick.x).toBeCloseTo(expected, 9);
	}
}

function dayOf(iso: string): number {
	const day = isoToDayNumber(iso);
	if (!day.ok) throw new Error("bad fixture date");
	return day.value;
}

/** `count` monthly bars on the first of each month from `year`-`month`. */
function monthlyBars(year: number, month: number, count: number) {
	return Array.from({ length: count }, (_, index) => {
		const total = month - 1 + index;
		const iso = `${year + Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
		const day = dayOf(iso);
		const close = 100 + index;
		return {
			observedOn: iso,
			day,
			open: close,
			high: close,
			low: close,
			close,
			count: 1,
			volume: null,
			fromBars: false,
		};
	});
}

/** ISO weekday with Monday = 1 (day 0, 1970-01-01, was a Thursday). */
function weekdayOf(day: number): number {
	return ((((day + 3) % 7) + 7) % 7) + 1;
}

/**
 * Date-axis ticks of a window holding a bar on each end and on every weekday
 * between (a trading calendar: ticks sit on bars since ADR-0057).
 */
function ticksFor(from: number, to: number, width: number): readonly DetailXTick[] {
	const bar = (day: number, close: number) => {
		const iso = dayNumberToIso(day);
		if (!iso.ok) throw new Error("bad fixture day");
		return {
			observedOn: iso.value,
			day,
			open: close,
			high: close,
			low: close,
			close,
			count: 1,
			volume: null,
			fromBars: false,
		};
	};
	const model = buildDetailChartModel({
		series: [
			{
				key: "t",
				label: "Ticks",
				color: seriesColor(0),
				bars: Array.from({ length: to - from + 1 }, (_, index) => from + index)
					.filter((day) => day === from || day === to || weekdayOf(day) <= 5)
					.map((day, index) => bar(day, 1 + (index % 7))),
			},
		],
		window: { from, to },
		plotWidth: width,
		plotHeight: 320,
		scale: "linear",
		mode: "value",
		maPeriods: [],
	});
	if (model === null) throw new Error("model is null");
	return model.xTicks;
}

/**
 * A window crossing a calendar year names the year on its first tick and on
 * the first tick of every later year (fix round 6: never only "May 18").
 */
function expectYearContext(ticks: readonly DetailXTick[], from: number, to: number): void {
	const yearOf = (day: number): number => {
		const iso = dayNumberToIso(day);
		if (!iso.ok) throw new Error("bad tick day");
		return Number(iso.value.slice(0, 4));
	};
	if (yearOf(from) === yearOf(to)) return;
	expect(ticks.length).toBeGreaterThan(0);
	let previous: number | null = null;
	for (const tick of [...ticks].sort((a, b) => a.day - b.day)) {
		const year = yearOf(tick.day);
		if (previous === null || year !== previous) {
			expect(tick.label, `tick on day ${tick.day} names ${year}`).toContain(String(year));
		}
		previous = year;
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
		const widened = ensureTwoBarWindow({ from: saturday, to: sunday }, unionBarDays([held]), {
			from: all[0]?.day ?? 0,
			to: monday.day,
		});
		// Friday through Monday: the two real bars around the weekend.
		expect(widened).toEqual({ from: friday.day, to: monday.day });
		// A window already holding two bars is untouched.
		const untouched = ensureTwoBarWindow(
			{ from: friday.day - 4, to: friday.day },
			unionBarDays([held]),
			{
				from: all[0]?.day ?? 0,
				to: monday.day,
			},
		);
		expect(untouched).toEqual({ from: friday.day - 4, to: friday.day });
		// Data shorter than two bars yields the whole extent.
		const single = ensureTwoBarWindow(
			{ from: saturday, to: sunday },
			unionBarDays([[all[0] ?? monday]]),
			{
				from: saturday,
				to: sunday,
			},
		);
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
		// At least one tick hides behind the close pair (the defect: the
		// "15.41" text sat on the "15.4" tick). The view applies exactly this
		// predicate; the model keeps no second copy of it (fix round 6).
		const tagYs = model.lastValueTags.map((tag) => tag.y);
		expect(model.yTicks.some((tick) => isValueLabelHidden(model.yFor(tick), tagYs, null))).toBe(
			true,
		);
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

	it("names a year on every multi-year axis, with 2/5/10-year steps for decades (fix round 6)", () => {
		// 800 monthly observations, 1960-02-01 … 2026-09-01, at Max.
		const monthly = monthlyBars(1960, 2, 800);
		const firstBar = monthly[0];
		const lastBar = monthly[monthly.length - 1];
		if (firstBar === undefined || lastBar === undefined) throw new Error("fixture is empty");
		expect(lastBar.observedOn).toBe("2026-09-01");
		for (const width of [358, 700, 1248, 1920]) {
			const model = buildDetailChartModel({
				series: [{ key: "m", label: "Monthly", color: seriesColor(0), bars: monthly }],
				window: { from: firstBar.day, to: lastBar.day },
				plotWidth: width,
				plotHeight: 320,
				scale: "linear",
				mode: "value",
				maPeriods: [],
			});
			if (model === null) throw new Error("model is null");
			// Never the single year-less "May 18" of the old fallback.
			expectBoundaryTicks(model, firstBar.day, lastBar.day, 2);
			expectYearContext(model.xTicks, firstBar.day, lastBar.day);
			for (const tick of model.xTicks) expect(tick.label).toMatch(/^\d{4}$/);
		}
		// Ten years of days at phone width: year ticks, never "Oct 18".
		const tenYears = ticksFor(dayOf("2016-10-17"), dayOf("2026-10-16"), 358);
		expect(tenYears.length).toBeGreaterThanOrEqual(2);
		expectYearContext(tenYears, dayOf("2016-10-17"), dayOf("2026-10-16"));
		// A 1Y window at 2500 px keeps fine ticks but names both years.
		const oneYear = ticksFor(dayOf("2025-10-17"), dayOf("2026-10-16"), 2500);
		expect(oneYear.length).toBeGreaterThanOrEqual(12);
		expectYearContext(oneYear, dayOf("2025-10-17"), dayOf("2026-10-16"));
		expect(oneYear.some((tick) => tick.label.includes("2025"))).toBe(true);
		expect(oneYear.some((tick) => tick.label.includes("2026"))).toBe(true);
		// A window inside one year stays glanceable: no year on day ticks.
		const oneMonth = ticksFor(dayOf("2026-09-16"), dayOf("2026-10-16"), 1200);
		for (const tick of oneMonth) expect(tick.label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
	});

	it("names the year on the first tick and at every year change for arbitrary windows", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -3000, max: 25000 }),
				fc.integer({ min: 1, max: 30000 }),
				fc.integer({ min: 120, max: 2600 }),
				(from, span, width) => {
					const to = from + span;
					const ticks = ticksFor(from, to, width);
					expect(ticks.length).toBeGreaterThanOrEqual(1);
					expectYearContext(ticks, from, to);
					for (const tick of ticks) {
						expect(tick.day).toBeGreaterThanOrEqual(from);
						expect(tick.day).toBeLessThanOrEqual(to);
						expectTickLabelMatchesDay(tick);
					}
					expect(new Set(ticks.map((tick) => tick.label)).size).toBe(ticks.length);
				},
			),
		);
	});

	it("rebases only the visible moving-average slice on a window change (fix round 6)", () => {
		const closes = Array.from({ length: 20_000 }, (_, index) => 100 + Math.sin(index / 50) * 10);
		const series = singleSeries(closes, "1970-01-01");
		const bars = series[0]?.bars ?? [];
		const averaged = movingAverage(closes, 20);
		if (!averaged.ok) throw new Error("moving average failed");
		const reads = { count: 0 };
		const counted = new Proxy([...averaged.value], {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
				return Reflect.get(target, key, receiver);
			},
		});
		const visibleFrom = bars[10_000]?.day ?? 0;
		const model = buildDetailChartModel({
			series,
			window: { from: visibleFrom, to: visibleFrom + 29 },
			plotWidth: 1200,
			plotHeight: 480,
			scale: "linear",
			mode: "percent",
			maPeriods: [],
			maOverlays: [
				{
					seriesKey: "s1",
					color: seriesColor(0),
					period: 20,
					label: "MA 20",
					days: bars.map((bar) => bar.day),
					values: counted,
				},
			],
		});
		if (model === null) throw new Error("model is null");
		expect(model.maPaths[0]?.d).not.toBe("");
		// Thirty visible bars plus one either side — never all 20,000.
		expect(reads.count).toBeLessThanOrEqual(32);
	});

	it("widens windows against a memoized union by binary search (fix round 6)", () => {
		const a = dailyBars("2026-01-01", [1, 2, 3, 4]);
		const b = dailyBars("2026-01-03", [5, 6, 7, 8]);
		const union = unionBarDays([a, b]);
		const first = a[0]?.day ?? 0;
		expect(union).toEqual([0, 1, 2, 3, 4, 5].map((offset) => first + offset));
		const reads = { count: 0 };
		const days = Array.from({ length: 80_000 }, (_, index) => index * 2);
		const counted = new Proxy(days, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
				return Reflect.get(target, key, receiver);
			},
		});
		const widened = ensureTwoBarWindow({ from: 1001, to: 1001 }, counted, {
			from: 0,
			to: 159_998,
		});
		expect(widened).toEqual({ from: 1000, to: 1002 });
		// O(log n) reads, never a collect-and-sort over every bar.
		expect(reads.count).toBeLessThan(80);
	});

	it("splits the navigator into an overview line and an O(1) window rectangle", () => {
		const bars = singleSeries(Array.from({ length: 100 }, (_, index) => 50 + index))[0]?.bars ?? [];
		const days = bars.map((bar) => bar.day);
		const values = bars.map((bar) => bar.close);
		const overview = buildNavigatorOverview({ days, values, width: 600, height: 56 });
		if (overview === null) throw new Error("overview is null");
		const first = days[0] ?? 0;
		for (const window of [
			{ from: first + 20, to: first + 39 },
			{ from: first, to: first + 99 },
			{ from: first + 98, to: first + 99 },
		]) {
			const composed = buildNavigatorModel({ days, values, window, width: 600, height: 56 });
			const rect = navigatorWindowRect(overview, window);
			expect(rect.windowLeft).toBe(composed?.windowLeft);
			expect(rect.windowWidth).toBe(composed?.windowWidth);
			expect(overview.d).toBe(composed?.d);
		}
	});

	it("exports no dead tick helpers and keeps no unread tick flags (fix round 6)", async () => {
		const registry: Record<string, unknown> = await import("../src/index.ts");
		expect("tickGranularityForSpan" in registry).toBe(false);
		expect("formatDetailTick" in registry).toBe(false);
		const model = buildDetailChartModel({
			series: singleSeries([1, 2, 3]),
			window: { from: dayOf("2026-01-01"), to: dayOf("2026-01-03") },
			plotWidth: 640,
			plotHeight: 320,
			scale: "linear",
			mode: "value",
			maPeriods: [],
		});
		if (model === null) throw new Error("model is null");
		expect("yTickHidden" in model).toBe(false);
	});
});

/** One row of a candle fixture: open, high, low, close, volume (and whether it is the provider's bar). */
type CandleRow = readonly [number, number, number, number, number | null, boolean?];

/** Consecutive daily provider bars starting at `startIso` (ADR-0056). */
function candleBars(startIso: string, rows: readonly CandleRow[]) {
	const start = isoToDayNumber(startIso);
	if (!start.ok) throw new Error("bad fixture date");
	return rows.map(([open, high, low, close, volume, fromBars = true], index) => {
		const day = start.value + index;
		const iso = dayNumberToIso(day);
		if (!iso.ok) throw new Error("bad fixture day");
		return { observedOn: iso.value, day, open, high, low, close, count: 1, volume, fromBars };
	});
}

function candleSeries(rows: readonly CandleRow[]): readonly DetailSeriesInput[] {
	return [
		{ key: "c1", label: "Candles", color: seriesColor(0), bars: candleBars("2026-03-02", rows) },
	];
}

/** Subpaths in a path string (each starts with M). */
function subpaths(d: string): number {
	return (d.match(/M/g) ?? []).length;
}

const CANDLE_ROWS: readonly CandleRow[] = [
	[100, 106, 98, 104, 1_000_000], // up
	[104, 105, 96, 97, 2_500_000], // down
	[97, 99, 95, 97, 500_000], // unchanged
	[97, 112, 97, 110, 3_000_000], // up, highest high
	[110, 111, 90, 92, null], // down, lowest low, no volume
];

function candleModel(
	overrides: Partial<Parameters<typeof buildDetailChartModel>[0]> = {},
): DetailChartModel {
	const series = overrides.series ?? candleSeries(CANDLE_ROWS);
	const first = series[0]?.bars[0]?.day ?? 0;
	const model = buildDetailChartModel({
		series,
		window: { from: first, to: first + 4 },
		plotWidth: 600,
		plotHeight: 320,
		scale: "linear",
		mode: "value",
		maPeriods: [],
		chartType: "candlestick",
		...overrides,
	});
	if (model === null) throw new Error("no model");
	return model;
}

describe("candlesticks and volume (ADR-0056)", () => {
	it("gives a close-only bar no open, high or low for the readout and the table", () => {
		const model = candleModel({
			series: candleSeries([
				[100, 106, 98, 104, 1_000_000],
				[104, 104, 104, 104, null, false],
			]),
		});
		const bars = model.barValues;
		if (bars === null) throw new Error("no bar values");
		expect([bars.open[0], bars.high[0], bars.low[0], bars.close[0]]).toEqual([100, 106, 98, 104]);
		expect([bars.open[1], bars.high[1], bars.low[1], bars.close[1]]).toEqual([
			null,
			null,
			null,
			104,
		]);
		expect(model.notFromBarsCount).toBe(1);
	});

	it("draws no volume panel when every visible volume is zero", () => {
		const model = candleModel({
			series: candleSeries([
				[100, 106, 98, 104, 0],
				[104, 105, 96, 97, 0],
			]),
		});
		expect(model.volume).toBeNull();
		expect(model.candles).not.toBeNull();
	});

	it("draws candles as five paths, one subpath per bar part, and no close line", () => {
		const model = candleModel();
		expect(model.chartType).toBe("candlestick");
		const candles = model.candles;
		if (candles === null) throw new Error("no candles");
		expect(candles.count).toBe(5);
		expect(subpaths(candles.upBodies)).toBe(2);
		expect(subpaths(candles.downBodies)).toBe(2);
		expect(subpaths(candles.upWicks)).toBe(2);
		expect(subpaths(candles.downWicks)).toBe(2);
		// The unchanged bar: its wick plus a horizontal tick.
		expect(subpaths(candles.unchanged)).toBe(2);
		expect(model.seriesPaths[0]?.d).toBe("");
	});

	it("spans the visible highs and lows, not just the closes", () => {
		const model = candleModel();
		const low = model.yTicks[0] ?? Number.NaN;
		const high = model.yTicks[model.yTicks.length - 1] ?? Number.NaN;
		expect(low).toBeLessThanOrEqual(90);
		expect(high).toBeGreaterThanOrEqual(112);
		// A line over the same bars spans the closes only.
		const line = candleModel({ chartType: "line" });
		expect(line.yTicks[line.yTicks.length - 1] ?? Number.NaN).toBeLessThan(112);
		expect(line.candles).toBeNull();
		expect(line.seriesPaths[0]?.d).not.toBe("");
	});

	it("sizes bodies at 70 % of the spacing, odd, at most 11 px, and wick-only below 3 px", () => {
		expect(candleBodyWidth(10)).toBe(7);
		expect(candleBodyWidth(40)).toBe(11);
		expect(candleBodyWidth(5)).toBe(3);
		expect(candleBodyWidth(3)).toBe(1);
		expect(candleBodyWidth(2.9)).toBe(0);
		fc.assert(
			fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), (spacing) => {
				const width = candleBodyWidth(spacing);
				if (spacing < 3) return width === 0;
				return width >= 1 && width <= 11 && width % 2 === 1 && width <= spacing * 0.7 + 1;
			}),
		);
		// Five bars a day apart over a 528 px plot: the 11 px cap.
		expect(candleModel().candles?.bodyWidth).toBe(11);
	});

	it("keeps the first and last bodies whole inside the plot, with the time scale inset", () => {
		const model = candleModel();
		const body = model.candles?.bodyWidth ?? 0;
		expect(body).toBeGreaterThan(0);
		expect(model.xRange.left).toBeGreaterThanOrEqual(model.plot.left + body / 2);
		expect(model.xRange.right).toBeLessThanOrEqual(model.plot.right - body / 2);
		const lefts = [...(model.candles?.upBodies ?? "").matchAll(/M([\d.]+),/g)].map((match) =>
			Number(match[1]),
		);
		for (const left of lefts) {
			expect(left).toBeGreaterThanOrEqual(model.plot.left);
			expect(left + body).toBeLessThanOrEqual(model.plot.right);
		}
		// Lines alone keep the whole plot width.
		const line = candleModel({
			chartType: "line",
			series: candleSeries(CANDLE_ROWS.map(([o, h, l, c]): CandleRow => [o, h, l, c, null])),
		});
		expect(line.xRange).toEqual({ left: line.plot.left, right: line.plot.right });
	});

	it("keeps a body at least 1 px high", () => {
		const model = candleModel({
			series: candleSeries([
				[100, 101, 99, 100.0001, 10],
				[100, 101, 99, 99.9999, 10],
			]),
		});
		expect(model.candles?.upBodies).toMatch(/v1\.0h/);
		expect(model.candles?.downBodies).toMatch(/v1\.0h/);
	});

	it("draws only wicks, merged per pixel column, when bars are denser than 3 px", () => {
		const rows: CandleRow[] = Array.from({ length: 2000 }, (_, index) => {
			const base = 100 + Math.sin(index / 7) * 10;
			return [base, base + 2, base - 2, base + (index % 2 === 0 ? 1 : -1), 1000 + index];
		});
		const series = candleSeries(rows);
		const first = series[0]?.bars[0]?.day ?? 0;
		const model = candleModel({ series, window: { from: first, to: first + 1999 } });
		const candles = model.candles;
		if (candles === null) throw new Error("no candles");
		expect(candles.bodyWidth).toBe(0);
		expect(candles.upBodies).toBe("");
		expect(candles.downBodies).toBe("");
		const plotWidth = model.plot.right - model.plot.left;
		expect(candles.count).toBeLessThanOrEqual(Math.floor(plotWidth));
		expect(subpaths(candles.upWicks) + subpaths(candles.downWicks)).toBeGreaterThan(0);
	});

	it("rebases open, high, low and close by the line's base in percent mode", () => {
		const model = candleModel({ mode: "percent" });
		// Base is the first visible close (104): the highest high 112 is +7.69 %,
		// the lowest low 90 is −13.46 %.
		const low = model.yTicks[0] ?? Number.NaN;
		const high = model.yTicks[model.yTicks.length - 1] ?? Number.NaN;
		expect(low).toBeLessThanOrEqual(((90 - 104) / 104) * 100);
		expect(high).toBeGreaterThanOrEqual(((112 - 104) / 104) * 100);
		expect(model.candles?.count).toBe(5);
		// Readouts keep the raw bars.
		expect(model.barValues?.high[3]).toBe(112);
	});

	it("works on a log scale", () => {
		const model = candleModel({ scale: "log" });
		expect(model.candles?.count).toBe(5);
		const low = model.yTicks[0] ?? Number.NaN;
		expect(low).toBeGreaterThan(0);
		expect(low).toBeLessThanOrEqual(90);
	});

	it("draws lines, no candles and no volume for more than one series", () => {
		const bars = candleBars("2026-03-02", CANDLE_ROWS);
		const model = candleModel({
			series: [
				{ key: "a", label: "A", color: seriesColor(0), bars },
				{ key: "b", label: "B", color: seriesColor(1), bars },
			],
		});
		expect(model.chartType).toBe("line");
		expect(model.candles).toBeNull();
		expect(model.volume).toBeNull();
		expect(model.barValues).toBeNull();
		expect(model.axisBottom).toBe(model.plot.bottom);
	});

	it("puts a volume panel under the price plot with a scale from zero", () => {
		const model = candleModel();
		const volume = model.volume;
		if (volume === null) throw new Error("no volume panel");
		expect(volume.max).toBe(3_000_000);
		expect(volume.ticks[0]).toBe(0);
		expect(volume.ticks[volume.ticks.length - 1] ?? 0).toBeGreaterThanOrEqual(3_000_000);
		expect(volume.area.bottom).toBe(model.axisBottom);
		expect(volume.area.top).toBeGreaterThan(model.plot.bottom);
		// About a fifth of the drawable height.
		const drawable = model.axisBottom - model.plot.top;
		const share = (volume.area.bottom - volume.area.top) / drawable;
		expect(share).toBeGreaterThan(0.15);
		expect(share).toBeLessThan(0.25);
		expect(volume.yFor(0)).toBe(volume.area.bottom);
		// Two up bars, one down, one unchanged; the day without a volume has none.
		expect(subpaths(volume.up)).toBe(2);
		expect(subpaths(volume.down)).toBe(1);
		expect(subpaths(volume.unchanged)).toBe(1);
		// Also in line mode.
		expect(candleModel({ chartType: "line" }).volume).not.toBeNull();
	});

	it("has no volume panel when no visible bar has a volume", () => {
		const model = candleModel({
			series: candleSeries(CANDLE_ROWS.map(([o, h, l, c]): CandleRow => [o, h, l, c, null])),
		});
		expect(model.volume).toBeNull();
		expect(model.axisBottom).toBe(model.plot.bottom);
	});

	it("exposes the raw bars aligned with the days and counts bars that are not the provider's", () => {
		const rows: CandleRow[] = CANDLE_ROWS.map(
			([o, h, l, c, v], index): CandleRow => [o, h, l, c, v, index !== 1 && index !== 4],
		);
		const model = candleModel({ series: candleSeries(rows) });
		const bars = model.barValues;
		if (bars === null) throw new Error("no bar values");
		// Bars that are not the provider's have no known open/high/low.
		expect(bars.open).toEqual([100, null, 97, 97, null]);
		expect(bars.high).toEqual([106, null, 99, 112, null]);
		expect(bars.low).toEqual([98, null, 95, 97, null]);
		expect(bars.close).toEqual([104, 97, 97, 110, 92]);
		expect(bars.volume).toEqual([1_000_000, 2_500_000, 500_000, 3_000_000, null]);
		expect(bars.fromBars).toEqual([true, false, true, true, false]);
		expect(model.notFromBarsCount).toBe(2);
	});
});

/** Provider bars on the weekdays (Mon–Fri) from `fromIso` to `toIso`, closes rising. */
function weekdayBars(fromIso: string, toIso: string): DetailSeriesInput["bars"][number][] {
	const bars: DetailSeriesInput["bars"][number][] = [];
	for (let day = dayOf(fromIso); day <= dayOf(toIso); day += 1) {
		if (weekdayOf(day) > 5) continue;
		const iso = dayNumberToIso(day);
		if (!iso.ok) throw new Error("bad fixture day");
		const close = 100 + bars.length;
		bars.push({
			observedOn: iso.value,
			day,
			open: close - 1,
			high: close + 1,
			low: close - 2,
			close,
			count: 1,
			volume: 1000 + bars.length,
			fromBars: true,
		});
	}
	return bars;
}

/** Left edges of the bodies in a path string (each body starts with `M<left>,`). */
function bodyLefts(d: string): number[] {
	return [...d.matchAll(/M([\d.]+),/g)].map((match) => Number(match[1]));
}

describe("trading-day axis (ADR-0057)", () => {
	// 2026-10-05 (Mon) … 2026-10-30 (Fri): four trading weeks, 20 bars.
	const bars = weekdayBars("2026-10-05", "2026-10-30");
	const axisDays = unionBarDays([bars]);
	const series: readonly DetailSeriesInput[] = [
		{ key: "w", label: "Weekdays", color: seriesColor(0), bars },
	];
	const window = { from: dayOf("2026-10-05"), to: dayOf("2026-10-30") };
	const build = (
		overrides: Partial<Parameters<typeof buildDetailChartModel>[0]> = {},
	): DetailChartModel => {
		const model = buildDetailChartModel({
			series,
			window,
			plotWidth: 900,
			plotHeight: 360,
			scale: "linear",
			mode: "value",
			maPeriods: [],
			axisDays,
			...overrides,
		});
		if (model === null) throw new Error("no model");
		return model;
	};

	it("puts Friday and the next Monday one bar spacing apart, in Line and Candlestick", () => {
		for (const chartType of ["line", "candlestick"] as const) {
			const model = build({ chartType });
			const step = model.xForDay(dayOf("2026-10-07")) - model.xForDay(dayOf("2026-10-06"));
			expect(step).toBeGreaterThan(0);
			const weekend = model.xForDay(dayOf("2026-10-12")) - model.xForDay(dayOf("2026-10-09"));
			expect(weekend).toBeCloseTo(step, 9);
			// 20 bars fill the range: 19 spacings.
			expect(model.positionSpan).toBeCloseTo(19, 9);
			expect(step).toBeCloseTo((model.xRange.right - model.xRange.left) / 19, 9);
			// A Saturday lies a third of the way from Friday to Monday.
			const saturday = model.xForDay(dayOf("2026-10-10")) - model.xForDay(dayOf("2026-10-09"));
			expect(saturday).toBeCloseTo(step / 3, 9);
		}
	});

	it("draws every candle and volume bar one spacing after the previous", () => {
		const model = build({ chartType: "candlestick" });
		const candles = model.candles;
		const volume = model.volume;
		if (candles === null || volume === null) throw new Error("no candles or volume");
		// Rising closes: every body is an up body.
		const lefts = bodyLefts(candles.upBodies);
		expect(lefts).toHaveLength(20);
		const spacing = (model.xRange.right - model.xRange.left) / 19;
		for (let index = 1; index < lefts.length; index += 1) {
			// Bodies sit on whole-pixel wick centres: within a pixel of the spacing.
			expect(Math.abs((lefts[index] ?? 0) - (lefts[index - 1] ?? 0) - spacing)).toBeLessThanOrEqual(
				1,
			);
		}
		expect(candles.bodyWidth).toBe(candleBodyWidth(spacing));
		expect(bodyLefts(volume.up)).toHaveLength(20);
	});

	it("maps pixels back to days through the axis", () => {
		const model = build();
		for (const day of axisDays) expect(model.dayForX(model.xForDay(day))).toBeCloseTo(day, 9);
		expect(model.dayForX(model.xRange.left)).toBeCloseTo(window.from, 9);
		expect(model.dayForX(model.xRange.right)).toBeCloseTo(window.to, 9);
		// The window opens on a Monday: the next Monday is five bars (one bar
		// spacing after Friday), not seven days, to the right.
		const spacing = (model.xRange.right - model.xRange.left) / model.positionSpan;
		const monday = window.from;
		expect(model.xForDay(monday + 7) - model.xForDay(monday)).toBeCloseTo(5 * spacing, 9);
	});

	it("gives a day one series lacks its own slot when several series are shown", () => {
		// The second series also trades Saturday 2026-10-10.
		const saturday = dayOf("2026-10-10");
		const extra = weekdayBars("2026-10-05", "2026-10-30");
		const template = extra[0];
		if (template === undefined) throw new Error("fixture is empty");
		extra.push({ ...template, observedOn: "2026-10-10", day: saturday });
		extra.sort((a, b) => a.day - b.day);
		const both: readonly DetailSeriesInput[] = [
			...series,
			{ key: "x", label: "Extra", color: seriesColor(1), bars: extra },
		];
		const model = build({ series: both, axisDays: unionBarDays([bars, extra]) });
		const step = model.xForDay(dayOf("2026-10-07")) - model.xForDay(dayOf("2026-10-06"));
		expect(model.xForDay(saturday) - model.xForDay(dayOf("2026-10-09"))).toBeCloseTo(step, 9);
		expect(model.xForDay(dayOf("2026-10-12")) - model.xForDay(saturday)).toBeCloseTo(step, 9);
		expect(model.positionSpan).toBeCloseTo(20, 9);
	});

	it("draws the same positions inside the window without the axis days", () => {
		const held = weekdayBars("2026-06-01", "2026-12-31");
		const heldSeries: readonly DetailSeriesInput[] = [
			{ key: "w", label: "Weekdays", color: seriesColor(0), bars: held },
		];
		const given = build({ series: heldSeries, axisDays: unionBarDays([held]) });
		const local = build({ series: heldSeries, axisDays: undefined });
		for (const day of given.dayAt) expect(local.xForDay(day)).toBeCloseTo(given.xForDay(day), 9);
		expect(local.xTicks).toEqual(given.xTicks);
	});

	it("puts date ticks on bars: none on a weekend, a month start on its first trading day", () => {
		// Daily ticks on a wide plot: one per bar, never on Saturday or Sunday.
		const wide = build({ plotWidth: 2400 });
		expect(wide.xTicks.length).toBeGreaterThan(5);
		for (const tick of wide.xTicks) {
			expect(weekdayOf(tick.day)).toBeLessThanOrEqual(5);
			expect(tick.x).toBeCloseTo(
				Math.min(
					Math.max(wide.xForDay(tick.day), wide.plot.left + (tick.label.length * 7.5) / 2),
					wide.plot.right - (tick.label.length * 7.5) / 2,
				),
				9,
			);
		}
		expectBoundaryTicks(wide, window.from, window.to, 2);
		// 2026-08-01 is a Saturday: the "Aug" tick sits on Monday 2026-08-03.
		const months = weekdayBars("2026-05-01", "2026-10-30");
		const monthly = build({
			series: [{ key: "w", label: "Weekdays", color: seriesColor(0), bars: months }],
			window: { from: dayOf("2026-05-01"), to: dayOf("2026-10-30") },
			axisDays: unionBarDays([months]),
			plotWidth: 700,
		});
		const august = monthly.xTicks.find((tick) => tick.label === "Aug");
		expect(august?.day).toBe(dayOf("2026-08-03"));
		expectBoundaryTicks(monthly, dayOf("2026-05-01"), dayOf("2026-10-30"), 2);
	});

	it("drops a month tick when its month has no bar in the window", () => {
		// No bars in August: the axis jumps from July to September.
		const gapped = weekdayBars("2026-05-01", "2026-10-30").filter(
			(bar) => !bar.observedOn.startsWith("2026-08"),
		);
		const model = build({
			series: [{ key: "g", label: "Gapped", color: seriesColor(0), bars: gapped }],
			window: { from: dayOf("2026-05-01"), to: dayOf("2026-10-30") },
			axisDays: unionBarDays([gapped]),
			plotWidth: 700,
		});
		expect(model.xTicks.map((tick) => tick.label)).not.toContain("Aug");
		expect(model.xTicks.map((tick) => tick.label)).toContain("Sep");
		// The closed-up gap: the last July bar and the first September bar are one spacing apart.
		const step = model.xForDay(dayOf("2026-07-30")) - model.xForDay(dayOf("2026-07-29"));
		expect(model.xForDay(dayOf("2026-09-01")) - model.xForDay(dayOf("2026-07-31"))).toBeCloseTo(
			step,
			9,
		);
	});

	it("reads only the visible slice of a long series on a window change", () => {
		const long = weekdayBars("1950-01-02", "2026-10-30");
		expect(long.length).toBeGreaterThan(19_000);
		const reads = { count: 0 };
		const counted = new Proxy([...long], {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
				return Reflect.get(target, key, receiver);
			},
		});
		const model = build({
			series: [{ key: "l", label: "Long", color: seriesColor(0), bars: counted }],
			axisDays: unionBarDays([long]),
			chartType: "candlestick",
		});
		expect(model.candles?.count).toBe(20);
		// Binary searches plus the visible bars a few times over, never the whole history.
		expect(reads.count).toBeLessThan(400);
	});
});
