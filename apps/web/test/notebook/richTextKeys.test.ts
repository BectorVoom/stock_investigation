import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { modelToPm, pmToModel } from "../../src/notebook/richText/docConvert.ts";
import { parseRichText } from "../../src/notebook/richText/parser.ts";
import { richTextPlugins, type WysiwygKeyCallbacks } from "../../src/notebook/richText/pmRules.ts";
import { richTextSchema } from "../../src/notebook/richText/schema.ts";
import { serializeRichText } from "../../src/notebook/richText/serializer.ts";

const callbacks: WysiwygKeyCallbacks = {
	isMenuOpen: () => false,
	isLinkOpen: () => false,
	menuMove: () => undefined,
	menuConfirm: () => undefined,
	closeOverlay: () => undefined,
	openLink: () => undefined,
	leave: () => undefined,
};

/** Drives the live keymap and input rules without a browser. */
function mountEditor(source: string): EditorView {
	const mount = document.createElement("div");
	document.body.append(mount);
	const view = new EditorView(mount, {
		state: EditorState.create({
			schema: richTextSchema,
			doc: modelToPm(parseRichText(source)),
			plugins: richTextPlugins(callbacks),
		}),
	});
	return view;
}

function markdown(view: EditorView): string {
	return serializeRichText(pmToModel(view.state.doc));
}

function cursorToEnd(view: EditorView): void {
	view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
}

/** Types through the real input-rules plugin, the way keystrokes land. */
function typeText(view: EditorView, text: string): void {
	for (const char of text) {
		const cursor =
			view.state.selection instanceof TextSelection ? view.state.selection.$cursor : null;
		const pos = cursor === null ? view.state.selection.to : cursor.pos;
		const handled = view.someProp("handleTextInput", (handler) =>
			handler(view, pos, pos, char, () => view.state.tr),
		);
		if (handled !== true) view.dispatch(view.state.tr.insertText(char, pos, pos));
	}
}

function pressKey(view: EditorView, init: KeyboardEventInit & { readonly key: string }): void {
	view.dom.dispatchEvent(
		new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
	);
}

function destroy(view: EditorView): void {
	view.destroy();
	view.dom.parentElement?.remove();
}

describe("rich-text keymap and input rules", () => {
	it("turns `# ` into a heading with no raw marker", () => {
		const view = mountEditor("");
		typeText(view, "# Plan");
		expect(view.state.doc.firstChild?.type.name).toBe("heading");
		expect(markdown(view)).toBe("# Plan");
		destroy(view);
	});

	it("starts a paragraph, not another heading, on Enter after a heading", () => {
		const view = mountEditor("# Plan");
		cursorToEnd(view);
		pressKey(view, { key: "Enter" });
		expect(view.state.doc.childCount).toBe(2);
		expect(view.state.doc.firstChild?.type.name).toBe("heading");
		expect(view.state.doc.lastChild?.type.name).toBe("paragraph");
		destroy(view);
	});

	it("turns `- ` into a bullet list and continues it on Enter", () => {
		const view = mountEditor("");
		typeText(view, "- item");
		expect(view.state.doc.firstChild?.type.name).toBe("bullet_list");
		cursorToEnd(view);
		pressKey(view, { key: "Enter" });
		expect(markdown(view)).toBe("- item\n- ");
		pressKey(view, { key: "Enter" });
		expect(markdown(view)).toBe("- item");
		destroy(view);
	});

	it("turns `[] ` into a to-do list", () => {
		const view = mountEditor("");
		typeText(view, "[] buy milk");
		expect(markdown(view)).toBe("- [ ] buy milk");
		destroy(view);
	});

	it("bolds `**x**` as the closing delimiter lands", () => {
		const view = mountEditor("");
		typeText(view, "a **bold** word");
		expect(markdown(view)).toBe("a **bold** word");
		expect(view.state.doc.textContent).not.toContain("**");
		destroy(view);
	});

	it("turns a heading back into a paragraph on Backspace at its start", () => {
		const view = mountEditor("# Plan");
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1)));
		pressKey(view, { key: "Backspace" });
		expect(markdown(view)).toBe("Plan");
		destroy(view);
	});

	it("lifts a list item back into a paragraph on Backspace at its start", () => {
		const view = mountEditor("- item");
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 3)));
		pressKey(view, { key: "Backspace" });
		expect(markdown(view)).toBe("item");
		destroy(view);
	});

	it("turns `> ` into a quote, exits it on Backspace, and turns ``` into code", () => {
		const view = mountEditor("");
		typeText(view, "> quoted");
		expect(view.state.doc.firstChild?.type.name).toBe("blockquote");
		cursorToEnd(view);
		pressKey(view, { key: "Enter" });
		pressKey(view, { key: "Backspace" });
		typeText(view, "``` ");
		expect(view.state.doc.lastChild?.type.name).toBe("code_block");
		destroy(view);
	});

	it("turns `--- ` into a divider", () => {
		const view = mountEditor("");
		typeText(view, "--- ");
		expect(view.state.doc.firstChild?.type.name).toBe("horizontal_rule");
		destroy(view);
	});

	it("renders to-do checked styling only while checked", () => {
		const view = mountEditor("- [ ] buy milk");
		const box = (): HTMLInputElement | null =>
			view.dom.querySelector('li[data-todo-item] > input[type="checkbox"]');
		const wrap = (): Element | null => view.dom.querySelector("li[data-todo-item] > div");
		expect(box()).not.toBeNull();
		expect(wrap()?.className).not.toContain("line-through");
		let itemPos = -1;
		view.state.doc.descendants((node, pos) => {
			if (node.type.name === "todo_item") {
				itemPos = pos;
				return false;
			}
			return true;
		});
		view.dispatch(view.state.tr.setNodeMarkup(itemPos, undefined, { checked: true }));
		expect(box()?.checked).toBe(true);
		expect(wrap()?.className).toContain("line-through");
		view.dispatch(view.state.tr.setNodeMarkup(itemPos, undefined, { checked: false }));
		expect(box()?.checked).toBe(false);
		expect(wrap()?.className).not.toContain("line-through");
		destroy(view);
	});

	it("undoes and redoes typed text", () => {
		const view = mountEditor("a");
		cursorToEnd(view);
		typeText(view, "b");
		expect(markdown(view)).toBe("ab");
		pressKey(view, { key: "z", ctrlKey: true });
		expect(markdown(view)).toBe("a");
		pressKey(view, { key: "z", ctrlKey: true, shiftKey: true });
		expect(markdown(view)).toBe("ab");
		destroy(view);
	});
});
