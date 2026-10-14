/**
 * The notebook as the widget-grid agent layer sees it (ADR-0020): the seam
 * both the runner and the API validate assistant commands through. These
 * tests pin the seam's behaviour — every command kind, the `remove`
 * refusal, all-or-nothing application, metadata stamping and the research
 * component rule.
 */
import type { Notebook, NotebookWidget, NotebookWidgetCore } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	applyNotebookCommands,
	describeNotebook,
	type NotebookAgentContext,
	notebookWidgetAgentTypes,
	stampNotebook,
	toNotebookWidgetCore,
} from "../src/notebook/notebookAgent.ts";

const NOW = "2026-10-14T00:00:00.000Z";
const EARLIER = "2026-10-13T00:00:00.000Z";

function context(known: readonly string[] = ["comp-1", "comp-2"]): NotebookAgentContext {
	let counter = 0;
	return {
		knownComponentIds: new Set(known),
		newWidgetId: () => {
			counter += 1;
			return `w-new-${counter}`;
		},
	};
}

function textWidget(widgetId: string, title = "Notes"): NotebookWidget {
	return {
		widgetId,
		type: "text",
		title,
		size: "medium",
		text: "hello",
		createdAt: EARLIER,
		updatedAt: EARLIER,
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	};
}

function notebookOf(widgets: readonly NotebookWidget[]): Notebook {
	return { widgets: [...widgets] };
}

describe("describeNotebook", () => {
	it("lists the stored widgets for an agent", async () => {
		const described = await describeNotebook(notebookOf([textWidget("w-1")]), context());
		if (!described.ok) throw new Error("expected a snapshot");
		expect(described.value.widgets.map((widget) => widget.widgetId)).toEqual(["w-1"]);
		expect(described.value.widgetTypes.map((entry) => entry.type).sort()).toEqual([
			"chart",
			"metric",
			"research",
			"table",
			"text",
		]);
	});
});

describe("applyNotebookCommands", () => {
	it("adds a text widget with a server id and reports it", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([textWidget("w-1")]),
			[{ kind: "add", type: "text", title: "New", config: { text: "body" } }],
			context(),
		);
		if (!applied.ok) throw new Error(`expected success: ${applied.error.failure.message}`);
		expect(applied.value.widgets.map((widget) => widget.widgetId)).toEqual(["w-1", "w-new-1"]);
		expect(applied.value.changes).toMatchObject([
			{ widgetId: "w-new-1", kind: "added", title: "New" },
		]);
	});

	it("adds a metric, a chart and a table through their configs", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([]),
			[
				{
					kind: "add",
					type: "metric",
					title: "M",
					config: { value: 3, unit: "x", change: null, caption: "", asOf: null },
				},
				{
					kind: "add",
					type: "chart",
					title: "C",
					config: {
						chartType: "line",
						unit: "",
						series: [{ name: "s", points: [{ x: "a", y: 1 }] }],
					},
				},
				{
					kind: "add",
					type: "table",
					title: "T",
					config: { columns: ["a"], rows: [["b"]] },
				},
			],
			context(),
		);
		if (!applied.ok) throw new Error(`expected success: ${applied.error.failure.message}`);
		expect(applied.value.widgets.map((widget) => widget.type)).toEqual([
			"metric",
			"chart",
			"table",
		]);
	});

	it("adds a research widget only for a known canvas component", async () => {
		const known = await applyNotebookCommands(
			notebookOf([]),
			[{ kind: "add", type: "research", title: "R", config: { componentId: "comp-1" } }],
			context(),
		);
		if (!known.ok) throw new Error(`expected success: ${known.error.failure.message}`);
		expect(known.value.widgets).toHaveLength(1);

		const unknown = await applyNotebookCommands(
			notebookOf([]),
			[{ kind: "add", type: "research", title: "R", config: { componentId: "comp-9" } }],
			context(),
		);
		if (unknown.ok) throw new Error("expected an unknown component to fail");
		expect(unknown.error.index).toBe(0);
		expect(unknown.error.failure.code).toBe("INVALID_WIDGET");
		expect(unknown.error.failure.message).toContain("componentId");
	});

	it("rejects a research size the type does not allow", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([]),
			[
				{
					kind: "add",
					type: "research",
					title: "R",
					size: "small",
					config: { componentId: "comp-1" },
				},
			],
			context(),
		);
		if (applied.ok) throw new Error("expected a size failure");
		expect(applied.error.failure.code).toBe("SIZE_NOT_ALLOWED");
	});

	it("rejects an unknown widget type", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([]),
			[{ kind: "add", type: "photo", title: "P" }],
			context(),
		);
		if (applied.ok) throw new Error("expected an unknown type to fail");
		expect(applied.error.failure.code).toBe("UNKNOWN_WIDGET_TYPE");
	});

	it("updates, moves, reorders and resizes with one change entry each", async () => {
		const start = notebookOf([textWidget("w-1", "First"), textWidget("w-2", "Second")]);
		const applied = await applyNotebookCommands(
			start,
			[
				{ kind: "update", widgetId: "w-1", config: { text: "changed" } },
				{ kind: "move", widgetId: "w-1", direction: "later" },
				{ kind: "resize", widgetId: "w-2", size: "large" },
				{ kind: "reorder", widgetId: "w-2", toIndex: 1 },
			],
			context(),
		);
		if (!applied.ok) throw new Error(`expected success: ${applied.error.failure.message}`);
		expect(applied.value.changes.map((change) => change.kind)).toEqual([
			"updated",
			"moved",
			"resized",
			"moved",
		]);
		expect(applied.value.widgets.map((widget) => widget.widgetId)).toEqual(["w-1", "w-2"]);
		expect(applied.value.widgets.find((widget) => widget.widgetId === "w-2")?.size).toBe("large");
	});

	it("refuses an update that changes nothing", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([textWidget("w-1")]),
			[{ kind: "update", widgetId: "w-1" }],
			context(),
		);
		if (applied.ok) throw new Error("expected an empty update to fail");
		expect(applied.error.failure.code).toBe("INVALID_COMMAND");
	});

	it("refuses a removal: the owner confirms removals", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([textWidget("w-1")]),
			[{ kind: "remove", widgetId: "w-1" }],
			context(),
		);
		if (applied.ok) throw new Error("expected a removal to fail");
		expect(applied.error.index).toBe(0);
		expect(applied.error.failure.code).toBe("INVALID_COMMAND");
		expect(applied.error.failure.message).toContain("proposed");
	});

	it("duplicates a widget right after the original and reports it as duplicated", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([textWidget("w-1"), textWidget("w-2")]),
			[{ kind: "duplicate", widgetId: "w-1" }],
			context(),
		);
		if (!applied.ok) throw new Error(applied.error.failure.message);
		const [original, copy, last] = applied.value.widgets;
		expect(original?.widgetId).toBe("w-1");
		expect(copy?.widgetId).not.toBe("w-1");
		expect(copy?.title).toBe(`${original?.title} (copy)`);
		expect(copy?.type === "text" && original?.type === "text" && copy.text === original.text).toBe(
			true,
		);
		expect(last?.widgetId).toBe("w-2");
		expect(applied.value.changes.map((change) => change.kind)).toEqual(["duplicated"]);
	});

	it("names an unknown widget id", async () => {
		const applied = await applyNotebookCommands(
			notebookOf([textWidget("w-1")]),
			[{ kind: "update", widgetId: "w-9", config: { text: "x" } }],
			context(),
		);
		if (applied.ok) throw new Error("expected an unknown id to fail");
		expect(applied.error.failure.code).toBe("WIDGET_NOT_FOUND");
	});

	it("applies nothing when a later command fails, and leaves the input alone", async () => {
		const start = notebookOf([textWidget("w-1")]);
		const before = JSON.stringify(start);
		const applied = await applyNotebookCommands(
			start,
			[
				{ kind: "add", type: "text", title: "New", config: { text: "body" } },
				{ kind: "update", widgetId: "w-9", config: { text: "x" } },
			],
			context(),
		);
		if (applied.ok) throw new Error("expected the turn to fail");
		expect(applied.error.index).toBe(1);
		expect(applied.error.failure.code).toBe("WIDGET_NOT_FOUND");
		expect(JSON.stringify(start)).toBe(before);
	});

	it("refuses more than twelve commands per turn", async () => {
		const commands = Array.from({ length: 13 }, (_, index) => ({
			kind: "add",
			type: "text",
			title: `T${index}`,
			config: { text: "x" },
		}));
		const applied = await applyNotebookCommands(notebookOf([]), commands, context());
		if (applied.ok) throw new Error("expected the limit to fail");
		expect(applied.error.index).toBe(12);
		expect(applied.error.failure.code).toBe("INVALID_COMMAND");
	});
});

