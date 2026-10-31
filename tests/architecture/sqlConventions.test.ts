/**
 * Enforces the checkable SQL conventions of docs/database/conventions.md on
 * every SQL string in the application's SQL code: explicit `AS` for table
 * aliases, canonical aliases (`TABLE_ALIASES`), no `SELECT *`, uppercase
 * keywords and lowercase function names. The scanner reads string and
 * template literals only; `${...}` interpolations count as opaque text.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TABLE_ALIASES, TABLE_COLUMNS, type TableName } from "@research/adapters/sql";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Files that hold application SQL. */
function sqlSourceFiles(): string[] {
	const directories = ["packages/adapters/src/sql", "packages/adapters/src/sqlite"];
	const files = directories.flatMap((directory) =>
		readdirSync(join(ROOT, directory))
			.filter((name) => name.endsWith(".ts"))
			.map((name) => join(ROOT, directory, name)),
	);
	return [...files, join(ROOT, "scripts/bench.ts"), join(ROOT, "scripts/profileRuns.ts")];
}

interface Literal {
	readonly text: string;
	readonly line: number;
}

/** Index just past the template literal opened at `start`, collecting its text. */
function readTemplate(source: string, start: number): { end: number; text: string } {
	let text = "";
	let index = start + 1;
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			text += source.slice(index, index + 2);
			index += 2;
		} else if (char === "`") {
			return { end: index + 1, text };
		} else if (char === "$" && source[index + 1] === "{") {
			index = skipExpression(source, index + 2);
			text += " __expr__ ";
		} else {
			text += char;
			index += 1;
		}
	}
	return { end: index, text };
}

/** Index just past the `}` closing an interpolation whose body starts at `start`. */
function skipExpression(source: string, start: number): number {
	let depth = 1;
	let index = start;
	while (index < source.length && depth > 0) {
		const char = source[index];
		if (char === "`") {
			index = readTemplate(source, index).end;
			continue;
		}
		if (char === '"' || char === "'") {
			index = readQuoted(source, index, char).end;
			continue;
		}
		if (char === "{") depth += 1;
		if (char === "}") depth -= 1;
		index += 1;
	}
	return index;
}

function readQuoted(source: string, start: number, quote: string): { end: number; text: string } {
	let index = start + 1;
	let text = "";
	while (index < source.length && source[index] !== quote && source[index] !== "\n") {
		if (source[index] === "\\") {
			text += source.slice(index, index + 2);
			index += 2;
			continue;
		}
		text += source[index];
		index += 1;
	}
	return { end: index + 1, text };
}

/** Every string and template literal of a TypeScript file, comments skipped. */
function literalsOf(source: string): Literal[] {
	const literals: Literal[] = [];
	let index = 0;
	const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (char === "/" && next === "/") {
			const end = source.indexOf("\n", index);
			index = end === -1 ? source.length : end;
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
		} else if (char === "`") {
			const read = readTemplate(source, index);
			literals.push({ text: read.text, line: lineAt(index) });
			index = read.end;
		} else if (char === '"' || char === "'") {
			const read = readQuoted(source, index, char);
			literals.push({ text: read.text, line: lineAt(index) });
			index = read.end;
		} else {
			index += 1;
		}
	}
	return literals;
}

/** True when the literal is (a fragment of) a SQL statement. */
const SQL_MARKER =
	/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|EXISTS|VALUES|RETURNING|ON CONFLICT|ORDER BY|GROUP BY)\b/;

/** SQL text without its single-quoted string literals. */
function withoutStrings(sql: string): string {
	return sql.replace(/'(?:[^']|'')*'/g, "''");
}

const LOWERCASE_KEYWORDS =
	/\b(select|from|where|join|inner|left|cross|insert|into|values|update|set|delete|order|group|by|having|limit|offset|union|returning|with|distinct|exists|between|case|when|then|else|end|and|or|not|null|is|in|as|on|conflict|do|nothing|ignore|asc|desc)\b/;

