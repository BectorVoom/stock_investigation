import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	applyWidgetLayoutEdit,
	DEFAULT_WIDGET_LAYOUT_LIMITS,
	type WidgetLayoutEdit,
} from "../../src/core/layout.ts";
import type { WidgetBase, WidgetSize } from "../../src/core/types.ts";

interface NoteWidget extends WidgetBase {
	readonly type: "note";
	readonly text: string;
}

const note = (
	widgetId: string,
	size: WidgetSize = "small",
	text = `Note ${widgetId}`,
): NoteWidget => ({
	widgetId,
	type: "note",
	title: `Note ${widgetId}`,
	size,
	text,
});

const idsOf = (widgets: readonly WidgetBase[]): string[] =>
	widgets.map((widget) => widget.widgetId);

function expectOkEdit(
	widgets: readonly NoteWidget[],
	edit: WidgetLayoutEdit<NoteWidget>,
): readonly NoteWidget[] {
	const result = applyWidgetLayoutEdit(widgets, edit);
	if (!result.ok) throw new Error(`expected ok, got error ${result.error}`);
	return result.value;
}

function expectErrEdit(widgets: readonly NoteWidget[], edit: WidgetLayoutEdit<NoteWidget>): string {
	const result = applyWidgetLayoutEdit(widgets, edit);
	if (result.ok) throw new Error(`expected an error, got ok ${JSON.stringify(result.value)}`);
	return result.error;
}

const one: readonly NoteWidget[] = [note("a")];
const two: readonly NoteWidget[] = [note("a"), note("b")];

