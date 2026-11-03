/**
 * Migration 0030 on an existing version-29 database: stored JPX labels
 * become `Q<quarter> <fiscal year>` like Finnhub's, keyed rows and every
 * other label stay as they were, and a second run changes nothing.
 */
import { fileURLToPath } from "node:url";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0030_jpx_quarter_labels.sql";

it("relabels stored JPX periods and leaves everything else alone", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		const before30 = migrations.filter((migration) => migration.name < MIGRATION);
		expect(before30.at(-1)?.name).toBe("0029_company_overview.sql");
		applySqlMigrations(db, before30);
		const rows: readonly (readonly [string, string, string, string | null])[] = [
			["jp:7203", "fy2027-03-31-second-quarter", "Second quarter", "2027-03-31"],
			["jp:6758", "fy2027-03-31-first-quarter", "first quarter", "2027-03-31"],
			["jp:9984", "fy2026-12-31-third-quarter", " Third quarter ", "2026-12-31"],
			["jp:2914", "fy2026-09-30-full-year", "Full year", "2026-09-30"],
			// Kept: an unknown kind, a JP row without a year end, and a US row.
			["jp:1301", "fy2027-03-31-interim", "Interim", "2027-03-31"],
			["jp:1332", "fy-unknown-second-quarter", "Second quarter", null],
			["us:AAPL", "2026-q4", "Q4 2026", null],
		];
		for (const [stockId, periodKey, label, end] of rows) {
			await db
				.prepare(
					`INSERT INTO earnings_events (owner_id, stock_id, period_key, announcement_date,
						fiscal_period_label, fiscal_period_end, timing)
					VALUES ('owner', ?, ?, '2026-11-05', ?, ?, 'unknown')`,
				)
				.bind(stockId, periodKey, label, end)
				.run();
		}
		const read = async () =>
			(
				await db
					.prepare(
						"SELECT stock_id, period_key, fiscal_period_label FROM earnings_events ORDER BY stock_id",
					)
					.all<{ stock_id: string; period_key: string; fiscal_period_label: string }>()
			).results.map((row) => [row.stock_id, row.period_key, row.fiscal_period_label]);

		applySqlMigrations(db, migrations);
		const after = await read();
		expect(after).toEqual([
			["jp:1301", "fy2027-03-31-interim", "Interim"],
			["jp:1332", "fy-unknown-second-quarter", "Second quarter"],
			["jp:2914", "fy2026-09-30-full-year", "Q4 2026"],
			["jp:6758", "fy2027-03-31-first-quarter", "Q1 2027"],
			["jp:7203", "fy2027-03-31-second-quarter", "Q2 2027"],
			["jp:9984", "fy2026-12-31-third-quarter", "Q3 2026"],
			["us:AAPL", "2026-q4", "Q4 2026"],
		]);
		// A second run is a no-op (the runner records 0030 as applied).
		applySqlMigrations(db, migrations);
		expect(await read()).toEqual(after);
	} finally {
		db.close();
	}
});
