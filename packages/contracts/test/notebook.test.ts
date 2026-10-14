/**
 * The notebook document, widget types, turns and API schemas (ADR-0020):
 * every table row matches its columns, ids are distinct, and the schemas
 * stay strict (unknown fields rejected).
 */
import { describe, expect, it } from "vitest";
import {
	EMPTY_NOTEBOOK,
	NOTEBOOK_LIMITS,
	NOTEBOOK_WIDGET_TYPE_META,
	NOTEBOOK_WIDGET_TYPES,
	notebookAssistRequestSchema,
	notebookResponseSchema,
	notebookSchema,
	notebookTurnSchema,
	notebookWidgetCoreSchema,
	notebookWidgetSchema,
	putNotebookRequestSchema,
	undoNotebookRequestSchema,
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
	it("knows the five widget types with their sizes", () => {
		expect([...NOTEBOOK_WIDGET_TYPES].sort()).toEqual([
			"chart",
			"metric",
			"research",
			"table",
			"text",
		]);
		for (const type of NOTEBOOK_WIDGET_TYPES) {
			expect(NOTEBOOK_WIDGET_TYPE_META[type].sizes.length).toBeGreaterThan(0);
		}
		// Agents cannot create research widgets at every size: only the owner's sizes.
		expect(NOTEBOOK_WIDGET_TYPE_META.research.sizes).toEqual(["medium", "large"]);
	});

	it("accepts one strict member per type, core and stored", () => {
		expectAccepted(notebookWidgetCoreSchema, TEXT_CORE);
		expectAccepted(notebookWidgetCoreSchema, {
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
		expectAccepted(notebookWidgetCoreSchema, {
			widgetId: "w-3",
			type: "chart",
			title: "C",
			size: "medium",
			chartType: "line",
			unit: "",
			series: [{ name: "s", points: [{ x: "a", y: 1 }] }],
		});
		expectAccepted(notebookWidgetCoreSchema, {
			widgetId: "w-4",
			type: "table",
			title: "T",
			size: "medium",
			columns: ["a", "b"],
			rows: [["c", 1]],
		});
		expectAccepted(notebookWidgetCoreSchema, {
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
			notebookWidgetCoreSchema,
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
		expectRejected(notebookWidgetCoreSchema, { ...TEXT_CORE, colour: "red" });
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
