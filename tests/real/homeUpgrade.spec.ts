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
 * Home tables on an upgraded installation (`bun run test:real` only).
 * An installation whose database predates migration 0006 must get the Home
 * tables on the next start and keep its data: from a pristine copy, first
 * start `dev` with `0006_market_data.sql` and every later migration moved out
 * of the copy's `infra/migrations` (a database at schema version 5), create a
 * conversation through the API, stop; restore the migration files; start `dev` again on the
 * SAME data directory; assert `GET /api/v1/home/dashboard` answers the
 * defaults, the earlier conversation is still listed, the server-side
 * market sync (ADR-0051: the API queues it at the runner's claim, because
 * the default series were never refreshed) completes over the real network
 * (keys passed through as in homeReal.spec.ts) and the Home page shows the
 * AAPL row in the browser (engine via REAL_BROWSER). In phase 1 the claim-
 * time scheduler runs against a database without the market tables, and
 * the claims must go on regardless.
 *
 * Never run by implementation agents (needs the network and minutes, and must
 * not touch `data/` or `data-dev/`); the orchestrator runs it.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8896;
const API_PORT = 8897;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const MIGRATION = "0006_market_data.sql";

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
	dataDir = mkdtempSync(join(tmpdir(), "research-real-home-upgrade-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-home-upgrade-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	if (pristine === null) throw new Error("the pristine copy was not created");
	// A database at schema version 5: the copy starts without the Home migration.
	stashed = stashMigrationsFrom(
		join(pristine.root, "infra", "migrations"),
		MIGRATION,
		join(extraRoot, "migrations-stash"),
	);
	resources.add(() => stashed?.restore());
	const fredKey = process.env.FRED_API_KEY;
	const twelveKey = process.env.TWELVE_DATA_API_KEY;
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
		TWELVE_DATA_API_KEY: twelveKey === undefined || twelveKey === "" ? "demo" : twelveKey,
		...(fredKey === undefined || fredKey === "" ? {} : { FRED_API_KEY: fredKey }),
	});
});

test.afterAll(() => resources.close());

function homeEnv(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18990",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers: ownerHeaders(API_ORIGIN),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	}
	return (text === "" ? null : JSON.parse(text)) as T;
}

test("a pre-0006 database gains the Home tables on restart and keeps its data", async ({
	page,
}) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");

	// Phase 1: schema version 5. A conversation is created through the API.
	const before = await startLauncher({ cwd: pristine.root, args: ["dev"], env: homeEnv() });
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

	// Phase 2: the migration returns; the SAME data directory restarts at schema version 6.
	stashed?.restore();
	const after = await startLauncher({ cwd: pristine.root, args: ["dev"], env: homeEnv() });
	resources.add(async () => {
		await after.stop();
	});
	try {
		const dashboard = await api<{
			dashboard: { widgets: unknown[] };
			origin: string;
		}>("GET", "/api/v1/home/dashboard");
		expect(dashboard.origin).toBe("defaults");
		expect(dashboard.dashboard.widgets.length).toBeGreaterThan(0);

		const conversations = await api<{ conversations: { workspaceId: string; title: string }[] }>(
			"GET",
			"/api/v1/conversations",
		);
		expect(conversations.conversations.map((entry) => entry.title)).toContain("Upgrade probe");

		// No refresh request: the API queues the sync at the runner's next
		// claim. Wait until the run has ended and AAPL carries a stamp.
		const synced = await waitForSync(
			() =>
				api<{
					series: { seriesId: string; lastRefreshedAt: string | null }[];
					refresh: {
						activeRunId: string | null;
						lastSucceededAt: string | null;
						lastFailure: { code: string } | null;
					};
				}>("GET", "/api/v1/home/data"),
			(current) =>
				current.series.some(
					(entry) => entry.seriesId === "twelve-data:AAPL" && entry.lastRefreshedAt !== null,
				),
			"the default market series",
			{ intervalMs: 5_000 },
		);
		expect(synced.refresh.lastFailure).toBeNull();

		await page.goto(`${VITE_ORIGIN}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});
		const watchlist = page.locator('article[data-widget-id="w-watchlist"]');
		await expect(watchlist).toBeVisible({ timeout: 60_000 });
		const aaplRow = watchlist.getByRole("row", { name: /AAPL/ });
		await expect(aaplRow).toContainText(/\d+\.\d+/, { timeout: 120_000 });
		await expect(aaplRow).toContainText("USD");
		await expect(aaplRow).toContainText(/\d{4}-\d{2}-\d{2}/);

		// F4: leave something to look at — a full-page 1440×900 screenshot
		// under `test-results-real/`, the same way homeReal.spec.ts saves its
		// screenshots (helper/path convention reused from that suite).
		const shotsDir = join(REPO_ROOT, "test-results-real");
		mkdirSync(shotsDir, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, "home-upgrade-1440x900.png"), fullPage: true });
	} finally {
		await after.stop();
	}
});
