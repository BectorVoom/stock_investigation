/**
 * Every literal `htmlToMarkdown` call of the converter's TypeScript suites
 * (`packages/adapters/test/tools/htmlToMarkdown{,Heuristics}.test.ts`),
 * mirrored here so the Rust port replays the same inputs. Completeness is
 * checked against a recording of the real suites (`capture.vitest.config.ts`,
 * `checkTestInputs.ts`). Large inputs are written as repeated parts, so the
 * vector files stay small and the Rust test rebuilds them byte for byte.
 */

/** One input piece: a string, or `[text, count]` for `text.repeat(count)`. */
export type Piece = string | readonly [string, number];

export interface TestInput {
	readonly html: readonly Piece[];
	readonly baseUrl: string;
	readonly maxChars: number;
}

export function joinPieces(pieces: readonly Piece[]): string {
	return pieces
		.map((piece) => (typeof piece === "string" ? piece : piece[0].repeat(piece[1])))
		.join("");
}

const BASE = "https://news.synthetic-wire.org/articles/2026/grid/";
const HEURISTICS_BASE = "https://energy.synthetic-wire.org/detail?id=1";
const X = "https://x.example/";
const XP = "https://x.example/p";

function tagMenuItems(count: number): string {
	const items: string[] = [];
	for (let index = 0; index < count; index += 1) {
		items.push(
			`<li><a href="https://energy.synthetic-wire.org/tag/${index}">synthetic tag ${index}</a></li>`,
		);
	}
	return items.join("");
}

function linkListItems(count: number): string {
	const items: string[] = [];
	for (let index = 0; index < count; index += 1) {
		items.push(`<li><a href="https://x.example/${index}">link ${index}</a></li>`);
	}
	return items.join("");
}

function buildDivOnlyPage(): string {
	return (
		`<html><head><title>Synthetic Energy Daily</title></head><body><div class="page-wrap">` +
		`<a href="https://energy.synthetic-wire.org/detail?id=1#page-sub-nav">Skip to sub-navigation</a>` +
		`<h1>Synthetic Energy Daily</h1>` +
		`<a href="https://energy.synthetic-wire.org/detail?id=1#page-content">Skip to page content</a>` +
		`<div class="sub-nav"><ul><li><a href="https://energy.synthetic-wire.org/recent">Recent articles</a></li>` +
		`<li><a href="https://energy.synthetic-wire.org/tags">Browse by tag</a><ul>${tagMenuItems(70)}</ul></li></ul></div>` +
		`<div class="detail"><h1>Grid storage orders double in synthetic region</h1>` +
		`<p>First synthetic paragraph about grid storage orders doubling year over year to 1250 units as utilities restocked across the region.</p>` +
		`<p>Second synthetic paragraph with an <a href="https://energy.synthetic-wire.org/report/1">inline report link</a> and more context about capacity additions.</p>` +
		`<h2>Capacity additions continue</h2>` +
		`<p>Third synthetic paragraph describing capacity additions of 100 gigawatt hours with <strong>Data source: </strong>Synthetic Survey Office trailing note.</p>` +
		`<p>Fourth synthetic paragraph covering price movements and inventory levels across synthetic markets.</p>` +
		`<p>Tags: <a href="https://energy.synthetic-wire.org/tag/storage">storage</a>, <a href="https://energy.synthetic-wire.org/tag/grid">grid</a>, <a href="https://energy.synthetic-wire.org/tag/orders">orders</a></p>` +
		`<div class="stats-farm"><ul>${linkListItems(12).replaceAll("https://x.example", "https://energy.synthetic-wire.org/stats").replaceAll("link ", "stat link ")}</ul></div></div>` +
		`<div id="footer"><p>Footer boilerplate with <a href="https://energy.synthetic-wire.org/about">about link</a> and contact details.</p></div>` +
		`</div></body></html>`
	);
}

const DROPPED_TAGS = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"canvas",
	"iframe",
	"object",
	"form",
	"button",
	"select",
	"textarea",
	"nav",
	"footer",
	"aside",
];

const DROP_ROLES = [
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"search",
	"menu",
	"menubar",
	"dialog",
	"alertdialog",
];

function single(html: string, baseUrl: string, maxChars: number): TestInput {
	return { html: [html], baseUrl, maxChars };
}

