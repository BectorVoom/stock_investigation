import { fileURLToPath } from "node:url";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0037_stock_margin_balances.sql";
const INSERT = `INSERT INTO stock_directory (owner_id, market, symbol, name, listing,
    symbol_key, name_key, local_name_key, search_key)
    VALUES ('owner', 'JP', '7203', 'Toyota', 'tse-prime', '7203', 'toyota', '', 'toyota')`;

it("preserves a populated previous directory, defaults balances to unknown and rejects invalid counts", async () => {
	const migrations = readSqlMigrations(
		fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
	);
	const db = openNodeSqlite(":memory:");
	try {
		applySqlMigrations(
			db,
			migrations.filter((migration) => migration.name < MIGRATION),
		);
		await db.prepare(INSERT).run();
		const before = await db.prepare("SELECT * FROM stock_directory").all();
		applySqlMigrations(db, migrations);
		applySqlMigrations(db, migrations);
		expect((await db.prepare("SELECT * FROM stock_directory").all()).results).toEqual(
			before.results.map((row) => ({
				...row,
				margin_buying_balance: null,
				margin_selling_balance: null,
			})),
		);
		for (const column of ["margin_buying_balance", "margin_selling_balance"]) {
			for (const value of [-1, 1.5, "invalid"]) {
				await expect(
					db.prepare(`UPDATE stock_directory SET ${column} = ?`).bind(value).run(),
				).rejects.toThrow(/CHECK constraint failed/);
			}
		}
		await db
			.prepare(
				"UPDATE stock_directory SET margin_buying_balance = 1234567890, margin_selling_balance = 0",
			)
			.run();
		expect(
			(
				await db
					.prepare("SELECT margin_buying_balance, margin_selling_balance FROM stock_directory")
					.all()
			).results,
		).toEqual([{ margin_buying_balance: 1234567890, margin_selling_balance: 0 }]);
		expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
	} finally {
		db.close();
	}
});

it("rolls back a failed second column addition without recording success or losing stocks", async () => {
	const migrations = readSqlMigrations(
		fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
	);
	const db = openNodeSqlite(":memory:");
	try {
		applySqlMigrations(
			db,
			migrations.filter((migration) => migration.name < MIGRATION),
		);
		await db.prepare(INSERT).run();
		// Simulate an incompatible installation: the second column already exists.
		await db.prepare("ALTER TABLE stock_directory ADD COLUMN margin_selling_balance INTEGER").run();
		const ledger = await db.prepare("SELECT * FROM schema_migrations").all();
		expect(() => applySqlMigrations(db, migrations)).toThrow(/duplicate column/);
		expect(
			(await db.prepare("PRAGMA table_info(stock_directory)").all()).results.map((row) => row.name),
		).not.toContain("margin_buying_balance");
		expect(await db.prepare("SELECT * FROM schema_migrations").all()).toEqual(ledger);
		expect((await db.prepare("SELECT name FROM stock_directory").all()).results).toEqual([
			{ name: "Toyota" },
		]);
	} finally {
		db.close();
	}
});
