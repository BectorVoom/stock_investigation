/**
 * Migration 0027 (ADR-0059 §4) on a populated version-26 database holding
 * EDINET-era rows: the US rows of the six rebuilt equity sync tables come
 * back unchanged; every Japanese company moves to J-Quants with no resolved
 * identity, loses its EDINET filings, facts, values and business
 * description, and is never checked and due now — so the due probe serves
 * it before every company being refreshed; the EDINET index tables and the
 * `edinet-index` jobs are gone; `stock_company_profile` exists. (The
 * upgraded schema equals `db/schema.sql`: `canonicalSchema.test.ts`.)
 */
import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0027_jquants_financials.sql";
const OWNER = "owner";
const T0 = "2026-10-11T00:00:00.000Z";

/** The US rows the migration must keep exactly. */
const US_TABLES = {
	companies: "SELECT * FROM equity_company WHERE market = 'US' ORDER BY owner_id, company_id",
	filings: "SELECT * FROM equity_report_filing WHERE provider = 'sec' ORDER BY owner_id, filing_id",
	facts: `SELECT * FROM equity_reported_fact WHERE company_id LIKE 'eqc_us%'
		ORDER BY owner_id, filing_id, concept, period_end`,
	values: `SELECT * FROM equity_metric_value WHERE company_id LIKE 'eqc_us%'
		ORDER BY owner_id, company_id, fiscal_year, metric_code`,
	descriptions: `SELECT * FROM equity_business_description WHERE company_id LIKE 'eqc_us%'
		ORDER BY owner_id, company_id`,
	states: `SELECT owner_id, company_id, next_due_at, sync_requested_at, last_checked_at,
			last_succeeded_at, failure_code, failure_upstream_status, failure_at,
			consecutive_failures, more_pending, data_updated_at
		FROM equity_sync_state WHERE company_id LIKE 'eqc_us%' ORDER BY owner_id, company_id`,
	otherJobs: "SELECT run_id, kind FROM research_jobs WHERE kind <> 'edinet-index' ORDER BY run_id",
} as const;

const FILING = `INSERT INTO equity_report_filing (owner_id, filing_id, company_id, provider,
	source_document_id, form, filed_on, submitted_at, period_start, period_end, accounting_standard,
	amends_source_document_id, source_url, facts_status, fact_count, primary_scope, first_seen_at,
	recorded_at) VALUES `;

const FACT = `INSERT INTO equity_reported_fact (owner_id, filing_id, concept, scope, period_type,
	period_start, period_end, unit, company_id, fiscal_year, metric_code, value_decimal,
	recorded_at) VALUES `;

const VALUE = `INSERT INTO equity_metric_value (owner_id, company_id, metric_code, fiscal_year,
	value_decimal, currency, unavailable_reason, filing_id, concept, scope, period_start,
	period_end, derived, reported_value_count, updated_at) VALUES `;

const JOB = `INSERT INTO research_jobs (owner_id, run_id, kind, state, idempotency_key,
	request_fingerprint, request_json, workspace_id, usage_json, attempt, max_attempts,
	lease_generation, lease_owner_id, lease_expires_at, last_event_seq, cancel_requested,
	failure_code, approval_request_json, retry_of_run_id, verification_status, provider_model,
	provider_session_ref, completed_generation, provenance_json, version, last_mutation_id,
	created_at, updated_at) VALUES `;

function job(runId: string, kind: string, state: string, request: string | null): string {
	return `('${OWNER}', '${runId}', '${kind}', '${state}', 'k_${runId}', 'f', ${
		request === null ? "NULL" : `'${request}'`
	}, NULL, '{}', 0, 3, 0, NULL, NULL, -1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
	'm', '${T0}', '${T0}')`;
}

