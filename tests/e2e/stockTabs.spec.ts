import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { articleListResponseSchema, CSRF_HEADER, CSRF_HEADER_VALUE } from "@research/contracts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { E2E_ORIGIN, E2E_PORT, FEED_URL } from "./fixtures.ts";
import { waitForHomeSeries } from "./marketSync.ts";
import {
	MENTIONING_TITLE,
	NEWS_MENTIONED_STOCK,
	NEWS_PAGED_STOCK,
	NEWS_PAGES,
	NEWS_SECOND_CURSOR,
} from "./stockTabsFixtures.ts";

/**
 * The Stocks page's Chart and News tabs end to end (ADR-0049 §4, §7), as
 * an isolated owner with its own REAL runner loop: Home's default stock
 * table's series are synchronised by the server at that runner's claims
 * (ADR-0051), so the runner stores the recorded Twelve Data AAPL closes
 * (`marketFixtures.ts`), and the synthetic feed (`fixtures.ts`), once
 * subscribed, is ingested into the owner's articles by the news sync the
 * server queues for a never-fetched source (ADR-0053 §4). The Chart tab draws the stored closes in the
 * inline viewer (presets, From/To, the data-table twin, no dialog); the
 * News tab lists the stored article that mentions a stock, says so when
 * none does, and appends a second page on Show more (served for one stock
 * from `stockTabsFixtures.ts`, since the feed holds only two items).
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const owner = `e2e-stock-tabs-${Date.now()}@example.test`;
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

async function addToWatchlist(market: "US" | "JP", symbol: string): Promise<void> {
	const answer = await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/stocks`, {
		headers: WRITE_HEADERS,
		data: { market, symbol },
	});
	expect(answer.status()).toBe(200);
}

function panel(name: "Chart" | "News") {
	return page.getByRole("tabpanel", { name });
}

test("stored data: Home's stock table stores AAPL's closes and the feed's articles are ingested", async () => {
	test.setTimeout(180_000);
	await page.goto("/#/home");
	// The server-side sync (ADR-0051) fetches never-refreshed series at
	// this owner's runner's next claim.
	await waitForHomeSeries(page.request, E2E_ORIGIN, ["twelve-data:AAPL"]);

	const subscribed = await page.request.post(`${E2E_ORIGIN}/api/v1/sources`, {
		headers: WRITE_HEADERS,
		data: {
			url: FEED_URL,
			licensePolicy: "short-excerpt-permitted",
			trustClassification: "unclassified",
		},
	});
	expect(subscribed.status()).toBe(201);
	// No refresh request: the server ingests the never-fetched source at the runner's next claim.
	await expect
		.poll(
			async () => {
				const answer = await page.request.get(`${E2E_ORIGIN}/api/v1/articles`);
				if (answer.status() !== 200) return 0;
				return articleListResponseSchema.parse(await answer.json()).articles.length;
			},
			{ timeout: 90_000 },
		)
		.toBeGreaterThanOrEqual(2);

	await addToWatchlist("US", "AAPL");
	await addToWatchlist(NEWS_MENTIONED_STOCK.market, NEWS_MENTIONED_STOCK.symbol);
	await addToWatchlist(NEWS_PAGED_STOCK.market, NEWS_PAGED_STOCK.symbol);
});

test("the Chart tab draws AAPL's stored closes in the inline viewer, opening at 1Y", async () => {
	await page.goto("/#/stocks/us:AAPL");
	const chart = panel("Chart");
	const summary = chart.locator('[data-field="stock-chart-summary"]');
	await expect(summary).toContainText("Last close", { timeout: 30_000 });
	await expect(summary).toContainText("USD");
	await expect(summary).toContainText("2026-10-09");
	await expect(summary.getByRole("link", { name: "Twelve Data" })).toBeVisible();

	await expect(chart.getByRole("heading", { level: 4, name: /daily closes$/ })).toBeVisible();
	await expect(chart.getByRole("group", { name: /daily closes$/ })).toBeVisible();
	await expect(chart.getByRole("button", { name: "1Y", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// Inline: no dialog, no Close button, and Escape on the chart closes nothing.
	await expect(page.locator("sl-dialog")).toHaveCount(0);
	await expect(chart.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
	await chart.getByRole("group", { name: /daily closes$/ }).focus();
	await page.keyboard.press("Escape");
	await expect(chart.getByRole("group", { name: /daily closes$/ })).toBeVisible();
});

test("opened straight from a link, the Chart tab's controls draw their icons without a blocked fetch", async () => {
	// A fresh page that never visited Home: nothing else registered the
	// Shoelace icon libraries, so the viewer must (CSP `connect-src 'self'`
	// blocks the library's default `data:` icons).
	const fresh = await context.newPage();
	const errors: string[] = [];
	fresh.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await fresh.setViewportSize({ width: 1440, height: 900 });
	await fresh.goto("/#/stocks/us:AAPL");
	const chart = fresh.getByRole("tabpanel", { name: "Chart" });
	await expect(chart.getByRole("group", { name: /daily closes$/ })).toBeVisible({
		timeout: 30_000,
	});
	// The select's expand icon resolves to the shipped same-origin SVG.
	const icon = chart.locator("sl-select").first().locator("sl-icon").first();
	await expect
		.poll(() => icon.evaluate((element) => element.shadowRoot?.querySelector("svg") !== null))
		.toBe(true);
	await fresh.close();
	expect(errors).toEqual([]);
});

test("a preset and the From date change the window; the data-table twin lists the visible closes", async () => {
	const chart = panel("Chart");
	await chart.getByRole("button", { name: "1W", exact: true }).click();
	await expect(chart.getByRole("button", { name: "1W", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(chart.getByRole("button", { name: "1Y", exact: true })).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	const twin = chart.locator("details", { hasText: "Data table:" });
	await twin.locator("summary").click();
	// The recorded response holds five daily closes, 2026-10-05 to 2026-10-09.
	await expect(twin.locator("tbody tr")).toHaveCount(5);
	await chart.getByLabel("From").fill("2026-10-07");
	await chart.getByLabel("From").dispatchEvent("change");
	await expect(twin.locator("tbody tr")).toHaveCount(3);
	await expect(twin.locator("tbody tr").first()).toContainText("2026-10-07");
	await expect(chart.getByRole("button", { name: "1W", exact: true })).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	// Kept while the stock stays selected: News and back keeps the window.
	await page.getByRole("tab", { name: "News" }).click();
	await page.getByRole("tab", { name: "Chart" }).click();
	await expect(twin.locator("tbody tr")).toHaveCount(3);
});

test("the News tab lists the stored article that mentions the stock, as inert text", async () => {
	await page.goto(`/#/stocks/${NEWS_MENTIONED_STOCK.stockId}/news`);
	const news = panel("News");
	const item = news.getByRole("listitem").filter({ hasText: MENTIONING_TITLE });
	await expect(item).toBeVisible({ timeout: 30_000 });
	await expect(item.getByRole("link", { name: MENTIONING_TITLE })).toHaveAttribute(
		"href",
		/^https:\/\/news\.example\.org\/articles\/injection/,
	);
	await expect(item).toContainText("Example Energy News (synthetic)");
	await expect(item).toContainText("Published Sep 30, 2026");
	await expect(item).toContainText(`Mentions: ${NEWS_MENTIONED_STOCK.symbol}`);
	await expect(news.getByRole("listitem")).toHaveCount(1);
	await expect(news).toContainText(`Searched for: ${NEWS_MENTIONED_STOCK.symbol}`);
	await expect(news.getByRole("button", { name: "Show more" })).toHaveCount(0);
});

test("the News tab says when no stored article mentions the stock, with a link to Sources", async () => {
	await page.goto("/#/stocks/us:AAPL/news");
	const none = panel("News").locator('[data-field="stock-news-none"]');
	await expect(none).toContainText(
		/No stored article mentions .+\. Articles come from the feeds chosen on Sources\./,
		{ timeout: 30_000 },
	);
	await expect(none).toContainText(/Searched for: .*AAPL/);
	await expect(none.getByRole("link", { name: "Open Sources" })).toHaveAttribute(
		"href",
		"#/sources",
	);
});

test("Sources lists the subscribed feed with no Refresh news now: the server refreshes it", async () => {
	await page.goto("/#/sources");
	const subscribed = page.getByRole("region", { name: "Subscribed sources", exact: true });
	await expect(subscribed.locator('[data-field="sources-refresh-hint"]')).toHaveText(
		"The server refreshes these feeds about every 30 minutes; the local runner fetches them.",
	);
	await expect(subscribed.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("button", { name: /refresh|sync/i })).toHaveCount(0);
});

test("Show more appends the next page and announces the count", async () => {
	const newsPath = /\/api\/v1\/stocks\/us%3AMSFT\/news(?:\?(.*))?$/;
	const served: string[] = [];
	await page.route(newsPath, async (route) => {
		const query = new URL(route.request().url()).searchParams.get("cursor");
		served.push(query ?? "first");
		const body = query === NEWS_SECOND_CURSOR ? NEWS_PAGES.second : NEWS_PAGES.first;
		await route.fulfill({ status: 200, contentType: "application/json", json: body });
	});
	try {
		await page.goto(`/#/stocks/${NEWS_PAGED_STOCK.stockId}/news`);
		const news = panel("News");
		const list = news.getByRole("list", { name: /^Stored articles that mention / });
		await expect(list.getByRole("listitem")).toHaveCount(20, { timeout: 30_000 });
		await news.getByRole("button", { name: "Show more" }).click();
		await expect(list.getByRole("listitem")).toHaveCount(25);
		await expect(news.locator('[data-field="stock-news-status"]')).toHaveText(
			"5 more articles loaded; 25 shown.",
		);
		await expect(news.getByRole("button", { name: "Show more" })).toHaveCount(0);
		expect(served).toEqual(["first", NEWS_SECOND_CURSOR]);
	} finally {
		await page.unroute(newsPath);
	}
});

test("no console errors", async () => {
	expect(consoleErrors).toEqual([]);
});
