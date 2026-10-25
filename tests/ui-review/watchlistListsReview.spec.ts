import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { homeDashboardResponseSchema } from "../../packages/contracts/src/home.ts";
import { watchlistResponseSchema } from "../../packages/contracts/src/watchlist.ts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { parseBrowser } from "../e2e/engines.ts";
import { E2E_ORIGIN, E2E_PORT } from "../e2e/fixtures.ts";

/**
 * Scripted UI review of Watchlist lists and the Watchlist prices widget
 * (ADR-0040; `bun run review:ui`, with the other review specs). REVIEW, not a
 * gate: the Watchlist page's stock tabs ("All stocks" before and after the
 * lists exist, a list's tab, an empty list's tab, the phone's tab strip),
 * the New list and Add stock dialogs, and the widget on Home at Small, Medium
 * and Large with prices from the E2E market fixtures (AAPL, MSFT) beside
 * stocks the fixtures do not serve ("unavailable"), at 1440×900 and 390×844.
 * Records PNGs and a findings file (document wider than the viewport) under
 * `test-results/ui-review/<engine>/watchlist-lists/`.
 *
 * Runs as an isolated owner with its own runner harness; every state is
 * produced through the API or the runner.
 */
const REVIEW_BROWSER = parseBrowser(process.env.REVIEW_BROWSER, "REVIEW_BROWSER");
const OUT = `${process.env.UIREVIEW_OUT ?? `test-results/ui-review/${REVIEW_BROWSER}`}/watchlist-lists`;
const OWNER = `ui-review-watchlist-lists-${Date.now()}@example.test`;
const WRITE_HEADERS = {
	Origin: E2E_ORIGIN,
	"X-Research-Csrf": "1",
	"Content-Type": "application/json",
};
const VIEWPORTS = [
	["desktop", 1440, 900],
	["phone", 390, 844],
] as const;
const STOCKS = [
	["US", "AAPL"],
	["US", "MSFT"],
	["US", "TM"],
	["JP", "7203"],
	["JP", "6758"],
	["JP", "7205"],
] as const;

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const findings: { state: string; detail: string }[] = [];

