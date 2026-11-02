import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { CSRF_HEADER, CSRF_HEADER_VALUE, watchlistResponseSchema } from "@research/contracts";
import { recordTrackedCompany } from "./equityTracking.ts";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * The Registered stocks and Stocks pages end to end (ADR-0049 §1–§3, §5,
 * §6, ADR-0054), as an isolated owner: Registered stocks holds the
 * Watchlist's lists as tabs — no "All stocks" tab, no earnings or
 * financials columns, no sync control — and with no list it says how to
 * make one; each row's name links to the stock on the Stocks page (a pushed
 * history entry, focus on the stock's heading). The Stocks page shows one
 * stock's tabs only — no table — with the tab strip's keyboard model (←/→
 * wrap, Home, End; a tab switch replaces the entry, so Back never walks
 * tabs), a link back to Registered stocks, the Financial statements tab of
 * a tracked stock the server has not synced yet and of a stock outside the
 * stored stock lists (read-only, no Sync now; the Watchlist does not
 * matter, ADR-0058), the Company tab (the listing, then the business
 * description's state, ADR-0053), and Remove from Watchlist; with no stock
 * it says where to choose one and reads nothing. No runner is started for
 * the owner, so no stock list is stored for it: every tab shows what is
 * stored, opening one never makes the runner fetch, and the tracked
 * company is recorded as the server's reconcile would (`equityTracking.ts`).
 * CSP stays clean.
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
	// Two Watchlist stocks in one list; the server tracks Nintendo's company,
	// nothing stored yet (recorded directly: no runner claims for this owner).
	for (const symbol of ["MSFT", "7974"]) {
		const watched = await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/stocks`, {
			headers: WRITE_HEADERS,
			data: { market: symbol === "MSFT" ? "US" : "JP", symbol },
		});
		expect(watched.status()).toBe(200);
	}
	const created = await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/lists`, {
		headers: WRITE_HEADERS,
		data: { title: "Mine" },
	});
	expect(created.status()).toBe(201);
	const listId = watchlistResponseSchema.parse(await created.json()).lists[0]?.listId ?? "";
	expect(listId).not.toBe("");
	for (const stock of [
		{ market: "US", symbol: "MSFT" },
		{ market: "JP", symbol: "7974" },
	]) {
		const added = await page.request.post(
			`${E2E_ORIGIN}/api/v1/watchlist/lists/${encodeURIComponent(listId)}/stocks`,
			{ headers: WRITE_HEADERS, data: stock },
		);
		expect(added.status()).toBe(200);
	}
	recordTrackedCompany({ ownerId: owner, market: "JP", symbol: "7974", name: "任天堂株式会社" });
});

test.afterAll(async () => {
	await context.close();
});

const row = (stockId: string) =>
	page.locator(`table[data-field="stocks"] tr[data-stock-id="${stockId}"]`);
/** A row's name: the link to the stock on the Stocks page. */
const showLink = (stockId: string) => row(stockId).locator(`a[data-show-stock="${stockId}"]`);

/** Controls that would start a sync from the page (ADR-0054: there are none). */
const SYNC_CONTROL = /sync|update stock list|refresh/i;

test("Registered stocks shows the lists only: no All stocks tab, no earnings or financials column, no sync control", async () => {
	await page.goto("/#/registered");
	await expect(page.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Stocks and lists", exact: true })).toBeVisible();
	await expect(row("jp:7974")).toBeVisible({ timeout: 30_000 });
	const ids = await page
		.locator('table[data-field="stocks"] tbody tr')
		.evaluateAll((rows) => rows.map((entry) => entry.getAttribute("data-stock-id")));
	expect(ids).toEqual(["us:MSFT", "jp:7974"]);
	// The list's tab is the only tab, selected; there is no "All stocks".
	const tabs = page.getByRole("tablist", { name: "Stock lists" }).getByRole("tab");
	await expect(tabs).toHaveCount(1);
	await expect(tabs.first()).toHaveText("Mine (2)");
	await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("tab", { name: /All stocks/ })).toHaveCount(0);
	// Symbol, market and the row's actions: no Next announcement, no Financials.
	const headers = await page
		.locator('table[data-field="stocks"] thead th')
		.evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim() ?? ""));
	expect(headers).toEqual(["Symbol", "Market", "Actions"]);
	await expect(page.locator('[data-field="financials"]')).toHaveCount(0);
	await expect(page.locator('[data-field="watchlist-status"]')).toHaveCount(0);
	// Nothing on the page starts a sync: no Sync now, no Update stock list, no Refresh.
	await expect(page.getByRole("button", { name: SYNC_CONTROL })).toHaveCount(0);
	await expect(page.getByRole("menuitem", { name: SYNC_CONTROL })).toHaveCount(0);
	await expect(
		row("us:MSFT").getByRole("button", { name: /^Remove MSFT from Mine/ }),
	).toBeVisible();
	// The table keeps its name for screen readers, but the caption is not shown (ADR-0050 §5).
	const caption = page.locator('table[data-field="stocks"] caption');
	await expect(caption).toHaveText("Stocks in Mine");
	expect((await caption.boundingBox())?.height ?? 0).toBeLessThanOrEqual(1);
	// Each name links to its stock on the Stocks page; this page shows no stock.
	await expect(showLink("us:MSFT")).toHaveAttribute("href", "#/stocks/us:MSFT");
	await expect(showLink("jp:7974")).toHaveAttribute("href", "#/stocks/jp:7974");
	await expect(page.locator('[data-field="stock-detail"]')).toHaveCount(0);
	await expect(page.getByRole("tablist", { name: /^Data of / })).toHaveCount(0);
});

