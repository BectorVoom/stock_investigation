/**
 * Static import-boundary checker (ENGINEERING_DESIGN_RULES section 3).
 *
 * Pure with respect to the file system: it works on in-memory source text, so
 * the same code checks the real tree and the synthetic violations of the
 * self-test. Imports are read from the TypeScript AST, never by regex, so text
 * inside comments and string literals cannot be mistaken for an import.
 */
import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";

/** A source file addressed by its repo-relative POSIX path, e.g. "packages/domain/src/a.ts". */
export interface SourceText {
	readonly path: string;
	readonly text: string;
}

export type ImportKind =
	| "import"
	| "export-from"
	| "import-equals"
	| "dynamic-import"
	| "require"
	| "import-type";

export interface ImportReference {
	readonly file: string;
	/** null when the specifier is not a string literal and so cannot be analysed. */
	readonly specifier: string | null;
	readonly line: number;
	readonly kind: ImportKind;
}

/** What a module specifier may look like. Rules are lists of these, so the table is plain data. */
export type SpecifierPattern =
	/** Exactly this specifier, e.g. a workspace entry point "@research/adapters/d1". */
	| { readonly kind: "exact"; readonly specifier: string }
	/** A package and any of its subpaths: "hono" and "hono/cors". */
	| { readonly kind: "package"; readonly name: string }
	/** A URL-like scheme prefix: "node:" or "cloudflare:". */
	| { readonly kind: "scheme"; readonly prefix: string }
	/** `node:*` or a bare Node builtin such as "fs" or "path". */
	| { readonly kind: "node-builtin" }
	/** Any non-relative specifier that is not a workspace package. */
	| { readonly kind: "any-external" };

export const exact = (specifier: string): SpecifierPattern => ({ kind: "exact", specifier });
export const pkg = (name: string): SpecifierPattern => ({ kind: "package", name });
export const scheme = (prefix: string): SpecifierPattern => ({ kind: "scheme", prefix });
export const nodeBuiltin = (): SpecifierPattern => ({ kind: "node-builtin" });
export const anyExternal = (): SpecifierPattern => ({ kind: "any-external" });

/** Extra restrictions for some directories of one package (e.g. Worker-safe adapter code). */
export interface ZoneRule {
	readonly name: string;
	/** Directories, relative to the package root, whose files the zone covers. */
	readonly directories: readonly string[];
	readonly forbidden: readonly SpecifierPattern[];
	/** Directories of the same package that files in this zone must not import from. */
	readonly forbiddenDirectories: readonly string[];
}

export interface PackageRule {
	/** Package root directory, e.g. "packages/domain". */
	readonly root: string;
	/** What the package may import. Relative imports inside the package are always allowed. */
	readonly allowed: readonly SpecifierPattern[];
	/** Explicit "never" list; reported ahead of the allowlist so the message names the reason. */
	readonly forbidden: readonly SpecifierPattern[];
	readonly zones: readonly ZoneRule[];
	/**
	 * When set, every source file of the package must live in one of these
	 * directories (relative to the package root). Used where rules are per
	 * directory, so that no file can sit outside every zone and carry a forbidden
	 * dependency into a zone that imports it.
	 */
	readonly sourceDirectories?: readonly string[];
}

export interface BoundaryConfig {
	readonly rules: readonly PackageRule[];
	/** Workspace package name -> root directory, e.g. "@research/domain" -> "packages/domain". */
	readonly workspacePackages: ReadonlyMap<string, string>;
	/** Scopes reserved for workspace packages; anything under them is never "external". */
	readonly workspaceScopes: readonly string[];
}

export type ViolationCode =
	| "NO_RULE_FOR_PACKAGE"
	| "NON_LITERAL_IMPORT"
	| "RELATIVE_IMPORT_ESCAPES_PACKAGE"
	| "RELATIVE_IMPORT_LEAVES_SRC"
	| "FILE_OUTSIDE_SOURCE_DIRECTORIES"
	| "DEEP_IMPORT"
	| "FORBIDDEN_IMPORT"
	| "ZONE_FORBIDDEN_IMPORT"
	| "IMPORT_NOT_ALLOWED"
	| "FILE_IMPORT_CYCLE"
	| "PACKAGE_IMPORT_CYCLE";

export interface Violation {
	readonly code: ViolationCode;
	readonly file: string;
	readonly specifier: string;
	readonly line: number;
	readonly detail: string;
}