test.beforeAll(async ({ browser }) => {
	mkdirSync(OUT, { recursive: true });
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": OWNER } });
	page = await context.newPage();
	page.on("pageerror", (error) => findings.push({ state: "page", detail: error.message }));
	runner = spawn("node", ["tests/e2e/runnerHarness.ts"], {
		cwd: new URL("../..", import.meta.url).pathname,
		env: {
			...baseChildEnv(),
			...suiteRunnerSettings(),
			E2E_PORT: String(E2E_PORT),
			E2E_RUNNER_OWNER: OWNER,
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
});

test.afterAll(async () => {
	writeFileSync(`${OUT}/findings.json`, `${JSON.stringify(findings, null, 2)}\n`);
	if (runner !== null && runner.exitCode === null) {
		const exited = new Promise<void>((resolve) => runner?.once("exit", () => resolve()));
		runner.kill("SIGTERM");
		await exited;
	}
	await context.close();
});

async function api(method: "POST" | "PUT", path: string, data: unknown): Promise<unknown> {
	const response = await page.request.fetch(`${E2E_ORIGIN}/api/v1${path}`, {
		method,
		headers: WRITE_HEADERS,
		data: JSON.stringify(data),
	});
	expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
	return response.json();
}

/** Screenshots the page at each viewport and records a document wider than the viewport. */
async function shoot(state: string, prepare?: () => Promise<void>): Promise<void> {
	for (const [name, width, height] of VIEWPORTS) {
		await page.setViewportSize({ width, height });
		await prepare?.();
		const overflow = await page.evaluate(() => ({
			width: document.documentElement.scrollWidth,
			viewport: window.innerWidth,
		}));
		if (overflow.width > overflow.viewport + 1) {
			findings.push({
				state: `${state}-${name}`,
				detail: `document is ${overflow.width}px wide in a ${overflow.viewport}px viewport`,
			});
		}
		await page.screenshot({ path: `${OUT}/${state}-${name}.png`, fullPage: true });
	}
}

test("the stock tabs: All stocks, a list, an empty list, the phone strip, and the dialogs", async () => {
	test.setTimeout(240_000);
	await page.goto("/#/watchlist");
	const section = page.getByRole("region", { name: "Registered stocks", exact: true });
	await expect(section.getByRole("button", { name: "New list" })).toBeEnabled({ timeout: 30_000 });
	await shoot("lists-empty");

	for (const [market, symbol] of STOCKS) await api("POST", "/watchlist/stocks", { market, symbol });
	let watchlist = watchlistResponseSchema.parse(
		await api("POST", "/watchlist/lists", { title: "Mega caps" }),
	);
	const megaId = watchlist.lists[0]?.listId ?? "";
	for (const [market, symbol] of STOCKS) {
		await api("POST", `/watchlist/lists/${megaId}/stocks`, { market, symbol });
	}
	watchlist = watchlistResponseSchema.parse(
		await api("POST", "/watchlist/lists", {
			title: "Japanese exporters with a long title that wraps onto a second line",
		}),
	);
	const japanId = watchlist.lists[1]?.listId ?? "";
	await api("POST", `/watchlist/lists/${japanId}/stocks`, { market: "JP", symbol: "7203" });
	await api("POST", "/watchlist/lists", { title: "Empty for now" });

	// The same hash: reload, so the page reads what the API wrote.
	await page.reload();
	const tab = (name: RegExp) => page.getByRole("tab", { name });
	await expect(tab(/^Mega caps \(6\)$/)).toBeVisible({ timeout: 30_000 });
	await shoot("tabs-all-stocks");
	await shoot("tabs-list", async () => {
		await tab(/^Mega caps \(6\)$/).click();
		await expect(page.getByRole("tabpanel")).toContainText("Mega caps · 6 of 12 stocks");
	});
	await shoot("tabs-empty-list", async () => {
		await tab(/^Empty for now \(0\)$/).click();
		await expect(page.getByRole("tabpanel")).toContainText("No stocks in this list yet.");
	});
	// The phone's tab strip, scrolled to its end: it scrolls inside itself.
	await page.setViewportSize({ width: 390, height: 844 });
	await tab(/^Empty for now \(0\)$/).scrollIntoViewIfNeeded();
	await page.getByRole("tablist").screenshot({ path: `${OUT}/tabs-strip-phone.png` });
	const strip = await page.getByRole("tablist").evaluate((element) => ({
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth,
	}));
	if (strip.scrollWidth <= strip.clientWidth) {
		findings.push({ state: "tabs-strip-phone", detail: "the tab strip did not need to scroll" });
	}

	await shoot("lists-new-dialog", async () => {
		await page.keyboard.press("Escape");
		await section.getByRole("button", { name: "New list" }).click();
		await expect(page.getByRole("dialog", { name: "New list" })).toBeVisible();
	});
	await page.keyboard.press("Escape");
	await shoot("lists-add-dialog", async () => {
		await page.keyboard.press("Escape");
		await tab(/^Empty for now \(0\)$/).click();
		await page.getByRole("button", { name: "Add stocks to Empty for now" }).click();
		await expect(page.getByRole("dialog", { name: "Add stocks to Empty for now" })).toBeVisible();
	});
	await page.keyboard.press("Escape");
});

test("the Watchlist prices widget on Home at Small, Medium and Large", async () => {
	test.setTimeout(300_000);
	const watchlist = watchlistResponseSchema.parse(
		await (await page.request.get(`${E2E_ORIGIN}/api/v1/watchlist`)).json(),
	);
	const mega = watchlist.lists.find((list) => list.title === "Mega caps");
	const empty = watchlist.lists.find((list) => list.title === "Empty for now");
	if (mega === undefined || empty === undefined) throw new Error("the lists are missing");
	const current = homeDashboardResponseSchema.parse(
		await (await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`)).json(),
	);
	const widget = (id: string, listId: string, size: "small" | "medium" | "large") => ({
		widgetId: id,
		type: "watchlist-prices",
		title: "Mega caps",
		size,
		listId,
	});
	await api("PUT", "/home/dashboard", {
		dashboard: {
			schemaVersion: 2,
			widgets: [
				widget("w-small", mega.listId, "small"),
				widget("w-empty", empty.listId, "small"),
				widget("w-medium", mega.listId, "medium"),
				widget("w-large", mega.listId, "large"),
			],
		},
		expectedVersion: current.version,
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/home");
	const medium = page.locator('article[data-widget-id="w-medium"]');
	// Home's automatic refresh fetches the list series through the runner.
	await expect(medium.locator("tbody tr[class] time[datetime]").first()).toBeVisible({
		timeout: 180_000,
	});
	await shoot("widget-sizes");
	for (const id of ["w-small", "w-medium", "w-large"]) {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page
			.locator(`article[data-widget-id="${id}"]`)
			.screenshot({ path: `${OUT}/${id}-desktop.png` });
		await page.setViewportSize({ width: 390, height: 844 });
		await page
			.locator(`article[data-widget-id="${id}"]`)
			.screenshot({ path: `${OUT}/${id}-phone.png` });
	}
});
