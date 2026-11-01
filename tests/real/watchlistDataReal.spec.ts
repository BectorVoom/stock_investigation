import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
	equityCompanyListSchema,
	stockPricesResponseSchema,
	stockProfileResponseSchema,
} from "@research/contracts";
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
 * ADR-0055 on the real `bun run dev` launcher from a pristine copy, against
 * the real Twelve Data and SEC EDGAR (`bun run test:real watchlistDataReal`),
 * with the owner's `TWELVE_DATA_API_KEY` and `SEC_USER_AGENT` from the
 * invoking environment (`EDINET_API_KEY` optional). No model quota is spent.
 *
 * 1. Fresh database: two US stocks no Home widget shows (KO, JNJ) and one
 *    Japanese stock (7974) go on the Watchlist — the only thing the test
 *    does besides reading. It never asks for a fetch: there is no endpoint
 *    for one (ADR-0054).
 * 2. The server fetches by itself: its claim-time schedule queues the
 *    `market-refresh` and `financial-sync` jobs (audited with actor
 *    `scheduler`), and the runner stores KO's and JNJ's daily closes, annual
 *    statements and business descriptions in the database.
 * 3. The Stocks page shows the stored data: each US stock's Chart tab draws
 *    its closes, the Financial statements tab its statements, the Company tab
 *    its business description; the Japanese stock's tabs state what is not
 *    stored (no prices on Twelve Data's Basic plan; no statements without an
 *    EDINET key). The page sends only GET requests, and no tab speaks of
 *    syncing. Screenshots in test-results-real/.
 *
 * Never run by implementation agents.
 */
test.describe.configure({ mode: "serial" });

const US_SYMBOLS = ["KO", "JNJ"] as const;
const STOCKS = [
	{ market: "US", symbol: "KO" },
	{ market: "US", symbol: "JNJ" },
	{ market: "JP", symbol: "7974" },
] as const;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8940;
const API_PORT = 8941;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

const twelveKey = process.env.TWELVE_DATA_API_KEY ?? "";
const secUserAgent = process.env.SEC_USER_AGENT ?? "";
const edinetKey = process.env.EDINET_API_KEY ?? "";

test.beforeAll(() => {
	test.skip(
		twelveKey === "" || secUserAgent === "",
		"needs TWELVE_DATA_API_KEY and SEC_USER_AGENT in the invoking environment",
	);
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-watchdata-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-watchdata-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
		TWELVE_DATA_API_KEY: twelveKey,
		SEC_USER_AGENT: secUserAgent,
		...(edinetKey === "" ? {} : { EDINET_API_KEY: edinetKey }),
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
		prodPort: "18940",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers: { ...ownerHeaders(API_ORIGIN) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	return text === "" ? null : JSON.parse(text);
}

/** Polls `check` every 5 s until it answers a value, or fails with `what` after `timeoutMs`. */
async function eventually<T>(
	what: string,
	timeoutMs: number,
	check: () => Promise<T | null>,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== null) return value;
		if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
}

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
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")
				.get();
			if (table !== undefined) return path;
		} finally {
			db.close();
		}
	}
	throw new Error(`no D1 database under ${dataDir}`);
}

