/**
 * The notebook document, widget types, turns and API schemas (ADR-0020):
 * every table row matches its columns, ids are distinct, and the schemas
 * stay strict (unknown fields rejected).
 */
import { describe, expect, it } from "vitest";
import { MAX_REQUEST_BODY_BYTES } from "../src/api.ts";
import {
	asHomeWidget,
	distinctWidgetSeriesIds,
	EMPTY_NOTEBOOK,
	homeWidgetSchema,
	isMarketWidget,
	NOTEBOOK_LIMITS,
	notebookAssistRequestSchema,
	notebookCapacityProblem,
	notebookContentBytes,
	notebookResponseSchema,
	notebookSchema,
	notebookTurnSchema,
	notebookWidgetSchema,
	putNotebookRequestSchema,
	undoNotebookRequestSchema,
	WIDGET_TYPE_META,
	WIDGET_TYPES,
	widgetCoreSchema,
} from "../src/index.ts";
import { notebookAssistJobRequestSchema } from "../src/jobs.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

const TEXT_CORE = {
	widgetId: "w-1",
	type: "text",
	title: "Notes",
	size: "medium",
	text: "hello",
} as const;

const TEXT_WIDGET = {
	...TEXT_CORE,
	createdAt: "2026-10-14T00:00:00.000Z",
	updatedAt: "2026-10-14T00:00:00.000Z",
	revision: 1,
	origin: { kind: "owner", messageId: null, runId: null, componentId: null },
} as const;

describe("notebook widgets", () => {
	it("knows the widget types with their sizes, Home's market types included", () => {
		expect([...WIDGET_TYPES].sort()).toEqual([
			"chart",
			"earnings-calendar",
			"indicator-table",
			"line-chart",
			"market-metric",
			"metric",
			"research",
			"scheduled-tasks",
			"stock-table",
			"table",
			"task-result",
			"text",
		]);
		for (const type of WIDGET_TYPES) {
			expect(WIDGET_TYPE_META[type].sizes.length).toBeGreaterThan(0);
		}
		// Agents cannot create research widgets at every size: only the owner's sizes.
		expect(WIDGET_TYPE_META.research.sizes).toEqual(["medium", "large"]);
	});

	it("accepts one strict member per type, core and stored", () => {
		expectAccepted(widgetCoreSchema, TEXT_CORE);
		expectAccepted(widgetCoreSchema, {
			widgetId: "w-2",
			type: "metric",
			title: "M",
			size: "small",
			value: 3,
			unit: "x",
			change: null,
			caption: "",
			asOf: null,
		});
		expectAccepted(widgetCoreSchema, {
			widgetId: "w-3",
			type: "chart",
			title: "C",
			size: "medium",
			chartType: "line",
			unit: "",
			series: [{ name: "s", points: [{ x: "a", y: 1 }] }],
		});
		expectAccepted(widgetCoreSchema, {
			widgetId: "w-4",
			type: "table",
			title: "T",
			size: "medium",
			columns: ["a", "b"],
			rows: [["c", 1]],
		});
		expectAccepted(widgetCoreSchema, {
			widgetId: "w-5",
			type: "research",
			title: "R",
			size: "large",
			componentId: "comp_1",
		});
		expectAccepted(notebookWidgetSchema, TEXT_WIDGET);
	});

	it("rejects a table row that does not match its columns", () => {
		expectRejected(
			widgetCoreSchema,
			{
				widgetId: "w-4",
				type: "table",
				title: "T",
				size: "medium",
				columns: ["a", "b"],
				rows: [["only-one"]],
			},
			["rows"],
		);
	});

	it("rejects unknown widget fields (strictness)", () => {
		expectRejected(widgetCoreSchema, { ...TEXT_CORE, colour: "red" });
		expectRejected(notebookWidgetSchema, { ...TEXT_WIDGET, colour: "red" });
		expectRejected(notebookSchema, { widgets: [], layout: [] });
	});

	it("requires distinct widget ids and bounds the notebook", () => {
		expectAccepted(notebookSchema, EMPTY_NOTEBOOK);
		expectAccepted(notebookSchema, { widgets: [TEXT_WIDGET] });
		expectRejected(notebookSchema, { widgets: [TEXT_WIDGET, TEXT_WIDGET] }, ["widgets"]);
		expectRejected(
			notebookSchema,
			{
				widgets: repeat({ ...TEXT_WIDGET, widgetId: "w-x" }, NOTEBOOK_LIMITS.maxWidgets + 1).map(
					(widget, index) => ({ ...widget, widgetId: `w-${index}` }),
				),
			},
			["widgets"],
		);
	});

	it("accepts a notebook at the widget maximum", () => {
		expect(NOTEBOOK_LIMITS.maxWidgets).toBe(200);
		expectAccepted(notebookSchema, {
			widgets: Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) => ({
				...TEXT_WIDGET,
				widgetId: `w-${index}`,
			})),
		});
	});
});

