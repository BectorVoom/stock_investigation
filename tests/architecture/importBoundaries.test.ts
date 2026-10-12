import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type BoundaryConfig,
	checkBoundaries,
	extractImports,
	findCycles,
	formatViolation,
	isNodeBuiltin,
	type SourceText,
	type Violation,
	type ViolationCode,
} from "./boundaryChecker.ts";
import { PACKAGE_RULES, WORKSPACE_SCOPES } from "./boundaryRules.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKSPACE_PARENTS = ["packages", "apps"] as const;
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;

/* ---------- Reading the real tree ---------- */

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

function listDirectories(directory: string): readonly string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

/** Every source file below `directory`; an absent directory simply has none. */
function collectSourceFiles(directory: string): readonly string[] {
	if (!existsSync(directory)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== "dist") {
				files.push(...collectSourceFiles(path));
			}
		} else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
			files.push(path);
		}
	}
	return files.sort();
}

interface WorkspacePackage {
	readonly root: string;
	readonly name: string | null;
	readonly dependencyNames: readonly string[];
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWorkspacePackages(): readonly WorkspacePackage[] {
	return WORKSPACE_PARENTS.flatMap((parent) =>
		listDirectories(join(REPO_ROOT, parent)).map((directory) => {
			const root = `${parent}/${directory}`;
			const manifestPath = join(REPO_ROOT, root, "package.json");
			if (!existsSync(manifestPath)) return { root, name: null, dependencyNames: [] };
			const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (!isRecord(manifest)) return { root, name: null, dependencyNames: [] };
			const dependencies = isRecord(manifest.dependencies)
				? Object.keys(manifest.dependencies)
				: [];
			return {
				root,
				name: typeof manifest.name === "string" ? manifest.name : null,
				dependencyNames: dependencies,
			};
		}),
	);
}

function readRepositorySources(packages: readonly WorkspacePackage[]): readonly SourceText[] {
	return packages.flatMap((workspacePackage) =>
		collectSourceFiles(join(REPO_ROOT, workspacePackage.root, "src")).map((absolutePath) => ({
			path: toPosix(relative(REPO_ROOT, absolutePath)),
			text: readFileSync(absolutePath, "utf8"),
		})),
	);
}

function report(violations: readonly Violation[]): string {
	return violations.map(formatViolation).join("\n");
}

/* ---------- The real tree ---------- */

describe("import boundaries of the repository", () => {
	const workspacePackages = readWorkspacePackages();
	const config: BoundaryConfig = {
		rules: PACKAGE_RULES,
		workspacePackages: new Map(
			workspacePackages.flatMap((entry) =>
				entry.name === null ? [] : [[entry.name, entry.root] as const],
			),
		),
		workspaceScopes: WORKSPACE_SCOPES,
	};
	const sources = readRepositorySources(workspacePackages);

	it("finds the foundation packages, so the check is not vacuous", () => {
		const analysed = new Set(sources.map((source) => source.path));
		for (const expected of [
			"packages/domain/src/index.ts",
			"packages/contracts/src/index.ts",
			"packages/agent-core/src/index.ts",
		]) {
			expect(analysed).toContain(expected);
		}
	});

	it("has a rule for every workspace package that contains source", () => {
		const ruled = new Set(PACKAGE_RULES.map((rule) => rule.root));
		const unruled = workspacePackages
			.filter((entry) => collectSourceFiles(join(REPO_ROOT, entry.root, "src")).length > 0)
			.map((entry) => entry.root)
			.filter((root) => !ruled.has(root));
		expect(unruled).toEqual([]);
	});

	it("names workspace packages the way the rule table refers to them", () => {
		for (const entry of workspacePackages) {
			if (entry.name === null) continue;
			const [parent = "", directory = ""] = entry.root.split("/");
			expect(entry.name).toBe(
				parent === "packages" ? `@research/${directory}` : `@app/${directory}`,
			);
		}
	});

	it("keeps packages/domain free of declared dependencies", () => {
		const domain = workspacePackages.find((entry) => entry.root === "packages/domain");
		expect(domain?.dependencyNames).toEqual([]);
	});

	it("has no forbidden import, deep import, package escape or import cycle", () => {
		const violations = checkBoundaries(sources, config);
		expect(report(violations)).toBe("");
	});

	it("passes on packages or directories that do not exist yet", () => {
		expect(collectSourceFiles(join(REPO_ROOT, "packages", "does-not-exist", "src"))).toEqual([]);
		expect(listDirectories(join(REPO_ROOT, "no-such-parent"))).toEqual([]);
		expect(checkBoundaries([], config)).toEqual([]);
	});
});

/* ---------- Self-test on synthetic sources ---------- */

/** A fixed workspace, independent of what currently exists on disk. */
const SYNTHETIC_CONFIG: BoundaryConfig = {
	rules: PACKAGE_RULES,
	workspacePackages: new Map([
		["@research/domain", "packages/domain"],
		["@research/contracts", "packages/contracts"],
		["@research/agent-core", "packages/agent-core"],
		["@research/application", "packages/application"],
		["@research/effects", "packages/effects"],
		["@research/ui-registry", "packages/ui-registry"],
		["@research/adapters", "packages/adapters"],
		["@app/api", "apps/api"],
		["@app/runner", "apps/runner"],
		["@app/web", "apps/web"],
	]),
	workspaceScopes: WORKSPACE_SCOPES,
};

function check(files: { readonly [path: string]: string }): readonly Violation[] {
	return checkBoundaries(
		Object.entries(files).map(([path, text]) => ({ path, text })),
		SYNTHETIC_CONFIG,
	);
}

/** Violations for a single file containing a single import of `specifier`. */
function importing(file: string, specifier: string): readonly Violation[] {
	return check({ [file]: `import x from ${JSON.stringify(specifier)};\nexport default x;\n` });
}

function expectViolation(
	violations: readonly Violation[],
	code: ViolationCode,
	specifier: string,
): void {
	const summary = violations.map((violation) => `${violation.code} ${violation.specifier}`);
	expect(summary).toContain(`${code} ${specifier}`);
}

describe("extractImports reads the AST, not text", () => {
	const source: SourceText = {
		path: "packages/domain/src/sample.ts",
		text: [
			'import a from "static-default";',
			'import { b } from "static-named";',
			'import type { C } from "type-only";',
			'import * as d from "namespace";',
			'import "side-effect";',
			'export { e } from "re-export";',
			'export * from "export-star";',
			'export type { F } from "export-type";',
			'import g = require("import-equals");',
			'const h = await import("dynamic");',
			'const i = require("common-js");',
			'type J = import("type-query").J;',
			"export const local = 1;",
			'// import "in-a-line-comment";',
			'/* import "in-a-block-comment"; */',
			"const text = 'import x from \"in-a-string\"';",
			'const template = `import("in-a-template")`;',
			"const computed = await import(text);",
			"export { local as renamed };",
		].join("\n"),
	};

	it("finds every import form with its line", () => {
		expect(
			extractImports(source)
				.filter((reference) => reference.specifier !== null)
				.map((reference) => [reference.line, reference.kind, reference.specifier]),
		).toEqual([
			[1, "import", "static-default"],
			[2, "import", "static-named"],
			[3, "import", "type-only"],
			[4, "import", "namespace"],
			[5, "import", "side-effect"],
			[6, "export-from", "re-export"],
			[7, "export-from", "export-star"],
			[8, "export-from", "export-type"],
			[9, "import-equals", "import-equals"],
			[10, "dynamic-import", "dynamic"],
			[11, "require", "common-js"],
			[12, "import-type", "type-query"],
		]);
	});

	it("ignores import-like text in comments, strings and templates", () => {
		const specifiers = extractImports(source).map((reference) => reference.specifier);
		for (const decoy of [
			"in-a-line-comment",
			"in-a-block-comment",
			"in-a-string",
			"in-a-template",
		]) {
			expect(specifiers).not.toContain(decoy);
		}
	});

	it("reports a computed dynamic import as unanalysable instead of skipping it", () => {
		expect(extractImports(source).filter((reference) => reference.specifier === null)).toEqual([
			{ file: source.path, specifier: null, line: 18, kind: "dynamic-import" },
		]);
	});

	it("parses TSX", () => {
		const tsx: SourceText = {
			path: "apps/web/src/App.tsx",
			text: 'import { createSignal } from "solid-js";\nexport const App = () => <div class="a">{createSignal(0)[0]()}</div>;\n',
		};
		expect(extractImports(tsx).map((reference) => reference.specifier)).toEqual(["solid-js"]);
	});

	it("recognizes Node builtins with and without the node: prefix", () => {
		for (const name of [
			"node:fs",
			"fs",
			"fs/promises",
			"path",
			"child_process",
			"net",
			"dns",
			"https",
			"os",
			"node:test",
		]) {
			expect(isNodeBuiltin(name)).toBe(true);
		}
		for (const name of ["zod", "hono", "solid-js", "@research/domain", "fsevents", "./fs"]) {
			expect(isNodeBuiltin(name)).toBe(false);
		}
	});
});

describe("self-test: a tree that follows the rules has no violations", () => {
	it("accepts every import the rule table allows", () => {
		const clean = check({
			"packages/domain/src/index.ts": 'export * from "./finance/per.ts";\n',
			"packages/domain/src/finance/per.ts":
				'import { ok } from "../result.ts";\nexport const per = ok;\n',
			"packages/domain/src/result.ts": "export const ok = 1;\n",
			"packages/contracts/src/index.ts":
				'import { z } from "zod";\nimport type { Result } from "@research/domain";\nexport { z };\nexport type R = Result;\n',
			"packages/agent-core/src/index.ts":
				'import "@research/contracts";\nimport "@research/domain";\nimport "zod";\n',
			"packages/application/src/index.ts":
				'import "@research/domain";\nimport "@research/contracts";\nimport "@research/agent-core";\nimport "zod";\n',
			"packages/effects/src/index.ts":
				'export * from "./logging.ts";\nexport * from "./errors.ts";\n',
			"packages/effects/src/logging.ts": 'import "@research/domain";\nimport "effect";\n',
			"packages/effects/src/errors.ts": 'import "@research/domain";\nimport "effect";\n',
			"packages/ui-registry/src/index.tsx":
				'import "@research/contracts";\nimport "@research/domain";\nimport "solid-js";\nimport "solid-js/web";\nimport "solid-js/store";\nimport "zod";\n',
			"packages/adapters/src/d1/index.ts":
				'import "@research/application";\nimport "@research/contracts";\nimport "@research/domain";\nimport "../runtime/index.ts";\nimport "../feed/index.ts";\nimport "../sql/index.ts";\n',
			"packages/adapters/src/sql/index.ts":
				'import "@research/application";\nimport "@research/contracts";\nimport "@research/domain";\nimport "zod";\n',
			"packages/adapters/src/sqlite/index.ts":
				'import "node:fs";\nimport "node:path";\nimport "node:sqlite";\nimport "../sql/index.ts";\n',
			"packages/adapters/src/runtime/index.ts": "export const runtime = 1;\n",
			"packages/adapters/src/feed/index.ts":
				'import "fast-xml-parser";\nimport "../runtime/index.ts";\n',
			"packages/adapters/src/worker/index.ts": 'import "jose";\nimport "../d1/index.ts";\n',
			"packages/adapters/src/node/index.ts":
				'import "node:fs";\nimport "node:child_process";\nimport "@research/agent-core";\nimport "@research/effects";\nimport "../feed/index.ts";\nimport "../providers/index.ts";\n',
			"packages/adapters/src/providers/index.ts":
				'import "@opencode-ai/sdk";\nimport "node:path";\n',
			"packages/adapters/src/tools/index.ts": 'import "../finance/index.ts";\nimport "node:dns";\n',
			"packages/adapters/src/finance/index.ts": 'import "zod";\n',
			"apps/api/src/app.ts":
				'import "@research/application";\nimport "@research/contracts";\nimport "@research/domain";\nimport "@research/effects";\nimport "effect";\nimport "@research/adapters/d1";\nimport "@research/adapters/sql";\nimport "@research/adapters/worker";\nimport "@research/adapters/feed";\nimport "@research/adapters/runtime";\nimport "hono";\nimport "hono/cors";\nimport "jose";\nimport "zod";\nimport "cloudflare:workers";\nimport "./routes/sources.ts";\n',
			"apps/api/src/routes/sources.ts": "export const routes = 1;\n",
			"apps/runner/src/main.ts":
				'import "@research/agent-core";\nimport "@research/application";\nimport "@research/contracts";\nimport "@research/domain";\nimport "@research/effects";\nimport "effect";\nimport "@research/adapters/node";\nimport "@research/adapters/providers";\nimport "@research/adapters/tools";\nimport "@research/adapters/finance";\nimport "@research/adapters/feed";\nimport "@research/adapters/runtime";\nimport "node:fs/promises";\nimport "node:process";\nimport "zod";\n',
			"apps/web/src/main.tsx":
				'import "@research/contracts";\nimport "@research/ui-registry";\nimport "@research/domain";\nimport "solid-js";\nimport "solid-js/web";\nimport "zod";\nimport "./index.css";\nimport logo from "./assets/logo.svg?url";\nexport default logo;\n',
		});
		expect(report(clean)).toBe("");
	});
});

describe("self-test: packages/domain imports nothing outside itself", () => {
	it.each([
		"zod",
		"fast-check",
		"node:fs",
		"fs",
		"path",
		"hono",
		"solid-js",
		"cloudflare:workers",
		"@research/contracts",
		"@research/application",
		"@research/domain",
	])("flags %s", (specifier) => {
		expectViolation(
			importing("packages/domain/src/a.ts", specifier),
			"IMPORT_NOT_ALLOWED",
			specifier,
		);
	});

	it("flags every import form, not only static imports", () => {
		const violations = check({
			"packages/domain/src/a.ts": [
				'export * from "zod";',
				'export const lazy = () => import("node:crypto");',
				'export type T = import("hono").Context;',
				'import type { Env } from "cloudflare:workers";',
				'const fs = require("fs");',
				"export const used: Env | typeof fs = fs;",
			].join("\n"),
		});
		for (const specifier of ["zod", "node:crypto", "hono", "cloudflare:workers", "fs"]) {
			expectViolation(violations, "IMPORT_NOT_ALLOWED", specifier);
		}
		expect(violations).toHaveLength(5);
	});

	it("flags a computed dynamic import, which could load anything", () => {
		const violations = check({
			"packages/domain/src/a.ts":
				'const name = "node:" + "fs";\nexport const load = () => import(name);\n',
		});
		expectViolation(violations, "NON_LITERAL_IMPORT", "<non-literal>");
	});

	it("reports the file and line of the offending import", () => {
		const [violation] = check({
			"packages/domain/src/deep/file.ts": '\n\nimport { z } from "zod";\nexport const s = z;\n',
		});
		expect(violation).toMatchObject({
			code: "IMPORT_NOT_ALLOWED",
			file: "packages/domain/src/deep/file.ts",
			specifier: "zod",
			line: 3,
		});
		expect(
			formatViolation(
				violation ?? { code: "DEEP_IMPORT", file: "", specifier: "", line: 0, detail: "" },
			),
		).toBe(
			'[IMPORT_NOT_ALLOWED] packages/domain/src/deep/file.ts:3 imports "zod" - packages/domain may import only: nothing outside its own directory',
		);
	});
});

describe("self-test: runtime-neutral packages", () => {
	it.each([
		["packages/contracts/src/a.ts", "@research/agent-core"],
		["packages/contracts/src/a.ts", "@research/application"],
		["packages/contracts/src/a.ts", "hono"],
		["packages/contracts/src/a.ts", "node:crypto"],
		["packages/contracts/src/a.ts", "solid-js"],
		["packages/agent-core/src/a.ts", "@research/application"],
		["packages/agent-core/src/a.ts", "@research/adapters/node"],
		["packages/agent-core/src/a.ts", "node:child_process"],
		["packages/agent-core/src/a.ts", "@opencode-ai/sdk"],
		["packages/application/src/a.ts", "@research/adapters/d1"],
		["packages/application/src/a.ts", "@research/ui-registry"],
		["packages/application/src/a.ts", "hono"],
		["packages/application/src/a.ts", "node:fs"],
		["packages/application/src/a.ts", "cloudflare:workers"],
		["packages/application/src/a.ts", "@app/api"],
		["packages/effects/src/a.ts", "@research/application"],
		["packages/effects/src/a.ts", "@research/contracts"],
		["packages/effects/src/a.ts", "@research/agent-core"],
		["packages/effects/src/a.ts", "@research/ui-registry"],
		["packages/effects/src/a.ts", "@research/adapters/node"],
		["packages/effects/src/a.ts", "hono"],
		["packages/effects/src/a.ts", "zod"],
		["packages/effects/src/a.ts", "node:fs"],
		["packages/effects/src/a.ts", "cloudflare:workers"],
		["packages/ui-registry/src/a.tsx", "hono"],
		["packages/ui-registry/src/a.tsx", "@research/application"],
		["packages/ui-registry/src/a.tsx", "@research/agent-core"],
		["packages/ui-registry/src/a.tsx", "node:fs"],
		["packages/ui-registry/src/a.tsx", "@solidjs/router"],
	])("%s may not import %s", (file, specifier) => {
		expectViolation(importing(file, specifier), "IMPORT_NOT_ALLOWED", specifier);
	});
});

describe("self-test: packages/adapters runtime separation", () => {
	it.each([
		"d1",
		"worker",
		"feed",
		"runtime",
		"sql",
	])("src/%s may not import Node builtins", (zone) => {
		for (const specifier of [
			"node:fs",
			"fs",
			"child_process",
			"net",
			"dns",
			"https",
			"path",
			"os",
			"fs/promises",
			"node:sqlite",
		]) {
			expectViolation(
				importing(`packages/adapters/src/${zone}/client.ts`, specifier),
				"ZONE_FORBIDDEN_IMPORT",
				specifier,
			);
		}
	});

	it.each([
		"d1",
		"worker",
		"feed",
		"runtime",
		"sql",
	])("src/%s may not import Node-only adapter code", (zone) => {
		for (const specifier of [
			"../node/index.ts",
			"../node",
			"../providers/opencode.ts",
			"../tools/search.ts",
			"../finance/index.ts",
			"../sqlite/index.ts",
			"./../node/process.ts",
		]) {
			expectViolation(
				importing(`packages/adapters/src/${zone}/client.ts`, specifier),
				"ZONE_FORBIDDEN_IMPORT",
				specifier,
			);
		}
	});

	it("does not let Worker-safe code reach Node through a helper outside every runtime directory", () => {
		// The bypass: feed -> src/bridge.ts -> node:fs. Neither import is individually forbidden,
		// so the helper's very location has to be.
		const violations = check({
			"packages/adapters/src/feed/index.ts": 'export { read } from "../bridge.ts";\n',
			"packages/adapters/src/bridge.ts": 'export { readFileSync as read } from "node:fs";\n',
		});
		expect(violations.map((violation) => `${violation.code} ${violation.file}`)).toContain(
			"FILE_OUTSIDE_SOURCE_DIRECTORIES packages/adapters/src/bridge.ts",
		);
	});

	it("applies the zone to nested files", () => {
		expectViolation(
			importing("packages/adapters/src/d1/repositories/jobs.ts", "../../node/index.ts"),
			"ZONE_FORBIDDEN_IMPORT",
			"../../node/index.ts",
		);
		expectViolation(
			importing("packages/adapters/src/d1/repositories/jobs.ts", "node:sqlite"),
			"ZONE_FORBIDDEN_IMPORT",
			"node:sqlite",
		);
	});

	it("does not apply the zone to Node-only adapter directories", () => {
		expect(importing("packages/adapters/src/node/spawn.ts", "node:child_process")).toEqual([]);
		expect(importing("packages/adapters/src/providers/codex.ts", "../node/spawn.ts")).toEqual([]);
		expect(importing("packages/adapters/src/sqlite/driver.ts", "node:sqlite")).toEqual([]);
		expect(importing("packages/adapters/src/sqlite/driver.ts", "../sql/index.ts")).toEqual([]);
	});

	it("may not import the UI registry, an app, or itself by package name", () => {
		for (const specifier of ["@research/ui-registry", "@app/api", "@research/adapters/node"]) {
			expectViolation(
				importing("packages/adapters/src/node/a.ts", specifier),
				"IMPORT_NOT_ALLOWED",
				specifier,
			);
		}
	});
});

describe("self-test: apps/api (Cloudflare Worker)", () => {
	it.each([
		"node:fs",
		"node:child_process",
		"node:sqlite",
		"fs",
		"path",
		"os",
		"net",
		"solid-js",
		"solid-js/web",
		"@research/adapters/node",
		"@research/adapters/providers",
		"@research/adapters/tools",
		"@research/adapters/finance",
		"@research/adapters/sqlite",
		"@research/agent-core",
		"@research/ui-registry",
	])("never imports %s", (specifier) => {
		expectViolation(importing("apps/api/src/app.ts", specifier), "FORBIDDEN_IMPORT", specifier);
	});

	it.each([
		"@research/adapters",
		"@opencode-ai/sdk",
		"express",
		"@app/runner",
		"@app/web",
	])("may not import %s, which is not on its allowlist", (specifier) => {
		expectViolation(importing("apps/api/src/app.ts", specifier), "IMPORT_NOT_ALLOWED", specifier);
	});
});

describe("self-test: apps/runner (local Node process)", () => {
	it.each([
		"hono",
		"hono/cors",
		"solid-js",
		"cloudflare:workers",
		"@research/adapters/d1",
		"@research/adapters/worker",
	])("never imports %s", (specifier) => {
		expectViolation(importing("apps/runner/src/main.ts", specifier), "FORBIDDEN_IMPORT", specifier);
	});

	it.each([
		"fs",
		"child_process",
		"@research/ui-registry",
		"@research/adapters",
		"@app/api",
	])("may not import %s, which is not on its allowlist", (specifier) => {
		expectViolation(
			importing("apps/runner/src/main.ts", specifier),
			"IMPORT_NOT_ALLOWED",
			specifier,
		);
	});
});

describe("self-test: apps/web (browser SPA)", () => {
	it.each([
		"hono",
		"hono/client",
		"node:fs",
		"fs",
		"path",
		"@research/application",
		"@research/adapters/d1",
		"@research/adapters/feed",
		"@research/adapters/node",
		"@research/adapters",
		"@research/agent-core",
	])("never imports %s", (specifier) => {
		expectViolation(importing("apps/web/src/main.tsx", specifier), "FORBIDDEN_IMPORT", specifier);
	});

	it.each([
		"cloudflare:workers",
		"jose",
		"@app/api",
		"react",
	])("may not import %s, which is not on its allowlist", (specifier) => {
		expectViolation(importing("apps/web/src/main.tsx", specifier), "IMPORT_NOT_ALLOWED", specifier);
	});
});

describe("self-test: source may not import unchecked files outside src/", () => {
	it.each([
		["packages/domain/src/index.ts", "../bridge.ts"],
		["packages/domain/src/finance/per.ts", "../../scripts/helper.ts"],
		["apps/api/src/app.ts", "../test/helpers.ts"],
	])("%s may not import %s", (file, specifier) => {
		expectViolation(importing(file, specifier), "RELATIVE_IMPORT_LEAVES_SRC", specifier);
	});

	it("still allows relative imports that stay inside src/", () => {
		expect(importing("packages/domain/src/finance/per.ts", "../result.ts")).toEqual([]);
	});
});

describe("self-test: package encapsulation", () => {
	it.each([
		["packages/contracts/src/a.ts", "@research/domain/src/result.ts"],
		["packages/application/src/a.ts", "@research/contracts/src/ui.ts"],
		["apps/api/src/app.ts", "@research/application/src/ports.ts"],
		["apps/web/src/main.tsx", "@research/ui-registry/src/renderers/table.tsx"],
		["apps/runner/src/main.ts", "@research/adapters/src/node/index.ts"],
		["packages/adapters/src/node/a.ts", "@research/agent-core/src"],
	])("%s may not deep-import %s", (file, specifier) => {
		expectViolation(importing(file, specifier), "DEEP_IMPORT", specifier);
	});

	it("flags workspace subpaths that are not public entry points", () => {
		expectViolation(
			importing("packages/contracts/src/a.ts", "@research/domain/finance/per.ts"),
			"IMPORT_NOT_ALLOWED",
			"@research/domain/finance/per.ts",
		);
		expectViolation(
			importing("apps/api/src/app.ts", "@research/adapters/d1/internal.ts"),
			"IMPORT_NOT_ALLOWED",
			"@research/adapters/d1/internal.ts",
		);
	});

	it.each([
		["packages/contracts/src/a.ts", "../../domain/src/result.ts"],
		["packages/domain/src/finance/per.ts", "../../../contracts/src/index.ts"],
		["apps/api/src/app.ts", "../../../packages/adapters/src/node/index.ts"],
		["apps/web/src/main.tsx", "../../api/src/app.ts"],
		["apps/runner/src/main.ts", "../../../infra/wrangler.jsonc"],
		["packages/domain/src/a.ts", "../../../package.json"],
		["packages/domain/src/a.ts", "/etc/passwd"],
		["packages/domain/src/a.ts", "file:///etc/passwd"],
	])("%s may not reach outside its package with %s", (file, specifier) => {
		expectViolation(importing(file, specifier), "RELATIVE_IMPORT_ESCAPES_PACKAGE", specifier);
	});

	it("allows relative imports that stay inside the package, even across directories", () => {
		expect(importing("packages/domain/src/finance/per.ts", "../news/feed.ts")).toEqual([]);
		expect(importing("packages/domain/src/finance/per.ts", "../../package.json")).toEqual([]);
	});

	it("does not confuse a sibling package whose name shares a prefix", () => {
		expectViolation(
			importing("packages/domain/src/a.ts", "../../domain-extras/src/b.ts"),
			"RELATIVE_IMPORT_ESCAPES_PACKAGE",
			"../../domain-extras/src/b.ts",
		);
	});

	it("flags source in a package that has no rule", () => {
		const violations = check({ "packages/brand-new/src/index.ts": "export const x = 1;\n" });
		expect(violations.map((violation) => [violation.code, violation.file])).toEqual([
			["NO_RULE_FOR_PACKAGE", "packages/brand-new/src/index.ts"],
		]);
	});
});

describe("self-test: import cycles", () => {
	it("flags a two-file cycle", () => {
		const violations = check({
			"packages/domain/src/a.ts": 'import { b } from "./b.ts";\nexport const a = b;\n',
			"packages/domain/src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
		});
		expect(violations.map((violation) => violation.code)).toEqual(["FILE_IMPORT_CYCLE"]);
		expect(violations[0]?.detail).toContain("packages/domain/src/a.ts, packages/domain/src/b.ts");
	});

	it("flags a longer cycle, including one through an index file and a type-only import", () => {
		const violations = check({
			"packages/contracts/src/a.ts": 'import "./b.ts";\n',
			"packages/contracts/src/b.ts": 'import "./nested";\n',
			"packages/contracts/src/nested/index.ts":
				'import type { A } from "../a.js";\nexport type N = A;\n',
			"packages/contracts/src/unrelated.ts": 'import "./a.ts";\n',
		});
		expect(violations.map((violation) => violation.code)).toEqual(["FILE_IMPORT_CYCLE"]);
		expect(violations[0]?.detail).toContain(
			"[packages/contracts/src/a.ts, packages/contracts/src/b.ts, packages/contracts/src/nested/index.ts]",
		);
		expect(violations[0]?.detail).not.toContain("unrelated");
	});

	it("flags a file that imports itself", () => {
		const violations = check({ "packages/domain/src/a.ts": 'import "./a.ts";\n' });
		expect(violations.map((violation) => violation.code)).toEqual(["FILE_IMPORT_CYCLE"]);
	});

	it("reports separate cycles separately", () => {
		const violations = check({
			"packages/domain/src/a.ts": 'import "./b.ts";\n',
			"packages/domain/src/b.ts": 'import "./a.ts";\n',
			"packages/domain/src/c.ts": 'import "./d.ts";\n',
			"packages/domain/src/d.ts": 'import "./c.ts";\n',
		});
		expect(violations.map((violation) => violation.code)).toEqual([
			"FILE_IMPORT_CYCLE",
			"FILE_IMPORT_CYCLE",
		]);
	});

	it("does not flag a diamond or a shared leaf", () => {
		expect(
			check({
				"packages/domain/src/top.ts": 'import "./left.ts";\nimport "./right.ts";\n',
				"packages/domain/src/left.ts": 'import "./leaf.ts";\n',
				"packages/domain/src/right.ts": 'import "./leaf.ts";\nimport "./left.ts";\n',
				"packages/domain/src/leaf.ts": "export const leaf = 1;\n",
			}),
		).toEqual([]);
	});

	it("flags a cycle between workspace packages", () => {
		const violations = check({
			"packages/contracts/src/index.ts": 'import "@research/domain";\n',
			"packages/domain/src/index.ts": 'import "@research/contracts";\n',
		});
		const cycles = violations.filter((violation) => violation.code === "PACKAGE_IMPORT_CYCLE");
		expect(cycles).toHaveLength(1);
		expect(cycles[0]?.detail).toContain("[packages/contracts, packages/domain]");
	});

	it("flags a package cycle that runs through an allowed subpath entry point", () => {
		// adapters -> application is allowed; application -> adapters closes the loop.
		const violations = check({
			"packages/adapters/src/d1/index.ts": 'import "@research/application";\n',
			"packages/application/src/index.ts": 'import "@research/adapters/d1";\n',
		});
		expectViolation(violations, "IMPORT_NOT_ALLOWED", "@research/adapters/d1");
		expect(violations.some((violation) => violation.code === "PACKAGE_IMPORT_CYCLE")).toBe(true);
	});

	it("does not report the allowed layering as a package cycle", () => {
		const violations = check({
			"packages/contracts/src/index.ts": 'import "@research/domain";\n',
			"packages/agent-core/src/index.ts":
				'import "@research/contracts";\nimport "@research/domain";\n',
			"packages/application/src/index.ts":
				'import "@research/agent-core";\nimport "@research/contracts";\n',
			"packages/adapters/src/node/index.ts": 'import "@research/application";\n',
			"apps/runner/src/main.ts":
				'import "@research/adapters/node";\nimport "@research/application";\n',
		});
		expect(report(violations)).toBe("");
	});
});

describe("findCycles", () => {
	const graph = (edges: { readonly [node: string]: readonly string[] }) =>
		new Map(Object.entries(edges));

	it("returns nothing for an acyclic graph", () => {
		expect(findCycles(graph({ a: ["b", "c"], b: ["c"], c: [] }))).toEqual([]);
		expect(findCycles(graph({}))).toEqual([]);
	});

	it("returns each strongly connected component once, sorted", () => {
		expect(
			findCycles(
				graph({ z: ["y"], y: ["z"], a: ["b"], b: ["c"], c: ["a"], lone: ["a"], self: ["self"] }),
			),
		).toEqual([["a", "b", "c"], ["self"], ["y", "z"]]);
	});

	it("ignores edges to nodes outside the graph", () => {
		expect(findCycles(graph({ a: ["missing"], b: ["a"] }))).toEqual([]);
	});

	it("handles a long chain without overflowing the stack", () => {
		const chain: { [node: string]: string[] } = {};
		for (let index = 0; index < 2000; index += 1) {
			chain[`n${index}`] = index + 1 < 2000 ? [`n${index + 1}`] : [];
		}
		expect(findCycles(graph(chain))).toEqual([]);
	});
});