/* ---------- Import extraction ---------- */

function scriptKindOf(path: string): ts.ScriptKind {
	return path.endsWith(".tsx") || path.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function literalText(node: ts.Node | undefined): string | null {
	return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

export function extractImports(source: SourceText): readonly ImportReference[] {
	const sourceFile = ts.createSourceFile(
		source.path,
		source.text,
		ts.ScriptTarget.Latest,
		true,
		scriptKindOf(source.path),
	);
	const references: ImportReference[] = [];
	const record = (node: ts.Node, kind: ImportKind, specifier: string | null): void => {
		const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		references.push({ file: source.path, specifier, line: line + 1, kind });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			record(node, "import", literalText(node.moduleSpecifier));
		} else if (ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier !== undefined) {
				record(node, "export-from", literalText(node.moduleSpecifier));
			}
		} else if (ts.isImportEqualsDeclaration(node)) {
			if (ts.isExternalModuleReference(node.moduleReference)) {
				record(node, "import-equals", literalText(node.moduleReference.expression));
			}
		} else if (ts.isImportTypeNode(node)) {
			const argument = node.argument;
			record(
				node,
				"import-type",
				ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null,
			);
		} else if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				record(node, "dynamic-import", literalText(node.arguments[0]));
			} else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
				record(node, "require", literalText(node.arguments[0]));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return references;
}

/* ---------- Specifier classification ---------- */

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

export function isNodeBuiltin(specifier: string): boolean {
	if (specifier.startsWith("node:")) return true;
	// "fs/promises" style subpaths are listed in builtinModules; also catch any other subpath.
	return NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split("/")[0] ?? "");
}

function isRelative(specifier: string): boolean {
	return (
		specifier === "." ||
		specifier === ".." ||
		specifier.startsWith("./") ||
		specifier.startsWith("../")
	);
}

function isAbsolutePath(specifier: string): boolean {
	return (
		specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith("file:")
	);
}

/** The package-name part of a bare specifier: "@scope/name/sub" -> "@scope/name", "a/b" -> "a". */
export function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isWorkspaceSpecifier(specifier: string, config: BoundaryConfig): boolean {
	return (
		config.workspaceScopes.some((scope) => specifier.startsWith(scope)) ||
		config.workspacePackages.has(packageNameOf(specifier))
	);
}

export function matchesPattern(
	specifier: string,
	pattern: SpecifierPattern,
	config: BoundaryConfig,
): boolean {
	switch (pattern.kind) {
		case "exact":
			return specifier === pattern.specifier;
		case "package":
			return specifier === pattern.name || specifier.startsWith(`${pattern.name}/`);
		case "scheme":
			return specifier.startsWith(pattern.prefix);
		case "node-builtin":
			return isNodeBuiltin(specifier);
		case "any-external":
			return (
				!isRelative(specifier) &&
				!isAbsolutePath(specifier) &&
				!isWorkspaceSpecifier(specifier, config)
			);
	}
}

function describePattern(pattern: SpecifierPattern): string {
	switch (pattern.kind) {
		case "exact":
			return pattern.specifier;
		case "package":
			return `${pattern.name}[/*]`;
		case "scheme":
			return `${pattern.prefix}*`;
		case "node-builtin":
			return "Node builtins";
		case "any-external":
			return "external packages";
	}
}

/* ---------- Path helpers ---------- */

function ruleFor(file: string, config: BoundaryConfig): PackageRule | undefined {
	return config.rules
		.filter((rule) => file.startsWith(`${rule.root}/`))
		.sort((a, b) => b.root.length - a.root.length)[0];
}

function isInside(path: string, directory: string): boolean {
	return path === directory || path.startsWith(`${directory}/`);
}

