import { describe, expect, it } from "vitest";
import {
	applyDashboardEdit,
	type Dashboard,
	type DashboardWidget,
} from "../../src/market/dashboard.ts";
import { expectErr, expectOk } from "../support/result.ts";

const metric = (widgetId: string, seriesId = "fred:VIXCLS"): DashboardWidget => ({
	widgetId,
	title: `Widget ${widgetId}`,
	size: "small",
	type: "metric",
	seriesId,
});

const empty: Dashboard = { schemaVersion: 1, widgets: [] };
const one: Dashboard = { schemaVersion: 1, widgets: [metric("a")] };
const two: Dashboard = { schemaVersion: 1, widgets: [metric("a"), metric("b", "fred:DGS10")] };

describe("applyDashboardEdit", () => {
	it("adds a widget at the end", () => {
		const next = expectOk(applyDashboardEdit(one, { kind: "add", widget: metric("b") }));
		expect(next.widgets.map((widget) => widget.widgetId)).toEqual(["a", "b"]);
	});

	it("rejects a duplicate widget id", () => {
		expect(expectErr(applyDashboardEdit(one, { kind: "add", widget: metric("a") }))).toBe(
			"DUPLICATE_WIDGET_ID",
		);
	});

	it("rejects a widget that repeats a series", () => {
		const bad: DashboardWidget = {
			widgetId: "c",
			title: "Bad",
			size: "medium",
			type: "line-chart",
			seriesIds: ["fred:VIXCLS", "fred:VIXCLS"],
			range: "1y",
		};
		expect(expectErr(applyDashboardEdit(one, { kind: "add", widget: bad }))).toBe(
			"DUPLICATE_SERIES_IN_WIDGET",
		);
	});

	it("removes exactly that widget and keeps the order of the rest", () => {
		const three: Dashboard = {
			schemaVersion: 1,
			widgets: [metric("a"), metric("b", "fred:DGS10"), metric("c", "fred:SP500")],
		};
		const next = expectOk(applyDashboardEdit(three, { kind: "remove", widgetId: "b" }));
		expect(next.widgets.map((widget) => widget.widgetId)).toEqual(["a", "c"]);
		expect(expectErr(applyDashboardEdit(one, { kind: "remove", widgetId: "missing" }))).toBe(
			"WIDGET_NOT_FOUND",
		);
	});

	it("moves a widget earlier and later, and errors at the ends", () => {
		const earlier = expectOk(
			applyDashboardEdit(two, { kind: "move", widgetId: "b", direction: "earlier" }),
		);
		expect(earlier.widgets.map((widget) => widget.widgetId)).toEqual(["b", "a"]);
		const later = expectOk(
			applyDashboardEdit(two, { kind: "move", widgetId: "a", direction: "later" }),
		);
		expect(later.widgets.map((widget) => widget.widgetId)).toEqual(["b", "a"]);
		expect(
			expectErr(applyDashboardEdit(two, { kind: "move", widgetId: "a", direction: "earlier" })),
		).toBe("MOVE_AT_END");
		expect(
			expectErr(applyDashboardEdit(two, { kind: "move", widgetId: "b", direction: "later" })),
		).toBe("MOVE_AT_END");
		expect(
			expectErr(applyDashboardEdit(one, { kind: "move", widgetId: "missing", direction: "later" })),
		).toBe("WIDGET_NOT_FOUND");
	});

	it("replaces a widget under the same id", () => {
		const next = expectOk(
			applyDashboardEdit(one, {
				kind: "replace",
				widget: { ...metric("a"), title: "Renamed", size: "large" },
			}),
		);
		expect(next.widgets[0]).toMatchObject({ widgetId: "a", title: "Renamed", size: "large" });
		expect(expectErr(applyDashboardEdit(one, { kind: "replace", widget: metric("missing") }))).toBe(
			"WIDGET_NOT_FOUND",
		);
	});

	it("resets to the given dashboard", () => {
		const next = expectOk(applyDashboardEdit(two, { kind: "reset", dashboard: one }));
		expect(next.widgets.map((widget) => widget.widgetId)).toEqual(["a"]);
	});

	it("enforces the widget and series limits", () => {
		const full: Dashboard = {
			schemaVersion: 1,
			widgets: Array.from({ length: 24 }, (_, index) => metric(`w${index}`, `fred:S${index}`)),
		};
		expect(expectErr(applyDashboardEdit(full, { kind: "add", widget: metric("extra") }))).toBe(
			"TOO_MANY_WIDGETS",
		);
		const wide: Dashboard = {
			schemaVersion: 1,
			widgets: Array.from({ length: 3 }, (_, index) =>
				index === 0
					? metric("w0", "fred:A")
					: {
							widgetId: `w${index}`,
							title: `W ${index}`,
							size: "large" as const,
							type: "indicator-table" as const,
							seriesIds: Array.from({ length: 12 }, (_, cell) => `fred:B${index}${cell}`),
						},
			),
		};
		// 1 + 12 + 12 = 25 distinct series; replacing w0 with 6 more distinct hits 30+… use a wider case:
		const atLimit: Dashboard = {
			schemaVersion: 1,
			widgets: [
				{
					widgetId: "w0",
					title: "W",
					size: "large",
					type: "indicator-table",
					seriesIds: Array.from({ length: 12 }, (_, cell) => `fred:A${cell}`),
				},
				{
					widgetId: "w1",
					title: "W",
					size: "large",
					type: "indicator-table",
					seriesIds: Array.from({ length: 12 }, (_, cell) => `fred:B${cell}`),
				},
				metric("w2", "fred:C0"),
				metric("w3", "fred:C1"),
				metric("w4", "fred:C2"),
				metric("w5", "fred:C3"),
				metric("w6", "fred:C4"),
				metric("w7", "fred:C5"),
			],
		};
		// 12 + 12 + 6 = 30 distinct: one more distinct series must fail.
		expect(
			expectErr(applyDashboardEdit(atLimit, { kind: "add", widget: metric("extra", "fred:NEWD") })),
		).toBe("TOO_MANY_SERIES");
		// Reusing an existing series stays within the limit.
		expect(
			expectOk(applyDashboardEdit(atLimit, { kind: "add", widget: metric("extra", "fred:A0") })),
		).toBeDefined();
		expect(wide.widgets).toHaveLength(3);
	});

	it("never mutates its input", () => {
		const before = JSON.parse(JSON.stringify(two)) as Dashboard;
		expectOk(applyDashboardEdit(two, { kind: "add", widget: metric("c", "fred:SP500") }));
		expectOk(applyDashboardEdit(two, { kind: "remove", widgetId: "a" }));
		expectOk(applyDashboardEdit(two, { kind: "move", widgetId: "a", direction: "later" }));
		expect(two).toEqual(before);
		expect(empty.widgets).toEqual([]);
	});
});
