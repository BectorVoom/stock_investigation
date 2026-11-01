import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@research/contracts";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * The Registered stocks and Stocks pages end to end (ADR-0049 §1–§3, §5,
 * §6), as an isolated owner: Registered stocks holds one list over the
 * watchlist and the companies whose statements are synced (a watched stock
 * and a tracked-only one, set up through the API), and each row's name links
 * to the stock on the Stocks page (a pushed history entry, focus on the
 * stock's heading). The Stocks page
 * shows one stock's tabs only — no table — with the tab strip's keyboard
 * model (←/→ wrap, Home, End; a tab switch replaces the entry, so Back never
 * walks tabs), a link back to Registered stocks, the Financial statements tab
 * of a stock that is not synced and of one that is, and the Company tab; with
 * no stock it says where to choose one and reads nothing. No runner is
 * started: every tab shows what is stored, and opening one never makes the
 * runner fetch. CSP stays clean.
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
/** A row's name: the link to the stock on the Stocks page. */
const showLink = (stockId: string) => row(stockId).locator(`a[data-show-stock="${stockId}"]`);

test("Registered stocks holds one list: the watchlist, then the tracked companies not on it", async () => {
	await page.goto("/#/registered");
	await expect(page.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Stocks and lists", exact: true })).toBeVisible();
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
	// The table keeps its name for screen readers, but the caption is not shown (ADR-0050 §5).
	const caption = page.locator('table[data-field="stocks"] caption');
	await expect(caption).toHaveText(
		"Your stocks: the watchlist, then the companies whose statements are synced",
	);
	expect((await caption.boundingBox())?.height ?? 0).toBeLessThanOrEqual(1);
	// The section header carries no companies count and no hint (ADR-0050 §5).
	await expect(page.locator('[data-field="tracked-count"]')).toHaveCount(0);
	await expect(page.getByText(/Statements synced for/)).toHaveCount(0);
	// Each name links to its stock on the Stocks page; this page shows no stock.
	await expect(showLink("us:MSFT")).toHaveAttribute("href", "#/stocks/us:MSFT");
	await expect(showLink("jp:7974")).toHaveAttribute("href", "#/stocks/jp:7974");
	await expect(page.locator('[data-field="stock-detail"]')).toHaveCount(0);
	await expect(page.getByRole("tablist", { name: /^Data of / })).toHaveCount(0);
});

test("the Stocks page with no stock says where to choose one and reads nothing until a search", async () => {
	// A fresh page, so no request of an earlier page is counted.
	const fresh = await context.newPage();
	const reads: string[] = [];
	fresh.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (/^\/api\/v1\/(watchlist|equities|stocks)(\/|$)/.test(path)) reads.push(path);
	});
	await fresh.goto("/#/stocks");
	await expect(fresh.getByRole("heading", { level: 2, name: "Stocks" })).toBeVisible();
	const choose = fresh.locator('[data-field="choose-stock"]');
	await expect(choose).toContainText(
		"No stock is shown. Search for one above, or choose one on the Registered stocks page",
	);
	await expect(fresh.getByRole("combobox", { name: "Search stocks" })).toBeVisible();
	await expect(fresh.locator('table[data-field="stocks"]')).toHaveCount(0);
	// The page's own reads have been sent by now (it has rendered and settled).
	await fresh.waitForLoadState("networkidle");
	expect(reads).toEqual([]);
	await choose.getByRole("link", { name: "Open Registered stocks" }).click();
	await expect(fresh).toHaveURL(/#\/registered$/);
	await expect(fresh.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible();
	await fresh.close();
});

test("a name opens the stock on the Stocks page; tabs follow the keyboard and replace the URL; Choose another stock goes back", async () => {
	await page.goto("/#/registered");
	await showLink("us:MSFT").click();
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT$/);
	const heading = page.locator('[data-field="stock-detail-heading"]');
	await expect(heading).toHaveText(/(^| · )MSFT$/);
	// The opened stock's heading takes the focus (the linking page may have been scrolled).
	await expect(heading).toBeFocused();
	await expect(page.getByRole("heading", { level: 2, name: "Stocks" })).toBeVisible();
	// The Stocks page holds the search and the stock's tabs: no table, no add form.
	await expect(page.locator('table[data-field="stocks"]')).toHaveCount(0);
	await expect(page.getByRole("form", { name: "Add a stock" })).toHaveCount(0);
	await expect(page.getByRole("combobox", { name: "Search stocks" })).toBeVisible();

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

	// "Choose another stock" returns to Registered stocks, where another name pushes again.
	const chooseOther = page.getByRole("link", { name: "Choose another stock" });
	await expect(chooseOther).toHaveAttribute("href", "#/registered");
	await chooseOther.click();
	await expect(page).toHaveURL(/#\/registered$/);
	await expect(page.locator('[data-field="stock-detail"]')).toHaveCount(0);
	await showLink("jp:7974").click();
	await expect(page).toHaveURL(/#\/stocks\/jp:7974$/);
	await expect(heading).toHaveText(/(^| · )7974$/);
	await expect(heading).toBeFocused();

	// Back walks pages, never tabs: Registered stocks, MSFT, Registered stocks.
	await page.goBack();
	await expect(page).toHaveURL(/#\/registered$/);
	await page.goBack();
	await expect(page).toHaveURL(/#\/stocks\/us:MSFT$/);
	await expect(heading).toHaveText(/(^| · )MSFT$/);
	await page.goBack();
	await expect(page).toHaveURL(/#\/registered$/);
	await expect(row("us:MSFT")).toBeVisible({ timeout: 30_000 });
	// The Stocks navigation link reopens the stock last shown in this tab.
	await expect(
		page.getByRole("navigation").getByRole("link", { name: "Stocks", exact: true }),
	).toHaveAttribute("href", "#/stocks/us:MSFT");
});

test("a stock that is not registered still shows its tabs from what is stored", async () => {
	await page.goto("/#/stocks/us:GOOG/company");
	await expect(page.locator('[data-field="stock-detail-heading"]')).toHaveText(/(^| · )GOOG$/, {
		timeout: 30_000,
	});
	await expect(page.locator('[data-field="company-listing"]')).toContainText("us:GOOG");
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

test("the Company tab lists the stock's listing only", async () => {
	await page.goto("/#/stocks/jp:7974/company");
	const panel = page.locator("#stock-panel-company");
	const listing = panel.locator('[data-field="company-listing"]');
	await expect(listing).toContainText("jp:7974", { timeout: 30_000 });
	await expect(listing).toContainText("Japan");
	await expect(panel.locator("section")).toHaveCount(1);
});

test("the Registered stocks and Stocks pages ran under the Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
