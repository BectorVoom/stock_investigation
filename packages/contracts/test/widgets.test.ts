import { describe, expect, it } from "vitest";
import {
	asHomeWidget,
	DEFAULT_HOME_DASHBOARD,
	HOME_WIDGET_TYPES,
	homeCapacityProblem,
	homeDashboardSchema,
	homeWidgetSchema,
	MARKET_LIMITS,
	notebookWidgetSchema,
	putHomeDashboardRequestSchema,
	storedHomeDashboardSchema,
	WIDGET_LIMITS,
	WIDGET_TYPE_META,
	WIDGET_TYPES,
	widgetAgentDescription,
	widgetContentBytes,
	widgetCoreSchema,
} from "../src/index.ts";
import { expectAccepted, expectRejected } from "./support.ts";

/** ADR-0024: one widget specification for Home and the Notebook. */

const note = {
	widgetId: "w-note",
	type: "text",
	title: "Thesis",
	size: "medium",
	text: "## Why\n\n**Margins** expand.",
} as const;

const research = {
	widgetId: "w-research",
	type: "research",
	title: "Report",
	size: "large",
	componentId: "cmp_1",
} as const;

describe("one widget specification", () => {
	it("describes every type once, for the owner and for agents", () => {
		for (const type of WIDGET_TYPES) {
			const meta = WIDGET_TYPE_META[type];
			expect(meta.label.trim()).not.toBe("");
			expect(meta.description.trim()).not.toBe("");
			expect(meta.sizes).toContain(meta.defaultSize);
			// Agents read the owner's sentence plus how to write the type.
			expect(widgetAgentDescription(type).startsWith(meta.description)).toBe(true);
		}
		// The owner never reads series-id syntax; agents do.
		expect(WIDGET_TYPE_META["line-chart"].description).not.toContain("fred:");
		expect(widgetAgentDescription("line-chart")).toContain("fred:VIXCLS");
	});

	it("takes every type on Home except a research result", () => {
		expect([...HOME_WIDGET_TYPES]).toEqual(WIDGET_TYPES.filter((type) => type !== "research"));
		expectAccepted(homeWidgetSchema, note);
		expectRejected(homeWidgetSchema, research);
		expectAccepted(widgetCoreSchema, research);
		const parsed = widgetCoreSchema.parse(research);
		expect(asHomeWidget(parsed)).toBeNull();
		expect(asHomeWidget(widgetCoreSchema.parse(note))).toEqual(note);
	});

	it("has a scheduled-tasks widget with no content fields, on Home and in the Notebook (ADR-0033)", () => {
		const tasks = {
			widgetId: "w-tasks",
			type: "scheduled-tasks",
			title: "Tasks",
			size: "medium",
		} as const;
		expect(WIDGET_TYPE_META["scheduled-tasks"].defaultSize).toBe("medium");
		expect([...WIDGET_TYPE_META["scheduled-tasks"].sizes].sort()).toEqual([
			"large",
			"medium",
			"small",
		]);
		expect(widgetAgentDescription("scheduled-tasks")).toContain("cannot create, edit or run tasks");
		for (const size of ["small", "medium", "large"] as const) {
			expectAccepted(widgetCoreSchema, { ...tasks, size });
			expectAccepted(homeWidgetSchema, { ...tasks, size });
		}
		expectAccepted(notebookWidgetSchema, {
			...tasks,
			createdAt: "2026-10-24T00:00:00.000Z",
			updatedAt: "2026-10-24T00:00:00.000Z",
			revision: 1,
			origin: { kind: "owner", messageId: null, runId: null, componentId: null },
		});
		// A task cannot be smuggled in through the widget.
		expectRejected(widgetCoreSchema, { ...tasks, question: "Summarise the market" });
		expectRejected(homeWidgetSchema, { ...tasks, daysAhead: 30 });
	});

	it("applies one title rule to every widget on every page", () => {
		expect(WIDGET_LIMITS.maxTitleChars).toBe(120);
		expectAccepted(widgetCoreSchema, { ...note, title: "x".repeat(120) });
		expectRejected(widgetCoreSchema, { ...note, title: "x".repeat(121) });
		expectRejected(homeWidgetSchema, { ...note, title: "x".repeat(121) });
		expectRejected(homeWidgetSchema, { ...note, title: "   " });
	});
});

