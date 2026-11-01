import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import { waitForSync } from "../e2e/marketSync.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	type StashedMigrations,
	startLauncher,
	stashMigrationsFrom,
	TestResources,
} from "./helpers.ts";

/**
 * Watchlist tables on an upgraded installation (`bun run test:real` only).
 * An installation whose database predates migration 0007 must get the
 * Watchlist tables — and the Google Calendar link table of 0008 — on the next
 * start and keep its data: from a pristine copy, first start `dev` with
 * `0007_watchlist_earnings.sql` and every later migration moved out of the
 * copy's `infra/migrations` (a database at schema version 6), create a
 * conversation through the API, stop; restore the migration files; start
 * `dev` again on the SAME data directory; assert the conversation is still
 * there and the Watchlist page loads empty; then a Home dashboard with an
 * earnings-calendar widget is saved (that widget type and its tables arrive
 * with the later migrations, so a version-6 installation cannot hold one;
 * a saved dashboard surviving an upgrade is covered by tasksReal.spec.ts),
 * 7203 is registered through the API (the never-refreshed state an
 * existing installation can hold) and Home is opened: the API queues the
 * stock's earnings-date refresh itself at the runner's next claim
 * (ADR-0051), and the saved calendar widget's dates appear with no click
 * and without a reload, over the real network, with the same
 * 7203 assertions on the Watchlist page as watchlistReal.spec.ts
 * (JPX company name, retrieved timestamp, JPX source link, upcoming ISO
 * date with fiscal-period text or the explicit undecided/unavailable text).
 *
 * JPX asks for low-frequency access: this spec causes exactly one earnings
 * fetch, and must not be re-run casually.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8906;
const API_PORT = 8907;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const MIGRATION = "0007_watchlist_earnings.sql";

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
let stashed: StashedMigrations | null = null;
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-watchlist-upgrade-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-watchlist-upgrade-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	if (pristine === null) throw new Error("the pristine copy was not created");
	// A database at schema version 6: the copy starts without the Watchlist
	// migration and every later one (Google Calendar included).
	stashed = stashMigrationsFrom(
		join(pristine.root, "infra", "migrations"),
		MIGRATION,
		join(extraRoot, "migrations-stash"),
	);
	resources.add(() => stashed?.restore());
	// JPX needs no key: the env file carries nothing at all.
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
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
		prodPort: "18986",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { ...ownerHeaders(API_ORIGIN) };
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

test("a pre-0007 database gains the Watchlist tables on restart and keeps its data", async ({
	page,
}) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");

	// Phase 1: schema version 6. A conversation is created through the API.
	const before = await startLauncher({ cwd: pristine.root, args: ["dev"], env: watchlistEnv() });
	try {
		const workspace = await api<{ workspaceId: string }>("POST", "/api/v1/workspaces", {
			title: "Upgrade probe",
		});
		const conversations = await api<{ conversations: { workspaceId: string }[] }>(
			"GET",
			"/api/v1/conversations",
		);
		expect(conversations.conversations.map((entry) => entry.workspaceId)).toContain(
			workspace.workspaceId,
		);
	} finally {
		await before.stop();
	}

	// Phase 2: the migrations return; the SAME data directory restarts at the
	// Watchlist + Google Calendar schema.
	stashed?.restore();
	const after = await startLauncher({ cwd: pristine.root, args: ["dev"], env: watchlistEnv() });
	resources.add(async () => {
		await after.stop();
	});
	try {
		const conversations = await api<{ conversations: { workspaceId: string; title: string }[] }>(
			"GET",
			"/api/v1/conversations",
		);
		expect(conversations.conversations.map((entry) => entry.title)).toContain("Upgrade probe");

		const empty = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
		expect(empty.stocks).toEqual([]);
		// The Google Calendar link table arrives with the migrations too: a
		// fresh link row reads disconnected.
		const withGoogle = await api<{ googleCalendar: { status: string } }>(
			"GET",
			"/api/v1/watchlist",
		);
		expect(withGoogle.googleCalendar.status).toBe("disconnected");

		// The Registered stocks page loads empty on the upgraded database.
		await page.goto(`${VITE_ORIGIN}/#/registered`);
		await expect(page.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible({
			timeout: 60_000,
		});
		// No watchlist stock: the page shows "No stocks yet." or, once the
		// first claim added the default financial-sync companies (ADR-0048),
		// only rows marked "Not on Watchlist".
		await expect(
			page.getByText("No stocks yet.").or(page.getByRole("tab", { name: /^All stocks/ })),
		).toBeVisible({ timeout: 60_000 });
		await expect(
			page.locator("tr[data-stock-id]").filter({ hasNotText: "Not on Watchlist" }),
		).toHaveCount(0);

		const defaults = await api<{
			dashboard: { schemaVersion: number; widgets: unknown[] };
			version: number;
			origin: string;
		}>("GET", "/api/v1/home/dashboard");
		expect(defaults.origin).toBe("defaults");
		const saved = await api<{ origin: string }>("PUT", "/api/v1/home/dashboard", {
			dashboard: {
				schemaVersion: 2,
				widgets: [
					...defaults.dashboard.widgets,
					{
						type: "earnings-calendar",
						widgetId: "w-earnings-upgrade",
						title: "Earnings calendar",
						size: "large",
						daysAhead: 180,
					},
				],
			},
			expectedVersion: defaults.version,
		});
		expect(saved.origin).toBe("saved");
		const dashboard = await api<{
			dashboard: { widgets: { widgetId: string; type: string }[] };
			origin: string;
		}>("GET", "/api/v1/home/dashboard");
		expect(dashboard.origin).toBe("saved");
		expect(dashboard.dashboard.widgets.map((widget) => widget.widgetId)).toContain(
			"w-earnings-upgrade",
		);

		// A stock never refreshed and a calendar widget already on the saved
		// dashboard. The API queues the stock's refresh at the runner's next
		// claim, so a run may already be active here; only the stored dates
		// are surely still absent.
		await api<WatchlistApiResponse>("POST", "/api/v1/watchlist/stocks", {
			market: "JP",
			symbol: "7203",
		});
		const unrefreshed = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
		expect(unrefreshed.stocks.map((entry) => entry.stockId)).toEqual(["jp:7203"]);
		expect(unrefreshed.stocks[0]?.retrievedAt).toBeNull();

		// Opening Home is all the owner does: the server fetches the dates
		// with no click anywhere, and the widget fills in without a reload.
		await page.goto(`${VITE_ORIGIN}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});
		const homeWidget = page.getByRole("article", { name: /Earnings calendar/ });
		await expect(homeWidget).toBeVisible({ timeout: 60_000 });
		await waitForSync(
			() => api<WatchlistApiResponse>("GET", "/api/v1/watchlist"),
			(current) =>
				(current.stocks.find((entry) => entry.stockId === "jp:7203")?.lastRefreshedAt ?? null) !==
				null,
			"the earnings dates of 7203",
			{ timeoutMs: 720_000, intervalMs: 5_000 },
		);

		const watchlist = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
		const toyota = watchlist.stocks.find((entry) => entry.stockId === "jp:7203");
		if (toyota === undefined) throw new Error("jp:7203 is missing from /api/v1/watchlist");
		const todayIso = new Date().toISOString().slice(0, 10);
		const widgetNext = toyota.events.find(
			(event) => event.announcementDate !== null && event.announcementDate >= todayIso,
		);
		// Still the page opened above — no reload, no click: the poller
		// brings the fetched date (or JPX's stated reason) into the widget.
		// (The page re-reads at up to 60 s intervals while nothing is stored, hence the wait.)
		await expect(homeWidget).not.toContainText("Earnings dates have not been fetched yet", {
			timeout: 120_000,
		});
		await expect(homeWidget).not.toContainText("Fetching earnings dates", { timeout: 120_000 });
		await expect(homeWidget).toContainText("7203");
		if (widgetNext !== undefined && widgetNext.announcementDate !== null) {
			await expect(homeWidget).toContainText(widgetNext.announcementDate, { timeout: 120_000 });
			// The widget marks the day with a link to the Registered stocks page, not a calendar link.
			await expect(
				homeWidget.getByRole("link", { name: /announcements?, (.*, )?7203/ }),
			).toHaveAttribute("href", "#/registered");
		}
		const shotsDir = join(REPO_ROOT, "test-results-real");
		mkdirSync(shotsDir, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 900 });
		await homeWidget.scrollIntoViewIfNeeded();
		await page.waitForTimeout(1_000);
		await page.screenshot({
			path: join(shotsDir, "watchlist-upgrade-home-1440x900.png"),
			fullPage: true,
		});

		await page.goto(`${VITE_ORIGIN}/#/registered`);
		await expect(page.getByRole("heading", { level: 2, name: "Registered stocks" })).toBeVisible({
			timeout: 60_000,
		});
		const status = page.locator('[data-field="watchlist-status"]');
		// The refresh ended well: the refresh line is empty (ADR-0050 §5).
		await expect(status).toHaveText("", { timeout: 120_000 });

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
	} finally {
		await after.stop();
	}
});
