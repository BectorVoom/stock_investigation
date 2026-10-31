import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@research/contracts";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * The Stocks page end to end (ADR-0049 §1–§3, §5, §6), as an isolated owner:
 * one list over the watchlist and the companies whose statements are
 * synced (a watched stock and a tracked-only one, set up through the API),
 * choosing a stock by its name (a pushed history entry, focus on the detail
 * heading), the tab strip's keyboard model (←/→ wrap, Home, End; a tab
 * switch replaces the entry, so Back never walks tabs), the Financial
 * statements tab of a stock that is not synced and of one that is, and the
 * Company tab. No runner is started: every tab shows what is stored, and
 * opening one never makes the runner fetch. CSP stays clean.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const owner = `e2e-stocks-${Date.now()}@example.test`;
const consoleErrors: string[] = [];
const WRITE_HEADERS = {
	Origin: E2E_ORIGIN,
	[CSRF_HEADER]: CSRF_HEADER_VALUE,
	"Content-Type": "application/json",
};

test.beforeAll(async ({ browser }) => {
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	await page.setViewportSize({ width: 1280, height: 900 });
	// A watched stock (statements not synced) and a tracked-only one.
	const watched = await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/stocks`, {
		headers: WRITE_HEADERS,
		data: { market: "US", symbol: "MSFT" },
	});
	expect(watched.status()).toBe(200);
	const tracked = await page.request.post(`${E2E_ORIGIN}/api/v1/equities/companies`, {
		headers: WRITE_HEADERS,
		data: { stockId: "jp:7974" },
	});
	expect([200, 201]).toContain(tracked.status());
});

test.afterAll(async () => {
	await context.close();
});

const row = (stockId: string) =>
	page.locator(`table[data-field="stocks"] tr[data-stock-id="${stockId}"]`);

test("one list holds the watchlist, then the tracked companies not on it", async () => {
	await page.goto("/#/stocks");
	await expect(page.getByRole("heading", { level: 2, name: "Stocks" })).toBeVisible();
	await expect(row("jp:7974")).toBeVisible({ timeout: 30_000 });
	const ids = await page
		.locator('table[data-field="stocks"] tbody tr')
		.evaluateAll((rows) => rows.map((entry) => entry.getAttribute("data-stock-id")));
	expect(ids).toEqual(["us:MSFT", "jp:7974"]);
	await expect(page.getByRole("tab", { name: "All stocks (2)" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(row("us:MSFT").locator('[data-field="financials"]')).toHaveText("Not synced");
	await expect(row("jp:7974")).toContainText("Not on Watchlist");
	await expect(
		row("jp:7974").getByRole("button", { name: "Add 7974 to the Watchlist" }),
	).toBeVisible();
	await expect(page.locator('[data-field="tracked-count"]')).toHaveText(
		"Statements synced for 1 of 20 companies",
	);
	// Nothing is selected: no tab strip, the hint instead.
	await expect(page.getByText(/Choose a stock to see its chart/)).toBeVisible();
	await expect(page.locator('[data-field="stock-detail"]')).toHaveCount(0);
});

test("choosing a stock pushes its URL and focuses its heading; tabs follow the keyboard and replace the URL", async () => {
	await page.goto("/#/stocks");
	const show = row("us:MSFT").locator('button[data-show-stock="us:MSFT"]');
	await show.click();
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT$/);
	await expect(show).toHaveAttribute("aria-pressed", "true");
	const heading = page.locator('[data-field="stock-detail-heading"]');
	await expect(heading).toContainText("· MSFT");
	await expect(heading).toBeFocused();

	const strip = page.getByRole("tablist", { name: /^Data of / });
	const chart = strip.getByRole("tab", { name: "Chart" });
	const financials = strip.getByRole("tab", { name: "Financial statements" });
	const news = strip.getByRole("tab", { name: "News" });
	await expect(chart).toHaveAttribute("aria-selected", "true");
	await expect(chart).toHaveAttribute("aria-controls", "stock-panel-chart");
	await chart.focus();
	await page.keyboard.press("ArrowRight");
	await expect(financials).toBeFocused();
	await expect(financials).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT\/financials$/);
	await expect(page.locator("#stock-panel-financials")).toBeVisible();
	await expect(page.locator("#stock-panel-chart")).toBeHidden();
	await page.keyboard.press("End");
	await expect(news).toBeFocused();
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT\/news$/);
	await page.keyboard.press("ArrowRight");
	await expect(chart).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(news).toBeFocused();
	await page.keyboard.press("Home");
	await expect(chart).toBeFocused();
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT$/);

	// Another stock pushes; Back returns to the previous stock, then the bare list.
	await row("jp:7974").locator('button[data-show-stock="jp:7974"]').click();
	await expect(page).toHaveURL(/#\/stocks\/jp:7974$/);
	await page.goBack();
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT$/);
	await expect(heading).toContainText("· MSFT");
	await page.goBack();
	await expect(page).toHaveURL(/#\/stocks$/);
	await expect(page.locator('[data-field="stock-detail"]')).toHaveCount(0);
});

test("the Financial statements tab offers to sync a stock that is not synced, and shows a tracked one's sync", async () => {
	await page.goto("/#/stocks/us:MSFT/financials");
	const panel = page.locator("#stock-panel-financials");
	await expect(panel.locator('[data-field="financials-not-tracked"]')).toContainText(
		"Annual financial statements are not synced for this stock.",
		{ timeout: 30_000 },
	);
	await expect(panel.getByRole("button", { name: "Sync financial statements" })).toBeEnabled();

	await page.goto("/#/stocks/jp:7974/financials");
	await expect(panel.locator('[data-field="financials-sync"]')).toBeVisible({ timeout: 30_000 });
	await expect(panel.getByRole("button", { name: /now$/ })).toBeVisible();
	// The filings stay closed (and unread) until opened.
	await expect(panel.locator('[data-field="company-filings"] summary')).toHaveText("Filings (0)");
	await expect(panel.locator('[data-field="company-filings"]')).not.toHaveAttribute("open", "");
});

test("the Company tab lists the listing, the filer and the workspace state", async () => {
	await page.goto("/#/stocks/jp:7974/company");
	const panel = page.locator("#stock-panel-company");
	const listing = panel.locator('[data-field="company-listing"]');
	await expect(listing).toContainText("jp:7974", { timeout: 30_000 });
	await expect(listing).toContainText("Japan");
	await expect(panel.locator('[data-field="company-filer"]')).toContainText("EDINET code");
	await expect(panel.locator('[data-field="company-workspace"]')).toContainText(
		"Not on the Watchlist",
	);
	// A stock not synced says so and offers its Financial statements tab.
	await page.goto("/#/stocks/us:MSFT/company");
	await expect(page.locator('[data-field="company-filer"]')).toContainText(
		"Statements are not synced for this stock",
		{ timeout: 30_000 },
	);
	await page.getByRole("button", { name: "Open Financial statements" }).click();
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT\/financials$/);
});

test("the Stocks page ran under the Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
