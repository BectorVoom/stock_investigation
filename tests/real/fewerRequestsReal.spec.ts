import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import { localD1DatabasePath, makeFullMarketSyncDue, waitForSync } from "../e2e/marketSync.ts";
import {
	idempotencyKey,
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * ADR-0039 on the real development stack and the real network
 * (`bun run test:real`). No model quota is spent. No refresh is requested:
 * the API queues every job itself at the runner's claims (ADR-0051) — at
 * once for never-refreshed series and stocks, a full market sync when it
 * is due (every 30 minutes; the spec makes it due at once by ageing the
 * stored stamps, `makeFullMarketSyncDue`).
 *
 * - **Market data:** once the default series are synchronised, adding a
 *   widget with a new series makes the server fetch only that series. The
 *   other series keep their stamps, and the "last successful refresh" time
 *   does not move. A full sync in the same runner process still shows
 *   correct FRED metadata, now served from the runner's cache.
 * - **Earnings dates:** with JPX (keyless), adding a second stock makes the
 *   server refresh only that stock.
 *
 * FRED and Twelve Data use the invoking environment's keys, and the market
 * part is skipped without FRED_API_KEY. Never run by implementation agents:
 * it needs the network and takes minutes.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8921;
const API_PORT = 8922;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
/** FRED series not on the default dashboard; the first one not yet tracked is added. */
const NEW_SERIES_CANDIDATES = ["fred:DCOILWTICO", "fred:NIKKEI225", "fred:DGS2", "fred:PAYEMS"];

interface SeriesView {
	readonly seriesId: string;
	readonly title: string;
	readonly unit: string;
	readonly publisher: string;
	readonly sourceUrl: string;
	readonly lastRefreshedAt: string | null;
	readonly unavailable: { readonly code: string } | null;
	readonly observations: readonly (readonly [string, number])[];
}
interface HomeData {
	readonly series: readonly SeriesView[];
	readonly refresh: {
		readonly activeRunId: string | null;
		readonly lastSucceededAt: string | null;
	};
}
interface WatchlistData {
	readonly stocks: readonly {
		readonly stockId: string;
		readonly lastRefreshedAt: string | null;
		readonly unavailable: { readonly code: string } | null;
	}[];
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
	dataDir = mkdtempSync(join(tmpdir(), "research-real-fewer-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-fewer-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	const keys: Record<string, string> = {};
	for (const name of ["FRED_API_KEY", "TWELVE_DATA_API_KEY"]) {
		const value = process.env[name] ?? "";
		if (value !== "") keys[name] = value;
	}
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, keys);
});

test.afterAll(() => resources.close());

function env(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18975",
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
	if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	return (text === "" ? null : JSON.parse(text)) as T;
}

function homeData(): Promise<HomeData> {
	return api<HomeData>("GET", "/api/v1/home/data");
}

function watchlistData(): Promise<WatchlistData> {
	return api<WatchlistData>("GET", "/api/v1/watchlist");
}

/** Whether the market series `seriesId` was refreshed (at or after `sinceMs`). */
function seriesRefreshed(data: HomeData, seriesId: string, sinceMs = 0): boolean {
	const at = data.series.find((entry) => entry.seriesId === seriesId)?.lastRefreshedAt ?? null;
	return at !== null && Date.parse(at) >= sinceMs;
}

/** Whether the watchlist stock `stockId` was refreshed. */
function stockRefreshed(data: WatchlistData, stockId: string): boolean {
	return (data.stocks.find((stock) => stock.stockId === stockId)?.lastRefreshedAt ?? null) !== null;
}

function stamps(data: HomeData): Map<string, string | null> {
	return new Map(data.series.map((entry) => [entry.seriesId, entry.lastRefreshedAt]));
}

test("a widget or stock added later fetches only itself; cached FRED metadata stays right", async ({
	page,
}) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: env() });
	resources.add(async () => {
		await service.stop();
	});
	const shotsDir = join(REPO_ROOT, "test-results-real");
	mkdirSync(shotsDir, { recursive: true });
	try {
		const session = await api<{ environment: string }>("GET", "/api/v1/session");
		expect(session.environment).toBe("development");

		if ((process.env.FRED_API_KEY ?? "") === "") {
			test.info().annotations.push({
				type: "market",
				description: "not exercised: no FRED_API_KEY in the invoking environment",
			});
		} else {
			// 1. The first sync, which the API queues for the never-refreshed
			// default series: every default series is stamped.
			const first = await waitForSync(
				homeData,
				(current) => current.series.every((entry) => entry.lastRefreshedAt !== null),
				"the default market series",
			);
			const firstStamps = stamps(first);
			const firstSuccess = first.refresh.lastSucceededAt;
			const fredBefore = first.series.filter((entry) => entry.seriesId.startsWith("fred:"));
			expect(fredBefore.length).toBeGreaterThan(0);

			// 2. A widget with a new series: the server fetches what has no data.
			const newSeries = NEW_SERIES_CANDIDATES.find((id) => !firstStamps.has(id));
			if (newSeries === undefined) throw new Error("every candidate series is already tracked");
			const dashboard = await api<{
				dashboard: { schemaVersion: number; widgets: unknown[] };
				version: number;
			}>("GET", "/api/v1/home/dashboard");
			await api("PUT", "/api/v1/home/dashboard", {
				dashboard: {
					schemaVersion: dashboard.dashboard.schemaVersion,
					widgets: [
						...dashboard.dashboard.widgets,
						{
							type: "market-metric",
							widgetId: "w-fewer-requests",
							title: "Added later",
							size: "small",
							seriesId: newSeries,
						},
					],
				},
				expectedVersion: dashboard.version,
			});
			const second = await waitForSync(
				homeData,
				(current) => seriesRefreshed(current, newSeries),
				`the added series ${newSeries}`,
			);
			const added = second.series.find((entry) => entry.seriesId === newSeries);
			if (added === undefined) throw new Error(`${newSeries} is missing from /home/data`);
			expect(added.unavailable).toBeNull();
			expect(added.observations.length).toBeGreaterThan(0);
			expect(added.lastRefreshedAt).not.toBeNull();
			for (const [seriesId, at] of firstStamps) {
				expect(stamps(second).get(seriesId), `${seriesId} was refetched`).toBe(at);
			}
			expect(second.refresh.lastSucceededAt).toBe(firstSuccess);

			// 3. A full sync in the same runner process: the FRED metadata
			// now comes from the runner's cache and must be the same.
			const dueAt = makeFullMarketSyncDue(localD1DatabasePath(dataDir), null);
			const third = await waitForSync(
				homeData,
				(current) =>
					current.series.every((entry) => seriesRefreshed(current, entry.seriesId, dueAt)),
				"a full market sync",
			);
			// Only a completed full sync moves the last successful refresh.
			const thirdSuccess = third.refresh.lastSucceededAt;
			expect(thirdSuccess).not.toBeNull();
			expect(thirdSuccess).not.toBe(firstSuccess);
			for (const before of fredBefore) {
				const after = third.series.find((entry) => entry.seriesId === before.seriesId);
				if (after === undefined) throw new Error(`${before.seriesId} vanished`);
				expect(after.unavailable).toBeNull();
				expect(after.title).toBe(before.title);
				expect(after.unit).toBe(before.unit);
				expect(after.publisher).toBe(before.publisher);
				expect(after.sourceUrl).toBe(before.sourceUrl);
				expect(after.lastRefreshedAt).not.toBe(firstStamps.get(before.seriesId));
			}

			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${VITE_ORIGIN}/#/home`);
			const addedWidget = page.locator('article[data-widget-id="w-fewer-requests"]');
			await expect(addedWidget).toContainText(/\d+\.\d+/, { timeout: 120_000 });
			await expect(addedWidget).toContainText(/\d{4}-\d{2}-\d{2}/);
			await page.screenshot({ path: join(shotsDir, "fewer-requests-home.png"), fullPage: true });
		}

		// 4. Earnings dates (JPX, keyless): a second stock refreshes alone.
		await api(
			"POST",
			"/api/v1/watchlist/stocks",
			{ market: "JP", symbol: "7203" },
			idempotencyKey(),
		);
		const watchFirst = await waitForSync(
			watchlistData,
			(current) => stockRefreshed(current, "jp:7203"),
			"the earnings dates of jp:7203",
		);
		const toyota = watchFirst.stocks.find((stock) => stock.stockId === "jp:7203");
		if (toyota === undefined) throw new Error("jp:7203 is not on the watchlist");
		const watchSuccess = watchFirst.refresh.lastSucceededAt;

		await api(
			"POST",
			"/api/v1/watchlist/stocks",
			{ market: "JP", symbol: "6758" },
			idempotencyKey(),
		);
		const watchSecond = await waitForSync(
			watchlistData,
			(current) => stockRefreshed(current, "jp:6758"),
			"the earnings dates of jp:6758",
		);
		const sony = watchSecond.stocks.find((stock) => stock.stockId === "jp:6758");
		if (sony === undefined) throw new Error("jp:6758 is not on the watchlist");
		expect(sony.lastRefreshedAt).not.toBeNull();
		expect(
			watchSecond.stocks.find((stock) => stock.stockId === "jp:7203")?.lastRefreshedAt,
			"jp:7203 was refetched",
		).toBe(toyota.lastRefreshedAt);
		expect(watchSecond.refresh.lastSucceededAt).toBe(watchSuccess);

		await page.setViewportSize({ width: 1440, height: 900 });
		// Registered stocks lists its lists' stocks only (ADR-0054); the stock's own page says it is watched.
		await page.goto(`${VITE_ORIGIN}/#/stocks/jp:6758`);
		await expect(page.locator('[data-field="stock-watchlist-status"]')).toHaveText(
			/^On the Watchlist/,
			{ timeout: 60_000 },
		);
		await page.screenshot({ path: join(shotsDir, "fewer-requests-watchlist.png"), fullPage: true });
	} finally {
		await service.stop();
	}
});
