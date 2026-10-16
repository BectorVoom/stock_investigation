import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	autoInterval,
	type ChartBar,
	type ChartInterval,
	type ChartNativeFrequency,
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
import { expectOk } from "../support/result.ts";

const isoDate = fc
	.tuple(
		fc.integer({ min: 2010, max: 2026 }),
		fc.integer({ min: 1, max: 12 }),
		fc.integer({ min: 1, max: 28 }),
	)
	.map(
		([year, month, day]) =>
			`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
	);

const chartPoint = fc.record({
	observedOn: isoDate,
	value: fc
		.double({ min: -1000, max: 1000, noNaN: true })
		.filter((value) => Number.isFinite(value)),
});

const interval = fc.constantFrom(
	"daily",
	"weekly",
	"monthly",
	"quarterly",
	"yearly",
) as fc.Arbitrary<ChartInterval>;

function dayOf(iso: string): number {
	return expectOk(isoToDayNumber(iso));
}

function makeBars(days: readonly number[]): ChartBar[] {
	return days.map((day, index) => ({
		observedOn: expectOk(dayNumberToIso(day)),
		day,
		open: index,
		high: index,
		low: index,
		close: index,
		count: 1,
	}));
}

describe("chartWindow properties", () => {
	it("resampleSeries output days strictly ascend with at most one bar per point", () => {
		fc.assert(
			fc.property(fc.array(chartPoint, { maxLength: 30 }), interval, (points, candidate) => {
				const bars = resampleSeries(points, candidate);
				expect(bars.length).toBeLessThanOrEqual(points.length);
				if (points.length === 0) expect(bars).toEqual([]);
				for (let index = 1; index < bars.length; index += 1) {
					const previous = bars[index - 1]?.day as number;
					const current = bars[index]?.day as number;
					// Bucketed bars merge shared dates, so their days ascend
					// strictly; daily is the identity, so shared dates stay.
					if (candidate === "daily") expect(current).toBeGreaterThanOrEqual(previous);
					else expect(current).toBeGreaterThan(previous);
				}
				for (const bar of bars) {
					// Open/close are bucket members, so the extremes cover them.
					expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
					expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
					expect(bar.count).toBeGreaterThanOrEqual(1);
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("resampleSeries daily is one bar per valid point", () => {
		fc.assert(
			fc.property(fc.array(chartPoint, { maxLength: 30 }), (points) => {
				const bars = resampleSeries(points, "daily");
				expect(bars).toHaveLength(points.length);
				// Identity up to the ascending-day sort (stable on ties).
				const ordered = points
					.map((point, index) => ({ point, index }))
					.sort((a, b) =>
						a.point.observedOn === b.point.observedOn
							? a.index - b.index
							: a.point.observedOn < b.point.observedOn
								? -1
								: 1,
					);
				bars.forEach((bar, index) => {
					expect(bar.observedOn).toBe(ordered[index]?.point.observedOn);
					expect(bar.open).toBe(ordered[index]?.point.value);
					expect(bar.close).toBe(ordered[index]?.point.value);
					expect(bar.count).toBe(1);
				});
			}),
			{ numRuns: 300 },
		);
	});

	it("resampleSeries close is the bucket's last value", () => {
		fc.assert(
			fc.property(
				fc.array(chartPoint, { minLength: 1, maxLength: 30 }),
				fc.constantFrom("weekly", "monthly", "quarterly", "yearly") as fc.Arbitrary<ChartInterval>,
				(points, candidate) => {
					const bars = resampleSeries(points, candidate);
					const last = bars[bars.length - 1];
					const newest = [...points].sort((a, b) => (a.observedOn < b.observedOn ? 1 : -1))[0];
					expect(last?.close).toBe(newest?.value);
					expect(last?.observedOn).toBe(newest?.observedOn);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("visibleSlice equals a filter over the bars", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 19_000, max: 21_000 }), { maxLength: 40 }),
				fc.integer({ min: 19_000, max: 21_000 }),
				fc.integer({ min: 19_000, max: 21_000 }),
				(days, from, to) => {
					const bars = makeBars([...new Set(days)].sort((a, b) => a - b));
					const slice = visibleSlice(bars, { from, to });
					const lo = Math.min(from, to);
					const hi = Math.max(from, to);
					expect(bars.slice(slice.start, slice.end)).toEqual(
						bars.filter((bar) => bar.day >= lo && bar.day <= hi),
					);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("movingAverage equals a naive implementation", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { maxLength: 40 }),
				fc.integer({ min: 1, max: 10 }),
				(values, period) => {
					const finite = values.filter((value) => Number.isFinite(value));
					const actual = expectOk(movingAverage(finite, period));
					expect(actual).toHaveLength(finite.length);
					actual.forEach((entry, index) => {
						if (index < period - 1) {
							expect(entry).toBeNull();
						} else {
							const window = finite.slice(index - period + 1, index + 1);
							const naive = window.reduce((sum, value) => sum + value, 0) / period;
							// Closeness, not identity: the running sum adds in a
							// different order than the naive sum, so the last
							// ulp may differ on denormal-scale values.
							expect(entry).toBeCloseTo(naive, 10);
						}
					});
				},
			),
			{ numRuns: 300 },
		);
	});

	it("clampWindow stays in the extent ordered, pan keeps the span, zoom keeps the anchor", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 19_000, max: 21_000 }),
				fc.integer({ min: 0, max: 400 }),
				fc.integer({ min: 19_000, max: 21_000 }),
				fc.integer({ min: 0, max: 400 }),
				fc.integer({ min: -50, max: 50 }),
				fc.double({ min: 0.2, max: 4, noNaN: true }),
				fc.integer({ min: 0, max: 30 }),
				(from, span, extentFrom, extentSpan, delta, factor, minSpan) => {
					const window = { from, to: from + Math.abs(span) };
					const extent = { from: extentFrom, to: extentFrom + Math.abs(extentSpan) };
					const clamped = expectOk(clampWindow(window, extent, minSpan));
					expect(clamped.from).toBeGreaterThanOrEqual(extent.from);
					expect(clamped.to).toBeLessThanOrEqual(extent.to);
					expect(clamped.from).toBeLessThanOrEqual(clamped.to);

					const panned = expectOk(panWindow(window, delta, extent));
					const extentLength = extent.to - extent.from;
					if (window.to - window.from <= extentLength) {
						expect(panned.to - panned.from).toBe(window.to - window.from);
					}

					const anchor = Math.min(Math.max(from + Math.floor(span / 2), extent.from), extent.to);
					const zoomed = expectOk(zoomWindow(window, anchor, factor, extent, minSpan));
					expect(zoomed.from).toBeLessThanOrEqual(anchor);
					expect(anchor).toBeLessThanOrEqual(zoomed.to);
					expect(zoomed.from).toBeGreaterThanOrEqual(extent.from);
					expect(zoomed.to).toBeLessThanOrEqual(extent.to);
				},
			),
			{ numRuns: 500 },
		);
	});

	it("presetWindow stays in the extent ordered with to at the last day", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("1w", "1m", "3m", "6m", "ytd", "1y", "3y", "5y", "max") as fc.Arbitrary<
					"1w" | "1m" | "3m" | "6m" | "ytd" | "1y" | "3y" | "5y" | "max"
				>,
				fc.integer({ min: 15_000, max: 25_000 }),
				fc.integer({ min: 0, max: 4000 }),
				(preset, firstDay, length) => {
					const lastDay = firstDay + length;
					const window = expectOk(presetWindow(preset, firstDay, lastDay));
					expect(window.to).toBe(lastDay);
					expect(window.from).toBeGreaterThanOrEqual(firstDay);
					expect(window.from).toBeLessThanOrEqual(window.to);
					if (preset === "max") expect(window.from).toBe(firstDay);
				},
			),
			{ numRuns: 500 },
		);
	});

	it("windowStats matches hand-rolled aggregates", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: 1, max: 100, noNaN: true }), { minLength: 1, maxLength: 20 }),
				(closes) => {
					// Positive closes keep every running peak positive, so the
					// drawdown is a plain number.
					const bars: ChartBar[] = closes.map((close, index) => ({
						observedOn: expectOk(dayNumberToIso(20_000 + index)),
						day: 20_000 + index,
						open: close,
						high: close,
						low: close,
						close,
						count: 1,
					}));
					const stats = expectOk(windowStats(bars));
					expect(stats.open).toBe(closes[0]);
					expect(stats.close).toBe(closes[closes.length - 1]);
					expect(stats.change).toBeCloseTo(stats.close - stats.open, 10);
					expect(stats.average).toBeCloseTo(
						closes.reduce((sum, value) => sum + value, 0) / closes.length,
						10,
					);
					expect(stats.high.value).toBe(Math.max(...closes));
					expect(stats.low.value).toBe(Math.min(...closes));
					let peak = Number.NEGATIVE_INFINITY;
					let worst = 0;
					for (const close of closes) {
						peak = Math.max(peak, close);
						worst = Math.max(worst, ((peak - close) / peak) * 100);
					}
					expect(stats.maxDrawdown).toBeCloseTo(worst, 10);
					expect(stats.bars).toBe(closes.length);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("rebasePercent is 0 at the base and autoInterval honours the native floor", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: 1, max: 100, noNaN: true }), { maxLength: 20 }),
				fc.double({ min: 1, max: 100, noNaN: true }),
				(values, base) => {
					const rebased = rebasePercent(values, base);
					expect(rebasePercent([base], base)).toEqual([0]);
					rebased.forEach((entry, index) => {
						const value = values[index] ?? base;
						expect(entry).toBeCloseTo(((value - base) / Math.abs(base)) * 100, 10);
					});
				},
			),
			{ numRuns: 200 },
		);
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 5000 }),
				fc.integer({ min: 1, max: 500 }),
				fc.constantFrom(
					"daily",
					"weekly",
					"monthly",
					"quarterly",
					"annual",
					"unknown",
				) as fc.Arbitrary<ChartNativeFrequency>,
				(spanDays, maxBars, native) => {
					const order = ["daily", "weekly", "monthly", "quarterly", "yearly"];
					const picked = autoInterval(spanDays, native, maxBars);
					const floor = { daily: 0, weekly: 1, monthly: 2, quarterly: 3, annual: 4, unknown: 0 }[
						native
					];
					expect(order.indexOf(picked)).toBeGreaterThanOrEqual(floor);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("day numbers round-trip through ISO text", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 30_000 }), (dayNumber) => {
				expect(dayOf(expectOk(dayNumberToIso(dayNumber)))).toBe(dayNumber);
			}),
			{ numRuns: 300 },
		);
	});

	it("every ChartPoint survives resampling exactly once across bars", () => {
		fc.assert(
			fc.property(
				fc.array(chartPoint, { maxLength: 30 }),
				fc.constantFrom("weekly", "monthly", "quarterly", "yearly") as fc.Arbitrary<ChartInterval>,
				(points, candidate) => {
					const bars = resampleSeries(points, candidate);
					expect(bars.reduce((sum, bar) => sum + bar.count, 0)).toBe(points.length);
				},
			),
			{ numRuns: 300 },
		);
	});
});
