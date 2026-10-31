import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

it.each([
	false,
	true,
])("initializes widget reference data with populated upgrade = %s", async (upgrade) => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		if (upgrade) {
			applySqlMigrations(
				db,
				migrations.filter((migration) => migration.name < "0018_widget_earnings_sources.sql"),
			);
			await db
				.prepare(
					"INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at) VALUES ('owner', 'us:AAPL', 'US', 'AAPL', 'Preserved company', '2026-01-01T00:00:00.000Z')",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO earnings_events VALUES ('owner', 'us:AAPL', 'q1', '2026-10-30', 'Q1', NULL, 'after-close')",
				)
				.run();
		}
		applySqlMigrations(db, migrations);
		applySqlMigrations(db, migrations);
		const persistence = createSqlPersistence(db);
		const sources = await persistence.earnings.getSources();
		expect(sources.map((source) => source.source).sort()).toEqual(["finnhub", "jpx"]);
		const home = await persistence.homeDashboard.get("owner");
		expect(home).toMatchObject({ version: 0, updatedAt: null });
		if (upgrade) {
			expect(await persistence.watchlist.getStock("owner", "us:AAPL")).toMatchObject({
				name: "Preserved company",
				addedAt: "2026-01-01T00:00:00.000Z",
			});
			expect(await persistence.earnings.getEvents("owner", ["us:AAPL"])).toMatchObject([
				{ periodKey: "q1", announcementDate: "2026-10-30" },
			]);
		}
		expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
	} finally {
		db.close();
	}
});

it("rolls back a failed reference migration and permits a clean retry", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		applySqlMigrations(
			db,
			migrations.filter((migration) => migration.name < "0018_widget_earnings_sources.sql"),
		);
		const pending = migrations.find(
			(migration) => migration.name === "0018_widget_earnings_sources.sql",
		);
		if (pending === undefined) throw new Error("missing reference migration");
		expect(() =>
			applySqlMigrations(db, [
				{ ...pending, sql: `${pending.sql}\nSELECT * FROM nonexistent_widget_table;` },
			]),
		).toThrow();
		expect(
			(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'earnings_sources'").all())
				.results,
		).toEqual([]);
		applySqlMigrations(db, migrations);
		expect(await createSqlPersistence(db).earnings.getSources()).toHaveLength(2);
	} finally {
		db.close();
	}
});
