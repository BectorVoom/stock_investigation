/**
 * The canonical schema `db/schema.sql` and the migrations in
 * `infra/migrations/` must produce the same database (docs/database/conventions.md).
 * This file proves it object by object, enforces the index naming and
 * no-redundancy rules on the final schema, checks that the 0020 index
 * migration keeps every row, and pins the query plans the indexes exist for
 * (migration 0021's upgrade is `equitySyncUpgrade.test.ts`).
 */
import { fileURLToPath } from "node:url";
import { TABLE_ALIASES, TABLE_COLUMNS } from "@research/adapters/sql";
import {
	applySqlMigrations,
	initializeSqlSchema,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
	readSqlSchema,
} from "@research/adapters/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const MIGRATIONS = readSqlMigrations(
	fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
);
const SCHEMA = readSqlSchema(fileURLToPath(new URL("../../../../db/schema.sql", import.meta.url)));

const opened: NodeSqliteDatabase[] = [];
afterEach(() => {
	for (const db of opened.splice(0)) db.close();
});

function open(): NodeSqliteDatabase {
	const db = openNodeSqlite(":memory:");
	opened.push(db);
	return db;
}

function migrated(): NodeSqliteDatabase {
	const db = open();
	applySqlMigrations(db, MIGRATIONS);
	return db;
}

function initialized(): NodeSqliteDatabase {
	const db = open();
	initializeSqlSchema(db, SCHEMA, MIGRATIONS);
	return db;
}

const objectRow = z.object({ type: z.string(), name: z.string(), tbl_name: z.string() });
const sqlRow = z.object({ sql: z.string().nullable() });
const indexRow = z.object({
	name: z.string(),
	unique: z.number(),
	origin: z.string(),
	partial: z.number(),
});
const indexColumnRow = z.object({
	name: z.string().nullable(),
	desc: z.number(),
	coll: z.string().nullable(),
	key: z.number(),
});

/** Tables owned by an engine or a migration runner, not by the application. */
const ENGINE_TABLES = new Set(["schema_migrations", "d1_migrations", "sqlite_sequence"]);

async function rows(db: NodeSqliteDatabase, sql: string, ...values: string[]) {
	return (
		await db
			.prepare(sql)
			.bind(...values)
			.all()
	).results;
}

/**
 * SQL text with comments and all whitespace removed, lowercased, and without
 * `IF NOT EXISTS`: two definitions that differ only in layout compare equal.
 * SQLite keeps the CREATE text it was given (with ALTER TABLE ADD COLUMN
 * spliced in), so CHECK expressions and column definitions are compared here.
 */
function normalizeSql(sql: string): string {
	return sql
		.replace(/--[^\n]*/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, "")
		.toLowerCase()
		.replace("ifnotexists", "");
}

interface IndexShape {
	readonly name: string;
	readonly unique: number;
	readonly origin: string;
	readonly partial: number;
	readonly columns: readonly string[];
}

async function indexesOf(db: NodeSqliteDatabase, table: string): Promise<IndexShape[]> {
	const shapes: IndexShape[] = [];
	for (const raw of await rows(db, "SELECT * FROM pragma_index_list(?)", table)) {
		const index = indexRow.parse(raw);
		const columns = (await rows(db, "SELECT * FROM pragma_index_xinfo(?)", index.name))
			.map((column) => indexColumnRow.parse(column))
			.filter((column) => column.key === 1)
			.map((column) => `${column.name ?? "<expr>"}${column.desc === 1 ? " desc" : ""}`);
		shapes.push({
			// Autoindex numbering depends on constraint order, not on meaning.
			name: index.origin === "c" ? index.name : `<${index.origin}>`,
			unique: index.unique,
			origin: index.origin,
			partial: index.partial,
			columns,
		});
	}
	return shapes.sort((a, b) =>
		`${a.name}:${a.columns.join(",")}`.localeCompare(`${b.name}:${b.columns.join(",")}`),
	);
}

