import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * Notebook widget cut, copy and paste (ADR-0023, second half).
 *
 * Runs as an isolated owner (`X-E2E-Owner`) so its chats never disturb the
 * other specs whatever the file order. Widgets are seeded through the
 * notebook API (like the full-notebook test in `notebook.spec.ts` does), so
 * no runner or agent backend is needed: this spec is about the clipboard,
 * not the assistant. Research-widget skipping across chats is covered by
 * unit tests instead: the server only stores a research widget whose
 * component exists on the chat's canvas, and no API can seed one.
 *
 * Contract coverage: cut a widget via its menu → gone, Undo brings it back;
 * copy + paste after another widget → order correct, pasted widget selected;
 * keyboard ⌘/Ctrl+C then ⌘/Ctrl+V on a header-selected widget; cut in one
 * chat and paste in a second chat, including after `page.reload()`; text
 * copy inside a Text widget's editor is not intercepted.
 */

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const owner = `e2e-clipboard-${Date.now()}@example.test`;
// WebKit has no Meta key path here; Control is the modifier everywhere else.
const mod = process.platform === "darwin" ? "Meta" : "Control";

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

function notebookRegion() {
	return page.getByRole("region", { name: "Notebook" });
}

/** The Notebook's widgets only: thread previews use the same frame. */
function notebookWidgets() {
	return page.locator('div[data-panel="notebook"] article[data-widget-id]');
}

function widgetIds(): Promise<(string | null)[]> {
	return notebookWidgets().evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-widget-id")),
	);
}

function workspaceIdFromUrl(): string {
	const workspaceId = /#\/(?:chat|canvas|workspace)\/([^/?]+)/.exec(page.url())?.[1] ?? "";
	expect(workspaceId).toMatch(/^ws_/);
	return workspaceId;
}

async function seedNotebook(workspaceId: string, titles: readonly string[]): Promise<void> {
	const notebookUrl = `${E2E_ORIGIN}/api/v1/workspaces/${workspaceId}/notebook`;
	const read = await page.request.get(notebookUrl);
	expect(read.ok()).toBe(true);
	const stored = (await read.json()) as { version: number };
	const now = new Date().toISOString();
	const saved = await page.request.put(notebookUrl, {
		headers: { Origin: E2E_ORIGIN, "X-Research-Csrf": "1", "Content-Type": "application/json" },
		data: {
			notebook: {
				widgets: titles.map((title, index) => ({
					widgetId: `nb-seed-${index}`,
					type: "text",
					title,
					size: "small",
					text: `${title} body.`,
					createdAt: now,
					updatedAt: now,
					revision: 1,
					origin: { kind: "owner", messageId: null, runId: null, componentId: null },
				})),
			},
			expectedVersion: stored.version,
		},
	});
	expect(saved.status()).toBe(200);
}

let chatA = "";
let chatB = "";

test("a new chat seeds its notebook through the API", async () => {
	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	chatA = workspaceIdFromUrl();
	await seedNotebook(chatA, ["Alpha note", "Beta note"]);
	await page.reload();
	await expect(notebookWidgets()).toHaveCount(2);
});

test("cut a widget via its menu removes it; Undo brings it back", async () => {
	const notebook = notebookRegion();
	const alpha = notebookWidgets().filter({ hasText: "Alpha note" });
	await alpha.locator("button[data-widget-actions]").click();
	if (page.context().browser()?.browserType().name() === "chromium") {
		await page.screenshot({ path: test.info().outputPath("widget-menu.png") });
		await page
			.getByRole("menu")
			.screenshot({ path: test.info().outputPath("widget-menu-items.png") });
	}
	await page.getByRole("menuitem", { name: "Cut", exact: true }).click();
	await expect(notebookWidgets()).toHaveCount(1);
	await expect(notebookWidgets().filter({ hasText: "Alpha note" })).toHaveCount(0);
	await expect(notebook.getByRole("button", { name: "Paste widgets" })).toBeEnabled();
	await notebook.getByRole("button", { name: "Undo" }).click();
	await expect(notebookWidgets()).toHaveCount(2);
	await expect(widgetIds()).resolves.toEqual(["nb-seed-0", "nb-seed-1"]);
});

