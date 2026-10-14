import { describe, expect, it } from "vitest";
import { createWidgetAgentHost } from "../../src/agent/host.ts";
import type {
	WidgetAgentFailure,
	WidgetAgentHost,
	WidgetAgentType,
	WidgetSnapshot,
} from "../../src/agent/types.ts";
import { err, ok, type Result } from "../../src/core/types.ts";
import { bannerType, createToyStore, freshId, noteType, type ToyWidget, toy } from "./support.ts";

function expectSnapshot(result: Result<WidgetSnapshot, WidgetAgentFailure>): WidgetSnapshot {
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	return result.value;
}

function expectFailureCode(result: Result<WidgetSnapshot, WidgetAgentFailure>): WidgetAgentFailure {
	if (result.ok) throw new Error(`expected a failure, got ok ${JSON.stringify(result.value)}`);
	return result.error;
}

function hostOf(
	controls: ReturnType<typeof createToyStore>,
	extra?: Partial<Parameters<typeof createWidgetAgentHost<ToyWidget, number>>[0]>,
): WidgetAgentHost {
	return createWidgetAgentHost({
		store: controls.store,
		types: [noteType, bannerType],
		newWidgetId: freshId,
		...extra,
	});
}

describe("createWidgetAgentHost describe", () => {
	it("returns the grid, the types without functions, and the widgets with positions", async () => {
		const controls = createToyStore();
		const snapshot = expectSnapshot(await hostOf(controls).describe());
		expect(snapshot.protocolVersion).toBe(1);
		expect(snapshot.grid.narrowColumns).toBe(2);
		expect(snapshot.grid.wideColumns).toBe(4);
		expect(snapshot.grid.maxWidgets).toBe(24);
		expect(snapshot.grid.sizes).toEqual([
			{
				size: "small",
				shape: "1 × 1",
				narrow: { columns: 1, rows: 1 },
				wide: { columns: 1, rows: 1 },
			},
			{
				size: "medium",
				shape: "2 × 2",
				narrow: { columns: 2, rows: 2 },
				wide: { columns: 2, rows: 2 },
			},
			{
				size: "large",
				shape: "full width × 2",
				narrow: { columns: 2, rows: 2 },
				wide: { columns: 4, rows: 2 },
			},
		]);
		expect(snapshot.widgetTypes).toEqual([
			{
				type: "note",
				label: "Note",
				description: "A sticky note.",
				defaultSize: "small",
				sizes: ["small", "medium"],
				configSchema: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				},
			},
			{
				type: "banner",
				label: "Banner",
				description: "A full-width banner.",
				defaultSize: "large",
				sizes: ["large"],
				configSchema: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				},
			},
		]);
		expect(snapshot.widgets).toEqual([
			{
				widgetId: "a",
				type: "note",
				title: "Title a",
				size: "small",
				position: 0,
				config: { text: "Text a" },
			},
			{
				widgetId: "b",
				type: "note",
				title: "Title b",
				size: "small",
				position: 1,
				config: { text: "Text b" },
			},
		]);
	});

	it("reports a custom limit in the snapshot", async () => {
		const controls = createToyStore();
		const snapshot = expectSnapshot(
			await hostOf(controls, { limits: { maxWidgets: 2 } }).describe(),
		);
		expect(snapshot.grid.maxWidgets).toBe(2);
	});

	it("maps a throwing store to STORE_UNAVAILABLE", async () => {
		const controls = createToyStore();
		controls.throwOnRead();
		const failure = expectFailureCode(await hostOf(controls).describe());
		expect(failure.code).toBe("STORE_UNAVAILABLE");
	});
});

