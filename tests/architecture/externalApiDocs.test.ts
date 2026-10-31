/**
 * The external API documents in `docs/external-apis/` (conventions.md, ADR-0047):
 * each has the mandatory sections and Overview properties, a subsection per
 * endpoint, request, success and error examples that each say how they were
 * verified, names only code paths that exist, and is linked from the index
 * once. Production code may name only hosts some document lists (or the README
 * lists as "not an API call"), and may build a URL with a computed host only in
 * a file some document lists, so a new integration fails here until it is
 * documented.
 *
 * Not checked: whether the prose matches the code, and whether an example
 * still matches today's production. The `*DocExamples.test.ts` files parse the
 * marked examples with the runner's parsers; the rest is reviewed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");
const DOCS_DIR = join(REPO, "docs/external-apis");
const APIS_DIR = join(DOCS_DIR, "apis");
const README = readFileSync(join(DOCS_DIR, "README.md"), "utf8");
const TEMPLATE = readFileSync(join(DOCS_DIR, "api-template.md"), "utf8");

const REQUIRED_SECTIONS = [
	"1. Overview",
	"2. Input Parameters",
	"3. Output Parameters",
	"4. Error Handling",
	"5. Examples",
	"6. Data Mapping",
	"7. Maintenance",
] as const;

const OVERVIEW_PROPERTIES = [
	"Provider",
	"Purpose",
	"Hosts",
	"Endpoints",
	"Authentication",
	"Configuration",
	"Usage Limits",
	"Called By",
	"Code",
	"Official Documentation",
	"Last Verified",
] as const;

const OUTPUT_COLUMNS = ["Field", "Type", "Nullable", "Optional", "Read", "Description"];
const MAINTENANCE_SUBSECTIONS = [
	"Known differences between the runners",
	"Open issues",
	"Verification log",
];

const VERIFIED_LINE = /^Verified: (live|fixture|spec|unverified), \d{4}-\d{2}-\d{2}, \S.*$/;
const EXAMPLE_MARKER = /^<!-- example: ([a-z0-9][a-z0-9-]*) -->$/;
const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE|HEAD) \S+$/;
const HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/;
const REPO_PATH =
	/^(apps|packages|crates|tests|scripts|infra|db|docs|vectors|formal|examples)\/[\w./@-]+$/;
/**
 * Git-ignored files each machine creates for itself, so a clean checkout has
 * none: a document may name one when its tracked template exists.
 */
const LOCAL_ONLY_FILES: ReadonlyMap<string, string> = new Map([
	["apps/runner/.env", "apps/runner/.env.example"],
]);

interface ApiDoc {
	readonly file: string;
	readonly api: string;
	readonly text: string;
	readonly lines: readonly string[];
}

const docs: readonly ApiDoc[] = readdirSync(APIS_DIR)
	.filter((name) => name.endsWith(".md"))
	.sort()
	.map((file) => {
		const text = readFileSync(join(APIS_DIR, file), "utf8");
		return { file, api: file.replace(/\.md$/, ""), text, lines: text.split("\n") };
	});

/** Splits a Markdown table row into trimmed cells; `\|` is a literal pipe. */
function cells(row: string): string[] {
	const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
	return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** The text of every `code span`. */
function codeSpans(text: string): string[] {
	return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** Lines of a level-2 section (heading excluded), or null when absent. */
function section(lines: readonly string[], title: string): readonly string[] | null {
	const start = lines.indexOf(`## ${title}`);
	if (start < 0) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith("## "));
	return end < 0 ? rest : rest.slice(0, end);
}

/** Level-3 subsections of a section: heading text → its lines. */
function subsections(lines: readonly string[]): Map<string, readonly string[]> {
	const found = new Map<string, string[]>();
	let current: string[] | null = null;
	for (const line of lines) {
		if (line.startsWith("### ")) {
			current = [];
			found.set(line.slice(4).trim(), current);
		} else current?.push(line);
	}
	return found;
}

function overview(doc: ApiDoc): Map<string, string> {
	const rows = new Map<string, string>();
	for (const line of section(doc.lines, "1. Overview") ?? []) {
		if (!line.startsWith("|")) continue;
		const [property, value] = cells(line);
		if (property !== undefined && value !== undefined) rows.set(property, value);
	}
	return rows;
}

function hostsOf(doc: ApiDoc): string[] {
	return codeSpans(overview(doc).get("Hosts") ?? "").filter((span) => HOSTNAME.test(span));
}

function endpointsOf(doc: ApiDoc): string[] {
	return codeSpans(overview(doc).get("Endpoints") ?? "").filter((span) => ENDPOINT.test(span));
}

/** Rows between two HTML comment markers of the README. */
function readmeBlock(name: string): string[] {
	const start = README.indexOf(`<!-- ${name}:start -->`);
	const end = README.indexOf(`<!-- ${name}:end -->`);
	if (start < 0 || end < start) return [];
	return README.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));
}

