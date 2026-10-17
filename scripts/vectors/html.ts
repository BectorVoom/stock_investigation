/**
 * HTML → Markdown (crate `research-html`, ADR-0030 decision 6): the real
 * converter (`packages/adapters/src/tools/htmlToMarkdown.ts`) and the real
 * htmlparser2 12.0.0 / entities 8.1.0 it runs on.
 *
 * Files under `vectors/html/`:
 * - `entities.json` — the decode trie's length and SHA-256 (ties the
 *   generated Rust table to the package) and, for every named reference,
 *   the parser events of one document using it in text and attributes;
 * - `events.json` — parser callbacks for edge cases and generated soup;
 * - `convert-*.json` — converter outputs for every input of the TypeScript
 *   tests, the edge cases, fixed-seed samples of the tests' fast-check
 *   arbitraries, seeded tag soup and the two `scripts/bench.ts` pages (whose
 *   inputs the Rust test rebuilds from the same recipe).
 *
 * Inputs and outputs are well-formed strings (`wellFormed`): where the
 * TypeScript produces a lone surrogate (an astral named entity split across
 * two text chunks), the Rust port writes U+FFFD (ADR-0030).
 */
import { createHash } from "node:crypto";
import fc from "fast-check";
import {
	type HtmlToMarkdownOptions,
	htmlToMarkdown,
	type MarkdownPage,
} from "../../packages/adapters/src/tools/htmlToMarkdown.ts";
import {
	BASE_URLS,
	MAX_CHARS,
	SOUP_BASE_URLS,
	SOUP_MAX_CHARS,
	Soup,
	TRICKY_HTML,
} from "./html/corpus.ts";
import { entityNames } from "./html/entityNames.ts";
import { recordEvents } from "./html/events.ts";
import { htmlDecodeTree } from "./html/htmlparser2.ts";
import { joinPieces, type Piece, TEST_INPUTS } from "./html/testInputs.ts";
import { type VectorExporter, type VectorFile, wellFormed } from "./shared.ts";

const TEST_BASE = "https://news.synthetic-wire.org/articles/2026/grid/";

interface ConvertCase {
	readonly html: string | readonly Piece[];
	readonly baseUrl: string;
	readonly maxChars: number;
	readonly output: MarkdownPage;
}

function convert(html: string, options: HtmlToMarkdownOptions): MarkdownPage {
	const page = htmlToMarkdown(html, options);
	return {
		title: page.title === null ? null : wellFormed(page.title),
		markdown: wellFormed(page.markdown),
		truncated: page.truncated,
		omitted: { ...page.omitted },
	};
}

function convertCase(html: string, baseUrl: string, maxChars: number): ConvertCase {
	const input = wellFormed(html);
	return { html: input, baseUrl, maxChars, output: convert(input, { baseUrl, maxChars }) };
}

/** The entity document template; `crates/research-html/tests/vectors.rs` builds the same. */
export function entityDocument(name: string): string {
	return `&${name};|&${name}|&${name}x|&${name}=|<a t="&${name};|&${name}|&${name}x|&${name}=|&${name}">|</a>`;
}

function entitiesFile(): VectorFile {
	const bytes = Buffer.alloc(htmlDecodeTree.length * 2);
	htmlDecodeTree.forEach((word, index) => {
		bytes.writeUInt16LE(word, index * 2);
	});
	return {
		path: "html/entities.json",
		content: {
			trieLength: htmlDecodeTree.length,
			trieSha256: createHash("sha256").update(bytes).digest("hex"),
			names: entityNames().map((name) => ({
				name,
				events: JSON.stringify(recordEvents(entityDocument(name))),
			})),
		},
	};
}

function eventsFile(): VectorFile {
	const soup = new Soup(20261017);
	const inputs = [...TRICKY_HTML];
	for (let index = 0; index < 1_000; index += 1) inputs.push(soup.document(1 + soup.int(60)));
	for (let index = 0; index < 100; index += 1) inputs.push(soup.noise(1 + soup.int(400)));
	return {
		path: "html/events.json",
		content: inputs.map((input) => ({ input, events: JSON.stringify(recordEvents(input)) })),
	};
}

function testsFile(): VectorFile {
	const cases: ConvertCase[] = [];
	for (const input of TEST_INPUTS) {
		const html = joinPieces(input.html);
		const variants = new Set([input.maxChars]);
		// Small inputs also run at every corpus limit (truncation paths).
		if (html.length <= 20_000) for (const maxChars of MAX_CHARS) variants.add(maxChars);
		for (const maxChars of variants) {
			cases.push({
				html: input.html,
				baseUrl: input.baseUrl,
				maxChars,
				output: convert(html, { baseUrl: input.baseUrl, maxChars }),
			});
		}
	}
	return { path: "html/convert-tests.json", content: cases };
}

function trickyFile(): VectorFile {
	const cases: ConvertCase[] = [];
	TRICKY_HTML.forEach((html, index) => {
		cases.push(convertCase(html, TEST_BASE, 20_000));
		cases.push(convertCase(html, BASE_URLS[index % BASE_URLS.length] ?? "", 50));
		cases.push(
			convertCase(`<ul><li>${html}</li></ul><blockquote>${html}</blockquote>`, TEST_BASE, 20_000),
		);
		cases.push(
			convertCase(
				`<p>x</p><ul>${html}</ul><table><tr><td>${html}</td></tr></table>`,
				TEST_BASE,
				2_000,
			),
		);
	});
	return { path: "html/convert-tricky.json", content: cases };
}