describe("createWidgetAgentHost apply", () => {
	it("adds with defaults and at a position", async () => {
		const controls = createToyStore([]);
		const host = hostOf(controls);
		const added = expectSnapshot(
			await host.apply({ kind: "add", type: "note", title: "First", config: { text: "one" } }),
		);
		expect(added.widgets.map((widget) => widget.widgetId)).toHaveLength(1);
		expect(added.widgets[0]).toMatchObject({ type: "note", title: "First", size: "small" });
		const placed = expectSnapshot(
			await host.apply({
				kind: "add",
				type: "banner",
				title: "Top",
				config: { text: "top" },
				toIndex: 0,
			}),
		);
		expect(placed.widgets.map((widget) => widget.title)).toEqual(["Top", "First"]);
		expect(placed.widgets.map((widget) => widget.position)).toEqual([0, 1]);
	});

	it("removes, moves and reorders", async () => {
		const controls = createToyStore([toy("a"), toy("b"), toy("c")]);
		const host = hostOf(controls);
		expect(
			expectSnapshot(await host.apply({ kind: "remove", widgetId: "b" })).widgets.map(
				(widget) => widget.widgetId,
			),
		).toEqual(["a", "c"]);
		expect(
			expectSnapshot(
				await host.apply({ kind: "move", widgetId: "c", direction: "earlier" }),
			).widgets.map((widget) => widget.widgetId),
		).toEqual(["c", "a"]);
		expect(
			expectSnapshot(await host.apply({ kind: "reorder", widgetId: "c", toIndex: 1 })).widgets.map(
				(widget) => widget.widgetId,
			),
		).toEqual(["a", "c"]);
	});

	it("resizes within the type's sizes", async () => {
		const controls = createToyStore();
		const resized = expectSnapshot(
			await hostOf(controls).apply({ kind: "resize", widgetId: "a", size: "medium" }),
		);
		expect(resized.widgets.map((widget) => widget.size)).toEqual(["medium", "small"]);
	});

	it("updates the title, the config, or both with a shallow merge", async () => {
		const controls = createToyStore();
		const host = hostOf(controls);
		const renamed = expectSnapshot(
			await host.apply({ kind: "update", widgetId: "a", title: "Renamed" }),
		);
		expect(renamed.widgets[0]).toMatchObject({ title: "Renamed", config: { text: "Text a" } });
		const reconfigured = expectSnapshot(
			await host.apply({ kind: "update", widgetId: "a", config: { text: "changed" } }),
		);
		expect(reconfigured.widgets[0]).toMatchObject({
			title: "Renamed",
			config: { text: "changed" },
		});
	});

	it("reports every failure code with one sentence", async () => {
		const controls = createToyStore();
		const host = hostOf(controls);
		expect(expectFailureCode(await host.apply({ kind: "remove", widgetId: "missing" })).code).toBe(
			"WIDGET_NOT_FOUND",
		);
		expect(
			expectFailureCode(await host.apply({ kind: "move", widgetId: "a", direction: "earlier" }))
				.code,
		).toBe("MOVE_AT_END");
		expect(
			expectFailureCode(await host.apply({ kind: "reorder", widgetId: "a", toIndex: 99 })).code,
		).toBe("POSITION_OUT_OF_RANGE");
		expect(
			expectFailureCode(await host.apply({ kind: "add", type: "ghost", title: "G" })).code,
		).toBe("UNKNOWN_WIDGET_TYPE");
		expect(
			expectFailureCode(
				await host.apply({ kind: "add", type: "note", title: "Big", size: "large" }),
			).code,
		).toBe("SIZE_NOT_ALLOWED");
		expect(
			expectFailureCode(await host.apply({ kind: "resize", widgetId: "a", size: "large" })).code,
		).toBe("SIZE_NOT_ALLOWED");
		expect(
			expectFailureCode(
				await host.apply({ kind: "add", type: "note", title: "Bad", config: { text: "" } }),
			).code,
		).toBe("INVALID_WIDGET");
		expect(expectFailureCode(await host.apply({ kind: "add", type: "note", title: 42 })).code).toBe(
			"INVALID_COMMAND",
		);
		for (const failure of [
			expectFailureCode(await host.apply({ kind: "remove", widgetId: "missing" })),
			expectFailureCode(await host.apply({ kind: "add", type: "ghost", title: "G" })),
		]) {
			expect(failure.message).toMatch(/^[^.]*\.$/);
		}
	});

	it("enforces the widget limit", async () => {
		const controls = createToyStore();
		const failure = expectFailureCode(
			await hostOf(controls, { limits: { maxWidgets: 2 } }).apply({
				kind: "add",
				type: "note",
				title: "Third",
				config: { text: "three" },
			}),
		);
		expect(failure.code).toBe("TOO_MANY_WIDGETS");
	});

	it("runs the host's whole-layout rules after the edit", async () => {
		const controls = createToyStore();
		const host = hostOf(controls, {
			validateLayout: (widgets) =>
				widgets.some((widget) => widget.size === "medium")
					? err("no medium widgets on this grid.")
					: ok(undefined),
		});
		const failure = expectFailureCode(
			await host.apply({ kind: "resize", widgetId: "a", size: "medium" }),
		);
		expect(failure).toEqual({ code: "INVALID_WIDGET", message: "no medium widgets on this grid." });
		expect(controls.snapshot().widgets.map((widget) => widget.size)).toEqual(["small", "small"]);
	});

	it("passes a store conflict through and keeps the layout", async () => {
		const controls = createToyStore();
		controls.conflictNextWrite();
		const failure = expectFailureCode(
			await hostOf(controls).apply({ kind: "remove", widgetId: "a" }),
		);
		expect(failure.code).toBe("CONFLICT");
		expect(controls.snapshot().widgets.map((widget) => widget.widgetId)).toEqual(["a", "b"]);
	});

	it("maps throwing stores, builds and id allocation to typed failures", async () => {
		const readControls = createToyStore();
		readControls.throwOnRead();
		expect(
			expectFailureCode(await hostOf(readControls).apply({ kind: "remove", widgetId: "a" })).code,
		).toBe("STORE_UNAVAILABLE");
		const writeControls = createToyStore();
		writeControls.throwOnWrite();
		expect(
			expectFailureCode(await hostOf(writeControls).apply({ kind: "remove", widgetId: "a" })).code,
		).toBe("STORE_UNAVAILABLE");
		expect(writeControls.snapshot().widgets.map((widget) => widget.widgetId)).toEqual(["a", "b"]);

		const throwingBuild: WidgetAgentType<ToyWidget> = {
			...noteType,
			type: "evil",
			build: () => {
				throw new Error("build blew up");
			},
		};
		const evilControls = createToyStore([]);
		const evil = createWidgetAgentHost({
			store: evilControls.store,
			types: [throwingBuild],
			newWidgetId: freshId,
		});
		expect(
			expectFailureCode(await evil.apply({ kind: "add", type: "evil", title: "E" })).code,
		).toBe("INVALID_WIDGET");

		const idControls = createToyStore([]);
		const noId = createWidgetAgentHost({
			store: idControls.store,
			types: [noteType],
			newWidgetId: () => {
				throw new Error("no ids");
			},
		});
		expect(
			expectFailureCode(await noId.apply({ kind: "add", type: "note", title: "N" })).code,
		).toBe("STORE_UNAVAILABLE");
	});

	it("maps a throwing configOf to INVALID_WIDGET", async () => {
		const unreadable: WidgetAgentType<ToyWidget> = {
			...noteType,
			configOf: () => {
				throw new Error("cannot read");
			},
		};
		const controls = createToyStore();
		const host = createWidgetAgentHost({
			store: controls.store,
			types: [unreadable, bannerType],
			newWidgetId: freshId,
		});
		expect(expectFailureCode(await host.describe()).code).toBe("INVALID_WIDGET");
		expect(
			expectFailureCode(await host.apply({ kind: "update", widgetId: "a", title: "T" })).code,
		).toBe("INVALID_WIDGET");
	});

	it("lists an unregistered widget but only moves, reorders and removes it", async () => {
		const ghost: ToyWidget = {
			widgetId: "g1",
			type: "ghost",
			title: "Ghost",
			size: "small",
			text: "boo",
		};
		const controls = createToyStore([toy("a"), ghost]);
		const host = hostOf(controls);
		const described = expectSnapshot(await host.describe());
		expect(described.widgets[1]).toEqual({
			widgetId: "g1",
			type: "ghost",
			title: "Ghost",
			size: "small",
			position: 1,
			config: {},
		});
		expect(
			expectSnapshot(
				await host.apply({ kind: "move", widgetId: "g1", direction: "earlier" }),
			).widgets.map((widget) => widget.widgetId),
		).toEqual(["g1", "a"]);
		expect(
			expectSnapshot(await host.apply({ kind: "reorder", widgetId: "g1", toIndex: 1 })).widgets.map(
				(widget) => widget.widgetId,
			),
		).toEqual(["a", "g1"]);
		expect(
			expectFailureCode(await host.apply({ kind: "resize", widgetId: "g1", size: "medium" })).code,
		).toBe("UNKNOWN_WIDGET_TYPE");
		expect(
			expectFailureCode(await host.apply({ kind: "update", widgetId: "g1", title: "G" })).code,
		).toBe("UNKNOWN_WIDGET_TYPE");
		expect(
			expectSnapshot(await host.apply({ kind: "remove", widgetId: "g1" })).widgets.map(
				(widget) => widget.widgetId,
			),
		).toEqual(["a"]);
	});

	it("leaves the store untouched when a command fails", async () => {
		const controls = createToyStore();
		const host = hostOf(controls, {
			validateLayout: () => err("always rejected."),
		});
		const before = controls.snapshot();
		for (const command of [
			{ kind: "add", type: "ghost", title: "G" },
			{ kind: "add", type: "note", title: "Bad", config: { text: "" } },
			{ kind: "remove", widgetId: "missing" },
			{ kind: "resize", widgetId: "a", size: "medium" },
			{ kind: "bogus" },
		]) {
			const failure = expectFailureCode(await host.apply(command));
			expect(failure.code).toBeDefined();
		}
		expect(controls.snapshot()).toEqual(before);
	});
});