it("moves Japanese companies to J-Quants, never checked and due now, and keeps every US row", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		expect(migrations.some((migration) => migration.name === MIGRATION)).toBe(true);
		applySqlMigrations(
			db,
			migrations.filter((migration) => migration.name < MIGRATION),
		);
		const run = (sql: string) => db.prepare(sql).run();
		const all = async (sql: string) => (await db.prepare(sql).all()).results;

		// The JP directory (7974 and 7203 listed; 9999 left it) and the Watchlist.
		await run(
			`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
				symbol_key, name_key, local_name_key, search_key)
			VALUES ('${OWNER}', 'JP', '7974', 'Nintendo Co.,Ltd.', '任天堂', 'tse-prime', '7974',
					'nintendo', '任天堂', '7974'),
				('${OWNER}', 'JP', '7203', 'TOYOTA MOTOR CORPORATION', NULL, 'tse-prime', '7203',
					'toyota', '', '7203')`,
		);
		await run(
			`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
			VALUES ('${OWNER}', 'jp:7974', 'JP', '7974', NULL, '${T0}')`,
		);
		await run(
			`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider,
				source_company_id, name, fiscal_year_end, tracked, tracked_at)
			VALUES ('${OWNER}', 'eqc_us', 'US', 'SYND', 'sec', '0009999981', 'Synthetic Devices Inc.',
					'09-30', 1, '${T0}'),
				('${OWNER}', 'eqc_us_new', 'US', 'NEWC', 'sec', NULL, NULL, NULL, 1, '${T0}'),
				('${OWNER}', 'eqc_jp', 'JP', '7974', 'edinet', 'E02367', '任天堂株式会社', '03-31',
					1, '${T0}'),
				('${OWNER}', 'eqc_jp_quiet', 'JP', '7203', 'edinet', NULL, 'トヨタ自動車', NULL, 1,
					'${T0}'),
				('${OWNER}', 'eqc_jp_gone', 'JP', '9999', 'edinet', 'E99991', 'シンセティック工業株式会社',
					'03-31', 0, '${T0}')`,
		);
		await run(
			`${FILING}
			('${OWNER}', 'eqc_us:sec:0009999981-25-000110', 'eqc_us', 'sec', '0009999981-25-000110',
				'10-K', '2025-11-05', '2025-11-05T21:04:11.000Z', NULL, '2025-09-30', 'US-GAAP', NULL,
				'https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm',
				'extracted', 1, 'consolidated', '${T0}', '${T0}'),
			('${OWNER}', 'eqc_jp:edinet:S100W4FG', 'eqc_jp', 'edinet', 'S100W4FG',
				'securities-report', '2025-06-27', '2025-06-27T06:00:00.000Z', '2024-04-01',
				'2025-03-31', 'JGAAP', NULL,
				'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100W4FG', 'extracted', 1,
				'consolidated', '${T0}', '${T0}'),
			('${OWNER}', 'eqc_jp_gone:edinet:S100SY25', 'eqc_jp_gone', 'edinet', 'S100SY25',
				'amended-securities-report', '2025-07-20', NULL, '2024-04-01', '2025-03-31', NULL,
				'S100SY24', 'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100SY25', 'pending',
				0, NULL, '${T0}', '${T0}')`,
		);
		await run(
			`${FACT}
			('${OWNER}', 'eqc_us:sec:0009999981-25-000110', 'us-gaap:Revenues', 'consolidated',
				'duration', '2024-10-01', '2025-09-30', 'USD', 'eqc_us', 2025, 'revenue',
				'391035000000', '${T0}'),
			('${OWNER}', 'eqc_jp:edinet:S100W4FG', 'jppfs_cor:NetSales', 'consolidated', 'duration',
				'2024-04-01', '2025-03-31', 'JPY', 'eqc_jp', 2024, 'revenue', '1164922000000', '${T0}')`,
		);
		await run(
			`${VALUE}
			('${OWNER}', 'eqc_us', 'revenue', 2025, '391035000000', 'USD', NULL,
				'eqc_us:sec:0009999981-25-000110', 'us-gaap:Revenues', 'consolidated', '2024-10-01',
				'2025-09-30', 0, 1, '${T0}'),
			('${OWNER}', 'eqc_jp', 'revenue', 2024, '1164922000000', 'JPY', NULL,
				'eqc_jp:edinet:S100W4FG', 'jppfs_cor:NetSales', 'consolidated', '2024-04-01',
				'2025-03-31', 0, 1, '${T0}'),
			('${OWNER}', 'eqc_jp', 'gross-profit', 2024, NULL, NULL, 'not-reported', NULL, NULL,
				NULL, NULL, NULL, 0, 0, '${T0}')`,
		);
		await run(
			`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form,
				filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
			VALUES ('${OWNER}', 'eqc_us', '0009999981-25-000110', '10-K', '2025-11-05', '2025-09-30',
					'https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm',
					'extracted', '[{"kind":"text","text":"We make instruments."}]', 0, '${T0}'),
				('${OWNER}', 'eqc_jp', 'S100W4FG', 'securities-report', '2025-06-27', '2025-03-31',
					'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100W4FG', 'extracted',
					'[{"kind":"text","text":"ゲーム機の開発"}]', 0, '${T0}')`,
		);
		await run(
			`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, sync_requested_at,
				last_checked_at, last_succeeded_at, failure_code, failure_upstream_status, failure_at,
				consecutive_failures, more_pending, edinet_phase, data_updated_at)
			VALUES ('${OWNER}', 'eqc_us', '2026-10-01T00:00:00.000Z', NULL, '2026-09-24T00:00:00.000Z',
					'2026-09-24T00:00:00.000Z', 'FINANCIAL_RATE_LIMITED', 429,
					'2026-09-25T00:00:00.000Z', 1, 1, NULL, '${T0}'),
				('${OWNER}', 'eqc_us_new', '2098-01-01T00:00:00.000Z', '2098-01-01T00:00:00.000Z',
					NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL),
				('${OWNER}', 'eqc_jp', '2026-12-01T00:00:00.000Z', '${T0}', '2026-10-20T00:00:00.000Z',
					'2026-10-20T00:00:00.000Z', NULL, NULL, NULL, 0, 0, 'idle', '${T0}'),
				('${OWNER}', 'eqc_jp_quiet', '2026-12-01T00:00:00.000Z', NULL,
					'2026-10-20T00:00:00.000Z', NULL, 'FINANCIAL_SOURCE_NOT_CONFIGURED', NULL,
					'2026-10-20T00:00:00.000Z', 3, 0, 'not-found', NULL),
				('${OWNER}', 'eqc_jp_gone', NULL, NULL, '2026-10-20T00:00:00.000Z', NULL, NULL, NULL,
					NULL, 0, 0, 'idle', NULL)`,
		);
		await run(
			`INSERT INTO edinet_index_day (owner_id, listed_on, checked_at, document_count)
			VALUES ('${OWNER}', '2025-06-27', '${T0}', 1)`,
		);
		await run(
			`INSERT INTO edinet_document_index (owner_id, doc_id, sec_code, edinet_code, filer_name,
				doc_type_code, period_start, period_end, submitted_at, parent_doc_id, listed_on)
			VALUES ('${OWNER}', 'S100W4FG', '79740', 'E02367', '任天堂株式会社', '120', '2024-04-01',
				'2025-03-31', '2025-06-27T15:00:00+09:00', NULL, '2025-06-27')`,
		);
		await run(
			`${JOB} ${job("run_index_done", "edinet-index", "failed", null)},
			${job("run_index_pending", "edinet-index", "pending", null)},
			${job("run_fsync_jp", "financial-sync", "pending", '{"companyId":"eqc_jp"}')},
			${job("run_dir_jp", "stock-directory-refresh", "completed", '{"market":"JP"}')}`,
		);
		for (const runId of ["run_index_done", "run_fsync_jp"]) {
			await run(
				`INSERT INTO job_transitions (owner_id, run_id, from_state, to_state, lease_generation,
					actor, reason, at)
				VALUES ('${OWNER}', '${runId}', 'pending', 'failed', 0, 'runner', 'x', '${T0}')`,
			);
			await run(
				`INSERT INTO job_events (owner_id, run_id, lease_generation, seq, kind, text, at)
				VALUES ('${OWNER}', '${runId}', 0, 0, 'state', 'x', '${T0}')`,
			);
		}
		const read = async () =>
			Object.fromEntries(
				await Promise.all(
					Object.entries(US_TABLES).map(async ([name, sql]) => [name, await all(sql)] as const),
				),
			);
		const before = await read();
		const startedAt = new Date().toISOString();

		applySqlMigrations(db, migrations);
		// A second run is a no-op (the launcher applies on every start).
		applySqlMigrations(db, migrations);
		const endedAt = new Date().toISOString();

		// Every US row unchanged.
		expect(await read()).toEqual(before);

		// Japanese companies: J-Quants, no identity, named from the directory.
		expect(
			await all(
				`SELECT company_id, provider, source_company_id, name, fiscal_year_end, tracked, tracked_at
				FROM equity_company WHERE market = 'JP' ORDER BY company_id`,
			),
		).toEqual([
			{
				company_id: "eqc_jp",
				provider: "jquants",
				source_company_id: null,
				name: "任天堂",
				fiscal_year_end: null,
				tracked: 1,
				tracked_at: T0,
			},
			// Left the directory: keeps the name it had.
			{
				company_id: "eqc_jp_gone",
				provider: "jquants",
				source_company_id: null,
				name: "シンセティック工業株式会社",
				fiscal_year_end: null,
				tracked: 0,
				tracked_at: T0,
			},
			{
				company_id: "eqc_jp_quiet",
				provider: "jquants",
				source_company_id: null,
				name: "TOYOTA MOTOR CORPORATION",
				fiscal_year_end: null,
				tracked: 1,
				tracked_at: T0,
			},
		]);
		// Their EDINET filings, facts, values and descriptions are gone.
		for (const table of [
			"equity_report_filing",
			"equity_reported_fact",
			"equity_metric_value",
			"equity_business_description",
		]) {
			expect(await all(`SELECT company_id FROM ${table} WHERE company_id LIKE 'eqc_jp%'`)).toEqual(
				[],
			);
		}
		// Never checked, failure cleared, due now (the Watchlist stock a day
		// earlier), the read ETag moved; the untracked one stays off the schedule.
		const states = await all(
			`SELECT company_id, next_due_at, sync_requested_at, last_checked_at, last_succeeded_at,
				failure_code, failure_upstream_status, failure_at, consecutive_failures, more_pending,
				data_updated_at
			FROM equity_sync_state WHERE company_id LIKE 'eqc_jp%' ORDER BY company_id`,
		);
		const never = {
			sync_requested_at: null,
			last_checked_at: null,
			last_succeeded_at: null,
			failure_code: null,
			failure_upstream_status: null,
			failure_at: null,
			consecutive_failures: 0,
			more_pending: 0,
		};
		expect(states).toMatchObject([
			{ company_id: "eqc_jp", ...never },
			{ company_id: "eqc_jp_gone", ...never, next_due_at: null },
			{ company_id: "eqc_jp_quiet", ...never },
		]);
		const dayBefore = (iso: string) => new Date(Date.parse(iso) - 86_400_000).toISOString();
		const at = (companyId: string, column: string) =>
			String(states.find((row) => row.company_id === companyId)?.[column]);
		expect(at("eqc_jp_quiet", "next_due_at") >= startedAt).toBe(true);
		expect(at("eqc_jp_quiet", "next_due_at") <= endedAt).toBe(true);
		expect(at("eqc_jp", "next_due_at") >= dayBefore(startedAt)).toBe(true);
		expect(at("eqc_jp", "next_due_at") <= dayBefore(endedAt)).toBe(true);
		for (const companyId of ["eqc_jp", "eqc_jp_quiet", "eqc_jp_gone"]) {
			expect(at(companyId, "data_updated_at") >= startedAt).toBe(true);
		}

		// The EDINET index and its jobs are gone; other jobs and rows stay.
		expect(
			await all(
				"SELECT name FROM sqlite_master WHERE name LIKE 'edinet%' OR name LIKE '%_0027' ORDER BY name",
			),
		).toEqual([]);
		expect(await all("SELECT run_id FROM research_jobs ORDER BY run_id")).toEqual([
			{ run_id: "run_dir_jp" },
			{ run_id: "run_fsync_jp" },
		]);
		expect(await all("SELECT DISTINCT run_id FROM job_transitions")).toEqual([
			{ run_id: "run_fsync_jp" },
		]);
		expect(await all("SELECT DISTINCT run_id FROM job_events")).toEqual([
			{ run_id: "run_fsync_jp" },
		]);
		expect(await all("SELECT symbol FROM stock_company_profile")).toEqual([]);

		// The due probe serves the never-checked Japanese companies — the
		// Watchlist one first — before a never-checked US company due later,
		// and every never-checked one before the overdue US company being refreshed.
		const repo = createSqlPersistence(db).equitySync;
		const far = "2099-01-01T00:00:00.000Z";
		await run("DELETE FROM research_jobs WHERE run_id = 'run_fsync_jp'");
		expect((await repo.probe(OWNER, far)).dueCompanyId).toBe("eqc_jp");
		await repo.reschedule(OWNER, "eqc_jp", "2099-06-01T00:00:00.000Z");
		expect((await repo.probe(OWNER, far)).dueCompanyId).toBe("eqc_jp_quiet");
		await repo.reschedule(OWNER, "eqc_jp_quiet", "2099-06-01T00:00:00.000Z");
		expect((await repo.probe(OWNER, far)).dueCompanyId).toBe("eqc_us_new");
		await repo.reschedule(OWNER, "eqc_us_new", "2099-06-01T00:00:00.000Z");
		expect((await repo.probe(OWNER, far)).dueCompanyId).toBe("eqc_us");
		const context = await repo.claimContext(OWNER, "eqc_jp");
		expect(context?.company).toMatchObject({ provider: "jquants", sourceCompanyId: null });
		expect(context?.filings).toEqual([]);
		expect(context?.describedReport).toBeNull();

		// The rebuilt CHECKs take J-Quants and refuse EDINET; foreign keys hold.
		await run(
			`${FILING} ('${OWNER}', 'eqc_jp:jquants:20250425524716', 'eqc_jp', 'jquants',
			'20250425524716', 'earnings-report', '2025-05-08', NULL, '2024-04-01', '2025-03-31',
			'JGAAP', NULL, 'https://api.jquants.com/v2/fins/summary?code=79740&date=2025-05-08',
			'extracted', 0, 'consolidated', '${T0}', '${T0}')`,
		);
		for (const refused of [
			`${FILING} ('${OWNER}', 'eqc_jp:edinet:S100AAAA', 'eqc_jp', 'edinet', 'S100AAAA',
				'earnings-report', '2025-05-08', NULL, NULL, '2025-03-31', NULL, NULL, 'https://x.test/',
				'pending', 0, NULL, '${T0}', '${T0}')`,
			`${FILING} ('${OWNER}', 'eqc_jp:jquants:1', 'eqc_jp', 'jquants', '1',
				'securities-report', '2025-05-08', NULL, NULL, '2025-03-31', NULL, NULL,
				'https://x.test/', 'pending', 0, NULL, '${T0}', '${T0}')`,
			"UPDATE equity_company SET provider = 'edinet' WHERE company_id = 'eqc_jp'",
			`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form,
				filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
			VALUES ('${OWNER}', 'eqc_jp', 'S100W4FG', 'securities-report', '2025-06-27',
				'2025-03-31', 'https://x.test/', 'not-found', '[]', 0, '${T0}')`,
			"INSERT INTO equity_sync_state (owner_id, company_id) VALUES ('owner', 'eqc_missing')",
			"DELETE FROM equity_company WHERE company_id = 'eqc_us'",
		]) {
			await expect(run(refused)).rejects.toThrow();
		}
		const indexes = await all(
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
				AND tbl_name LIKE 'equity_%' AND tbl_name IN (
					'equity_company', 'equity_report_filing', 'equity_reported_fact',
					'equity_sync_state'
				)
			ORDER BY name`,
		);
		expect(indexes).toEqual([
			{ name: "idx_equity_report_filing__owner_id_company_id_filed_on_filing_id" },
			{
				name: "idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal",
			},
			{ name: "idx_equity_sync_state__owner_id_last_checked_at_next_due_at" },
			{ name: "idx_equity_sync_state__owner_id_next_due_at" },
			{ name: "uq_equity_company__owner_id_market_symbol" },
			{ name: "uq_equity_company__owner_id_provider_source_company_id" },
		]);
	} finally {
		db.close();
	}
});
