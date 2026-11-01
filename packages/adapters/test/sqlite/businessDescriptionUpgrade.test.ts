/**
 * Migration 0022 (ADR-0053) on an existing version-21 database: it only
 * adds `equity_business_description`, so the financial-sync rows survive
 * unchanged, a synced company reads as having no description (its next claim
 * asks for one), and the table takes a description at once. (The upgraded
 * schema equals `db/schema.sql`: `canonicalSchema.test.ts`.)
 */
import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0022_equity_business_description.sql";

it("upgrades a version-21 database with a synced company without changing its rows", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		const before22 = migrations.filter((migration) => migration.name < MIGRATION);
		expect(before22.at(-1)?.name).toBe("0021_equity_financial_sync.sql");
		applySqlMigrations(db, before22);
		// A company tracked at version 21, as its code wrote it (today's batch
		// tracking reads tables of later versions).
		await db
			.prepare(
				`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name, tracked,
					tracked_at)
				VALUES ('owner', 'eqc_1', 'US', 'AAPL', 'sec', 'Apple Inc.', 1, '2026-10-11T00:00:00.000Z')`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, sync_requested_at)
				VALUES ('owner', 'eqc_1', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
			)
			.run();
		const company = "SELECT owner_id, company_id, market, symbol, tracked FROM equity_company";
		const state = "SELECT owner_id, company_id, next_due_at FROM equity_sync_state";
		const before = [
			(await db.prepare(company).all()).results,
			(await db.prepare(state).all()).results,
		];

		applySqlMigrations(db, migrations);
		// A second run is a no-op (the runner records 0022 as applied).
		applySqlMigrations(db, migrations);
		expect([
			(await db.prepare(company).all()).results,
			(await db.prepare(state).all()).results,
		]).toEqual(before);

		const upgraded = createSqlPersistence(db).equitySync;
		expect((await upgraded.claimContext("owner", "eqc_1"))?.describedReport).toBeNull();
		const found = await upgraded.businessByListing("owner", "US", "AAPL");
		expect(found?.company.tracked).toBe(true);
		expect(found?.description).toBeNull();
		await db
			.prepare(
				`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form,
					filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
				VALUES ('owner', 'eqc_1', '0000320193-25-000079', '10-K', '2025-10-31', '2025-09-27',
					'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm',
					'not-found', '[]', 0, '2026-11-01T00:00:00.000Z')`,
			)
			.run();
		expect((await upgraded.businessByListing("owner", "US", "AAPL"))?.description?.status).toBe(
			"not-found",
		);
	} finally {
		db.close();
	}
});
