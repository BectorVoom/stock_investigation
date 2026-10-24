/**
 * Finds English UI text written straight into UI source instead of a
 * translation catalog (ADR-0032). Text the owner reads lives in a
 * `*.messages.ts` catalog in every UI language; this scanner reports the
 * places that still bypass one.
 *
 * What counts as UI text (a heuristic, tuned on this code base):
 *  - JSX text with a word of two or more letters;
 *  - a string or template literal that reads like prose: it starts with a
 *    capital letter followed by a lower-case one and holds a space
 *    ("Market-data refresh queued."), or it is the value of a JSX attribute
 *    that people read (`aria-label`, `title`, `placeholder`, `alt`, `label`…).
 *
 * Not UI text: messages of thrown errors and log lines (for developers, and
 * the API's codes carry the meaning), the arguments of a test's
 * `describe`/`it`, catalogs themselves, and any line marked with a preceding
 * `// i18n-exempt: <reason>` comment (a ticker, a unit, a product name, a
 * format pattern).
 *
 * Run `bun tests/architecture/uiTextScanner.ts <file|dir>…` to list the
 * findings of some files while translating them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** UI source: every file under these roots is scanned. */
export const UI_TEXT_ROOTS = [
	"apps/web/src",
	"packages/ui-registry/src",
	"packages/widget-grid/src/solid",
] as const;

/**
 * Files that hold the English source text other code translates from, not
 * text shown as it is (each with its reason).
 */
export const UI_TEXT_EXEMPT_FILES: Readonly<Record<string, string>> = {
	"apps/web/src/pages.ts":
		"the English page titles and purposes, also checked against docs/PAGES.md; pages.messages.ts translates them",
	"packages/widget-grid/src/solid/strings.tsx":
		"the package's English default strings; hosts pass their own",
};

/** JSX attributes whose string value a person reads or hears. */
const READ_ATTRIBUTES = new Set([
	"aria-label",
	"aria-description",
	"aria-placeholder",
	"aria-roledescription",
	"aria-valuetext",
	"alt",
	"placeholder",
	"title",
	"label",
	"heading",
	"hint",
	"description",
	"fallback",
	"emptyText",
	"confirmLabel",
	"cancelLabel",
	"text",
	"message",
	"help-text",
]);

/** Calls whose string arguments are for developers, not the owner. */
const DEVELOPER_CALLEES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"describe",
	"it",
	"test",
	"console.log",
	"console.warn",
	"console.error",
	"console.info",
	"console.debug",
	"Effect.log",
	"Effect.logInfo",
	"Effect.logWarning",
	"Effect.logError",
	"Effect.logDebug",
]);

const PROSE = /^[\s“"'(¡¿]*[A-Z][a-z][\s\S]*\s/;
const WORD = /[A-Za-z]{2,}/;
const EXEMPT_MARK = "i18n-exempt:";

export interface UiTextFinding {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function calleeName(expression: ts.Expression): string {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) {
		return `${calleeName(expression.expression)}.${expression.name.text}`;
	}
	return "";
}

/** Whether `node` sits in an argument of a developer-facing call or a `throw`. */
function inDeveloperContext(node: ts.Node): boolean {
	for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
		if (ts.isThrowStatement(current)) return true;
		if (
			(ts.isCallExpression(current) || ts.isNewExpression(current)) &&
			DEVELOPER_CALLEES.has(calleeName(current.expression))
		) {
			return true;
		}
		if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
		if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return false;
	}
	return false;
}

function attributeOf(node: ts.Node): string | null {
	let current: ts.Node | undefined = node.parent;
	if (current && ts.isJsxExpression(current)) current = current.parent;
	if (current && ts.isJsxAttribute(current)) return current.name.getText();
	return null;
}

function literalText(node: ts.Node): string | null {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isTemplateExpression(node)) {
		return node.head.text + node.templateSpans.map((span) => ` x ${span.literal.text}`).join("");
	}
	return null;
}

function exemptLines(source: ts.SourceFile): Set<number> {
	const lines = new Set<number>();
	const text = source.getFullText();
	const lineStarts = source.getLineStarts();
	lineStarts.forEach((start, index) => {
		const end = lineStarts[index + 1] ?? text.length;
		if (text.slice(start, end).includes(EXEMPT_MARK)) {
			// The mark covers its own line and the next one.
			lines.add(index + 1);
			lines.add(index + 2);
		}
	});
	return lines;
}

export function scanUiText(file: string, content: string): UiTextFinding[] {
	const source = ts.createSourceFile(
		file,
		content,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const exempt = exemptLines(source);
	const findings: UiTextFinding[] = [];
	const report = (node: ts.Node, text: string) => {
		const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
		if (exempt.has(line)) return;
		findings.push({ file, line, text: text.trim().replace(/\s+/g, " ").slice(0, 80) });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isJsxText(node)) {
			if (WORD.test(node.text)) report(node, node.text);
			return;
		}
		const text = literalText(node);
		if (text !== null && WORD.test(text) && !inDeveloperContext(node)) {
			const attribute = attributeOf(node);
			if ((attribute !== null && READ_ATTRIBUTES.has(attribute)) || PROSE.test(text)) {
				report(node, text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return findings;
}

function isScanned(path: string): boolean {
	return /\.(ts|tsx)$/.test(path) && !/\.messages\.tsx?$/.test(path) && !path.endsWith(".d.ts");
}

function filesUnder(path: string): string[] {
	if (!statSync(path).isDirectory()) return isScanned(path) ? [path] : [];
	return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)));
}

/** Findings for the given repo-relative files or directories (default: every UI root). */
export function scanUiTextPaths(paths: readonly string[] = UI_TEXT_ROOTS): UiTextFinding[] {
	return paths
		.flatMap((path) => filesUnder(join(REPO_ROOT, path)))
		.map((absolute) => relative(REPO_ROOT, absolute))
		.filter((file) => !(file in UI_TEXT_EXEMPT_FILES))
		.sort()
		.flatMap((file) => scanUiText(file, readFileSync(join(REPO_ROOT, file), "utf8")));
}

if (import.meta.main) {
	const args = process.argv.slice(2).map((arg) => relative(REPO_ROOT, join(process.cwd(), arg)));
	const findings = scanUiTextPaths(args.length > 0 ? args : UI_TEXT_ROOTS);
	for (const finding of findings) {
		console.log(`${finding.file}:${finding.line}  ${finding.text}`);
	}
	console.log(`${findings.length} finding(s)`);
	process.exit(findings.length > 0 ? 1 : 0);
}
