/**
 * The table definition documents in `docs/database/` must describe the
 * canonical schema `db/schema.sql` exactly (docs/database/conventions.md,
 * section 10). The schema is the source of truth: this file builds a database
 * from it, reads every table's columns, keys, constraints, indexes, foreign
 * keys and triggers from SQLite itself, and compares them with the Markdown.
 * A failure names the document and prints the row the schema expects.
 *
 * What it does not check: prose (descriptions, lifecycle text, logical
 * relationships beyond "the referenced table exists"). Those are reviewed
 * with the schema change, as the conventions require.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	initializeSqlSchema,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
	readSqlSchema,
} from "@research/adapters/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const repoPath = (relative: string) =>
	fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));

const DOCS_DIR = repoPath("docs/database");
const TABLES_DIR = `${DOCS_DIR}/tables`;
const README = readFileSync(`${DOCS_DIR}/README.md`, "utf8");
const TEMPLATE = readFileSync(`${DOCS_DIR}/table-template.md`, "utf8");

/** Level-2 sections every table document has, in this order. */
const REQUIRED_SECTIONS = [
	"Overview",
	"Columns",
	"Constraints",
	"Indexes",
	"Relationships",
	"Data Lifecycle",
] as const;
/** Level-3 subsections of "Data Lifecycle". */
const LIFECYCLE_SUBSECTIONS = ["Insert", "Update", "Delete", "Synchronization", "Retention"];
/** Tables owned by an engine or a migration runner, not by the application. */
const ENGINE_TABLES = new Set(["schema_migrations", "d1_migrations", "sqlite_sequence"]);

interface ExpectedTable {
	readonly name: string;
	readonly withoutRowid: boolean;
	readonly primaryKey: readonly string[];
	/** `name | TYPE | Nullable | Default`, in schema order. */
	readonly columns: readonly string[];
	/** `TYPE | columns | definition`. Rows of sets compare in `compact` form. */
	readonly constraints: readonly string[];
	/** `name | columns[ WHERE predicate] | Unique`, CREATE INDEX indexes only. */
	readonly indexes: readonly string[];
	/** `columns | table | columns | enforcement`. */
	readonly foreignKeys: readonly string[];
	/** `name | timing event[ WHEN condition] | body`. */
	readonly triggers: readonly string[];
}

const tableRow = z.object({ name: z.string() });
const listRow = z.object({ wr: z.number() });
const columnRow = z.object({
	name: z.string(),
	type: z.string(),
	notnull: z.number(),
	dflt_value: z.string().nullable(),
	pk: z.number(),
	hidden: z.number(),
});
const indexRow = z.object({ name: z.string(), unique: z.number(), origin: z.string() });
const indexColumnRow = z.object({ name: z.string().nullable(), desc: z.number(), key: z.number() });
const foreignKeyRow = z.object({
	id: z.number(),
	table: z.string(),
	from: z.string(),
	to: z.string(),
	on_delete: z.string(),
	on_update: z.string(),
});
const sqlRow = z.object({ sql: z.string() });
const triggerRow = z.object({ name: z.string(), sql: z.string() });

async function rows(db: NodeSqliteDatabase, sql: string, ...values: string[]) {
	return (
		await db
			.prepare(sql)
			.bind(...values)
			.all()
	).results;
}

const list = (names: readonly string[]) => names.join(", ");

// ---------------------------------------------------------------------------
// SQL text reading. Quoted text ('literal', "identifier", `identifier`,
// [identifier]) is copied verbatim and never searched, so a parenthesis, a
// comma or a keyword inside a literal cannot shift a boundary, and literal
// case and spacing stay significant.
// ---------------------------------------------------------------------------

const QUOTE_END: Readonly<Record<string, string>> = { "'": "'", '"': '"', "`": "`", "[": "]" };

interface SqlPart {
	readonly text: string;
	readonly quoted: boolean;
}

/** Splits SQL into quoted and unquoted parts; comments are dropped. */
function sqlParts(sql: string): SqlPart[] {
	const parts: SqlPart[] = [];
	let plainText = "";
	let i = 0;
	while (i < sql.length) {
		const char = sql[i] ?? "";
		const end = QUOTE_END[char];
		if (end !== undefined) {
			let j = i + 1;
			for (; j < sql.length; j++) {
				// A doubled quote inside a literal is an escaped quote.
				if (sql[j] === end && !(end !== "]" && sql[j + 1] === end)) break;
				if (sql[j] === end) j++;
			}
			parts.push({ text: plainText, quoted: false }, { text: sql.slice(i, j + 1), quoted: true });
			plainText = "";
			i = j + 1;
		} else if (sql.startsWith("--", i)) {
			const newline = sql.indexOf("\n", i);
			i = newline < 0 ? sql.length : newline;
		} else if (sql.startsWith("/*", i)) {
			const close = sql.indexOf("*/", i + 2);
			i = close < 0 ? sql.length : close + 2;
			plainText += " ";
		} else {
			plainText += char;
			i++;
		}
	}
	parts.push({ text: plainText, quoted: false });
	return parts.filter((part) => part.text !== "");
}

