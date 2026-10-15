import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { baseChildEnv } from "../../scripts/testEnv.ts";
import { E2E_ORIGIN, E2E_PORT } from "./fixtures.ts";

/**
 * Notebook market widgets end to end (ADR-0021, task W3): every widget type
 * available on Home renders in the Notebook through the shared Home code
 * and its live fixture data.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) with its own runner harness so
 * its chats, market refreshes and earnings dates never disturb the other
 * specs whatever the file order. Market numbers come from the same recorded
 * provider responses the Home suite uses (`marketFixtures.ts` — fixtures,
 * never live data); earnings dates from the canned Finnhub answers
 * (`earningsFixtures.ts`).
 *
 * Contract coverage: new chat → Focus Notebook → Add widget → Line chart
 * through Home's form → the Home chart (its own svg, data-table twin and
 * computed layout) → range change persists → reload keeps it → an earnings
 * calendar shows the fixture announcement.
 */

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const consoleErrors: string[] = [];
// Isolated owner: this file's chats, refreshes and watchlist are its own,
// whatever the file order. Runner status is owner-scoped, so the spec brings
// its own harness loop reporting as this owner (see `E2E_RUNNER_OWNER`).
const owner = `e2e-notebook-market-${Date.now()}@example.test`;

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

/** Sets a Shoelace control's value the way its `sl-*` listener expects. */
async function setSlValue(selector: string, value: string | readonly string[]): Promise<void> {
	await page.evaluate(
		([sel, val]) => {
			const element = document.querySelector(sel);
			if (!(element instanceof HTMLElement)) throw new Error(`missing ${sel}`);
			Object.assign(element, { value: val });
			element.dispatchEvent(new Event("sl-change", { bubbles: true, composed: true }));
		},
		[selector, value] as [string, string | readonly string[]],
	);
}

/** The Notebook's widgets only: thread previews use the same frame. */
function notebookWidgets() {
	return page.locator('div[data-panel="notebook"] article[data-widget-id]');
}

function notebookRegion() {
	return page.getByRole("region", { name: "Notebook" });
}

/**
 * A screenshot for reading the layout, taken on Chromium only: Playwright's
 * WebKit screenshot injects a <style> the app's CSP refuses, which would be
 * logged as a console error that this spec rightly fails on.
 */
async function reviewShot(name: string): Promise<void> {
	if (page.context().browser()?.browserType().name() !== "chromium") return;
	await page.screenshot({ path: test.info().outputPath(name) });
}

test("a new chat focuses the Notebook with an empty widget list", async () => {
	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	await page.getByRole("button", { name: "Focus Notebook" }).first().click();
	await expect(notebookRegion()).toBeVisible();
	await expect(notebookWidgets()).toHaveCount(0);
});

test("a line chart added through Home's form renders the Home chart with fixture data", async () => {
	test.setTimeout(180_000);
	const title = `E2E notebook gold ${Date.now()}`;
	const notebook = notebookRegion();
	await notebook.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Line chart" }).click();

	// Home's own add form: series picker, range and size.
	const dialog = page.locator("sl-dialog", { hasText: /Add [a-z ]*widget/ });
	await expect(dialog).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(title);
	await setSlValue('sl-dialog sl-select[label="Series"]', "twelve-data:XAU/USD");
	await dialog.getByRole("button", { name: "Add widget" }).click();

	// The widget renders Home's line chart in the Notebook: its own svg
	// with the accessible chart name, the data-table twin and the fixture
	// numbers — a series never refreshed queues one refresh by itself, so
	// the gold close arrives without a further click.
	const added = page.getByRole("article", {
		name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	await expect(added.getByRole("img", { name: new RegExp(`Line chart: ${title}`) })).toBeVisible({
		timeout: 120_000,
	});
	await expect(added.locator("path").first()).toBeVisible();
	// The chart's data-table twin lives inside its disclosure (as on Home):
	// opening it reveals the fixture values in a real table.
	await added.getByText(/Data table:/).click();
	const twin = added.getByRole("table", { name: /Values plotted/ });
	await expect(twin, "the Home chart's data-table twin").toBeAttached({ timeout: 30_000 });
	await expect(twin.getByRole("row", { name: /2026-10-12/ })).toContainText("4,168.44");

	// Computed layout, not just attributes: the article has a real box and
	// the chart svg draws inside it.
	const layout = await added.evaluate((article) => {
		const rect = article.getBoundingClientRect();
		const svg = article.querySelector("svg[role='img']");
		const svgRect = svg?.getBoundingClientRect() ?? null;
		return {
			width: rect.width,
			height: rect.height,
			svgWidth: svgRect?.width ?? 0,
			svgHeight: svgRect?.height ?? 0,
		};
	});
	expect(layout.width).toBeGreaterThan(100);
	expect(layout.height).toBeGreaterThan(100);
	expect(layout.svgWidth).toBeGreaterThan(50);
	expect(layout.svgHeight).toBeGreaterThan(50);

	// The chart's range select saves the notebook widget.
	await setSlValue(
		`article[data-widget-id="${await added.getAttribute("data-widget-id")}"] sl-select[label="Range"]`,
		"3m",
	);
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const sel: unknown = document.querySelector(
						'div[data-panel="notebook"] sl-select[label="Range"]',
					);
					return sel !== null && typeof sel === "object" && "value" in sel
						? String(sel.value)
						: "missing";
				}),
			{ timeout: 30_000 },
		)
		.toBe("3m");
});