describe("applyWidgetLayoutEdit", () => {
	it("adds a widget at the end", () => {
		expect(idsOf(expectOkEdit(one, { kind: "add", widget: note("b") }))).toEqual(["a", "b"]);
	});

	it("adds a widget at a position as append followed by reorder", () => {
		const three: readonly NoteWidget[] = [note("a"), note("b"), note("c")];
		// First, middle, last of the four-widget result.
		expect(idsOf(expectOkEdit(three, { kind: "add", widget: note("x"), toIndex: 0 }))).toEqual([
			"x",
			"a",
			"b",
			"c",
		]);
		expect(idsOf(expectOkEdit(three, { kind: "add", widget: note("x"), toIndex: 2 }))).toEqual([
			"a",
			"b",
			"x",
			"c",
		]);
		expect(idsOf(expectOkEdit(three, { kind: "add", widget: note("x"), toIndex: 3 }))).toEqual([
			"a",
			"b",
			"c",
			"x",
		]);
		// No toIndex appends.
		expect(idsOf(expectOkEdit(three, { kind: "add", widget: note("x") }))).toEqual([
			"a",
			"b",
			"c",
			"x",
		]);
	});

	it("rejects an add with a duplicate id, an invalid widget, a full grid or a bad position", () => {
		expect(expectErrEdit(one, { kind: "add", widget: note("a") })).toBe("DUPLICATE_WIDGET_ID");
		expect(expectErrEdit(one, { kind: "add", widget: note("") })).toBe("INVALID_WIDGET");
		expect(
			expectErrEdit(one, {
				kind: "add",
				widget: note("b", "tiny" as WidgetSize),
			}),
		).toBe("INVALID_WIDGET");
		const full: readonly NoteWidget[] = Array.from({ length: 24 }, (_, index) => note(`w${index}`));
		expect(expectErrEdit(full, { kind: "add", widget: note("extra") })).toBe("TOO_MANY_WIDGETS");
		// A duplicate on a full grid still reports the id: the append runs first.
		expect(expectErrEdit(full, { kind: "add", widget: note("w0", "small"), toIndex: 0 })).toBe(
			"DUPLICATE_WIDGET_ID",
		);
		for (const toIndex of [-1, 2, 99, 1.5, Number.NaN]) {
			expect(
				expectErrEdit(one, { kind: "add", widget: note("b"), toIndex }),
				`toIndex ${String(toIndex)}`,
			).toBe("POSITION_OUT_OF_RANGE");
		}
	});

	it("removes exactly that widget and keeps the order of the rest", () => {
		const three: readonly NoteWidget[] = [note("a"), note("b"), note("c")];
		expect(idsOf(expectOkEdit(three, { kind: "remove", widgetId: "b" }))).toEqual(["a", "c"]);
		expect(expectErrEdit(one, { kind: "remove", widgetId: "missing" })).toBe("WIDGET_NOT_FOUND");
		expect(expectErrEdit(one, { kind: "remove", widgetId: "" })).toBe("INVALID_WIDGET");
	});

	it("moves a widget earlier and later, and errors at the ends", () => {
		expect(idsOf(expectOkEdit(two, { kind: "move", widgetId: "b", direction: "earlier" }))).toEqual(
			["b", "a"],
		);
		expect(idsOf(expectOkEdit(two, { kind: "move", widgetId: "a", direction: "later" }))).toEqual([
			"b",
			"a",
		]);
		expect(expectErrEdit(two, { kind: "move", widgetId: "a", direction: "earlier" })).toBe(
			"MOVE_AT_END",
		);
		expect(expectErrEdit(two, { kind: "move", widgetId: "b", direction: "later" })).toBe(
			"MOVE_AT_END",
		);
		expect(expectErrEdit(one, { kind: "move", widgetId: "missing", direction: "later" })).toBe(
			"WIDGET_NOT_FOUND",
		);
		expect(expectErrEdit(one, { kind: "move", widgetId: "", direction: "later" })).toBe(
			"INVALID_WIDGET",
		);
	});

	it("reorders a widget to an absolute index", () => {
		const four: readonly NoteWidget[] = [note("a"), note("b"), note("c"), note("d")];
		expect(idsOf(expectOkEdit(four, { kind: "reorder", widgetId: "a", toIndex: 3 }))).toEqual([
			"b",
			"c",
			"d",
			"a",
		]);
		expect(idsOf(expectOkEdit(four, { kind: "reorder", widgetId: "d", toIndex: 0 }))).toEqual([
			"d",
			"a",
			"b",
			"c",
		]);
		expect(idsOf(expectOkEdit(four, { kind: "reorder", widgetId: "b", toIndex: 2 }))).toEqual([
			"a",
			"c",
			"b",
			"d",
		]);
		expect(idsOf(expectOkEdit(four, { kind: "reorder", widgetId: "c", toIndex: 1 }))).toEqual([
			"a",
			"c",
			"b",
			"d",
		]);
	});

	it("treats a reorder to the current index as a no-op copy", () => {
		const four: readonly NoteWidget[] = [note("a"), note("b"), note("c"), note("d")];
		const next = expectOkEdit(four, { kind: "reorder", widgetId: "b", toIndex: 1 });
		expect(idsOf(next)).toEqual(["a", "b", "c", "d"]);
		expect(next).not.toBe(four);
	});

	it("rejects a reorder with an unknown id or an out-of-range index", () => {
		const four: readonly NoteWidget[] = [note("a"), note("b"), note("c"), note("d")];
		expect(expectErrEdit(four, { kind: "reorder", widgetId: "missing", toIndex: 0 })).toBe(
			"WIDGET_NOT_FOUND",
		);
		// The id check runs first: unknown id plus a bad index still reports the id.
		expect(expectErrEdit(four, { kind: "reorder", widgetId: "missing", toIndex: 99 })).toBe(
			"WIDGET_NOT_FOUND",
		);
		expect(expectErrEdit(four, { kind: "reorder", widgetId: "", toIndex: 0 })).toBe(
			"INVALID_WIDGET",
		);
		for (const toIndex of [-1, 4, 1.5, Number.NaN]) {
			expect(
				expectErrEdit(four, { kind: "reorder", widgetId: "a", toIndex }),
				`toIndex ${String(toIndex)}`,
			).toBe("POSITION_OUT_OF_RANGE");
		}
	});

	it("reorders a single-widget grid", () => {
		expect(idsOf(expectOkEdit(one, { kind: "reorder", widgetId: "a", toIndex: 0 }))).toEqual(["a"]);
		expect(expectErrEdit(one, { kind: "reorder", widgetId: "a", toIndex: 1 })).toBe(
			"POSITION_OUT_OF_RANGE",
		);
		expect(expectErrEdit([], { kind: "reorder", widgetId: "a", toIndex: 0 })).toBe(
			"WIDGET_NOT_FOUND",
		);
	});

	it("resizes one widget and leaves order and ids untouched", () => {
		const three: readonly NoteWidget[] = [note("a"), note("b"), note("c")];
		const next = expectOkEdit(three, { kind: "resize", widgetId: "b", size: "large" });
		expect(idsOf(next)).toEqual(["a", "b", "c"]);
		expect(next.map((widget) => widget.size)).toEqual(["small", "large", "small"]);
		// Untouched widgets keep their identity; the resized one is a copy.
		expect(next[0]).toBe(three[0]);
		expect(next[2]).toBe(three[2]);
		expect(next[1]).not.toBe(three[1]);
		expect(next[1]).toMatchObject({ widgetId: "b", text: "Note b" });
		expect(expectErrEdit(three, { kind: "resize", widgetId: "missing", size: "large" })).toBe(
			"WIDGET_NOT_FOUND",
		);
		expect(expectErrEdit(three, { kind: "resize", widgetId: "", size: "large" })).toBe(
			"INVALID_WIDGET",
		);
		expect(
			expectErrEdit(three, { kind: "resize", widgetId: "b", size: "huge" as WidgetSize }),
		).toBe("INVALID_WIDGET");
	});

	it("replaces a widget under the same id at the same position", () => {
		const three: readonly NoteWidget[] = [note("a"), note("b"), note("c")];
		const next = expectOkEdit(three, {
			kind: "replace",
			widget: { ...note("b"), title: "Renamed", size: "large" },
		});
		expect(idsOf(next)).toEqual(["a", "b", "c"]);
		expect(next[1]).toMatchObject({ widgetId: "b", title: "Renamed", size: "large" });
		expect(expectErrEdit(one, { kind: "replace", widget: note("missing") })).toBe(
			"WIDGET_NOT_FOUND",
		);
		expect(expectErrEdit(one, { kind: "replace", widget: note("") })).toBe("INVALID_WIDGET");
		expect(expectErrEdit(one, { kind: "replace", widget: note("a", "tiny" as WidgetSize) })).toBe(
			"INVALID_WIDGET",
		);
	});

	it("honours a custom limit", () => {
		const tiny = applyWidgetLayoutEdit(two, { kind: "add", widget: note("c") }, { maxWidgets: 2 });
		if (tiny.ok) throw new Error("expected TOO_MANY_WIDGETS");
		expect(tiny.error).toBe("TOO_MANY_WIDGETS");
		expect(DEFAULT_WIDGET_LAYOUT_LIMITS).toEqual({ maxWidgets: 24 });
	});

	it("never mutates its input", () => {
		const before = JSON.parse(JSON.stringify(two)) as readonly NoteWidget[];
		expectOkEdit(two, { kind: "add", widget: note("c", "small"), toIndex: 0 });
		expectOkEdit(two, { kind: "remove", widgetId: "a" });
		expectOkEdit(two, { kind: "move", widgetId: "a", direction: "later" });
		expectOkEdit(two, { kind: "reorder", widgetId: "a", toIndex: 1 });
		expectOkEdit(two, { kind: "resize", widgetId: "a", size: "medium" });
		expectOkEdit(two, { kind: "replace", widget: { ...note("a"), title: "New" } });
		expect(two).toEqual(before);
	});
});

