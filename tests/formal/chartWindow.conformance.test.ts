import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type ChartBar,
	type ChartInterval,
	type ChartPoint,
	clampWindow,
	dayNumberToIso,
	isoToDayNumber,
	movingAverage,
	panWindow,
	presetWindow,
	resampleSeries,
	visibleSlice,
	zoomWindow,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between the chart-viewer algorithms
 * (`packages/domain/src/market/chartWindow.ts`) and the Lean 4 model in
 * `formal/ResearchFormal/ChartWindow.lean`.
 *
 * `formal/Export.lean` evaluates the verified definitions over exhaustive
 * small grids (910 resampling cases around week/month/quarter/year
 * boundaries, 81 presets, 72 clamps, 72 pans, 408 zooms, 500 slices,
 * 200 moving-average masks) and every vector is replayed here against the
 * implementation. A divergence between model and code fails this suite.
 */
const chartVectors = z.object({
	chartResample: z.array(
		z.object({
			interval: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]),
			points: z.array(z.object({ day: z.number(), date: z.string(), value: z.number() })),
			bars: z.array(
				z.object({
					day: z.number(),
					date: z.string(),
					open: z.number(),
					high: z.number(),
					low: z.number(),
					close: z.number(),
					count: z.number(),
				}),
			),
		}),
	),
	chartPreset: z.array(
		z.object({
			preset: z.enum(["1w", "1m", "3m", "6m", "ytd", "1y", "3y", "5y", "max"]),
			firstDay: z.number(),
			lastDay: z.number(),
			from: z.number(),
			to: z.number(),
		}),
	),
	chartClamp: z.array(
		z.object({
			window: z.object({ from: z.number(), to: z.number() }),
			extent: z.object({ from: z.number(), to: z.number() }),
			minSpan: z.number(),
			from: z.number(),
			to: z.number(),
		}),
	),
	chartPan: z.array(
		z.object({
			window: z.object({ from: z.number(), to: z.number() }),
			delta: z.number(),
			extent: z.object({ from: z.number(), to: z.number() }),
			from: z.number(),
			to: z.number(),
		}),
	),
	chartZoom: z.array(
		z.object({
			window: z.object({ from: z.number(), to: z.number() }),
			anchor: z.number(),
			factorNum: z.number(),
			factorDen: z.number(),
			extent: z.object({ from: z.number(), to: z.number() }),
			minSpan: z.number(),
			from: z.number(),
			to: z.number(),
		}),
	),
	chartSlice: z.array(
		z.object({
			days: z.array(z.number()),
			from: z.number(),
			to: z.number(),
			start: z.number(),
			end: z.number(),
		}),
	),
	chartMa: z.array(
		z.object({
			values: z.array(z.number()),
			period: z.number(),
			mask: z.array(z.boolean()).nullable(),
		}),
	),
});

const vectors = chartVectors.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

function dayToIso(day: number): string {
	const iso = dayNumberToIso(day);
	if (!iso.ok) throw new Error(`vector day out of range: ${day}`);
	return iso.value;
}

describe("Lean model conformance: chart resampling", () => {
	it(`agrees with resampleSeries on all ${vectors.chartResample.length} vectors`, () => {
		expect(vectors.chartResample.length).toBe(910);
		for (const vector of vectors.chartResample) {
			const label = JSON.stringify(vector);
			const points: ChartPoint[] = vector.points.map((point) => ({
				observedOn: point.date,
				value: point.value,
			}));
			const bars = resampleSeries(points, vector.interval as ChartInterval);
			expect(bars.length, label).toBe(vector.bars.length);
			bars.forEach((bar, index) => {
				const expected = vector.bars[index];
				if (expected === undefined) throw new Error(`missing bar: ${label}`);
				expect(bar.observedOn, label).toBe(expected.date);
				expect(bar.open, label).toBe(expected.open);
				expect(bar.high, label).toBe(expected.high);
				expect(bar.low, label).toBe(expected.low);
				expect(bar.close, label).toBe(expected.close);
				expect(bar.count, label).toBe(expected.count);
				const day = isoToDayNumber(bar.observedOn);
				if (!day.ok) throw new Error(`bad bar date: ${label}`);
				expect(day.value, label).toBe(expected.day);
			});
			// The proved properties, checked independently on the wire values.
			for (let index = 1; index < bars.length; index += 1) {
				const previous = bars[index - 1]?.day ?? 0;
				const current = bars[index]?.day ?? 0;
				if (vector.interval === "daily") expect(current, label).toBeGreaterThanOrEqual(previous);
				else expect(current, label).toBeGreaterThan(previous);
			}
			expect(
				bars.reduce((sum, bar) => sum + bar.count, 0),
				label,
			).toBe(points.length);
		}
	});
});

