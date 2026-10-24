import { type ConsoleMessage, expect, type Page, test } from "@playwright/test";

/**
 * UI languages end to end (ADR-0032): a browser whose preferred language is
 * Japanese gets the Japanese UI on first visit (`<html lang>`, navigation,
 * page headings, the tab title); Settings → Language switches the whole UI
 * at once without a reload, the choice survives a reload, and "Browser
 * default" returns to the browser's language. CSP stays clean throughout.
 */

const JAPANESE_PAGES = [
	{ hash: "#/home", heading: "ホーム" },
	{ hash: "#/watchlist", heading: "ウォッチリスト" },
	{ hash: "#/chat", heading: "チャット" },
	{ hash: "#/sources", heading: "情報源" },
	{ hash: "#/settings", heading: "設定" },
] as const;

function collectConsoleErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (message: ConsoleMessage) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

test.describe("a browser that prefers Japanese", () => {
	test.use({ locale: "ja-JP" });

	test("shows every page in Japanese on first visit", async ({ page }) => {
		const errors = collectConsoleErrors(page);
		await page.goto("/#/home");
		await expect(page.locator("html")).toHaveAttribute("lang", "ja");
		const nav = page.getByRole("navigation", { name: "ページ" });
		for (const entry of JAPANESE_PAGES) {
			await expect(nav.getByRole("link", { name: entry.heading, exact: true })).toBeVisible();
		}
		for (const entry of JAPANESE_PAGES) {
			await page.goto(`/${entry.hash}`);
			await expect(page.getByRole("heading", { level: 2, name: entry.heading })).toBeVisible();
			await expect(page).toHaveTitle(`${entry.heading} · リサーチワークスペース`);
		}
		await expect(page.getByRole("region", { name: "言語" })).toBeVisible();
		expect(errors).toEqual([]);
	});
});

test.describe("Settings → Language", () => {
	test("switches at once, survives a reload and returns to the browser default", async ({
		page,
	}) => {
		const errors = collectConsoleErrors(page);
		await page.goto("/#/settings");
		await expect(page.locator("html")).toHaveAttribute("lang", "en");
		const select = page.getByLabel("Display language");
		await expect(select).toHaveValue("system");

		// A marker on the window proves the switch happened without a reload.
		await page.evaluate(() => Reflect.set(window, "__sameDocument", true));
		await select.selectOption("ja");
		await expect(page.locator("html")).toHaveAttribute("lang", "ja");
		await expect(page.getByRole("heading", { level: 2, name: "設定" })).toBeVisible();
		await expect(page.getByRole("link", { name: "ホーム", exact: true })).toBeVisible();
		expect(await page.evaluate(() => Reflect.get(window, "__sameDocument"))).toBe(true);

		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("lang", "ja");
		const japaneseSelect = page.getByLabel("表示言語");
		await expect(japaneseSelect).toHaveValue("ja");

		await japaneseSelect.selectOption("system");
		await expect(page.locator("html")).toHaveAttribute("lang", "en");
		await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
		await page.reload();
		await expect(page.getByLabel("Display language")).toHaveValue("system");
		expect(errors).toEqual([]);
	});
});