/** Who queued each data job: the audit rows of the market and financial syncs. */
function syncAudits(): { readonly actor: string; readonly action: string }[] {
	const db = new DatabaseSync(devDatabasePath(), { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		return db
			.prepare(
				`SELECT actor, action FROM audit_log
				WHERE action IN ('run.sync_market', 'equity.track')
				ORDER BY audit_id`,
			)
			.all()
			.map((row) => ({ actor: String(row.actor), action: String(row.action) }));
	} finally {
		db.close();
	}
}

/** The text of a tab panel, for the "no sync wording" check. */
async function panelText(page: Page, tab: string): Promise<string> {
	return page.locator(`#stock-panel-${tab}`).innerText();
}

test("the server fetches Watchlist stocks' prices, statements and descriptions by itself, and the Stocks page shows them", async ({
	page,
}) => {
	test.setTimeout(1_800_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: devEnv() });
	resources.add(async () => {
		await service.stop();
	});

	// 1. The owner registers the stocks; nothing else is written.
	for (const stock of STOCKS) await api("POST", "/api/v1/watchlist/stocks", stock);

	// 2. The server fetches and stores, with no request from the test or a page.
	const prices = new Map<string, number>();
	for (const symbol of US_SYMBOLS) {
		const stockId = `us:${symbol}`;
		const stored = await eventually(`${symbol}'s daily closes`, 600_000, async () => {
			const answer = stockPricesResponseSchema.parse(
				await api("GET", `/api/v1/stocks/${encodeURIComponent(stockId)}/prices`),
			);
			const count = answer.series?.observations.length ?? 0;
			return count >= 2 ? answer : null;
		});
		expect(stored.series?.unavailable, `${symbol} prices`).toBeNull();
		expect(stored.series?.publisher).toBe("Twelve Data");
		prices.set(symbol, stored.series?.observations.length ?? 0);
	}
	const japanPrices = await eventually("7974's price answer", 600_000, async () => {
		const answer = stockPricesResponseSchema.parse(
			await api("GET", `/api/v1/stocks/${encodeURIComponent("jp:7974")}/prices`),
		);
		return answer.series?.lastRefreshedAt == null ? null : answer;
	});
	const companies = await eventually("the US statements", 1_200_000, async () => {
		const list = equityCompanyListSchema.parse(
			await api("GET", "/api/v1/equities/companies"),
		).companies;
		const us = list.filter((company) => company.market === "US");
		if (us.length < US_SYMBOLS.length) return null;
		for (const company of us) {
			if (company.sync.status === "failed") {
				throw new Error(`${company.symbol} sync failed: ${company.sync.failure?.code}`);
			}
		}
		return us.every((company) => company.sync.status === "succeeded" && company.latestFiscalYear)
			? list
			: null;
	});
	const descriptions = new Map<string, string>();
	for (const symbol of US_SYMBOLS) {
		const profile = await eventually(`${symbol}'s business description`, 300_000, async () => {
			const answer = stockProfileResponseSchema.parse(
				await api("GET", `/api/v1/stocks/${encodeURIComponent(`us:${symbol}`)}`),
			);
			return answer.business.status === "extracted" ? answer : null;
		});
		if (profile.business.status !== "extracted") throw new Error("unreachable");
		const text = profile.business.paragraphs.find((paragraph) => paragraph.kind === "text");
		if (text === undefined) throw new Error(`${symbol} has no text paragraph`);
		descriptions.set(symbol, text.text);
	}
	// Every data job came from the server's schedule, none from a person.
	const audits = syncAudits();
	expect(audits.filter((row) => row.action === "run.sync_market").length).toBeGreaterThan(0);
	expect(audits.filter((row) => row.action === "equity.track").length).toBe(STOCKS.length);
	for (const row of audits) expect(row.actor, row.action).toBe("scheduler");

	// 3. The Stocks page shows the stored data, sending GET requests only.
	const writes: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/api/") && request.method() !== "GET") {
			writes.push(`${request.method()} ${request.url()}`);
		}
	});
	await page.setViewportSize({ width: 1440, height: 1000 });
	const shotsDir = join(REPO_ROOT, "test-results-real");
	mkdirSync(shotsDir, { recursive: true });
	for (const symbol of US_SYMBOLS) {
		const stockId = `us:${symbol}`;
		await page.goto(`${VITE_ORIGIN}/#/stocks/${stockId}/chart`);
		await expect(page.locator('[data-field="stock-detail-heading"]')).toHaveText(
			new RegExp(`(^| · )${symbol}$`),
			{ timeout: 60_000 },
		);
		await expect(page.locator('#stock-panel-chart section[aria-label="Chart"]')).toBeVisible({
			timeout: 60_000,
		});
		await page.screenshot({ path: join(shotsDir, `watchlist-data-${symbol}-chart.png`) });

		await page.getByRole("tab", { name: "Financial statements" }).click();
		await expect(page.getByRole("columnheader", { name: /FY20\d\d/ }).first()).toBeVisible({
			timeout: 60_000,
		});
		await page.screenshot({ path: join(shotsDir, `watchlist-data-${symbol}-financials.png`) });

		await page.getByRole("tab", { name: "Company" }).click();
		const description = descriptions.get(symbol) ?? "";
		await expect(page.getByText(description.slice(0, 60), { exact: false }).first()).toBeVisible({
			timeout: 60_000,
		});
		await page.screenshot({ path: join(shotsDir, `watchlist-data-${symbol}-company.png`) });
		for (const tab of ["chart", "financials", "company"]) {
			expect(await panelText(page, tab), `${symbol} ${tab}`).not.toMatch(/\bsync(ed|ing|s)?\b/i);
		}
	}

	// The Japanese stock: each tab states what is not stored, without sync words or codes.
	await page.goto(`${VITE_ORIGIN}/#/stocks/jp:7974/chart`);
	if (japanPrices.series?.unavailable === null) {
		// Stored closes: the chart, or with only one close the note saying it needs two.
		await expect(
			page.locator(
				'#stock-panel-chart section[aria-label="Chart"], [data-field="stock-chart-one-close"]',
			),
		).toBeVisible({ timeout: 60_000 });
	} else {
		await expect(page.locator('[data-field="stock-chart-unavailable"]')).toBeVisible({
			timeout: 60_000,
		});
	}
	await page.getByRole("tab", { name: "Financial statements" }).click();
	const japan = companies.find((company) => company.market === "JP");
	if (edinetKey === "" || japan?.latestFiscalYear == null) {
		await expect(
			page.locator('#stock-panel-financials [data-field="stock-financials-tab"]'),
		).toContainText("stored", { timeout: 60_000 });
	}
	await page.screenshot({ path: join(shotsDir, "watchlist-data-7974-financials.png") });
	const japanText = await panelText(page, "financials");
	expect(japanText).not.toMatch(/\bsync(ed|ing|s)?\b|FINANCIAL_|EDINET_API_KEY/i);

	expect(writes, "the page only reads").toEqual([]);
	expect([...prices.values()].every((count) => count >= 2)).toBe(true);
});
