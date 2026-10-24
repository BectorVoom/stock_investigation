import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DIRECTORY_FIXTURE_AS_OF, directoryFixtureRow } from "./directoryFixtures.ts";
import { E2E_ORIGIN } from "./fixtures.ts";
import { googleUnconfiguredFlagFile } from "./googleFlag.ts";

/**
 * Watchlist and earnings-date calendar end to end (FR-018/FR-019): registering
 * a US and a JP stock, an earnings-date refresh through the REAL runner loop
 * with the fixture Finnhub/JPX sources (`tests/e2e/earningsFixtures.ts` —
 * canned dates, never live data), the Home earnings-calendar widget (month
 * grid, day links to the Watchlist page, month navigation) and, in Settings →
 * Calendar (ADR-0022), the Google Calendar card (scripted connect →
 * automatic sync → disconnect, plus the not-configured failure sentence),
 * the .ics download, and the secret-token subscription feed (fetch without
 * cookies, rotation, revocation). The Watchlist page itself has no calendar.
 * The stock lists (ADR-0034) download through the same runner from the
 * fixture lists (`tests/e2e/directoryFixtures.ts`), and the add-a-stock
 * search finds, picks and adds a stock from them. CSP stays clean.
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

/** Opens Settings → Calendar and waits for its watchlist-backed state. */
async function openCalendarSettings(): Promise<Locator> {
	await page.goto("/#/settings/calendar");
	const section = page.getByRole("region", { name: "Calendar" });
	await expect(section.getByText("Google Calendar", { exact: true })).toBeVisible({
		timeout: 30_000,
	});
	return section;
}

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

/** Opens the add form's "Enter a symbol instead" disclosure unless it is open. */
async function openManualEntry(): Promise<void> {
	const symbol = page.getByLabel("Symbol");
	if (await symbol.isVisible()) return;
	await page.getByText("Enter a symbol instead", { exact: true }).click();
	await expect(symbol).toBeVisible();
}