/** SQL without comments, unquoted whitespace collapsed to one space. */
function cleanSql(sql: string): string {
	return sqlParts(sql)
		.map((part) => (part.quoted ? part.text : part.text.replace(/\s+/g, " ")))
		.join("")
		.trim();
}

/**
 * Comparable form of a definition: unquoted text loses all whitespace and
 * case (SQL keywords and identifiers are case-insensitive); quoted text is
 * kept exactly, so `'ABC'` and `'abc'` differ.
 */
function compact(sql: string): string {
	const parts = sqlParts(sql);
	return parts
		.map((part, i) => {
			if (part.quoted) return part.text;
			let text = part.text
				.toLowerCase()
				.replace(/\s+/g, " ")
				// Spacing next to punctuation is insignificant; between two words it
				// separates tokens (`a collate nocase` is not `acollatenocase`).
				.replace(/ ?([^\w ]) ?/g, "$1");
			// A quote is punctuation too, and so are the ends of the text.
			if (i === 0 || parts[i - 1]?.quoted === true) text = text.trimStart();
			if (i === parts.length - 1 || parts[i + 1]?.quoted === true) text = text.trimEnd();
			return text;
		})
		.join("");
}

/**
 * The cleaned SQL with every quoted part replaced by spaces of the same
 * length: a search mask on which positions match the cleaned text.
 */
function unquotedMask(clean: string): string {
	return sqlParts(clean)
		.map((part) => (part.quoted ? " ".repeat(part.text.length) : part.text))
		.join("");
}

/** Index of the `)` that closes the `(` at `open`, in a masked string. */
function closingParen(masked: string, open: number): number {
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === "(") depth++;
		else if (masked[i] === ")" && --depth === 0) return i;
	}
	throw new Error(`unbalanced parentheses in: ${masked}`);
}

/** Splits at the commas outside parentheses and quotes. */
function splitTopLevel(clean: string): string[] {
	const masked = unquotedMask(clean);
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < masked.length; i++) {
		if (masked[i] === "(") depth++;
		else if (masked[i] === ")") depth--;
		else if (masked[i] === "," && depth === 0) {
			items.push(clean.slice(start, i).trim());
			start = i + 1;
		}
	}
	items.push(clean.slice(start).trim());
	return items;
}

/** The parenthesized text after each match of `keyword` (which ends at `(`). */
function parenthesizedAfter(clean: string, keyword: RegExp): string[] {
	const masked = unquotedMask(clean);
	const found: string[] = [];
	for (const match of masked.matchAll(keyword)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		found.push(clean.slice(open + 1, closingParen(masked, open)).trim());
	}
	return found;
}

