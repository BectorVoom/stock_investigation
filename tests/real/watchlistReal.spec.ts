import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
 * Watchlist and earnings-date calendar against the real network
 * (`bun run test:real`). No model quota is spent: the earnings-refresh job
 * only calls the JPX schedule (no key needed) and Finnhub (keyed). The
 * suite's own runner env file carries NO key at all — unless
 * `RUN_REAL_FINNHUB=1` is set, in which case the invoking environment's
 * `FINNHUB_API_KEY` is passed through and the US leg is asserted live too.
 *
 * From a pristine copy the test starts the real `bun run dev` on test ports
 * with throwaway directories, adds JP `7203` and US `AAPL` on `/#/watchlist`
 * (each add queues its own earnings-date refresh — no manual click, the
 * first fetch is the automatic one) and waits for the run to complete over the
 * real network (minutes: the runner really downloads the JPX index page and
 * its workbooks). For 7203 it asserts the JPX company name, a retrieved
 * timestamp, the JPX source link, and either an upcoming ISO date with its
 * fiscal-period text or the explicit undecided/unavailable text — whichever
 * JPX publishes that day, never a specific date. For AAPL without a key it
 * asserts the fixed "not configured" reason naming FINNHUB_API_KEY. Then the
 * .ics download (VEVENT count equals the dated-event count), the
 * subscription link (fetched from Node with no cookies, then revoked to a
 * 404), and the "Earnings calendar" widget on Home showing the same 7203
 * row or its stated reason. Full-page screenshots at 1440×900 and 390×844
 * land under `test-results-real/`, and no file under the launcher's log
 * directory may contain the feed token.
 *
 * JPX asks for low-frequency access: this spec performs exactly one refresh,
 * and must not be re-run casually.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8904;
const API_PORT = 8905;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;

interface WatchlistApiEvent {
	readonly announcementDate: string | null;
	readonly fiscalPeriodLabel: string;
}

interface WatchlistApiStock {
	readonly stockId: string;
	readonly symbol: string;
	readonly name: string | null;
	readonly publisher: string;
	readonly sourceUrl: string;
	readonly retrievedAt: string | null;
	readonly unavailable: { readonly code: string; readonly reason: string } | null;
	readonly events: readonly WatchlistApiEvent[];
}

interface WatchlistApiResponse {
	readonly stocks: readonly WatchlistApiStock[];
	readonly refresh: {
		readonly activeRunId: string | null;
		readonly lastSucceededAt: string | null;
	};
}

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-watchlist-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-watchlist-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	// JPX needs no key: the env file carries nothing, unless the orchestrator
	// explicitly opts into the live Finnhub leg (RUN_REAL_FINNHUB=1), in which
	// case the invoking environment's key is passed through.
	const finnhubKey = process.env.FINNHUB_API_KEY ?? "";
	const passFinnhub = process.env.RUN_REAL_FINNHUB === "1" && finnhubKey !== "";
	runnerEnvFile = writeTestRunnerEnvFile(
		extraRoot,
		passFinnhub ? { FINNHUB_API_KEY: finnhubKey } : {},
	);
});

test.afterAll(() => resources.close());

function watchlistEnv(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18984",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
	const headers: Record<string, string> = { ...ownerHeaders(API_ORIGIN) };
	if (key !== undefined) headers["Idempotency-Key"] = key;
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	}
	return (text === "" ? null : JSON.parse(text)) as T;
}

/** Registers the stock through the Watchlist form unless its row is already there. */
async function ensureStock(page: Page, market: "US" | "JP", symbol: string): Promise<void> {
	await page.goto(`${VITE_ORIGIN}/#/watchlist`);
	await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible({
		timeout: 60_000,
	});
	const row = page.locator(`tr[data-stock-id="${market.toLowerCase()}:${symbol}"]`);
	if ((await row.count()) > 0) return;
	await page.getByLabel("Market").selectOption(market);
	await page.getByLabel("Symbol").fill(symbol);
	await page.getByRole("button", { name: "Add stock" }).click();
	await expect(row).toBeVisible({ timeout: 60_000 });
}

/** Sets a Shoelace control's value the way its `sl-*` listener expects. */
async function setSlValue(page: Page, selector: string, value: string): Promise<void> {
	await page.evaluate(
		([sel, val]) => {
			const element = document.querySelector(sel);
			if (!(element instanceof HTMLElement)) throw new Error(`missing ${sel}`);
			Object.assign(element, { value: val });
			element.dispatchEvent(new Event("sl-change", { bubbles: true, composed: true }));
		},
		[selector, value] as [string, string],
	);
}

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFilesRecursive(full));
		else if (statSync(full).isFile()) out.push(full);
	}
	return out;
}

