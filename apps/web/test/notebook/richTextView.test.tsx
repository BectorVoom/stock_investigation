import type { NotebookWidget } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRichText } from "../../src/notebook/richText/parser.ts";
import { RichTextView } from "../../src/notebook/richText/RichTextView.tsx";
import { wysiwygViewFor } from "../../src/notebook/richText/WysiwygEditor.tsx";
import { TextWidget } from "../../src/notebook/widgets/TextWidget.tsx";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function textWidget(
	text: string,
	size: NotebookWidget["size"] = "medium",
): Extract<NotebookWidget, { readonly type: "text" }> {
	return {
		widgetId: "nb-text",
		type: "text",
		title: "Notes",
		size,
		text,
		createdAt: "2026-10-01T00:00:00Z",
		updatedAt: "2026-10-01T00:00:00Z",
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	};
}

describe("rich-text renderer", () => {
	it("renders headings, links, lists and quotes as real elements", () => {
		render(() => (
			<RichTextView
				doc={parseRichText(
					"# Plan\n\nSee [docs](https://example.com).\n\n- one\n- two\n\n> quoted\n\n---",
				)}
				onToggleTodo={null}
				checkboxesDisabled={false}
			/>
		));
		expect(document.querySelector("h1")?.textContent).toBe("Plan");
		const link = document.querySelector("a");
		if (!(link instanceof HTMLAnchorElement)) throw new Error("no link");
		expect(link.getAttribute("href")).toBe("https://example.com");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(document.querySelectorAll("ul li")).toHaveLength(2);
		expect(document.querySelector("blockquote")?.textContent).toBe("quoted");
		expect(document.querySelector("hr")).not.toBeNull();
	});

	it("renders legacy plain text unchanged: paragraphs and line breaks", () => {
		render(() => (
			<RichTextView
				doc={parseRichText("First paragraph.\n\nSecond line\nwith break.")}
				onToggleTodo={null}
				checkboxesDisabled={false}
			/>
		));
		expect(screen.getByText("First paragraph.")).toBeDefined();
		const paragraphs = document.querySelectorAll("p");
		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[1]?.querySelector("br")).not.toBeNull();
	});

	it("renders unsafe link schemes as text and never uses innerHTML", () => {
		render(() => (
			<RichTextView
				doc={parseRichText('[evil](javascript:alert(1))\n\n<img src=x onerror="window.__xss=1">')}
				onToggleTodo={null}
				checkboxesDisabled={false}
			/>
		));
		expect(document.querySelector("a")).toBeNull();
		expect(document.querySelector("img")).toBeNull();
		expect(document.body.textContent).toContain("[evil](javascript:alert(1))");
		expect(document.body.textContent).toContain('<img src=x onerror="window.__xss=1">');
		expect(document.body.innerHTML).not.toContain("<img");
	});

	it("renders to-do items as checkboxes that toggle through the callback", () => {
		const toggle = vi.fn();
		render(() => (
			<RichTextView
				doc={parseRichText("- [ ] open\n- [x] done")}
				onToggleTodo={toggle}
				checkboxesDisabled={false}
			/>
		));
		const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
		expect(boxes).toHaveLength(2);
		expect((boxes[0] as HTMLInputElement).checked).toBe(false);
		expect((boxes[1] as HTMLInputElement).checked).toBe(true);
		fireEvent.click(boxes[0] as HTMLInputElement);
		expect(toggle).toHaveBeenCalledWith(0);
	});
});

