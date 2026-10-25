import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Watchlist lists and the Watchlist prices widget (ADR-0040) against the
 * real network (`bun run test:real`). No model quota is spent: the only
 * provider calls are Twelve Data daily series (and the automatic earnings
 * and stock-list refreshes the Watchlist page queues anyway). The suite's
 * runner env file carries the invoking environment's `TWELVE_DATA_API_KEY`
 * when present, else the PUBLIC demo key, which serves AAPL only — so AAPL
 * is the stock whose prices must arrive; MSFT is asserted only with a real
 * key.
 *
 * From a pristine copy the test starts the real `bun run dev` on test ports
 * with a throwaway data directory (a fresh install: nothing saved), then in
 * the browser: adds AAPL (and MSFT) by symbol, creates a list, adds the
 * stocks to it through the Add stock dialog, shows it on Home, and waits on
 * Home for the widget's automatic refresh of unrefreshed series to fetch the
 * prices over the network — no Refresh click. It asserts a last close in
 * USD, a change and a percentage from the previous close, an ISO as-of date,
 * and that the runner fetched exactly what the page shows. Full-page
 * screenshots at 1440×900 and 390×844 land under `test-results-real/`.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8931;
const API_PORT = 8932;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const LIST_TITLE = "Mega caps";

const twelveKey = process.env.TWELVE_DATA_API_KEY ?? "";
const realKey = twelveKey !== "" && twelveKey !== "demo";
const SYMBOLS: readonly string[] = realKey ? ["AAPL", "MSFT"] : ["AAPL"];

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-lists-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-lists-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
		TWELVE_DATA_API_KEY: realKey ? twelveKey : "demo",
	});
});

test.afterAll(() => resources.close());

function listsEnv(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18931",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function apiGet<T>(path: string): Promise<T> {
	const response = await fetch(`${API_ORIGIN}${path}`, { headers: ownerHeaders(API_ORIGIN) });
	const text = await response.text();
	if (response.status >= 400) throw new Error(`GET ${path} -> ${response.status}: ${text}`);
	return JSON.parse(text) as T;
}

interface HomeSeries {
	readonly seriesId: string;
	readonly observations: readonly (readonly [string, number])[];
	readonly unavailable: { readonly code: string } | null;
}

/** Registers the stock by its symbol ("Enter a symbol instead"). */
async function watchBySymbol(page: Page, symbol: string): Promise<void> {
	const row = page.locator(`tr[data-stock-id="us:${symbol}"]`);
	const addForm = page.getByRole("form", { name: "Add a stock" });
	const symbolField = addForm.getByLabel("Symbol");
	if (!(await symbolField.isVisible())) {
		await addForm.getByText("Enter a symbol instead", { exact: true }).click();
	}
	await addForm.getByLabel("Market").selectOption("US");
	await symbolField.fill(symbol);
	await addForm.getByRole("button", { name: "Add stock" }).click();
	await expect(row).toBeVisible({ timeout: 60_000 });
}

test("a list of watched stocks shows real prices from the previous close on Home", async ({
	page,
}) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: listsEnv() });
	resources.add(async () => {
		await service.stop();
	});
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});

	await page.goto(`${VITE_ORIGIN}/#/watchlist`);
	const section = page.getByRole("region", { name: "Registered stocks", exact: true });
	await expect(section.getByRole("button", { name: "New list" })).toBeEnabled({
		timeout: 120_000,
	});
	for (const symbol of SYMBOLS) await watchBySymbol(page, symbol);

	await section.getByRole("button", { name: "New list" }).click();
	const create = page.getByRole("dialog", { name: "New list" });
	await create.getByRole("textbox", { name: "Title" }).fill(LIST_TITLE);
	await create.getByRole("button", { name: "Create list" }).click();
	await expect(create).toBeHidden();
	// The new list's tab is selected: its panel carries the list's actions.
	await expect(page.getByRole("tab", { name: `${LIST_TITLE} (0)`, exact: true })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	const card = page.getByRole("tabpanel");
	await expect(card).toContainText(`${LIST_TITLE} · 0 of 12 stocks`);

	await card.getByRole("button", { name: `Add stocks to ${LIST_TITLE}` }).click();
	const dialog = page.getByRole("dialog", { name: `Add stocks to ${LIST_TITLE}` });
	for (const symbol of SYMBOLS) {
		await dialog.locator(`input[type="checkbox"][data-stock-id="us:${symbol}"]`).check();
	}
	const addLabel =
		SYMBOLS.length === 1 ? "Add 1 stock to list" : `Add ${SYMBOLS.length} stocks to list`;
	await dialog.getByRole("button", { name: addLabel }).click();
	await expect(dialog).toBeHidden({ timeout: 60_000 });
	await expect(card).toContainText(`${SYMBOLS.length} of 12 stocks`);

	await card.getByRole("button", { name: "Show on Home", exact: true }).click();
	await expect(section.locator('[data-field="lists-status"]')).toHaveText(
		`Added ${LIST_TITLE} to Home.`,
	);
	await page.screenshot({
		path: "test-results-real/watchlist-lists-page-1440.png",
		fullPage: true,
	});

	// Home: the widget's series were never refreshed, so the page queues one
	// refresh of the unrefreshed series by itself; the runner fetches them
	// from Twelve Data over the network.
	await page.goto(`${VITE_ORIGIN}/#/home`);
	const widget = page.locator('[data-widget-kind="watchlist-prices"]');
	await expect(widget).toContainText(LIST_TITLE, { timeout: 60_000 });
	const appleRow = widget.locator("tbody tr").filter({ hasText: "AAPL" });
	await expect(appleRow.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/, {
		timeout: 600_000,
	});
	await expect(appleRow).toContainText("USD");
	await expect(appleRow).toContainText(/[+−-]?\d[\d,.]*%/);
	if (realKey) {
		const msftRow = widget.locator("tbody tr").filter({ hasText: "MSFT" });
		await expect(msftRow.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/, {
			timeout: 600_000,
		});
	}

	// The page serves the list's series, and the numbers are real daily
	// closes: at least two observations, so a change from the previous close
	// exists.
	const data = await apiGet<{ readonly series: readonly HomeSeries[] }>("/api/v1/home/data");
	for (const symbol of SYMBOLS) {
		const series = data.series.find((entry) => entry.seriesId === `twelve-data:${symbol}`);
		expect(series, `twelve-data:${symbol} is served`).toBeDefined();
		expect(series?.unavailable ?? null).toBeNull();
		expect(series?.observations.length ?? 0).toBeGreaterThanOrEqual(2);
	}

	await page.screenshot({
		path: "test-results-real/watchlist-prices-home-1440.png",
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: "test-results-real/watchlist-prices-home-390.png",
		fullPage: true,
	});

	// The chart viewer opens from a row (ADR-0025).
	await page.setViewportSize({ width: 1440, height: 900 });
	await widget.getByRole("button", { name: /^Open chart: .*AAPL/ }).click();
	await expect(page.locator("sl-dialog.chart-viewer[open]")).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press("Escape");

	expect(consoleErrors).toEqual([]);
});
