import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * WYSIWYG rich text in the Text widget (ADR-0021, task W4b).
 *
 * Runs as an isolated owner (`X-E2E-Owner`) so its chats and notebook never
 * disturb the other specs. Flow: add two Text widgets, grow the first to
 * medium, edit it in place through the formatted surface (`# ` becomes a
 * real `h1` with no `#` character, bold through the shortcut, a link
 * through the link popover, a to-do through the `/` menu), screenshot the
 * medium editing state, leave, reload, and see the heading element,
 * `strong`, the link and the checkbox; the stored Markdown (via
 * `GET …/notebook`) is the canonical subset; the small widget's editing
 * state screenshots cleanly too; no console errors (the app's CSP is
 * `style-src 'self'`, so no injected `<style>` and no `style=` attributes).
 */

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const owner = `e2e-richtext-${Date.now()}@example.test`;

test.beforeAll(async ({ browser }) => {
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
	await context.close();
});

/**
 * A screenshot for reading the layout, taken on Chromium only: Playwright's
 * WebKit screenshot injects a <style> the app's CSP refuses, which would be
 * logged as a console error that this spec rightly fails on.
 */
async function reviewShot(name: string): Promise<void> {
	if (page.context().browser()?.browserType().name() !== "chromium") return;
	await page.screenshot({ path: test.info().outputPath(name) });
}

/** The Notebook's widgets only: thread previews use the same frame. */
function notebookWidgets() {
	return page.locator('div[data-panel="notebook"] article[data-widget-id]');
}

function richEditor() {
	return page.locator("[data-rich-text-editor]");
}

async function addTextWidget(): Promise<void> {
	const notebook = page.getByRole("region", { name: "Notebook" });
	await notebook.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Text" }).click();
	const dialog = page.getByRole("dialog", { name: /Edit text widget/ });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
}

/**
 * Selects the first occurrence of `text` in a freshly opened editor. The
 * editor learns about DOM selections asynchronously; the suite opens a new
 * session per selection (like a person coming back to edit), so the
 * toolbar starts hidden and its appearance proves ProseMirror holds the
 * wanted range before any shortcut runs.
 */
async function selectInEditor(text: string): Promise<void> {
	await richEditor().evaluate((root, wanted) => {
		const editable = root.querySelector(".ProseMirror") ?? root;
		const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node !== null) {
			const at = node.textContent?.indexOf(wanted) ?? -1;
			if (at >= 0) {
				const range = document.createRange();
				range.setStart(node, at);
				range.setEnd(node, at + wanted.length);
				const selection = document.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
				return;
			}
			node = walker.nextNode();
		}
		throw new Error(`missing ${wanted} in the editor`);
	}, text);
	await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
}

/** Opens the first widget's editor by clicking at the start of a line. */
async function openFirstEditor() {
	await notebookWidgets()
		.first()
		.locator("[data-text-view]")
		.click({ position: { x: 8, y: 8 } });
	const editor = page.getByRole("textbox", { name: "Edit note" });
	await expect(editor).toBeVisible();
	return editor;
}

/** One text widget's stored Markdown by order, via `GET …/notebook`. */
async function storedTextAt(index: number): Promise<unknown> {
	const workspaceId = /#\/chat\/([^/?]+)/.exec(page.url())?.[1];
	if (workspaceId === undefined) throw new Error(`no open chat in ${page.url()}`);
	const read = await page.request.get(`${E2E_ORIGIN}/api/v1/workspaces/${workspaceId}/notebook`);
	expect(read.ok()).toBe(true);
	const stored = (await read.json()) as {
		notebook: { widgets: { readonly type: string; readonly text?: string }[] };
	};
	return stored.notebook.widgets.filter((widget) => widget.type === "text").at(index)?.text;
}

/**
 * Leaves through Escape, then waits for the stored text to converge. The
 * debounced save may land before, during, or because of the leave — polling
 * the API covers every order, unlike waiting for a single PUT.
 */
async function escapeAndExpectSaved(editor: Locator, index: number, expected: string) {
	await editor.press("Escape");
	await expect(editor).toBeHidden();
	await expect.poll(() => storedTextAt(index), { timeout: 15_000 }).toBe(expected);
}

/** True when the caret (or focus) sits inside `selector` within the editor. */
async function caretInside(selector: string): Promise<boolean> {
	return await richEditor().evaluate((root, target) => {
		const selection = document.getSelection();
		const node = selection?.anchorNode;
		const element = node instanceof Element ? node : node?.parentElement;
		if (element === null || element === undefined) return false;
		return element.closest(`${target}`) !== null && root.contains(element);
	}, selector);
}

/** The text the editor selection currently covers. */
async function selectedText(): Promise<string> {
	return await richEditor().evaluate(() => document.getSelection()?.toString() ?? "");
}

test("a new chat shows the Notebook panel", async () => {
	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	await expect(page.getByRole("region", { name: "Notebook" })).toBeVisible();
});

test("two text widgets can be added, the first grown to medium", async () => {
	await addTextWidget();
	await addTextWidget();
	await expect(notebookWidgets()).toHaveCount(2);
	const first = notebookWidgets().first();
	await first.locator("button[data-widget-actions]").click();
	await page.getByRole("menuitem", { name: "Medium" }).click();
	await expect(first).toHaveAttribute("data-widget-size", "medium");
});