/** The two fast-check properties of `htmlToMarkdown.test.ts`, sampled with fixed seeds. */
function propertyFile(): VectorFile {
	const openTags = [
		"div",
		"p",
		"span",
		"blockquote",
		"ul",
		"ol",
		"li",
		"table",
		"tr",
		"td",
		"th",
		"a",
		"strong",
		"em",
		"code",
		"pre",
		"h1",
		"h2",
		"section",
		"article",
		"main",
		"script",
		"style",
		"nav",
		"br",
		"hr",
		"img",
		"title",
	] as const;
	const htmlArbitrary = fc.letrec((tie) => ({
		node: fc.oneof(
			{ depthSize: "medium" },
			fc.constant("text"),
			fc.constant("mismatch"),
			tie("element") as fc.Arbitrary<string>,
		),
		element: fc
			.tuple(
				fc.constantFrom(...openTags),
				fc.array(tie("node") as fc.Arbitrary<string>, { maxLength: 4 }),
				fc.boolean(),
				fc.boolean(),
			)
			.map(([tag, children, close, mismatchClose]) => {
				if (tag === "br" || tag === "hr" || tag === "img") return `<${tag}>text`;
				if (tag === "a") return `<a href="https://other.example/x">${children.join("")}</a>`;
				const open = `<${tag}>`;
				if (!close) return `${open}${children.join("")}`;
				const closeTag = mismatchClose ? `</${tag}x>` : `</${tag}>`;
				return `${open}${children.join("")}${closeTag}`;
			}),
	})).node as fc.Arbitrary<string>;
	const structured = fc.sample(fc.tuple(htmlArbitrary, fc.integer({ min: 0, max: 20_000 })), {
		seed: 20261012,
		numRuns: 1_500,
	});
	const arbitrary = fc.sample(
		fc.tuple(
			fc.string({ maxLength: 2_000 }),
			fc.integer({ min: 0, max: 5_000 }),
			fc.string({ maxLength: 200 }),
		),
		{ seed: 20261017, numRuns: 1_000 },
	);
	return {
		path: "html/convert-property.json",
		content: [
			...structured.map(([html, maxChars]) => convertCase(html, TEST_BASE, maxChars)),
			...arbitrary.map(([html, maxChars, baseUrl]) =>
				convertCase(html, wellFormed(baseUrl), maxChars),
			),
		],
	};
}

function soupFiles(): VectorFile[] {
	const files: VectorFile[] = [];
	for (let part = 0; part < 4; part += 1) {
		const soup = new Soup(7_000 + part);
		const cases: ConvertCase[] = [];
		for (let index = 0; index < 1_000; index += 1) {
			const html =
				index % 20 === 19 ? soup.noise(1 + soup.int(2_000)) : soup.document(1 + soup.int(180));
			cases.push(convertCase(html, soup.pick(SOUP_BASE_URLS), soup.pick(SOUP_MAX_CHARS)));
		}
		files.push({ path: `html/convert-soup-${part}.json`, content: cases });
	}
	return files;
}

/* The `scripts/bench.ts` inputs, rebuilt here from the same recipe (the Rust test does too). */
function benchArticleHtml(): string {
	const articleSentence =
		"Grid-scale battery orders doubled year over year to 1,250 units as utilities restocked. ";
	const parts: string[] = [
		"<html><head><title>Grid battery orders double &amp; margins hold</title><style>p{color:red}</style>",
		'<script>window.tracker="x";</script></head><body><nav><a href="/home">home</a></nav><main><article><h1>Grid battery orders double</h1>',
	];
	for (let section = 0; section < 1_000; section += 1) {
		parts.push(
			`<h2>Section ${section}</h2><p>${articleSentence.repeat(8)}<strong>strong ${section}</strong> <a href="/a/${section}">link ${section}</a></p>`,
			`<ul><li>item ${section} a</li><li>item ${section} b<ul><li>nested ${section}</li></ul></li></ul>`,
			`<table><tr><th>Metric</th><th>Value</th></tr><tr><td>orders|units</td><td>${section}</td></tr></table>`,
			`<blockquote><p>quoted ${section}</p></blockquote><pre>code ${section}\n  indented</pre>`,
		);
	}
	parts.push("</article></main><aside>sidebar</aside><footer>footer</footer></body></html>");
	return parts.join("");
}

function benchDeepNestingHtml(): string {
	const longLine = `x${"y".repeat(1999)}`;
	return (
		"<blockquote><ul><li><strong><em>".repeat(4_000) +
		`<p>${`${longLine}<br>`.repeat(900)}</p>` +
		"</em></strong></li></ul></blockquote>".repeat(4_000)
	);
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function benchFile(): VectorFile {
	const baseUrl = "https://news.example.org/a/1";
	const cases = [
		{ name: "article", html: benchArticleHtml() },
		{ name: "deepNesting", html: benchDeepNestingHtml() },
	].flatMap(({ name, html }) =>
		[20_000, 2_000_000].map((maxChars) => {
			const { markdown, ...rest } = convert(html, { baseUrl, maxChars });
			// Full-size outputs (up to 2 MB) travel as a hash; the cut ones inline.
			return {
				name,
				inputLength: html.length,
				inputSha256: sha256(html),
				baseUrl,
				maxChars,
				output: { ...rest, markdownLength: markdown.length, markdownSha256: sha256(markdown) },
				markdown: markdown.length <= 50_000 ? markdown : null,
			};
		}),
	);
	return { path: "html/convert-bench.json", content: cases };
}

export const htmlExporter: VectorExporter = {
	name: "html",
	async build() {
		return [
			entitiesFile(),
			eventsFile(),
			testsFile(),
			trickyFile(),
			propertyFile(),
			...soupFiles(),
			benchFile(),
		];
	},
};