describe("Lean model conformance: chart presets", () => {
	it(`agrees with presetWindow on all ${vectors.chartPreset.length} vectors`, () => {
		expect(vectors.chartPreset.length).toBe(81);
		for (const vector of vectors.chartPreset) {
			const window = presetWindow(vector.preset, vector.firstDay, vector.lastDay);
			const label = JSON.stringify(vector);
			expect(window.from, label).toBe(vector.from);
			expect(window.to, label).toBe(vector.to);
			// The proved bounds, checked independently.
			expect(window.to, label).toBe(vector.lastDay);
			expect(window.from, label).toBeGreaterThanOrEqual(Math.min(vector.firstDay, vector.lastDay));
			expect(window.from, label).toBeLessThanOrEqual(window.to);
		}
	});
});

describe("Lean model conformance: chart window placement", () => {
	it(`agrees with clampWindow on all ${vectors.chartClamp.length} vectors`, () => {
		expect(vectors.chartClamp.length).toBe(72);
		for (const vector of vectors.chartClamp) {
			const window = clampWindow(vector.window, vector.extent, vector.minSpan);
			const label = JSON.stringify(vector);
			expect(window.from, label).toBe(vector.from);
			expect(window.to, label).toBe(vector.to);
			const lo = Math.min(vector.extent.from, vector.extent.to);
			const hi = Math.max(vector.extent.from, vector.extent.to);
			expect(window.from, label).toBeGreaterThanOrEqual(lo);
			expect(window.to, label).toBeLessThanOrEqual(hi);
			expect(window.from, label).toBeLessThanOrEqual(window.to);
		}
	});

	it(`agrees with panWindow on all ${vectors.chartPan.length} vectors`, () => {
		expect(vectors.chartPan.length).toBe(72);
		for (const vector of vectors.chartPan) {
			const window = panWindow(vector.window, vector.delta, vector.extent);
			const label = JSON.stringify(vector);
			expect(window.from, label).toBe(vector.from);
			expect(window.to, label).toBe(vector.to);
		}
	});

	it(`agrees with zoomWindow on all ${vectors.chartZoom.length} vectors`, () => {
		expect(vectors.chartZoom.length).toBeGreaterThan(300);
		for (const vector of vectors.chartZoom) {
			// Every factor is an exact binary fraction, so the float
			// product matches the model's integer arithmetic exactly.
			const window = zoomWindow(
				vector.window,
				vector.anchor,
				vector.factorNum / vector.factorDen,
				vector.extent,
				vector.minSpan,
			);
			const label = JSON.stringify(vector);
			expect(window.from, label).toBe(vector.from);
			expect(window.to, label).toBe(vector.to);
			// The proved anchor property, checked independently.
			const anchor = Math.min(
				Math.max(vector.anchor, Math.min(vector.extent.from, vector.extent.to)),
				Math.max(vector.extent.from, vector.extent.to),
			);
			expect(window.from, label).toBeLessThanOrEqual(anchor);
			expect(anchor, label).toBeLessThanOrEqual(window.to);
		}
	});
});

describe("Lean model conformance: visible slice", () => {
	it(`agrees with visibleSlice on all ${vectors.chartSlice.length} vectors`, () => {
		expect(vectors.chartSlice.length).toBe(500);
		for (const vector of vectors.chartSlice) {
			const bars: ChartBar[] = vector.days.map((day, index) => ({
				observedOn: dayToIso(day),
				day,
				open: index,
				high: index,
				low: index,
				close: index,
				count: 1,
			}));
			const slice = visibleSlice(bars, { from: vector.from, to: vector.to });
			const label = JSON.stringify(vector);
			expect(slice.start, label).toBe(vector.start);
			expect(slice.end, label).toBe(vector.end);
			// The proved filter equivalence, checked independently.
			const lo = Math.min(vector.from, vector.to);
			const hi = Math.max(vector.from, vector.to);
			expect(bars.slice(slice.start, slice.end), label).toEqual(
				bars.filter((bar) => bar.day >= lo && bar.day <= hi),
			);
		}
	});
});

describe("Lean model conformance: moving-average shape", () => {
	it(`agrees with movingAverage on all ${vectors.chartMa.length} vectors`, () => {
		expect(vectors.chartMa.length).toBe(200);
		for (const vector of vectors.chartMa) {
			const label = JSON.stringify(vector);
			const result = movingAverage(vector.values, vector.period);
			if (vector.mask === null) {
				// Period 0 is outside the Nat model; the implementation
				// fails closed (also covered by unit tests).
				expect(result.ok, label).toBe(false);
				continue;
			}
			expect(result.ok, label).toBe(true);
			if (!result.ok) continue;
			expect(result.value.length, label).toBe(vector.values.length);
			expect(
				result.value.map((entry) => entry !== null),
				label,
			).toEqual(vector.mask);
		}
	});
});