/** Registers the stock by its symbol unless its row is already there (shared database). */
async function ensureStock(market: "US" | "JP", symbol: string, stockId: string): Promise<void> {
	await page.goto("/#/watchlist");
	await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible();
	const row = page.locator(`tr[data-stock-id="${stockId}"]`);
	if ((await row.count()) > 0) return;
	await openManualEntry();
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

test("the stock lists download on the first visit and the search adds a stock", async () => {
	test.setTimeout(180_000);
	await page.goto("/#/watchlist");
	await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible();
	// Opening the page queued the missing lists itself; the runner stores the fixture lists.
	const lists = page.locator('[data-field="directory-status"]');
	await expect(lists.locator('p[data-market="US"]')).toContainText(
		/^US list: [\d,]+ stocks, retrieved /,
		{
			timeout: 120_000,
		},
	);
	await expect(lists.locator('p[data-market="JP"]')).toContainText(
		`stocks, as of ${DIRECTORY_FIXTURE_AS_OF.JP ?? ""}.`,
		{ timeout: 120_000 },
	);

	const toyota = directoryFixtureRow("JP", "7203");
	const box = page.getByRole("combobox", { name: "Search stocks" });
	const listbox = page.getByRole("listbox", { name: "Matching stocks" });
	const selected = page.locator('[data-field="selected-stock"]');
	const row = page.locator('tr[data-stock-id="jp:7203"]');
	// The database is shared between runs: add 7203 only when it is not there yet.
	if ((await row.count()) === 0) {
		await box.fill("toyota");
		const option = listbox.locator('[data-stock-id="jp:7203"]');
		await expect(option).toBeVisible({ timeout: 30_000 });
		await expect(option).toContainText(toyota.name);
		await expect(option).toContainText("Japan · Prime");
		await expect(listbox.locator('[data-stock-id="us:TM"]')).toBeVisible();
		await option.click();
		await expect(listbox).toBeHidden();
		await expect(selected).toHaveText(`Selected: 7203 ${toyota.name} (Japan)`);
		await page.getByRole("button", { name: "Add stock" }).click();
		await expect(row).toBeVisible({ timeout: 30_000 });
		await expect(box).toHaveValue("");
		await expect(selected).toHaveText("");
	}

	// Hiragana finds the Japanese name; a registered stock says so and cannot be picked.
	await box.fill("とよた");
	const again = listbox.locator('[data-stock-id="jp:7203"]');
	await expect(again).toBeVisible({ timeout: 30_000 });
	await expect(again).toContainText(toyota.localName ?? "");
	await expect(again).toContainText("Added");
	await expect(again).toHaveAttribute("aria-disabled", "true");
	// Playwright never clicks an aria-disabled element on its own; force the
	// click to prove that picking a registered stock selects nothing.
	await again.click({ force: true });
	await expect(selected).toHaveText("");
	// Keyboard: ↓ makes the hit active, Escape closes the list, then clears the text.
	await box.press("ArrowDown");
	await expect(box).toHaveAttribute(
		"aria-activedescendant",
		(await again.getAttribute("id")) ?? "",
	);
	await box.press("Escape");
	await expect(listbox).toBeHidden();
	await box.press("Escape");
	await expect(box).toHaveValue("");
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

test("the Home earnings-calendar widget shows a month grid whose days open the Watchlist", async () => {
	test.setTimeout(180_000);
	const title = `E2E earnings ${Date.now()}`;
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible({ timeout: 30_000 });

	await page.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Earnings calendar", exact: true }).click();
	const dialog = page.locator("sl-dialog");
	await expect(dialog).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(title);
	await setSlValue('sl-dialog sl-select[label="Days ahead"]', "180");
	await dialog.getByRole("button", { name: "Add widget" }).click();

	const added = page.getByRole("article", {
		name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	// The grid links each announcement day to the Watchlist page…
	const appleDay = added.getByRole("link", { name: /announcements?, (.*, )?AAPL/ });
	await expect(appleDay).toBeVisible({ timeout: 30_000 });
	await expect(appleDay).toHaveAttribute("href", "#/watchlist");
	const toyotaDay = added.getByRole("link", { name: /announcements?, (.*, )?7203/ });
	// …navigating forward when the date falls in a later month…
	for (let step = 0; step < 3 && (await toyotaDay.count()) === 0; step += 1) {
		await added.getByRole("button", { name: "Next month" }).click();
	}
	await expect(toyotaDay).toBeVisible({ timeout: 10_000 });
	// …and back to the opening month for the rest of the test.
	for (let step = 0; step < 3 && (await appleDay.count()) === 0; step += 1) {
		await added.getByRole("button", { name: "Previous month" }).click();
	}
	await expect(appleDay).toBeVisible({ timeout: 10_000 });
	// …the Next list names the same dates with no per-row calendar links…
	await expect(added).toContainText(appleDate);
	await expect(added).toContainText(toyotaDate);
	await expect(added).toContainText("Apple Inc");
	expect(await added.getByRole("link", { name: "Add to Google Calendar" }).count()).toBe(0);
	expect(await added.getByRole("link", { name: "Add to Outlook" }).count()).toBe(0);
	// …and the widget keeps one provenance line plus its two actions.
	await expect(added).toContainText("Finnhub");
	await expect(added.getByRole("link", { name: "Open Watchlist" })).toHaveAttribute(
		"href",
		"#/watchlist",
	);

	// Month navigation is local: the caption moves and returns.
	const grid = added.getByRole("table");
	const caption = grid.locator("caption");
	const first = await caption.textContent();
	await added.getByRole("button", { name: "Next month" }).click();
	await expect.poll(() => caption.textContent(), { timeout: 10_000 }).not.toBe(first);
	await added.getByRole("button", { name: "Previous month" }).click();
	await expect.poll(() => caption.textContent(), { timeout: 10_000 }).toBe(first);

	// A day link opens the Watchlist page, whose table carries the date with
	// its calendar links; the page has no calendar of its own (ADR-0022).
	await appleDay.click();
	await expect(page).toHaveURL(/#\/watchlist$/);
	const appleCompact = appleDate.replaceAll("-", "");
	const appleNextCompact = nextDay(appleDate).replaceAll("-", "");
	const appleRow = page.locator('tr[data-stock-id="us:AAPL"]');
	await expect(appleRow).toContainText(appleDate, { timeout: 30_000 });
	await expect(
		appleRow.getByRole("link", { name: "Add to Google Calendar" }).first(),
	).toHaveAttribute(
		"href",
		new RegExp(`calendar\\.google\\.com.*dates=${appleCompact}/${appleNextCompact}`),
	);
	await expect(page.getByRole("region", { name: "Calendar" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toHaveCount(0);

	// Back on Home: the widget's own Refresh button queues a run (the one manual-button step).
	await page.goto("/#/home");
	const again = page.getByRole("article", {
		name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	await again.getByRole("button", { name: "Refresh earnings dates" }).click();
	await expect(again).toContainText("Fetching earnings dates", { timeout: 30_000 });

	// The widget is removed so later runs start clean.
	await again.getByRole("button", { name: `${title} actions` }).click();
	await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
	await expect(again).toHaveCount(0);
});

test("the calendar file downloads with deterministic earnings content", async () => {
	test.setTimeout(120_000);
	await openCalendarSettings();

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
	await openCalendarSettings();

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

test("Google Calendar connects, syncs automatically, then disconnects", async () => {
	test.setTimeout(240_000);
	await openCalendarSettings();

	await page.getByRole("button", { name: "Connect Google Calendar" }).click();
	await expect(page.getByText(/Preparing Google sign-in…/)).toBeVisible({ timeout: 30_000 });
	const signIn = page.getByRole("link", { name: "Open Google sign-in" });
	await expect(signIn).toBeVisible({ timeout: 30_000 });
	await expect(signIn).toHaveAttribute(
		"href",
		/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/,
	);
	await expect(page.getByText(/Connected since/)).toBeVisible({ timeout: 60_000 });
	// No click: the automatic sync queues itself once the connection lands.
	await expect(page.getByText(/Last synced/)).toBeVisible({ timeout: 120_000 });
	await expect(page.getByText("2 added, 0 changed, 0 removed.")).toBeVisible();

	await page.getByRole("button", { name: "Disconnect" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("The calendar stays in your Google account");
	await dialog.getByRole("button", { name: "Disconnect" }).click();
	await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible({
		timeout: 60_000,
	});
});

test("a Google connect without credentials ends in the fixed not-configured sentence", async () => {
	test.setTimeout(120_000);
	const flagFile = googleUnconfiguredFlagFile();
	mkdirSync(dirname(flagFile), { recursive: true });
	writeFileSync(flagFile, "unconfigured\n");
	try {
		await openCalendarSettings();
		await page.getByRole("button", { name: "Connect Google Calendar" }).click();
		await expect(
			page.getByText(
				"Google Calendar is not configured; set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in apps/runner/.env.",
			),
		).toBeVisible({ timeout: 60_000 });
	} finally {
		rmSync(flagFile, { force: true });
	}
});

test("the Watchlist page and Settings → Calendar ran under the Content-Security-Policy without errors", async () => {
	const response = await page.request.get("/");
	const policy = response.headers()["content-security-policy"] ?? "";
	expect(policy).toContain("script-src 'self'");
	expect(policy).toContain("style-src 'self'");
	expect(policy).toContain("connect-src 'self'");

	await page.goto("/#/watchlist");
	await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible();
	await openCalendarSettings();
	await page.goto("/#/home");
	await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
