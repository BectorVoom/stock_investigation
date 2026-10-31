import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { HISTORY_OVERLAP_OBSERVATIONS } from "../../packages/domain/src/market/historyRefresh.ts";
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
 * ADR-0044 incremental history refresh against the real network
 * (`bun run test:real`), on the real `bun run dev` launcher from a pristine
 * copy (default runner: Rust), with the owner's Twelve Data and FRED keys
 * from the invoking environment. No model quota is spent.
 *
 * The local D1 file of the throwaway development data directory is edited
 * between refreshes so each branch of the rule shows in the stored rows:
 *
 * 1. First refresh: every series is fetched in full (`history_checked_at` set).
 * 2. A bogus AAPL point is planted inside the refresh window, and an older
 *    point (outside the window) is altered. The next refresh is a window
 *    fetch: the bogus point is gone (the provider does not have it) while the
 *    altered older point is still altered — proof that the older history was
 *    neither re-fetched nor rewritten.
 * 3. The anchor itself is altered (as a split would re-adjust it). The next
 *    refresh finds the anchor changed, fetches the full history in the same
 *    job and replaces the series: the older point is repaired.
 *
 * Then the Home page shows the Indicator table's Trend column and a row
 * opens the detailed chart viewer. Never run by implementation agents.
 *
 * A real revision between the refreshes (FRED's annual seasonal revision of
 * CPI, a split of AAPL) changes the anchor legitimately and fails step 2 —
 * re-run it then.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8908;
const API_PORT = 8909;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const AAPL = "twelve-data:AAPL";
const CPI = "fred:CPIAUCSL";

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

const fredKey = process.env.FRED_API_KEY ?? "";
const twelveKey = process.env.TWELVE_DATA_API_KEY ?? "";

test.beforeAll(() => {
	test.skip(
		fredKey === "" || twelveKey === "",
		"needs FRED_API_KEY and TWELVE_DATA_API_KEY in the invoking environment",
	);
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-history-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-history-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
		TWELVE_DATA_API_KEY: twelveKey,
		FRED_API_KEY: fredKey,
	});
});

test.afterAll(() => resources.close());

function devEnv(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18993",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api(method: string, path: string, body?: unknown, key?: string): Promise<unknown> {
	const headers: Record<string, string> = { ...ownerHeaders(API_ORIGIN) };
	if (key !== undefined) headers["Idempotency-Key"] = key;
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	return text === "" ? null : JSON.parse(text);
}

const runIdSchema = z.object({ run: z.object({ runId: z.string() }) });
const runStateSchema = z.object({ run: z.object({ state: z.string() }) });

/** Queues a refresh of every tracked series and waits until its run ends; returns the end state. */
async function refreshAll(): Promise<string> {
	const created = runIdSchema.parse(
		await api("POST", "/api/v1/home/refresh", { scope: "all" }, idempotencyKey()),
	);
	const deadline = Date.now() + 420_000;
	for (;;) {
		const run = runStateSchema.parse(
			await api("GET", `/api/v1/research-runs/${created.run.runId}`),
		);
		const state = run.run.state;
		if (state === "completed" || state === "failed" || state === "cancelled") return state;
		if (Date.now() > deadline) throw new Error("the market refresh did not finish in time");
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
}

/** The development D1 file: the `.sqlite` under the data directory that holds the market tables. */
function devDatabasePath(): string {
	const candidates: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith(".sqlite")) candidates.push(path);
		}
	};
	walk(dataDir);
	for (const path of candidates) {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const table = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'market_observations'",
				)
				.get();
			if (table !== undefined) return path;
		} finally {
			db.close();
		}
	}
	throw new Error(`no D1 database with market tables under ${dataDir}`);
}

const rowSchema = z.object({ observed_on: z.string(), value: z.number() });
const checkedSchema = z.object({ history_checked_at: z.string().nullable() });

function withDatabase<T>(use: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(devDatabasePath());
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		return use(db);
	} finally {
		db.close();
	}
}

/** Stored rows of one series, newest first. */
function storedRows(seriesId: string): { observed_on: string; value: number }[] {
	return withDatabase((db) =>
		db
			.prepare(
				"SELECT observed_on, value FROM market_observations WHERE series_id = ? ORDER BY observed_on DESC",
			)
			.all(seriesId)
			.map((row) => rowSchema.parse(row)),
	);
}

function historyCheckedAt(seriesId: string): string | null {
	return withDatabase(
		(db) =>
			checkedSchema.parse(
				db
					.prepare("SELECT history_checked_at FROM market_series WHERE series_id = ?")
					.get(seriesId),
			).history_checked_at,
	);
}

function setValue(seriesId: string, observedOn: string, value: number): void {
	withDatabase((db) => {
		db.prepare(
			"UPDATE market_observations SET value = ? WHERE series_id = ? AND observed_on = ?",
		).run(value, seriesId, observedOn);
	});
}