/** Every application object, described so equal schemas give equal values. */
async function describeSchema(db: NodeSqliteDatabase) {
	const objects = (
		await rows(
			db,
			`SELECT ss.type, ss.name, ss.tbl_name
			FROM sqlite_schema AS ss
			WHERE ss.name NOT LIKE 'sqlite_%'
			ORDER BY ss.type, ss.name`,
		)
	)
		.map((row) => objectRow.parse(row))
		.filter((object) => !ENGINE_TABLES.has(object.tbl_name));
	const tables: Record<string, unknown> = {};
	const others: Record<string, string> = {};
	for (const object of objects) {
		const { sql } = sqlRow.parse(
			(await rows(db, "SELECT ss.sql FROM sqlite_schema AS ss WHERE ss.name = ?", object.name))[0],
		);
		if (object.type === "table") {
			tables[object.name] = {
				sql: normalizeSql(sql ?? ""),
				columns: await rows(db, "SELECT * FROM pragma_table_xinfo(?)", object.name),
				foreignKeys: await rows(db, "SELECT * FROM pragma_foreign_key_list(?)", object.name),
				options: await rows(
					db,
					"SELECT tl.wr, tl.strict FROM pragma_table_list AS tl WHERE tl.name = ?",
					object.name,
				),
				indexes: await indexesOf(db, object.name),
			};
		} else {
			others[`${object.type}:${object.name}`] = normalizeSql(sql ?? "");
		}
	}
	return { tables, others };
}

describe("canonical schema db/schema.sql", () => {
	it("initializes the same schema the migrations produce", async () => {
		expect(await describeSchema(initialized())).toEqual(await describeSchema(migrated()));
	});

	it("initializes the same reference data the migrations insert", async () => {
		const sql = `SELECT es.market, es.source, es.publisher, es.source_url
			FROM earnings_sources AS es
			ORDER BY es.market`;
		expect(await rows(initialized(), sql)).toEqual(await rows(migrated(), sql));
	});

	it("records every migration as applied, so later migrations still upgrade it", async () => {
		const db = initialized();
		const applied = (
			await rows(db, "SELECT sm.name FROM schema_migrations AS sm ORDER BY sm.name")
		).map((row) => z.object({ name: z.string() }).parse(row).name);
		expect(applied).toEqual(MIGRATIONS.map((migration) => migration.name));
		applySqlMigrations(db, MIGRATIONS);
		expect(await describeSchema(db)).toEqual(await describeSchema(migrated()));
	});

	it("refuses a database that already has schema objects, leaving it untouched", async () => {
		const db = migrated();
		const before = await describeSchema(db);
		expect(() => initializeSqlSchema(db, SCHEMA, MIGRATIONS)).toThrow(/already has schema/);
		expect(await describeSchema(db)).toEqual(before);
	});

	it("names every index idx_<table>__<columns> (uq_ when unique) and keeps none redundant", async () => {
		const db = initialized();
		const { tables } = await describeSchema(db);
		const problems: string[] = [];
		for (const table of Object.keys(tables)) {
			const indexes = await indexesOf(db, table);
			for (const index of indexes) {
				if (index.origin !== "c") continue;
				const columns = index.columns.map((column) => column.replace(/ desc$/, ""));
				const expected = `${index.unique === 1 ? "uq" : "idx"}_${table}__${columns.join("_")}`;
				if (index.name !== expected) problems.push(`${index.name} should be ${expected}`);
				const keys = columns.join(",");
				for (const other of indexes) {
					if (other === index) continue;
					const otherKeys = other.columns.map((column) => column.replace(/ desc$/, ""));
					if (`${otherKeys.join(",")},`.startsWith(`${keys},`) && index.unique === 0) {
						problems.push(`${index.name} is a prefix of ${other.name} (${otherKeys.join(", ")})`);
					}
				}
			}
		}
		expect(problems).toEqual([]);
	});
});

describe("shared SQL vocabulary (packages/adapters/src/sql/columns.ts)", () => {
	it("lists every table's columns in schema order", async () => {
		const db = initialized();
		const { tables } = await describeSchema(db);
		const actual: Record<string, string[]> = {};
		for (const table of Object.keys(tables)) {
			actual[table] = (
				await rows(db, "SELECT ti.name FROM pragma_table_info(?) AS ti ORDER BY ti.cid", table)
			).map((row) => z.object({ name: z.string() }).parse(row).name);
		}
		expect(TABLE_COLUMNS).toEqual(actual);
	});

	it("gives every table one alias, unique, short and lowercase", () => {
		const aliases = Object.values(TABLE_ALIASES);
		expect(Object.keys(TABLE_ALIASES).sort()).toEqual(Object.keys(TABLE_COLUMNS).sort());
		expect(new Set(aliases).size).toBe(aliases.length);
		for (const alias of aliases) expect(alias).toMatch(/^[a-z]{1,4}$/);
	});
});

