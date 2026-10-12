/**
 * Node-only SQLite driver for the narrow `SqlDatabase` contract, built on the
 * `node:sqlite` module (no npm dependency). This is the portability proof for
 * ADR-0008 — the whole API suite runs against it — not a supported
 * production store. It stays importable only from Node: `src/sqlite` is a
 * Node-only adapter directory in `tests/architecture/boundaryRules.ts`, and
 * only the Node adapters tsconfig includes it.
 *
 * Three dialect gaps are contained here so the SQL text stays frozen:
 * `?NNN` placeholders (rewritten to positional, values duplicated for reused
 * numbers), `RETURNING` row visibility (rows are read through `all()`), and
 * batched-`SELECT` rows (also read through `all()`, like D1's batch). The
 * query/write split those paths need is decided by parsing the statement —
 * the installed `node:sqlite` exposes no read-only/columns introspection on a
 * prepared statement — with SQLite's real literal rules (see `prepareQuery`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
	SqlAllResult,
	SqlBatchResult,
	SqlDatabase,
	SqlRow,
	SqlRunResult,
	SqlStatement,
	SqlValue,
} from "../sql/database.ts";

export interface SqlMigration {
	readonly name: string;
	readonly sql: string;
}

interface PreparedQuery {
	/** The SQL with every `?N` rewritten to a positional `?`. */
	readonly text: string;
	/**
	 * One entry per positional placeholder: the 1-based number it had.
	 * Empty when the statement used bare `?` throughout (or has none).
	 */
	readonly order: readonly number[];
	/** True when the statement ends in a `RETURNING` clause. */
	readonly returnsRows: boolean;
	/** True when executing the statement yields rows (a query or `... RETURNING`). */
	readonly producesRows: boolean;
}

/**
 * WHY this rewrite lives here instead of in the repositories: `node:sqlite`
 * rejects SQLite's `?NNN` numbered placeholders ("column index out of range"),
 * while D1 accepts them — yet three repository statements reuse a number
 * (`?2 ... ?2`) to bind one value twice, which positional `?` cannot express
 * without duplicating the value. The SQL text is frozen (it is the portable
 * dialect both engines share), so the driver maps each `?N` occurrence to the
 * Nth bound value, duplicating values for reused numbers. Statements using
 * only bare `?` pass through untouched. A statement mixing bare `?` with
 * `?N` is rejected: its numbering would be ambiguous without full SQLite
 * parameter-numbering rules.
 *
 * Literal rules are SQLite's real ones: inside `'...'` a quote is escaped by
 * doubling it (`''`) and a backslash is ordinary text (there are no backslash
 * escapes); the same doubling applies inside `"..."` and `` `...` ``, while a
 * `[bracket]` identifier ends at the first `]`. Placeholders, the `RETURNING`
 * detector and the statement classifier below all skip strings, quoted
 * identifiers and both comment styles, so text that merely looks like syntax
 * is never treated as syntax.
 */
function prepareQuery(sql: string): PreparedQuery {
	let text = "";
	const order: number[] = [];
	let returnsRows = false;
	let hasNumbered = false;
	let hasBare = false;
	let index = 0;
	while (index < sql.length) {
		const char = sql[index];
		if (char === undefined) break;
		const next = sql[index + 1];
		if (char === "'" || char === '"' || char === "`") {
			// Quoted literal or identifier; placeholders and keywords inside are text.
			text += copyQuoted(sql, index, char);
			index = skipQuoted(sql, index, char);
		} else if (char === "[") {
			// Bracket identifier: the first `]` ends it (SQLite has no bracket escape).
			const end = sql.indexOf("]", index + 1);
			const stop = end === -1 ? sql.length : end + 1;
			text += sql.slice(index, stop);
			index = stop;
		} else if (char === "-" && next === "-") {
			const end = sql.indexOf("\n", index);
			const stop = end === -1 ? sql.length : end;
			text += sql.slice(index, stop);
			index = stop;
		} else if (char === "/" && next === "*") {
			const end = sql.indexOf("*/", index + 2);
			const stop = end === -1 ? sql.length : end + 2;
			text += sql.slice(index, stop);
			index = stop;
		} else if (char === "?") {
			const match = /^[0-9]+/.exec(sql.slice(index + 1));
			if (match === null) {
				hasBare = true;
			} else {
				hasNumbered = true;
				order.push(Number.parseInt(match[0], 10));
				index += match[0].length;
			}
			text += "?";
			index += 1;
		} else if (isWordStart(char)) {
			// A maximal word: a `RETURNING` inside a longer word or a literal
			// can never match, because literals are skipped above.
			const word = readWord(sql, index);
			if (word.word.toLowerCase() === "returning") returnsRows = true;
			text += word.word;
			index = word.end;
		} else {
			text += char;
			index += 1;
		}
	}
	if (hasNumbered && hasBare) {
		throw new Error("node:sqlite driver does not support mixing ? with ?NNN placeholders");
	}
	return { text, order, returnsRows, producesRows: returnsRows || classifyStatement(text) };
}

