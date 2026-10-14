import type { NotebookWidget } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRichText } from "../../src/notebook/richText/parser.ts";
import { RichTextView } from "../../src/notebook/richText/RichTextView.tsx";
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
	it("opens the editor on body click and saves on Escape", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget
				widget={textWidget("Hello **world**.")}
				editingDisabled={false}
				onSaveText={onSaveText}
			/>
		));
		expect(document.querySelector("strong")?.textContent).toBe("world");
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		fireEvent.input(area, { target: { value: "Hello **world**!" } });
		fireEvent.keyDown(area, { key: "Escape" });
		await waitFor(() => expect(onSaveText).toHaveBeenCalledWith("nb-text", "Hello **world**!"));
		await waitFor(() => expect(screen.queryByLabelText("Edit text as Markdown")).toBeNull());
	});

	it("opens the editor on Enter and saves on blur", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget widget={textWidget("Notes.")} editingDisabled={false} onSaveText={onSaveText} />
		));
		fireEvent.keyDown(screen.getByRole("button", { name: "Edit note" }), { key: "Enter" });
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		fireEvent.input(area, { target: { value: "Notes, revised." } });
		fireEvent.focusOut(area);
		await waitFor(() => expect(onSaveText).toHaveBeenCalledWith("nb-text", "Notes, revised."));
		await waitFor(() => expect(screen.queryByLabelText("Edit text as Markdown")).toBeNull());
	});

	it("keeps the editor open with the text intact when the save fails", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(false));
		render(() => (
			<TextWidget widget={textWidget("Keep me.")} editingDisabled={false} onSaveText={onSaveText} />
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		fireEvent.input(area, { target: { value: "Keep me, longer." } });
		fireEvent.keyDown(area, { key: "Escape" });
		await waitFor(() => expect(onSaveText).toHaveBeenCalled());
		// Still open, nothing lost.
		expect(screen.getByLabelText("Edit text as Markdown")).not.toBeNull();
		expect((screen.getByLabelText("Edit text as Markdown") as HTMLTextAreaElement).value).toBe(
			"Keep me, longer.",
		);
	});

	it("saves debounced while typing: one save for fast keystrokes", async () => {
		const onSaveText = vi.fn(() => Promise.resolve(true));
		render(() => (
			<TextWidget widget={textWidget("a")} editingDisabled={false} onSaveText={onSaveText} />
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		fireEvent.input(area, { target: { value: "ab" } });
		fireEvent.input(area, { target: { value: "abc" } });
		fireEvent.input(area, { target: { value: "abcd" } });
		expect(onSaveText).not.toHaveBeenCalled();
		await waitFor(() => expect(onSaveText).toHaveBeenCalledTimes(1), { timeout: 3000 });
		expect(onSaveText).toHaveBeenCalledWith("nb-text", "abcd");
	});

	it("stays read-only while editing is disabled", () => {
		render(() => (
			<TextWidget
				widget={textWidget("Locked.")}
				editingDisabled={true}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		expect(screen.queryByRole("button", { name: "Edit note" })).toBeNull();
		fireEvent.click(document.querySelector("[data-text-view]") as HTMLElement);
		expect(screen.queryByLabelText("Edit text as Markdown")).toBeNull();
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
		expect(screen.queryByLabelText("Edit text as Markdown")).toBeNull();
	});

	it("bolds the selection from the toolbar", () => {
		render(() => (
			<TextWidget
				widget={textWidget("make this bold")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		area.setSelectionRange(5, 9);
		fireEvent.mouseUp(area);
		fireEvent.click(screen.getByRole("button", { name: "Bold" }));
		expect(area.value).toBe("make **this** bold");
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
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		area.setSelectionRange(9, 13);
		fireEvent.keyDown(area, { key: "b", ctrlKey: true });
		expect(area.value).toBe("read the **docs**");
		// Bold kept the word selected, so the link applies to it directly.
		fireEvent.keyDown(area, { key: "k", ctrlKey: true });
		const url = screen.getByLabelText("Link URL (http, https or mailto)");
		if (!(url instanceof HTMLInputElement)) throw new Error("no url field");
		fireEvent.input(url, { target: { value: "javascript:evil()" } });
		fireEvent.click(screen.getByRole("button", { name: "Save link" }));
		expect(screen.getByRole("alert").textContent).toContain("http(s) or mailto");
		fireEvent.input(url, { target: { value: "https://example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Save link" }));
		expect(area.value).toBe("read the **[docs](https://example.com)**");
	});

	it("opens the slash menu on an empty line and inserts a to-do", () => {
		render(() => (
			<TextWidget
				widget={textWidget("Title")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		fireEvent.input(area, { target: { value: "Title\n/" } });
		const menu = screen.getByRole("listbox", { name: "Insert block" });
		expect(menu).toBeDefined();
		fireEvent.input(area, { target: { value: "Title\n/to" } });
		const todo = within(menu).getByRole("option", { name: /To-do/ });
		expect(todo.getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(area, { key: "Enter" });
		expect(area.value).toBe("Title\n- [ ] ");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("continues a bullet on Enter and leaves the list on an empty item", () => {
		render(() => (
			<TextWidget
				widget={textWidget("- item")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		area.setSelectionRange(6, 6);
		fireEvent.keyDown(area, { key: "Enter" });
		expect(area.value).toBe("- item\n- ");
		fireEvent.keyDown(area, { key: "Enter" });
		expect(area.value).toBe("- item\n");
	});

	it("numbers the next ordered item", () => {
		render(() => (
			<TextWidget
				widget={textWidget("2. second")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		area.setSelectionRange(9, 9);
		fireEvent.keyDown(area, { key: "Enter" });
		expect(area.value).toBe("2. second\n3. ");
	});

	it("shows a quiet counter near the limit and caps the source", () => {
		const { unmount } = render(() => (
			<TextWidget
				widget={textWidget("Short.")}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
		const area = screen.getByLabelText("Edit text as Markdown");
		if (!(area instanceof HTMLTextAreaElement)) throw new Error("no editor");
		expect(document.body.textContent).not.toContain("characters");
		fireEvent.input(area, { target: { value: `x`.repeat(7600) } });
		expect(document.body.textContent).toContain("7600 / 8000 characters");
		fireEvent.input(area, { target: { value: `x`.repeat(9000) } });
		expect(area.value.length).toBe(8000);
		unmount();
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
