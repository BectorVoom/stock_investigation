import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	EQUITY_DEFAULT_STOCK_IDS,
	type EquityCompanyView,
	equityCompanyListSchema,
	equityStatementResponseSchema,
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
 * 1. Fresh database: the default companies (AAPL, MSFT, KO, 7974, 8035,
 *    6367) are added by the first claim and synced automatically — US in one
 *    job each, Japanese over several (discovery, five backfill windows,
 *    forward scan).
 * 2. Every company has at least five fiscal years of income statement, balance
 *    sheet and cash flow values; Japanese balance sheets satisfy assets =
 *    liabilities + net assets exactly; US revenue equals the latest-filed 10-K
 *    value read independently from SEC's company facts.
 * 3. A second sync with nothing new changes no filing, fact or value row.
 * 4. The Equities page shows the statements (screenshots in
 *    test-results-real/).
 *
 * Never run by implementation agents.
 */
test.describe.configure({ mode: "serial" });

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

test.beforeAll(() => {
	test.skip(
		secUserAgent === "" || edinetKey === "",
		"needs SEC_USER_AGENT and EDINET_API_KEY in the invoking environment",
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
		EDINET_API_KEY: edinetKey,
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

function settled(company: EquityCompanyView): boolean {
	const { status, phase } = company.sync;
	if (status === "failed") {
		throw new Error(
			`${company.symbol} sync failed: ${company.sync.failure?.code} (${company.sync.failure?.upstreamStatus})`,
		);
	}
	if (status !== "succeeded") return false;
	return company.provider === "sec" || phase === "idle" || phase === "forward";
}

/** Waits until every company's sync succeeded and (EDINET) left discovery and backfill. */
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
});

/** Row counts and newest write stamps of the financial tables. */
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
					        (SELECT max(recorded_at) FROM equity_reported_fact) AS newestFact`,
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

test("syncs the default US and Japanese companies from SEC and EDINET, re-syncs without writes, and shows them", async ({
	page,
}) => {
	test.setTimeout(3_600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: devEnv() });
	resources.add(async () => {
		await service.stop();
	});

	// 1. The first runner claim adds the defaults; wait for every sync.
	const deadline = Date.now() + 120_000;
	let listed: EquityCompanyView[] = [];
	while (listed.length < EQUITY_DEFAULT_STOCK_IDS.length) {
		if (Date.now() > deadline) throw new Error("the default companies were not added");
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		listed = await companies();
	}
	const ids = listed.map((c) => c.companyId);
	const synced = await waitForSyncs(ids, 3_000_000);

	// 2. Five fiscal years of all three statements, checked against identities and SEC.
	for (const company of synced) {
		const income = await statement(company.companyId, "income-statement", 5);
		const balance = await statement(company.companyId, "balance-sheet", 5);
		const cash = await statement(company.companyId, "cash-flow", 5);
		expect(income.fiscalYears.length, `${company.symbol} fiscal years`).toBe(5);
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

	// 3. Nothing new upstream: a second sync of one US and one Japanese company writes no financial row.
	const before = financialSnapshot();
	const again = synced.filter((c) => c.symbol === "AAPL" || c.symbol === "7974");
	const checkedBefore = new Map(again.map((c) => [c.companyId, c.sync.lastCheckedAt]));
	for (const company of again) {
		await api("POST", `/api/v1/equities/companies/${encodeURIComponent(company.companyId)}/sync`);
	}
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

	// 4. The Equities page reads the stored statements.
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${VITE_ORIGIN}/#/equities`);
	const shotsDir = join(REPO_ROOT, "test-results-real");
	mkdirSync(shotsDir, { recursive: true });
	for (const symbol of ["AAPL", "7974"]) {
		await page
			.getByRole("button", { name: new RegExp(`\\b${symbol}\\b`) })
			.first()
			.click();
		await expect(page.getByRole("table").first()).toBeVisible({ timeout: 60_000 });
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, `equity-sync-${symbol}.png`), fullPage: true });
	}
});