/** True for the first character of a bare SQL keyword or identifier. */
function isWordStart(char: string): boolean {
	return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

interface ScannedWord {
	readonly word: string;
	readonly end: number;
}

/** Reads the maximal bare word (`[A-Za-z_][A-Za-z0-9_$]*`) starting at `index`. */
function readWord(sql: string, index: number): ScannedWord {
	const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
	if (match === null) return { word: "", end: index };
	return { word: match[0], end: index + match[0].length };
}

/**
 * Copies a quoted literal or identifier starting at `index` (which holds the
 * opening quote), SQLite rules: the quote is escaped by doubling it, anything
 * else — including a backslash — is ordinary text. An unterminated literal is
 * copied to the end; `prepare` then fails closed on the syntax error.
 */
function copyQuoted(sql: string, index: number, quote: string): string {
	return sql.slice(index, skipQuoted(sql, index, quote));
}

/** Index just past the quoted literal or identifier starting at `index`. */
function skipQuoted(sql: string, index: number, quote: string): number {
	let cursor = index + 1;
	while (cursor < sql.length) {
		if (sql[cursor] === quote) {
			if (sql[cursor + 1] === quote) {
				cursor += 2;
				continue;
			}
			return cursor + 1;
		}
		cursor += 1;
	}
	return cursor;
}

/** Skips whitespace and any number of line and block comments. */
function skipTrivia(sql: string, index: number): number {
	let cursor = index;
	while (cursor < sql.length) {
		const char = sql[cursor];
		if (char === undefined) break;
		if (char === "-" && sql[cursor + 1] === "-") {
			const end = sql.indexOf("\n", cursor);
			cursor = end === -1 ? sql.length : end;
			continue;
		}
		if (char === "/" && sql[cursor + 1] === "*") {
			const end = sql.indexOf("*/", cursor + 2);
			cursor = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (/\s/.test(char)) {
			cursor += 1;
			continue;
		}
		break;
	}
	return cursor;
}

/**
 * Index just past the balanced parenthesised group starting at `index`
 * (which holds the opening paren), skipping strings, quoted identifiers and
 * comments so a paren inside one cannot unbalance the count.
 */
function skipBalanced(sql: string, index: number): number {
	let depth = 0;
	let cursor = index;
	while (cursor < sql.length) {
		const char = sql[cursor];
		if (char === undefined) break;
		if (char === "(") {
			depth += 1;
			cursor += 1;
			continue;
		}
		if (char === ")") {
			depth -= 1;
			cursor += 1;
			if (depth === 0) break;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			cursor = skipQuoted(sql, cursor, char);
			continue;
		}
		if (char === "[") {
			const end = sql.indexOf("]", cursor + 1);
			cursor = end === -1 ? sql.length : end + 1;
			continue;
		}
		if (char === "-" && sql[cursor + 1] === "-") {
			const end = sql.indexOf("\n", cursor);
			cursor = end === -1 ? sql.length : end;
			continue;
		}
		if (char === "/" && sql[cursor + 1] === "*") {
			const end = sql.indexOf("*/", cursor + 2);
			cursor = end === -1 ? sql.length : end + 2;
			continue;
		}
		cursor += 1;
	}
	return cursor;
}

/** Statements whose execution yields rows (read through `all()`, like D1's batch). */
const ROW_YIELDING_KEYWORDS: ReadonlySet<string> = new Set([
	"select",
	"values",
	"explain",
	"pragma",
]);

/**
 * True when the statement is a query rather than a write. D1's batch returns
 * rows for batched SELECTs (the record resolvers read them), so the driver
 * must keep them too; `node:sqlite` only yields them through `all()`. Writes
 * go through `run()` instead, so `meta.changes` always comes from SQLite.
 *
 * WHY parsing instead of asking the engine: the installed `node:sqlite`
 * (Node 23.6) exposes no read-only/columns introspection on a prepared
 * statement — `StatementSync` offers only `get`/`all`/`run`/`iterate` — so
 * the driver classifies the text. It skips ALL leading comments (line and
 * block, any number) and classifies a `WITH` statement by its main statement,
 * not by the `WITH` keyword: `WITH ... SELECT` is a query, while
 * `WITH ... INSERT/UPDATE/DELETE` is a write even though it opens with `WITH`.
 */
function classifyStatement(text: string): boolean {
	const cursor = skipTrivia(text, 0);
	const first = readWord(text, cursor);
	if (first.word === "") {
		// Only comments and whitespace: there is nothing to execute. Fail
		// closed with a clear error rather than handing SQLite an empty
		// statement (which finalises it with a cryptic error).
		throw new Error("node:sqlite driver received a statement with no executable SQL");
	}
	const keyword = first.word.toLowerCase();
	if (ROW_YIELDING_KEYWORDS.has(keyword)) return true;
	if (keyword !== "with") return false;
	return classifyCte(text, first.end);
}

/**
 * Classifies a `WITH [RECURSIVE] cte, ... main-statement` by its main
 * statement. Each CTE definition (`name [(columns)] AS [NOT MATERIALIZED]
 * (body)`) is skipped with paren counting, so keywords inside CTE bodies —
 * including a `SELECT` inside a `WITH ... UPDATE` — cannot misclassify it.
 */
function classifyCte(text: string, index: number): boolean {
	let cursor = index;
	const maybeRecursive = readWord(text, skipTrivia(text, cursor));
	if (maybeRecursive.word.toLowerCase() === "recursive") cursor = maybeRecursive.end;
	let trailingComma = false;
	do {
		trailingComma = false;
		cursor = skipTrivia(text, cursor);
		const nameEnd = readCteName(text, cursor);
		if (nameEnd === null) return true;
		cursor = skipTrivia(text, nameEnd);
		if (text[cursor] === "(") cursor = skipBalanced(text, cursor);
		cursor = skipTrivia(text, cursor);
		const as = readWord(text, cursor);
		if (as.word.toLowerCase() !== "as") return true;
		cursor = skipTrivia(text, as.end);
		const modifier = readWord(text, cursor);
		if (modifier.word.toLowerCase() === "not") {
			const materialized = readWord(text, skipTrivia(text, modifier.end));
			if (materialized.word.toLowerCase() !== "materialized") return true;
			cursor = skipTrivia(text, materialized.end);
		} else if (modifier.word.toLowerCase() === "materialized") {
			cursor = skipTrivia(text, modifier.end);
		}
		cursor = skipTrivia(text, cursor);
		if (text[cursor] !== "(") return true;
		cursor = skipBalanced(text, cursor);
		cursor = skipTrivia(text, cursor);
		if (text[cursor] === ",") {
			trailingComma = true;
			cursor += 1;
		}
	} while (trailingComma);
	const main = readWord(text, cursor);
	return main.word === "" || ROW_YIELDING_KEYWORDS.has(main.word.toLowerCase());
}

/**
 * Index just past a CTE name (bare, double-quoted, backtick or bracket
 * identifier), or null when there is no identifier. Valid SQL always has one
 * here; anything else fails closed in `prepare` right after classification.
 */
function readCteName(text: string, index: number): number | null {
	const char = text[index];
	if (char === undefined) return null;
	if (char === '"' || char === "`") return skipQuoted(text, index, char);
	if (char === "[") {
		const end = text.indexOf("]", index + 1);
		return end === -1 ? null : end + 1;
	}
	const word = readWord(text, index);
	return word.word === "" ? null : word.end;
}

/** Copies row values into a plain object; `node:sqlite` rows have a null prototype. */
function toRow(value: unknown): SqlRow | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("node:sqlite driver expected a row object");
	}
	const row: { [key: string]: unknown } = {};
	for (const [key, entry] of Object.entries(value)) {
		row[key] = entry;
	}
	return row;
}

