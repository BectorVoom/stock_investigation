import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

/** Tables of the ADR-0041 import that migration 0020 must leave untouched. */
const LEGACY_TABLES = [
	"equity_import",
	"equity_record",
	"equity_data_source",
	"equity_source_document",
] as const;

it("upgrades a version-19 database with ADR-0041 equity rows without changing them, then syncs into the new tables", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		applySqlMigrations(
			db,
			migrations.filter((migration) => migration.name < "0020_equity_financial_sync.sql"),
		);
		// An installation that imported a normalized file (ADR-0041) and has other data.
		await db
			.prepare(
				"INSERT INTO equity_import VALUES ('owner', 'import_1', 'key', ?, '2026-01-01T00:00:00.000Z', 1, 'legacy', '{}', 2)",
			)
			.bind("a".repeat(64))
			.run();
		await db
			.prepare(
				"INSERT INTO equity_record VALUES ('owner', 'source', 'source', 'import_1', '{}'), ('owner', 'document', 'document', 'import_1', '{\"v\":\"391035000000\"}')",
			)
			.run();
		await db.prepare("INSERT INTO equity_data_source VALUES ('owner', 'source')").run();
		await db
			.prepare(
				"INSERT INTO equity_source_document VALUES ('owner', 'document', 'source', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO audit_log (owner_id, actor, action, resource, detail, at) VALUES ('owner', 'owner', 'existing.action', 'r', 'd', '2026-01-01T00:00:00.000Z')",
			)
			.run();
		const snapshot = async () => {
			const tables: Record<string, readonly unknown[]> = {};
			for (const table of [...LEGACY_TABLES, "audit_log"]) {
				tables[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results;
			}
			return tables;
		};
		const before = await snapshot();
		expect(before.equity_record).toHaveLength(2);

		applySqlMigrations(db, migrations);
		applySqlMigrations(db, migrations);
		expect(await snapshot()).toEqual(before);

		// The new tables work: track, probe, read.
		const persistence = createSqlPersistence(db);
		expect(
			await persistence.equitySync.track(
				"owner",
				{
					companyId: "eqc_1",
					market: "US",
					symbol: "AAPL",
					provider: "sec",
					name: "Apple Inc.",
				},
				20,
				"2026-10-11T00:00:00.000Z",
			),
		).toEqual({ kind: "inserted" });
		expect(await persistence.equitySync.probe("owner", "2026-10-11T00:00:00.000Z")).toEqual({
			seeded: false,
			activeJob: false,
			dueCompanyId: "eqc_1",
		});
		expect(await persistence.equitySync.valueYears("owner", "eqc_1", 5)).toEqual([]);
		// The legacy rows are still there after the new tables were written.
		expect(await snapshot()).toEqual(before);
	} finally {
		db.close();
	}
});