// ---------------------------------------------------------------------------
// Fenced code blocks of the Examples section.

interface Block {
	readonly language: string;
	readonly body: string;
	/** Line index of the opening fence within the lines given. */
	readonly start: number;
	readonly marker: string | null;
	/** First line after the block that is not blank and not a marker. */
	readonly following: string;
}

function blocks(lines: readonly string[]): { blocks: Block[]; problems: string[] } {
	const found: Block[] = [];
	const problems: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const fence = /^```(\S*)\s*$/.exec(lines[index] ?? "");
		if (!fence) {
			index += 1;
			continue;
		}
		const close = lines.findIndex((text, at) => at > index && text.startsWith("```"));
		if (close < 0) {
			problems.push(`unclosed code block at line ${index}`);
			break;
		}
		const markerMatch = EXAMPLE_MARKER.exec(lines[index - 1] ?? "");
		let next = close + 1;
		while (
			next < lines.length &&
			((lines[next] ?? "").trim() === "" || EXAMPLE_MARKER.test(lines[next] ?? ""))
		) {
			next += 1;
		}
		found.push({
			language: fence[1] ?? "",
			body: lines.slice(index + 1, close).join("\n"),
			start: index,
			marker: markerMatch ? (markerMatch[1] ?? null) : null,
			following: lines[next] ?? "",
		});
		index = close + 1;
	}
	return { blocks: found, problems };
}

function statusOf(block: Block): number | null {
	if (block.language !== "http") return null;
	const status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(block.body);
	return status ? Number(status[1]) : null;
}

function isRequest(block: Block): boolean {
	return block.language === "http" && /^(GET|POST|PUT|PATCH|DELETE|HEAD) \S/.test(block.body);
}