const PROPERTY_SEED = 2_026_101_401;
const widgetIdArb = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/);
const sizeArb = fc.constantFrom("small", "medium", "large") as fc.Arbitrary<WidgetSize>;

function uniqueWidgets(ids: readonly string[]): NoteWidget[] {
	return [...new Set(ids)].map((id) => note(id));
}

describe("applyWidgetLayoutEdit properties", () => {
	it("an accepted add keeps ids unique and appends, or lands at toIndex", () => {
		fc.assert(
			fc.property(
				fc.array(widgetIdArb, { maxLength: 8 }),
				widgetIdArb,
				fc.nat({ max: 9 }),
				fc.boolean(),
				(ids, id, toRaw, withIndex) => {
					const widgets = uniqueWidgets(ids);
					const toIndex = toRaw % (widgets.length + 1);
					const edit: WidgetLayoutEdit<NoteWidget> = withIndex
						? { kind: "add", widget: note(id), toIndex }
						: { kind: "add", widget: note(id) };
					const result = applyWidgetLayoutEdit(widgets, edit);
					if (widgets.some((widget) => widget.widgetId === id) || widgets.length >= 24) {
						expect(result.ok).toBe(false);
					} else {
						expect(result.ok).toBe(true);
						if (!result.ok) return;
						const out = idsOf(result.value);
						expect(new Set(out).size).toBe(out.length);
						if (withIndex) expect(out[toIndex]).toBe(id);
						else expect(out[out.length - 1]).toBe(id);
					}
				},
			),
			{ numRuns: 300, seed: PROPERTY_SEED },
		);
	});

	it("move, reorder and resize are permutations of the same ids", () => {
		fc.assert(
			fc.property(
				fc.array(widgetIdArb, { minLength: 1, maxLength: 8 }),
				fc.nat(),
				fc.nat(),
				sizeArb,
				(ids, fromRaw, toRaw, size) => {
					const unique = [...new Set(ids)];
					const widgets = uniqueWidgets(unique);
					const from = fromRaw % unique.length;
					const to = toRaw % unique.length;
					const target = unique[from];
					if (target === undefined) return;
					const edits: readonly WidgetLayoutEdit<NoteWidget>[] = [
						{ kind: "move", widgetId: target, direction: "earlier" },
						{ kind: "move", widgetId: target, direction: "later" },
						{ kind: "reorder", widgetId: target, toIndex: to },
						{ kind: "resize", widgetId: target, size },
					];
					for (const edit of edits) {
						const result = applyWidgetLayoutEdit(widgets, edit);
						if (result.ok) {
							expect([...idsOf(result.value)].sort()).toEqual([...unique].sort());
							expect(result.value).toHaveLength(unique.length);
							// Ids stay unique.
							expect(new Set(idsOf(result.value)).size).toBe(unique.length);
						}
					}
				},
			),
			{ numRuns: 300, seed: PROPERTY_SEED },
		);
	});

	it("a reorder lands at toIndex and keeps the relative order of the rest", () => {
		fc.assert(
			fc.property(
				fc.array(widgetIdArb, { minLength: 1, maxLength: 8 }),
				fc.nat(),
				fc.nat(),
				(ids, fromRaw, toRaw) => {
					const unique = [...new Set(ids)];
					const widgets = uniqueWidgets(unique);
					const from = fromRaw % unique.length;
					const to = toRaw % unique.length;
					const moved = unique[from];
					if (moved === undefined) return;
					const result = applyWidgetLayoutEdit(widgets, {
						kind: "reorder",
						widgetId: moved,
						toIndex: to,
					});
					expect(result.ok).toBe(true);
					if (!result.ok) return;
					const out = idsOf(result.value);
					expect(out[to]).toBe(moved);
					expect(out.filter((candidate) => candidate !== moved)).toEqual(
						unique.filter((candidate) => candidate !== moved),
					);
				},
			),
			{ numRuns: 300, seed: PROPERTY_SEED },
		);
	});

	it("a rejected edit returns an error and leaves the input unchanged", () => {
		fc.assert(
			fc.property(
				fc.array(widgetIdArb, { minLength: 1, maxLength: 8 }),
				fc.nat(),
				fc.nat(),
				(ids, pickRaw, toRaw) => {
					const unique = [...new Set(ids)];
					const widgets = uniqueWidgets(unique);
					const before = JSON.parse(JSON.stringify(widgets)) as NoteWidget[];
					const target = unique[pickRaw % (unique.length + 1)] ?? "definitely-missing";
					const edits: readonly WidgetLayoutEdit<NoteWidget>[] = [
						{ kind: "remove", widgetId: target },
						{ kind: "move", widgetId: target, direction: "earlier" },
						{ kind: "reorder", widgetId: target, toIndex: toRaw },
						{ kind: "resize", widgetId: target, size: "large" },
						{ kind: "add", widget: note(target), toIndex: toRaw },
					];
					let sawRejection = false;
					for (const edit of edits) {
						const result = applyWidgetLayoutEdit(widgets, edit);
						if (!result.ok) {
							sawRejection = true;
							expect(typeof result.error).toBe("string");
						}
					}
					// At least the missing-id and out-of-range variants reject.
					expect(sawRejection).toBe(true);
					expect(widgets).toEqual(before);
				},
			),
			{ numRuns: 300, seed: PROPERTY_SEED },
		);
	});
});
