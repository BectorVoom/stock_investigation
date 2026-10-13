import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { latestChange, selectRange } from "../../src/market/changes.ts";
import {
	applyDashboardEdit,
	type Dashboard,
	type DashboardWidget,
} from "../../src/market/dashboard.ts";
import { rateWindowPermit } from "../../src/market/rateWindow.ts";
import { parseMarketSeriesId } from "../../src/market/seriesId.ts";

const isoDate = fc
	.tuple(
		fc.integer({ min: 2000, max: 2030 }),
		fc.integer({ min: 1, max: 12 }),
		fc.integer({ min: 1, max: 28 }),
	)
	.map(
		([year, month, day]) =>
			`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
	);

const point = fc.record({
	observedOn: isoDate,
	value: fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((value) => Number.isFinite(value)),
});

const widgetId = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/);

function metricWidget(id: string, series: string): DashboardWidget {
	return { widgetId: id, title: `T ${id}`, size: "small", type: "metric", seriesId: series };
}

describe("market properties", () => {
	it("selectRange returns a suffix of the input in the same order", () => {
		fc.assert(
			fc.property(
				fc.array(point, { maxLength: 20 }),
				fc.constantFrom("1m", "3m", "6m", "1y", "3y", "max") as fc.Arbitrary<
					"1m" | "3m" | "6m" | "1y" | "3y" | "max"
				>,
				(all, range) => {
					const sorted = [...all].sort((a, b) => (a.observedOn < b.observedOn ? -1 : 1));
					const selected = selectRange(sorted, range);
					// A suffix: the selected points are the last N of the input, in order.
					expect(selected).toEqual(sorted.slice(sorted.length - selected.length));
					for (const entry of selected) {
						expect(sorted).toContainEqual(entry);
					}
				},
			),
			{ numRuns: 300 },
		);
	});

	it("selectRange with max returns everything", () => {
		fc.assert(
			fc.property(fc.array(point, { maxLength: 20 }), (all) => {
				expect(selectRange(all, "max")).toEqual(all);
			}),
			{ numRuns: 300 },
		);
	});

	it("an accepted add preserves id uniqueness and appends", () => {
		fc.assert(
			fc.property(
				fc.array(widgetId, { maxLength: 8 }),
				widgetId,
				fc.constantFrom("fred:VIXCLS", "fred:DGS10", "twelve-data:AAPL"),
				(ids, id, series) => {
					const unique = [...new Set(ids)];
					const dashboard: Dashboard = {
						schemaVersion: 1,
						widgets: unique.map((candidate) => metricWidget(candidate, "fred:SP500")),
					};
					const result = applyDashboardEdit(dashboard, {
						kind: "add",
						widget: metricWidget(id, series),
					});
					if (unique.includes(id) || unique.length >= 24) {
						expect(result.ok).toBe(false);
					} else {
						expect(result.ok).toBe(true);
						if (result.ok) {
							const out = result.value.widgets.map((widget) => widget.widgetId);
							expect(new Set(out).size).toBe(out.length);
							expect(out[out.length - 1]).toBe(id);
						}
					}
				},
			),
			{ numRuns: 300 },
		);
	});

	it("a move keeps the same members with the same length", () => {
		fc.assert(
			fc.property(
				fc.array(widgetId, { minLength: 1, maxLength: 8 }),
				fc.constantFrom("earlier", "later") as fc.Arbitrary<"earlier" | "later">,
				(ids, direction) => {
					const unique = [...new Set(ids)];
					const dashboard: Dashboard = {
						schemaVersion: 1,
						widgets: unique.map((candidate) => metricWidget(candidate, "fred:SP500")),
					};
					const target = unique[0];
					if (target === undefined) return;
					const result = applyDashboardEdit(dashboard, {
						kind: "move",
						widgetId: target,
						direction,
					});
					if (result.ok) {
						expect([...result.value.widgets.map((w) => w.widgetId)].sort()).toEqual(
							[...unique].sort(),
						);
						expect(result.value.widgets).toHaveLength(unique.length);
					}
				},
			),
			{ numRuns: 300 },
		);
	});

	it("rateWindowPermit allows at most maxPerWindow grants in any window", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 10 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 1, max: 5 }),
				(grants, nowMs, maxPerWindow) => {
					const windowMs = 100;
					const decision = rateWindowPermit(grants, nowMs, maxPerWindow, windowMs);
					const inWindow = grants.filter((at) => at > nowMs - windowMs && at <= nowMs);
					if (inWindow.length < maxPerWindow) {
						expect(decision).toEqual({ allowed: true });
					} else {
						expect(decision.allowed).toBe(false);
						if (!decision.allowed) {
							expect(decision.retryAfterMs).toBeGreaterThanOrEqual(0);
						}
					}
				},
			),
			{ numRuns: 500 },
		);
	});

	it("parseMarketSeriesId accepts exactly the contract shapes", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (text) => {
				const result = parseMarketSeriesId(text);
				const [provider, ...rest] = text.split(":");
				const symbol = rest.join(":");
				if (provider === "fred") {
					expect(result.ok).toBe(/^[A-Z0-9]{1,25}$/.test(symbol));
				} else if (provider === "twelve-data") {
					expect(result.ok).toBe(/^[A-Z0-9][A-Z0-9./-]{0,19}(:[A-Z0-9]{2,10})?$/.test(symbol));
				} else {
					expect(result.ok).toBe(false);
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("latestChange percent equals (latest − previous) / |previous| × 100", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -1000, max: 1000, noNaN: true }),
				fc.double({ min: -1000, max: 1000, noNaN: true }),
				(previous, latest) => {
					if (!Number.isFinite(previous) || !Number.isFinite(latest)) return;
					const result = latestChange([
						{ observedOn: "2026-09-30", value: previous },
						{ observedOn: "2026-10-01", value: latest },
					]);
					if (previous === 0) {
						expect(result.ok && result.value.percentChange).toBeNull();
					} else if (result.ok) {
						const expected = ((latest - previous) / Math.abs(previous)) * 100;
						expect(result.value.percentChange).toBeCloseTo(expected, 8);
						expect(result.value.absoluteChange).toBe(latest - previous);
					}
				},
			),
			{ numRuns: 500 },
		);
	});
});
