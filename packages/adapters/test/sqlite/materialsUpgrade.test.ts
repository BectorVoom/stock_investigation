import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";
import { materialFixture } from "../../../../examples/materials/fixture.ts";

it.each([
	"legacy",
	"current",
])("repairs the %s material schema and preserves source records", async (layout) => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		const previous = migrations
			.filter((migration) => migration.name < "0017_material_series_upgrade.sql")
			.map((migration) =>
				layout === "legacy" && migration.name === "0016_material_series.sql"
					? {
							...migration,
							sql: `CREATE TABLE metal_series (owner_id TEXT NOT NULL, series_id TEXT NOT NULL, body_json TEXT NOT NULL, committed_at TEXT NOT NULL, PRIMARY KEY(owner_id, series_id)) WITHOUT ROWID;
 CREATE TRIGGER metal_series_immutable_update BEFORE UPDATE ON metal_series BEGIN SELECT RAISE(ABORT, 'immutable'); END;
 CREATE TRIGGER metal_series_immutable_delete BEFORE DELETE ON metal_series BEGIN SELECT RAISE(ABORT, 'immutable'); END;`,
						}
					: migration,
			);
		applySqlMigrations(db, previous);
		const series = materialFixture.series[0];
		if (series === undefined) throw new Error("fixture needs a series");
		if (layout === "legacy") {
			await db
				.prepare("INSERT INTO metal_series VALUES (?, ?, ?, ?)")
				.bind("owner", series.seriesId, JSON.stringify(series), "2026-01-04T00:00:00.000Z")
				.run();
		} else {
			await createSqlPersistence(db).materials.import(
				"owner",
				materialFixture,
				"2026-01-04T00:00:00.000Z",
			);
			await db
				.prepare(
					"INSERT INTO metal_observation (owner_id, series_id, observed_on, value_decimal, materials_source_updated_at) VALUES (?, ?, ?, ?, NULL)",
				)
				.bind("owner", series.seriesId, "2026-01-03", "73")
				.run();
		}
		applySqlMigrations(db, migrations);
		applySqlMigrations(db, migrations);
		const persistence = createSqlPersistence(db);
		expect(await persistence.materials.get("owner", series.seriesId)).toEqual(series);
		expect(await persistence.materials.get("other-owner", series.seriesId)).toBeNull();
		expect(
			(await persistence.market.getSeriesMeta("owner", [series.seriesId]))[0]?.lastRefreshedAt,
		).toBe("2026-01-04T00:00:00.000Z");
		const triggers = await db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'metal_%' ORDER BY name",
			)
			.all();
		expect(triggers.results).toHaveLength(4);
		expect((await persistence.materials.listCatalog("owner"))[0]?.label).toBe(series.title);
		expect((await persistence.market.getSeriesMeta("owner", [series.seriesId]))[0]?.unit).toBe(
			series.unit,
		);
		const observations = await persistence.market.getObservations("owner", [series.seriesId], 800);
		expect(observations.map((point) => point.valueDecimal)).toEqual(
			layout === "legacy" ? ["70.25", "72.5"] : ["70.25", "72.5", "73"],
		);
		expect(observations[1]?.materialsSourceUpdatedAt).toBe("2026-01-02T10:45:30.000Z");
		expect(await db.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
	} finally {
		db.close();
	}
});
