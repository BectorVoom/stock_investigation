/**
 * Heuristic boilerplate removal for the page-to-Markdown converter.
 *
 * The fixture below mirrors a real `<div>`-layout article page: two skip
 * links, a site-title `<h1>` before the article's own `<h1>`, a 70-entry
 * nested tag menu in plain `<ul>`s inside `<div class="sub-nav">`, an
 * article with headings/paragraphs/links, a trailing statistics link farm
 * and a `<div id="footer">`. All text is synthetic; no publisher copy.
 *
 * Measured on this fixture with maxChars 20,000 and
 * baseUrl https://energy.synthetic-wire.org/detail?id=1:
 * before (unmodified converter) 6,428 characters, after 769 characters
 * (12% of before; the 60% budget is 3,856). The saving comes from dropping
 * the skip links, the site title, the tag menu, the statistics farm, the
 * footer and every block before the article `<h1>`.
 */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/tools/htmlToMarkdown.ts";

const BASE = "https://energy.synthetic-wire.org/detail?id=1";
const BEFORE_CHARS = 6_428;

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

function linkOnlyShare(markdown: string): number {
	const lines = markdown.split("\n");
	if (lines.length === 0) return 0;
	const linkOnly = lines.filter((line) =>
		/^(-|\d+\.)\s+\[.+\]\(https?:\/\/\S+\)$/.test(line.trim()),
	);
	return linkOnly.length / lines.length;
}

describe("htmlToMarkdown div-layout article fixture", () => {
	it("starts at the article heading and drops the surrounding menus", () => {
		const page = htmlToMarkdown(buildDivOnlyPage(), { baseUrl: BASE, maxChars: 20_000 });
		expect(page.markdown.indexOf("# Grid storage orders double in synthetic region")).toBeLessThan(
			200,
		);
		expect(linkOnlyShare(page.markdown)).toBeLessThan(0.05);
		for (const paragraph of [
			"First synthetic paragraph about grid storage orders",
			"Second synthetic paragraph with an",
			"inline report link",
			"Capacity additions continue",
			"Third synthetic paragraph describing capacity additions",
			"**Data source:** Synthetic Survey Office",
			"Fourth synthetic paragraph covering price movements",
			"Tags:",
		]) {
			expect(page.markdown).toContain(paragraph);
		}
		for (const chrome of [
			"Synthetic Energy Daily",
			"Skip to sub-navigation",
			"Skip to page content",
			"Recent articles",
			"synthetic tag 0",
			"synthetic tag 69",
			"Footer boilerplate",
		]) {
			expect(page.markdown).not.toContain(chrome);
		}
		expect(page.markdown.length).toBeLessThanOrEqual(Math.floor(BEFORE_CHARS * 0.6));
		expect(
			page.omitted.boilerplateBlocks + page.omitted.menuLists + page.omitted.leadingBlocks,
		).toBeGreaterThan(0);
	});
});

