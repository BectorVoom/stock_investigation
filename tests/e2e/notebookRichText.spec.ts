import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * Notion-like rich text in the Text widget (ADR-0021, task W4).
 *
 * Runs as an isolated owner (`X-E2E-Owner`) so its chats and notebook never
 * disturb the other specs. Flow: add two Text widgets, edit the first in
 * place (`# Plan` heading, bold through the shortcut, a link through the
 * link popover, a to-do through the `/` menu), leave, reload, and see the
 * heading element, `strong`, the link and the checkbox; the widget still
 * drags by its grip; no console errors.
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

async function addTextWidget(): Promise<void> {
	const notebook = page.getByRole("region", { name: "Notebook" });
	await notebook.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Text" }).click();
	const dialog = page.getByRole("dialog", { name: /Edit text widget/ });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
}

/** Selects `text` inside the open rich-text editor. */
async function selectInEditor(text: string): Promise<void> {
	const editor = page.getByLabel("Edit text as Markdown");
	await editor.evaluate((element, wanted) => {
		if (!(element instanceof HTMLTextAreaElement)) throw new Error("no rich-text editor");
		const start = element.value.indexOf(wanted);
		if (start < 0) throw new Error(`missing ${wanted}`);
		element.focus();
		element.setSelectionRange(start, start + wanted.length);
	}, text);
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

test("two text widgets can be added", async () => {
	await addTextWidget();
	await addTextWidget();
	await expect(notebookWidgets()).toHaveCount(2);
});

test("the first widget edits in place with heading, bold, link and to-do", async () => {
	const first = notebookWidgets().first();
	await first.locator("[data-text-view]").click();
	const editor = page.getByLabel("Edit text as Markdown");
	await expect(editor).toBeVisible();

	// A heading through the `# ` shortcut, then a sentence.
	await editor.fill("# Plan");
	await editor.press("Enter");
	await editor.pressSequentially("Pack light and travel far.");

	// Bold through the shortcut.
	await selectInEditor("light");
	await editor.press("ControlOrMeta+b");
	await expect(editor).toHaveValue("# Plan\nPack **light** and travel far.");

	// A link through the link popover.
	await selectInEditor("travel");
	await editor.press("ControlOrMeta+k");
	const url = page.getByLabel("Link URL (http, https or mailto)");
	await expect(url).toBeVisible();
	await url.fill("https://example.com");
	await page.getByRole("button", { name: "Save link" }).click();
	await expect(editor).toHaveValue("# Plan\nPack **light** and [travel](https://example.com) far.");

	// A to-do through the `/` block menu.
	await editor.evaluate((element) => {
		if (!(element instanceof HTMLTextAreaElement)) throw new Error("no rich-text editor");
		element.focus();
		element.setSelectionRange(element.value.length, element.value.length);
	});
	await editor.press("Enter");
	await editor.pressSequentially("/to");
	await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
	await expect(page.getByRole("option", { name: /To-do/ })).toBeVisible();
	await editor.press("Enter");
	await editor.pressSequentially("Buy tickets");
	await expect(editor).toHaveValue(
		"# Plan\nPack **light** and [travel](https://example.com) far.\n- [ ] Buy tickets",
	);
	await reviewShot("rich-text-editing.png");

	// Leaving saves; the read view shows the heading already before reload.
	const saved = page.waitForResponse(
		(response) => response.url().includes("/notebook") && response.request().method() === "PUT",
	);
	await editor.press("Escape");
	await saved;
	await expect(editor).toBeHidden();
	await expect(first.locator("h1")).toHaveText("Plan");
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
	await expect(first.getByRole("checkbox", { name: "To-do: Buy tickets" })).not.toBeChecked();
	await reviewShot("rich-text-rendered.png");
});

test("dragging the widget by its grip still works", async () => {
	const widgets = notebookWidgets();
	await expect(widgets).toHaveCount(2);
	const before = await widgets.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-widget-id")),
	);
	// Both frames must be on screen: the panel scrolls, and a drop outside
	// the viewport cannot land on a slot.
	await widgets.nth(1).scrollIntoViewIfNeeded();
	// Press on the grip glyph itself: the header strip also holds buttons,
	// and a press on any of them must not (and does not) start a drag.
	const gripBox = await widgets.first().locator("[data-widget-drag-handle] .wg-grip").boundingBox();
	if (gripBox === null) throw new Error("grip box missing");
	const gripX = gripBox.x + gripBox.width / 2;
	const gripY = gripBox.y + gripBox.height / 2;
	await page.mouse.move(gripX, gripY);
	await page.mouse.down();
	// Past the press threshold so the dragged frame lifts out of flow, then
	// re-read the target: the lift reflows the grid, so a pre-drag box would
	// aim at a gap instead of the second frame.
	await page.mouse.move(gripX, gripY + 12, { steps: 3 });
	const freshTarget = await widgets.nth(1).boundingBox();
	if (freshTarget === null) throw new Error("target widget box missing");
	await page.mouse.move(
		freshTarget.x + freshTarget.width * 0.8,
		freshTarget.y + freshTarget.height * 0.8,
		{ steps: 25 },
	);
	await page.mouse.up();
	// The drop saves through the session; the re-render lands just after the
	// release, so poll for the new order instead of reading it mid-flight.
	await expect
		.poll(
			async () =>
				(
					await widgets.evaluateAll((nodes) =>
						nodes.map((node) => node.getAttribute("data-widget-id")),
					)
				).join(",") === before.join(",")
					? "same"
					: "moved",
			{ timeout: 15_000 },
		)
		.toBe("moved");
	const moved = await widgets.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-widget-id")),
	);
	await page.reload();
	await expect(notebookWidgets().first()).toBeVisible();
	await expect(
		notebookWidgets().evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-widget-id")),
		),
	).resolves.toEqual(moved);
	// Console errors exclude the expected error paths (422/403).
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