test("Registered stocks with no list says how to make one", async ({ browser }) => {
	const other = await browser.newContext({
		extraHTTPHeaders: { "X-E2E-Owner": `e2e-stocks-nolists-${Date.now()}@example.test` },
	});
	try {
		const fresh = await other.newPage();
		await fresh.goto("/#/registered");
		await expect(fresh.locator('[data-field="no-lists"]')).toHaveText(
			"No lists yet. Make one with New list. Stocks go on the Watchlist from the Stocks page.",
			{ timeout: 30_000 },
		);
		await expect(fresh.getByRole("tab")).toHaveCount(0);
		await expect(fresh.getByRole("button", { name: "New list" })).toBeEnabled();
		await expect(fresh.getByRole("button", { name: SYNC_CONTROL })).toHaveCount(0);
	} finally {
		await other.close();
	}
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

test("the Financial statements tab says the server syncs every listed stock and offers no sync control", async () => {
	const panel = page.locator("#stock-panel-financials");
	// Tracked, nothing stored yet: on the way, with no sync line and no Sync now (ADR-0055 §4).
	await page.goto("/#/stocks/jp:7974/financials");
	const none = panel.locator('[data-field="financials-none"]');
	await expect(none).toContainText(
		"No financial statements are stored for this stock yet. The server fetches the statements of every listed stock",
		{ timeout: 30_000 },
	);
	await expect(none).toHaveAttribute("data-listed", "true");
	await expect(panel.locator('[data-field="financials-sync"]')).toHaveCount(0);
	await expect(panel.getByRole("button")).toHaveCount(0);

	// No stock list is stored for this owner, so MSFT — on the Watchlist — and
	// GOOG — off it — are both outside it: no statements will come.
	for (const stockId of ["us:MSFT", "us:GOOG"]) {
		await page.goto(`/#/stocks/${stockId}/financials`);
		await expect(none).toHaveAttribute("data-listed", "false", { timeout: 30_000 });
		await expect(none).toContainText(
			"The server fetches the statements of the stocks in the stored US and Japanese stock lists, and this stock is not in them.",
		);
		await expect(none).not.toContainText("Watchlist");
		await expect(panel.getByRole("button", { name: SYNC_CONTROL })).toHaveCount(0);
	}
});

test("the Company tab lists the stock's listing, then its company profile or business description's state", async () => {
	await page.goto("/#/stocks/jp:7974/company");
	const panel = page.locator("#stock-panel-company");
	const listing = panel.locator('[data-field="company-listing"]');
	await expect(listing).toContainText("jp:7974", { timeout: 30_000 });
	await expect(listing).toContainText("Japan");
	// A Japanese stock has no business description, only a J-Quants company
	// profile (ADR-0059 §3); no runner here stored one, so it says so.
	const profile = panel.getByRole("region", { name: "Company profile" });
	await expect(profile.locator('[data-field="company-profile-none"]')).toHaveText(
		"No company profile is stored for this stock yet. The server stores the profiles of Japanese stocks from J-Quants with the Japanese stock list; it appears here once stored.",
	);
	await expect(panel.locator("section")).toHaveCount(2);
	await expect(panel.locator('[data-field="company-business"]')).toHaveCount(0);

	// A US stock outside the stored stock lists says where descriptions come from, with no control.
	const business = panel.getByRole("region", { name: "Business" });
	await page.goto("/#/stocks/us:MSFT/company");
	await expect(business.locator('[data-field="business-not-tracked"]')).toBeVisible({
		timeout: 30_000,
	});
	await expect(business.getByRole("button")).toHaveCount(0);
});

test("Remove from Watchlist on the Stocks page takes the stock off the Watchlist and its lists", async () => {
	await page.goto("/#/stocks/us:MSFT");
	const status = page.locator('[data-field="stock-watchlist-status"]');
	await expect(status).toHaveText("On the Watchlist · In lists: Mine", { timeout: 30_000 });
	const remove = page.locator('[data-field="stock-remove-from-watchlist"]');
	await expect(remove).toHaveText("Remove from Watchlist");
	await remove.click();
	const dialog = page.getByRole("dialog", { name: "Remove MSFT?" });
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-field="remove-leaves-lists"]')).toHaveText(
		"Also removes it from 1 list.",
	);
	await dialog.getByRole("button", { name: "Remove stock" }).click();
	await expect(dialog).toBeHidden();
	await expect(status).toHaveCount(0);
	await expect(remove).toHaveCount(0);
	await expect(page.locator('[data-field="stock-add-to-watchlist"]')).toHaveText(
		"Add to Watchlist",
	);
	await expect(page.locator('[data-field="stock-detail-heading"]')).toBeFocused();
	// The list keeps only Nintendo.
	await page.goto("/#/registered");
	await expect(page.getByRole("tab", { name: "Mine (1)" })).toBeVisible({ timeout: 30_000 });
	await expect(row("us:MSFT")).toHaveCount(0);
	await expect(row("jp:7974")).toBeVisible();
});

test("the Registered stocks and Stocks pages ran under the Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
