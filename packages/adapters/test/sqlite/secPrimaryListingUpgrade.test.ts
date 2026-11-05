import { fileURLToPath } from "node:url";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

it("retries existing SEC identity conflicts without moving identities or other schedules", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		applySqlMigrations(
			db,
			migrations.filter((m) => m.name < "0035"),
		);
		for (const [id, provider, code] of [
			["main", "sec", "FINANCIAL_IDENTITY_CONFLICT"],
			["jp", "jquants", "FINANCIAL_IDENTITY_CONFLICT"],
			["other", "sec", "FINANCIAL_SOURCE_FAILED"],
		] as const) {
			await db
				.prepare(
					"INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, tracked, tracked_at) VALUES ('owner', ?, ?, ?, ?, 1, '2026-11-01T00:00:00.000Z')",
				)
				.bind(id, provider === "sec" ? "US" : "JP", id, provider)
				.run();
			await db
				.prepare(
					"INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, failure_code) VALUES ('owner', ?, '2099-01-01T00:00:00.000Z', ?)",
				)
				.bind(id, code)
				.run();
		}
		const before = new Date().toISOString();
		applySqlMigrations(db, migrations);
		const rows = (
			await db
				.prepare(
					"SELECT company_id, next_due_at, failure_code FROM equity_sync_state ORDER BY company_id",
				)
				.all()
		).results;
		expect(String(rows.find((r) => r.company_id === "main")?.next_due_at) >= before).toBe(true);
		expect(String(rows.find((r) => r.company_id === "main")?.next_due_at) < "2099").toBe(true);
		expect(
			rows
				.filter((r) => r.company_id !== "main")
				.every((r) => r.next_due_at === "2099-01-01T00:00:00.000Z"),
		).toBe(true);
		applySqlMigrations(db, migrations);
		expect(
			(
				await db
					.prepare(
						"SELECT company_id, next_due_at, failure_code FROM equity_sync_state ORDER BY company_id",
					)
					.all()
			).results,
		).toEqual(rows);
	} finally {
		db.close();
	}
});
