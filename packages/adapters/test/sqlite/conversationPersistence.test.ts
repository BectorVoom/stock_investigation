import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "../../src/sql/index.ts";
import { numberColumn } from "../../src/sql/rows.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";
import { defineConversationPersistenceSuite } from "../sql/conversationPersistence.ts";

const db = openNodeSqlite(":memory:");
applySqlMigrations(
	db,
	readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
);

defineConversationPersistenceSuite(() => ({
	persistence: createSqlPersistence(db),
	count: async (table, ownerId, parentId) => {
		// Column names come from a fixed map over the allowlisted tables, never from input.
		const column = table === "claim_evidence" ? "claim_id" : "run_id";
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ? AND ${column} = ?`)
			.bind(ownerId, parentId)
			.first();
		return row === null ? 0 : numberColumn(table, "n", row);
	},
}));