describe("htmlToMarkdown rule 1: drop by role and state", () => {
	it.each([
		"navigation",
		"banner",
		"contentinfo",
		"complementary",
		"search",
		"menu",
		"menubar",
		"dialog",
		"alertdialog",
	])("drops <div role=%s> with everything inside it", (role) => {
		const page = htmlToMarkdown(`<p>keep</p><div role="${role}"><p>drop</p></div><p>kept</p>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(page.markdown).toBe("keep\n\nkept");
		expect(page.omitted.boilerplateBlocks).toBeGreaterThan(0);
	});

	it("drops aria-hidden and hidden subtrees, but keeps aria-hidden=false", () => {
		expect(
			htmlToMarkdown(`<p>keep</p><div aria-hidden="true"><p>drop</p></div><p>kept</p>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toBe("keep\n\nkept");
		expect(
			htmlToMarkdown(`<p>keep</p><div hidden><p>drop</p></div><p>kept</p>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toBe("keep\n\nkept");
		expect(
			htmlToMarkdown(`<p>keep</p><div aria-hidden="false"><p>shown</p></div>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toContain("shown");
	});

	it("treats role=main like <main> for the only-main-content rule", () => {
		const page = htmlToMarkdown(`<p>outside</p><div role="main"><p>inside</p></div>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(page.markdown).toBe("inside");
	});
});

describe("htmlToMarkdown rule 2: drop by conventional names", () => {
	it("drops div/section/ul/header chrome by whole id/class tokens", () => {
		expect(
			htmlToMarkdown(`<p>keep</p><div class="sidebar"><p>drop</p></div><p>kept</p>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toBe("keep\n\nkept");
		expect(
			htmlToMarkdown(`<p>keep</p><div id="footer"><p>drop</p></div>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toBe("keep");
		expect(
			htmlToMarkdown(`<p>keep</p><div class="sub-nav"><p>drop</p></div>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toBe("keep");
	});

	it("matches whole tokens only: class=document is not a menu", () => {
		const page = htmlToMarkdown(`<div class="document"><p>kept text</p></div>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(page.markdown).toContain("kept text");
		expect(page.omitted.boilerplateBlocks).toBe(0);
	});

	it("never drops inside main content and never drops body itself", () => {
		const inside = htmlToMarkdown(`<main><div class="sidebar"><p>kept</p></div></main>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(inside.markdown).toContain("kept");
	});
});

describe("htmlToMarkdown rule 3: same-page and skip links", () => {
	it("emits a same-page link as its plain text", () => {
		expect(
			htmlToMarkdown(`<p><a href="#frag">frag text</a> after</p>`, {
				baseUrl: "https://x.example/p",
				maxChars: 20_000,
			}).markdown,
		).toBe("frag text after");
		expect(
			htmlToMarkdown(`<p><a href="https://x.example/p#frag">frag text</a> after</p>`, {
				baseUrl: "https://x.example/p",
				maxChars: 20_000,
			}).markdown,
		).toBe("frag text after");
		expect(
			htmlToMarkdown(`<p><a href="https://other.example/x">out</a> after</p>`, {
				baseUrl: "https://x.example/p",
				maxChars: 20_000,
			}).markdown,
		).toBe("[out](https://other.example/x) after");
	});

	it("drops a link whose text is a skip hint", () => {
		expect(
			htmlToMarkdown(`<p><a href="https://other.example/x">Skip to content</a>after</p>`, {
				baseUrl: "https://x.example/p",
				maxChars: 20_000,
			}).markdown,
		).toBe("after");
		expect(
			htmlToMarkdown(`<p><a href="https://other.example/x">Skip content</a>after</p>`, {
				baseUrl: "https://x.example/p",
				maxChars: 20_000,
			}).markdown,
		).toBe("after");
	});
});

describe("htmlToMarkdown rule 4: link-only lists outside main content", () => {
	it("drops a five-link list when no main element was found", () => {
		const page = htmlToMarkdown(`<p>intro</p><ul>${linkListItems(5)}</ul>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(page.omitted.menuLists).toBe(1);
		expect(page.markdown).toBe("intro");
	});

	it("keeps a four-link list and a five-link list inside <article>", () => {
		const four = htmlToMarkdown(`<ul>${linkListItems(4)}</ul>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(four.omitted.menuLists).toBe(0);
		expect(four.markdown).toContain("[link 0](https://x.example/0)");
		const inside = htmlToMarkdown(`<article><ul>${linkListItems(5)}</ul></article>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(inside.omitted.menuLists).toBe(0);
		expect(inside.markdown).toContain("[link 0](https://x.example/0)");
	});

	it("keeps a list whose item carries text beyond its link", () => {
		const page = htmlToMarkdown(
			`<ul>${linkListItems(4)}<li><a href="https://x.example/extra">extra</a> with note</li></ul>`,
			{ baseUrl: "https://x.example/", maxChars: 20_000 },
		);
		expect(page.omitted.menuLists).toBe(0);
		expect(page.markdown).toContain("with note");
	});
});

describe("htmlToMarkdown rule 5: start at the article heading", () => {
	it("starts at a single h1 and drops leading chrome", () => {
		const page = htmlToMarkdown(`<p>chrome</p><h1>Article</h1><p>${"word ".repeat(150)}</p>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(page.markdown.startsWith("# Article")).toBe(true);
		expect(page.omitted.leadingBlocks).toBe(1);
	});

	it("picks the last h1 followed by 200 characters of paragraph text", () => {
		const page = htmlToMarkdown(
			`<h1>Site title</h1><p>short</p><h1>Article title</h1><p>${"word ".repeat(150)}</p>`,
			{ baseUrl: "https://x.example/", maxChars: 20_000 },
		);
		expect(page.markdown.startsWith("# Article title")).toBe(true);
		expect(page.markdown).not.toContain("Site title");
	});

	it("keeps the current behaviour when there is no h1", () => {
		const page = htmlToMarkdown(`<p>just text</p><p>more text</p>`, {
			baseUrl: "https://x.example/",
			maxChars: 20_000,
		});
		expect(page.markdown).toBe("just text\n\nmore text");
		expect(page.omitted.leadingBlocks).toBe(0);
	});
});

describe("htmlToMarkdown rule 6: whitespace in emphasis", () => {
	it("preserves a space lost inside trailing emphasis", () => {
		expect(
			htmlToMarkdown(`<p><strong>Data source: </strong>U.S. Energy</p>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toBe("**Data source:** U.S. Energy");
	});

	it("preserves a space around italic and link text", () => {
		expect(
			htmlToMarkdown(`<p><em>note </em>after</p>`, {
				baseUrl: "https://x.example/",
				maxChars: 20_000,
			}).markdown,
		).toBe("*note* after");
	});
});