const paragraph = `<p>${"lorem ipsum dolor sit amet ".repeat(40)}</p>`;
const emphasis = '<strong><em><a href="https://other.example/x"><code>';

export const TEST_INPUTS: readonly TestInput[] = [
	// htmlToMarkdown.test.ts — headings and blocks
	single("<h1>A</h1><h2>B</h2><h6>C</h6>", BASE, 20_000),
	single("<p>one</p><div>two</div><section>three</section>", BASE, 20_000),
	single("<p>a<br>b</p><hr><p>c</p>", BASE, 20_000),
	single("  <p>  a   b  </p>\n\n\n<p>c</p>  ", BASE, 20_000),
	single("<p>a</p><br><br><br><p>b</p>", BASE, 20_000),
	// dropped content
	...DROPPED_TAGS.map((tag) =>
		single(`<p>keep</p><${tag}><p>drop</p>text</${tag}><p>kept</p>`, BASE, 20_000),
	),
	single(`<p>keep</p><embed src="https://evil.example/x"><p>kept</p>`, BASE, 20_000),
	single("<p>a<!-- secret -->b</p>", BASE, 20_000),
	single(`<p>a<img src="https://evil.example/x.png" alt="alt text">b</p>`, BASE, 20_000),
	single("<p>a &amp; b &lt;c&gt; &ldquo;q&rdquo; &#x1F600;</p>", BASE, 20_000),
	// main/article filtering
	single(
		"<html><head><title>Doc title</title></head><body><p>outside</p><main><p>inside</p></main></body></html>",
		BASE,
		20_000,
	),
	single("<div>chrome</div><article><p>story</p></article><div>more chrome</div>", BASE, 20_000),
	single("<article><p>story</p><script>steal()</script></article>", BASE, 20_000),
	// title
	single("<title>  A\n  B </title><p>x</p>", BASE, 100),
	{ html: ["<title>", ["t", 500], "</title>"], baseUrl: BASE, maxChars: 100 },
	single("<h1>Headline</h1><h1>Second</h1>", BASE, 100),
	single("<p>no heading</p>", BASE, 100),
	single("", BASE, 100),
	// inline formatting
	single("<p><strong>a</strong> <b>b</b> <em>c</em> <i>d</i> <code>e</code></p>", BASE, 20_000),
	single("<pre>  keep\n\tspaces  </pre>", BASE, 20_000),
	single("<blockquote><p>one</p><p>two</p></blockquote>", BASE, 20_000),
	// lists
	single("<ul><li>a</li><li>b</li></ul>", BASE, 20_000),
	single("<ol><li>a</li><li>b</li></ol>", BASE, 20_000),
	single("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>", BASE, 20_000),
	// links
	single('<p><a href="https://other.example/x">out</a></p>', BASE, 20_000),
	single('<p><a href="../up">up</a></p>', BASE, 20_000),
	single('<p><a href="javascript:steal()">a</a></p>', BASE, 20_000),
	single('<p><a href="data:text/html,x">b</a></p>', BASE, 20_000),
	single('<p><a href="mailto:someone@example.com">c</a></p>', BASE, 20_000),
	single('<p><a href="https://[::1">d</a></p>', BASE, 20_000),
	single('<p>a<a href="https://other.example/x"></a>b</p>', BASE, 20_000),
	single('<p>a<a href="https://other.example/x">   </a>b</p>', BASE, 20_000),
	// tables
	single(
		"<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
		BASE,
		20_000,
	),
	single("<table><tr><td>a|b<br>c</td></tr></table>", BASE, 20_000),
	// truncation
	single("<p>aaa</p><p>bbb</p><p>ccc</p>", BASE, 9),
	single("<p>aaa</p>", BASE, 3),
	single("<p>😀😀😀😀😀</p>", BASE, 4),
	// hostile and malformed input (the lone surrogate becomes U+FFFD, as a Rust string holds it)
	...[
		"",
		"\u0000\u0001��lone",
		"</p></div><",
		"<a><div><span>",
		"<table><div><tr>stray",
		"<ul>text<li>",
	].map((html) => single(html, BASE, 100)),
	single("<div><p>unclosed", BASE, 20_000),
	{ html: ["<div>", ["<div>", 10_000], "deep", ["</div>", 10_000]], baseUrl: BASE, maxChars: 100 },
	{
		html: ["<html><head><title>Big</title></head><body>", [paragraph, 2_000], "</body></html>"],
		baseUrl: BASE,
		maxChars: 100_000,
	},
	single("<p>a * b [c] `d`</p>", BASE, 20_000),
	// nested-pre termination
	single("<pre><pre>x</pre></pre>", BASE, 20_000),
	{ html: ["<pre>", ["<pre>", 5_000], "x", ["</pre>", 3_000]], baseUrl: BASE, maxChars: 20_000 },
	single("<div>keep<script>evil", BASE, 20_000),
	single("<div>keep<title>unclosed", BASE, 20_000),
	single("<div>keep<pre>unclosed", BASE, 20_000),
	// nesting ceilings and work budget
	{
		html: ["<blockquote>", ["<blockquote>", 40], "<p>", ["x<br>", 100], "</p>"],
		baseUrl: BASE,
		maxChars: 200_000,
	},
	{
		html: [["<blockquote>", 10_000], "<p>", ["x<br>", 50_000], "</p>", ["</blockquote>", 10_000]],
		baseUrl: BASE,
		maxChars: 20_000,
	},
	{
		html: ["<ul>", ["<ul><li>a", 200], ["</li></ul>", 200]],
		baseUrl: BASE,
		maxChars: 200_000,
	},
	{
		html: [["<table>", 200], "<tr><td>cell</td></tr>", ["</table>", 200]],
		baseUrl: BASE,
		maxChars: 200_000,
	},
	{
		html: ["<p>", [emphasis, 100], "t", ["</code></a></em></strong>", 100], "</p>"],
		baseUrl: BASE,
		maxChars: 200_000,
	},
	// htmlToMarkdownHeuristics.test.ts
	single(buildDivOnlyPage(), HEURISTICS_BASE, 20_000),
	...DROP_ROLES.map((role) =>
		single(`<p>keep</p><div role="${role}"><p>drop</p></div><p>kept</p>`, X, 20_000),
	),
	single(`<p>keep</p><div aria-hidden="true"><p>drop</p></div><p>kept</p>`, X, 20_000),
	single(`<p>keep</p><div hidden><p>drop</p></div><p>kept</p>`, X, 20_000),
	single(`<p>keep</p><div aria-hidden="false"><p>shown</p></div>`, X, 20_000),
	single(`<p>outside</p><div role="main"><p>inside</p></div>`, X, 20_000),
	single(`<p>keep</p><div class="sidebar"><p>drop</p></div><p>kept</p>`, X, 20_000),
	single(`<p>keep</p><div id="footer"><p>drop</p></div>`, X, 20_000),
	single(`<p>keep</p><div class="sub-nav"><p>drop</p></div>`, X, 20_000),
	single(`<div class="document"><p>kept text</p></div>`, X, 20_000),
	single(`<main><div class="sidebar"><p>kept</p></div></main>`, X, 20_000),
	single(`<p><a href="#frag">frag text</a> after</p>`, XP, 20_000),
	single(`<p><a href="https://x.example/p#frag">frag text</a> after</p>`, XP, 20_000),
	single(`<p><a href="https://other.example/x">out</a> after</p>`, XP, 20_000),
	single(`<p><a href="https://other.example/x">Skip to content</a>after</p>`, XP, 20_000),
	single(`<p><a href="https://other.example/x">Skip content</a>after</p>`, XP, 20_000),
	single(`<p>intro</p><ul>${linkListItems(5)}</ul>`, X, 20_000),
	single(`<ul>${linkListItems(4)}</ul>`, X, 20_000),
	single(`<article><ul>${linkListItems(5)}</ul></article>`, X, 20_000),
	single(
		`<ul>${linkListItems(4)}<li><a href="https://x.example/extra">extra</a> with note</li></ul>`,
		X,
		20_000,
	),
	single(`<p>chrome</p><h1>Article</h1><p>${"word ".repeat(150)}</p>`, X, 20_000),
	single(
		`<h1>Site title</h1><p>short</p><h1>Article title</h1><p>${"word ".repeat(150)}</p>`,
		X,
		20_000,
	),
	single(`<p>just text</p><p>more text</p>`, X, 20_000),
	single(`<p><strong>Data source: </strong>U.S. Energy</p>`, X, 20_000),
	single(`<p><em>note </em>after</p>`, X, 20_000),
];
