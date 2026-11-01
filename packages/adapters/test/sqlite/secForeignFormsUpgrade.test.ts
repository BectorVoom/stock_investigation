/**
 * Migration 0025 (ADR-0058 §5) on a populated version-24 database: it
 * rebuilds `equity_report_filing`, its child `equity_reported_fact` and
 * `equity_business_description` to widen their `form` CHECKs, so every
 * stored row must come back unchanged, the indexes and the foreign keys must
 * hold again, and a 20-F / 40-F row must now be accepted. (The upgraded
 * schema equals `db/schema.sql`: `canonicalSchema.test.ts`.)
 */
import { fileURLToPath } from "node:url";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0025_sec_foreign_annual_forms.sql";

const TABLES = {
	filings: "SELECT * FROM equity_report_filing ORDER BY owner_id, filing_id",
	facts: "SELECT * FROM equity_reported_fact ORDER BY owner_id, filing_id, concept, period_end",
	descriptions: "SELECT * FROM equity_business_description ORDER BY owner_id, company_id",
	values: "SELECT * FROM equity_metric_value ORDER BY owner_id, company_id, metric_code",
} as const;

const FILING = `INSERT INTO equity_report_filing (owner_id, filing_id, company_id, provider,
	source_document_id, form, filed_on, submitted_at, period_start, period_end, accounting_standard,
	amends_source_document_id, source_url, facts_status, fact_count, primary_scope, first_seen_at,
	recorded_at) VALUES `;

