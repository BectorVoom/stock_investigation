import { describe, expect, it } from "vitest";
import {
	autoInterval,
	type ChartBar,
	type ChartPoint,
	clampWindow,
	dayNumberToIso,
	isoToDayNumber,
	movingAverage,
	panWindow,
	presetWindow,
	rebasePercent,
	resampleSeries,
	visibleSlice,
	windowStats,
	zoomWindow,
} from "../../src/market/chartWindow.ts";
import { expectErr, expectOk } from "../support/result.ts";

const point = (observedOn: string, value: number): ChartPoint => ({ observedOn, value });

function day(iso: string): number {
	return expectOk(isoToDayNumber(iso));
}

function iso(dayNumber: number): string {
	return expectOk(dayNumberToIso(dayNumber));
}

/*
 * Hard gate 5: every expected number below is hand-worked with the arithmetic
 * shown. None is derived by calling the implementation.
 */
describe("isoToDayNumber / dayNumberToIso", () => {
	it("converts the epoch and round-trips", () => {
		// 1970-01-01 is day 0 by definition.
		expect(expectOk(isoToDayNumber("1970-01-01"))).toBe(0);
		// 2024-12-30: 54 years + leap days; checked against `date -d`.
		expect(expectOk(isoToDayNumber("2024-12-30"))).toBe(20087);
		expect(expectOk(dayNumberToIso(20087))).toBe("2024-12-30");
		expect(expectOk(dayNumberToIso(0))).toBe("1970-01-01");
	});

	it("rejects malformed and impossible dates", () => {
		expect(expectErr(isoToDayNumber("not-a-date"))).toBe("INVALID_DATE");
		expect(expectErr(isoToDayNumber("2026-02-30"))).toBe("INVALID_DATE");
		expect(expectErr(isoToDayNumber("2026-13-01"))).toBe("INVALID_DATE");
		expect(expectErr(dayNumberToIso(1.5))).toBe("INVALID_DAY");
		expect(expectErr(dayNumberToIso(Number.NaN))).toBe("INVALID_DAY");
	});

	it("supports years 0000–0099 without the Date.UTC remap", () => {
		// Finding #9: Date.UTC(99, …) means 1999; the civil helper repairs
		// it, so 0099-12-31 parses and round-trips the day before 0100-01-01.
		const eve = expectOk(isoToDayNumber("0099-12-31"));
		expect(expectOk(dayNumberToIso(eve))).toBe("0099-12-31");
		expect(eve).toBe(day("0100-01-01") - 1);
	});
});

