import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * The composer's + mode menu (ADR-0023, first half): the "Composer target"
 * fieldset with its Research / Notebook buttons is gone, and a round + button
 * at the leading edge of the input bar opens a menu where the owner picks the
 * mode. Choosing Notebook shows a "Notebook" chip whose × leaves the mode.
 *
 * Runs as an isolated owner (`X-E2E-Owner`), like
 * `notebookAssistantGold.spec.ts`: `E2E_PORT=8811 E2E_BROWSER=chrome bunx
 * playwright test -c tests/e2e/playwright.config.ts composerModeMenu`. No
 * runner harness: nothing here sends, so no agent backend is needed.
 */

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
// Isolated owner: this file's chats are its own, whatever the file order.
const owner = `e2e-composer-menu-${Date.now()}@example.test`;

test.beforeAll(async ({ browser }) => {
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	await page.setViewportSize({ width: 1280, height: 800 });
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

test("a new chat opens with the Research composer and no mode chip", async () => {
	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	await expect(page.getByRole("form", { name: "Research composer" })).toBeVisible();
	// The old target buttons are gone.
	await expect(page.getByRole("button", { name: "Research", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Leave Notebook mode" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Choose mode" })).toBeVisible();
});

test("the + menu shows the checked mode and switches to Notebook", async () => {
	const research = page.getByRole("form", { name: "Research composer" });
	await research.getByRole("button", { name: "Choose mode" }).click();
	const menu = page.getByRole("menu", { name: "Composer mode" });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitemradio", { name: "Research" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(menu.getByRole("menuitemradio", { name: "Notebook" })).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await menu.getByRole("menuitemradio", { name: "Notebook" }).click();

	// The composer is now the Notebook composer with its chip, and focus is
	// in the instruction box so the owner can type at once.
	const notebook = page.getByRole("form", { name: "Notebook composer" });
	await expect(notebook).toBeVisible();
	await expect(notebook.getByRole("button", { name: "Leave Notebook mode" })).toBeVisible();
	await expect(notebook.getByRole("textbox", { name: "Instruction" })).toBeFocused();
	await reviewShot("notebook-mode.png");
});

test("the chip leaves Notebook mode, and the menu switches back both ways", async () => {
	const notebook = page.getByRole("form", { name: "Notebook composer" });
	await notebook.getByRole("button", { name: "Leave Notebook mode" }).click();
	const research = page.getByRole("form", { name: "Research composer" });
	await expect(research).toBeVisible();
	await expect(research.getByRole("button", { name: "Leave Notebook mode" })).toHaveCount(0);
	await expect(research.getByRole("textbox", { name: "Question" })).toBeVisible();
	await reviewShot("research-mode.png");

	// Back to Notebook through the menu, then back to Research through it.
	await research.getByRole("button", { name: "Choose mode" }).click();
	await page.getByRole("menuitemradio", { name: "Notebook" }).click();
	await expect(page.getByRole("form", { name: "Notebook composer" })).toBeVisible();
	const backToNotebook = page.getByRole("form", { name: "Notebook composer" });
	await backToNotebook.getByRole("button", { name: "Choose mode" }).click();
	const menu = page.getByRole("menu", { name: "Composer mode" });
	await expect(menu.getByRole("menuitemradio", { name: "Notebook" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await menu.getByRole("menuitemradio", { name: "Research" }).click();
	await expect(page.getByRole("form", { name: "Research composer" })).toBeVisible();
});

test("keyboard-only path: Tab to +, open, arrows, select, Escape", async () => {
	const research = page.getByRole("form", { name: "Research composer" });
	const question = research.getByRole("textbox", { name: "Question" });
	await question.click();
	// The + button is the focusable before the textarea.
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByRole("button", { name: "Choose mode" })).toBeFocused();
	// Enter opens with focus on the first item; arrows move; Enter selects.
	await page.keyboard.press("Enter");
	const menu = page.getByRole("menu", { name: "Composer mode" });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitemradio", { name: "Research" })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(menu.getByRole("menuitemradio", { name: "Notebook" })).toBeFocused();
	await page.keyboard.press("Enter");
	const notebook = page.getByRole("form", { name: "Notebook composer" });
	await expect(notebook).toBeVisible();
	await expect(notebook.getByRole("textbox", { name: "Instruction" })).toBeFocused();

	// Escape closes the menu and returns focus to +.
	await notebook.getByRole("button", { name: "Choose mode" }).focus();
	await page.keyboard.press("Enter");
	await expect(menu).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(notebook.getByRole("button", { name: "Choose mode" })).toBeFocused();

	// Back to Research for the tests below.
	await notebook.getByRole("button", { name: "Leave Notebook mode" }).click();
	await expect(page.getByRole("form", { name: "Research composer" })).toBeVisible();
});

test("the open menu stays fully inside the viewport at desktop and phone widths", async () => {
	for (const size of [
		{ width: 1280, height: 800 },
		{ width: 390, height: 844 },
	] as const) {
		await page.setViewportSize(size);
		const research = page.getByRole("form", { name: "Research composer" });
		await expect(research).toBeVisible();
		const trigger = research.getByRole("button", { name: "Choose mode" });
		await trigger.click();
		const menu = page.getByRole("menu", { name: "Composer mode" });
		await expect(menu).toBeVisible();
		const geometry = await page.evaluate(() => {
			const element = document.querySelector('[role="menu"][aria-label="Composer mode"]');
			const button = document.querySelector('button[aria-label="Choose mode"]');
			if (!(element instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
			const box = element.getBoundingClientRect();
			return {
				menu: { x: box.x, y: box.y, right: box.right, bottom: box.bottom },
				buttonTop: button.getBoundingClientRect().top,
				viewport: { width: window.innerWidth, height: window.innerHeight },
			};
		});
		expect(geometry).not.toBeNull();
		// The menu opens upward from the + button (above-start).
		expect(geometry?.menu.bottom ?? Number.NaN).toBeLessThanOrEqual(
			(geometry?.buttonTop ?? Number.NaN) + 1,
		);
		// And it is fully inside the viewport.
		expect(geometry?.menu.x ?? -1).toBeGreaterThanOrEqual(0);
		expect(geometry?.menu.y ?? -1).toBeGreaterThanOrEqual(0);
		expect(geometry?.menu.right ?? Number.NaN).toBeLessThanOrEqual(geometry?.viewport.width ?? -1);
		expect(geometry?.menu.bottom ?? Number.NaN).toBeLessThanOrEqual(
			geometry?.viewport.height ?? -1,
		);
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
	}
	await page.setViewportSize({ width: 1280, height: 800 });

	// Console errors exclude the expected error paths (422/403/404).
	expect(consoleErrors.filter((text) => !/422|403|404/.test(text))).toEqual([]);
});