describe("stampNotebook", () => {
	const origin = { kind: "owner", messageId: null, runId: null, componentId: null } as const;

	it("stamps a new widget and keeps an unchanged one identical", async () => {
		const previous = notebookOf([textWidget("w-1")]);
		const core: NotebookWidgetCore = {
			widgetId: "w-1",
			type: "text",
			title: "Notes",
			size: "medium",
			text: "hello",
		};
		const fresh: NotebookWidgetCore = {
			widgetId: "w-2",
			type: "text",
			title: "New",
			size: "small",
			text: "body",
		};
		const stamped = stampNotebook(previous, [core, fresh], NOW, () => ({ ...origin }));
		expect(stamped.widgets[0]).toEqual(textWidget("w-1"));
		expect(stamped.widgets[1]).toMatchObject({
			widgetId: "w-2",
			createdAt: NOW,
			updatedAt: NOW,
			revision: 1,
			origin,
		});
	});

	it("bumps revision and updatedAt only for changed widgets", () => {
		const previous = notebookOf([textWidget("w-1")]);
		const changed: NotebookWidgetCore = {
			widgetId: "w-1",
			type: "text",
			title: "Notes",
			size: "medium",
			text: "changed",
		};
		const stamped = stampNotebook(previous, [changed], NOW, () => ({ ...origin }));
		expect(stamped.widgets[0]).toMatchObject({
			createdAt: EARLIER,
			updatedAt: NOW,
			revision: 2,
			origin,
		});
	});

	it("compares key-order independently", () => {
		const previous = notebookOf([textWidget("w-1")]);
		// Same widget, keys in another order: still unchanged.
		const reordered = {
			text: "hello",
			size: "medium",
			title: "Notes",
			type: "text",
			widgetId: "w-1",
		} as NotebookWidgetCore;
		const stamped = stampNotebook(previous, [reordered], NOW, () => ({ ...origin }));
		expect(stamped.widgets[0]).toEqual(textWidget("w-1"));
	});

	it("drops the server metadata back to a core", () => {
		expect(toNotebookWidgetCore(textWidget("w-1"))).toEqual({
			widgetId: "w-1",
			type: "text",
			title: "Notes",
			size: "medium",
			text: "hello",
		});
	});

	it("exposes one agent type per widget type", () => {
		expect(
			notebookWidgetAgentTypes(context())
				.map((entry) => entry.type)
				.sort(),
		).toEqual(["chart", "metric", "research", "table", "text"]);
	});
});
