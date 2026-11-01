import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { homeDashboardResponseSchema } from "../../packages/contracts/src/home.ts";
import { watchlistResponseSchema } from "../../packages/contracts/src/watchlist.ts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { directoryFixtureRow } from "./directoryFixtures.ts";
import { E2E_ORIGIN, E2E_PORT } from "./fixtures.ts";
import {
	addShownStockToWatchlist,
	openStockFromSearch,
	waitForStoredStockList,
} from "./stocksPage.ts";

/**
 * Watchlist lists and the Watchlist prices widget end to end (ADR-0040): a
 * stock put on the watchlist from the Stocks page (ADR-0050), a list made
 * on the Registered stocks page, a watched stock added by its checkbox and
 * a new one found by the stock search (which also puts it on the watchlist),
 * a rename — each from the list's tab over the one stock table — Show on
 * Home (added, then "already on Home"), the widget on Home
 * with each stock's last close and change from the previous close from the
 * E2E market fixtures — fetched through the REAL runner loop by the
 * server-side sync of never-refreshed series (ADR-0051: the API queues it at
 * the runner's claim, the page re-reads by itself) — the chart viewer from a row,
 * a stock removed from the list, and the list deleted ("This list was
 * deleted"). Registered stocks shows the lists only (ADR-0054): before the
 * first list it says how to make one, and after the last is deleted it
 * says so again with focus on New list. The pages run under their Content-Security-Policy without
 * errors.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) with its own runner harness, so
 * its watchlist, lists and Home dashboard never touch the other specs.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const owner = `e2e-watchlist-lists-${Date.now()}@example.test`;
const consoleErrors: string[] = [];
const FIRST_TITLE = "Big tech";
const TITLE = "Mega caps";

test.beforeAll(async ({ browser }) => {
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
	runner = spawn("node", ["tests/e2e/runnerHarness.ts"], {
		cwd: new URL("../..", import.meta.url).pathname,
		env: {
			...baseChildEnv(),
			...suiteRunnerSettings(),
			E2E_PORT: String(E2E_PORT),
			E2E_RUNNER_OWNER: owner,
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
});

test.afterAll(async () => {
	if (runner !== null && runner.exitCode === null) {
		const exited = new Promise<void>((resolve) => runner?.once("exit", () => resolve()));
		runner.kill("SIGTERM");
		await exited;
	}
	runner = null;
	await context.close();
});

async function readWatchlist() {
	const response = await page.request.get(`${E2E_ORIGIN}/api/v1/watchlist`);
	expect(response.status()).toBe(200);
	return watchlistResponseSchema.parse(await response.json());
}

async function homeListIds(): Promise<string[]> {
	const response = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
	expect(response.status()).toBe(200);
	const { dashboard } = homeDashboardResponseSchema.parse(await response.json());
	return dashboard.widgets.flatMap((widget) =>
		widget.type === "watchlist-prices" ? [widget.listId] : [],
	);
}

async function openWatchlist(): Promise<Locator> {
	await page.goto("/#/registered");
	const section = page.getByRole("region", { name: "Stocks and lists", exact: true });
	await expect(section.getByRole("button", { name: "New list" })).toBeEnabled({ timeout: 30_000 });
	return section;
}

/** A list's tab ("Title (n)"). */
function listTab(title: string): Locator {
	return page.getByRole("tab", { name: new RegExp(`^${title} \\(\\d+\\)$`) });
}

/** Selects the list's tab and answers the tab panel. */
async function listCard(title: string): Promise<Locator> {
	await listTab(title).click();
	await expect(listTab(title)).toHaveAttribute("aria-selected", "true");
	return page.getByRole("tabpanel");
}