function insertRow(seriesId: string, observedOn: string, value: number): void {
	withDatabase((db) => {
		db.prepare(
			"INSERT INTO market_observations (owner_id, series_id, observed_on, value) SELECT owner_id, series_id, ?, ? FROM market_series WHERE series_id = ?",
		).run(observedOn, value, seriesId);
	});
}

/** A weekend date strictly between two ISO dates (no daily close exists on it). */
function weekendBetween(older: string, newer: string): string {
	const day = new Date(`${older}T00:00:00Z`);
	for (;;) {
		day.setUTCDate(day.getUTCDate() + 1);
		const iso = day.toISOString().slice(0, 10);
		if (iso >= newer) throw new Error(`no weekend between ${older} and ${newer}`);
		const weekday = day.getUTCDay();
		if (weekday === 0 || weekday === 6) return iso;
	}
}

test("market history refreshes by window, repairs a changed anchor in full, and the Indicator table charts it", async ({
	page,
}) => {
	test.setTimeout(1_200_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: devEnv() });
	resources.add(async () => {
		await service.stop();
	});

	// 1. First refresh: everything in full.
	expect(await refreshAll()).toBe("completed");
	const first = storedRows(AAPL);
	expect(first.length).toBeGreaterThan(HISTORY_OVERLAP_OBSERVATIONS + 60);
	const firstChecked = historyCheckedAt(AAPL);
	expect(firstChecked).not.toBeNull();
	expect(storedRows(CPI).length).toBeGreaterThan(HISTORY_OVERLAP_OBSERVATIONS);
	expect(historyCheckedAt(CPI)).not.toBeNull();

	// 2. Plant a bogus point inside the window, alter one outside it.
	const anchor = first[HISTORY_OVERLAP_OBSERVATIONS - 1];
	const older = first[HISTORY_OVERLAP_OBSERVATIONS + 40];
	const newest = first[0];
	if (anchor === undefined || older === undefined || newest === undefined) {
		throw new Error("not enough AAPL rows");
	}
	const bogusDate = weekendBetween(anchor.observed_on, newest.observed_on);
	insertRow(AAPL, bogusDate, 1);
	setValue(AAPL, older.observed_on, older.value + 1_000);
	// FRED too: an older CPI point altered outside its window stays altered
	// only if FRED's `observation_start` answer held the anchor unchanged.
	const cpiFirst = storedRows(CPI);
	const cpiOlder = cpiFirst[HISTORY_OVERLAP_OBSERVATIONS + 12];
	if (cpiOlder === undefined) throw new Error("not enough CPI rows");
	const cpiChecked = historyCheckedAt(CPI);
	setValue(CPI, cpiOlder.observed_on, cpiOlder.value + 1_000);
	expect(await refreshAll()).toBe("completed");
	expect(storedRows(CPI).find((row) => row.observed_on === cpiOlder.observed_on)?.value).toBe(
		cpiOlder.value + 1_000,
	);
	expect(historyCheckedAt(CPI)).toBe(cpiChecked);
	const second = storedRows(AAPL);
	expect(second.some((row) => row.observed_on === bogusDate)).toBe(false);
	expect(second.find((row) => row.observed_on === older.observed_on)?.value).toBe(
		older.value + 1_000,
	);
	expect(second.find((row) => row.observed_on === anchor.observed_on)?.value).toBe(anchor.value);
	expect(historyCheckedAt(AAPL)).toBe(firstChecked);

	// 3. Alter the anchor: the runner sees a revision and fetches everything.
	const current = storedRows(AAPL);
	const anchorNow = current[HISTORY_OVERLAP_OBSERVATIONS - 1];
	if (anchorNow === undefined) throw new Error("no anchor row");
	setValue(AAPL, anchorNow.observed_on, anchorNow.value + 1_000);
	expect(await refreshAll()).toBe("completed");
	const third = storedRows(AAPL);
	expect(third.find((row) => row.observed_on === anchorNow.observed_on)?.value).toBe(
		anchorNow.value,
	);
	expect(third.find((row) => row.observed_on === older.observed_on)?.value).toBe(older.value);
	expect(historyCheckedAt(AAPL)).not.toBe(firstChecked);

	// 4. The Indicator table on Home: Trend column and the chart viewer.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${VITE_ORIGIN}/#/home`);
	const table = page.locator('article[data-widget-id="w-us-economy"]');
	await expect(table).toBeVisible({ timeout: 60_000 });
	await expect(table.getByRole("columnheader", { name: "Trend" })).toBeVisible();
	await expect(table.locator("svg").first()).toBeVisible({ timeout: 60_000 });
	const shotsDir = join(REPO_ROOT, "test-results-real");
	mkdirSync(shotsDir, { recursive: true });
	await table.screenshot({ path: join(shotsDir, "market-history-indicator-table.png") });
	await table.getByRole("button", { name: /^Open chart: .*CPIAUCSL/ }).click();
	const viewer = page.locator("sl-dialog.chart-viewer");
	await expect(viewer).toBeVisible({ timeout: 60_000 });
	await page.waitForTimeout(1_000);
	await page.screenshot({ path: join(shotsDir, "market-history-viewer.png") });
});