describe("notebook capacity", () => {
	/** A text widget of about `bytes` content bytes. */
	const textOfBytes = (widgetId: string, bytes: number) => ({
		...TEXT_WIDGET,
		widgetId,
		text: "y".repeat(Math.min(bytes, NOTEBOOK_LIMITS.maxTextChars)),
	});
	/** Widgets whose content together is just over `total` bytes. */
	const widgetsOver = (total: number) =>
		Array.from({ length: Math.ceil(total / NOTEBOOK_LIMITS.maxTextChars) + 1 }, (_, index) =>
			textOfBytes(`w-${index}`, NOTEBOOK_LIMITS.maxTextChars),
		);

	it("measures content without the server-stamped metadata", () => {
		const coreBytes = new TextEncoder().encode(JSON.stringify(TEXT_CORE)).byteLength;
		expect(notebookContentBytes([TEXT_CORE])).toBe(coreBytes);
		expect(notebookContentBytes([TEXT_WIDGET])).toBe(coreBytes);
		expect(notebookContentBytes([TEXT_WIDGET, { ...TEXT_WIDGET, widgetId: "w-2" }])).toBe(
			coreBytes * 2,
		);
		// UTF-8 bytes, not UTF-16 code units.
		expect(notebookContentBytes([{ ...TEXT_CORE, text: "円" }])).toBe(
			notebookContentBytes([{ ...TEXT_CORE, text: "y" }]) + 2,
		);
		expect(notebookContentBytes([{ ...TEXT_WIDGET, text: "📈" }])).toBe(
			notebookContentBytes([{ ...TEXT_CORE, text: "y" }]) + 3,
		);
		const fromChat = {
			...TEXT_WIDGET,
			origin: { kind: "chat", messageId: "msg_1", runId: "run_1", componentId: "comp_1" },
		} as const;
		expect(notebookContentBytes([fromChat])).toBe(coreBytes);
	});

	it("refuses more widgets than the maximum", () => {
		const full = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) => ({
			...TEXT_CORE,
			widgetId: `w-${index}`,
		}));
		expect(notebookCapacityProblem(full, full.slice(1))).toBeNull();
		expect(notebookCapacityProblem([...full, { ...TEXT_CORE, widgetId: "w-x" }], full)).toEqual({
			code: "TOO_MANY_WIDGETS",
			message: "A notebook holds at most 200 widgets. Remove one before adding another.",
		});
	});

	it("refuses growing past the byte cap, but lets an over-cap notebook shrink", () => {
		const over = widgetsOver(NOTEBOOK_LIMITS.maxContentBytes);
		expect(notebookContentBytes(over)).toBeGreaterThan(NOTEBOOK_LIMITS.maxContentBytes);
		expect(notebookCapacityProblem(over, over.slice(1))?.code).toBe("NOTEBOOK_TOO_LARGE");
		expect(notebookCapacityProblem(over.slice(1), over)).toBeNull();
		// Rearranging an over-cap notebook does not grow it.
		expect(notebookCapacityProblem([...over].reverse(), over)).toBeNull();
	});

	it("keeps a notebook at the byte cap, metadata included, inside one request", () => {
		const origin = {
			kind: "chat",
			messageId: "m".repeat(96),
			runId: "r".repeat(96),
			componentId: "c".repeat(96),
		} as const;
		const perWidget = Math.floor(NOTEBOOK_LIMITS.maxContentBytes / NOTEBOOK_LIMITS.maxWidgets);
		const widgets = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) => ({
			...TEXT_WIDGET,
			widgetId: `w-${String(index).padStart(94, "0")}`,
			origin,
			revision: 999_999_999,
			text: "y".repeat(perWidget - 200),
		}));
		expect(notebookContentBytes(widgets)).toBeLessThanOrEqual(NOTEBOOK_LIMITS.maxContentBytes);
		const body = JSON.stringify({ notebook: { widgets }, expectedVersion: 999_999_999 });
		expect(new TextEncoder().encode(body).byteLength).toBeLessThan(MAX_REQUEST_BODY_BYTES);
	});
});