function toRows(values: readonly unknown[]): SqlRow[] {
	const rows: SqlRow[] = [];
	for (const value of values) {
		const row = toRow(value);
		if (row !== null) rows.push(row);
	}
	return rows;
}

class NodeSqliteStatement implements SqlStatement {
	private constructor(
		private readonly statement: StatementSync,
		private readonly query: PreparedQuery,
		private readonly values: readonly SqlValue[],
		private readonly owner: object,
	) {}

	static open(db: DatabaseSync, owner: object, sql: string): NodeSqliteStatement {
		const query = prepareQuery(sql);
		return new NodeSqliteStatement(db.prepare(query.text), query, [], owner);
	}

	bind(...values: readonly SqlValue[]): SqlStatement {
		return new NodeSqliteStatement(this.statement, this.query, values, this.owner);
	}

	/** True when this statement was prepared (or bound) from `owner`'s database. */
	ownedBy(owner: object): boolean {
		return this.owner === owner;
	}

	private expanded(): SqlValue[] {
		if (this.query.order.length === 0) return [...this.values];
		const expanded: SqlValue[] = [];
		for (const number of this.query.order) {
			const value = this.values[number - 1];
			if (value === undefined) {
				throw new Error(`missing bound value for placeholder ?${number}`);
			}
			expanded.push(value);
		}
		return expanded;
	}