describe("resampleSeries", () => {
	it("is the identity for daily bars", () => {
		const bars = resampleSeries(
			[point("2026-10-14", 3), point("2026-10-15", 7), point("2026-10-16", 5)],
			"daily",
		);
		expect(bars).toHaveLength(3);
		expect(bars[0]).toEqual({
			observedOn: "2026-10-14",
			day: day("2026-10-14"),
			open: 3,
			high: 3,
			low: 3,
			close: 3,
			count: 1,
		});
		expect(bars[2]?.close).toBe(5);
	});

	it("buckets an ISO week across a year end by its Monday", () => {
		// 2024-12-30 is a Monday (ISO week 1 of 2025) but buckets with its own
		// Monday, not with January: Dec 28–29 belong to the week of Mon Dec 23.
		const bars = resampleSeries(
			[
				point("2024-12-28", 100),
				point("2024-12-29", 101),
				point("2024-12-30", 102),
				point("2024-12-31", 103),
				point("2025-01-01", 104),
			],
			"weekly",
		);
		expect(bars).toHaveLength(2);
		// First bucket: open 100, close 101, high 101, low 100, count 2,
		// observedOn the bucket's last date.
		expect(bars[0]).toEqual({
			observedOn: "2024-12-29",
			day: day("2024-12-29"),
			open: 100,
			high: 101,
			low: 100,
			close: 101,
			count: 2,
		});
		// Second bucket: 102, 103, 104 → open 102, close 104, high 104,
		// low 102, count 3.
		expect(bars[1]).toEqual({
			observedOn: "2025-01-01",
			day: day("2025-01-01"),
			open: 102,
			high: 104,
			low: 102,
			close: 104,
			count: 3,
		});
	});

	it("splits quarters and years at their boundaries", () => {
		const quarterly = resampleSeries(
			[point("2024-12-31", 10), point("2025-01-01", 20)],
			"quarterly",
		);
		// Q4 2024 vs Q1 2025: one bar each.
		expect(quarterly.map((bar) => bar.observedOn)).toEqual(["2024-12-31", "2025-01-01"]);
		const yearly = resampleSeries(
			[point("2024-06-01", 10), point("2024-12-31", 30), point("2025-01-01", 20)],
			"yearly",
		);
		// 2024: open 10, close 30, high 30, low 10, count 2; 2025: single.
		expect(yearly).toHaveLength(2);
		expect(yearly[0]).toEqual({
			observedOn: "2024-12-31",
			day: day("2024-12-31"),
			open: 10,
			high: 30,
			low: 10,
			close: 30,
			count: 2,
		});
		expect(yearly[1]?.open).toBe(20);
	});

	it("splits months at month ends", () => {
		const bars = resampleSeries(
			[point("2026-01-31", 5), point("2026-02-01", 8), point("2026-02-28", 6)],
			"monthly",
		);
		expect(bars.map((bar) => bar.observedOn)).toEqual(["2026-01-31", "2026-02-28"]);
		// February: open 8, close 6, high 8, low 6, count 2.
		expect(bars[1]).toEqual({
			observedOn: "2026-02-28",
			day: day("2026-02-28"),
			open: 8,
			high: 8,
			low: 6,
			close: 6,
			count: 2,
		});
	});

	it("sorts ascending input and drops invalid points", () => {
		const bars = resampleSeries(
			[point("2026-10-16", 5), point("bogus", 9), point("2026-10-14", 3)],
			"daily",
		);
		expect(bars.map((bar) => bar.observedOn)).toEqual(["2026-10-14", "2026-10-16"]);
		expect(resampleSeries([], "monthly")).toEqual([]);
	});
});

describe("autoInterval", () => {
	it("picks the finest allowed interval that fits maxBars", () => {
		// 400 days daily-native: daily needs ceil(400×5/7) = 286 > 100;
		// weekly needs ceil(400/7) = 58 ≤ 100.
		expect(autoInterval(400, "daily", 100)).toBe("weekly");
		// Same span monthly-native: monthly needs ceil(400/30.44) = 14 ≤ 100,
		// and daily/weekly are finer than the source.
		expect(autoInterval(400, "monthly", 100)).toBe("monthly");
		// Annual-native data can only show yearly.
		expect(autoInterval(400, "annual", 10_000)).toBe("yearly");
		// Unknown frequency behaves like daily.
		expect(autoInterval(10, "unknown", 100)).toBe("daily");
	});

	it("falls back to yearly when nothing fits", () => {
		// Even yearly needs ceil(400/365.25) = 2 > 1.
		expect(autoInterval(400, "daily", 1)).toBe("yearly");
		expect(autoInterval(0, "daily", 10)).toBe("daily");
	});
});

describe("presetWindow", () => {
	const first = day("2020-01-01");
	const last = day("2024-03-31");

	it("counts months/years back with month-end clamping", () => {
		// 1M before 2024-03-31 clamps February to 2024-02-29 (leap year).
		const oneMonth = expectOk(presetWindow("1m", first, last));
		expect(iso(oneMonth.from)).toBe("2024-02-29");
		expect(oneMonth.to).toBe(last);
		// 1Y before 2024-03-31 is 2023-03-31.
		expect(iso(expectOk(presetWindow("1y", first, last)).from)).toBe("2023-03-31");
		// 1W is 7 days: 2024-03-24.
		expect(iso(expectOk(presetWindow("1w", first, last)).from)).toBe("2024-03-24");
	});

	it("starts YTD on 1 January and returns everything for max", () => {
		expect(iso(expectOk(presetWindow("ytd", first, last)).from)).toBe("2024-01-01");
		expect(expectOk(presetWindow("max", first, last))).toEqual({ from: first, to: last });
	});

	it("clamps short histories to the first observation", () => {
		// 5Y before 2024-03-31 is 2019-03-31, before the first held day.
		const window = expectOk(presetWindow("5y", first, last));
		expect(window).toEqual({ from: first, to: last });
	});

	it("rejects non-finite day coordinates instead of propagating NaN", () => {
		// Finding #5: an apparently usable window must never come back.
		expect(expectErr(presetWindow("1m", Number.NaN, last))).toBe("NON_FINITE_DAY");
		expect(expectErr(presetWindow("max", first, Number.POSITIVE_INFINITY))).toBe("NON_FINITE_DAY");
	});

	it("supports years 0000–0099 and clamps presets crossing that boundary", () => {
		// Finding #9: Date.UTC remaps 00–99 onto 1900+; the civil helper
		// repairs it, so 0099-12-31 parses and a 1m preset over January 0100
		// clamps to the first held day (January 1).
		expect(expectOk(isoToDayNumber("0099-12-31"))).toBe(expectOk(isoToDayNumber("0100-01-01")) - 1);
		const lo = day("0100-01-01");
		const hi = day("0100-01-31");
		expect(iso(expectOk(presetWindow("1m", lo, hi)).from)).toBe("0100-01-01");
	});
});

