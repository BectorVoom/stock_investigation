import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** Every Markdown file under docs/, plus the root README and agent instructions. */
function documents(): string[] {
	const found = [join(REPO, "README.md"), join(REPO, "AGENTS.md")];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".md")) found.push(path);
		}
	};
	walk(join(REPO, "docs"));
	return found;
}

/**
 * Text outside fenced code blocks and code spans: links shown as code
 * (`[a](url)` in a formatting example) are not links.
 */
function prose(markdown: string): string {
	return markdown
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
		.replace(/(`+)[^`]+?\1/g, "");
}

/**
 * Heading anchors of a Markdown document, as GitHub generates them:
 * lowercase, punctuation dropped, spaces to hyphens, repeats numbered.
 */
function anchorsOf(markdown: string): Set<string> {
	const anchors = new Set<string>();
	const seen = new Map<string, number>();
	const withoutFences = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
	for (const match of withoutFences.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
		const slug = (match[1] ?? "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.replace(/\s/g, "-");
		const count = seen.get(slug) ?? 0;
		anchors.add(count === 0 ? slug : `${slug}-${count}`);
		seen.set(slug, count + 1);
	}
	return anchors;
}

/**
 * Link targets of a Markdown document: inline links `[text](target)`,
 * reference definitions `[label]: target` and HTML `href="target"`.
 */
function linkTargets(markdown: string): string[] {
	const text = prose(markdown);
	// A destination is `<anything but > or newline>` or a run without spaces;
	// an optional title is "…", '…' or (…).
	const destination = String.raw`(?:<([^>\n]*)>|([^\s<>)][^\s)]*))`;
	const title = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?`;
	const inline = new RegExp(String.raw`\]\(\s*${destination}${title}\s*\)`, "g");
	const reference = new RegExp(String.raw`^ {0,3}\[[^\]\n]+\]:\s*${destination}`, "gm");
	const target = (match: RegExpMatchArray) => match[1] ?? match[2] ?? "";
	return [
		...[...text.matchAll(inline)].map(target),
		...[...text.matchAll(reference)].map(target),
		...[...text.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1] ?? ""),
	];
}

/**
 * Relative link targets in `markdown` that do not resolve from `directory`:
 * a missing file, or a missing heading anchor — in another Markdown file or,
 * for `#anchor`, in this document itself.
 */
function brokenLinksIn(markdown: string, directory: string): string[] {
	const broken: string[] = [];
	for (const target of linkTargets(markdown)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
		const [file = "", anchor] = target.split("#");
		const path = resolve(directory, decodeURIComponent(file));
		if (file !== "" && !existsSync(path)) broken.push(target);
		else if (anchor !== undefined && (file === "" || file.endsWith(".md"))) {
			const document = file === "" ? markdown : readFileSync(path, "utf8");
			if (!anchorsOf(document).has(decodeURIComponent(anchor))) broken.push(target);
		}
	}
	return broken;
}

const brokenLinks = (file: string) =>
	brokenLinksIn(readFileSync(file, "utf8"), dirname(file)).map(
		(target) => `${relative(REPO, file)}: ${target}`,
	);

/**
 * Documents move (ADR-0046 moved the database documents into docs/database/);
 * a link left pointing at the old place must fail here, not in a reader's
 * browser.
 */
describe("documentation links", () => {
	it("resolves every relative link in docs/, README.md and AGENTS.md", () => {
		expect(documents().flatMap(brokenLinks)).toEqual([]);
	});

	it("reports moved documents and missing headings in every link form, but not links shown as code", () => {
		const text = [
			"[old](DATABASE_CONVENTIONS.md) [new](database/conventions.md#3-migrations)",
			"[gone](database/conventions.md#no-such-section)",
			"`[shown](as-code.md)`",
			"```md",
			"[fenced](also-code.md)",
			"```",
			"## Top",
			"[web](https://example.com/x.md) [here](#top) [nowhere](#bottom)",
			"[spaced](<missing file.md>) [titled](METALS_DATABASE.md 'Materials') [ok](PAGES.md \"Pages\")",
			"[ref]: OPERATIONS.md",
			"[stale ref]: NAMING_CONVENTIONS.md",
			'<a href="EQUITIES_DATABASE.md">old</a> <a href="PAGES.md">ok</a>',
		].join("\n");
		expect(brokenLinksIn(text, join(REPO, "docs"))).toEqual([
			"DATABASE_CONVENTIONS.md",
			"database/conventions.md#no-such-section",
			"#bottom",
			"missing file.md",
			"METALS_DATABASE.md",
			"NAMING_CONVENTIONS.md",
			"EQUITIES_DATABASE.md",
		]);
	});
});