	async first(): Promise<SqlRow | null> {
		return toRow(this.statement.get(...this.expanded()));
	}

	async all(): Promise<SqlAllResult> {
		return { results: toRows(this.statement.all(...this.expanded())) };
	}

	async run(): Promise<SqlRunResult> {
		// No caller reads rows from run(); RETURNING statements keep their
		// rows only through batch(), where the rate limiter needs them.
		return { meta: this.execute().meta };
	}

	/** Executes inside a `batch` transaction; row-returning statements keep their rows. */
	execute(): SqlBatchResult {
		if (this.query.producesRows) {
			const results = toRows(this.statement.all(...this.expanded()));
			// One row is returned per changed row, so a RETURNING write reports
			// its row count as its change count; a plain query changed nothing.
			return { results, meta: { changes: this.query.returnsRows ? results.length : 0 } };
		}
		const info = this.statement.run(...this.expanded());
		return { results: [], meta: { changes: Number(info.changes) } };
	}
}

export interface NodeSqliteDatabase extends SqlDatabase {
	/** Releases the underlying handle; the database is unusable afterwards. */
	close(): void;
}

const HANDLES = new WeakMap<NodeSqliteDatabase, DatabaseSync>();

function handleOf(db: NodeSqliteDatabase): DatabaseSync {
	const handle = HANDLES.get(db);
	if (handle === undefined) {
		throw new Error("node:sqlite driver received a database from another driver");
	}
	return handle;
}

/** Opens a SQLite database; `filename` may be `":memory:"`. */
export function openNodeSqlite(filename: string): NodeSqliteDatabase {
	const handle = new DatabaseSync(filename);
	// Identity token: a statement runs only in a batch of the database that
	// prepared it, so a transaction can never silently execute another
	// database's statement outside of it (ARCH-017: fail closed).
	const owner = {};
	const db: NodeSqliteDatabase = {
		prepare(sql: string): SqlStatement {
			return NodeSqliteStatement.open(handle, owner, sql);
		},
		async batch(statements: readonly SqlStatement[]): Promise<readonly SqlBatchResult[]> {
			const owned: NodeSqliteStatement[] = [];
			for (const statement of statements) {
				if (!(statement instanceof NodeSqliteStatement) || !statement.ownedBy(owner)) {
					throw new Error("node:sqlite batch received a statement from another database");
				}
				owned.push(statement);
			}
			handle.prepare("BEGIN IMMEDIATE").run();
			try {
				const results = owned.map((statement) => statement.execute());
				handle.prepare("COMMIT").run();
				return results;
			} catch (error) {
				handle.prepare("ROLLBACK").run();
				throw error;
			}
		},
		close(): void {
			handle.close();
		},
	};
	HANDLES.set(db, handle);
	return db;
}

/** Reads `*.sql` files from a directory (the real ones live in `infra/migrations`). */
export function readSqlMigrations(directory: string): SqlMigration[] {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => ({ name, sql: readFileSync(join(directory, name), "utf8") }));
}

/**
 * Applies, in name order, the migrations not yet recorded in the
 * `schema_migrations` table, each in its own transaction. Idempotent:
 * re-applying records nothing twice.
 */
export function applySqlMigrations(
	db: NodeSqliteDatabase,
	migrations: readonly SqlMigration[],
): void {
	const handle = handleOf(db);
	handle.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
	);
	const applied = new Set<string>();
	for (const row of handle.prepare("SELECT name FROM schema_migrations").all()) {
		if (typeof row.name !== "string") {
			throw new Error("schema_migrations.name is not text");
		}
		applied.add(row.name);
	}
	const pending = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const record = handle.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
	for (const migration of pending) {
		if (applied.has(migration.name)) continue;
		handle.exec("BEGIN IMMEDIATE");
		try {
			handle.exec(migration.sql);
			record.run(migration.name, new Date().toISOString());
			handle.exec("COMMIT");
		} catch (error) {
			handle.exec("ROLLBACK");
			throw error;
		}
	}
}
