import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import { waitForSync } from "../e2e/marketSync.ts";
import { addShownStockToWatchlist } from "../e2e/stocksPage.ts";
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
 * (queued by the API itself at the runner's claims, ADR-0051)
 * only calls the JPX schedule (no key needed) and Finnhub (keyed). The
 * suite's own runner env file carries NO key at all — unless
 * `RUN_REAL_FINNHUB=1` is set, in which case the invoking environment's
 * `FINNHUB_API_KEY` is passed through and the US leg is asserted live too.
 *
 * From a pristine copy the test starts the real `bun run dev` on test ports
 * with throwaway directories. Opening `/#/registered` queues the stock lists
 * (ADR-0034): the runner really downloads JPX's TSE-listed issues
 * workbooks, and the US list states the fixed `SEC_USER_AGENT` sentence
 * (the env file sets none) unless a user agent reaches the runner. The
 * test then finds JP `7203` with the Stocks page's search ("トヨタ") over
 * the stored JPX list, opens it from the hit and adds it with "Add to
 * Watchlist", and adds US `AAPL` the same way from its own page
 * `#/stocks/us:AAPL` (no US list is stored without SEC_USER_AGENT)
 * (no refresh request: each added stock is never refreshed, so the API
 * queues its earnings-date refresh at the runner's next claim) and waits
 * for the run to complete over the
 * real network (minutes: the runner really downloads the JPX index page and
 * its workbooks). For 7203 it asserts the JPX company name, a retrieved
 * timestamp, the JPX source link, and either an upcoming ISO date with its
 * fiscal-period text or the explicit undecided/unavailable text — whichever
 * JPX publishes that day, never a specific date. For AAPL without a key it
 * asserts the fixed "not configured" reason naming FINNHUB_API_KEY. Then the
 * .ics download (VEVENT count equals the dated-event count), the
 * subscription link (fetched from Node with no cookies, then revoked to a
 * 404), and the "Earnings calendar" widget on Home showing the same 7203
 * date (or its stated reason) with its month grid marking the day. Full-page
 * screenshots at 1440×900 and 390×844
 * land under `test-results-real/`, and no file under the launcher's log
 * directory may contain the feed token.
 *
 * JPX asks for low-frequency access: this spec causes one earnings fetch
 * of 7203 (the AAPL add may cause a second, Finnhub-only job) and one
 * stock-list download, and must not be re-run casually.
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
	readonly lastRefreshedAt: string | null;
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

/**
 * Registers the stock unless its row is already there, from the stock's own
 * page: `#/stocks/<stockId>` shows any stock, listed or not, and its "Add
 * to Watchlist" adds it (ADR-0050). The search cannot be used for AAPL here:
 * the US list is not stored without SEC_USER_AGENT.
 */
async function ensureStock(page: Page, market: "US" | "JP", symbol: string): Promise<void> {
	await page.goto(`${VITE_ORIGIN}/#/registered`);
	await expect(page.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible({
		timeout: 60_000,
	});
	const stockId = `${market.toLowerCase()}:${symbol}`;
	// Registered stocks lists only its lists' stocks (ADR-0053): the API says what is watched.
	const watchlist = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
	if (watchlist.stocks.some((entry) => entry.stockId === stockId)) return;
	await page.goto(`${VITE_ORIGIN}/#/stocks/${stockId}`);
	await addShownStockToWatchlist(page, symbol);
	const after = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
	expect(after.stocks.map((entry) => entry.stockId)).toContain(stockId);
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

test("the server-side earnings-date sync shows the JPX date and the Finnhub key notice", async ({
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

		// The stock lists: the server queued them at the runner's first claim (ADR-0053 §2). JPX's list is
		// downloaded for real; the US one needs SEC_USER_AGENT, which the
		// suite's env file does not set, so it states the fixed sentence
		// (or, when a user agent reaches the runner anyway, its count).
		await page.goto(`${VITE_ORIGIN}/#/registered`);
		const lists = page.locator('[data-field="directory-status"]');
		await expect(lists.locator('p[data-market="JP"]')).toContainText(
			/^Japan list: [\d,]+ stocks, (as of \d{4}-\d{2}-\d{2}|retrieved )/,
			{ timeout: 600_000 },
		);
		await expect(lists.locator('p[data-market="US"]')).toContainText(
			/SEC_USER_AGENT|stocks, retrieved/,
			{ timeout: 600_000 },
		);
		// 7203 from the Stocks page's search over the stored JPX list: the
		// hit opens the stock, and "Add to Watchlist" adds it (ADR-0050).
		await page.goto(`${VITE_ORIGIN}/#/stocks`);
		const box = page.getByRole("combobox", { name: "Search stocks" });
		await box.fill("トヨタ");
		const toyotaHit = page
			.getByRole("listbox", { name: "Matching stocks" })
			.locator('[data-stock-id="jp:7203"]');
		await expect(toyotaHit).toBeVisible({ timeout: 30_000 });
		await expect(toyotaHit).toContainText("トヨタ自動車");
		await expect(toyotaHit).toContainText("Japan · Prime");
		await toyotaHit.click();
		await expect(page).toHaveURL(/#\/stocks\/jp:7203$/);
		await addShownStockToWatchlist(page, "7203");
		await ensureStock(page, "US", "AAPL");

		// No refresh request: both stocks were never refreshed, so the API
		// queues their earnings-refresh at the runner's next claims; wait
		// until no run is active and both carry a refresh stamp.
		await waitForSync(
			() => api<WatchlistApiResponse>("GET", "/api/v1/watchlist"),
			(current) =>
				["jp:7203", "us:AAPL"].every(
					(stockId) =>
						(current.stocks.find((entry) => entry.stockId === stockId)?.lastRefreshedAt ?? null) !==
						null,
				),
			"the earnings dates of 7203 and AAPL",
			{ timeoutMs: 720_000, intervalMs: 5_000 },
		);

		const watchlist = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
		const toyota = watchlist.stocks.find((entry) => entry.stockId === "jp:7203");
		if (toyota === undefined) throw new Error("jp:7203 is missing from /api/v1/watchlist");
		const apple = watchlist.stocks.find((entry) => entry.stockId === "us:AAPL");
		if (apple === undefined) throw new Error("us:AAPL is missing from /api/v1/watchlist");

		// Registered stocks shows no earnings dates since ADR-0053 (no
		// Next announcement column, no status line): the API answer is checked.
		await page.goto(`${VITE_ORIGIN}/#/registered`);
		await expect(page.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.getByRole("columnheader", { name: "Next announcement" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /refresh|sync|update stock list/i })).toHaveCount(
			0,
		);

		// JPX leg (no key): the company name JPX publishes, a retrieved
		// timestamp, the JPX source, and either an upcoming ISO date with its
		// fiscal-period text or an undecided date / unavailable reason —
		// whichever JPX publishes that day.
		const companyName = toyota.name;
		expect(companyName !== null && companyName.trim() !== "").toBe(true);
		expect(toyota.retrievedAt).not.toBeNull();
		expect(toyota.sourceUrl).toContain("jpx.co.jp");
		const today = new Date().toISOString().slice(0, 10);
		const upcoming = toyota.events.filter(
			(event) => event.announcementDate !== null && event.announcementDate >= today,
		);
		const next = upcoming[0];
		if (next !== undefined && next.announcementDate !== null) {
			expect(next.fiscalPeriodLabel.trim()).not.toBe("");
		} else {
			expect(
				toyota.events.some((event) => event.announcementDate === null) ||
					toyota.unavailable !== null,
			).toBe(true);
		}

		// US leg: without a key the fixed "not configured" reason naming
		// FINNHUB_API_KEY; with RUN_REAL_FINNHUB=1 the Finnhub name and either
		// a dated event or the NO_SCHEDULED_DATE reason.
		if (finnhubExercised) {
			const appleName = apple.name;
			expect(appleName !== null && appleName.trim() !== "").toBe(true);
			const appleUpcoming = apple.events.filter(
				(event) => event.announcementDate !== null && event.announcementDate >= today,
			);
			if (appleUpcoming[0]?.announcementDate === undefined) {
				expect(apple.unavailable?.code).toBe("NO_SCHEDULED_DATE");
			}
		} else {
			expect(apple.unavailable?.code).toBe("SOURCE_NOT_CONFIGURED");
			expect(apple.unavailable?.reason).toContain("FINNHUB_API_KEY");
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
		// The download, the subscription link and Google Calendar live in
		// Settings → Calendar (ADR-0022); the Watchlist page has no calendar.
		await expect(page.getByRole("region", { name: "Calendar" })).toHaveCount(0);
		await page.goto(`${VITE_ORIGIN}/#/settings/calendar`);
		await expect(
			page.getByRole("region", { name: "Calendar" }).getByText("Google Calendar", { exact: true }),
		).toBeVisible({ timeout: 60_000 });
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

		// No Google credentials in the runner env file: connecting ends in the
		// fixed not-configured sentence (never a guess, never provider text).
		await page.getByRole("button", { name: "Connect Google Calendar" }).click();
		await expect(
			page.getByText(
				"Google Calendar is not configured; set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in apps/runner/.env.",
			),
		).toBeVisible({ timeout: 120_000 });

		// The Home earnings-calendar widget shows the same 7203 date or its
		// stated reason.
		await page.goto(`${VITE_ORIGIN}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});
		await page.getByRole("button", { name: "Add widget" }).click();
		await page.getByRole("menuitem", { name: "Earnings calendar", exact: true }).click();
		const dialog = page.locator("sl-dialog");
		await expect(dialog).toBeAttached();
		await page.locator('sl-dialog sl-input[label="Title"] input').fill("Earnings calendar");
		await setSlValue(page, 'sl-dialog sl-select[label="Days ahead"]', "180");
		await dialog.getByRole("button", { name: "Add widget" }).click();
		const added = page.getByRole("article", { name: /Earnings calendar/ });
		if (next !== undefined && next.announcementDate !== null) {
			const horizon = new Date(Date.parse(`${today}T00:00:00.000Z`) + 180 * 86_400_000)
				.toISOString()
				.slice(0, 10);
			if (next.announcementDate <= horizon) {
				await expect(added).toContainText(next.announcementDate, { timeout: 120_000 });
				await expect(added).toContainText("7203", { timeout: 120_000 });
			}
			// The month grid marks the 7203 date: navigate from the opening
			// month when it is not there yet…
			const dayLink = added.getByRole("link", { name: /announcements?, (.*, )?7203/ });
			for (let step = 0; step < 12 && (await dayLink.count()) === 0; step += 1) {
				await added.getByRole("button", { name: "Next month" }).click();
			}
			await expect(dayLink).toBeVisible({ timeout: 30_000 });
			// …following that day's link lands on the Registered stocks page.
			await dayLink.click();
			await expect(page).toHaveURL(/#\/registered$/);
			await expect(page.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible({
				timeout: 60_000,
			});
			// Back on Home for the screenshots below.
			await page.goto(`${VITE_ORIGIN}/#/home`);
			await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
				timeout: 60_000,
			});
		} else {
			await expect(added).toContainText("no upcoming date", { timeout: 120_000 });
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
