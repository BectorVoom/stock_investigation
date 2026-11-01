import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0023_market_observation_bars.sql";

function migrations() {
	return readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)));
}

/**
 * ADR-0056 §3: a populated version-22 database upgrades to 23 with every
 * stored value intact and no bar (nothing fabricated), and every Twelve Data
 * series loses its history stamp so its next sync is a full fetch that
 * stores the bars; a FRED series keeps its stamp.
 */
it("upgrades a populated version-22 market store: values kept, bars null, Twelve Data stamps cleared", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const all = migrations();
		expect(all.some((migration) => migration.name === MIGRATION)).toBe(true);
		applySqlMigrations(
			db,
			all.filter((migration) => migration.name < MIGRATION),
		);
		await db
			.prepare(
				`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
					publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code,
					unavailable_upstream_status, history_checked_at)
				VALUES
					('owner', 'fred:VIXCLS', 'fred', 'VIXCLS', 'CBOE Volatility Index', 'Index',
						'daily', 'FRED', 'https://fred.stlouisfed.org/series/VIXCLS',
						'2026-10-30T09:00:00.000Z', '2026-10-30T09:00:00.000Z', NULL, NULL,
						'2026-10-29T09:00:00.000Z'),
					('owner', 'twelve-data:AAPL', 'twelve-data', 'AAPL', 'Apple Inc.', 'USD',
						'daily', 'Twelve Data', 'https://twelvedata.com/',
						'2026-10-30T09:00:00.000Z', '2026-10-30T09:00:00.000Z', NULL, NULL,
						'2026-10-29T09:00:00.000Z')`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
				VALUES ('owner', 'fred:VIXCLS', '2026-10-28', 16.25), ('owner', 'twelve-data:AAPL', '2026-10-29', 227.5)`,
			)
			.run();

		applySqlMigrations(db, all);
		// Applying again is a no-op (the launcher applies on every start).
		applySqlMigrations(db, all);

		const persistence = createSqlPersistence(db);
		expect(
			await persistence.market.getObservations("owner", ["fred:VIXCLS", "twelve-data:AAPL"], 800),
		).toEqual([
			{ seriesId: "fred:VIXCLS", observedOn: "2026-10-28", value: 16.25 },
			{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-29", value: 227.5 },
		]);
		const stored = await db
			.prepare(
				`SELECT series_id, open_value, high_value, low_value, volume
				FROM market_observations
				WHERE owner_id = 'owner'
				ORDER BY series_id`,
			)
			.all();
		expect(stored.results).toEqual([
			{
				series_id: "fred:VIXCLS",
				open_value: null,
				high_value: null,
				low_value: null,
				volume: null,
			},
			{
				series_id: "twelve-data:AAPL",
				open_value: null,
				high_value: null,
				low_value: null,
				volume: null,
			},
		]);
		const state = await persistence.market.getRefreshState("owner", [
			"fred:VIXCLS",
			"twelve-data:AAPL",
		]);
		expect(state.get("fred:VIXCLS")?.historyCheckedAt).toBe("2026-10-29T09:00:00.000Z");
		expect(state.get("twelve-data:AAPL")?.historyCheckedAt).toBeNull();
	} finally {
		db.close();
	}
});

/** ADR-0056 §3: the bar invariants are the database's, not only the write path's. */
it("refuses a partial bar, a volume without a bar and a negative volume", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		applySqlMigrations(db, migrations());
		const insert = (
			open: number | null,
			high: number | null,
			low: number | null,
			volume: number | null,
		) =>
			db
				.prepare(
					`INSERT INTO market_observations
						(owner_id, series_id, observed_on, value, open_value, high_value, low_value, volume)
					VALUES ('owner', 'twelve-data:AAPL', '2026-10-29', 10, ?, ?, ?, ?)`,
				)
				.bind(open, high, low, volume)
				.run();
		await expect(insert(10, null, 9, 100)).rejects.toThrow(/CHECK constraint failed/);
		await expect(insert(null, null, null, 100)).rejects.toThrow(/CHECK constraint failed/);
		await expect(insert(10, 11, 9, -1)).rejects.toThrow(/CHECK constraint failed/);
		await insert(10, 11, 9, null);
		await db.prepare("DELETE FROM market_observations WHERE owner_id = 'owner'").run();
		await insert(10, 11, 9, 0);
		await db.prepare("DELETE FROM market_observations WHERE owner_id = 'owner'").run();
		await insert(null, null, null, null);
	} finally {
		db.close();
	}
});

/**
 * A stored bar that no longer fits its close (a rollback runner revised the
 * close and kept the old bar) is read as the close alone: every response
 * schema refuses an inconsistent bar, so returning it would fail the whole
 * Home, Notebook or Stocks read (ADR-0056 §2's "drop the bar, keep the close").
 */
it("reads a stored bar that no longer fits its close as the close alone", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		applySqlMigrations(db, migrations());
		await db
			.prepare(
				`INSERT INTO market_observations (owner_id, series_id, observed_on, value,
					open_value, high_value, low_value, volume)
				VALUES
					('owner', 'twelve-data:AAPL', '2026-10-28', 113.75, 225, 230, 224, 1000),
					('owner', 'twelve-data:AAPL', '2026-10-29', 227.5, 225, 230, 224, 2000)`,
			)
			.run();
		const persistence = createSqlPersistence(db);
		expect(await persistence.market.getObservations("owner", ["twelve-data:AAPL"], 800)).toEqual([
			{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-28", value: 113.75 },
			{
				seriesId: "twelve-data:AAPL",
				observedOn: "2026-10-29",
				value: 227.5,
				bar: [225, 230, 224, 2000],
			},
		]);
	} finally {
		db.close();
	}
});
