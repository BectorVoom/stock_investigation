import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applySqlMigrations,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
	type SqlMigration,
} from "../../src/sqlite/index.ts";

async function openSeeded(): Promise<NodeSqliteDatabase> {
	const db = openNodeSqlite(":memory:");
	await db.prepare("CREATE TABLE items (id TEXT PRIMARY KEY, qty INTEGER, note TEXT)").run();
	return db;
}

describe("node:sqlite driver: statement execution", () => {
	it("binds values into first/all/run", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 3, null)
				.run();
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("b", 5, "hi")
				.run();
			const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind("b").first();
			expect(row).toMatchObject({ id: "b", qty: 5, note: "hi" });
			const { results } = await db.prepare("SELECT * FROM items ORDER BY id").all();
			expect(results.map((entry) => entry.id)).toEqual(["a", "b"]);
			const missing = await db.prepare("SELECT * FROM items WHERE id = ?").bind("zzz").first();
			expect(missing).toBeNull();
		} finally {
			db.close();
		}
	});

	it("reports rows changed through meta.changes", async () => {
		const db = await openSeeded();
		try {
			const inserted = await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, null)
				.run();
			expect(inserted.meta.changes).toBe(1);
			const updated = await db.prepare("UPDATE items SET qty = ? WHERE id = ?").bind(2, "a").run();
			expect(updated.meta.changes).toBe(1);
			const missed = await db.prepare("UPDATE items SET qty = ? WHERE id = ?").bind(2, "zzz").run();
			expect(missed.meta.changes).toBe(0);
			const deleted = await db.prepare("DELETE FROM items WHERE id = ?").bind("a").run();
			expect(deleted.meta.changes).toBe(1);
		} finally {
			db.close();
		}
	});

	it("accepts SQLite's ?NNN placeholders, duplicating reused numbers", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, "x")
				.run();
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("b", 2, "y")
				.run();
			// ?2 bound once, read twice — the repository filter queries rely on this.
			const { results } = await db
				.prepare("SELECT * FROM items WHERE qty = ?1 AND (?2 IS NULL OR note = ?2)")
				.bind(1, null)
				.all();
			expect(results.map((entry) => entry.id)).toEqual(["a"]);
			const filtered = await db
				.prepare("SELECT * FROM items WHERE qty = ?1 AND (?2 IS NULL OR note = ?2)")
				.bind(2, "zzz")
				.all();
			expect(filtered.results).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("reads rows through INSERT ... RETURNING inside a batch", async () => {
		const db = await openSeeded();
		try {
			const [counted] = await db.batch([
				db
					.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?) RETURNING qty")
					.bind("a", 4, null),
			]);
			expect(counted?.results[0]).toMatchObject({ qty: 4 });
			expect(counted?.meta.changes).toBe(1);
		} finally {
			db.close();
		}
	});

	it("keeps rows of batched SELECTs, like D1's batch does", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, null)
				.run();
			// The record resolvers batch several SELECTs and read each result's rows.
			const [first, second] = await db.batch([
				db.prepare("SELECT id, qty FROM items WHERE id = ?").bind("a"),
				db.prepare("SELECT id FROM items WHERE id = ?").bind("missing"),
			]);
			expect(first?.results).toEqual([{ id: "a", qty: 1 }]);
			expect(second?.results).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe("node:sqlite driver: statement classification (A2-1)", () => {
	it("keeps rows of a SELECT behind a leading block comment", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, null)
				.run();
			const [result] = await db.batch([db.prepare("/* resolve records */ SELECT * FROM items")]);
			expect(result?.results).toEqual([{ id: "a", qty: 1, note: null }]);
			expect(result?.meta.changes).toBe(0);
		} finally {
			db.close();
		}
	});

	it("keeps rows of a SELECT behind leading line and block comments", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, null)
				.run();
			const [result] = await db.batch([db.prepare("-- c\n/* c */ SELECT id FROM items")]);
			expect(result?.results).toEqual([{ id: "a" }]);
			expect(result?.meta.changes).toBe(0);
		} finally {
			db.close();
		}
	});

	it("reports SQLite change counts for WITH ... UPDATE", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, null)
				.run();
			const updated = await db
				.prepare(
					"WITH chosen AS (SELECT 'a' AS id) UPDATE items SET qty = 2 WHERE id IN (SELECT id FROM chosen)",
				)
				.run();
			expect(updated.meta.changes).toBe(1);
			const row = await db.prepare("SELECT qty FROM items WHERE id = ?").bind("a").first();
			expect(row).toMatchObject({ qty: 2 });
			const missed = await db
				.prepare(
					"WITH chosen AS (SELECT 'missing' AS id) UPDATE items SET qty = 3 WHERE id IN (SELECT id FROM chosen)",
				)
				.run();
			expect(missed.meta.changes).toBe(0);
		} finally {
			db.close();
		}
	});

	it("reads rows through WITH ... INSERT ... RETURNING inside a batch", async () => {
		const db = await openSeeded();
		try {
			const [inserted] = await db.batch([
				db
					.prepare(
						"WITH seed AS (SELECT 'a' AS id) INSERT INTO items (id, qty, note) SELECT id, 4, NULL FROM seed RETURNING qty",
					)
					.bind(),
			]);
			expect(inserted?.results).toEqual([{ qty: 4 }]);
			expect(inserted?.meta.changes).toBe(1);
		} finally {
			db.close();
		}
	});

	it("reports SQLite change counts for WITH ... DELETE", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, null)
				.run();
			const deleted = await db
				.prepare(
					"WITH gone AS (SELECT 'a' AS id) DELETE FROM items WHERE id IN (SELECT id FROM gone)",
				)
				.run();
			expect(deleted.meta.changes).toBe(1);
		} finally {
			db.close();
		}
	});

	it("keeps rows of WITH ... SELECT, VALUES and EXPLAIN inside a batch", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("a", 1, null)
				.run();
			const [cte, values, explained] = await db.batch([
				db.prepare("WITH one AS (SELECT 1 AS n) SELECT n FROM one"),
				db.prepare("VALUES (1), (2)"),
				db.prepare("EXPLAIN SELECT 1"),
			]);
			expect(cte?.results).toEqual([{ n: 1 }]);
			expect(values?.results).toEqual([{ column1: 1 }, { column1: 2 }]);
			expect(values?.meta.changes).toBe(0);
			expect(explained?.results.length).toBeGreaterThan(0);
			expect(explained?.meta.changes).toBe(0);
		} finally {
			db.close();
		}
	});

	it("refuses a comment-only statement with a clear error", () => {
		const db = openNodeSqlite(":memory:");
		try {
			expect(() => db.prepare("-- just a comment")).toThrow(/no executable SQL/);
			expect(() => db.prepare("/* nothing here */")).toThrow(/no executable SQL/);
		} finally {
			db.close();
		}
	});
});

