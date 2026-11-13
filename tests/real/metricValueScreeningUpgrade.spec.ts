import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { equityCompanyListSchema, equityStatementResponseSchema } from "@research/contracts";
import { z } from "zod";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
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
 * Migration 0036 (screening support, `bun run test:real
 * metricValueScreeningUpgrade`) on an existing installation, through the real
 * development launcher from a pristine copy, with a populated version-35
 * database:
 *
 * 1. Phase 1 — the copy starts without `0036_equity_metric_value_screening.sql`:
 *    an empty database at schema version 35. The installation is populated
 *    with one synthetic US company ("Synthetic Upgrade Probe Co", symbol
 *    `ZZZZ`, which the SEC directory never lists, so no sync is ever queued
 *    for it) with one 10-K, two revenue facts and two stored revenue values
 *    plus one unavailable value, written directly into the throwaway dev D1
 *    exactly as the ADR-0048 sync would store them — minus `value_real`,
 *    which does not exist yet. The statement read answers the stored values.
 * 2. The 0036 migration returns; the SAME data directory starts again and the
 *    launcher applies it. The rows survive byte for byte, `value_real` is
 *    backfilled (within double range) or NULL (unavailable), the partial
 *    covering index exists and the screening query runs off it; the
 *    statements API still answers the stored values, and the Stocks page's
 *    Financial statements tab renders them (screenshot in
 *    test-results-real/).
 * 3. Fresh install (the second, separate requirement): a brand-new empty
 *    data directory starts with all migrations including 0036; the schema
 *    arrives complete (the column and the partial index are present) and the
 *    app answers on the empty database.
 *
 * All data is synthetic; no SEC/J-Quants request is made (the env file
 * carries no keys, and `ZZZZ` is not in any stored list). The launcher's
 * claim-time directory download still runs, as for every real spec.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8924;
const API_PORT = 8925;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const MIGRATION = "0036_equity_metric_value_screening.sql";
const OWNER = "owner@localhost";
const COMPANY = "eqc_metric_upgrade";
const FILING = "eqc_metric_upgrade:sec:0009999901-25-000001";
const FRESH_VITE_PORT = 8926;
const FRESH_API_PORT = 8927;

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
	dataDir = mkdtempSync(join(tmpdir(), "research-real-metric-upgrade-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-metric-upgrade-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	if (pristine === null) throw new Error("the pristine copy was not created");
	// A database at schema version 35: the copy starts without 0036 (the last
	// migration). Restored in phase 2.
	stashed = stashMigrationsFrom(
		join(pristine.root, "infra", "migrations"),
		MIGRATION,
		join(extraRoot, "migrations-stash"),
	);
	resources.add(() => stashed?.restore());
	// No keys: nothing in this spec may reach SEC or J-Quants.
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
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
		prodPort: "19024",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

function devDatabasePath(rootDir: string = dataDir): string {
	const candidates: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith(".sqlite")) candidates.push(path);
		}
	};
	walk(rootDir);
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
	throw new Error(`no D1 database with the equity tables under ${rootDir}`);
}

const columnsOf = (table: string, rootDir?: string): string[] => {
	const db = new DatabaseSync(devDatabasePath(rootDir), { readOnly: true });
	try {
		return z
			.array(z.object({ name: z.string() }))
			.parse(db.prepare(`PRAGMA table_info(${table})`).all())
			.map((row) => row.name);
	} finally {
		db.close();
	}
};