test("copy and paste after another widget keeps order and selects the paste", async () => {
	const alpha = notebookWidgets().filter({ hasText: "Alpha note" });
	await alpha.locator("button[data-widget-actions]").click();
	await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
	const beta = notebookWidgets().filter({ hasText: "Beta note" });
	await beta.locator("button[data-widget-actions]").click();
	await page.getByRole("menuitem", { name: "Paste after", exact: true }).click();
	await expect(notebookWidgets()).toHaveCount(3);
	await expect(notebookRegion().getByText("1 selected")).toBeVisible();
	// The pasted copy lands directly after Beta with a fresh id, selected alone.
	const ids = await widgetIds();
	expect(ids[0]).toBe("nb-seed-0");
	expect(ids[1]).toBe("nb-seed-1");
	expect(ids[2]).not.toBe("nb-seed-0");
	const selected = await notebookWidgets().evaluateAll((nodes) =>
		nodes
			.filter((node) => node.hasAttribute("data-widget-selected"))
			.map((node) => node.getAttribute("data-widget-id")),
	);
	expect(selected).toEqual([ids[2]]);
	await reviewShot("selection-toolbar.png");
	await reviewShot("header-paste.png");
});

test("keyboard copy and paste act on a header-selected widget", async () => {
	// A click on the grip selects the widget alone (ADR-0021).
	const beta = notebookWidgets().filter({ hasText: "Beta note" });
	await beta.hover();
	await beta.locator(".wg-grip").click();
	await expect(notebookRegion().getByText("1 selected")).toBeVisible();
	await page.keyboard.press(`${mod}+C`);
	const idsBefore = await widgetIds();
	const pasted = notebookWidgets().nth(2);
	await pasted.hover();
	await pasted.locator(".wg-grip").click();
	await page.keyboard.press(`${mod}+V`);
	await expect(notebookWidgets()).toHaveCount(4);
	// Pasted after the third widget with a fresh id.
	const ids = await widgetIds();
	expect(ids.slice(0, 3)).toEqual(idsBefore);
	expect(ids[3]).not.toBeNull();
	expect(new Set(ids).size).toBe(4);
});

test("cut in one chat pastes in a second chat, even after a reload", async () => {
	// Cut the Alpha note in chat A.
	const alpha = notebookWidgets().filter({ hasText: "Alpha note" }).first();
	await alpha.locator("button[data-widget-actions]").click();
	await page.getByRole("menuitem", { name: "Cut", exact: true }).click();
	await expect(notebookWidgets()).toHaveCount(3);
	// "New chat" reuses an empty chat, so create the second chat through the
	// API and open it directly.
	const created = await page.request.post(`${E2E_ORIGIN}/api/v1/workspaces`, {
		headers: { Origin: E2E_ORIGIN, "X-Research-Csrf": "1", "Content-Type": "application/json" },
		data: { title: "Chat B" },
	});
	expect(created.status()).toBe(201);
	chatB = ((await created.json()) as { workspaceId: string }).workspaceId;
	expect(chatB).not.toBe(chatA);
	await page.goto(`/#/chat/${chatB}`);
	await expect(notebookWidgets()).toHaveCount(0);
	const notebook = notebookRegion();
	// The clipboard survived the chat switch: the header offers a paste.
	await expect(notebook.getByRole("button", { name: "Paste widgets" })).toBeEnabled();
	await notebook.getByRole("button", { name: "Paste widgets" }).click();
	await expect(notebookWidgets()).toHaveCount(1);
	await expect(notebookWidgets().first()).toContainText("Alpha note");
	// And it survives a page reload: pasting again duplicates.
	await page.reload();
	await expect(notebookWidgets()).toHaveCount(1);
	await expect(notebookRegion().getByRole("button", { name: "Paste widgets" })).toBeEnabled();
	await notebookRegion().getByRole("button", { name: "Paste widgets" }).click();
	await expect(notebookWidgets()).toHaveCount(2);
});

test("text copy inside a Text widget's editor is not intercepted", async () => {
	// Empty the widget clipboard first, so any interception would show.
	await page.evaluate(() => window.localStorage.clear());
	await page.reload();
	await expect(notebookWidgets()).toHaveCount(2);
	const notebook = notebookRegion();
	await expect(notebook.getByRole("button", { name: "Paste widgets" })).toBeDisabled();
	const first = notebookWidgets().first();
	await first.locator("button[data-widget-actions]").click();
	await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
	const dialog = page.getByRole("dialog");
	const field = dialog.getByLabel("Text (Markdown)");
	await field.fill("Quoted sentences for the text copy check.");
	await field.press(`${mod}+A`);
	await field.press(`${mod}+C`);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	// The widget clipboard is still empty: nothing was intercepted.
	await expect(notebook.getByRole("button", { name: "Paste widgets" })).toBeDisabled();
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