describe("node:sqlite driver: SQLite literal rules (A2-2)", () => {
	it("treats a backslash as ordinary text inside a string literal", async () => {
		const db = await openSeeded();
		try {
			const row = await db.prepare("SELECT 'a\\' AS prefix, ?1 AS x, ?1 AS y").bind(7).first();
			expect(row).toEqual({ prefix: "a\\", x: 7, y: 7 });
		} finally {
			db.close();
		}
	});

	it("treats a doubled quote as the escape inside string literals", async () => {
		const db = await openSeeded();
		try {
			const row = await db.prepare("SELECT 'it''s' AS text, ?1 AS x").bind(3).first();
			expect(row).toEqual({ text: "it's", x: 3 });
		} finally {
			db.close();
		}
	});

	it("ignores placeholders inside strings, quoted identifiers and comments", async () => {
		const db = await openSeeded();
		try {
			const inString = await db.prepare("SELECT '?1' AS text, ?1 AS x").bind(9).first();
			expect(inString).toEqual({ text: "?1", x: 9 });
			const inIdent = await db.prepare('SELECT 1 AS "we""ird", ?1 AS x').bind(4).first();
			expect(inIdent).toEqual({ 'we"ird': 1, x: 4 });
			const inBacktick = await db.prepare("SELECT 1 AS `q``u`, ?1 AS x").bind(5).first();
			expect(inBacktick).toEqual({ "q`u": 1, x: 5 });
			const inBrackets = await db.prepare("SELECT 1 AS [weird col], ?1 AS x").bind(6).first();
			expect(inBrackets).toEqual({ "weird col": 1, x: 6 });
			const inLineComment = await db
				.prepare("SELECT ?1 AS x -- ?2 is not a placeholder")
				.bind(7)
				.first();
			expect(inLineComment).toEqual({ x: 7 });
			const inBlockComment = await db.prepare("SELECT /* ?1 */ ?1 AS x").bind(8).first();
			expect(inBlockComment).toEqual({ x: 8 });
		} finally {
			db.close();
		}
	});
});

