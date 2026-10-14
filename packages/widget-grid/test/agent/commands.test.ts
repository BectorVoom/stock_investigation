import { describe, expect, it } from "vitest";
import { parseWidgetCommand } from "../../src/agent/commands.ts";
import type { WidgetAgentFailure, WidgetCommand } from "../../src/agent/types.ts";

function expectCommand(input: unknown): WidgetCommand {
	const result = parseWidgetCommand(input);
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	return result.value;
}

function expectFailure(input: unknown): WidgetAgentFailure {
	const result = parseWidgetCommand(input);
	if (result.ok) throw new Error(`expected a failure, got ok ${JSON.stringify(result.value)}`);
	return result.error;
}

describe("parseWidgetCommand", () => {
	it("accepts every kind", () => {
		expect(expectCommand({ kind: "add", type: "note", title: "Hello" })).toEqual({
			kind: "add",
			type: "note",
			title: "Hello",
		});
		expect(
			expectCommand({
				kind: "add",
				type: "note",
				title: "Hello",
				size: "large",
				config: { text: "hi" },
				toIndex: 2,
			}),
		).toMatchObject({ kind: "add", size: "large", toIndex: 2 });
		expect(expectCommand({ kind: "remove", widgetId: "a" })).toEqual({
			kind: "remove",
			widgetId: "a",
		});
		expect(expectCommand({ kind: "move", widgetId: "a", direction: "earlier" })).toEqual({
			kind: "move",
			widgetId: "a",
			direction: "earlier",
		});
		expect(expectCommand({ kind: "reorder", widgetId: "a", toIndex: 0 })).toEqual({
			kind: "reorder",
			widgetId: "a",
			toIndex: 0,
		});
		expect(expectCommand({ kind: "resize", widgetId: "a", size: "medium" })).toEqual({
			kind: "resize",
			widgetId: "a",
			size: "medium",
		});
		expect(expectCommand({ kind: "update", widgetId: "a", title: "New" })).toEqual({
			kind: "update",
			widgetId: "a",
			title: "New",
		});
		expect(expectCommand({ kind: "update", widgetId: "a", config: { text: "x" } })).toEqual({
			kind: "update",
			widgetId: "a",
			config: { text: "x" },
		});
		expect(expectCommand({ kind: "duplicate", widgetId: "a" })).toEqual({
			kind: "duplicate",
			widgetId: "a",
		});
		expect(
			expectCommand({ kind: "duplicate", widgetId: "a", title: "Copy", toIndex: 0 }),
		).toMatchObject({ kind: "duplicate", title: "Copy", toIndex: 0 });
	});

	it("trims the title", () => {
		const command = expectCommand({ kind: "add", type: "note", title: "  Hello  " });
		if (command.kind !== "add") throw new Error("wrong kind");
		expect(command.title).toBe("Hello");
	});

	it("rejects unknown kinds and unknown fields, naming them", () => {
		const kind = expectFailure({ kind: "explode", widgetId: "a" });
		expect(kind.code).toBe("INVALID_COMMAND");
		expect(kind.message).toContain("kind");
		const field = expectFailure({ kind: "remove", widgetId: "a", force: true });
		expect(field.code).toBe("INVALID_COMMAND");
		expect(field.message).toContain("force");
		const duplicateField = expectFailure({
			kind: "duplicate",
			widgetId: "a",
			config: { text: "x" },
		});
		expect(duplicateField.code).toBe("INVALID_COMMAND");
		expect(duplicateField.message).toContain("config");
	});

	it("rejects out-of-bounds fields, naming them", () => {
		for (const widgetId of ["", "x".repeat(121)]) {
			const failure = expectFailure({ kind: "remove", widgetId });
			expect(failure.code).toBe("INVALID_COMMAND");
			expect(failure.message).toContain("widgetId");
		}
		for (const type of ["", "t".repeat(81)]) {
			const failure = expectFailure({ kind: "add", type, title: "T" });
			expect(failure.message).toContain("type");
		}
		for (const title of ["", "   ", "t".repeat(201)]) {
			const failure = expectFailure({ kind: "add", type: "note", title });
			expect(failure.message).toContain("title");
		}
		for (const title of ["", "   ", "t".repeat(201)]) {
			const failure = expectFailure({ kind: "duplicate", widgetId: "a", title });
			expect(failure.message).toContain("title");
		}
		for (const toIndex of [-1, 1.5, 1001, Number.NaN]) {
			const failure = expectFailure({ kind: "reorder", widgetId: "a", toIndex });
			expect(failure.message).toContain("toIndex");
		}
		for (const toIndex of [-1, 1.5, 1001, Number.NaN]) {
			const failure = expectFailure({ kind: "duplicate", widgetId: "a", toIndex });
			expect(failure.message).toContain("toIndex");
		}
		for (const config of ["text", 42, ["text"], null]) {
			const failure = expectFailure({ kind: "add", type: "note", title: "T", config });
			expect(failure.message).toContain("config");
		}
		expect(expectFailure({ kind: "resize", widgetId: "a", size: "huge" }).message).toContain(
			"size",
		);
		expect(expectFailure({ kind: "move", widgetId: "a", direction: "up" }).message).toContain(
			"direction",
		);
	});

	it("rejects an update with neither title nor config", () => {
		const failure = expectFailure({ kind: "update", widgetId: "a" });
		expect(failure.code).toBe("INVALID_COMMAND");
		expect(failure.message).toContain("title");
		expect(failure.message).toContain("config");
	});

	it("rejects missing required fields and non-objects", () => {
		expect(expectFailure({ kind: "remove" }).message).toContain("widgetId");
		expect(expectFailure({ kind: "add", title: "T" }).message).toContain("type");
		for (const input of [null, 42, "add", [], { kind: "remove", widgetId: "a", extra: 1 }]) {
			expect(expectFailure(input).code).toBe("INVALID_COMMAND");
		}
	});
});