const UPPERCASE_FUNCTIONS =
	/\b(COUNT|MAX|MIN|SUM|AVG|TOTAL|COALESCE|IFNULL|NULLIF|IIF|LENGTH|LOWER|UPPER|INSTR|SUBSTR|TRIM|ABS|ROUND|STRFTIME|DATE|DATETIME|TYPEOF|PRINTF|GROUP_CONCAT|JSON_[A-Z_]+)\s*\(/;

const TABLES = new Set<string>(Object.keys(TABLE_COLUMNS));

function isTable(name: string): name is TableName {
	return TABLES.has(name);
}

/** Uppercase words that may follow a table name where an alias could stand. */
function violationsOf(sql: string): string[] {
	const problems: string[] = [];
	const text = withoutStrings(sql);
	if (/\bSELECT\s+(DISTINCT\s+)?\*|\bRETURNING\s+\*/.test(text)) {
		problems.push("SELECT * / RETURNING *: name the columns (columnList)");
	}
	const lower = LOWERCASE_KEYWORDS.exec(text);
	if (lower !== null) problems.push(`lowercase keyword "${lower[1]}"`);
	const upperFunction = UPPERCASE_FUNCTIONS.exec(text);
	if (upperFunction !== null) problems.push(`uppercase function "${upperFunction[1]}("`);
	for (const match of text.matchAll(
		/\b(FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b(\s+AS\s+([a-z_][a-z0-9_]*))?(\s+([a-z_][a-z0-9_]*))?/g,
	)) {
		const table = match[2] ?? "";
		if (!isTable(table)) continue;
		const alias = match[4];
		const bare = match[6];
		if (alias === undefined && bare !== undefined && bare !== "__expr__") {
			problems.push(`alias "${bare}" of ${table} needs AS`);
		}
		const canonical = TABLE_ALIASES[table];
		if (alias !== undefined && alias !== canonical && !alias.startsWith(`${canonical}_`)) {
			problems.push(
				`${table} AS ${alias}: canonical alias is ${canonical} (or ${canonical}_<role>)`,
			);
		}
	}
	for (const match of text.matchAll(/\)\s+([a-z_][a-z0-9_]*)\b/g)) {
		const word = match[1] ?? "";
		if (word !== "__expr__") problems.push(`alias "${word}" after ")" needs AS`);
	}
	return problems;
}

describe("SQL conventions (docs/database/conventions.md)", () => {
	it("holds for every SQL string in the application's SQL code", () => {
		const problems: string[] = [];
		for (const file of sqlSourceFiles()) {
			const source = readFileSync(file, "utf8");
			for (const literal of literalsOf(source)) {
				if (!SQL_MARKER.test(withoutStrings(literal.text))) continue;
				for (const problem of violationsOf(literal.text)) {
					problems.push(`${relative(ROOT, file)}:${literal.line}: ${problem}`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	it("catches the violations it is meant to catch", () => {
		expect(violationsOf("SELECT * FROM articles WHERE owner_id = ?")).toEqual([
			"SELECT * / RETURNING *: name the columns (columnList)",
		]);
		expect(violationsOf("SELECT a.title FROM articles a WHERE a.owner_id = ?")).toEqual([
			'alias "a" of articles needs AS',
		]);
		expect(violationsOf("SELECT x.title FROM articles AS x")).toEqual([
			"articles AS x: canonical alias is a (or a_<role>)",
		]);
		expect(violationsOf("select title FROM articles")).toEqual(['lowercase keyword "select"']);
		expect(violationsOf("SELECT COUNT(*) AS n FROM articles")).toEqual([
			'uppercase function "COUNT("',
		]);
		expect(violationsOf("SELECT 1 FROM json_each(?) incoming")).toEqual([
			'alias "incoming" after ")" needs AS',
		]);
		expect(
			violationsOf(
				"SELECT erc_fact.body_json FROM equity_record AS erc_fact WHERE erc_fact.kind = 'select from'",
			),
		).toEqual([]);
	});
});