/** Strips a query/hash suffix such as Vite's "?url" or "?raw". */
function withoutQuery(specifier: string): string {
	return specifier.replace(/[?#].*$/, "");
}

function resolveRelative(file: string, specifier: string): string {
	return posix.normalize(posix.join(posix.dirname(file), withoutQuery(specifier)));
}

const CODE_EXTENSION = /\.(d\.ts|[cm]?tsx?|[cm]?jsx?)$/;

function withoutCodeExtension(path: string): string {
	return path.replace(CODE_EXTENSION, "");
}

/** Resolves a relative import to a file of the analysed set, or null (assets, missing files). */
function resolveToSourceFile(
	file: string,
	specifier: string,
	knownFiles: ReadonlySet<string>,
): string | null {
	const target = resolveRelative(file, specifier);
	const stem = withoutCodeExtension(target);
	const candidates = [
		target,
		`${stem}.ts`,
		`${stem}.tsx`,
		`${stem}.d.ts`,
		`${target}.ts`,
		`${target}.tsx`,
		`${target}/index.ts`,
		`${target}/index.tsx`,
	];
	return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

/* ---------- Per-import rules ---------- */

function checkImport(
	reference: ImportReference,
	rule: PackageRule,
	config: BoundaryConfig,
): Violation | null {
	const violation = (code: ViolationCode, detail: string): Violation => ({
		code,
		file: reference.file,
		specifier: reference.specifier ?? "<non-literal>",
		line: reference.line,
		detail,
	});
	const specifier = reference.specifier;
	if (specifier === null) {
		return violation(
			"NON_LITERAL_IMPORT",
			`${reference.kind} with a computed specifier cannot be checked; use a string literal`,
		);
	}
	const zones = rule.zones.filter((zone) =>
		zone.directories.some((directory) => isInside(reference.file, `${rule.root}/${directory}`)),
	);

	if (isAbsolutePath(specifier)) {
		return violation("RELATIVE_IMPORT_ESCAPES_PACKAGE", "absolute paths bypass package boundaries");
	}
	if (isRelative(specifier)) {
		const target = resolveRelative(reference.file, specifier);
		if (!isInside(target, rule.root)) {
			return violation(
				"RELATIVE_IMPORT_ESCAPES_PACKAGE",
				`resolves to "${target}", outside ${rule.root}; import the package by name instead`,
			);
		}
		// Only src/ is analysed. A source file importing a sibling outside src/ would pull in
		// code whose own imports and cycles this check never sees.
		// Data files (e.g. package.json) cannot import anything, so only code targets matter.
		const targetsCode = /\.(m?[jt]sx?|c[jt]s)$/.test(target) || !/\.[A-Za-z0-9]+$/.test(target);
		if (
			targetsCode &&
			isInside(reference.file, `${rule.root}/src`) &&
			!isInside(target, `${rule.root}/src`)
		) {
			return violation(
				"RELATIVE_IMPORT_LEAVES_SRC",
				`resolves to "${target}", outside ${rule.root}/src where imports are not checked`,
			);
		}
		for (const zone of zones) {
			const hit = zone.forbiddenDirectories.find((directory) =>
				isInside(withoutCodeExtension(target), `${rule.root}/${directory}`),
			);
			if (hit !== undefined) {
				return violation(
					"ZONE_FORBIDDEN_IMPORT",
					`${zone.name} code must not import from ${rule.root}/${hit}`,
				);
			}
		}
		return null;
	}

	if (isWorkspaceSpecifier(specifier, config) && /^(@[^/]+\/)?[^/]+\/src(\/|$)/.test(specifier)) {
		return violation(
			"DEEP_IMPORT",
			"reaches into another package's src; import its public entry point",
		);
	}
	const forbidden = rule.forbidden.find((pattern) => matchesPattern(specifier, pattern, config));
	if (forbidden !== undefined) {
		return violation(
			"FORBIDDEN_IMPORT",
			`${rule.root} must never import ${describePattern(forbidden)}`,
		);
	}
	for (const zone of zones) {
		const hit = zone.forbidden.find((pattern) => matchesPattern(specifier, pattern, config));
		if (hit !== undefined) {
			return violation(
				"ZONE_FORBIDDEN_IMPORT",
				`${zone.name} code must not import ${describePattern(hit)}`,
			);
		}
	}
	if (!rule.allowed.some((pattern) => matchesPattern(specifier, pattern, config))) {
		const allowed =
			rule.allowed.length === 0
				? "nothing outside its own directory"
				: rule.allowed.map(describePattern).join(", ");
		return violation("IMPORT_NOT_ALLOWED", `${rule.root} may import only: ${allowed}`);
	}
	return null;
}

/* ---------- Cycle detection ---------- */

/**
 * Strongly connected components that contain a cycle (more than one node, or a
 * self-loop), via Tarjan's algorithm. Output is sorted, so it is deterministic.
 */
export function findCycles(
	graph: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
	const index = new Map<string, number>();
	const lowLink = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const components: string[][] = [];
	let counter = 0;

	const connect = (node: string): void => {
		index.set(node, counter);
		lowLink.set(node, counter);
		counter += 1;
		stack.push(node);
		onStack.add(node);
		for (const next of graph.get(node) ?? []) {
			if (!graph.has(next)) continue;
			if (!index.has(next)) {
				connect(next);
				lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(next) ?? 0));
			} else if (onStack.has(next)) {
				lowLink.set(node, Math.min(lowLink.get(node) ?? 0, index.get(next) ?? 0));
			}
		}
		if (lowLink.get(node) !== index.get(node)) return;
		const component: string[] = [];
		for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
			onStack.delete(member);
			component.push(member);
			if (member === node) break;
		}
		const selfLoop = (graph.get(node) ?? []).includes(node);
		if (component.length > 1 || selfLoop) components.push(component.sort());
	};

	for (const node of [...graph.keys()].sort()) {
		if (!index.has(node)) connect(node);
	}
	return components.sort((a, b) => {
		const [firstA = "", firstB = ""] = [a[0], b[0]];
		if (firstA === firstB) return 0;
		return firstA < firstB ? -1 : 1;
	});
}