async function listMenu(title: string, item: string): Promise<void> {
	const panel = await listCard(title);
	await panel.getByRole("button", { name: `Actions for ${title}`, exact: true }).click();
	await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("a list is made, gets a watched stock and a searched one, and is renamed", async () => {
	test.setTimeout(240_000);
	const section = await openWatchlist();
	// The search needs the stock lists: the server queued them at the runner's claim (ADR-0054 §2).
	await waitForStoredStockList(page, E2E_ORIGIN, "US");
	// AAPL is on the watchlist before the list exists: found on the Stocks
	// page and added there with no list (ADR-0050); this page has no add form.
	await page.goto("/#/stocks");
	await openStockFromSearch(page, "apple", "us:AAPL");
	await addShownStockToWatchlist(page, "AAPL");
	expect((await readWatchlist()).stocks.map((stock) => stock.stockId)).toContain("us:AAPL");
	// No list yet: the page shows no tab and says how to make one (no "All stocks").
	await openWatchlist();
	await expect(section.locator('[data-field="no-lists"]')).toBeVisible();
	await expect(page.getByRole("tab")).toHaveCount(0);

	await section.getByRole("button", { name: "New list" }).click();
	const create = page.getByRole("dialog", { name: "New list" });
	await create.getByRole("textbox", { name: "Title" }).fill(FIRST_TITLE);
	await create.getByRole("button", { name: "Create list" }).click();
	await expect(create).toBeHidden();
	// The new list's tab is selected and focused.
	await expect(listTab(FIRST_TITLE)).toBeFocused();
	await expect(listTab(FIRST_TITLE)).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("tabpanel")).toContainText(`${FIRST_TITLE} · 0 of 12 stocks`);
	await expect(section.locator('[data-field="lists-status"]')).toHaveText(
		`Created ${FIRST_TITLE}.`,
	);

	await (await listCard(FIRST_TITLE))
		.getByRole("button", { name: `Add stocks to ${FIRST_TITLE}` })
		.click();
	const dialog = page.getByRole("dialog", { name: `Add stocks to ${FIRST_TITLE}` });
	await dialog.locator('input[type="checkbox"][data-stock-id="us:AAPL"]').check();
	const microsoft = directoryFixtureRow("US", "MSFT");
	await dialog.getByRole("combobox", { name: "Search stocks" }).fill("microsoft");
	const option = dialog
		.getByRole("listbox", { name: "Matching stocks" })
		.locator('[data-stock-id="us:MSFT"]');
	await expect(option).toBeVisible({ timeout: 30_000 });
	await option.click();
	await expect(dialog.locator('[data-field="list-add-found"]')).toHaveText(
		`Selected: MSFT ${microsoft.name} (US)`,
	);
	await dialog.getByRole("button", { name: "Add 2 stocks to list" }).click();
	await expect(dialog).toBeHidden({ timeout: 30_000 });

	// The tab's table: the list's stocks in list order.
	const members = page.getByRole("tabpanel").locator("tbody tr");
	await expect(members).toHaveCount(2);
	await expect(members.first()).toHaveAttribute("data-stock-id", "us:AAPL");
	await expect(members.nth(1)).toHaveAttribute("data-stock-id", "us:MSFT");
	await expect(listTab(FIRST_TITLE)).toHaveText(`${FIRST_TITLE} (2)`);
	// MSFT was not watched: it is on the watchlist now, and its dates are being fetched.
	await expect(page.getByText(/^Added MSFT to Big tech and to the watchlist\./)).toBeVisible();
	// No row repeats which lists hold the stock: the tab names the list.
	await expect(page.getByRole("tabpanel").locator('[data-field="stock-in-lists"]')).toHaveCount(0);

	await listMenu(FIRST_TITLE, "Rename…");
	const rename = page.getByRole("dialog", { name: `Rename ${FIRST_TITLE}` });
	await rename.getByRole("textbox", { name: "Title" }).fill(TITLE);
	await rename.getByRole("button", { name: "Save" }).click();
	await expect(rename).toBeHidden();
	// The renamed list's tab stays selected.
	await expect(listTab(TITLE)).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("tabpanel")).toContainText(`${TITLE} · 2 of 12 stocks`);

	const watchlist = await readWatchlist();
	expect(watchlist.lists.map((list) => [list.title, list.stockIds])).toEqual([
		[TITLE, ["us:AAPL", "us:MSFT"]],
	]);
});