/** Problems with the examples of one subsection of section 5. */
function exampleProblems(lines: readonly string[]): string[] {
	const { blocks: found, problems } = blocks(lines);
	for (const [at, block] of found.entries()) {
		const previous = found[at - 1];
		const bodyOfPrevious =
			previous !== undefined &&
			statusOf(previous) !== null &&
			previous.following.startsWith("```") &&
			block.language !== "http";
		if (block.language === "") problems.push("code block without a language");
		if (statusOf(block) !== null && /\n\s*\n\s*\S/.test(block.body)) {
			problems.push(`"${block.body.split("\n")[0] ?? ""}": put the response body in its own block`);
		}
		if (block.following.startsWith("```")) {
			// Only a response's status-line block may hand its verification line to its body.
			if (statusOf(block) === null || found[at + 1]?.language === "http") {
				problems.push(`"${block.body.split("\n")[0] ?? ""}" needs its own Verified line`);
			}
			continue;
		}
		if (!VERIFIED_LINE.test(block.following)) {
			problems.push(`example "${block.body.split("\n")[0] ?? ""}" lacks a "Verified: ..." line`);
		}
		const status = bodyOfPrevious ? statusOf(previous) : null;
		if (
			block.language === "json" &&
			status !== null &&
			status >= 200 &&
			status < 300 &&
			block.marker === null
		) {
			problems.push(`2xx json body after "HTTP ${status}" has no <!-- example: id --> marker`);
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Source scanning: string literals outside comments and Rust test modules.

interface Literal {
	readonly start: number;
	readonly text: string;
}

interface Lexed {
	/** The source with comments and string contents blanked (same length, newlines kept). */
	readonly masked: string;
	readonly literals: readonly Literal[];
}

/**
 * A small lexer for TypeScript and Rust: enough to tell comments from code
 * and find string literals. TypeScript `"`/`'` strings end at a newline, so a
 * regular expression literal holding a quote cannot desynchronise more than
 * one line.
 */
function lexSource(text: string, language: "ts" | "rs", blankStrings = true): Lexed {
	const out = text.split("");
	const literals: Literal[] = [];
	const blank = (from: number, to: number) => {
		for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " ";
	};
	let at = 0;
	while (at < text.length) {
		const char = text[at];
		const next = text[at + 1];
		if (char === "/" && next === "/") {
			const end = text.indexOf("\n", at);
			const stop = end < 0 ? text.length : end;
			blank(at, stop);
			at = stop;
		} else if (char === "/" && next === "*") {
			let depth = 1;
			let scan = at + 2;
			while (scan < text.length && depth > 0) {
				if (text.startsWith("*/", scan)) {
					depth -= 1;
					scan += 2;
				} else if (language === "rs" && text.startsWith("/*", scan)) {
					depth += 1;
					scan += 2;
				} else scan += 1;
			}
			blank(at, scan);
			at = scan;
		} else if (
			language === "rs" &&
			char === "r" &&
			/^r#*"/.test(text.slice(at, at + 40)) &&
			!/\w/.test(text[at - 1] ?? "")
		) {
			const hashes = /^r(#*)"/.exec(text.slice(at, at + 40))?.[1] ?? "";
			const open = at + 2 + hashes.length;
			const closeAt = text.indexOf(`"${hashes}`, open);
			const stop = closeAt < 0 ? text.length : closeAt;
			literals.push({ start: open, text: text.slice(open, stop) });
			if (blankStrings) blank(open, stop);
			at = stop + 1 + hashes.length;
		} else if (char === "`" && language === "ts") {
			const { end, holes } = scanTemplate(text, at);
			literals.push({ start: at + 1, text: text.slice(at + 1, end) });
			let from = at + 1;
			for (const [holeStart, holeEnd] of holes) {
				if (blankStrings) blank(from, holeStart);
				// An interpolation is code: lex it in place, offsetting its literals.
				const inner = lexSource(text.slice(holeStart, holeEnd), "ts", blankStrings);
				for (let offset = 0; offset < inner.masked.length; offset += 1) {
					out[holeStart + offset] = inner.masked[offset] ?? " ";
				}
				for (const literal of inner.literals) {
					literals.push({ start: holeStart + literal.start, text: literal.text });
				}
				from = holeEnd;
			}
			if (blankStrings) blank(from, end);
			at = end + 1;
		} else if (char === '"' || char === "`" || (char === "'" && language === "ts")) {
			let scan = at + 1;
			while (scan < text.length && text[scan] !== char) {
				if (text[scan] === "\\") scan += 1;
				else if (text[scan] === "\n" && language === "ts" && char !== "`") break;
				scan += 1;
			}
			literals.push({ start: at + 1, text: text.slice(at + 1, scan) });
			if (blankStrings) blank(at + 1, scan);
			at = scan + 1;
		} else if (char === "'" && language === "rs") {
			// A char literal ('a', '\n', '\u{1F600}'), otherwise a lifetime.
			const charLiteral = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.exec(
				text.slice(at, at + 12),
			);
			at += charLiteral ? charLiteral[0].length : 1;
		} else at += 1;
	}
	return { masked: out.join(""), literals };
}

/**
 * The end (closing backtick) of the TypeScript template literal opening at
 * `start`, and the `${…}` interpolations inside it as [from, to) ranges.
 */
function scanTemplate(
	text: string,
	start: number,
): { end: number; holes: Array<readonly [number, number]> } {
	const holes: Array<readonly [number, number]> = [];
	let at = start + 1;
	while (at < text.length) {
		const char = text[at];
		if (char === "\\") at += 2;
		else if (char === "`") return { end: at, holes };
		else if (char === "$" && text[at + 1] === "{") {
			let depth = 1;
			let scan = at + 2;
			while (scan < text.length && depth > 0) {
				const inner = text[scan];
				if (inner === "/" && text[scan + 1] === "/") {
					const lineEnd = text.indexOf("\n", scan);
					scan = lineEnd < 0 ? text.length : lineEnd;
				} else if (inner === "/" && text[scan + 1] === "*") {
					const commentEnd = text.indexOf("*/", scan + 2);
					scan = commentEnd < 0 ? text.length : commentEnd + 1;
				} else if (inner === "{") depth += 1;
				else if (inner === "}") depth -= 1;
				else if (inner === "`") scan = scanTemplate(text, scan).end;
				else if (inner === '"' || inner === "'") {
					let close = scan + 1;
					while (close < text.length && text[close] !== inner && text[close] !== "\n") {
						close += text[close] === "\\" ? 2 : 1;
					}
					scan = close;
				}
				if (depth > 0) scan += 1;
			}
			holes.push([at + 2, scan]);
			at = scan + 1;
		} else at += 1;
	}
	return { end: text.length, holes };
}

/** Ranges of `#[cfg(test)] mod name { ... }` blocks in masked Rust source. */
function rustTestModules(masked: string): Array<readonly [number, number]> {
	const ranges: Array<readonly [number, number]> = [];
	for (const match of masked.matchAll(
		/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g,
	)) {
		let depth = 0;
		let at = (match.index ?? 0) + match[0].length - 1;
		for (; at < masked.length; at += 1) {
			if (masked[at] === "{") depth += 1;
			else if (masked[at] === "}") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		ranges.push([match.index ?? 0, at + 1]);
	}
	return ranges;
}

interface SourceHosts {
	/** Hosts named in literals: `https://host` or a `*_HOST` constant. */
	readonly hosts: readonly string[];
	/** True when a literal builds a URL whose host is computed. */
	readonly computedHost: boolean;
}

function hostsInSource(text: string, language: "ts" | "rs"): SourceHosts {
	const { masked, literals } = lexSource(text, language);
	const skipped = language === "rs" ? rustTestModules(masked) : [];
	const hosts: string[] = [];
	/** `*_HOST` constants of this file that hold a hostname literal. */
	const hostConstants = new Set<string>();
	const interpolated: string[] = [];
	let computedHost = false;
	for (const literal of literals) {
		if (skipped.some(([from, to]) => literal.start >= from && literal.start < to)) continue;
		for (const match of literal.text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
			hosts.push((match[1] ?? "").toLowerCase().replace(/\.$/, ""));
		}
		// `https://${expr}` (TypeScript) or `https://{…}` (Rust format string).
		for (const match of literal.text.matchAll(/https?:\/\/(?:\$\{([^}]*)\}|\{([^}]*)\})/g)) {
			interpolated.push((match[1] ?? match[2] ?? "").trim());
		}
		// `"https://" + host`, `"https://api." + domain`: the host is completed by concatenation.
		const closing = literal.start + literal.text.length + 1;
		if (/https?:\/\/[a-z0-9.-]*$/i.test(literal.text) && /^\s*\+/.test(masked.slice(closing))) {
			computedHost = true;
		}
		const before = masked.slice(Math.max(0, literal.start - 100), literal.start - 1);
		const constant = /([A-Z_]*HOST[A-Z_]*)\s*(?::\s*(?:&(?:'static\s+)?str|string))?\s*=\s*$/.exec(
			before,
		);
		if (constant && HOSTNAME.test(literal.text)) {
			hosts.push(literal.text.toLowerCase());
			hostConstants.add(constant[1] ?? "");
		}
	}
	// An interpolated name is a known host only when this file binds it to a hostname literal.
	if (interpolated.some((name) => !hostConstants.has(name))) computedHost = true;
	return { hosts, computedHost };
}

const SOURCE_ROOTS = ["apps", "packages", "crates"];
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"test",
	"tests",
	"target",
	"fixtures",
]);

function sourceFiles(directory: string, files: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		// Test-support crates (`*-testkit`) and modules build fake servers, not integrations.
		if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.endsWith("-testkit")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) sourceFiles(path, files);
		else if (
			/\.(ts|tsx|rs)$/.test(entry.name) &&
			!/\.test\.|(^|_)tests?\.rs$|^test_support\.rs$/.test(entry.name) &&
			path.includes("/src/")
		) {
			files.push(path);
		}
	}
	return files;
}

/** Files whose hosts are data (README: "Files whose hosts are data"). */
function dataFiles(): Set<string> {
	const line = README.split("\n").find((text) => text.startsWith("Files whose hosts are data"));
	return new Set(codeSpans(line ?? "").filter((span) => REPO_PATH.test(span)));
}

function scanProduction(): { hosts: Map<string, Set<string>>; computed: Set<string> } {
	const skip = dataFiles();
	const hosts = new Map<string, Set<string>>();
	const computed = new Set<string>();
	for (const root of SOURCE_ROOTS) {
		for (const path of sourceFiles(join(REPO, root))) {
			const file = relative(REPO, path);
			if (skip.has(file)) continue;
			const found = hostsInSource(readFileSync(path, "utf8"), file.endsWith(".rs") ? "rs" : "ts");
			for (const host of found.hosts) {
				const files = hosts.get(host) ?? new Set<string>();
				files.add(file);
				hosts.set(host, files);
			}
			if (found.computedHost) computed.add(file);
		}
	}
	return { hosts, computed };
}

function docExampleTests(directory: string, files: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "fixtures") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) docExampleTests(path, files);
		else if (/DocExamples\.test\.ts$/.test(entry.name)) files.push(path);
	}
	return files;
}