describe("text widget in place", () => {
	/** The live ProseMirror view behind the open editor. */
	function pmView(): EditorView {
		const mount = document.querySelector("[data-wysiwyg-mount]");
		if (!(mount instanceof HTMLDivElement)) throw new Error("no wysiwyg mount");
		const view = wysiwygViewFor(mount);
		if (view === undefined) throw new Error("no pm view");
		return view;
	}

	async function openEditor(): Promise<HTMLElement> {
		return await screen.findByRole("textbox", { name: "Edit note" });
	}

	/** Puts the cursor at the very end of the document. */
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

	function docRange(
		view: EditorView,
		wanted: string,
	): { readonly from: number; readonly to: number } {
		let found: { readonly from: number; readonly to: number } | null = null;
		view.state.doc.descendants((node, pos) => {
			if (found !== null || !node.isText || node.text === undefined) return true;
			const at = node.text.indexOf(wanted);
			if (at >= 0) found = { from: pos + at, to: pos + at + wanted.length };
			return true;
		});
		if (found === null) throw new Error(`missing ${wanted}`);
		return found;
	}

	function selectText(view: EditorView, wanted: string): void {
		const range = docRange(view, wanted);
		view.dispatch(
			view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)),
		);
	}

	function pressKey(view: EditorView, init: KeyboardEventInit & { readonly key: string }): void {
		view.dom.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
		);
	}

	it("opens the editor on body click and saves on Escape", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget
				widget={textWidget("Hello **world**")}
				editingDisabled={false}
				onSaveText={onSaveText}
			/>
		));
		expect(document.querySelector("strong")?.textContent).toBe("world");
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const editor = await openEditor();
		// WYSIWYG: the formatted text is inside the editor, no raw `**`.
		expect(within(editor).getByText("world").tagName).toBe("STRONG");
		expect(editor.textContent).not.toContain("**");
		const view = pmView();
		cursorToEnd(view);
		typeText(view, "!");
		pressKey(view, { key: "Escape" });
		await waitFor(() => expect(onSaveText).toHaveBeenCalledWith("nb-text", "Hello **world!**"));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit note" })).toBeNull());
		// Focus returns to the body the editor came from.
		await waitFor(() => {
			const active = document.activeElement;
			if (!(active instanceof HTMLElement) || active.getAttribute("data-text-view") === null)
				throw new Error("focus did not return to the body");
		});
	});

	it("opens the editor on Enter and saves on blur", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget widget={textWidget("Notes.")} editingDisabled={false} onSaveText={onSaveText} />
		));
		fireEvent.keyDown(screen.getByRole("button", { name: "Edit note" }), { key: "Enter" });
		await openEditor();
		const view = pmView();
		cursorToEnd(view);
		typeText(view, " revised");
		fireEvent.focusOut(view.dom);
		await waitFor(() => expect(onSaveText).toHaveBeenCalledWith("nb-text", "Notes. revised"));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit note" })).toBeNull());
	});

	it("keeps the editor open with the text intact when the save fails", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(false));
		render(() => (
			<TextWidget widget={textWidget("Keep me")} editingDisabled={false} onSaveText={onSaveText} />
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		await openEditor();
		const view = pmView();
		cursorToEnd(view);
		typeText(view, ", longer");
		pressKey(view, { key: "Escape" });
		await waitFor(() => expect(onSaveText).toHaveBeenCalled());
		// Still open, nothing lost.
		expect(screen.getByRole("textbox", { name: "Edit note" })).not.toBeNull();
		expect(pmView().dom.textContent).toBe("Keep me, longer");
	});

	it("saves debounced while typing: one save for fast keystrokes", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget widget={textWidget("a")} editingDisabled={false} onSaveText={onSaveText} />
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		await openEditor();
		const view = pmView();
		cursorToEnd(view);
		typeText(view, "bcd");
		expect(onSaveText).not.toHaveBeenCalled();
		await waitFor(() => expect(onSaveText).toHaveBeenCalledTimes(1), { timeout: 3000 });
		expect(onSaveText).toHaveBeenCalledWith("nb-text", "abcd");
	});

	it("stays read-only while editing is disabled", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("Locked.")}
				editingDisabled={true}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		expect(screen.queryByRole("button", { name: "Edit note" })).toBeNull();
		fireEvent.click(document.querySelector("[data-text-view]") as HTMLElement);
		expect(screen.queryByRole("textbox", { name: "Edit note" })).toBeNull();
	});

	it("toggles a to-do without opening the editor", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget
				widget={textWidget("- [ ] buy milk")}
				editingDisabled={false}
				onSaveText={onSaveText}
			/>
		));
		fireEvent.click(screen.getByRole("checkbox", { name: "To-do: buy milk" }));
		await waitFor(() => expect(onSaveText).toHaveBeenCalledWith("nb-text", "- [x] buy milk"));
		expect(screen.queryByRole("textbox", { name: "Edit note" })).toBeNull();
	});

	it("bolds the selection from the toolbar", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("make this bold")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const editor = await openEditor();
		const view = pmView();
		selectText(view, "this");
		fireEvent.click(await screen.findByRole("button", { name: "Bold" }));
		expect(editor.querySelector("strong")?.textContent).toBe("this");
	});

	it("bolds with Ctrl+B and links with Ctrl+K plus a validated URL", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("read the docs")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const editor = await openEditor();
		const view = pmView();
		selectText(view, "docs");
		pressKey(view, { key: "b", ctrlKey: true });
		expect(editor.querySelector("strong")?.textContent).toBe("docs");
		// Bold kept the word selected, so the link applies to it directly.
		pressKey(view, { key: "k", ctrlKey: true });
		const url = await screen.findByLabelText("Link URL (http, https or mailto)");
		if (!(url instanceof HTMLInputElement)) throw new Error("no url field");
		fireEvent.input(url, { target: { value: "javascript:evil()" } });
		fireEvent.click(screen.getByRole("button", { name: "Save link" }));
		expect(screen.getByRole("alert").textContent).toContain("http(s) or mailto");
		fireEvent.input(url, { target: { value: "https://example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Save link" }));
		const link = editor.querySelector('a[href="https://example.com"]');
		expect(link?.textContent).toBe("docs");
	});

	it("opens the slash menu on an empty block and inserts a to-do", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("Title")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		await openEditor();
		const view = pmView();
		cursorToEnd(view);
		pressKey(view, { key: "Enter" });
		typeText(view, "/to");
		const menu = await screen.findByRole("listbox", { name: "Insert block" });
		const todo = within(menu).getByRole("option", { name: /To-do/ });
		expect(todo.getAttribute("aria-selected")).toBe("true");
		pressKey(view, { key: "Enter" });
		await waitFor(() => {
			if (pmView().dom.querySelector('input[type="checkbox"]') === null)
				throw new Error("no todo checkbox in the editor");
		});
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("turns `# ` into a heading while typing, with no raw marker", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const editor = await openEditor();
		const view = pmView();
		typeText(view, "# Plan");
		const heading = editor.querySelector("h1");
		expect(heading?.textContent).toBe("Plan");
		expect(editor.textContent).not.toContain("#");
	});

	it("continues a bullet on Enter and leaves the list on an empty item", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("- item")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const editor = await openEditor();
		const view = pmView();
		cursorToEnd(view);
		pressKey(view, { key: "Enter" });
		expect(editor.querySelectorAll("li")).toHaveLength(2);
		pressKey(view, { key: "Enter" });
		expect(editor.querySelectorAll("li")).toHaveLength(1);
	});

	it("numbers the next ordered item", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("1. first")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const editor = await openEditor();
		const view = pmView();
		cursorToEnd(view);
		pressKey(view, { key: "Enter" });
		const items = editor.querySelectorAll("li");
		expect(items).toHaveLength(2);
		expect(items[1]?.textContent).toBe("");
	});

	it("shows a quiet counter near the limit and caps the source", async () => {
		render(() => (
			<TextWidget
				widget={textWidget("x".repeat(7600))}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		await openEditor();
		expect(document.body.textContent).toContain("7600 / 8000 characters");
		const view = pmView();
		// Growth past the cap is dropped like `maxLength`; shrinks still apply.
		view.dispatch(view.state.tr.insertText("y".repeat(9000), 1, 1));
		expect(view.state.doc.textContent.length).toBe(7600);
		cursorToEnd(view);
		typeText(view, "!");
		expect(view.state.doc.textContent.length).toBe(7601);
	});

	it("toggles a to-do checkbox while editing and saves it on leave", async () => {
		// happy-dom clicks carry no coordinates, so ProseMirror's click
		// wiring (covered in E2E) cannot fire here: dispatch the same
		// toggle transaction the checkbox handler builds and check the
		// save flow end to end.
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget
				widget={textWidget("- [ ] buy milk")}
				editingDisabled={false}
				onSaveText={onSaveText}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		await openEditor();
		const view = pmView();
		let itemPos = -1;
		view.state.doc.descendants((node, pos) => {
			if (node.type.name === "todo_item") {
				itemPos = pos;
				return false;
			}
			return true;
		});
		if (itemPos < 0) throw new Error("no todo item");
		view.dispatch(view.state.tr.setNodeMarkup(itemPos, undefined, { checked: true }));
		pressKey(view, { key: "Escape" });
		await waitFor(() => expect(onSaveText).toHaveBeenCalledWith("nb-text", "- [x] buy milk"));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit note" })).toBeNull());
	});

	it("keeps the clamped preview with a fade for small widgets", () => {
		render(() => (
			<TextWidget
				widget={textWidget("First paragraph.\n\nSecond paragraph.", "small")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		expect(screen.getByText("First paragraph.")).toBeDefined();
		expect(document.querySelector(".max-h-24.overflow-hidden")).not.toBeNull();
		expect(document.querySelector(".bg-gradient-to-t")).not.toBeNull();
	});
});
