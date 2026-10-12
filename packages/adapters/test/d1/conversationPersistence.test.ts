import { applyD1Migrations, env } from "cloudflare:test";
import { createD1Adapters } from "../../src/d1/index.ts";
import { numberColumn } from "../../src/sql/rows.ts";
import { defineConversationPersistenceSuite } from "../sql/conversationPersistence.ts";

// The test database and migrations without naming the engine types (which may
// only appear in the D1 binding itself): both are derived from the signatures
// that consume them.
type TestDatabase = Parameters<typeof createD1Adapters>[0];
type TestMigrations = Parameters<typeof applyD1Migrations>[1];
const testEnv = env as unknown as { DB: TestDatabase; TEST_MIGRATIONS: TestMigrations };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

defineConversationPersistenceSuite(() => ({
	persistence: createD1Adapters(testEnv.DB),
	count: async (table, ownerId, parentId) => {
		// Column names come from a fixed map over the allowlisted tables, never from input.
		const column = table === "claim_evidence" ? "claim_id" : "run_id";
		const row = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ? AND ${column} = ?`,
		)
			.bind(ownerId, parentId)
			.first();
		return row === null ? 0 : numberColumn(table, "n", row);
	},
}));