describe("clampWindow / panWindow / zoomWindow", () => {
	const extent = { from: day("2024-01-01"), to: day("2024-12-31") };

	it("keeps windows inside the extent with from ≤ to", () => {
		const window = expectOk(clampWindow({ from: extent.to + 10, to: extent.to + 20 }, extent, 2));
		expect(window.from).toBeGreaterThanOrEqual(extent.from);
		expect(window.to).toBeLessThanOrEqual(extent.to);
		expect(window.from).toBeLessThanOrEqual(window.to);
		// A span wider than the extent yields the whole extent.
		expect(expectOk(clampWindow({ from: 0, to: 100_000 }, extent, 0))).toEqual(extent);
	});

	it("pans by the delta while keeping the span", () => {
		const window = { from: day("2024-06-01"), to: day("2024-06-11") };
		const panned = expectOk(panWindow(window, 5, extent));
		expect(panned).toEqual({ from: window.from + 5, to: window.to + 5 });
		// Panning past the end stops at the edge with the span intact.
		const stuck = expectOk(panWindow(window, 10_000, extent));
		expect(stuck.to).toBe(extent.to);
		expect(stuck.to - stuck.from).toBe(10);
	});

	it("zooms around the anchor and keeps it inside", () => {
		const window = { from: day("2024-06-01"), to: day("2024-06-11") };
		const anchor = day("2024-06-06");
		// Factor 2 about Jun 6 (5 days in, span 10): new span 20, from Jun 1.
		const out = expectOk(zoomWindow(window, anchor, 2, extent, 2));
		expect(out.to - out.from).toBe(20);
		expect(out.from).toBeLessThanOrEqual(anchor);
		expect(anchor).toBeLessThanOrEqual(out.to);
		// Factor 0.5 halves the span to 5, still holding the anchor.
		const into = expectOk(zoomWindow(window, anchor, 0.5, extent, 2));
		expect(into.to - into.from).toBe(5);
		expect(into.from).toBeLessThanOrEqual(anchor);
		expect(anchor).toBeLessThanOrEqual(into.to);
		// A useless factor falls back to clamping the input with minSpan.
		expect(expectOk(zoomWindow(window, anchor, 0, extent, 2))).toEqual(
			expectOk(clampWindow(window, extent, 2)),
		);
	});

	it("falls back to clampWindow with minSpan for an invalid factor", () => {
		// Finding #3: {from:5,to:5} zoomed by 0 with minSpan 4 clamps to a
		// 4-day window {from:5,to:9}, not the degenerate input; Lean models
		// this branch as clampWindow.
		expect(expectOk(zoomWindow({ from: 5, to: 5 }, 5, 0, { from: 0, to: 10 }, 4))).toEqual({
			from: 5,
			to: 9,
		});
		// The anchor guarantee only holds for a valid positive finite
		// factor: an invalid factor keeps the clamped window, which may sit
		// away from a far-away anchor.
		expect(expectOk(zoomWindow({ from: 0, to: 2 }, 8, 0, { from: 0, to: 10 }, 2))).toEqual({
			from: 0,
			to: 2,
		});
	});

	it("saturates an overflowing zoom-out to the whole extent", () => {
		// Finding #4: span 6 × 1e308 overflows to Infinity; the target is
		// the full extent, not the minimum span.
		expect(expectOk(zoomWindow({ from: 2, to: 8 }, 5, 1e308, { from: 0, to: 10 }, 2))).toEqual({
			from: 0,
			to: 10,
		});
	});

	it("rejects non-finite coordinates instead of propagating NaN", () => {
		// Finding #5: every NaN coordinate fails closed with NON_FINITE_DAY.
		expect(expectErr(clampWindow({ from: Number.NaN, to: 5 }, { from: 0, to: 10 }, 2))).toBe(
			"NON_FINITE_DAY",
		);
		expect(expectErr(panWindow({ from: 0, to: 5 }, 1, { from: 0, to: Number.NaN }))).toBe(
			"NON_FINITE_DAY",
		);
		expect(expectErr(zoomWindow({ from: 0, to: 5 }, Number.NaN, 2, { from: 0, to: 10 }, 0))).toBe(
			"NON_FINITE_DAY",
		);
		expect(expectErr(zoomWindow({ from: 0, to: 5 }, 2, 2, { from: Number.NaN, to: 10 }, 0))).toBe(
			"NON_FINITE_DAY",
		);
	});
});