describe("Home dashboard version 2", () => {
	it("ships a default arrangement of live market metrics", () => {
		expectAccepted(homeDashboardSchema, DEFAULT_HOME_DASHBOARD);
		expect(DEFAULT_HOME_DASHBOARD.widgets.filter((w) => w.type === "market-metric")).toHaveLength(
			4,
		);
	});

	it("upgrades a stored version-1 dashboard on read: its live metric becomes market-metric", () => {
		const stored = {
			schemaVersion: 1,
			widgets: [
				{ type: "metric", widgetId: "w-vix", title: "VIX", size: "small", seriesId: "fred:VIXCLS" },
				{
					type: "earnings-calendar",
					widgetId: "w-cal",
					title: "Earnings",
					size: "large",
					daysAhead: 90,
				},
			],
		};
		const read = storedHomeDashboardSchema.parse(stored);
		expect(read.schemaVersion).toBe(2);
		expect(read.widgets[0]).toEqual({ ...stored.widgets[0], type: "market-metric" });
		expect(read.widgets[1]).toEqual(stored.widgets[1]);
		// A version-2 document reads as it is.
		expect(storedHomeDashboardSchema.parse(DEFAULT_HOME_DASHBOARD)).toEqual(DEFAULT_HOME_DASHBOARD);
		// Something that is neither still fails closed.
		expect(storedHomeDashboardSchema.safeParse({ schemaVersion: 1, widgets: "x" }).success).toBe(
			false,
		);
	});

	it("accepts only version 2 from the API", () => {
		const request = {
			dashboard: { schemaVersion: 1, widgets: [] },
			expectedVersion: 0,
		};
		expect(putHomeDashboardRequestSchema.safeParse(request).success).toBe(false);
		expectAccepted(putHomeDashboardRequestSchema, {
			dashboard: { schemaVersion: 2, widgets: [note] },
			expectedVersion: 0,
		});
	});

	it("bounds widgets, series and content bytes, saying why", () => {
		const widgets = Array.from({ length: MARKET_LIMITS.maxWidgets + 1 }, (_, index) => ({
			...note,
			widgetId: `w-${index}`,
		}));
		expect(homeCapacityProblem(widgets)?.code).toBe("TOO_MANY_WIDGETS");
		expect(homeCapacityProblem(widgets.slice(0, MARKET_LIMITS.maxWidgets))).toBeNull();

		const series = Array.from({ length: MARKET_LIMITS.maxSeries + 1 }, (_, index) => ({
			type: "market-metric" as const,
			widgetId: `w-s${index}`,
			title: "S",
			size: "small" as const,
			seriesId: `fred:S${index}`,
		}));
		// The 31 series fit in 24 widgets only through tables; one widget per
		// series is over both bounds, and the widget count is named first.
		const tables = [0, 1, 2].map((table) => ({
			type: "stock-table" as const,
			widgetId: `w-t${table}`,
			title: "T",
			size: "medium" as const,
			seriesIds: series.slice(table * 11, table * 11 + 11).map((entry) => entry.seriesId),
		}));
		expect(homeCapacityProblem(tables)?.code).toBe("TOO_MANY_SERIES");

		const long = "x".repeat(WIDGET_LIMITS.maxTextChars);
		const heavy = Array.from({ length: 24 }, (_, index) => ({
			...note,
			widgetId: `w-h${index}`,
			// A table of 200 rows of 12 long cells each.
			type: "table" as const,
			columns: Array.from({ length: 12 }, (_, column) => `C${column}`),
			rows: Array.from({ length: 200 }, () =>
				Array.from({ length: 12 }, () => long.slice(0, WIDGET_LIMITS.maxCellChars)),
			),
		})).map(({ text: _text, ...table }) => table);
		expect(widgetContentBytes(heavy)).toBeGreaterThan(WIDGET_LIMITS.maxContentBytes);
		expect(homeCapacityProblem(heavy)?.code).toBe("DASHBOARD_TOO_LARGE");
		expect(homeDashboardSchema.safeParse({ schemaVersion: 2, widgets: heavy }).success).toBe(false);
	});
});
