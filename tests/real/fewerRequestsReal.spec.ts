import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
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
 * (`bun run test:real`). No model quota is spent.
 *
 * - **Market data:** after a refresh of everything, adding a widget with a
 *   new series and asking for `"unrefreshed"` fetches only that series. The
 *   other series keep their stamps, and the "last successful refresh" time
 *   does not move. A second refresh of everything in the same runner process
 *   still shows correct FRED metadata, now served from the runner's cache.
 * - **Earnings dates:** with JPX (keyless), adding a second stock and asking
 *   for `"unrefreshed"` refreshes only that stock.
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
	readonly refresh: { readonly activeRunId: string | null; readonly lastSucceededAt: string | null };
}
interface WatchlistData {
	readonly stocks: readonly {
		readonly stockId: string;
		readonly lastRefreshedAt: string | null;
		readonly unavailable: { readonly code: string } | null;
	}[];
	readonly refresh: { readonly activeRunId: string | null; readonly lastSucceededAt: string | null };
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

/** Queues one refresh and waits for it to finish; answers its final state. */
async function refresh(path: string, body: unknown): Promise<string> {
	const created = await api<{ run: { runId: string } }>("POST", path, body, idempotencyKey());
	const deadline = Date.now() + 420_000;
	for (;;) {
		const run = await api<{ run: { state: string } }>(
			"GET",
			`/api/v1/research-runs/${created.run.runId}`,
		);
		const state = run.run.state;
		if (state === "completed" || state === "failed" || state === "cancelled") return state;
		if (Date.now() > deadline) throw new Error(`${path} run did not finish in time`);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
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
			// 1. Everything, once: every default series is stamped.
			expect(await refresh("/api/v1/home/refresh", {})).toBe("completed");
			const first = await api<HomeData>("GET", "/api/v1/home/data");
			const firstStamps = stamps(first);
			expect([...firstStamps.values()].every((at) => at !== null)).toBe(true);
			const firstSuccess = first.refresh.lastSucceededAt;
			expect(firstSuccess).not.toBeNull();
			const fredBefore = first.series.filter((entry) => entry.seriesId.startsWith("fred:"));
			expect(fredBefore.length).toBeGreaterThan(0);

			// 2. A widget with a new series, then a refresh of what has no data.
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
			expect(await refresh("/api/v1/home/refresh", { scope: "unrefreshed" })).toBe("completed");
			const second = await api<HomeData>("GET", "/api/v1/home/data");
			const added = second.series.find((entry) => entry.seriesId === newSeries);
			if (added === undefined) throw new Error(`${newSeries} is missing from /home/data`);
			expect(added.unavailable).toBeNull();
			expect(added.observations.length).toBeGreaterThan(0);
			expect(added.lastRefreshedAt).not.toBeNull();
			for (const [seriesId, at] of firstStamps) {
				expect(stamps(second).get(seriesId), `${seriesId} was refetched`).toBe(at);
			}
			expect(second.refresh.lastSucceededAt).toBe(firstSuccess);

			// 3. Everything again in the same runner process: the FRED
			// metadata now comes from the runner's cache and must be the same.
			expect(await refresh("/api/v1/home/refresh", {})).toBe("completed");
			const third = await api<HomeData>("GET", "/api/v1/home/data");
			expect(third.refresh.lastSucceededAt).not.toBe(firstSuccess);
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
		await api("POST", "/api/v1/watchlist/stocks", { market: "JP", symbol: "7203" }, idempotencyKey());
		expect(await refresh("/api/v1/watchlist/refresh", {})).toBe("completed");
		const watchFirst = await api<WatchlistData>("GET", "/api/v1/watchlist");
		const toyota = watchFirst.stocks.find((stock) => stock.stockId === "jp:7203");
		if (toyota === undefined) throw new Error("jp:7203 is not on the watchlist");
		expect(toyota.lastRefreshedAt).not.toBeNull();
		const watchSuccess = watchFirst.refresh.lastSucceededAt;
		expect(watchSuccess).not.toBeNull();

		await api("POST", "/api/v1/watchlist/stocks", { market: "JP", symbol: "6758" }, idempotencyKey());
		expect(await refresh("/api/v1/watchlist/refresh", { scope: "unrefreshed" })).toBe("completed");
		const watchSecond = await api<WatchlistData>("GET", "/api/v1/watchlist");
		const sony = watchSecond.stocks.find((stock) => stock.stockId === "jp:6758");
		if (sony === undefined) throw new Error("jp:6758 is not on the watchlist");
		expect(sony.lastRefreshedAt).not.toBeNull();
		expect(
			watchSecond.stocks.find((stock) => stock.stockId === "jp:7203")?.lastRefreshedAt,
			"jp:7203 was refetched",
		).toBe(toyota.lastRefreshedAt);
		expect(watchSecond.refresh.lastSucceededAt).toBe(watchSuccess);

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${VITE_ORIGIN}/#/watchlist`);
		await expect(page.locator('tr[data-stock-id="jp:6758"]')).toBeVisible({ timeout: 60_000 });
		await page.screenshot({ path: join(shotsDir, "fewer-requests-watchlist.png"), fullPage: true });
	} finally {
		await service.stop();
	}
});