test("Show on Home adds the widget once, and it shows each stock's change from the previous close", async () => {
	test.setTimeout(240_000);
	const listId = (await readWatchlist()).lists[0]?.listId ?? "";
	await openWatchlist();
	const panel = await listCard(TITLE);
	await panel.getByRole("button", { name: "Show on Home", exact: true }).click();
	const status = page.locator('[data-field="lists-status"]');
	await expect(status).toHaveText(`Added ${TITLE} to Home.`);
	await panel.getByRole("button", { name: "Show on Home", exact: true }).click();
	await expect(status).toHaveText(`${TITLE} is already on Home.`);
	expect(await homeListIds()).toEqual([listId]);

	await page.goto("/#/home");
	const widget = page.locator(`[data-widget-kind="watchlist-prices"][data-list-id="${listId}"]`);
	await expect(widget).toContainText(TITLE, { timeout: 30_000 });
	await expect(widget).toContainText("2 stocks");
	// The API queues a refresh of the never-refreshed list series at the
	// runner's next claim; the page re-reads its data by itself, so the
	// rows fill with the fixtures' closes with no click and no reload.
	const rows = widget.locator("tbody tr");
	await expect(rows).toHaveCount(2);
	for (const symbol of ["AAPL", "MSFT"]) {
		const row = rows.filter({ hasText: symbol });
		await expect(row.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/, {
			timeout: 180_000,
		});
		await expect(row).toContainText("USD");
		await expect(row).toContainText(/[+−-]?\d[\d,.]*%/);
	}
	await expect(widget.locator('[data-field="widget-footer"]')).toContainText("Twelve Data");

	// A row opens the detailed chart viewer.
	const opener = widget.getByRole("button", { name: /^Open chart: .*AAPL/ });
	await opener.click();
	const viewer = page.locator("sl-dialog.chart-viewer[open]");
	await expect(viewer).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press("Escape");
	await expect(viewer).toHaveCount(0);
});

test("a stock removed from the list leaves the widget, and a deleted list says so", async () => {
	test.setTimeout(120_000);
	const listId = (await readWatchlist()).lists[0]?.listId ?? "";
	await openWatchlist();
	const panel = await listCard(TITLE);
	await panel.getByRole("button", { name: `Remove MSFT from ${TITLE}` }).click();
	await expect(panel).toContainText(`${TITLE} · 1 of 12 stocks`);
	await expect(panel.locator('tr[data-stock-id="us:MSFT"]')).toHaveCount(0);
	// Still watched: only the list lost it.
	expect((await readWatchlist()).stocks.map((stock) => stock.stockId)).toContain("us:MSFT");

	await page.goto("/#/home");
	const widget = page.locator(`[data-widget-kind="watchlist-prices"][data-list-id="${listId}"]`);
	await expect(widget).toContainText("1 stock", { timeout: 30_000 });
	await expect(widget.locator("tbody tr")).toHaveCount(1);

	await openWatchlist();
	await listMenu(TITLE, "Delete…");
	const confirm = page.getByRole("dialog", { name: `Delete ${TITLE}?` });
	await confirm.getByRole("button", { name: "Delete list" }).click();
	// Its tab is gone and no list is left: the page says how to make one, focus on New list.
	await expect(listTab(TITLE)).toHaveCount(0);
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.locator('[data-field="no-lists"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "New list" })).toBeFocused();

	await page.goto("/#/home");
	await expect(widget).toContainText("This list was deleted.", { timeout: 30_000 });
	expect((await readWatchlist()).lists).toEqual([]);
});

test("the pages ran under their Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