test("a reload keeps the notebook market widget with its range", async () => {
	await page.reload();
	await expect(notebookRegion()).toBeVisible();
	const chart = notebookWidgets().first();
	await expect(chart.getByRole("img", { name: /Line chart:/ })).toBeVisible({ timeout: 120_000 });
	await expect(chart).toContainText("4,168.44");
	const rangeValue = await page.evaluate(() => {
		const sel: unknown = document.querySelector(
			'div[data-panel="notebook"] sl-select[label="Range"]',
		);
		return sel !== null && typeof sel === "object" && "value" in sel
			? String(sel.value)
			: "missing";
	});
	expect(rangeValue).toBe("3m");
});

test("an earnings calendar shows the fixture announcement", async () => {
	test.setTimeout(180_000);
	// The calendar reads the Watchlist page's stocks: register one with a
	// canned earnings date (the fixture answers 16 days out).
	await page.goto("/#/watchlist");
	await page.getByLabel("Symbol").fill("AAPL");
	await page.getByRole("button", { name: "Add stock" }).click();
	const stocks = page.getByRole("region", { name: "Registered stocks" });
	await expect(stocks).toContainText("AAPL", { timeout: 60_000 });
	await expect(stocks).toContainText(/202\d-\d\d-\d\d/, { timeout: 120_000 });

	await page.goto("/#/chat");
	await expect(notebookRegion()).toBeVisible();
	const notebook = notebookRegion();
	await notebook.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Earnings calendar" }).click();
	const dialog = page.locator("sl-dialog", { hasText: /Add [a-z ]*widget/ });
	await expect(dialog).toBeAttached();
	const calendarTitle = `E2E earnings ${Date.now()}`;
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(calendarTitle);
	await dialog.getByRole("button", { name: "Add widget" }).click();

	const added = page.getByRole("article", {
		name: new RegExp(calendarTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	// Home's own calendar markup: the Next list names the fixture stock.
	await expect(added.getByText("Next")).toBeVisible({ timeout: 60_000 });
	await expect(added).toContainText("AAPL");
	await expect(added.getByRole("link", { name: "Open Watchlist" })).toBeVisible();

	await reviewShot("notebook-market-widgets.png");
	await expect(notebookWidgets()).toHaveCount(2);
});

test("a reload keeps both market widgets, with no console errors", async () => {
	await page.reload();
	await expect(notebookWidgets()).toHaveCount(2, { timeout: 60_000 });
	await expect(
		notebookWidgets()
			.first()
			.getByRole("img", { name: /Line chart:/ }),
	).toBeVisible({
		timeout: 120_000,
	});
	await expect(notebookWidgets().nth(1)).toContainText("AAPL");
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
	// The suite's addressing never leaks the production database.
	expect(E2E_ORIGIN).not.toContain(":8787");
});