/** Seeds the v35 installation; mirrors what a `financial-synced` completion stores, minus `value_real`. */
function seedFixture(): void {
	const db = new DatabaseSync(devDatabasePath());
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		db.exec("BEGIN");
		const statements = [
			`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider,
				source_company_id, name, fiscal_year_end, tracked, tracked_at)
			VALUES ('${OWNER}', '${COMPANY}', 'US', 'ZZZZ', 'sec',
				'9999999901', 'Synthetic Upgrade Probe Co', '09-30', 1, '2026-01-01T00:00:00.000Z')`,
			`INSERT INTO equity_report_filing (owner_id, filing_id, company_id, provider,
				source_document_id, form, filed_on, submitted_at, period_start, period_end,
				accounting_standard, amends_source_document_id, source_url, facts_status,
				fact_count, primary_scope, first_seen_at, recorded_at)
			VALUES ('${OWNER}', '${FILING}', '${COMPANY}', 'sec',
				'0009999901-25-000001', '10-K', '2025-11-01', NULL, '2024-10-01', '2025-09-30',
				'US-GAAP', NULL,
				'https://www.sec.gov/Archives/edgar/data/9999999901/000999990125000001-index.htm',
				'extracted', 2, 'consolidated', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			`INSERT INTO equity_reported_fact (owner_id, filing_id, concept, scope, period_type,
				period_start, period_end, unit, company_id, fiscal_year, metric_code, value_decimal,
				recorded_at)
			VALUES
				('${OWNER}', '${FILING}', 'us-gaap:Revenues', 'consolidated', 'duration',
					'2023-10-01', '2024-09-30', 'USD', '${COMPANY}', 2024, 'revenue',
					'383285000000', '2026-01-01T00:00:00.000Z'),
				('${OWNER}', '${FILING}', 'us-gaap:Revenues', 'consolidated', 'duration',
					'2024-10-01', '2025-09-30', 'USD', '${COMPANY}', 2025, 'revenue',
					'391035000000', '2026-01-01T00:00:00.000Z')`,
			`INSERT INTO equity_metric_value (owner_id, company_id, metric_code, fiscal_year,
				value_decimal, currency, unavailable_reason, filing_id, concept, scope,
				period_start, period_end, derived, reported_value_count, updated_at)
			VALUES
				('${OWNER}', '${COMPANY}', 'revenue', 2024, '383285000000', 'USD', NULL,
					'${FILING}', 'us-gaap:Revenues', 'consolidated', '2023-10-01', '2024-09-30',
					0, 1, '2026-01-01T00:00:00.000Z'),
				('${OWNER}', '${COMPANY}', 'revenue', 2025, '391035000000', 'USD', NULL,
					'${FILING}', 'us-gaap:Revenues', 'consolidated', '2024-10-01', '2025-09-30',
					0, 1, '2026-01-01T00:00:00.000Z'),
				('${OWNER}', '${COMPANY}', 'gross-profit', 2025, NULL, NULL, 'not-reported',
					NULL, NULL, NULL, NULL, NULL, 0, 0, '2026-01-01T00:00:00.000Z')`,
			`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, sync_requested_at,
				last_checked_at, last_succeeded_at, failure_code, failure_upstream_status,
				failure_at, consecutive_failures, more_pending, data_updated_at)
			VALUES ('${OWNER}', '${COMPANY}', NULL, NULL,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
				NULL, NULL, NULL, 0, 0, '2026-01-01T00:00:00.000Z')`,
		];
		for (const statement of statements) db.exec(statement);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	} finally {
		db.close();
	}
}

const valueRows = () => {
	const hasReal = columnsOf("equity_metric_value").includes("value_real");
	const db = new DatabaseSync(devDatabasePath(), { readOnly: true });
	try {
		return z
			.array(
				z.object({
					metric_code: z.string(),
					fiscal_year: z.number(),
					value_decimal: z.string().nullable(),
					value_real: z.number().nullable().optional(),
				}),
			)
			.parse(
				db
					.prepare(
						`SELECT metric_code, fiscal_year, value_decimal${hasReal ? ", value_real" : ""}
						FROM equity_metric_value
						ORDER BY metric_code, fiscal_year`,
					)
					.all(),
			);
	} finally {
		db.close();
	}
};

const indexSql = (name: string, rootDir?: string): string | null => {
	const db = new DatabaseSync(devDatabasePath(rootDir), { readOnly: true });
	try {
		const row = db
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
			.get(name) as { sql?: string } | undefined;
		return row?.sql ?? null;
	} finally {
		db.close();
	}
};

async function api<T>(
	method: string,
	path: string,
	body?: unknown,
	origin = API_ORIGIN,
): Promise<T> {
	const response = await fetch(`${origin}${path}`, {
		method,
		headers: { ...ownerHeaders(origin) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	}
	return (text === "" ? null : JSON.parse(text)) as T;
}

const statementRevenue = async (): Promise<Record<number, string | null>> => {
	const response = equityStatementResponseSchema.parse(
		await api("GET", `/api/v1/equities/companies/${COMPANY}/statements/income-statement?years=2`),
	);
	const row = response.rows.find((entry) => entry.metric === "revenue");
	if (row === undefined) throw new Error("the revenue row is missing");
	const out: Record<number, string | null> = {};
	for (const cell of row.cells) out[cell.fiscalYear] = cell.valueDecimal;
	return out;
};

test("a version-35 installation keeps its stored values and gains the screening column and index", async ({
	page,
}) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");

	// ---- Phase 1: schema version 35 (0036 stashed out of the copy) ----
	const before = await startLauncher({ cwd: pristine.root, args: ["dev"], env: devEnv() });
	try {
		expect(columnsOf("equity_metric_value")).not.toContain("value_real");
		expect(
			indexSql("idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real"),
		).toBeNull();

		seedFixture();
		expect(await statementRevenue()).toEqual({ 2024: "383285000000", 2025: "391035000000" });
		const companies = equityCompanyListSchema.parse(await api("GET", "/api/v1/equities/companies"));
		expect(companies.companies.map((entry) => entry.companyId)).toContain(COMPANY);
	} finally {
		await before.stop();
	}

	// ---- Phase 2: 0036 returns; the same data directory starts; the launcher applies it ----
	stashed?.restore();
	const after = await startLauncher({ cwd: pristine.root, args: ["dev"], env: devEnv() });
	resources.add(async () => {
		await after.stop();
	});
	try {
		expect(columnsOf("equity_metric_value").at(-1)).toBe("value_real");
		expect(await valueRows()).toEqual([
			{ metric_code: "gross-profit", fiscal_year: 2025, value_decimal: null, value_real: null },
			{
				metric_code: "revenue",
				fiscal_year: 2024,
				value_decimal: "383285000000",
				value_real: 383285000000,
			},
			{
				metric_code: "revenue",
				fiscal_year: 2025,
				value_decimal: "391035000000",
				value_real: 391035000000,
			},
		]);
		expect(
			indexSql("idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real"),
		).toContain("WHERE value_real IS NOT NULL");
		{
			const db = new DatabaseSync(devDatabasePath(), { readOnly: true });
			try {
				const plan = z
					.array(z.object({ detail: z.string() }))
					.parse(
						db
							.prepare(
								`EXPLAIN QUERY PLAN
								SELECT emv.company_id FROM equity_metric_value AS emv
								WHERE emv.owner_id = ? AND emv.metric_code = 'revenue' AND emv.fiscal_year = 2025
									AND emv.value_real BETWEEN 1e8 AND 1e11
								ORDER BY emv.value_real DESC, emv.company_id DESC LIMIT 50`,
							)
							.all(OWNER),
					)
					.map((row) => row.detail)
					.join(" | ");
				expect(plan).toContain(
					"USING COVERING INDEX idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real",
				);
				const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
				expect(fkViolations).toEqual([]);
			} finally {
				db.close();
			}
		}

		// The app reads on the upgraded database exactly as on the seeded one.
		expect(await statementRevenue()).toEqual({ 2024: "383285000000", 2025: "391035000000" });
		const companies = equityCompanyListSchema.parse(await api("GET", "/api/v1/equities/companies"));
		expect(companies.companies.map((entry) => entry.companyId)).toContain(COMPANY);

		// The Financial statements tab renders the stored values, not an error.
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		await page.goto(`${VITE_ORIGIN}/#/stocks/us:ZZZZ/financials`);
		await expect(page.getByText("391,035").first()).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("383,285").first()).toBeVisible({ timeout: 60_000 });
		await page.screenshot({ path: "test-results-real/metric-value-screening-upgrade.png" });
		expect(pageErrors).toEqual([]);
	} finally {
		await after.stop();
	}
});

