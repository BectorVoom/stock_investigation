import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { homeDashboardResponseSchema } from "../../packages/contracts/src/home.ts";
import { watchlistResponseSchema } from "../../packages/contracts/src/watchlist.ts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { directoryFixtureRow } from "./directoryFixtures.ts";
import { E2E_ORIGIN, E2E_PORT } from "./fixtures.ts";

/**
 * Watchlist lists and the Watchlist prices widget end to end (ADR-0040): a
 * list made on the Watchlist page, a watched stock added by its checkbox and
 * a new one found by the stock search (which also puts it on the watchlist),
 * a rename — each from the list's tab over the one stock table — Show on
 * Home (added, then "already on Home"), the widget on Home
 * with each stock's last close and change from the previous close from the
 * E2E market fixtures — fetched through the REAL runner loop by Home's one
 * automatic refresh of the unrefreshed series — the chart viewer from a row,
 * a stock removed from the list, and the list deleted ("This list was
 * deleted"). The pages run under their Content-Security-Policy without
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
	await page.goto("/#/watchlist");
	const section = page.getByRole("region", { name: "Registered stocks", exact: true });
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
	// The search needs the stock lists: opening the page queued them for the runner.
	await expect(page.locator('[data-field="directory-status"] p[data-market="US"]')).toContainText(
		/^US list: [\d,]+ stocks, retrieved /,
		{ timeout: 120_000 },
	);
	// AAPL is on the watchlist before the list exists (the page's own add form).
	const addForm = page.getByRole("form", { name: "Add a stock" });
	await addForm.getByRole("combobox", { name: "Search stocks" }).fill("apple");
	const apple = addForm
		.getByRole("listbox", { name: "Matching stocks" })
		.locator('[data-stock-id="us:AAPL"]');
	await expect(apple).toBeVisible({ timeout: 30_000 });
	await apple.click();
	await addForm.getByRole("button", { name: "Add stock" }).click();
	await expect(page.locator('tr[data-stock-id="us:AAPL"]')).toBeVisible({ timeout: 30_000 });

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
	await page.getByRole("tab", { name: /^All stocks \(\d+\)$/ }).click();
	await expect(page.locator('tr[data-stock-id="us:MSFT"]')).toContainText(
		`In lists: ${FIRST_TITLE}`,
	);

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
	// Home's one automatic refresh fetches the never-refreshed list series
	// through the runner: the rows fill with the fixtures' closes.
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
	await page.getByRole("tab", { name: /^All stocks \(\d+\)$/ }).click();
	await expect(page.locator('tr[data-stock-id="us:MSFT"]')).toBeVisible();

	await page.goto("/#/home");
	const widget = page.locator(`[data-widget-kind="watchlist-prices"][data-list-id="${listId}"]`);
	await expect(widget).toContainText("1 stock", { timeout: 30_000 });
	await expect(widget.locator("tbody tr")).toHaveCount(1);

	await openWatchlist();
	await listMenu(TITLE, "Delete…");
	const confirm = page.getByRole("dialog", { name: `Delete ${TITLE}?` });
	await confirm.getByRole("button", { name: "Delete list" }).click();
	// Its tab is gone; "All stocks" is selected and focused.
	await expect(listTab(TITLE)).toHaveCount(0);
	const all = page.getByRole("tab", { name: /^All stocks \(\d+\)$/ });
	await expect(all).toHaveAttribute("aria-selected", "true");
	await expect(all).toBeFocused();

	await page.goto("/#/home");
	await expect(widget).toContainText("This list was deleted.", { timeout: 30_000 });
	expect((await readWatchlist()).lists).toEqual([]);
});

test("the pages ran under their Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