test("a real earnings-date refresh shows the JPX date and the Finnhub key notice", async ({
	page,
}) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const finnhubExercised =
		process.env.RUN_REAL_FINNHUB === "1" && (process.env.FINNHUB_API_KEY ?? "") !== "";
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: watchlistEnv() });
	resources.add(async () => {
		await service.stop();
	});
	try {
		const session = await api<{ environment: string }>("GET", "/api/v1/session");
		expect(session.environment).toBe("development");

		await ensureStock(page, "JP", "7203");
		await ensureStock(page, "US", "AAPL");

		await page.goto(`${VITE_ORIGIN}/#/watchlist`);
		const status = page.locator('[data-field="watchlist-status"]');
		await expect(status).toBeVisible({ timeout: 60_000 });
		// No manual click: the adds above queued the refresh themselves, so
		// the first fetch is the automatic one.
		// The automatic queue posted the job; the run id appears on the watchlist response.
		let activeRunId: string | null = null;
		const queueDeadline = Date.now() + 120_000;
		for (;;) {
			const current = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
			activeRunId = current.refresh.activeRunId;
			if (activeRunId !== null) break;
			if (current.refresh.lastSucceededAt !== null) break;
			if (Date.now() > queueDeadline) throw new Error("the earnings refresh was never queued");
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		if (activeRunId !== null) {
			let state = "";
			const deadline = Date.now() + 600_000;
			for (;;) {
				const run = await api<{ run: { state: string } }>(
					"GET",
					`/api/v1/research-runs/${activeRunId}`,
				);
				state = run.run.state;
				if (state === "completed" || state === "failed" || state === "cancelled") break;
				if (Date.now() > deadline)
					throw new Error(`earnings refresh ${activeRunId} did not finish`);
				await new Promise((resolve) => setTimeout(resolve, 5_000));
			}
			expect(state).toBe("completed");
		}

		const watchlist = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
		const toyota = watchlist.stocks.find((entry) => entry.stockId === "jp:7203");
		if (toyota === undefined) throw new Error("jp:7203 is missing from /api/v1/watchlist");
		const apple = watchlist.stocks.find((entry) => entry.stockId === "us:AAPL");
		if (apple === undefined) throw new Error("us:AAPL is missing from /api/v1/watchlist");

		// The refreshed DOM: reload so every assertion below reads the completed state.
		await page.goto(`${VITE_ORIGIN}/#/watchlist`);
		await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible({
			timeout: 60_000,
		});
		await expect(status).toContainText("Last successful refresh:", { timeout: 120_000 });

		// JPX leg (no key): the company name JPX publishes, a retrieved
		// timestamp, the JPX source link, and either an upcoming ISO date
		// with its fiscal-period text or the explicit undecided/unavailable
		// text — whichever JPX publishes that day.
		const toyotaRow = page.locator('tr[data-stock-id="jp:7203"]');
		await expect(toyotaRow).toBeVisible({ timeout: 60_000 });
		const companyName = toyota.name;
		expect(companyName !== null && companyName.trim() !== "").toBe(true);
		if (companyName === null) throw new Error("JPX returned no company name for 7203");
		await expect(toyotaRow).toContainText(companyName);
		const retrievedAt = toyota.retrievedAt;
		expect(retrievedAt).not.toBeNull();
		if (retrievedAt === null) throw new Error("7203 has no retrieved timestamp after the refresh");
		await expect(toyotaRow.locator(`time[dateTime="${retrievedAt}"]`)).toBeVisible();
		expect(toyota.sourceUrl).toContain("jpx.co.jp");
		await expect(
			toyotaRow.getByRole("link", { name: "Japan Exchange Group (JPX)" }),
		).toHaveAttribute("href", toyota.sourceUrl);
		const today = new Date().toISOString().slice(0, 10);
		const upcoming = toyota.events.filter(
			(event) => event.announcementDate !== null && event.announcementDate >= today,
		);
		const next = upcoming[0];
		if (next !== undefined && next.announcementDate !== null) {
			expect(next.announcementDate >= today).toBe(true);
			await expect(toyotaRow).toContainText(next.announcementDate);
			await expect(toyotaRow).toContainText(next.fiscalPeriodLabel);
		} else {
			const rowText = (await toyotaRow.textContent()) ?? "";
			expect(rowText.includes("date undecided") || rowText.includes("unavailable (")).toBe(true);
		}

		// US leg: without a key the fixed "not configured" reason naming
		// FINNHUB_API_KEY; with RUN_REAL_FINNHUB=1 the Finnhub name and either
		// a dated event or the NO_SCHEDULED_DATE reason.
		const appleRow = page.locator('tr[data-stock-id="us:AAPL"]');
		await expect(appleRow).toBeVisible({ timeout: 60_000 });
		if (finnhubExercised) {
			const appleName = apple.name;
			expect(appleName !== null && appleName.trim() !== "").toBe(true);
			if (appleName === null) throw new Error("Finnhub returned no company name for AAPL");
			await expect(appleRow).toContainText(appleName);
			const appleUpcoming = apple.events.filter(
				(event) => event.announcementDate !== null && event.announcementDate >= today,
			);
			const appleNext = appleUpcoming[0];
			if (appleNext !== undefined && appleNext.announcementDate !== null) {
				await expect(appleRow).toContainText(appleNext.announcementDate);
			} else {
				expect(apple.unavailable?.code).toBe("NO_SCHEDULED_DATE");
				if (apple.unavailable === null) throw new Error("AAPL has neither a date nor a reason");
				await expect(appleRow).toContainText(apple.unavailable.reason);
			}
		} else {
			expect(apple.unavailable?.code).toBe("SOURCE_NOT_CONFIGURED");
			await expect(appleRow).toContainText("FINNHUB_API_KEY");
			test.info().annotations.push({
				type: "FINNHUB",
				description: "not exercised: RUN_REAL_FINNHUB=1 with FINNHUB_API_KEY was not set",
			});
		}

		const shotsDir = join(REPO_ROOT, "test-results-real");
		mkdirSync(shotsDir, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, "watchlist-real-1440x900.png"), fullPage: true });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, "watchlist-real-390x844.png"), fullPage: true });

		// The .ics download: a VCALENDAR whose VEVENT count equals the number
		// of dated events, holding every displayed date.
		const ics = await page.request.get(`${VITE_ORIGIN}/api/v1/watchlist/calendar.ics`);
		expect(ics.ok()).toBe(true);
		expect(ics.headers()["content-type"]).toContain("text/calendar");
		const icsBody = await ics.text();
		expect(icsBody).toContain("BEGIN:VCALENDAR");
		expect(icsBody).toContain("END:VCALENDAR");
		let datedTotal = 0;
		for (const stock of watchlist.stocks) {
			for (const event of stock.events) {
				if (event.announcementDate !== null) datedTotal += 1;
			}
		}
		expect(icsBody.split("BEGIN:VEVENT").length - 1).toBe(datedTotal);
		for (const stock of watchlist.stocks) {
			for (const event of stock.events) {
				if (event.announcementDate !== null && event.announcementDate >= today) {
					expect(icsBody).toContain(
						`DTSTART;VALUE=DATE:${event.announcementDate.replaceAll("-", "")}`,
					);
				}
			}
		}
		const download = page.waitForEvent("download", { timeout: 30_000 });
		await page.getByRole("button", { name: "Download calendar file (.ics)" }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe("earnings-calendar.ics");

		// The subscription link: created once, fetched from Node with no
		// cookies (calendar apps send none) returning the same calendar,
		// then revoked to the uniform 404.
		await page.getByRole("button", { name: "Create subscription link" }).click();
		const field = page.getByLabel("Subscription link (shown once)");
		await expect(field).toBeVisible({ timeout: 30_000 });
		const feedUrl = await field.inputValue();
		expect(feedUrl).toMatch(
			/^http.*\/api\/v1\/calendar-feed\/[A-Za-z0-9_-]{40,200}\/earnings\.ics$/,
		);
		const segments = new URL(feedUrl).pathname.split("/");
		const token = segments[4];
		if (token === undefined || token === "") throw new Error("the feed URL carries no token");
		const served = await fetch(feedUrl);
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toContain("text/calendar");
		expect(await served.text()).toBe(icsBody);
		await page.getByRole("button", { name: "Revoke link" }).first().click();
		const revokeDialog = page.getByRole("dialog");
		await expect(revokeDialog).toContainText("Revoke the subscription link?");
		await revokeDialog.getByRole("button", { name: "Revoke link" }).click();
		await expect(page.getByText("The subscription link was revoked.")).toBeVisible({
			timeout: 30_000,
		});
		const revoked = await fetch(feedUrl);
		expect(revoked.status).toBe(404);

		// The Home earnings-calendar widget shows the same 7203 row or its
		// stated reason.
		await page.goto(`${VITE_ORIGIN}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});
		await page.getByRole("button", { name: "Add widget" }).click();
		const dialog = page.locator("sl-dialog", { hasText: "Add widget" });
		await expect(dialog).toBeAttached();
		await page.locator('sl-dialog sl-input[label="Title"] input').fill("Earnings calendar");
		await setSlValue(page, 'sl-dialog sl-select[label="Widget type"]', "earnings-calendar");
		await setSlValue(page, 'sl-dialog sl-select[label="Days ahead"]', "180");
		await dialog.locator("sl-button", { hasText: "Add widget" }).click();
		const added = page.getByRole("article", { name: /Earnings calendar/ });
		await expect(added).toContainText("7203", { timeout: 120_000 });
		if (next !== undefined && next.announcementDate !== null) {
			const horizon = new Date(Date.parse(`${today}T00:00:00.000Z`) + 180 * 86_400_000)
				.toISOString()
				.slice(0, 10);
			if (next.announcementDate <= horizon) {
				await expect(added).toContainText(next.announcementDate);
			}
		}

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(1_000);
		await page.screenshot({
			path: join(shotsDir, "watchlist-real-home-1440x900.png"),
			fullPage: true,
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(1_000);
		await page.screenshot({
			path: join(shotsDir, "watchlist-real-home-390x844.png"),
			fullPage: true,
		});

		// The feed token travels in a URL path: it must reach no file under
		// the launcher's log directory.
		for (const file of listFilesRecursive(join(dataDir, "logs"))) {
			expect(readFileSync(file, "utf8")).not.toContain(token);
		}
	} finally {
		await service.stop();
	}
});