test("a fresh installation receives 0036 with everything else", async ({ page }) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const freshData = mkdtempSync(join(tmpdir(), "research-real-metric-fresh-data-"));
	resources.add(() => rmSync(freshData, { recursive: true, force: true }));
	const freshExtra = mkdtempSync(join(tmpdir(), "research-real-metric-fresh-extra-"));
	resources.add(() => rmSync(freshExtra, { recursive: true, force: true }));
	const freshRunnerEnvFile = writeTestRunnerEnvFile(freshExtra, {});
	const env = launcherEnv({
		dataDir: join(freshExtra, "prod-data"),
		devDataDir: freshData,
		releaseDir: join(freshExtra, "release"),
		previousDir: join(freshExtra, "release.previous"),
		runnerEnvFile: freshRunnerEnvFile,
		scratchRoot: join(freshExtra, "scratch"),
		webOutDir: join(freshExtra, "web-out"),
		prodPort: "19026",
		devPort: String(FRESH_VITE_PORT),
		devApiPort: String(FRESH_API_PORT),
	});
	const freshOrigin = `http://localhost:${FRESH_API_PORT}`;

	const fresh = await startLauncher({ cwd: pristine.root, args: ["dev"], env });
	try {
		expect(columnsOf("equity_metric_value", freshData).at(-1)).toBe("value_real");
		expect(
			indexSql("idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real", freshData),
		).toContain("WHERE value_real IS NOT NULL");

		const companies = equityCompanyListSchema.parse(
			await api("GET", "/api/v1/equities/companies", undefined, freshOrigin),
		);
		expect(companies.companies).toEqual([]);

		const pageErrors: unknown[] = [];
		page.on("pageerror", (error) => pageErrors.push(error));
		// The page must load on a database that only 0036 just created objects in;
		// a failed /api read would surface as an error state, not a page error,
		// so the heading is asserted too.
		await page.goto(`http://localhost:${FRESH_VITE_PORT}/#/stocks`);
		await expect(page.getByRole("heading", { level: 2, name: "Stocks" })).toBeVisible({
			timeout: 60_000,
		});
		expect(pageErrors).toEqual([]);
	} finally {
		await fresh.stop();
	}
});