test("the first widget edits WYSIWYG: a heading and bold", async () => {
	const first = notebookWidgets().first();
	const editor = await openFirstEditor();

	// A heading through the `# ` shortcut: the block IS an h1 already.
	// (The fresh widget says "New note": select all first, like a person.)
	await editor.press("ControlOrMeta+a");
	await editor.pressSequentially("# ");
	await expect(richEditor().locator("h1")).toBeVisible();
	await editor.pressSequentially("Plan");
	const heading = richEditor().locator("h1");
	await expect(heading).toHaveText("Plan");
	expect(await caretInside("h1")).toBe(true);

	// Enter after a heading starts a paragraph, not another heading.
	await editor.press("Enter");
	await editor.pressSequentially("Pack light and travel far.");

	// Bold through the shortcut: the selection still covers the word, now `strong`.
	await selectInEditor("light");
	await editor.press("ControlOrMeta+b");
	await expect(richEditor().locator("strong", { hasText: "light" })).toBeVisible();
	expect(await selectedText()).toBe("light");

	await reviewShot("rich-text-editing-medium.png");
	await escapeAndExpectSaved(editor, 0, "# Plan\n\nPack **light** and travel far.");
	await expect(first.locator("h1")).toHaveText("Plan");
});

test("a link is added through the link popover", async () => {
	const editor = await openFirstEditor();
	await selectInEditor("travel");
	await editor.press("ControlOrMeta+k");
	const url = page.getByLabel("Link URL (http, https or mailto)");
	await expect(url).toBeVisible();
	await url.fill("https://example.com");
	await page.getByRole("button", { name: "Save link" }).click();
	const link = richEditor().locator('a[href="https://example.com"]');
	await expect(link).toHaveText("travel");
	await escapeAndExpectSaved(
		editor,
		0,
		"# Plan\n\nPack **light** and [travel](https://example.com) far.",
	);
	await expect(notebookWidgets().first().getByRole("link", { name: "travel" })).toBeVisible();
});

test("a to-do is added through the `/` block menu in the small widget", async () => {
	// The small widget still says "New note": select all first, like a
	// person replacing the placeholder, so no caret hunt is needed.
	const second = notebookWidgets().nth(1);
	await second.locator("[data-text-view]").click({ position: { x: 8, y: 8 } });
	const editor = page.getByRole("textbox", { name: "Edit note" });
	await expect(editor).toBeVisible();
	await editor.press("ControlOrMeta+a");
	await editor.pressSequentially("/to");
	await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
	await expect(page.getByRole("option", { name: /To-do/ })).toBeVisible();
	await editor.press("Enter");
	await expect(richEditor().locator('input[type="checkbox"]')).toBeVisible();
	await editor.pressSequentially("Buy tickets");
	// To-dos toggle while editing too: check and uncheck again through the
	// real checkbox, so the stored line stays `- [ ]`.
	const box = richEditor().locator('input[type="checkbox"]');
	await box.click();
	await expect(box).toBeChecked();
	await box.click();
	await expect(box).not.toBeChecked();
	// Small-widget editing: the surface scrolls inside the frame body and
	// never grows or overflows the grid cell; formatted, no Markdown syntax.
	expect(await richEditor().evaluate((root) => root.scrollWidth <= root.clientWidth + 1)).toBe(
		true,
	);
	expect(richEditor().getByText("Buy tickets")).toBeVisible();
	await reviewShot("rich-text-editing-small.png");
	await escapeAndExpectSaved(editor, 1, "- [ ] Buy tickets");
});

test("a reload keeps the heading, bold, link and to-do", async () => {
	await page.reload();
	await expect(page.getByRole("region", { name: "Notebook" })).toBeVisible();
	const first = notebookWidgets().first();
	await expect(first.locator("h1")).toHaveText("Plan");
	await expect(first.locator("strong")).toHaveText("light");
	const link = first.getByRole("link", { name: "travel" });
	await expect(link).toHaveAttribute("href", "https://example.com");
	await expect(link).toHaveAttribute("target", "_blank");
	const second = notebookWidgets().nth(1);
	await expect(second.getByRole("checkbox", { name: "To-do: Buy tickets" })).not.toBeChecked();
	await reviewShot("rich-text-rendered.png");
});

test("the stored Markdown is the canonical subset", async () => {
	const workspaceId = /#\/chat\/([^/?]+)/.exec(page.url())?.[1];
	if (workspaceId === undefined) throw new Error(`no open chat in ${page.url()}`);
	const notebookUrl = `${E2E_ORIGIN}/api/v1/workspaces/${workspaceId}/notebook`;
	const read = await page.request.get(notebookUrl);
	expect(read.ok()).toBe(true);
	const stored = (await read.json()) as {
		notebook: {
			widgets: { readonly widgetId: string; readonly type: string; readonly text?: string }[];
		};
	};
	const texts = stored.notebook.widgets.filter((widget) => widget.type === "text");
	expect(texts).toHaveLength(2);
	expect(texts[0]?.text).toBe("# Plan\n\nPack **light** and [travel](https://example.com) far.");
	expect(texts[1]?.text).toBe("- [ ] Buy tickets");
	// Console errors exclude the expected error paths (422/403).
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
