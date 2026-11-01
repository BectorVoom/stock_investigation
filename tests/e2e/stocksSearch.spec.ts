import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	stockDirectoryStatusResponseSchema,
	watchlistResponseSchema,
} from "@research/contracts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { directoryFixtureRow } from "./directoryFixtures.ts";
import { E2E_ORIGIN, E2E_PORT } from "./fixtures.ts";

/**
 * The Stocks page's "Find a stock" and "Add to Watchlist" end to end
 * (ADR-0050), as an isolated owner: its stock lists are queued by the
 * server at the first claim of the REAL runner loop started for that owner
 * (ADR-0054 §2; as `equityFinancials.spec.ts` starts one) and downloaded
 * from the fixture lists (`directoryFixtures.ts`), and one
 * list is made through the API. The search opens a stock by pointer and by
 * keyboard (↓ then Enter), focus lands on the stock's heading, and the add
 * button's dialog puts the stock on the watchlist and in the ticked list —
 * read back from the API. CSP stays clean.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const owner = `e2e-stocks-search-${Date.now()}@example.test`;
const consoleErrors: string[] = [];
const WRITE_HEADERS = {
	Origin: E2E_ORIGIN,
	[CSRF_HEADER]: CSRF_HEADER_VALUE,
	"Content-Type": "application/json",
};

test.beforeAll(async ({ browser }) => {
	test.setTimeout(180_000);
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	await page.setViewportSize({ width: 1280, height: 900 });
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
	const list = await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/lists`, {
		headers: WRITE_HEADERS,
		data: { title: "Autos" },
	});
	expect(list.status()).toBe(201);
	// The server finds both lists missing and the runner stores the fixture lists.
	await expect
		.poll(
			async () => {
				const status = await page.request.get(`${E2E_ORIGIN}/api/v1/watchlist/directory`);
				const body = stockDirectoryStatusResponseSchema.parse(await status.json());
				return body.markets.filter((entry) => entry.entryCount > 0).length;
			},
			{ timeout: 150_000, intervals: [1_000] },
		)
		.toBe(2);
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

const heading = () => page.locator('[data-field="stock-detail-heading"]');

test("Find a stock opens a stock by pointer and by keyboard", async () => {
	await page.goto("/#/stocks");
	await expect(page.getByRole("region", { name: "Find a stock" })).toBeVisible();
	await expect(page.locator('[data-field="choose-stock"]')).toContainText("Search for one above");
	const box = page.getByRole("combobox", { name: "Search stocks" });
	const listbox = page.getByRole("listbox", { name: "Matching stocks" });

	const toyota = directoryFixtureRow("JP", "7203");
	await box.fill("toyota");
	const option = listbox.locator('[data-stock-id="jp:7203"]');
	await expect(option).toContainText(toyota.name);
	await option.click();
	await expect(page).toHaveURL(/#\/stocks\/jp:7203$/);
	await expect(heading()).toHaveText(/(^| · )7203$/);
	await expect(heading()).toBeFocused();
	await expect(box).toHaveValue("");

	// Keyboard: ↓ makes the first hit active, Enter opens it.
	const sony = directoryFixtureRow("JP", "6758");
	await box.fill("6758");
	await expect(listbox.locator('[data-stock-id="jp:6758"]')).toContainText(sony.name);
	await box.press("ArrowDown");
	await box.press("Enter");
	await expect(page).toHaveURL(/#\/stocks\/jp:6758$/);
	await expect(heading()).toHaveText(/(^| · )6758$/);
	// Back returns to the stock opened before.
	await page.goBack();
	await expect(page).toHaveURL(/#\/stocks\/jp:7203$/);
});

test("Add to Watchlist puts the stock on the watchlist and in the ticked list", async () => {
	await page.goto("/#/stocks/jp:7203");
	const part = page.locator('[data-field="stock-watchlist"]');
	await part.getByRole("button", { name: "Add to Watchlist" }).click({ timeout: 30_000 });
	const dialog = page.getByRole("dialog", { name: "Add 7203 to the Watchlist" });
	await expect(dialog).toBeVisible();
	const autos = dialog.getByRole("checkbox", { name: /Autos/ });
	await expect(autos).toBeFocused();
	await autos.check();
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(part.locator('[data-field="stock-watchlist-status"]')).toHaveText(
		"On the Watchlist · In lists: Autos",
	);
	// The only list holds it now: nothing more to add (only Remove from
	// Watchlist is left, ADR-0054), and focus is on the heading.
	await expect(part.getByRole("button")).toHaveText(["Remove from Watchlist"]);
	await expect(heading()).toBeFocused();
	const watchlist = await page.request.get(`${E2E_ORIGIN}/api/v1/watchlist`);
	const body = watchlistResponseSchema.parse(await watchlist.json());
	expect(body.stocks.map((stock) => stock.stockId)).toEqual(["jp:7203"]);
	expect(body.lists.map((list) => list.stockIds)).toEqual([["jp:7203"]]);
});

test("the Stocks page search and Add to Watchlist ran under the Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