it("rebuilds the filing and description tables with every row kept and accepts 20-F and 40-F", async () => {
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
		await run(
			`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider,
				source_company_id, name, fiscal_year_end, tracked, tracked_at)
			VALUES ('owner', 'eqc_us', 'US', 'SYND', 'sec', '0009999981', 'Synthetic Devices Inc.',
					'09-30', 1, '2026-10-11T00:00:00.000Z'),
				('owner', 'eqc_jp', 'JP', '9999', 'edinet', 'E99991', 'シンセティック工業株式会社',
					'03-31', 0, '2026-10-11T00:00:00.000Z')`,
		);
		await run(
			`${FILING}
			('owner', 'eqc_us:sec:0009999981-25-000110', 'eqc_us', 'sec', '0009999981-25-000110',
				'10-K', '2025-11-05', '2025-11-05T21:04:11.000Z', NULL, '2025-09-30', 'US-GAAP', NULL,
				'https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm',
				'extracted', 1, 'consolidated', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z'),
			('owner', 'eqc_us:sec:0009999981-26-000005', 'eqc_us', 'sec', '0009999981-26-000005',
				'10-K/A', '2026-01-15', NULL, NULL, '2025-09-30', NULL, NULL,
				'https://www.sec.gov/Archives/edgar/data/9999981/000999998126000005/',
				'pending', 0, NULL, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z'),
			('owner', 'eqc_jp:edinet:S100SY25', 'eqc_jp', 'edinet', 'S100SY25',
				'securities-report', '2025-06-20', '2025-06-20T09:00:00.000Z', '2024-04-01',
				'2025-03-31', 'JGAAP', NULL,
				'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100SY25', 'unavailable', 0, NULL,
				'2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
		);
		await run(
			`INSERT INTO equity_reported_fact (owner_id, filing_id, concept, scope, period_type,
				period_start, period_end, unit, company_id, fiscal_year, metric_code, value_decimal,
				recorded_at)
			VALUES ('owner', 'eqc_us:sec:0009999981-25-000110', 'us-gaap:Revenues', 'consolidated',
				'duration', '2024-10-01', '2025-09-30', 'USD', 'eqc_us', 2025, 'revenue',
				'391035000000', '2026-10-11T00:00:00.000Z')`,
		);
		await run(
			`INSERT INTO equity_metric_value (owner_id, company_id, metric_code, fiscal_year,
				value_decimal, currency, unavailable_reason, filing_id, concept, scope, period_start,
				period_end, derived, reported_value_count, updated_at)
			VALUES ('owner', 'eqc_us', 'revenue', 2025, '391035000000', 'USD', NULL,
				'eqc_us:sec:0009999981-25-000110', 'us-gaap:Revenues', 'consolidated', '2024-10-01',
				'2025-09-30', 0, 1, '2026-10-11T00:00:00.000Z')`,
		);
		await run(
			`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form,
				filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
			VALUES ('owner', 'eqc_us', '0009999981-25-000110', '10-K', '2025-11-05', '2025-09-30',
				'https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm',
				'extracted', '[{"kind":"text","text":"We make instruments."}]', 0,
				'2026-10-11T00:00:00.000Z')`,
		);
		// Version 24 refuses a 20-F.
		await expect(
			run(
				`${FILING} ('owner', 'eqc_us:sec:0009999983-25-000018', 'eqc_us', 'sec',
				'0009999983-25-000018', '20-F', '2025-02-27', NULL, NULL, '2024-12-31', NULL, NULL,
				'https://www.sec.gov/', 'pending', 0, NULL, '2026-10-11T00:00:00.000Z',
				'2026-10-11T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		const read = async () =>
			Object.fromEntries(
				await Promise.all(
					Object.entries(TABLES).map(
						async ([name, sql]) => [name, (await db.prepare(sql).all()).results] as const,
					),
				),
			);
		const before = await read();

		applySqlMigrations(db, migrations);
		// A second run is a no-op (the launcher applies on every start).
		applySqlMigrations(db, migrations);

		expect(await read()).toEqual(before);
		const tables = await db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_0025' ORDER BY name",
			)
			.all();
		expect(tables.results).toEqual([]);
		const indexes = await db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'index'
					AND tbl_name IN ('equity_report_filing', 'equity_reported_fact') ORDER BY name`,
			)
			.all();
		expect(indexes.results).toEqual(
			expect.arrayContaining([
				{ name: "idx_equity_report_filing__owner_id_company_id_filed_on_filing_id" },
				{
					name: "idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal",
				},
			]),
		);

		await run(
			`${FILING} ('owner', 'eqc_us:sec:0009999983-25-000018', 'eqc_us', 'sec',
			'0009999983-25-000018', '20-F', '2025-02-27', NULL, NULL, '2024-12-31', 'IFRS', NULL,
			'https://www.sec.gov/', 'pending', 0, NULL, '2026-10-11T00:00:00.000Z',
			'2026-10-11T00:00:00.000Z'),
			('owner', 'eqc_us:sec:0009999984-25-000002', 'eqc_us', 'sec',
			'0009999984-25-000002', '40-F/A', '2025-03-20', NULL, NULL, '2024-12-31', NULL, NULL,
			'https://www.sec.gov/', 'pending', 0, NULL, '2026-10-11T00:00:00.000Z',
			'2026-10-11T00:00:00.000Z')`,
		);
		await run(
			`UPDATE equity_business_description SET form = '40-F', status = 'not-found',
				paragraphs_json = '[]' WHERE company_id = 'eqc_us'`,
		);
		// The wider CHECKs still refuse anything else, and the foreign keys hold.
		await expect(
			run(
				`${FILING} ('owner', 'eqc_us:sec:x', 'eqc_us', 'sec', 'x', '10-Q', '2025-02-27', NULL,
				NULL, '2024-12-31', NULL, NULL, 'https://www.sec.gov/', 'pending', 0, NULL,
				'2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		await expect(
			run(`UPDATE equity_business_description SET form = '20-F/A' WHERE company_id = 'eqc_us'`),
		).rejects.toThrow();
		await expect(
			run(
				`INSERT INTO equity_reported_fact (owner_id, filing_id, concept, scope, period_type,
					period_start, period_end, unit, company_id, fiscal_year, metric_code, value_decimal,
					recorded_at)
				VALUES ('owner', 'eqc_us:sec:missing', 'ifrs-full:Revenue', 'consolidated', 'duration',
					'2024-01-01', '2024-12-31', 'GBP', 'eqc_us', 2024, 'revenue', '1',
					'2026-10-11T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		await expect(
			run("DELETE FROM equity_report_filing WHERE filing_id = 'eqc_us:sec:0009999981-25-000110'"),
		).rejects.toThrow();
	} finally {
		db.close();
	}
});