/**
 * `api\nid` of every `docExampleJson("api", "id")` / `docExampleText(...)` call
 * in code: not in a comment or a string, but inside a template literal's `${…}`.
 */
function exampleReads(text: string): string[] {
	const { masked, literals } = lexSource(text, "ts");
	const at = new Map(literals.map((literal) => [literal.start, literal]));
	const reads: string[] = [];
	for (const call of masked.matchAll(/\bdocExample(?:Json|Text)\(\s*/g)) {
		const api = at.get((call.index ?? 0) + call[0].length + 1);
		if (api === undefined) continue;
		const afterApi = api.start + api.text.length + 1;
		const separator = /^\s*,\s*/.exec(masked.slice(afterApi));
		const id = separator ? at.get(afterApi + separator[0].length + 1) : undefined;
		if (id !== undefined) reads.push(`${api.text}\n${id.text}`);
	}
	return reads;
}

// ---------------------------------------------------------------------------

describe("source scanner", () => {
	it("ignores comments and finds code after a block comment", () => {
		const text = [
			"// https://comment.example.org/",
			"/* https://block.example.org/ */ fetch('https://after.example.org/x');",
			"const total = a",
			'  * b; const u = "https://star-line.example.org";',
			"/**",
			" not a star line https://inside.example.org",
			" */",
		].join("\n");
		expect(hostsInSource(text, "ts").hosts).toEqual(["after.example.org", "star-line.example.org"]);
	});

	it("drops Rust test modules but not a #[cfg(test)] item before production code", () => {
		const text = [
			"struct S { #[cfg(test)] probe: u8, }",
			'const API_HOST: &str = "api.example.org";',
			"fn f<'a>(x: &'a str) -> char { 'x' }",
			'const RAW: &str = r#"https://raw.example.org/"#;',
			"#[cfg(test)]",
			"mod tests {",
			'    fn t() { let _ = "https://test-only.example.org/{}"; }',
			"}",
			'fn g() { format!("https://{}/x", host); }',
		].join("\n");
		const found = hostsInSource(text, "rs");
		expect(found.hosts).toEqual(["api.example.org", "raw.example.org"]);
		expect(found.computedHost).toBe(true);
	});

	it("treats an unbound constant and a concatenated host as computed", () => {
		expect(hostsInSource("f(`https://$" + "{API_URL}/v1`);", "ts").computedHost).toBe(true);
		expect(hostsInSource('f("https://" + host + "/v1");', "ts").computedHost).toBe(true);
	});

	it("detects partial-host concatenation and typed host constants", () => {
		expect(hostsInSource('f("https://api." + "new.example/v1");', "ts").computedHost).toBe(true);
		expect(hostsInSource('const API_HOST: string = "new.example.org";', "ts").hosts).toEqual([
			"new.example.org",
		]);
		expect(hostsInSource('const u = "https://whole.example.org";', "ts").computedHost).toBe(false);
	});

	it("counts only example reads in code", () => {
		const text = [
			'const note = \'docExampleJson("fred", "in-string")\';',
			'const t = `docExampleJson("fred", "in-template-text")`;',
			`const u = \`$\{docExampleText("fred", "in-interpolation")}\`;`,
			`const v = \`$\{ /* } */ docExampleJson("fred", "after-block-comment")}\`;`,
			`const w = \`$\{ // }\n docExampleJson("fred", "after-line-comment")}\`;`,
			'// docExampleJson("fred", "in-comment")',
			'/* docExampleJson("fred", "in-block") */',
			'docExampleJson("fred", "real");',
		].join("\n");
		expect(exampleReads(text)).toEqual([
			"fred\nin-interpolation",
			"fred\nafter-block-comment",
			"fred\nafter-line-comment",
			"fred\nreal",
		]);
	});

	it("treats a template literal with a constant host as named, with a variable host as computed", () => {
		expect(
			hostsInSource("const X_HOST = 'x.example.org'; f(`https://$" + "{X_HOST}/a`);", "ts"),
		).toEqual({
			hosts: ["x.example.org"],
			computedHost: false,
		});
		expect(hostsInSource("f(`https://$" + "{config.domain}/a`);", "ts").computedHost).toBe(true);
	});
});

describe("external API documents (docs/external-apis/conventions.md)", () => {
	it("has at least one document", () => {
		expect(docs.length).toBeGreaterThan(0);
	});

	it("links every document from the README index exactly once, and only existing ones", () => {
		const linked = readmeBlock("api-index").flatMap((row) =>
			[...row.matchAll(/\]\(apis\/([^)#]+\.md)\)/g)].map((match) => match[1] ?? ""),
		);
		expect([...linked].sort()).toEqual(docs.map((doc) => doc.file));
	});

	it("keeps the template's sections in sync with the checker", () => {
		const lines = TEMPLATE.split("\n");
		expect(lines.filter((line) => line.startsWith("## "))).toEqual(
			REQUIRED_SECTIONS.map((title) => `## ${title}`),
		);
		for (const property of OVERVIEW_PROPERTIES) expect(TEMPLATE).toContain(`| ${property} |`);
		expect(TEMPLATE).toContain(`| ${OUTPUT_COLUMNS.join(" | ")} |`);
	});

	for (const doc of docs) {
		describe(doc.file, () => {
			it("has the title line and the mandatory sections in order", () => {
				expect(doc.lines[0]).toMatch(/^# External API: \S/);
				expect(doc.lines.filter((line) => line.startsWith("## "))).toEqual(
					REQUIRED_SECTIONS.map((title) => `## ${title}`),
				);
				const maintenance = [...subsections(section(doc.lines, "7. Maintenance") ?? []).keys()];
				expect(maintenance).toEqual(MAINTENANCE_SUBSECTIONS);
			});

			it("fills every Overview property and leaves no placeholder", () => {
				const rows = overview(doc);
				expect(
					OVERVIEW_PROPERTIES.filter((property) => !(rows.get(property) ?? "").trim()),
				).toEqual([]);
				expect(doc.text.match(/\{\{[^}]*\}\}/g) ?? []).toEqual([]);
			});

			it("names only repository paths that exist", () => {
				const spans = codeSpans(doc.text)
					.map((span) => span.replace(/:\d+(-\d+)?$/, "").replace(/#.*$/, ""))
					.filter((span) => REPO_PATH.test(span) && !span.includes("*") && !span.includes("<"));
				expect(
					[...new Set(spans)].filter(
						(span) => !existsSync(join(REPO, LOCAL_ONLY_FILES.get(span) ?? span)),
					),
				).toEqual([]);
				expect(codeSpans(overview(doc).get("Code") ?? "").length).toBeGreaterThan(0);
			});

			it("has a subsection per Overview endpoint in sections 2, 3 and 5, and an error example", () => {
				const endpoints = endpointsOf(doc);
				expect(endpoints.length).toBeGreaterThan(0);
				const missing: string[] = [];
				for (const title of ["2. Input Parameters", "3. Output Parameters", "5. Examples"]) {
					const headings = subsections(section(doc.lines, title) ?? []);
					for (const endpoint of endpoints) {
						if (!headings.has(endpoint)) missing.push(`${title}: ### ${endpoint}`);
					}
				}
				expect(missing).toEqual([]);
				const examples = subsections(section(doc.lines, "5. Examples") ?? []);
				const roles: string[] = [];
				for (const endpoint of endpoints) {
					const found = blocks(examples.get(endpoint) ?? []).blocks;
					if (!found.some(isRequest)) roles.push(`${endpoint}: no request example`);
					const success = found.some((block) => {
						const status = statusOf(block) ?? 0;
						// A redirect is the success answer of a browser endpoint (OAuth authorization).
						return status >= 200 && status < 400;
					});
					if (!success) roles.push(`${endpoint}: no successful response example`);
				}
				const errorStatuses = [...examples]
					.filter(([heading]) => heading.startsWith("Error response"))
					.flatMap(([, lines]) => blocks(lines).blocks.map(statusOf));
				if (!errorStatuses.some((status) => status !== null && status >= 400 && status <= 599)) {
					roles.push("no ### Error response with a 4xx or 5xx status line");
				}
				expect(roles).toEqual([]);
			});

			it("uses the output table columns", () => {
				const lines = section(doc.lines, "3. Output Parameters") ?? [];
				const headers = lines.filter(
					(line, at) => line.startsWith("| ") && (lines[at + 1] ?? "").startsWith("|---"),
				);
				expect(headers.length).toBeGreaterThan(0);
				expect(
					headers.filter((line) => cells(line).join("|") !== OUTPUT_COLUMNS.join("|")),
				).toEqual([]);
			});

			it("gives every example its own verification line and marks 2xx JSON bodies", () => {
				const problems: string[] = [];
				for (const [heading, lines] of subsections(section(doc.lines, "5. Examples") ?? [])) {
					for (const problem of exampleProblems(lines)) problems.push(`${heading}: ${problem}`);
				}
				expect(problems).toEqual([]);
			});

			it("parses every json block, keeps markers in section 5, and lists unverified examples as open issues", () => {
				const all = blocks(doc.lines);
				const invalid = all.blocks
					.filter((block) => block.language === "json")
					.filter((block) => {
						try {
							JSON.parse(block.body);
							return false;
						} catch {
							return true;
						}
					})
					.map((block) => `json block at line ${block.start + 1}`);
				expect([...all.problems, ...invalid]).toEqual([]);
				const examples = section(doc.lines, "5. Examples") ?? [];
				const outside = doc.lines.filter(
					(line) => EXAMPLE_MARKER.test(line) && !examples.includes(line),
				);
				expect(outside).toEqual([]);
				const dangling = doc.lines.filter(
					(line, at) => EXAMPLE_MARKER.test(line) && !(doc.lines[at + 1] ?? "").startsWith("```"),
				);
				expect(dangling).toEqual([]);
				if (doc.lines.some((line) => line.startsWith("Verified: unverified,"))) {
					const issues =
						subsections(section(doc.lines, "7. Maintenance") ?? []).get("Open issues") ?? [];
					expect(issues.join("\n").trim()).not.toMatch(/^None\.?$/);
				}
			});
		});
	}

	it("uses each example id once, and a DocExamples test reads every one", () => {
		const marked = docs.flatMap((doc) =>
			doc.lines.flatMap((line) => {
				const match = EXAMPLE_MARKER.exec(line);
				return match ? [{ api: doc.api, id: match[1] ?? "" }] : [];
			}),
		);
		const ids = marked.map((entry) => entry.id);
		expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
		const files = ["packages", "apps", "tests"].flatMap((root) =>
			docExampleTests(join(REPO, root)),
		);
		const reads = new Set(files.flatMap((path) => exampleReads(readFileSync(path, "utf8"))));
		const unread = marked.filter(({ api, id }) => !reads.has(`${api}\n${id}`));
		expect(unread.map(({ api, id }) => `${api}: ${id}`)).toEqual([]);
		const skipping = files.filter((path) =>
			/\.(skip|todo|only|skipIf|runIf)\b/.test(lexSource(readFileSync(path, "utf8"), "ts").masked),
		);
		expect(skipping.map((path) => relative(REPO, path))).toEqual([]);
	});

	it("documents every host production code names, and lists no host the code does not name", () => {
		const { hosts } = scanProduction();
		const documented = new Set(docs.flatMap(hostsOf));
		const notCalls = new Set(
			readmeBlock("non-api-hosts").flatMap((row) => codeSpans(cells(row)[0] ?? "")),
		);
		const undocumented = [...hosts]
			.filter(([host]) => !documented.has(host) && !notCalls.has(host))
			.map(([host, files]) => `${host} (${[...files].join(", ")})`);
		expect(undocumented).toEqual([]);
		expect([...documented, ...notCalls].filter((host) => !hosts.has(host))).toEqual([]);
	});

	it("lists under Code every file that builds a URL with a computed host", () => {
		const { computed } = scanProduction();
		const listed = new Set(docs.flatMap((doc) => codeSpans(overview(doc).get("Code") ?? "")));
		expect([...computed].filter((file) => !listed.has(file)).sort()).toEqual([]);
	});
});
