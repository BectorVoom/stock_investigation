import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	type EquityCompanyView,
	equityCompanyListSchema,
	equityStatementResponseSchema,
	stockProfileResponseSchema,
} from "@research/contracts";
import { z } from "zod";
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
 * ADR-0048 financial statement sync against the real SEC EDGAR and EDINET
 * APIs (`bun run test:real equitySyncReal`), on the real `bun run dev`
 * launcher from a pristine copy (default runner: Rust), with the owner's
 * `SEC_USER_AGENT` and `EDINET_API_KEY` from the invoking environment. No
 * model quota is spent.
 *
 * 1. Fresh database: six stocks (AAPL, MSFT, KO, 7974, 8035, 6367) go on
 *    the Watchlist. The server downloads both stock lists and tracks every
 *    listed stock (ADR-0058 §3), the Watchlist's first, and syncs them
 *    automatically — a US company in one job; a Japanese one once the shared
 *    EDINET index (`edinet-index`, ADR-0058 §4: six years of day lists, 40
 *    a job) has listed its reports, each indexed report downloaded once.
 *    Without an EDINET key the index job fails as not configured and no
 *    Japanese company job is queued (the companies stay never synced).
 * 2. Every company has at least five fiscal years of income statement, balance
 *    sheet and cash flow values; Japanese balance sheets satisfy assets =
 *    liabilities + net assets exactly; US revenue equals the latest-filed 10-K
 *    value read independently from SEC's company facts.
 * 3. Every US company has the business description of its newest 10-K
 *    (ADR-0053): "Item 1. Business" extracted from the 10-K SEC's
 *    submissions index names newest, opening with a text paragraph.
 * 4. A second sync with nothing new changes no filing, fact, value or
 *    description row (the described 10-K is not downloaded again); it is
 *    made due by moving `next_due_at` to now in the dev D1: there is no
 *    Sync now any more, and the scheduler's own interval is 24 hours on the
 *    Watchlist.
 * 5. The Stocks page's Financial statements tab shows the statements, and the
 *    Company tab the business description (screenshots in test-results-real/).
 *
 * Never run by implementation agents.
 */
test.describe.configure({ mode: "serial" });

/** The stocks this spec puts on the Watchlist (the retired ADR-0048 §8 defaults). */
const STOCKS = [
	{ market: "US", symbol: "AAPL" },
	{ market: "US", symbol: "MSFT" },
	{ market: "US", symbol: "KO" },
	{ market: "JP", symbol: "7974" },
	{ market: "JP", symbol: "8035" },
	{ market: "JP", symbol: "6367" },
] as const;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8918;
const API_PORT = 8919;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

const secUserAgent = process.env.SEC_USER_AGENT ?? "";
const edinetKey = process.env.EDINET_API_KEY ?? "";
/** Without an EDINET key only the US half runs live; Japanese companies must then fail as not configured. */
const japanLive = edinetKey !== "";

test.beforeAll(() => {
	test.skip(
		secUserAgent === "",
		"needs SEC_USER_AGENT (and EDINET_API_KEY for the Japanese half) in the invoking environment",
	);
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-equity-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-equity-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
		SEC_USER_AGENT: secUserAgent,
		...(japanLive ? { EDINET_API_KEY: edinetKey } : {}),
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
		prodPort: "18994",
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

async function companies(): Promise<EquityCompanyView[]> {
	return equityCompanyListSchema.parse(await api("GET", "/api/v1/equities/companies")).companies;
}

/** Annual statements the spec expects per company: five fiscal years. */
const FISCAL_YEARS = 5;

function settled(company: EquityCompanyView): boolean {
	const { status, phase } = company.sync;
	if (status === "failed") {
		throw new Error(
			`${company.symbol} sync failed: ${company.sync.failure?.code} (${company.sync.failure?.upstreamStatus})`,
		);
	}
	if (status !== "succeeded") return false;
	// A Japanese company is synced again as the EDINET index lists older
	// reports (ADR-0058 §4): settled once nothing indexed is left to download
	// and the backfill reached five fiscal years.
	return (
		company.provider === "sec" ||
		(phase === "idle" && company.latestFiscalYear !== null && company.filingCount >= FISCAL_YEARS)
	);
}

/** Waits until every company's sync succeeded and (EDINET) has downloaded the indexed backfill. */
async function waitForSyncs(
	ids: readonly string[],
	timeoutMs: number,
): Promise<EquityCompanyView[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const list = (await companies()).filter((c) => ids.includes(c.companyId));
		if (list.length === ids.length && list.every(settled)) return list;
		if (Date.now() > deadline) {
			throw new Error(
				`syncs did not finish: ${JSON.stringify(list.map((c) => [c.symbol, c.sync.status, c.sync.phase]))}`,
			);
		}
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
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'equity_metric_value'",
				)
				.get();
			if (table !== undefined) return path;
		} finally {
			db.close();
		}
	}
	throw new Error(`no D1 database with the equity tables under ${dataDir}`);
}