describe("turns and owner API schemas", () => {
	const turn = {
		runId: "run_1",
		baseVersion: 1,
		appliedVersion: 2,
		changes: [{ widgetId: "w-1", kind: "added", title: "Notes", before: null, after: "hello" }],
		proposedRemovals: [{ widgetId: "w-2", title: "Old" }],
		failure: null,
		createdAt: "2026-10-14T00:00:00.000Z",
	} as const;

	it("accepts an applied turn and a failed turn", () => {
		expectAccepted(notebookTurnSchema, turn);
		expectAccepted(notebookTurnSchema, {
			...turn,
			appliedVersion: null,
			changes: [],
			proposedRemovals: [],
			failure: { code: "NOTEBOOK_CHANGED", message: "Changed." },
		});
		expectRejected(notebookTurnSchema, without(turn, "runId"), ["runId"]);
	});

	it("accepts a full notebook response", () => {
		expectAccepted(notebookResponseSchema, {
			workspaceId: "ws_1",
			notebook: { widgets: [TEXT_WIDGET] },
			version: 2,
			updatedAt: "2026-10-14T00:00:00.000Z",
			undoAvailable: true,
			turns: [turn],
		});
		// Version 0 was never saved: the empty notebook with no stamp.
		expectAccepted(notebookResponseSchema, {
			workspaceId: "ws_1",
			notebook: EMPTY_NOTEBOOK,
			version: 0,
			updatedAt: null,
			undoAvailable: false,
			turns: [],
		});
	});

	it("bounds the save, undo and assist requests", () => {
		expectAccepted(putNotebookRequestSchema, {
			notebook: { widgets: [TEXT_WIDGET] },
			expectedVersion: 2,
		});
		expectRejected(putNotebookRequestSchema, { notebook: { widgets: [TEXT_WIDGET] } }, [
			"expectedVersion",
		]);
		expectAccepted(undoNotebookRequestSchema, { expectedVersion: 2 });
		expectRejected(undoNotebookRequestSchema, { expectedVersion: 0 }, ["expectedVersion"]);
		expectAccepted(notebookAssistRequestSchema, {
			instruction: "Summarise",
			selectedWidgetIds: ["w-1"],
			notebookVersion: 2,
		});
		expectRejected(notebookAssistRequestSchema, {
			instruction: "  ",
			selectedWidgetIds: [],
			notebookVersion: 0,
		});
	});

	it("stores the notebook-assist job request with its agent choices", () => {
		const stored = {
			instruction: "Summarise",
			selectedWidgetIds: ["w-1"],
			notebookVersion: 2,
			agent: { agentId: "claude-code", model: null, effort: "medium" },
		} as const;
		const parsed = expectAccepted(notebookAssistJobRequestSchema, stored);
		expect(parsed.agent).toMatchObject({ agentId: "claude-code", effort: "medium" });
		expectRejected(notebookAssistJobRequestSchema, without(stored, "instruction"), ["instruction"]);
		// A research request never parses as a notebook request and back.
		expectRejected(notebookAssistJobRequestSchema, {
			...stored,
			workspaceId: "ws_1",
			question: "Q?",
		});
	});
});

describe("notebook market widgets (ADR-0021)", () => {
	const GOLD_CHART = {
		widgetId: "w-gold",
		type: "line-chart",
		title: "Gold, past year",
		size: "medium",
		seriesIds: ["twelve-data:XAU/USD"],
		range: "1y",
	} as const;

	it("accepts each Home widget type with exactly Home's fields", () => {
		expectAccepted(widgetCoreSchema, GOLD_CHART);
		expectAccepted(widgetCoreSchema, {
			widgetId: "w-m",
			type: "market-metric",
			title: "VIX",
			size: "small",
			seriesId: "fred:VIXCLS",
		});
		expectAccepted(widgetCoreSchema, {
			widgetId: "w-e",
			type: "earnings-calendar",
			title: "Earnings",
			size: "large",
			daysAhead: 90,
		});
		expectRejected(widgetCoreSchema, { ...GOLD_CHART, seriesIds: ["gold"] });
		expectRejected(widgetCoreSchema, { ...GOLD_CHART, points: [] });
	});

	it("refuses a widget that repeats a series", () => {
		expectRejected(widgetCoreSchema, {
			...GOLD_CHART,
			seriesIds: ["twelve-data:XAU/USD", "twelve-data:XAU/USD"],
		});
	});

	it("is a Home widget as it is: one specification, no conversion (ADR-0024)", () => {
		const parsed = widgetCoreSchema.parse(GOLD_CHART);
		if (!isMarketWidget(parsed)) throw new Error("expected a market widget");
		expect(homeWidgetSchema.parse(parsed)).toEqual(parsed);
		expect(asHomeWidget(parsed)).toBe(parsed);
		expect(distinctWidgetSeriesIds([parsed, parsed])).toEqual(["twelve-data:XAU/USD"]);
	});

	it("caps the distinct series a notebook may grow to", () => {
		const many = Array.from({ length: NOTEBOOK_LIMITS.maxMarketSeries + 1 }, (_, index) => ({
			widgetId: `w-${index}`,
			type: "market-metric" as const,
			title: "S",
			size: "small" as const,
			seriesId: `fred:S${index}`,
		}));
		expect(notebookCapacityProblem(many, [])?.code).toBe("TOO_MANY_SERIES");
		expect(notebookCapacityProblem(many.slice(1), many)).toBeNull();
	});
});
