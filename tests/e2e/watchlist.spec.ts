import { expect, type Locator, type Page, test } from "@playwright/test";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * Watchlist and earnings-date calendar end to end (FR-018): registering a US
 * and a JP stock, an earnings-date refresh through the REAL runner loop with
 * the fixture Finnhub/JPX sources (`tests/e2e/earningsFixtures.ts` — canned
 * dates, never live data), the Home earnings-calendar widget, the .ics
 * download, and the secret-token subscription feed (fetch without cookies,
 * rotation, revocation). CSP stays clean.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
const consoleErrors: string[] = [];
/**
 * Fixture announcement dates read back from the Watchlist page (see
 * `earningsFixtures.ts`: the fixtures answer offsets from the refresh day,
 * so the suite derives every later expectation from what is displayed).
 */
let appleDate = "";
let toyotaDate = "";

/** The first `<time>` in a watchlist row is the next announcement date. */
async function rowDate(row: Locator): Promise<string> {
	const text = ((await row.locator("time").first().textContent()) ?? "").trim();
	expect(text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	return text;
}

function nextDay(isoDate: string): string {
	return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterAll(async () => {
	await page.close();
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

/** Registers the stock unless its row is already there (shared database). */
async function ensureStock(market: "US" | "JP", symbol: string, stockId: string): Promise<void> {
	await page.goto("/#/watchlist");
	await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible();
	const row = page.locator(`tr[data-stock-id="${stockId}"]`);
	if ((await row.count()) > 0) return;
	await page.getByLabel("Market").selectOption(market);
	await page.getByLabel("Symbol").fill(symbol);
	await page.getByRole("button", { name: "Add stock" }).click();
	await expect(row).toBeVisible({ timeout: 30_000 });
}

test("Watchlist is its own page behind its own navigation item", async () => {
	await page.goto("/#/watchlist");
	await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible();
	const nav = page.getByRole("navigation", { name: "Views" });
	await expect(nav.getByRole("link", { name: "Watchlist" })).toHaveAttribute(
		"aria-current",
		"page",
	);
});

test("adding a US and a JP stock fetches the fixture earnings dates with no manual refresh", async () => {
	test.setTimeout(180_000);
	await ensureStock("US", "AAPL", "us:AAPL");
	await ensureStock("JP", "7203", "jp:7203");

	await page.goto("/#/watchlist");
	const status = page.locator('[data-field="watchlist-status"]');
	await expect(status).toBeVisible({ timeout: 30_000 });
	// No click on "Refresh earnings dates": each add queued the refresh
	// itself (the second add while the first run is active arms exactly one
	// follow-up when needed).
	await expect(status).toContainText("Last successful refresh:", { timeout: 120_000 });

	// Finnhub fixture: Apple Q4 2026 after close, on the fixture's upcoming date.
	const apple = page.locator('tr[data-stock-id="us:AAPL"]');
	appleDate = await rowDate(apple);
	expect(appleDate >= new Date().toISOString().slice(0, 10)).toBe(true);
	const appleCompact = appleDate.replaceAll("-", "");
	const appleNextCompact = nextDay(appleDate).replaceAll("-", "");
	await expect(apple).toContainText("Apple Inc");
	await expect(apple).toContainText(appleDate);
	await expect(apple).toContainText("Q4 2026");
	await expect(apple).toContainText("after market close");
	await expect(apple.getByRole("link", { name: "Finnhub" })).toHaveAttribute(
		"href",
		"https://finnhub.io/",
	);
	await expect(apple.getByRole("link", { name: "Add to Google Calendar" }).first()).toHaveAttribute(
		"href",
		new RegExp(`calendar\\.google\\.com.*dates=${appleCompact}/${appleNextCompact}`),
	);
	await expect(apple.getByRole("link", { name: "Add to Outlook" }).first()).toHaveAttribute(
		"href",
		new RegExp(`outlook\\.live\\.com.*startdt=${appleDate}`),
	);

	// JPX fixture: Toyota second quarter, timing unknown.
	const toyota = page.locator('tr[data-stock-id="jp:7203"]');
	toyotaDate = await rowDate(toyota);
	expect(toyotaDate >= new Date().toISOString().slice(0, 10)).toBe(true);
	await expect(toyota).toContainText("Toyota Motor Corp.");
	await expect(toyota).toContainText(toyotaDate);
	await expect(toyota).toContainText("Second quarter");
});

test("the Home earnings-calendar widget shows the dates after it is added", async () => {
	test.setTimeout(180_000);
	const title = `E2E earnings ${Date.now()}`;
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible({ timeout: 30_000 });

	await page.getByRole("button", { name: "Add widget" }).click();
	const dialog = page.locator("sl-dialog", { hasText: "Add widget" });
	await expect(dialog).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(title);
	await setSlValue('sl-dialog sl-select[label="Widget type"]', "earnings-calendar");
	await setSlValue('sl-dialog sl-select[label="Days ahead"]', "180");
	await dialog.getByRole("button", { name: "Add widget" }).click();

	const added = page.getByRole("article", {
		name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	await expect(added).toContainText(appleDate, { timeout: 30_000 });
	await expect(added).toContainText(toyotaDate);
	await expect(added).toContainText("Apple Inc");
	await expect(added.getByRole("link", { name: "Manage watchlist" })).toHaveAttribute(
		"href",
		"#/watchlist",
	);
	await expect(added).toContainText("Finnhub");

	// The widget's own Refresh button queues a run (the one manual-button step).
	await added.getByRole("button", { name: "Refresh earnings dates" }).click();
	await expect(added).toContainText("Fetching earnings dates", { timeout: 30_000 });

	// The widget is removed so later runs start clean.
	await added.getByRole("button", { name: `${title} actions` }).click();
	await page.getByRole("menuitem", { name: "Remove widget" }).click();
	await expect(added).toHaveCount(0);
});

test("the calendar file downloads with deterministic earnings content", async () => {
	test.setTimeout(120_000);
	await page.goto("/#/watchlist");
	await expect(page.locator('tr[data-stock-id="us:AAPL"]')).toBeVisible({ timeout: 30_000 });

	const response = await page.request.get("/api/v1/watchlist/calendar.ics");
	expect(response.ok()).toBe(true);
	expect(response.headers()["content-type"]).toContain("text/calendar");
	expect(response.headers()["content-disposition"]).toContain("earnings-calendar.ics");
	const body = await response.text();
	expect(body).toContain("BEGIN:VCALENDAR");
	expect(body).toContain("UID:earnings-us-AAPL-2026-q4@research-workspace");
	expect(body).toContain(`DTSTART;VALUE=DATE:${appleDate.replaceAll("-", "")}`);
	expect(body).toContain("UID:earnings-jp-7203-fy2027-03-31-second-quarter@research-workspace");
	expect(body).toContain(`DTSTART;VALUE=DATE:${toyotaDate.replaceAll("-", "")}`);

	const download = page.waitForEvent("download", { timeout: 30_000 });
	await page.getByRole("button", { name: "Download calendar file (.ics)" }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe("earnings-calendar.ics");
});

test("the subscription link serves the calendar without cookies until revoked", async () => {
	test.setTimeout(120_000);
	await page.goto("/#/watchlist");
	await expect(page.locator('tr[data-stock-id="us:AAPL"]')).toBeVisible({ timeout: 30_000 });

	// Create (or rotate: a link may already exist from an earlier run).
	const existing = page.getByRole("button", { name: "Replace link" });
	if ((await existing.count()) > 0) {
		await existing.first().click();
		const rotateDialog = page.getByRole("dialog");
		await expect(rotateDialog).toContainText("The old link stops working");
		await rotateDialog.getByRole("button", { name: "Replace link" }).click();
	} else {
		await page.getByRole("button", { name: "Create subscription link" }).click();
	}
	const field = page.getByLabel("Subscription link (shown once)");
	await expect(field).toBeVisible({ timeout: 30_000 });
	const url = await field.inputValue();
	expect(url).toMatch(/^http.*\/api\/v1\/calendar-feed\/[A-Za-z0-9_-]{40,200}\/earnings\.ics$/);
	const path = new URL(url).pathname;

	// Calendar apps send no cookies: plain Node fetch carries none.
	const served = await fetch(`${E2E_ORIGIN}${path}`);
	expect(served.status).toBe(200);
	expect(served.headers.get("content-type")).toContain("text/calendar");
	expect(served.headers.get("cache-control")).toContain("max-age=900");
	const servedBody = await served.text();
	expect(servedBody).toContain("UID:earnings-us-AAPL-2026-q4@research-workspace");

	// Rotation: replacing the link kills the old one and serves the new one.
	await page.getByRole("button", { name: "Replace link" }).first().click();
	const rotateDialog = page.getByRole("dialog");
	await expect(rotateDialog).toContainText("The old link stops working");
	await rotateDialog.getByRole("button", { name: "Replace link" }).click();
	const rotatedField = page.getByLabel("Subscription link (shown once)");
	// The field keeps showing the old URL until the re-issue response is
	// processed — poll for the value change itself, not just visibility.
	await expect.poll(() => rotatedField.inputValue(), { timeout: 30_000 }).not.toBe(url);
	const rotatedPath = new URL(await rotatedField.inputValue()).pathname;
	expect(rotatedPath).not.toBe(path);
	expect((await fetch(`${E2E_ORIGIN}${path}`)).status).toBe(404);
	expect((await fetch(`${E2E_ORIGIN}${rotatedPath}`)).status).toBe(200);

	// Revocation: the link answers the uniform 404 afterwards.
	await page.getByRole("button", { name: "Revoke link" }).first().click();
	const revokeDialog = page.getByRole("dialog");
	await expect(revokeDialog).toContainText("Revoke the subscription link?");
	await revokeDialog.getByRole("button", { name: "Revoke link" }).click();
	await expect(page.getByText("The subscription link was revoked.")).toBeVisible({
		timeout: 30_000,
	});
	const revoked = await fetch(`${E2E_ORIGIN}${rotatedPath}`);
	expect(revoked.status).toBe(404);
	expect(await revoked.json()).toEqual({
		error: { code: "NOT_FOUND", message: "Resource not found." },
	});
});

test("an unknown feed token answers the same uniform 404", async () => {
	const missing = await fetch(`${E2E_ORIGIN}/api/v1/calendar-feed/${"z".repeat(43)}/earnings.ics`);
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({
		error: { code: "NOT_FOUND", message: "Resource not found." },
	});
	const malformed = await fetch(`${E2E_ORIGIN}/api/v1/calendar-feed/not-a-token/earnings.ics`);
	expect(malformed.status).toBe(404);
	expect(await malformed.json()).toEqual({
		error: { code: "NOT_FOUND", message: "Resource not found." },
	});
});

test("the Watchlist page ran under its Content-Security-Policy without errors", async () => {
	const response = await page.request.get("/");
	const policy = response.headers()["content-security-policy"] ?? "";
	expect(policy).toContain("script-src 'self'");
	expect(policy).toContain("style-src 'self'");
	expect(policy).toContain("connect-src 'self'");

	await page.goto("/#/watchlist");
	await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible();
	await page.goto("/#/home");
	await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
