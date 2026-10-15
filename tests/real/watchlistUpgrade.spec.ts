import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
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
 * Watchlist tables on an upgraded installation (`bun run test:real` only).
 * An installation whose database predates migration 0007 must get the
 * Watchlist tables — and, with migration 0008 moved out and back exactly
 * like it, the Google Calendar link table — on the next start and keep its
 * data: from a pristine
 * copy, first start `dev` with `0007_watchlist_earnings.sql` moved out of
 * the copy's `infra/migrations` (a database at schema version 6), create a
 * conversation and save a Home dashboard through the API, stop; restore the
 * migration file; start `dev` again on the SAME data directory; assert the
 * conversation and the saved dashboard are still there, the Watchlist page
 * loads empty; then 7203 is registered through the API (which queues no
 * refresh — the never-refreshed state an existing installation can hold)
 * and Home is opened: the saved calendar widget's dates are fetched with no
 * click and appear without a reload, over the real network, with the same
 * 7203 assertions on the Watchlist page as watchlistReal.spec.ts
 * (JPX company name, retrieved timestamp, JPX source link, upcoming ISO
 * date with fiscal-period text or the explicit undecided/unavailable text).
 *
 * JPX asks for low-frequency access: this spec performs exactly one refresh,
 * and must not be re-run casually.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8906;
const API_PORT = 8907;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const MIGRATION = "0007_watchlist_earnings.sql";
const MIGRATION_GOOGLE = "0008_google_calendar.sql";

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
let stashedMigration = "";
let stashedGoogleMigration = "";
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
	// migration — and without the Google Calendar migration, moved out and
	// back exactly like it.
	stashedMigration = join(extraRoot, MIGRATION);
	renameSync(join(pristine.root, "infra", "migrations", MIGRATION), stashedMigration);
	stashedGoogleMigration = join(extraRoot, MIGRATION_GOOGLE);
	renameSync(join(pristine.root, "infra", "migrations", MIGRATION_GOOGLE), stashedGoogleMigration);
	resources.add(() => {
		try {
			if (pristine !== null)
				renameSync(stashedMigration, join(pristine.root, "infra", "migrations", MIGRATION));
		} catch {
			// The spec body restores it first; only a setup failure lands here.
		}
		try {
			if (pristine !== null)
				renameSync(
					stashedGoogleMigration,
					join(pristine.root, "infra", "migrations", MIGRATION_GOOGLE),
				);
		} catch {
			// The spec body restores it first; only a setup failure lands here.
		}
	});
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

	// Phase 1: schema version 6. A conversation is created and a Home
	// dashboard (with an earnings-calendar widget) is saved through the API.
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
		const dashboard = await api<{
			dashboard: { schemaVersion: number; widgets: unknown[] };
			version: number;
			origin: string;
		}>("GET", "/api/v1/home/dashboard");
		expect(dashboard.origin).toBe("defaults");
		const saved = await api<{ origin: string }>("PUT", "/api/v1/home/dashboard", {
			dashboard: {
				schemaVersion: 1,
				widgets: [
					...dashboard.dashboard.widgets,
					{
						type: "earnings-calendar",
						widgetId: "w-earnings-upgrade",
						title: "Earnings calendar",
						size: "large",
						daysAhead: 180,
					},
				],
			},
			expectedVersion: dashboard.version,
		});
		expect(saved.origin).toBe("saved");
	} finally {
		await before.stop();
	}

	// Phase 2: the migrations return; the SAME data directory restarts at the
	// Watchlist + Google Calendar schema.
	renameSync(stashedMigration, join(pristine.root, "infra", "migrations", MIGRATION));
	renameSync(stashedGoogleMigration, join(pristine.root, "infra", "migrations", MIGRATION_GOOGLE));
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

		const dashboard = await api<{
			dashboard: { widgets: { widgetId: string; type: string }[] };
			origin: string;
		}>("GET", "/api/v1/home/dashboard");
		expect(dashboard.origin).toBe("saved");
		expect(dashboard.dashboard.widgets.map((widget) => widget.widgetId)).toContain(
			"w-earnings-upgrade",
		);

		const empty = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
		expect(empty.stocks).toEqual([]);
		// The Google Calendar link table arrives with the migrations too: a
		// fresh link row reads disconnected.
		const withGoogle = await api<{ googleCalendar: { status: string } }>(
			"GET",
			"/api/v1/watchlist",
		);
		expect(withGoogle.googleCalendar.status).toBe("disconnected");

		// The Watchlist page loads empty on the upgraded database.
		await page.goto(`${VITE_ORIGIN}/#/watchlist`);
		await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.getByText("No stocks registered yet.")).toBeVisible({ timeout: 60_000 });

		// The state that prompted the automatic refresh (2026-10-13): a stock
		// registered WITHOUT any refresh ever queued — the API add queues
		// none — and a calendar widget already on the saved dashboard.
		await api<WatchlistApiResponse>("POST", "/api/v1/watchlist/stocks", {
			market: "JP",
			symbol: "7203",
		});
		const unrefreshed = await api<WatchlistApiResponse>("GET", "/api/v1/watchlist");
		expect(unrefreshed.stocks.map((entry) => entry.stockId)).toEqual(["jp:7203"]);
		expect(unrefreshed.stocks[0]?.retrievedAt).toBeNull();
		expect(unrefreshed.refresh.activeRunId).toBeNull();
		expect(unrefreshed.refresh.lastSucceededAt).toBeNull();

		// Opening Home is all the owner does: the widget's dates are fetched
		// with no click anywhere, and the widget fills in without a reload.
		await page.goto(`${VITE_ORIGIN}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});
		const homeWidget = page.getByRole("article", { name: /Earnings calendar/ });
		await expect(homeWidget).toBeVisible({ timeout: 60_000 });
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
		const todayIso = new Date().toISOString().slice(0, 10);
		const widgetNext = toyota.events.find(
			(event) => event.announcementDate !== null && event.announcementDate >= todayIso,
		);
		// Still the page opened above — no reload, no click: the poller
		// brings the fetched date (or JPX's stated reason) into the widget.
		// (A queued run is polled at up to 15 s intervals, hence the wait.)
		await expect(homeWidget).not.toContainText("Earnings dates have not been fetched yet.", {
			timeout: 120_000,
		});
		await expect(homeWidget).not.toContainText("Fetching earnings dates", { timeout: 120_000 });
		await expect(homeWidget).toContainText("7203");
		if (widgetNext !== undefined && widgetNext.announcementDate !== null) {
			await expect(homeWidget).toContainText(widgetNext.announcementDate, { timeout: 120_000 });
			// The widget marks the day with a link to the Watchlist page, not a calendar link.
			await expect(
				homeWidget.getByRole("link", { name: /announcements?, (.*, )?7203/ }),
			).toHaveAttribute("href", "#/watchlist");
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

		await page.goto(`${VITE_ORIGIN}/#/watchlist`);
		await expect(page.getByRole("heading", { level: 2, name: "Watchlist" })).toBeVisible({
			timeout: 60_000,
		});
		const status = page.locator('[data-field="watchlist-status"]');
		await expect(status).toContainText("Last successful refresh:", { timeout: 120_000 });

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
