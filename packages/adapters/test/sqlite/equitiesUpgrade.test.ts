import { fileURLToPath } from "node:url";
import { randomIdGenerator, systemClock, webCryptoHasher } from "@research/adapters/runtime";
import { createSqlPersistence } from "@research/adapters/sql";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { createEquityService } from "@research/application";
import { expect, it } from "vitest";
import { equityFixture } from "../../../../examples/equities/fixture.ts";

it("upgrades a pre-equities database without changing existing rows, then accepts a catalog import", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		applySqlMigrations(
			db,
			migrations.filter((migration) => migration.name < "0014_equities.sql"),
		);
		await db
			.prepare(
				"INSERT INTO audit_log (owner_id, actor, action, resource, detail, at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(
				"upgrade-owner",
				"upgrade-owner",
				"existing.action",
				"original-record",
				"original-detail",
				"2026-01-01T00:00:00.000Z",
			)
			.run();
		const before = await db
			.prepare("SELECT * FROM audit_log WHERE owner_id = ?")
			.bind("upgrade-owner")
			.all();
		applySqlMigrations(db, migrations);
		applySqlMigrations(db, migrations);
		expect(
			await db.prepare("SELECT * FROM audit_log WHERE owner_id = ?").bind("upgrade-owner").all(),
		).toEqual(before);
		const persistence = createSqlPersistence(db);
		const service = createEquityService({
			equities: persistence.equities,
			clock: systemClock,
			ids: randomIdGenerator,
			hasher: webCryptoHasher,
		});
		const imported = await service.import(
			"upgrade-owner",
			{
				...equityFixture,
				documents: equityFixture.documents.map((document, index) => ({
					...document,
					materialsSourceUpdatedAt: index === 0 ? "2020-10-29T09:30:45.123Z" : undefined,
				})),
			},
			"upgrade_import",
		);
		expect(imported.ok).toBe(true);
		const document = equityFixture.documents[0];
		if (document === undefined) throw new Error("fixture needs a source document");
		const stored = await db
			.prepare(
				"SELECT materials_source_updated_at FROM equity_source_document WHERE owner_id = ? AND source_document_id = ?",
			)
			.bind("upgrade-owner", document.sourceDocumentId)
			.first();
		expect(stored).toEqual({ materials_source_updated_at: "2020-10-29T09:30:45.123Z" });
		for (const invalid of [
			"2026-02-30T09:30:45.000Z",
			"2026-10-29",
			"2026-10-29T09:30:45Z",
			"2026-10-29T09:30:45.000+09:00",
			"2026-10-29T24:00:00.000Z",
			"x".repeat(100),
		]) {
			await expect(
				db
					.prepare(
						"UPDATE equity_source_document SET materials_source_updated_at = ? WHERE owner_id = ? AND source_document_id = ?",
					)
					.bind(invalid, "upgrade-owner", document.sourceDocumentId)
					.run(),
			).rejects.toThrow();
		}

		expect(await persistence.equities.getVersion("upgrade-owner")).toBe(1);
		expect((await service.listIssuers("upgrade-owner", { q: "", limit: 10 })).issuers).toHaveLength(
			2,
		);
	} finally {
		db.close();
	}
});

it("leaves source timestamps unknown when upgrading existing source records", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		applySqlMigrations(
			db,
			migrations.filter((migration) => migration.name < "0015_materials_source_updated_at.sql"),
		);
		await db
			.prepare(
				"INSERT INTO equity_import VALUES ('owner', 'import', 'key', ?, '2026-01-01T00:00:00.000Z', 1, 'legacy', '{}', 2)",
			)
			.bind("a".repeat(64))
			.run();
		await db
			.prepare(
				"INSERT INTO equity_record VALUES ('owner', 'source', 'source', 'import', '{}'), ('owner', 'document', 'document', 'import', '{}')",
			)
			.run();
		await db.prepare("INSERT INTO equity_data_source VALUES ('owner', 'source')").run();
		await db
			.prepare(
				"INSERT INTO equity_source_document VALUES ('owner', 'document', 'source', NULL, '2026-01-01T00:00:00.000Z')",
			)
			.run();
		applySqlMigrations(db, migrations);
		expect(
			await db
				.prepare(
					"SELECT source_id, retrieved_at, materials_source_updated_at FROM equity_source_document",
				)
				.first(),
		).toEqual({
			source_id: "source",
			retrieved_at: "2026-01-01T00:00:00.000Z",
			materials_source_updated_at: null,
		});
	} finally {
		db.close();
	}
});