const snapshotSchema = z.object({
	filings: z.number(),
	facts: z.number(),
	valueRows: z.number(),
	newestValue: z.string().nullable(),
	newestFact: z.string().nullable(),
	descriptions: z.number(),
	newestDescription: z.string().nullable(),
});

/** Row counts and newest write stamps of the financial tables. */
/**
 * Makes the companies due at once, as the scheduler's 24-hour interval would
 * once it has passed: the next claim queues their syncs one at a time.
 */
function makeDueNow(companyIds: readonly string[]): void {
	const db = new DatabaseSync(devDatabasePath());
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		const update = db.prepare("UPDATE equity_sync_state SET next_due_at = ? WHERE company_id = ?");
		const now = new Date().toISOString();
		for (const companyId of companyIds) update.run(now, companyId);
	} finally {
		db.close();
	}
}

function financialSnapshot(): z.infer<typeof snapshotSchema> {
	const db = new DatabaseSync(devDatabasePath(), { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		return snapshotSchema.parse(
			db
				.prepare(
					`SELECT (SELECT count(*) FROM equity_report_filing) AS filings,
					        (SELECT count(*) FROM equity_reported_fact) AS facts,
					        (SELECT count(*) FROM equity_metric_value) AS valueRows,
					        (SELECT max(updated_at) FROM equity_metric_value) AS newestValue,
					        (SELECT max(recorded_at) FROM equity_reported_fact) AS newestFact,
					        (SELECT count(*) FROM equity_business_description) AS descriptions,
					        (SELECT max(fetched_at) FROM equity_business_description) AS newestDescription`,
				)
				.get(),
		);
	} finally {
		db.close();
	}
}

async function statement(companyId: string, kind: string, years: number) {
	return equityStatementResponseSchema.parse(
		await api(
			"GET",
			`/api/v1/equities/companies/${encodeURIComponent(companyId)}/statements/${kind}?years=${years}`,
		),
	);
}

function cellValue(
	response: z.infer<typeof equityStatementResponseSchema>,
	metric: string,
	fiscalYear: number,
): bigint | null {
	const cell = response.rows
		.find((row) => row.metric === metric)
		?.cells.find((c) => c.fiscalYear === fiscalYear);
	return cell?.valueDecimal === null || cell?.valueDecimal === undefined
		? null
		: BigInt(cell.valueDecimal);
}

const companyFactsSchema = z.object({
	facts: z.object({
		"us-gaap": z.record(
			z.string(),
			z.object({
				units: z.record(
					z.string(),
					z.array(
						z.object({
							start: z.string().optional(),
							end: z.string(),
							val: z.number(),
							form: z.string(),
							filed: z.string(),
						}),
					),
				),
			}),
		),
	}),
});

/** The latest-filed 10-K value of `concept` for the annual period ending on `periodEnd`, read from SEC directly. */
async function secAnnualValue(
	cik: string,
	concept: string,
	periodEnd: string,
): Promise<bigint | null> {
	const response = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
		headers: { "User-Agent": secUserAgent },
	});
	expect(response.status).toBe(200);
	const facts = companyFactsSchema.parse(await response.json());
	const entries = (facts.facts["us-gaap"][concept]?.units.USD ?? []).filter((entry) => {
		if (entry.end !== periodEnd || entry.start === undefined) return false;
		if (entry.form !== "10-K" && entry.form !== "10-K/A") return false;
		const days = (Date.parse(entry.end) - Date.parse(entry.start)) / 86_400_000 + 1;
		return days >= 350 && days <= 380;
	});
	entries.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0));
	const latest = entries[0];
	return latest === undefined ? null : BigInt(latest.val);
}

const submissionsSchema = z.object({
	filings: z.object({
		recent: z.object({
			accessionNumber: z.array(z.string()),
			filingDate: z.array(z.string()),
			form: z.array(z.string()),
		}),
	}),
});

