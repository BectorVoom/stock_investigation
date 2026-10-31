/**
 * Stands in for the `cloudflare:test` module when the API suite runs outside
 * workerd (the `api-sqlite` vitest project aliases `cloudflare:test` to this
 * file). It exports the same two names the suite uses — `env` and
 * `applyD1Migrations` — backed by an in-memory `node:sqlite` database
 * initialized from the canonical schema `db/schema.sql` (ADR-0008). The
 * workerd project runs the same suite on a database built by the migrations,
 * so the API suite covers both the fresh-initialization path and the upgrade
 * path. Each test file gets a
 * fresh module graph from vitest, hence a fresh database, so files stay
 * isolated from each other; tests within a file isolate by owner id, exactly
 * as on D1.
 */
import { fileURLToPath } from "node:url";
import {
	applySqlMigrations,
	initializeSqlSchema,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
	readSqlSchema,
	type SqlMigration,
} from "@research/adapters/sqlite";

const db: NodeSqliteDatabase = openNodeSqlite(":memory:");

const TEST_MIGRATIONS: readonly SqlMigration[] = readSqlMigrations(
	fileURLToPath(new URL("../../infra/migrations", import.meta.url)),
);

initializeSqlSchema(
	db,
	readSqlSchema(fileURLToPath(new URL("../../db/schema.sql", import.meta.url))),
	TEST_MIGRATIONS,
);

export const env = { DB: db, TEST_MIGRATIONS };

/** Idempotent, like the original: applies only migrations not yet recorded. */
export function applyD1Migrations(
	database: NodeSqliteDatabase,
	migrations: readonly SqlMigration[],
): Promise<void> {
	applySqlMigrations(database, migrations);
	return Promise.resolve();
}
