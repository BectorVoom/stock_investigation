/**
 * Migration 0021 (ADR-0048) on an existing version-20 database: it only adds
 * the seven financial-sync tables, so every stored row — the ADR-0041
 * import's `equity_*` ledger rows included — survives unchanged, and the new
 * tables work at once. (The upgraded schema equals `db/schema.sql`:
 * `canonicalSchema.test.ts`.)
 */
import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import {
	applySqlMigrations,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
} from "@research/adapters/sqlite";
import { expect, it } from "vitest";
import { z } from "zod";

const MIGRATION = "0021_equity_financial_sync.sql";

/**
 * Tables with rows before the upgrade, each with its full column list in
 * schema order (no `SELECT *`): the ADR-0041 import tables that 0021 must
 * leave untouched, and tables of other features.
 */
const SNAPSHOT_TABLES = {
	equity_import:
		"owner_id, import_id, idempotency_key, content_sha256, committed_at, commit_sequence, coverage_note, payload_json, record_count",
	equity_record: "owner_id, record_id, record_type, import_id, body_json",
	equity_data_source: "owner_id, source_id",
	equity_source_document:
		"owner_id, source_document_id, source_id, published_at, retrieved_at, materials_source_updated_at",
	audit_log: "audit_id, owner_id, actor, action, resource, detail, at",
	watchlist_stocks:
		"owner_id, stock_id, market, symbol, name, added_at, last_refreshed_at, retrieved_at, unavailable_code, unavailable_upstream_status",
} as const;

const NEW_TABLES = [
	"equity_company",
	"equity_report_filing",
	"equity_reported_fact",
	"equity_metric_value",
	"equity_sync_state",
	"equity_edinet_scanned_day",
	"equity_sync_meta",
] as const;

async function seedVersion20(db: NodeSqliteDatabase): Promise<void> {
	const statements = [
		// An installation that imported a normalized file (ADR-0041) and has other data.
		`INSERT INTO equity_import (owner_id, import_id, idempotency_key, content_sha256, committed_at,
			commit_sequence, coverage_note, payload_json, record_count)
		VALUES ('owner', 'import_1', 'key', '${"a".repeat(64)}', '2026-01-01T00:00:00.000Z', 1, 'legacy', '{}', 2)`,
		`INSERT INTO equity_record (owner_id, record_id, record_type, import_id, body_json)
		VALUES ('owner', 'source', 'source', 'import_1', '{}'),
			('owner', 'document', 'document', 'import_1', '{"v":"391035000000"}')`,
		"INSERT INTO equity_data_source (owner_id, source_id) VALUES ('owner', 'source')",
		`INSERT INTO equity_source_document (owner_id, source_document_id, source_id, published_at,
			retrieved_at, materials_source_updated_at)
		VALUES ('owner', 'document', 'source', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO audit_log (owner_id, actor, action, resource, detail, at)
		VALUES ('owner', 'owner', 'existing.action', 'r', 'd', '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
		VALUES ('owner', 'stock_1', 'US', 'AAPL', 'Apple Inc.', '2026-01-01T00:00:00.000Z')`,
	];
	for (const statement of statements) await db.prepare(statement).run();
}

async function snapshot(db: NodeSqliteDatabase): Promise<Record<string, readonly unknown[]>> {
	const tables: Record<string, readonly unknown[]> = {};
	for (const [table, columns] of Object.entries(SNAPSHOT_TABLES)) {
		tables[table] = (
			await db.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1, 2`).all()
		).results;
	}
	return tables;
}

async function rowCount(db: NodeSqliteDatabase, table: string): Promise<number> {
	const row = await db.prepare(`SELECT count(*) AS row_count FROM ${table}`).first();
	return z.object({ row_count: z.number() }).parse(row).row_count;
}

it("upgrades a version-20 database with ADR-0041 equity rows without changing them, then syncs into the new tables", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		const before21 = migrations.filter((migration) => migration.name < MIGRATION);
		// The database the upgrade starts from is exactly version 20.
		expect(before21.at(-1)?.name).toBe("0020_index_conventions.sql");
		applySqlMigrations(db, before21);
		await seedVersion20(db);
		const before = await snapshot(db);
		expect(before.equity_record).toHaveLength(2);

		applySqlMigrations(db, migrations);
		// A second run is a no-op (the runner records 0021 as applied).
		applySqlMigrations(db, migrations);
		expect(await snapshot(db)).toEqual(before);
		for (const table of NEW_TABLES) expect(await rowCount(db, table)).toBe(0);

		// The new tables work: track, probe, request a sync, record a failure, read.
		const persistence = createSqlPersistence(db);
		const sync = persistence.equitySync;
		expect(
			await sync.track(
				"owner",
				{ companyId: "eqc_1", market: "US", symbol: "AAPL", provider: "sec", name: "Apple Inc." },
				20,
				"2026-10-11T00:00:00.000Z",
			),
		).toEqual({ kind: "inserted" });
		expect(await sync.probe("owner", "2026-10-11T00:00:00.000Z")).toEqual({
			seeded: false,
			activeJob: false,
			dueCompanyId: "eqc_1",
		});
		expect(await sync.requestSync("owner", "eqc_1", "2026-10-12T00:00:00.000Z")).toBe(true);
		await sync.recordFailure("owner", {
			kind: "failed",
			companyId: "eqc_1",
			failureCode: "FINANCIAL_RATE_LIMITED",
			failureUpstreamStatus: 429,
			consecutiveFailures: 1,
			nextDueAt: "2026-10-13T00:00:00.000Z",
			schedule: { jobCreatedAt: "2026-10-12T00:00:00.000Z" },
			at: "2026-10-12T00:00:00.000Z",
		});
		const [summary] = await sync.listSummaries("owner", { companyId: null });
		expect(summary?.company.symbol).toBe("AAPL");
		expect(summary?.state.failureCode).toBe("FINANCIAL_RATE_LIMITED");
		expect(summary?.state.failureUpstreamStatus).toBe(429);
		expect(summary?.state.nextDueAt).toBe("2026-10-13T00:00:00.000Z");
		expect(summary?.filingCount).toBe(0);
		expect(summary?.latestFiscalYear).toBeNull();
		expect(await sync.valueYears("owner", "eqc_1", 5)).toEqual([]);
		expect(await sync.revisions("owner", "eqc_1", "revenue", 2025, 10)).toEqual([]);
		// The legacy rows are still there after the new tables were written.
		expect(await snapshot(db)).toEqual(before);
	} finally {
		db.close();
	}
});
