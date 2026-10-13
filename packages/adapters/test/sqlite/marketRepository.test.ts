import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMarketRepository } from "../../src/sql/repositories.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * The home service maps repository rows straight to the tuple wire format:
 * it must be able to trust that `getObservations` returns the newest
 * `limitPerSeries` rows per series, ascending by date, from the SQL alone.
 * These tests pin that contract against the real migrations (including
 * 0006's index-free WITHOUT ROWID table) on `node:sqlite`; D1 runs the same
 * SQL text through the API suite.
 */
function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

async function insertObservations(
	db: ReturnType<typeof openNodeSqlite>,
	rows: readonly (readonly [string, string, number])[],
): Promise<void> {
	for (const [seriesId, observedOn, value] of rows) {
		await db
			.prepare(
				"INSERT INTO market_observations (owner_id, series_id, observed_on, value) VALUES (?, ?, ?, ?)",
			)
			.bind("owner_1", seriesId, observedOn, value)
			.run();
	}
}

describe("market repository observation order (FR-017)", () => {
	it("returns rows ascending by date however they were inserted", async () => {
		const db = openMigrated();
		try {
			await insertObservations(db, [
				["fred:VIXCLS", "2026-10-03", 15.1],
				["fred:VIXCLS", "2026-10-01", 15.3],
				["fred:VIXCLS", "2026-10-02", 15.2],
				["twelve-data:AAPL", "2026-10-02", 340.42],
				["twelve-data:AAPL", "2026-10-01", 336.67],
			]);
			const repository = createMarketRepository(db);
			const rows = await repository.getObservations(
				"owner_1",
				["fred:VIXCLS", "twelve-data:AAPL"],
				800,
			);
			expect(rows).toEqual([
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-01", value: 15.3 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-02", value: 15.2 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-03", value: 15.1 },
				{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-01", value: 336.67 },
				{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-02", value: 340.42 },
			]);
		} finally {
			db.close();
		}
	});

	it("keeps the newest limitPerSeries rows per series, still ascending", async () => {
		const db = openMigrated();
		try {
			await insertObservations(db, [
				["fred:VIXCLS", "2026-10-05", 5],
				["fred:VIXCLS", "2026-10-01", 1],
				["fred:VIXCLS", "2026-10-04", 4],
				["fred:VIXCLS", "2026-10-02", 2],
				["fred:VIXCLS", "2026-10-03", 3],
			]);
			const repository = createMarketRepository(db);
			const rows = await repository.getObservations("owner_1", ["fred:VIXCLS"], 3);
			expect(rows).toEqual([
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-03", value: 3 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-04", value: 4 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-05", value: 5 },
			]);
			expect(await repository.getObservations("owner_1", [], 3)).toEqual([]);
		} finally {
			db.close();
		}
	});
});