describe("visibleSlice", () => {
	const bars: ChartBar[] = ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01"].map(
		(observedOn, index) => ({
			observedOn,
			day: day(observedOn),
			open: index,
			high: index,
			low: index,
			close: index,
			count: 1,
		}),
	);

	it("returns the in-window indices", () => {
		const slice = visibleSlice(bars, { from: day("2024-01-15"), to: day("2024-03-15") });
		expect(slice).toEqual({ start: 1, end: 3 });
		expect(bars.slice(slice.start, slice.end).map((bar) => bar.observedOn)).toEqual([
			"2024-02-01",
			"2024-03-01",
		]);
		expect(visibleSlice(bars, { from: day("2024-01-01"), to: day("2024-12-31") })).toEqual({
			start: 0,
			end: 4,
		});
		expect(visibleSlice([], { from: 0, to: 10 })).toEqual({ start: 0, end: 0 });
	});
});

describe("movingAverage", () => {
	it("averages a running window with a null prefix", () => {
		// (10+20+30)/3 = 20; (20+30+40)/3 = 30.
		const average = expectOk(movingAverage([10, 20, 30, 40], 3));
		expect(average).toEqual([null, null, 20, 30]);
		expect(expectOk(movingAverage([5, 7], 1))).toEqual([5, 7]);
		// A period longer than the input is all null.
		expect(expectOk(movingAverage([5, 7], 5))).toEqual([null, null]);
	});

	it("rejects a bad period and non-finite values", () => {
		expect(expectErr(movingAverage([1, 2], 0))).toBe("INVALID_PERIOD");
		expect(expectErr(movingAverage([1, 2], 1.5))).toBe("INVALID_PERIOD");
		expect(expectErr(movingAverage([1, Number.NaN], 1))).toBe("NON_FINITE");
	});

	it("keeps small values next to a huge one without cancellation", () => {
		// Finding #1: a plain running sum rounds 1e16 + 1 back to 1e16, so
		// subtracting the head leaves 0; the compensated scaled accumulator
		// recovers the trailing ones. Windows: [1e16,1] → 5e15, then 1, 1.
		expect(expectOk(movingAverage([1e16, 1, 1, 1], 2))).toEqual([null, 5e15, 1, 1]);
	});

	it("never overflows a finite window to Infinity", () => {
		// Finding #1: [1e308,1e308,1,1] period 2 ends at the [1,1] window.
		// Windows: 1e308, (1e308+1)/2 = 5e307, then 1 — every entry finite.
		const average = expectOk(movingAverage([1e308, 1e308, 1, 1], 2));
		expect(average).toHaveLength(4);
		expect(average[0]).toBeNull();
		expect(average[1]).toBe(1e308);
		expect(average[2]).toBe(5e307);
		expect(average[3]).toBe(1);
		for (const entry of average) {
			if (entry !== null) expect(Number.isFinite(entry)).toBe(true);
		}
	});
});