describe("node:sqlite driver: batch atomicity", () => {
	it("commits every statement together", async () => {
		const db = await openSeeded();
		try {
			const results = await db.batch([
				db.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)").bind("a", 1, null),
				db.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)").bind("b", 2, null),
			]);
			expect(results.map((result) => result.meta.changes)).toEqual([1, 1]);
			const { results: rows } = await db.prepare("SELECT id FROM items ORDER BY id").all();
			expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
		} finally {
			db.close();
		}
	});

	it("rolls back the first statement when the second fails", async () => {
		const db = await openSeeded();
		try {
			await db
				.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)")
				.bind("kept", 1, null)
				.run();
			await expect(
				db.batch([
					db.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)").bind("lost", 2, null),
					db.prepare("INSERT INTO items (id, qty, note) VALUES (?, ?, ?)").bind("kept", 3, null),
				]),
			).rejects.toThrow();
			const { results } = await db.prepare("SELECT id FROM items ORDER BY id").all();
			// The batch's first insert was rolled back; the earlier commit is untouched.
			expect(results.map((row) => row.id)).toEqual(["kept"]);
		} finally {
			db.close();
		}
	});

	it("rejects statements from another database", async () => {
		const first = await openSeeded();
		const second = await openSeeded();
		try {
			const foreign = second.prepare("SELECT 1 AS one");
			await expect(first.batch([foreign])).rejects.toThrow(/another database/);
		} finally {
			first.close();
			second.close();
		}
	});
});

describe("node:sqlite driver: migrations", () => {
	const MIGRATIONS: readonly SqlMigration[] = [
		{ name: "0001_a.sql", sql: "CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER);" },
		{
			name: "0002_b.sql",
			sql: "ALTER TABLE t ADD COLUMN label TEXT; INSERT INTO t (id, v) VALUES ('seed', 1);",
		},
	];

	it("applies pending migrations in name order, then ignores them on re-apply", async () => {
		const db = openNodeSqlite(":memory:");
		try {
			applySqlMigrations(db, [...MIGRATIONS].reverse());
			const first = await db.prepare("SELECT id, v, label FROM t").all();
			expect(first.results).toEqual([{ id: "seed", v: 1, label: null }]);
			applySqlMigrations(db, MIGRATIONS);
			const second = await db.prepare("SELECT id, v, label FROM t").all();
			// Idempotent: the seed row was inserted exactly once.
			expect(second.results).toEqual([{ id: "seed", v: 1, label: null }]);
			const applied = await db.prepare("SELECT name FROM schema_migrations ORDER BY name").all();
			expect(applied.results).toEqual([{ name: "0001_a.sql" }, { name: "0002_b.sql" }]);
		} finally {
			db.close();
		}
	});

	it("rolls back a migration whose second statement fails", async () => {
		const db = openNodeSqlite(":memory:");
		try {
			expect(() =>
				applySqlMigrations(db, [
					{
						name: "0001_bad.sql",
						sql: "CREATE TABLE t (id TEXT); INSERT INTO missing VALUES (1);",
					},
				]),
			).toThrow();
			const applied = await db.prepare("SELECT name FROM schema_migrations").all();
			expect(applied.results).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("applies the real production migrations cleanly", async () => {
		const db = openNodeSqlite(":memory:");
		try {
			const migrations = readSqlMigrations(
				fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
			);
			expect(migrations.length).toBeGreaterThan(0);
			applySqlMigrations(db, migrations);
			applySqlMigrations(db, migrations);
			const tables = await db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all();
			expect(tables.results.map((row) => row.name)).toEqual(
				expect.arrayContaining(["research_jobs", "workspaces", "schema_migrations"]),
			);
		} finally {
			db.close();
		}
	});

	it("reads migration files in sorted order", () => {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		const names = migrations.map((migration) => migration.name);
		expect(names).toEqual([...names].sort());
		for (const migration of migrations) {
			expect(migration.sql.length).toBeGreaterThan(0);
		}
	});
});
