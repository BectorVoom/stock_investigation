/**
 * The notebook as the widget-grid agent layer sees it (ADR-0020): the seam
 * both the runner and the API validate assistant commands through. These
 * tests pin the seam's behaviour — every command kind, the `remove`
 * refusal, all-or-nothing application, metadata stamping and the research
 * component rule.
 */
import {
	NOTEBOOK_LIMITS,
	type Notebook,
	type NotebookWidget,
	type NotebookWidgetCore,
	notebookContentBytes,
} from "@research/contracts";
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

function textWidget(widgetId: string, title = "Notes", text = "hello"): NotebookWidget {
	return {
		widgetId,
		type: "text",
		title,
		size: "medium",
		text,
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

	it("reports the widget the command moved, not the neighbour it displaced", async () => {
		const start = notebookOf([
			textWidget("w-1", "First"),
			textWidget("w-2", "Second"),
			textWidget("w-3", "Third"),
		]);
		const applied = await applyNotebookCommands(
			start,
			[
				{ kind: "move", widgetId: "w-1", direction: "later" },
				{ kind: "reorder", widgetId: "w-1", toIndex: 2 },
				{ kind: "move", widgetId: "w-1", direction: "earlier" },
			],
			context(),
		);
		if (!applied.ok) throw new Error(`expected success: ${applied.error.failure.message}`);
		expect(applied.value.changes).toEqual([
			expect.objectContaining({
				widgetId: "w-1",
				title: "First",
				before: "position 1",
				after: "position 2",
			}),
			expect.objectContaining({ widgetId: "w-1", before: "position 2", after: "position 3" }),
			expect.objectContaining({ widgetId: "w-1", before: "position 3", after: "position 2" }),
		]);
		expect(applied.value.changes.every((change) => change.kind === "moved")).toBe(true);

		// A reorder to the widget's own position moves nothing and reports nothing.
		const stay = await applyNotebookCommands(
			start,
			[{ kind: "reorder", widgetId: "w-2", toIndex: 1 }],
			context(),
		);
		if (!stay.ok) throw new Error(`expected success: ${stay.error.failure.message}`);
		expect(stay.value.changes).toEqual([]);
	});

	it("adds up to the widget maximum and refuses the next one", async () => {
		const full = notebookOf(
			Array.from({ length: NOTEBOOK_LIMITS.maxWidgets - 1 }, (_, index) =>
				textWidget(`w-${index}`),
			),
		);
		const add = { kind: "add", type: "text", title: "Last", config: { text: "x" } };
		const applied = await applyNotebookCommands(full, [add], context());
		if (!applied.ok) throw new Error(`expected success: ${applied.error.failure.message}`);
		expect(applied.value.widgets).toHaveLength(NOTEBOOK_LIMITS.maxWidgets);
		const over = await applyNotebookCommands(
			notebookOf([...full.widgets, textWidget("w-x")]),
			[add],
			context(),
		);
		if (over.ok) throw new Error("expected the widget maximum to refuse the add");
		expect(over.error.failure.code).toBe("TOO_MANY_WIDGETS");
	});

	it("refuses a turn that grows the notebook past its byte cap, all or nothing", async () => {
		const big = (widgetId: string): NotebookWidget =>
			textWidget(widgetId, "Notes", "y".repeat(NOTEBOOK_LIMITS.maxTextChars));
		// Just under the cap: one duplicate still fits, the second does not.
		const perWidget = notebookContentBytes([big("w-0")]);
		const count = Math.floor(NOTEBOOK_LIMITS.maxContentBytes / perWidget) - 1;
		const start = notebookOf(Array.from({ length: count }, (_, index) => big(`w-${index}`)));
		expect(notebookContentBytes(start.widgets) + perWidget).toBeLessThanOrEqual(
			NOTEBOOK_LIMITS.maxContentBytes,
		);
		expect(notebookContentBytes(start.widgets) + 2 * perWidget).toBeGreaterThan(
			NOTEBOOK_LIMITS.maxContentBytes,
		);
		const applied = await applyNotebookCommands(
			start,
			[
				{ kind: "resize", widgetId: "w-0", size: "large" },
				{ kind: "duplicate", widgetId: "w-1" },
				{ kind: "duplicate", widgetId: "w-2" },
			],
			context(),
		);
		if (applied.ok) throw new Error("expected the byte cap to refuse the turn");
		expect(applied.error.index).toBe(2);
		expect(applied.error.failure.code).toBe("NOTEBOOK_TOO_LARGE");
		// The same notebook still takes commands that do not grow it.
		const rearranged = await applyNotebookCommands(
			start,
			[{ kind: "reorder", widgetId: "w-0", toIndex: count - 1 }],
			context(),
		);
		expect(rearranged.ok).toBe(true);
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

	it("compares nested content cell by cell, whatever the key order", () => {
		const table: NotebookWidget = {
			widgetId: "w-t",
			type: "table",
			title: "Table",
			size: "medium",
			columns: ["Year", "Revenue"],
			rows: [
				["2025", 10],
				["2026", null],
			],
			createdAt: EARLIER,
			updatedAt: EARLIER,
			revision: 2,
			origin,
		};
		const previous = notebookOf([table]);
		// The same content with keys in another order, as a client may send it.
		const reordered: NotebookWidgetCore = {
			rows: [
				["2025", 10],
				["2026", null],
			],
			columns: ["Year", "Revenue"],
			size: "medium",
			title: "Table",
			type: "table",
			widgetId: "w-t",
		};
		expect(stampNotebook(previous, [reordered], NOW, () => origin).widgets[0]).toMatchObject({
			updatedAt: EARLIER,
			revision: 2,
		});
		for (const rows of [
			[
				["2025", 10],
				["2026", 0],
			],
			[["2025", 10]],
			[
				["2025", "10"],
				["2026", null],
			],
			[
				["2025", 10],
				["2026", null],
				["2027", 1],
			],
		]) {
			const edited: NotebookWidgetCore = { ...reordered, rows };
			expect(stampNotebook(previous, [edited], NOW, () => origin).widgets[0]).toMatchObject({
				updatedAt: NOW,
				revision: 3,
			});
		}
		// A field on one side only is a difference, whichever side has it.
		const withExtra = { ...reordered, note: "x" };
		const extraCore: NotebookWidgetCore = withExtra;
		expect(stampNotebook(previous, [extraCore], NOW, () => origin).widgets[0]?.revision).toBe(3);
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
