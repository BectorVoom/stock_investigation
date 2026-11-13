/**
 * Migration 0036 on an existing version-35 database: `equity_metric_value`
 * gains `value_real` (the stored value as an IEEE-754 double, backfilled
 * from `value_decimal` — NULL without a value or beyond double range) and
 * the partial covering screening index. The rows already stored keep their
 * values; a screening can then range-filter and sort one metric of one
 * fiscal year across the companies.
 */
import { fileURLToPath } from "node:url";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0036_equity_metric_value_screening.sql";

const VALUE_ROWS = [
	// value_decimal | expected value_real
	["391035000000", 391035000000],
	["-5000000", -5000000],
	["9007199254740993", 9007199254740992], // 2^53 + 1 rounds to the nearest double
	["1e400", null], // beyond double range: NULL, row keeps its exact text
] as const;

it("backfills value_real and adds the screening index, keeping every row", async () => {
	const migrations = readSqlMigrations(
		fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
	);
	expect(migrations.some((migration) => migration.name === MIGRATION)).toBe(true);
	const before = migrations.filter((migration) => migration.name < MIGRATION);
	expect(before.at(-1)?.name).toBe("0035_sec_primary_listing_and_report_layouts.sql");
	const db = openNodeSqlite(":memory:");
	try {
		applySqlMigrations(db, before);
		await db
			.prepare(
				`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, tracked_at)
				VALUES ('owner', 'eqc_us_1', 'US', 'U00001', 'sec', '2026-01-01T00:00:00.000Z')`,
			)
			.run();
		for (const [index, [decimal]] of VALUE_ROWS.entries()) {
			await db
				.prepare(
					`INSERT INTO equity_metric_value (owner_id, company_id, metric_code, fiscal_year,
						value_decimal, currency, filing_id, concept, scope, period_end,
						derived, reported_value_count, updated_at)
					VALUES ('owner', 'eqc_us_1', ?, 2025, ?, 'USD', ?, 'concept', 'consolidated',
						'2025-12-31', 0, 1, '2026-02-01T00:00:00.000Z')`,
				)
				.bind(`metric-${index}`, decimal, `filing-${index}`)
				.run();
		}
		// A row without a value (never 0 for a missing figure).
		await db
			.prepare(
				`INSERT INTO equity_metric_value (owner_id, company_id, metric_code, fiscal_year,
					value_decimal, currency, unavailable_reason, filing_id, derived,
					reported_value_count, updated_at)
				VALUES ('owner', 'eqc_us_1', 'not-reported-metric', 2025,
					NULL, NULL, 'not-reported', NULL, 0, 0, '2026-02-01T00:00:00.000Z')`,
			)
			.run();

		applySqlMigrations(db, migrations);

		const columns = (await db.prepare("PRAGMA table_info(equity_metric_value)").all()).results.map(
			(row) => row.name,
		);
		expect(columns.at(-1)).toBe("value_real");

		const values = (
			await db
				.prepare(
					`SELECT metric_code, value_decimal, value_real FROM equity_metric_value
					ORDER BY metric_code`,
				)
				.all()
		).results;
		expect(values).toEqual([
			...VALUE_ROWS.map(([decimal, valueReal], index) => ({
				metric_code: `metric-${index}`,
				value_decimal: decimal,
				value_real: valueReal,
			})),
			{ metric_code: "not-reported-metric", value_decimal: null, value_real: null },
		]);

		const indexes = (await db.prepare("PRAGMA index_list(equity_metric_value)").all()).results.map(
			(row) => [row.name, row.partial],
		);
		expect(indexes).toContainEqual([
			"idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real",
			1,
		]);

		// The screening read runs off the index.
		const plan = (
			await db
				.prepare(
					`EXPLAIN QUERY PLAN
					SELECT emv.company_id FROM equity_metric_value AS emv
					WHERE emv.owner_id = 'owner' AND emv.metric_code = 'metric-0'
						AND emv.fiscal_year = 2025 AND emv.value_real BETWEEN 1e8 AND 1e11
					ORDER BY emv.value_real DESC, emv.company_id DESC LIMIT 50`,
				)
				.all()
		).results.map((row) => String(row.detail));
		expect(plan.join(" | ")).toContain(
			"USING COVERING INDEX idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real",
		);

		// A second run changes nothing (the runner records 0036 as applied).
		const before2 = await db.prepare("SELECT count(*) AS n FROM equity_metric_value").all();
		applySqlMigrations(db, migrations);
		expect(await db.prepare("SELECT count(*) AS n FROM equity_metric_value").all()).toEqual(
			before2,
		);
	} finally {
		db.close();
	}
});