/** The accession of the newest original 10-K in SEC's submissions index, read from SEC directly. */
async function secNewestTenKAccession(cik: string): Promise<string | null> {
	const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
		headers: { "User-Agent": secUserAgent },
	});
	expect(response.status).toBe(200);
	const { recent } = submissionsSchema.parse(await response.json()).filings;
	let newest: { accession: string; filed: string } | null = null;
	for (const [index, form] of recent.form.entries()) {
		const accession = recent.accessionNumber[index] ?? "";
		const filed = recent.filingDate[index] ?? "";
		if (form !== "10-K") continue;
		if (
			newest === null ||
			filed > newest.filed ||
			(filed === newest.filed && accession > newest.accession)
		) {
			newest = { accession, filed };
		}
	}
	return newest?.accession ?? null;
}

test("syncs the default US and Japanese companies from SEC and EDINET (US only without an EDINET key), re-syncs without writes, and shows them", async ({
	page,
}) => {
	test.setTimeout(3_600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: devEnv() });
	resources.add(async () => {
		await service.stop();
	});

	// 1. The stocks go on the Watchlist; the claims download the stock lists
	// and track every listed stock, the Watchlist's first. Wait for every sync.
	for (const stock of STOCKS) await api("POST", "/api/v1/watchlist/stocks", stock);
	const isWatched = (company: EquityCompanyView) =>
		STOCKS.some((stock) => stock.market === company.market && stock.symbol === company.symbol);
	const deadline = Date.now() + 600_000;
	let listed: EquityCompanyView[] = [];
	while (listed.length < STOCKS.length) {
		if (Date.now() > deadline) throw new Error("the Watchlist stocks were not tracked");
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		// The list names Watchlist companies first (at most 200 of all tracked).
		listed = (await companies()).filter(isWatched);
	}
	const ids = listed.filter((c) => japanLive || c.market === "US").map((c) => c.companyId);
	const synced = await waitForSyncs(ids, 3_000_000);
	if (!japanLive) {
		// The positive path of the missing key (ADR-0058 §4): the shared index
		// job fails with the stable code, retried after 30 minutes, and no
		// Japanese company job is queued — one failed job, not one per company.
		const japanDeadline = Date.now() + 300_000;
		for (;;) {
			const runs = z
				.object({
					runs: z.array(z.object({ state: z.string(), failureCode: z.string().nullable() })),
				})
				.parse(await api("GET", "/api/v1/research-runs?kind=edinet-index")).runs;
			if (runs.length > 0 && runs.every((run) => run.state === "failed")) {
				for (const run of runs) expect(run.failureCode).toBe("FINANCIAL_SOURCE_NOT_CONFIGURED");
				break;
			}
			if (Date.now() > japanDeadline)
				throw new Error("the EDINET index job did not fail as expected");
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
		// No Japanese company was ever synced: none is due without an indexed report.
		const japan = (await companies()).filter((c) => c.market === "JP" && isWatched(c));
		expect(japan).toHaveLength(3);
		expect(japan.map((c) => c.sync.status)).toEqual(japan.map(() => "never"));
	}

	// 2. Five fiscal years of all three statements, checked against identities and SEC.
	for (const company of synced) {
		const income = await statement(company.companyId, "income-statement", 5);
		const balance = await statement(company.companyId, "balance-sheet", 5);
		const cash = await statement(company.companyId, "cash-flow", 5);
		expect(income.fiscalYears.length, `${company.symbol} fiscal years`).toBe(FISCAL_YEARS);
		for (const year of income.fiscalYears) {
			expect(
				cellValue(income, "revenue", year),
				`${company.symbol} revenue ${year}`,
			).not.toBeNull();
			expect(cellValue(income, "profit-attributable-to-owners", year)).not.toBeNull();
			expect(
				cellValue(balance, "total-assets", year),
				`${company.symbol} assets ${year}`,
			).not.toBeNull();
			expect(cellValue(cash, "net-cash-from-operating-activities", year)).not.toBeNull();
			if (company.market === "JP") {
				const assets = cellValue(balance, "total-assets", year);
				const liabilities = cellValue(balance, "total-liabilities", year);
				const equity = cellValue(balance, "total-equity", year);
				expect(
					liabilities !== null && equity !== null && liabilities + equity,
					`${company.symbol} ${year} B/S`,
				).toBe(assets);
				expect(cellValue(income, "ordinary-income", year)).not.toBeNull();
			}
		}
		if (company.market === "US" && company.sourceCompanyId !== null && company.symbol !== "KO") {
			const newest = income.fiscalYears.at(-1);
			const cell = income.rows
				.find((row) => row.metric === "revenue")
				?.cells.find((c) => c.fiscalYear === newest);
			if (cell?.concept === null || cell?.concept === undefined || cell.periodEnd === null) {
				throw new Error(`${company.symbol} has no newest revenue`);
			}
			const official = await secAnnualValue(
				company.sourceCompanyId,
				cell.concept.replace("us-gaap:", ""),
				cell.periodEnd,
			);
			expect(
				cell.valueDecimal === null ? null : BigInt(cell.valueDecimal),
				`${company.symbol} revenue vs SEC`,
			).toBe(official);
		}
	}

	// 3. The business description of each US company's newest 10-K (ADR-0053).
	const firstTexts = new Map<string, string>();
	for (const company of synced.filter((c) => c.market === "US")) {
		const stockId = `us:${company.symbol}`;
		const profile = stockProfileResponseSchema.parse(
			await api("GET", `/api/v1/stocks/${encodeURIComponent(stockId)}`),
		);
		const business = profile.business;
		if (business.status !== "extracted") {
			throw new Error(`${company.symbol} business description is ${business.status}`);
		}
		expect(business.source.form, `${company.symbol} form`).toBe("10-K");
		if (company.sourceCompanyId !== null) {
			expect(business.source.sourceDocumentId, `${company.symbol} newest 10-K`).toBe(
				await secNewestTenKAccession(company.sourceCompanyId),
			);
		}
		expect(business.source.sourceUrl).toMatch(
			/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9._-]+$/,
		);
		const firstText = business.paragraphs.find((paragraph) => paragraph.kind === "text");
		if (firstText === undefined) throw new Error(`${company.symbol} has no text paragraph`);
		// The section opens with what the company does, never with the table of contents or Item 1A.
		expect(firstText.text.length, `${company.symbol} first paragraph`).toBeGreaterThan(80);
		expect(business.paragraphs.map((p) => p.text).join("\n")).not.toMatch(/^Item 1A/im);
		firstTexts.set(company.symbol, firstText.text);
	}

	// 4. Nothing new upstream: a second sync of one US and one Japanese company writes no financial row.
	const before = financialSnapshot();
	const again = synced.filter((c) => c.symbol === "AAPL" || (japanLive && c.symbol === "7974"));
	const checkedBefore = new Map(again.map((c) => [c.companyId, c.sync.lastCheckedAt]));
	makeDueNow(again.map((company) => company.companyId));
	const resyncDeadline = Date.now() + 600_000;
	for (;;) {
		const now = (await companies()).filter((c) => checkedBefore.has(c.companyId));
		if (
			now.every(
				(c) =>
					c.sync.status === "succeeded" && c.sync.lastCheckedAt !== checkedBefore.get(c.companyId),
			)
		) {
			break;
		}
		if (Date.now() > resyncDeadline) throw new Error("the second syncs did not finish");
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
	expect(financialSnapshot()).toEqual(before);

	// 5. The Stocks page's Financial statements tab reads the stored statements (ADR-0049 §5).
	await page.setViewportSize({ width: 1440, height: 1000 });
	const shotsDir = join(REPO_ROOT, "test-results-real");
	mkdirSync(shotsDir, { recursive: true });
	for (const symbol of japanLive ? ["AAPL", "7974"] : ["AAPL"]) {
		const company = synced.find((c) => c.symbol === symbol);
		if (company === undefined) throw new Error(`${symbol} is not tracked`);
		// Each stock's tab has its own URL: open its Financial statements directly.
		const stockId = `${company.market.toLowerCase()}:${company.symbol}`;
		await page.goto(`${VITE_ORIGIN}/#/stocks/${stockId}/financials`);
		// The Stocks page has no stock table: its heading names the opened stock.
		await expect(page.locator('[data-field="stock-detail-heading"]')).toHaveText(
			new RegExp(`(^| · )${company.symbol}$`),
			{ timeout: 60_000 },
		);
		// The statement table's fiscal-year column headers appear once the stored statement loaded.
		await expect(page.getByRole("columnheader", { name: /FY20\d\d/ }).first()).toBeVisible({
			timeout: 60_000,
		});
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, `equity-sync-${symbol}.png`), fullPage: true });
	}
	// The Company tab shows the stored business description (ADR-0053 §6): its first text paragraph.
	const aaplText = firstTexts.get("AAPL");
	if (aaplText === undefined) throw new Error("AAPL has no business description");
	await page.goto(`${VITE_ORIGIN}/#/stocks/us:AAPL/company`);
	await expect(page.getByText(aaplText.slice(0, 60), { exact: false }).first()).toBeVisible({
		timeout: 60_000,
	});
	await page.screenshot({ path: join(shotsDir, "business-description-AAPL.png"), fullPage: true });
});
