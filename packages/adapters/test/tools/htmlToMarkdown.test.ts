import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/tools/htmlToMarkdown.ts";

const BASE = "https://news.synthetic-wire.org/articles/2026/grid/";

function convert(html: string, maxChars = 20_000, baseUrl: string = BASE): string {
	return htmlToMarkdown(html, { baseUrl, maxChars }).markdown;
}

describe("htmlToMarkdown headings and blocks", () => {
	it("maps h1..h6 to #..######", () => {
		expect(convert("<h1>A</h1><h2>B</h2><h6>C</h6>")).toBe("# A\n\n## B\n\n###### C");
	});

	it("separates p, div and section blocks with one blank line", () => {
		expect(convert("<p>one</p><div>two</div><section>three</section>")).toBe("one\n\ntwo\n\nthree");
	});

	it("turns br into a line break and hr into ---", () => {
		expect(convert("<p>a<br>b</p><hr><p>c</p>")).toBe("a\nb\n\n---\n\nc");
	});

	it("collapses whitespace, trims the ends and keeps at most one blank line", () => {
		expect(convert("  <p>  a   b  </p>\n\n\n<p>c</p>  ")).toBe("a b\n\nc");
		expect(convert("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb");
	});
});

describe("htmlToMarkdown dropped content", () => {
	it.each([
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
	])("drops <%s> with everything inside it", (tag) => {
		expect(convert(`<p>keep</p><${tag}><p>drop</p>text</${tag}><p>kept</p>`)).toBe("keep\n\nkept");
	});

	it("drops the void <embed> element itself", () => {
		// `embed` is a void element: per HTML it cannot contain anything, so
		// the parser treats following siblings as siblings, not contents.
		expect(convert(`<p>keep</p><embed src="https://evil.example/x"><p>kept</p>`)).toBe(
			"keep\n\nkept",
		);
	});

	it("drops HTML comments and images entirely (no alt text, no URL)", () => {
		// Like `toPlainText` in the domain, removing inline markup inserts no
		// space, so "CO<sub>2</sub>" never becomes "CO 2".
		expect(convert("<p>a<!-- secret -->b</p>")).toBe("ab");
		expect(convert(`<p>a<img src="https://evil.example/x.png" alt="alt text">b</p>`)).toBe("ab");
	});

	it("decodes character references", () => {
		expect(convert("<p>a &amp; b &lt;c&gt; &ldquo;q&rdquo; &#x1F600;</p>")).toBe(
			"a & b <c> “q” 😀",
		);
	});
});

describe("htmlToMarkdown main/article filtering", () => {
	it("keeps only text inside main/article when one exists, but still reads <title>", () => {
		const page = htmlToMarkdown(
			"<html><head><title>Doc title</title></head><body><p>outside</p><main><p>inside</p></main></body></html>",
			{ baseUrl: BASE, maxChars: 20_000 },
		);
		expect(page.markdown).toBe("inside");
		expect(page.title).toBe("Doc title");
	});

	it("keeps only article text when article exists", () => {
		expect(convert("<div>chrome</div><article><p>story</p></article><div>more chrome</div>")).toBe(
			"story",
		);
	});

	it("drops a script smuggled inside an article", () => {
		expect(convert("<article><p>story</p><script>steal()</script></article>")).toBe("story");
	});
});

describe("htmlToMarkdown title", () => {
	it("prefers <title>, collapsing whitespace and capping at 300 characters", () => {
		expect(
			htmlToMarkdown("<title>  A\n  B </title><p>x</p>", { baseUrl: BASE, maxChars: 100 }).title,
		).toBe("A B");
		const long = htmlToMarkdown(`<title>${"t".repeat(500)}</title>`, {
			baseUrl: BASE,
			maxChars: 100,
		});
		expect(long.title?.length).toBe(300);
	});

	it("falls back to the first h1, else null", () => {
		expect(
			htmlToMarkdown("<h1>Headline</h1><h1>Second</h1>", { baseUrl: BASE, maxChars: 100 }).title,
		).toBe("Headline");
		expect(htmlToMarkdown("<p>no heading</p>", { baseUrl: BASE, maxChars: 100 }).title).toBeNull();
		expect(htmlToMarkdown("", { baseUrl: BASE, maxChars: 100 }).title).toBeNull();
	});
});

describe("htmlToMarkdown inline formatting", () => {
	it("bolds, italicizes and wraps code", () => {
		expect(convert("<p><strong>a</strong> <b>b</b> <em>c</em> <i>d</i> <code>e</code></p>")).toBe(
			"**a** **b** *c* *d* `e`",
		);
	});

	it("keeps pre line breaks inside a fenced block", () => {
		// Whitespace is preserved verbatim inside `pre`; only the fence is added.
		expect(convert("<pre>  keep\n\tspaces  </pre>")).toBe("```\n  keep\n\tspaces  \n```");
	});

	it("prefixes blockquote lines with > ", () => {
		expect(convert("<blockquote><p>one</p><p>two</p></blockquote>")).toBe("> one\n> two");
	});
});

describe("htmlToMarkdown lists", () => {
	it("renders ul and ol items, nesting two spaces per level", () => {
		expect(convert("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
		expect(convert("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
		expect(convert("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>")).toBe(
			"- a\n  - b\n    - c\n- d",
		);
	});
});

describe("htmlToMarkdown links", () => {
	it("keeps http(s) links with absolute URLs", () => {
		expect(convert('<p><a href="https://other.example/x">out</a></p>')).toBe(
			"[out](https://other.example/x)",
		);
	});

	it("resolves a relative href against baseUrl on a <base>-less page", () => {
		expect(convert('<p><a href="../up">up</a></p>')).toBe(
			"[up](https://news.synthetic-wire.org/articles/2026/up)",
		);
	});

	it("reduces javascript:, data:, mailto: and unparsable hrefs to plain text", () => {
		expect(convert('<p><a href="javascript:steal()">a</a></p>')).toBe("a");
		expect(convert('<p><a href="data:text/html,x">b</a></p>')).toBe("b");
		expect(convert('<p><a href="mailto:someone@example.com">c</a></p>')).toBe("c");
		expect(convert('<p><a href="https://[::1">d</a></p>')).toBe("d");
	});

	it("drops a link with empty text", () => {
		expect(convert('<p>a<a href="https://other.example/x"></a>b</p>')).toBe("ab");
		expect(convert('<p>a<a href="https://other.example/x">   </a>b</p>')).toBe("ab");
	});
});

describe("htmlToMarkdown tables", () => {
	it("renders one line per row with a separator after the first row", () => {
		expect(
			convert(
				"<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
			),
		).toBe("| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |");
	});

	it("replaces line breaks and pipes in cells with spaces", () => {
		expect(convert("<table><tr><td>a|b<br>c</td></tr></table>")).toBe("| a b c |\n| --- |");
	});
});

describe("htmlToMarkdown truncation", () => {
	it("cuts at the last block boundary that fits and reports truncated", () => {
		const page = htmlToMarkdown("<p>aaa</p><p>bbb</p><p>ccc</p>", {
			baseUrl: BASE,
			maxChars: 9,
		});
		expect(page.markdown).toBe("aaa\n\nbbb");
		expect(page.truncated).toBe(true);
	});

	it("reports truncated false when everything fits", () => {
		const page = htmlToMarkdown("<p>aaa</p>", { baseUrl: BASE, maxChars: 3 });
		expect(page.markdown).toBe("aaa");
		expect(page.truncated).toBe(false);
	});

	it("cuts a single over-long block without splitting a surrogate pair", () => {
		const page = htmlToMarkdown("<p>😀😀😀😀😀</p>", { baseUrl: BASE, maxChars: 4 });
		expect(page.markdown).toBe("😀😀");
		expect(page.truncated).toBe(true);
	});
});

describe("htmlToMarkdown hostile and malformed input", () => {
	it("never throws on binary garbage, stray tags or empty input", () => {
		for (const input of [
			"",
			"\u0000\u0001�\uD800lone",
			"</p></div><",
			"<a><div><span>",
			"<table><div><tr>stray",
			"<ul>text<li>",
		]) {
			const page = htmlToMarkdown(input, { baseUrl: BASE, maxChars: 100 });
			expect(page.markdown.length).toBeLessThanOrEqual(100);
		}
	});

	it("keeps text from unclosed tags", () => {
		expect(convert("<div><p>unclosed")).toContain("unclosed");
	});

	it("survives 10,000 levels of nesting without a stack overflow", () => {
		const page = htmlToMarkdown(`<div>${"<div>".repeat(10_000)}deep${"</div>".repeat(10_000)}`, {
			baseUrl: BASE,
			maxChars: 100,
		});
		expect(page.markdown).toBe("deep");
	});

	it("converts a 2 MB page", () => {
		const paragraph = `<p>${"lorem ipsum dolor sit amet ".repeat(40)}</p>`;
		const big = `<html><head><title>Big</title></head><body>${paragraph.repeat(2_000)}</body></html>`;
		expect(big.length).toBeGreaterThan(2_000_000);
		const started = Date.now();
		const page = htmlToMarkdown(big, { baseUrl: BASE, maxChars: 100_000 });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(page.markdown.length).toBeLessThanOrEqual(100_000);
		expect(page.truncated).toBe(true);
	});

	it("does not attempt Markdown escaping of text", () => {
		// The output is plain text for a model, never rendered as HTML (UI-005):
		// literal markup characters stay literal.
		expect(convert("<p>a * b [c] `d`</p>")).toBe("a * b [c] `d`");
	});
});

describe("htmlToMarkdown property", () => {
	it("never throws on arbitrary strings and respects maxChars", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 2_000 }),
				fc.integer({ min: 0, max: 5_000 }),
				fc.string({ maxLength: 200 }),
				(html, maxChars, baseUrl) => {
					const page = htmlToMarkdown(html, { baseUrl, maxChars });
					expect(page.markdown.length).toBeLessThanOrEqual(maxChars);
					if (page.title !== null) expect(page.title.length).toBeLessThanOrEqual(300);
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe("htmlToMarkdown nested-pre termination (finding 1)", () => {
	it("returns on nested <pre> instead of hanging", () => {
		const started = Date.now();
		const page = htmlToMarkdown("<pre><pre>x</pre></pre>", { baseUrl: BASE, maxChars: 20_000 });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(page.markdown).toContain("x");
	});

	it("returns on deeply nested and mismatched pre tags", () => {
		const started = Date.now();
		const page = htmlToMarkdown(`<pre>${"<pre>".repeat(5_000)}x${"</pre>".repeat(3_000)}`, {
			baseUrl: BASE,
			maxChars: 20_000,
		});
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(page.markdown).toContain("x");
	});

	it("returns on unclosed dropped, title and pre elements", () => {
		const started = Date.now();
		expect(
			htmlToMarkdown("<div>keep<script>evil", { baseUrl: BASE, maxChars: 20_000 }).markdown,
		).toContain("keep");
		expect(
			htmlToMarkdown("<div>keep<title>unclosed", { baseUrl: BASE, maxChars: 20_000 }).markdown,
		).toContain("keep");
		expect(
			htmlToMarkdown("<div>keep<pre>unclosed", { baseUrl: BASE, maxChars: 20_000 }).markdown,
		).toContain("keep");
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});

describe("htmlToMarkdown nesting ceilings and work budget (finding 2)", () => {
	it("flattens blockquotes past 32 levels instead of rebuilding lines per level", () => {
		const body = `<p>${"x<br>".repeat(100)}</p>`;
		const page = htmlToMarkdown(`<blockquote>${"<blockquote>".repeat(40)}${body}`, {
			baseUrl: BASE,
			maxChars: 200_000,
		});
		const prefixes = page.markdown.split("\n")[0]?.match(/^> /g);
		expect(prefixes).not.toBeNull();
		// 41 opens but at most 32 levels of `>` prefixing.
		const depth =
			(page.markdown
				.split("\n")[0]
				?.match(/^(> )+/)?.[0]
				.split(" ").length ?? 1) - 1;
		expect(depth).toBeLessThanOrEqual(32);
		expect(page.markdown).toContain("x");
	});

	it("keeps 10,000 nested blockquotes around 50,000 lines linear and bounded", () => {
		const big =
			"<blockquote>".repeat(10_000) +
			`<p>${"x<br>".repeat(50_000)}</p>` +
			"</blockquote>".repeat(10_000);
		expect(big.length).toBeLessThanOrEqual(2_000_000);
		const started = Date.now();
		const page = htmlToMarkdown(big, { baseUrl: BASE, maxChars: 20_000 });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(page.markdown.length).toBeLessThanOrEqual(20_000);
		expect(page.truncated).toBe(true);
	});

	it("flattens deep lists, tables and emphasis instead of blowing up", () => {
		const started = Date.now();
		const lists = `<ul>${"<ul><li>a".repeat(200)}${"</li></ul>".repeat(200)}`;
		const listPage = htmlToMarkdown(lists, { baseUrl: BASE, maxChars: 200_000 });
		expect(listPage.markdown.length).toBeLessThanOrEqual(200_000);
		const tables = `${"<table>".repeat(200)}<tr><td>cell</td></tr>${"</table>".repeat(200)}`;
		const tablePage = htmlToMarkdown(tables, { baseUrl: BASE, maxChars: 200_000 });
		// Nested tables render into their parent table frame, which holds no
		// blocks (pre-existing semantics): assert boundedness, not content.
		expect(tablePage.markdown.length).toBeLessThanOrEqual(200_000);
		const emph = `${'<strong><em><a href="https://other.example/x"><code>'.repeat(100)}t${"</code></a></em></strong>".repeat(100)}`;
		const emphPage = htmlToMarkdown(`<p>${emph}</p>`, { baseUrl: BASE, maxChars: 200_000 });
		expect(emphPage.markdown).toContain("t");
		expect(emphPage.markdown.length).toBeLessThanOrEqual(200_000);
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});

/**
 * Structured-HTML property test: a generator of nested special elements
 * (depth up to 40, random mismatched/unclosed tags) that the arbitrary-string
 * property test almost never produces. Fixed seed so failures reproduce.
 */
describe("htmlToMarkdown structured-HTML property", () => {
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

	it("returns within a time bound, respects maxChars and never throws", () => {
		fc.assert(
			fc.property(htmlArbitrary, fc.integer({ min: 0, max: 20_000 }), (html, maxChars) => {
				const started = Date.now();
				const page = htmlToMarkdown(html, { baseUrl: BASE, maxChars });
				expect(Date.now() - started).toBeLessThan(5_000);
				expect(page.markdown.length).toBeLessThanOrEqual(maxChars);
				if (page.title !== null) expect(page.title.length).toBeLessThanOrEqual(300);
			}),
			{ numRuns: 500, seed: 20261012 },
		);
	});
});