interface Edge {
	readonly from: string;
	readonly to: string;
	readonly reference: ImportReference;
}

function cycleViolations(
	code: "FILE_IMPORT_CYCLE" | "PACKAGE_IMPORT_CYCLE",
	edges: readonly Edge[],
	nodes: readonly string[],
): readonly Violation[] {
	const graph = new Map<string, string[]>(nodes.map((node) => [node, []]));
	for (const edge of edges) graph.get(edge.from)?.push(edge.to);
	return findCycles(graph).map((component) => {
		const members = new Set(component);
		const inside = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
		const first = inside[0];
		const steps = inside
			.map((edge) => `${edge.reference.file}:${edge.reference.line} -> ${edge.to}`)
			.sort();
		return {
			code,
			file: first?.reference.file ?? component[0] ?? "",
			specifier: first?.reference.specifier ?? "",
			line: first?.reference.line ?? 0,
			detail: `cycle among [${component.join(", ")}]: ${[...new Set(steps)].join("; ")}`,
		};
	});
}

/* ---------- Entry point ---------- */

export function checkBoundaries(
	sources: readonly SourceText[],
	config: BoundaryConfig,
): readonly Violation[] {
	const violations: Violation[] = [];
	const knownFiles = new Set(sources.map((source) => source.path));
	const fileEdges: Edge[] = [];
	const packageEdges: Edge[] = [];

	for (const source of sources) {
		const rule = ruleFor(source.path, config);
		if (rule === undefined) {
			violations.push({
				code: "NO_RULE_FOR_PACKAGE",
				file: source.path,
				specifier: "",
				line: 0,
				detail: "no import rule covers this file; add its package to the rule table",
			});
			continue;
		}
		if (
			rule.sourceDirectories !== undefined &&
			!rule.sourceDirectories.some((directory) =>
				isInside(source.path, `${rule.root}/${directory}`),
			)
		) {
			violations.push({
				code: "FILE_OUTSIDE_SOURCE_DIRECTORIES",
				file: source.path,
				specifier: "",
				line: 0,
				detail: `source files of ${rule.root} must live in one of: ${rule.sourceDirectories.join(", ")}`,
			});
		}
		for (const reference of extractImports(source)) {
			const violation = checkImport(reference, rule, config);
			if (violation !== null) violations.push(violation);
			const specifier = reference.specifier;
			if (specifier === null) continue;
			if (isRelative(specifier)) {
				const target = resolveToSourceFile(source.path, specifier, knownFiles);
				if (target !== null) fileEdges.push({ from: source.path, to: target, reference });
				continue;
			}
			const targetRoot = config.workspacePackages.get(packageNameOf(specifier));
			if (targetRoot !== undefined) {
				packageEdges.push({ from: rule.root, to: targetRoot, reference });
			}
		}
	}

	violations.push(...cycleViolations("FILE_IMPORT_CYCLE", fileEdges, [...knownFiles]));
	violations.push(
		...cycleViolations("PACKAGE_IMPORT_CYCLE", packageEdges, [
			...new Set([...config.rules.map((rule) => rule.root), ...config.workspacePackages.values()]),
		]),
	);
	return violations;
}

export function formatViolation(violation: Violation): string {
	const location = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file;
	const imported = violation.specifier === "" ? "" : ` imports "${violation.specifier}"`;
	return `[${violation.code}] ${location}${imported} - ${violation.detail}`;
}