/** Every `CHECK (...)` expression of a CREATE TABLE statement, in order. */
function checkExpressions(createSql: string): string[] {
	return parenthesizedAfter(cleanSql(createSql), /\bCHECK\s*\(/gi);
}

/** `GENERATED (expression) VIRTUAL|STORED` of a generated column. */
function generatedDefinition(createSql: string, column: string): string {
	const clean = cleanSql(createSql);
	const masked = unquotedMask(clean);
	const body = clean.slice(masked.indexOf("(") + 1, closingParen(masked, masked.indexOf("(")));
	const definition = splitTopLevel(body).find(
		(item) => item.split(" ")[0]?.replace(/^["`[]|["`\]]$/g, "") === column,
	);
	const [expression] = parenthesizedAfter(definition ?? "", /\bAS\s*\(/gi);
	if (definition === undefined || expression === undefined) {
		throw new Error(`no generation expression found for column ${column}`);
	}
	return `GENERATED (${expression}) ${/\bSTORED\b/i.test(unquotedMask(definition)) ? "STORED" : "VIRTUAL"}`;
}

/** `columns[ WHERE predicate]` of a CREATE INDEX statement, keys as written. */
function indexDefinition(createSql: string): string {
	const clean = cleanSql(createSql);
	const masked = unquotedMask(clean);
	// The table name may be quoted (masked to spaces): the key list is the
	// first parenthesis after ON.
	const on = /\bON\s/i.exec(masked);
	const open = on === null ? -1 : masked.indexOf("(", on.index);
	if (open < 0) throw new Error(`no ON <table> (...) in: ${clean}`);
	const close = closingParen(masked, open);
	const keys = splitTopLevel(clean.slice(open + 1, close));
	const where = masked.slice(close + 1).search(/\bWHERE\b/i);
	const predicate = where < 0 ? "" : ` ${clean.slice(close + 1 + where).trim()}`;
	return `${list(keys)}${predicate}`;
}

/**
 * `timing event[ WHEN condition] | body` of a CREATE TRIGGER statement:
 * the header without the trigger and table names and the implied
 * `FOR EACH ROW`, and the statements between BEGIN and END.
 */
function triggerDefinition(createSql: string): { event: string; body: string } {
	const clean = cleanSql(createSql);
	const masked = unquotedMask(clean);
	const begin = masked.search(/\bBEGIN\b/i);
	const end = masked.search(/\bEND\s*;?\s*$/i);
	const identifier = String.raw`(?:"(?:[^"]|"")*"|\`(?:[^\`]|\`\`)*\`|\[[^\]]*\]|[^\s(]+)`;
	const on = /\bON\s/i.exec(masked.slice(0, begin));
	if (on === null) throw new Error(`no ON <table> in: ${clean}`);
	const table = new RegExp(String.raw`ON\s+${identifier}`, "iy");
	table.lastIndex = on.index;
	const tableEnd = table.exec(clean) === null ? on.index : table.lastIndex;
	const header = `${clean.slice(0, on.index)} ${clean.slice(tableEnd, begin)}`
		.replace(
			new RegExp(
				String.raw`^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\s+(IF\s+NOT\s+EXISTS\s+)?${identifier}\s*`,
				"i",
			),
			"",
		)
		.replace(/\bFOR\s+EACH\s+ROW\b/i, "");
	return {
		event: cleanSql(header),
		body: clean.slice(begin + "BEGIN".length, end).trim(),
	};
}

async function describeTable(db: NodeSqliteDatabase, name: string): Promise<ExpectedTable> {
	const [options] = (
		await rows(db, "SELECT tl.wr FROM pragma_table_list AS tl WHERE tl.name = ?", name)
	).map((row) => listRow.parse(row));
	const withoutRowid = options?.wr === 1;
	const columns = (await rows(db, "SELECT * FROM pragma_table_xinfo(?) ORDER BY cid", name)).map(
		(row) => columnRow.parse(row),
	);
	// hidden: 0 ordinary, 2 generated VIRTUAL, 3 generated STORED; 1 only
	// exists in virtual tables, which this checker does not describe.
	if (columns.some((column) => column.hidden === 1)) {
		throw new Error(`${name}: virtual tables are not supported by the table document checker`);
	}
	const primaryKey = columns
		.filter((column) => column.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((column) => column.name);
	const integerPrimaryKey =
		!withoutRowid &&
		primaryKey.length === 1 &&
		columns.some(
			(column) => column.name === primaryKey[0] && column.type.toUpperCase() === "INTEGER",
		);
	const { sql } = sqlRow.parse(
		(await rows(db, "SELECT ss.sql FROM sqlite_schema AS ss WHERE ss.name = ?", name))[0],
	);

	// UNIQUE constraints name plain columns only (SQLite allows no expressions there).
	const keyColumns = async (index: string) =>
		(await rows(db, "SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno", index))
			.map((row) => indexColumnRow.parse(row))
			.filter((column) => column.key === 1)
			.map((column) => `${column.name ?? "<expression>"}${column.desc === 1 ? " DESC" : ""}`);
	const schemaSql = async (object: string) =>
		sqlRow.parse(
			(await rows(db, "SELECT ss.sql FROM sqlite_schema AS ss WHERE ss.name = ?", object))[0],
		).sql;
	const indexes = (await rows(db, "SELECT * FROM pragma_index_list(?)", name)).map((row) =>
		indexRow.parse(row),
	);

	const constraints: string[] = [
		// An INTEGER PRIMARY KEY is the rowid; AUTOINCREMENT is part of its definition.
		`PRIMARY KEY | ${list(primaryKey)} | ${integerPrimaryKey && /\bAUTOINCREMENT\b/i.test(sql) ? "AUTOINCREMENT" : "-"}`,
	];
	for (const index of indexes.filter((each) => each.origin === "u")) {
		constraints.push(`UNIQUE | ${list(await keyColumns(index.name))} | -`);
	}
	const foreignKeys = new Map<
		number,
		{ table: string; from: string[]; to: string[]; onDelete: string; onUpdate: string }
	>();
	for (const row of await rows(
		db,
		"SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq",
		name,
	)) {
		const fk = foreignKeyRow.parse(row);
		const entry = foreignKeys.get(fk.id) ?? {
			table: fk.table,
			from: [],
			to: [],
			onDelete: fk.on_delete,
			onUpdate: fk.on_update,
		};
		entry.from.push(fk.from);
		entry.to.push(fk.to);
		foreignKeys.set(fk.id, entry);
	}
	const actions = (fk: { onDelete: string; onUpdate: string }) =>
		`ON DELETE ${fk.onDelete}${fk.onUpdate === "NO ACTION" ? "" : ` ON UPDATE ${fk.onUpdate}`}`;
	for (const fk of foreignKeys.values()) {
		constraints.push(
			`FOREIGN KEY | ${list(fk.from)} | ${fk.table} (${list(fk.to)}) ${actions(fk)}`,
		);
	}
	const columnNames = columns.map((column) => column.name);
	for (const expression of checkExpressions(sql)) {
		const identifiers = new Set(expression.match(/[A-Za-z_][A-Za-z0-9_]*/g));
		constraints.push(
			`CHECK | ${list(columnNames.filter((column) => identifiers.has(column)))} | ${expression}`,
		);
	}

	const explicitIndexes: string[] = [];
	for (const index of indexes.filter((each) => each.origin === "c")) {
		explicitIndexes.push(
			`${index.name} | ${indexDefinition(await schemaSql(index.name))} | ${index.unique === 1 ? "Yes" : "No"}`,
		);
	}
	const triggers: string[] = [];
	for (const row of await rows(
		db,
		"SELECT ss.name, ss.sql FROM sqlite_schema AS ss WHERE ss.type = 'trigger' AND ss.tbl_name = ?",
		name,
	)) {
		const trigger = triggerRow.parse(row);
		const { event, body } = triggerDefinition(trigger.sql);
		triggers.push(`${trigger.name} | ${event} | ${body}`);
	}

	return {
		name,
		withoutRowid,
		primaryKey,
		columns: columns.map((column) => {
			// SQLite enforces NOT NULL on a WITHOUT ROWID key and on the rowid alias,
			// but pragma_table_info reports notnull = 0 unless it was declared.
			const notNull =
				column.notnull === 1 || (column.pk > 0 && (withoutRowid || integerPrimaryKey));
			const defaultValue =
				column.hidden >= 2 ? generatedDefinition(sql, column.name) : (column.dflt_value ?? "-");
			return `${column.name} | ${column.type.toUpperCase()} | ${notNull ? "No" : "Yes"} | ${defaultValue}`;
		}),
		constraints,
		indexes: explicitIndexes,
		foreignKeys: [...foreignKeys.values()].map(
			(fk) => `${list(fk.from)} | ${fk.table} | ${list(fk.to)} | Foreign key, ${actions(fk)}`,
		),
		triggers,
	};
}

// ---------------------------------------------------------------------------
// Markdown reading
// ---------------------------------------------------------------------------

/** Body of each `## Heading`, by heading text, in document order. */
function sectionsOf(markdown: string, level: "##" | "###"): Map<string, string> {
	const sections = new Map<string, string>();
	const pattern = new RegExp(`^${level} (.+)$`, "gm");
	const headings = [...markdown.matchAll(pattern)];
	headings.forEach((heading, i) => {
		const start = (heading.index ?? 0) + heading[0].length;
		const end = headings[i + 1]?.index ?? markdown.length;
		// A lower-level body stops at the next heading of a higher level.
		const body = markdown.slice(start, end);
		const stop = level === "###" ? body.search(/^## /m) : -1;
		sections.set((heading[1] ?? "").trim(), stop < 0 ? body : body.slice(0, stop));
	});
	return sections;
}

/**
 * Splits a Markdown table row into cells. As in GitHub Flavored Markdown,
 * every unescaped `|` separates cells, even inside a code span; a pipe that
 * belongs to the text is written `\|` (unescaped by `literal`).
 */
function cellsOf(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

/** Rows whose cell count differs from their table's header (an unescaped `|`). */
function malformedRows(markdown: string): string[] {
	const problems: string[] = [];
	let headerCells = 0;
	for (const line of markdown.split("\n")) {
		if (!line.trim().startsWith("|")) {
			headerCells = 0;
			continue;
		}
		const cells = cellsOf(line).length;
		if (headerCells === 0) headerCells = cells;
		else if (cells !== headerCells) {
			problems.push(
				`row has ${cells} cells, its header ${headerCells} (escape a literal pipe as \\|): ${line.trim()}`,
			);
		}
	}
	return problems;
}

/** Data rows (header and separator dropped) of the first table in a section. */
function tableRows(body: string): string[][] {
	const lines = body.split("\n").filter((line) => line.trim().startsWith("|"));
	return lines.slice(2).map(cellsOf);
}

/**
 * Cell text with code spans replaced by their content (a span opened by N
 * backticks closes on N backticks, so ``x = 'a`b'`` holds a backtick), spacing
 * kept: definition cells.
 */
const literal = (cell: string) =>
	cell
		.replace(/(`+)(.+?)(?<!`)\1(?!`)/g, (_match, _fence: string, content: string) =>
			/^ .* $/.test(content) ? content.slice(1, -1) : content,
		)
		.replaceAll("\\|", "|")
		.trim();
/** Cell text as `literal`, with single spaces: names and prose cells. */
const plain = (cell: string) => literal(cell).replace(/\s+/g, " ");
/** Joins definition cells into one row, as the expected rows are written. */
const definitionRow = (cells: readonly string[], columns: readonly number[]) =>
	columns.map((i) => literal(cells[i] ?? "")).join(" | ");

function compareSets(
	problems: string[],
	what: string,
	expected: readonly string[],
	documented: readonly string[],
) {
	const remaining = [...documented];
	for (const row of expected) {
		const at = remaining.findIndex((each) => compact(each) === compact(row));
		if (at < 0) problems.push(`${what}: missing row | ${row} |`);
		else remaining.splice(at, 1);
	}
	for (const row of remaining) problems.push(`${what}: row not in the schema | ${row} |`);
}

/**
 * Every way a table document disagrees with its table. Pure, so the checker
 * itself is tested below with broken documents.
 */
function documentProblems(
	markdown: string,
	expected: ExpectedTable,
	tableNames: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	if (!markdown.startsWith(`# Table: ${expected.name}\n`)) {
		problems.push(`first line must be "# Table: ${expected.name}"`);
	}
	if (markdown.includes("{{")) problems.push("unfilled {{placeholder}} left from the template");
	problems.push(...malformedRows(markdown));

	const sections = sectionsOf(markdown, "##");
	const headings = [...sections.keys()];
	let previous = -1;
	for (const section of REQUIRED_SECTIONS) {
		const at = headings.indexOf(section);
		if (at < 0) problems.push(`missing section "## ${section}"`);
		else if (at < previous) problems.push(`section "## ${section}" is out of order`);
		else previous = at;
	}
	const lifecycle = sectionsOf(sections.get("Data Lifecycle") ?? "", "###");
	for (const sub of LIFECYCLE_SUBSECTIONS) {
		if ((lifecycle.get(sub) ?? "").trim() === "") {
			problems.push(`"## Data Lifecycle" needs a non-empty "### ${sub}"`);
		}
	}

	const overview = new Map(
		tableRows(sections.get("Overview") ?? "").map(([key = "", value = ""]) => [
			plain(key),
			plain(value),
		]),
	);
	const expectOverview = (key: string, value: string) => {
		if (overview.get(key) !== value) {
			problems.push(`Overview: "${key}" is "${overview.get(key) ?? ""}", schema says "${value}"`);
		}
	};
	expectOverview("Table Name", expected.name);
	expectOverview("Primary Key", list(expected.primaryKey));
	expectOverview("Storage", expected.withoutRowid ? "WITHOUT ROWID" : "Rowid table");
	for (const key of ["Purpose", "Update Strategy", "Data Retention"]) {
		if ((overview.get(key) ?? "") === "") problems.push(`Overview: "${key}" is empty`);
	}

	const columnRows = tableRows(sections.get("Columns") ?? "");
	const documentedColumns = columnRows.map((cells) => definitionRow(cells, [0, 1, 2, 3]));
	expected.columns.forEach((column, i) => {
		if (compact(documentedColumns[i] ?? "") !== compact(column)) {
			problems.push(
				`Columns: row ${i + 1} is | ${documentedColumns[i] ?? "(none)"} |, schema says | ${column} |`,
			);
		}
	});
	for (const extra of documentedColumns.slice(expected.columns.length)) {
		problems.push(`Columns: row not in the schema | ${extra} |`);
	}
	for (const cells of columnRows) {
		if (plain(cells[4] ?? "") === "")
			problems.push(`Columns: ${plain(cells[0] ?? "")} has no description`);
	}

	const constraintRows = tableRows(sections.get("Constraints") ?? "");
	compareSets(
		problems,
		"Constraints",
		expected.constraints,
		constraintRows.map((cells) => definitionRow(cells, [1, 2, 3])),
	);

	const indexRows = tableRows(sections.get("Indexes") ?? "");
	compareSets(
		problems,
		"Indexes",
		expected.indexes,
		indexRows.map((cells) => definitionRow(cells, [0, 1, 2])),
	);
	const triggerRows = tableRows(sections.get("Triggers") ?? "");
	if (expected.triggers.length > 0 && !sections.has("Triggers")) {
		problems.push('missing section "## Triggers"');
	}
	compareSets(
		problems,
		"Triggers",
		expected.triggers,
		triggerRows.map((cells) => definitionRow(cells, [0, 1, 2])),
	);
	for (const cells of [...constraintRows, ...indexRows, ...triggerRows]) {
		if (plain(cells.at(-1) ?? "") === "")
			problems.push(`${plain(cells[0] ?? "")}: empty description`);
	}

	const relationshipRows = tableRows(sections.get("Relationships") ?? "");
	compareSets(
		problems,
		"Relationships (foreign keys)",
		expected.foreignKeys,
		relationshipRows
			.filter((cells) => plain(cells[4] ?? "").startsWith("Foreign key"))
			.map((cells) => definitionRow(cells, [0, 1, 2, 4])),
	);
	for (const cells of relationshipRows) {
		const referenced = plain(cells[1] ?? "");
		if (!tableNames.has(referenced)) {
			problems.push(`Relationships: "${referenced}" is not a table in the schema`);
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let db: NodeSqliteDatabase;
let tables: ExpectedTable[] = [];
let tableNames: ReadonlySet<string> = new Set();

beforeAll(async () => {
	db = openNodeSqlite(":memory:");
	initializeSqlSchema(
		db,
		readSqlSchema(repoPath("db/schema.sql")),
		readSqlMigrations(repoPath("infra/migrations")),
	);
	const names = (
		await rows(
			db,
			"SELECT ss.name FROM sqlite_schema AS ss WHERE ss.type = 'table' AND ss.name NOT LIKE 'sqlite_%' ORDER BY ss.name",
		)
	)
		.map((row) => tableRow.parse(row).name)
		.filter((name) => !ENGINE_TABLES.has(name));
	tableNames = new Set(names);
	tables = [];
	for (const name of names) tables.push(await describeTable(db, name));
});

afterAll(() => db.close());

const documentFiles = () =>
	readdirSync(TABLES_DIR)
		.filter((file) => file.endsWith(".md"))
		.map((file) => file.slice(0, -".md".length))
		.sort();

describe("table definition documents (docs/database/tables)", () => {
	it("has exactly one document per table in db/schema.sql", () => {
		expect(documentFiles()).toEqual([...tableNames].sort());
	});

	it("indexes every table document, and only those, in docs/database/README.md", () => {
		const linked = [...README.matchAll(/\]\(tables\/([a-z0-9_]+)\.md\)/g)].map((match) => match[1]);
		expect([...new Set(linked)].sort()).toEqual([...tableNames].sort());
		expect(linked).toHaveLength(new Set(linked).size);
	});

	it("documents every table's columns, constraints, indexes, relationships and triggers as the schema defines them", () => {
		const problems: string[] = [];
		for (const table of tables) {
			const markdown = readFileSync(`${TABLES_DIR}/${table.name}.md`, "utf8");
			for (const problem of documentProblems(markdown, table, tableNames)) {
				problems.push(`docs/database/tables/${table.name}.md: ${problem}`);
			}
		}
		expect(problems).toEqual([]);
	});

	it("keeps the template's mandatory sections", () => {
		for (const section of [...REQUIRED_SECTIONS, "Triggers", "Notes"]) {
			expect(TEMPLATE).toContain(`\n## ${section}\n`);
		}
		for (const sub of LIFECYCLE_SUBSECTIONS) expect(TEMPLATE).toContain(`\n### ${sub}\n`);
	});
});

describe("the document checker", () => {
	const table = () => {
		const found = tables.find((each) => each.name === "equity_import");
		if (found === undefined) throw new Error("expected equity_import in the schema");
		return found;
	};
	const document = () => readFileSync(`${TABLES_DIR}/equity_import.md`, "utf8");

	it("accepts the real document", () => {
		expect(documentProblems(document(), table(), tableNames)).toEqual([]);
	});

	it("reports a wrong column type, a dropped index and a changed CHECK", () => {
		const broken = document()
			.replace("| `record_count` | INTEGER |", "| `record_count` | TEXT |")
			.replace(/^\| `idx_equity_import__owner_id_committed_at_import_id` .*\n/m, "")
			.replace("record_count BETWEEN 1 AND 2000", "record_count BETWEEN 1 AND 5000");
		expect(broken).not.toBe(document());
		const problems = documentProblems(broken, table(), tableNames).join("\n");
		expect(problems).toContain("Columns: row 9");
		expect(problems).toContain(
			"Indexes: missing row | idx_equity_import__owner_id_committed_at_import_id",
		);
		expect(problems).toContain("Constraints: missing row | CHECK | record_count |");
	});

	it("reports a missing section and a placeholder", () => {
		const broken = document().replace("## Relationships", "## Links").concat("\n{{todo}}\n");
		const problems = documentProblems(broken, table(), tableNames);
		expect(problems).toContain('missing section "## Relationships"');
		expect(problems).toContain("unfilled {{placeholder}} left from the template");
	});

	it("reports a changed letter case inside a CHECK literal", () => {
		const listing = tables.find((each) => each.name === "equity_listing");
		if (listing === undefined) throw new Error("expected equity_listing in the schema");
		const real = readFileSync(`${TABLES_DIR}/equity_listing.md`, "utf8");
		const broken = real.replace("market IN ('JP','US')", "market IN ('jp','US')");
		expect(broken).not.toBe(real);
		expect(documentProblems(broken, listing, tableNames).join("\n")).toContain(
			"Constraints: missing row | CHECK | market | market IN ('JP','US')",
		);
	});

	it("reports a changed trigger event or body", () => {
		const series = tables.find((each) => each.name === "metal_series");
		if (series === undefined) throw new Error("expected metal_series in the schema");
		const real = readFileSync(`${TABLES_DIR}/metal_series.md`, "utf8");
		const event = real.replace(
			"| `metal_series_immutable_delete` | BEFORE DELETE |",
			"| `metal_series_immutable_delete` | AFTER DELETE |",
		);
		const body = real.replace("'material series is immutable');", "'series is immutable');");
		for (const broken of [event, body]) {
			expect(broken).not.toBe(real);
			expect(documentProblems(broken, series, tableNames).join("\n")).toContain(
				"Triggers: missing row | metal_series_immutable_delete |",
			);
		}
	});
});

/**
 * SQLite features the schema does not use yet, so a future table that uses
 * them is still compared in full: a DEFAULT, a generated column, a CHECK with
 * parentheses inside a literal, a partial expression index and a trigger
 * with OF and WHEN.
 */
describe("the document checker on SQLite features the schema does not use yet", () => {
	const SAMPLE_SCHEMA = `
		CREATE TABLE sample (
			owner_id TEXT NOT NULL,
			name TEXT NOT NULL DEFAULT 'a  b',
			name_length INTEGER GENERATED ALWAYS AS (length(name)) VIRTUAL,
			state TEXT NOT NULL CHECK (state IN ('Open', 'closed (final)')),
			CHECK (name <> 'x\`y'),
			CHECK (length(name || 'z') > 1),
			PRIMARY KEY (owner_id, name)
		) WITHOUT ROWID;
		CREATE INDEX idx_sample__owner_id_lower_name
			ON "sample" (owner_id, lower(name) DESC) WHERE state <> 'closed (final)';
		CREATE TRIGGER sample_closed_update BEFORE UPDATE OF state ON "sample"
		FOR EACH ROW WHEN old.state = 'closed (final)'
		BEGIN
			SELECT RAISE(ABORT, 'closed');
		END;`;

	const SAMPLE_DOCUMENT = [
		"# Table: sample",
		"",
		"## Overview",
		"",
		"| Property | Value |",
		"|---|---|",
		"| Table Name | `sample` |",
		"| Purpose | A test table. |",
		"| Primary Key | `owner_id`, `name` |",
		"| Storage | `WITHOUT ROWID` |",
		"| Update Strategy | Test only. |",
		"| Data Retention | Test only. |",
		"",
		"## Columns",
		"",
		"| Column | Data Type | Nullable | Default | Description |",
		"|---|---|---|---|---|",
		"| `owner_id` | TEXT | No | - | Owner. |",
		"| `name` | TEXT | No | `'a  b'` | Name. |",
		"| `name_length` | INTEGER | Yes | `GENERATED (length(name)) VIRTUAL` | Length of the name. |",
		"| `state` | TEXT | No | - | State. |",
		"",
		"## Constraints",
		"",
		"| Name | Type | Columns | Definition | Description |",
		"|---|---|---|---|---|",
		"| (unnamed) | PRIMARY KEY | `owner_id`, `name` | - | Key. |",
		"| (unnamed) | CHECK | `state` | `state IN ('Open', 'closed (final)')` | Allowed states. |",
		"| (unnamed) | CHECK | `name` | ``name <> 'x`y'`` | A literal holding a backtick. |",
		"| (unnamed) | CHECK | `name` | `length(name \\|\\| 'z') > 1` | An escaped pipe. |",
		"",
		"## Indexes",
		"",
		"| Index Name | Columns | Unique | Purpose |",
		"|---|---|---|---|",
		"| `idx_sample__owner_id_lower_name` | `owner_id`, `lower(name)` DESC WHERE `state <> 'closed (final)'` | No | Open rows by name. |",
		"",
		"## Relationships",
		"",
		"| Column | Referenced Table | Referenced Column | Relationship | Enforcement |",
		"|---|---|---|---|---|",
		"",
		"## Triggers",
		"",
		"| Trigger | Event | Body | Description |",
		"|---|---|---|---|",
		"| `sample_closed_update` | BEFORE UPDATE OF state WHEN `old.state = 'closed (final)'` | `SELECT RAISE(ABORT, 'closed');` | Closed rows are final. |",
		"",
		"## Data Lifecycle",
		"",
		...LIFECYCLE_SUBSECTIONS.flatMap((sub) => [`### ${sub}`, "", "Test only.", ""]),
	].join("\n");

	let sample: ExpectedTable;
	beforeAll(async () => {
		const sampleDb = openNodeSqlite(":memory:");
		try {
			initializeSqlSchema(sampleDb, SAMPLE_SCHEMA, []);
			sample = await describeTable(sampleDb, "sample");
		} finally {
			sampleDb.close();
		}
	});

	it("describes defaults, generated columns, literals, partial expression indexes and triggers", () => {
		expect(sample.columns).toEqual([
			"owner_id | TEXT | No | -",
			"name | TEXT | No | 'a  b'",
			"name_length | INTEGER | Yes | GENERATED (length(name)) VIRTUAL",
			"state | TEXT | No | -",
		]);
		expect(sample.constraints).toEqual([
			"PRIMARY KEY | owner_id, name | -",
			"CHECK | state | state IN ('Open', 'closed (final)')",
			"CHECK | name | name <> 'x`y'",
			"CHECK | name | length(name || 'z') > 1",
		]);
		expect(sample.indexes).toEqual([
			"idx_sample__owner_id_lower_name | owner_id, lower(name) DESC WHERE state <> 'closed (final)' | No",
		]);
		expect(sample.triggers).toEqual([
			"sample_closed_update | BEFORE UPDATE OF state WHEN old.state = 'closed (final)' | SELECT RAISE(ABORT, 'closed');",
		]);
		expect(documentProblems(SAMPLE_DOCUMENT, sample, new Set(["sample"]))).toEqual([]);
	});

	it.each([
		["a default's literal spacing", "`'a  b'`", "`'a b'`", "Columns: row 2"],
		[
			"a generation expression",
			"(length(name)) VIRTUAL",
			"(length(name)) STORED",
			"Columns: row 3",
		],
		[
			"a CHECK literal",
			"'Open', 'closed (final)')` | Allowed",
			"'open', 'closed (final)')` | Allowed",
			"Constraints: missing row | CHECK",
		],
		[
			"a partial-index predicate",
			"WHERE `state <> 'closed (final)'`",
			"WHERE `state = 'Open'`",
			"Indexes: missing row",
		],
		["an expression key", "`lower(name)` DESC", "`upper(name)` DESC", "Indexes: missing row"],
		["a token boundary", "`lower(name)` DESC", "`lower(name)` DE SC", "Indexes: missing row"],
		[
			"a literal holding a backtick",
			"``name <> 'x`y'``",
			"``name <> 'x`z'``",
			"Constraints: missing row | CHECK | name",
		],
		[
			"an unescaped pipe",
			"`length(name \\|\\| 'z') > 1`",
			"`length(name || 'z') > 1`",
			"row has 7 cells, its header 5",
		],
		[
			"a trigger condition",
			"WHEN `old.state = 'closed (final)'`",
			"WHEN `old.state = 'Open'`",
			"Triggers: missing row",
		],
	])("reports a changed %s", (_what, from, to, problem) => {
		const broken = SAMPLE_DOCUMENT.replace(from, to);
		expect(broken).not.toBe(SAMPLE_DOCUMENT);
		expect(documentProblems(broken, sample, new Set(["sample"])).join("\n")).toContain(problem);
	});
});