describe("windowStats", () => {
	it("computes hand-checked statistics", () => {
		// Closes 10, 12, 9, 13: open 10, close 13, change 3, pct 30,
		// high 13, low 9, average (10+12+9+13)/4 = 11.
		// Drawdown: peaks 10, 12, 12, 13 → falls 0, 0, (12−9)/12×100 = 25, 0.
		const bars: ChartBar[] = [
			["2024-01-01", 10],
			["2024-01-02", 12],
			["2024-01-03", 9],
			["2024-01-04", 13],
		].map(([observedOn, close]) => ({
			observedOn: observedOn as string,
			day: day(observedOn as string),
			open: close as number,
			high: close as number,
			low: close as number,
			close: close as number,
			count: 1,
		}));
		const stats = expectOk(windowStats(bars));
		expect(stats.open).toBe(10);
		expect(stats.close).toBe(13);
		expect(stats.change).toBe(3);
		expect(stats.percentChange).toBeCloseTo(30, 10);
		expect(stats.high).toEqual({ value: 13, observedOn: "2024-01-04", day: day("2024-01-04") });
		expect(stats.low).toEqual({ value: 9, observedOn: "2024-01-03", day: day("2024-01-03") });
		expect(stats.average).toBe(11);
		expect(stats.maxDrawdown).toBeCloseTo(25, 10);
		expect(stats.bars).toBe(4);
	});

	it("nulls percents on a zero base and drawdown on a non-positive peak", () => {
		const zeroBase: ChartBar[] = [
			{
				observedOn: "2024-01-01",
				day: day("2024-01-01"),
				open: 0,
				high: 0,
				low: 0,
				close: 0,
				count: 1,
			},
			{
				observedOn: "2024-01-02",
				day: day("2024-01-02"),
				open: 0,
				high: 5,
				low: 0,
				close: 5,
				count: 1,
			},
		];
		// Change 5 − 0 = 5 with a null percent; the first running peak is 0.
		const stats = expectOk(windowStats(zeroBase));
		expect(stats.change).toBe(5);
		expect(stats.percentChange).toBeNull();
		expect(stats.maxDrawdown).toBeNull();
	});

	it("rejects empty input", () => {
		expect(expectErr(windowStats([]))).toBe("EMPTY_WINDOW");
	});

	it("fails closed when a derived percent or drawdown overflows", () => {
		// Finding #2: subnormal bases inflate finite moves to Infinity.
		const tiny = (close: number): ChartBar => ({
			observedOn: "2024-01-01",
			day: day("2024-01-01"),
			open: close,
			high: close,
			low: close,
			close,
			count: 1,
		});
		// Percent (1 − 1e-310)/1e-310 × 100 overflows.
		expect(
			expectErr(
				windowStats([
					{ ...tiny(1e-310), observedOn: "2024-01-01", day: day("2024-01-01") },
					{ ...tiny(1), observedOn: "2024-01-02", day: day("2024-01-02") },
				]),
			),
		).toBe("NON_FINITE");
		// Drawdown off peak 1e-310 against close −1 overflows.
		expect(
			expectErr(
				windowStats([
					{ ...tiny(1e-310), observedOn: "2024-01-01", day: day("2024-01-01") },
					{ ...tiny(-1), observedOn: "2024-01-02", day: day("2024-01-02") },
					{ ...tiny(1e-310), observedOn: "2024-01-03", day: day("2024-01-03") },
				]),
			),
		).toBe("NON_FINITE");
	});
});

describe("rebasePercent", () => {
	it("rebases to 0 % at the base and nulls a zero base", () => {
		// (110−100)/100×100 = 10; (90−100)/100×100 = −10.
		expect(rebasePercent([100, 110, 90], 100)).toEqual([0, 10, -10]);
		expect(rebasePercent([100, 110], 0)).toEqual([null, null]);
	});

	it("scales before subtracting so opposite extremes stay finite", () => {
		// Finding #6: (1e308 − (−1e308))/1e308 × 100 = 200; the naive
		// numerator overflows to Infinity and wrongly yields null.
		expect(rebasePercent([1e308], -1e308)).toEqual([200]);
	});
});

describe("resampleSeries duplicate dates", () => {
	it("keeps both daily points, so days are nondecreasing rather than strict", () => {
		// Finding #10: two points on 2024-01-01 intentionally stay two bars.
		const bars = resampleSeries(
			[
				{ observedOn: "2024-01-01", value: 3 },
				{ observedOn: "2024-01-01", value: 7 },
			],
			"daily",
		);
		expect(bars.map((bar) => bar.day)).toEqual([day("2024-01-01"), day("2024-01-01")]);
		expect(bars[0]?.close).toBe(3);
		expect(bars[1]?.close).toBe(7);
	});
});
