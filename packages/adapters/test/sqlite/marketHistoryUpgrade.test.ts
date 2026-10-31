import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0019_market_history_check.sql";

/**
 * ADR-0044: a populated version-18 database upgrades to 19 with every market
 * row intact and `history_checked_at` NULL, so each existing series' first
 * refresh after the upgrade is a full fetch (no fabricated stamp).
 */
it("upgrades a populated version-18 market store with its data intact and no history stamp", async () => {
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
		await db
			.prepare(
				`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
					publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code,
					unavailable_upstream_status)
				VALUES ('owner', 'fred:VIXCLS', 'fred', 'VIXCLS', 'CBOE Volatility Index', 'Index',
					'daily', 'FRED', 'https://fred.stlouisfed.org/series/VIXCLS',
					'2026-10-30T09:00:00.000Z', '2026-10-30T09:00:00.000Z', NULL, NULL)`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
				VALUES ('owner', 'fred:VIXCLS', '2026-10-28', 16.25), ('owner', 'fred:VIXCLS', '2026-10-29', 17.5)`,
			)
			.run();

		applySqlMigrations(db, migrations);
		// Applying again is a no-op (the launcher applies on every start).
		applySqlMigrations(db, migrations);

		const persistence = createSqlPersistence(db);
		expect(await persistence.market.getSeriesMeta("owner", ["fred:VIXCLS"])).toMatchObject([
			{
				seriesId: "fred:VIXCLS",
				title: "CBOE Volatility Index",
				lastRefreshedAt: "2026-10-30T09:00:00.000Z",
			},
		]);
		expect(await persistence.market.getObservations("owner", ["fred:VIXCLS"], 800)).toEqual([
			{ seriesId: "fred:VIXCLS", observedOn: "2026-10-28", value: 16.25 },
			{ seriesId: "fred:VIXCLS", observedOn: "2026-10-29", value: 17.5 },
		]);
		const state = await persistence.market.getRefreshState("owner", ["fred:VIXCLS"]);
		expect(state.get("fred:VIXCLS")).toEqual({
			latestObservedOn: "2026-10-29",
			lastRefreshedAt: "2026-10-30T09:00:00.000Z",
			unavailableCode: null,
			anchor: { observedOn: "2026-10-28", value: 16.25 },
			historyCheckedAt: null,
		});
	} finally {
		db.close();
	}
});
