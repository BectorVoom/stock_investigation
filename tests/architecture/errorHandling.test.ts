import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Mechanical checks of docs/rule/error_handling.md for the TypeScript
 * sources. Each rule names the one shared helper that replaces the pattern it
 * forbids, so a failure message says what to use instead.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");
const SOURCE_ROOTS = ["apps", "packages"];
const SOURCE_FILE = /\.(ts|tsx)$/;

/**
 * Packages that may not import `@research/domain` (tests/architecture/boundaryRules.ts):
 * the reusable widget grid (ADR-0019) and the standalone Home MCP server. They keep their
 * own local equivalents of the shared helpers.
 */
const STANDALONE_PREFIXES = ["apps/mcp/src/", "packages/widget-grid/src/"];

interface SourceFile {
	readonly path: string;
	readonly text: string;
}

function collect(directory: string, files: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) collect(path, files);
		else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !entry.name.includes(".test.")) {
			files.push(path);
		}
	}
	return files;
}

/** Production TypeScript under apps/<name>/src and packages/<name>/src. */
const SOURCES: readonly SourceFile[] = SOURCE_ROOTS.flatMap((root) =>
	collect(join(REPO_ROOT, root)),
)
	.map((absolute) => ({
		path: absolute
			.slice(REPO_ROOT.length + 1)
			.split("\\")
			.join("/"),
		text: readFileSync(absolute, "utf8"),
	}))
	.filter((file) => /^(apps|packages)\/[^/]+\/src\//.test(file.path));

const isStandalone = (path: string): boolean =>
	STANDALONE_PREFIXES.some((prefix) => path.startsWith(prefix));

function lineOf(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

/** `path:line` for every match of `pattern` outside the allowed files. */
function offenders(pattern: RegExp, allowed: (path: string) => boolean): string[] {
	const found: string[] = [];
	for (const file of SOURCES) {
		if (allowed(file.path)) continue;
		for (const match of file.text.matchAll(pattern)) {
			found.push(`${file.path}:${lineOf(file.text, match.index)}`);
		}
	}
	return found;
}

/** The text between the `{` at `open` and its matching `}` (catch bodies hold no stray braces). */
function blockBody(text: string, open: number): string {
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		const char = text[index];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(open + 1, index);
		}
	}
	return text.slice(open + 1);
}

describe("error handling rules (docs/rule/error_handling.md)", () => {
	it("scans the production sources", () => {
		// Guards the scanner itself: an empty file list would pass every rule below.
		expect(SOURCES.length).toBeGreaterThan(300);
		expect(SOURCES.some((file) => file.path === "packages/domain/src/thrown.ts")).toBe(true);
	});

	it("never leaves a catch block empty: a discard says why in a comment", () => {
		const found: string[] = [];
		for (const file of SOURCES) {
			for (const match of file.text.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
				const body = blockBody(file.text, match.index + match[0].length - 1);
				if (body.trim() === "") found.push(`${file.path}:${lineOf(file.text, match.index)}`);
			}
		}
		expect(found).toEqual([]);
	});

	it("never discards a promise rejection without a comment", () => {
		const found: string[] = [];
		const discard = /\.catch\(\s*\(\)\s*=>\s*(?:undefined|null|\{\s*\})\s*\)/g;
		for (const file of SOURCES) {
			const lines = file.text.split("\n");
			for (const match of file.text.matchAll(discard)) {
				const line = lineOf(file.text, match.index);
				const nearby = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
				if (!nearby.includes("//")) found.push(`${file.path}:${line}`);
			}
		}
		expect(found).toEqual([]);
	});

	it("labels a thrown value with thrownName / thrownCode / describeThrown only", () => {
		// `x instanceof Error ? x.name : …` and `x.constructor.name` hand-roll the label;
		// the shared helpers also reject names and codes that carry free text (SEC-010).
		const handRolled = /instanceof Error\s*\?\s*\w+\.(?:name|constructor)\b/g;
		expect(offenders(handRolled, isStandalone)).toEqual([]);
	});

	it("parses JSON text with parseJson / parseJsonOrNull only", () => {
		const allowed = (path: string): boolean =>
			path === "packages/domain/src/json.ts" || isStandalone(path);
		expect(offenders(/\bJSON\.parse\(/g, allowed)).toEqual([]);
	});

	it("parses URLs that may be malformed with parseUrl, not try { new URL }", () => {
		const tryNewUrl =
			/\btry\s*\{\s*(?:(?:const|let)\s+\w+(?::[^=]+)?=\s*|\w+\s*=\s*|return\s+)?new URL\(/g;
		const allowed = (path: string): boolean =>
			path === "packages/domain/src/url.ts" || isStandalone(path);
		expect(offenders(tryNewUrl, allowed)).toEqual([]);
	});

	it("keeps one copy of the thrown-value labels", () => {
		const definitions = /\bfunction\s+(?:describeError|describeThrown|thrownName|thrownCode)\b/g;
		const allowed = (path: string): boolean => path === "packages/domain/src/thrown.ts";
		expect(offenders(definitions, allowed)).toEqual([]);
	});
});

/** Production Rust: crates/<name>/src, without test modules, test files or the testkit crate. */
function rustProductionFiles(): readonly SourceFile[] {
	const crates = join(REPO_ROOT, "crates");
	const files: SourceFile[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "tests") walk(path);
			} else if (entry.name.endsWith(".rs")) {
				const relative = path
					.slice(REPO_ROOT.length + 1)
					.split("\\")
					.join("/");
				const isTestFile =
					entry.name === "tests.rs" ||
					entry.name.endsWith("_tests.rs") ||
					entry.name === "test_support.rs";
				if (!isTestFile) files.push({ path: relative, text: readFileSync(path, "utf8") });
			}
		}
	};
	for (const entry of readdirSync(crates, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "research-runner-testkit") continue;
		walk(join(crates, entry.name, "src"));
	}
	return files;
}

describe("error handling rules for the Rust runner (docs/rule/error_handling.md)", () => {
	it("never discards a value with `let _ =` without saying why", () => {
		// Production code cannot unwrap or panic (Cargo.toml lints), so `let _ =` is the one
		// way left to drop an error silently. A comment on the line or the three above it
		// says why dropping it is safe; `TurnSender::send_closing` names the commonest case.
		const files = rustProductionFiles();
		expect(files.length).toBeGreaterThan(100);
		const found: string[] = [];
		for (const file of files) {
			const lines = file.text.split("\n");
			for (const [index, line] of lines.entries()) {
				if (line.trim().startsWith("#[cfg(test)]")) break;
				if (!/\blet _ =(?:\s|$)/.test(line)) continue;
				const context = lines.slice(Math.max(0, index - 3), index + 1);
				if (!context.some((text) => text.includes("//"))) {
					found.push(`${file.path}:${index + 1}`);
				}
			}
		}
		expect(found).toEqual([]);
	});
});