describe("migration 0020_index_conventions.sql", () => {
	it("changes only indexes: every row survives the upgrade", async () => {
		const db = open();
		applySqlMigrations(
			db,
			MIGRATIONS.filter((migration) => migration.name < "0020_index_conventions.sql"),
		);
		const statements = [
			`INSERT INTO articles (owner_id, article_id, source_id, canonical_url, publisher, title,
				retrieved_at, content_fingerprint)
			VALUES ('o', 'a1', 's1', 'https://example.com/a1', 'p', 't', '2026-01-01T00:00:00.000Z', 'f1')`,
			`INSERT INTO audit_log (owner_id, actor, action, resource, detail, at)
			VALUES ('o', 'o', 'act', 'res', 'det', '2026-01-01T00:00:00.000Z')`,
			`INSERT INTO scheduled_tasks (owner_id, task_id, workspace_id, title, question, horizon_years,
				markets_json, schedule_json, time_zone, status, next_run_at, version, created_at, updated_at)
			VALUES ('o', 't1', 'w1', 'title', 'q', 1, '[]', '{}', 'UTC', 'active',
				'2026-01-02T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		];
		for (const statement of statements) await db.prepare(statement).run();
		const snapshot = async () => ({
			articles: await rows(db, "SELECT a.* FROM articles AS a"),
			audit: await rows(db, "SELECT al.* FROM audit_log AS al"),
			tasks: await rows(db, "SELECT st.* FROM scheduled_tasks AS st"),
		});
		const before = await snapshot();
		applySqlMigrations(db, MIGRATIONS);
		expect(await snapshot()).toEqual(before);
		expect(await describeSchema(db)).toEqual(await describeSchema(initialized()));
	});
});

describe("query plans of the indexed access paths", () => {
	async function plan(sql: string): Promise<string> {
		const db = initialized();
		return (await rows(db, `EXPLAIN QUERY PLAN ${sql}`))
			.map((row) => z.object({ detail: z.string() }).parse(row).detail)
			.join(" | ");
	}

	it("pages articles newest first straight from the index (no temporary sort)", async () => {
		const detail = await plan(
			`SELECT a.article_id
			FROM articles AS a
			WHERE a.owner_id = ?
				AND (? IS NULL OR a.source_id = ?)
				AND (? IS NULL OR (a.retrieved_at, a.article_id) < (?, ?))
			ORDER BY a.retrieved_at DESC, a.article_id DESC
			LIMIT ?`,
		);
		expect(detail).toContain("idx_articles__owner_id_retrieved_at_article_id");
		expect(detail).not.toContain("TEMP B-TREE");
	});

	it("finds the latest job of a kind through the kind index", async () => {
		const detail = await plan(
			`SELECT rj.run_id
			FROM research_jobs AS rj
			WHERE rj.owner_id = ? AND rj.kind = ? AND rj.state NOT IN ('completed', 'failed', 'cancelled')
			ORDER BY rj.created_at DESC, rj.run_id DESC
			LIMIT 1`,
		);
		expect(detail).toContain("idx_research_jobs__owner_id_kind_created_at_run_id");
		expect(detail).not.toContain("TEMP B-TREE");
	});

	it("scans due scheduled tasks in order from the due index", async () => {
		const detail = await plan(
			`SELECT st.task_id
			FROM scheduled_tasks AS st
			WHERE st.owner_id = ? AND st.next_run_at <= ? AND st.status = 'active'
			ORDER BY st.next_run_at, st.task_id
			LIMIT ?`,
		);
		expect(detail).toContain("idx_scheduled_tasks__owner_id_next_run_at_task_id");
		expect(detail).not.toContain("TEMP B-TREE");
	});

	// ADR-0048 (packages/adapters/src/sql/equitySync.ts). Without statistics
	// the planner prices `owner_id = ?` on a WITHOUT ROWID key at a few rows,
	// so it reads every fact of the owner rather than take a non-covering
	// index: these pins catch an index or query change that brings that back.
	const FACT_INDEX =
		"idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal";

	it("reads a metric-year's revisions from the covering fact index", async () => {
		const detail = await plan(
			`SELECT erp.filing_id, erp.concept, erp.scope, erp.period_type, erp.period_start,
				erp.period_end, erp.unit, erp.fiscal_year, erp.metric_code, erp.value_decimal,
				erf.filed_on AS filing_filed_on
			FROM equity_reported_fact AS erp
			JOIN equity_report_filing AS erf
				ON erf.owner_id = erp.owner_id AND erf.filing_id = erp.filing_id
			WHERE erp.owner_id = ? AND erp.company_id = ? AND erp.metric_code = ?
				AND erp.fiscal_year = ?
			ORDER BY erf.filed_on DESC, erp.filing_id DESC, erp.scope, erp.concept, erp.period_end
			LIMIT ?`,
		);
		expect(detail).toContain(
			`SEARCH erp USING COVERING INDEX ${FACT_INDEX} (owner_id=? AND company_id=? AND metric_code=? AND fiscal_year=?)`,
		);
		expect(detail).toContain("SEARCH erf USING PRIMARY KEY (owner_id=? AND filing_id=?)");
	});

	it("drives the touched-key fact read from the keys, one fact index seek per key", async () => {
		const detail = await plan(
			`SELECT erp.filing_id, erp.concept, erp.scope, erp.period_type, erp.period_start,
				erp.period_end, erp.unit, erp.fiscal_year, erp.metric_code, erp.value_decimal,
				erf.filed_on AS filing_filed_on, erf.accounting_standard AS filing_accounting_standard
			FROM json_each(?) AS touched_keys
			CROSS JOIN equity_reported_fact AS erp
				ON erp.owner_id = ?
				AND erp.company_id = ?
				AND erp.metric_code = json_extract(touched_keys.value, '$[0]')
				AND erp.fiscal_year = json_extract(touched_keys.value, '$[1]')
			JOIN equity_report_filing AS erf
				ON erf.owner_id = erp.owner_id AND erf.filing_id = erp.filing_id`,
		);
		expect(detail.startsWith("SCAN touched_keys")).toBe(true);
		expect(detail).toContain(
			`SEARCH erp USING COVERING INDEX ${FACT_INDEX} (owner_id=? AND company_id=? AND metric_code=? AND fiscal_year=?)`,
		);
	});

	it("lists a company's newest value years off the metric-value key (no temporary sort)", async () => {
		const detail = await plan(
			`SELECT DISTINCT fiscal_year
			FROM equity_metric_value
			WHERE owner_id = ? AND company_id = ? AND value_decimal IS NOT NULL
			ORDER BY fiscal_year DESC
			LIMIT ?`,
		);
		expect(detail).toContain("USING PRIMARY KEY (owner_id=? AND company_id=?)");
		expect(detail).not.toContain("TEMP B-TREE");
	});

	it("seeks each (year, metric) of a statement read on the metric-value key", async () => {
		const detail = await plan(
			`SELECT emv.metric_code, emv.fiscal_year, emv.value_decimal, erf.filed_on AS filing_filed_on
			FROM equity_metric_value AS emv
			LEFT JOIN equity_report_filing AS erf
				ON erf.owner_id = emv.owner_id AND erf.filing_id = emv.filing_id
			WHERE emv.owner_id = ? AND emv.company_id = ?
				AND emv.fiscal_year IN (SELECT years.value FROM json_each(?) AS years)
				AND emv.metric_code IN (SELECT metrics.value FROM json_each(?) AS metrics)`,
		);
		expect(detail).toContain(
			"SEARCH emv USING PRIMARY KEY (owner_id=? AND company_id=? AND fiscal_year=? AND metric_code=?)",
		);
	});

	it("lists a company's filings newest first from the filing index (no temporary sort)", async () => {
		const detail = await plan(
			`SELECT filing_id, filed_on, facts_status
			FROM equity_report_filing
			WHERE owner_id = ? AND company_id = ?
			ORDER BY filed_on DESC, filing_id DESC`,
		);
		expect(detail).toContain("idx_equity_report_filing__owner_id_company_id_filed_on_filing_id");
		expect(detail).not.toContain("TEMP B-TREE");
	});

	it("finds the due company of a claim in order from the due index", async () => {
		const detail = await plan(
			`SELECT ess.company_id
			FROM equity_sync_state AS ess
			JOIN equity_company AS eco
				ON eco.owner_id = ess.owner_id AND eco.company_id = ess.company_id
			WHERE ess.owner_id = ?
				AND ess.next_due_at IS NOT NULL
				AND ess.next_due_at <= ?
				AND eco.tracked = 1
			ORDER BY ess.next_due_at, ess.company_id
			LIMIT 1`,
		);
		expect(detail).toContain("idx_equity_sync_state__owner_id_next_due_at");
		expect(detail).not.toContain("TEMP B-TREE");
	});
});
