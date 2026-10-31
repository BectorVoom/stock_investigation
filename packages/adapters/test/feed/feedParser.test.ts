import { readFileSync } from "node:fs";
import { normalizeFeed } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createFeedParser, MAX_FEED_BYTES } from "../../src/feed/index.ts";

function fixture(name: string): string {
	return readFileSync(
		new URL(`../../../../examples/fixtures/feeds/${name}`, import.meta.url),
		"utf8",
	);
}

const parser = createFeedParser();

function parseOk(text: string) {
	const parsed = parser.parse(text);
	if (!parsed.ok) throw new Error("expected a feed");
	return parsed.value;
}

describe("feed parser: RSS 2.0", () => {
	const feed = parseOk(fixture("rss2-synthetic.xml"));

	it("reads channel metadata and decodes predefined entities once", () => {
		expect(feed.kind).toBe("rss");
		expect(feed.title).toBe("Synthetic Industry Wire & Review");
		// The channel's own <link>, not the atom:link rel="self".
		expect(feed.siteLink).toBe("https://news.synthetic-wire.org/");
		expect(feed.items).toHaveLength(5);
	});

	it("keeps CDATA literal and entity-decodes ordinary text", () => {
		const [first, second] = feed.items;
		// CDATA content is literal: its markup and bare ampersand are passed through untouched.
		expect(first?.title).toBe("Grid battery orders <b>double</b> at Example Storage & Co");
		expect(first?.link).toBe(
			"https://news.synthetic-wire.org/2026/10/grid-battery-orders?utm_source=rss&id=7",
		);
		expect(first?.publishedText).toBe("Mon, 05 Oct 2026 09:30:00 GMT");
		expect(first?.summaryText).toBe(
			"<p>Orders for grid-scale batteries <em>doubled</em> year over year, the company said.</p>",
		);
		expect(second?.title).toBe("Heat pump shipments rise 12% <update>");
	});

	it("falls back to a permalink guid, dc:date and content:encoded", () => {
		const second = feed.items[1];
		expect(second?.link).toBe("https://news.synthetic-wire.org/2026/10/heat-pump-shipments");
		expect(second?.publishedText).toBe("2026-10-04T08:00:00+09:00");
		expect(second?.summaryText).toBe("<div>Full text fallback: shipments rose 12%.</div>");
	});

	it("does not treat a non-permalink guid as a link", () => {
		const parsed = parseOk(
			'<rss version="2.0"><channel><title>t</title><item><title>a</title><guid isPermaLink="false">https://news.synthetic-wire.org/not-a-link</guid></item></channel></rss>',
		);
		expect(parsed.items[0]?.link).toBeNull();
	});

	it("handles a single item and a channel with no items", () => {
		const one = parseOk(
			"<rss><channel><title>t</title><item><title>only</title><link>https://a.synthetic-wire.org/1</link></item></channel></rss>",
		);
		expect(one.items.map((item) => item.title)).toEqual(["only"]);
		const none = parseOk("<rss><channel><title>t</title></channel></rss>");
		expect(none.items).toEqual([]);
		expect(none.siteLink).toBeNull();
	});

	it("produces raw fields that the domain normalizes and filters", () => {
		const normalized = normalizeFeed(feed, {
			publisher: "Synthetic Industry Wire",
			retrievedAt: "2026-10-11T00:00:00.000Z",
			licensePolicy: "short-excerpt-permitted",
			maxItems: 100,
		});
		expect(normalized.articles.map((article) => article.canonicalUrl)).toEqual([
			"https://news.synthetic-wire.org/2026/10/grid-battery-orders?id=7",
			"https://news.synthetic-wire.org/2026/10/heat-pump-shipments",
			"https://news.synthetic-wire.org/2026/10/injected-item",
		]);
		expect(normalized.articles[0]?.title).toBe(
			"Grid battery orders double at Example Storage & Co",
		);
		expect(normalized.articles[0]?.publishedAt).toBe("2026-10-05T09:30:00.000Z");
		expect(normalized.articles[1]?.publishedAt).toBe("2026-10-03T23:00:00.000Z");
		// The item pointing at http://192.168.1.1 and the untitled item are rejected by the domain.
		expect(normalized.rejected).toEqual([
			{ reason: "UNSAFE_LINK", index: 3, detail: "SCHEME_NOT_ALLOWED" },
			{ reason: "MISSING_TITLE", index: 4 },
		]);
	});
});

describe("feed parser: Atom", () => {
	const feed = parseOk(fixture("atom-synthetic.xml"));

	it("prefers rel=alternate for the feed and for entries", () => {
		expect(feed.kind).toBe("atom");
		expect(feed.title).toBe("Synthetic Semiconductor Notes");
		expect(feed.siteLink).toBe("https://synthetic-notes.org/");
		expect(feed.items).toHaveLength(3);
		// enclosure and self come first in the document; alternate must still win.
		expect(feed.items[0]?.link).toBe(
			"https://synthetic-notes.org/posts/packaging-capacity?a=1&b=2",
		);
	});

	it("treats a link without rel as alternate and never uses rel=self", () => {
		expect(feed.items[1]?.link).toBe("https://synthetic-notes.org/posts/second-entry");
		expect(feed.items[2]?.link).toBeNull();
	});

	it("reads published before updated, and summary before content", () => {
		expect(feed.items[0]?.publishedText).toBe("2026-10-05T06:00:00Z");
		expect(feed.items[1]?.publishedText).toBe("2026-10-01T10:00:00+09:00");
		// One XML layer decoded; the HTML layer is left for the domain.
		expect(feed.items[0]?.title).toBe("Packaging capacity &amp; lead times");
		expect(feed.items[0]?.summaryText).toBe(
			"<p>Advanced packaging lead times lengthened to <b>40 weeks</b>.</p>",
		);
	});

	it("flattens XHTML content to its text", () => {
		const summary = feed.items[1]?.summaryText ?? "";
		expect(summary).toContain("Substrate supply");
		expect(summary).toContain("tightened");
		expect(summary).not.toContain("<");
	});

	it("accepts the atom: prefix", () => {
		const prefixed = parseOk(
			'<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>P</atom:title><atom:entry><atom:title>e</atom:title><atom:link href="https://synthetic-notes.org/p"/><atom:updated>2026-10-01T00:00:00Z</atom:updated></atom:entry></atom:feed>',
		);
		expect(prefixed.kind).toBe("atom");
		expect(prefixed.items).toEqual([
			{
				title: "e",
				link: "https://synthetic-notes.org/p",
				publishedText: "2026-10-01T00:00:00Z",
				summaryText: null,
			},
		]);
	});
});

describe("feed parser: RSS 1.0 (RDF)", () => {
	it("reads items that are siblings of the channel", () => {
		const feed = parseOk(fixture("rss1-rdf-synthetic.xml"));
		expect(feed.kind).toBe("rss");
		expect(feed.title).toBe("合成経済ニュース");
		expect(feed.siteLink).toBe("https://synthetic-keizai.org/");
		expect(feed.items).toEqual([
			{
				title: "データセンター向け電力設備の受注が拡大",
				link: "https://synthetic-keizai.org/articles/1001",
				publishedText: "2026-10-05T09:00:00+09:00",
				summaryText: "変圧器の受注残は前年同期比で増加した。",
			},
			{
				title: "半導体製造装置の出荷見通し",
				link: "https://synthetic-keizai.org/articles/1002",
				publishedText: "2026-10-03T15:30:00+09:00",
				summaryText: null,
			},
		]);
	});
});

describe("feed parser: hostile and non-feed input", () => {
	it("never expands DOCTYPE entities (billion laughs)", () => {
		const startedAt = performance.now();
		const parsed = parser.parse(fixture("billion-laughs-synthetic.xml"));
		const elapsedMs = performance.now() - startedAt;
		// Expansion would produce 3 GB of text; unexpanded, the reference stays a short literal.
		expect(elapsedMs).toBeLessThan(1000);
		// The references stay inert literal text.
		const feed = parseOk(fixture("billion-laughs-synthetic.xml"));
		expect(parsed.ok).toBe(true);
		expect(feed.title).toBe("&lol9;");
		expect(feed.items[0]?.title).toBe("&lol9;");
		expect(feed.items[0]?.summaryText).toBe("&lol9;");
		expect(JSON.stringify(feed)).not.toContain("lollol");
	});

	it("never resolves external entities (XXE)", () => {
		const parsed = parser.parse(fixture("xxe-synthetic.xml"));
		// A document that declares external entities is refused outright.
		expect(parsed).toEqual({ ok: false, error: "NOT_A_FEED" });
	});

	it("rejects an HTML page", () => {
		expect(parser.parse(fixture("html-page-synthetic.html"))).toEqual({
			ok: false,
			error: "NOT_A_FEED",
		});
		expect(
			parser.parse(
				"<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>",
			),
		).toEqual({ ok: false, error: "NOT_A_FEED" });
	});

	it("rejects well-formed XML that is not a feed", () => {
		for (const text of [
			"<urlset><url><loc>https://a.synthetic-wire.org/</loc></url></urlset>",
			"<rss><notachannel/></rss>",
			"<feed><unrelated>1</unrelated></feed>",
			'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><thing/></rdf:RDF>',
		]) {
			expect(parser.parse(text)).toEqual({ ok: false, error: "NOT_A_FEED" });
		}
	});

	it("rejects malformed and empty input without throwing", () => {
		for (const text of [
			"",
			"   ",
			"plain text, no markup",
			"<rss><channel><item><title>unterminated",
			"<rss><channel><title>A & B</title></channel></rss>",
			"<rss><channel></rss></channel>",
			'{"json": true}',
			"\u0000\u0001\u0002<rss>",
			"<<<<>>>>",
		]) {
			expect(parser.parse(text)).toEqual({ ok: false, error: "NOT_A_FEED" });
		}
	});

	it("rejects deeply nested junk quickly, wherever it sits", () => {
		const depth = 50_000;
		const junk = `${"<a>".repeat(depth)}x${"</a>".repeat(depth)}`;
		const startedAt = performance.now();
		expect(parser.parse(junk)).toEqual({ ok: false, error: "NOT_A_FEED" });
		expect(
			parser.parse(
				`<rss><channel><title>t</title><item><title>${junk}</title></item></channel></rss>`,
			),
		).toEqual({ ok: false, error: "NOT_A_FEED" });
		expect(performance.now() - startedAt).toBeLessThan(2000);
	});

	it("rejects reserved property names instead of polluting objects", () => {
		const parsed = parser.parse(
			"<rss><channel><title>t</title><__proto__><polluted>yes</polluted></__proto__><constructor>x</constructor></channel></rss>",
		);
		expect(parsed).toEqual({ ok: false, error: "NOT_A_FEED" });
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});

	it("rejects input above the size limit before parsing", () => {
		const item = "<item><title>t</title><link>https://a.synthetic-wire.org/x</link></item>";
		const oversized = `<rss><channel><title>t</title>${item.repeat(Math.ceil(MAX_FEED_BYTES / item.length) + 1)}</channel></rss>`;
		expect(oversized.length).toBeGreaterThan(MAX_FEED_BYTES);
		expect(parser.parse(oversized)).toEqual({ ok: false, error: "NOT_A_FEED" });
		// Multi-byte text: under the limit in UTF-16 units, over it in bytes.
		const multibyte = `<rss><channel><title>${"経".repeat(700_000)}</title></channel></rss>`;
		expect(multibyte.length).toBeLessThan(MAX_FEED_BYTES);
		expect(parser.parse(multibyte)).toEqual({ ok: false, error: "NOT_A_FEED" });
	});

	it("bounds oversized fields instead of passing megabytes downstream", () => {
		const feed = parseOk(
			`<rss><channel><title>t</title><item><title>${"T".repeat(10_000)}</title><link>https://a.synthetic-wire.org/x</link><description>${"word ".repeat(50_000)}</description></item></channel></rss>`,
		);
		expect(feed.items[0]?.title?.length).toBeLessThanOrEqual(2_000);
		expect(feed.items[0]?.summaryText?.length).toBeLessThanOrEqual(20_000);
	});

	it("treats an overlong link as absent and falls back instead of cutting it", () => {
		const long = `https://a.synthetic-wire.org/${"p".repeat(4_096)}`;
		const atLimit = `https://a.synthetic-wire.org/${"q".repeat(4_096 - 29)}`;
		expect(atLimit).toHaveLength(4_096);
		const feed = parseOk(
			`<rss xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>t</title><link>${long}</link>` +
				`<item><title>a</title><link>${long}</link><guid>https://a.synthetic-wire.org/guid</guid></item>` +
				`<item><title>b</title><link>${long}</link><guid>${long}</guid><atom:link href="https://a.synthetic-wire.org/atom"/></item>` +
				`<item><title>c</title><link><![CDATA[${long}]]></link></item>` +
				`<item><title>d</title><link>${atLimit}</link></item>` +
				"</channel></rss>",
		);
		expect(feed.siteLink).toBeNull();
		expect(feed.items.map((item) => item.link)).toEqual([
			"https://a.synthetic-wire.org/guid",
			"https://a.synthetic-wire.org/atom",
			null,
			atLimit,
		]);
	});

	it("takes the first Atom alternate link whose href is usable", () => {
		const long = `https://a.synthetic-wire.org/${"p".repeat(4_096)}`;
		const feed = parseOk(
			'<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>' +
				`<link href="${long}"/><link rel="alternate" href="https://a.synthetic-wire.org/"/>` +
				`<entry><title>e</title><link href="  "/><link rel="self" href="https://a.synthetic-wire.org/self"/>` +
				`<link rel="alternate" href="${long}"/><link href="https://a.synthetic-wire.org/e"/></entry>` +
				`<entry><title>f</title><link href="${long}"/></entry>` +
				"</feed>",
		);
		expect(feed.siteLink).toBe("https://a.synthetic-wire.org/");
		expect(feed.items.map((item) => item.link)).toEqual(["https://a.synthetic-wire.org/e", null]);
	});

	it("skips an Atom alternate link the article URL policy refuses and takes a later valid one", () => {
		const feed = parseOk(
			'<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>' +
				'<link href="http://a.synthetic-wire.org/"/><link href="https://a.synthetic-wire.org/"/>' +
				'<entry><title>e</title><link href="javascript:alert(1)"/><link rel="alternate" href="https://10.0.0.1/x"/>' +
				'<link href="https://a.synthetic-wire.org/e"/></entry>' +
				'<entry><title>f</title><link href="javascript:bad"/></entry>' +
				"</feed>",
		);
		expect(feed.siteLink).toBe("https://a.synthetic-wire.org/");
		expect(feed.items.map((item) => item.link)).toEqual(["https://a.synthetic-wire.org/e", null]);
	});

	it("decodes numeric references and drops invalid code points", () => {
		const feed = parseOk(
			"<rss><channel><title>&#x41;&#66;&#0;&#xD800; &unknown; &amp;lt;</title></channel></rss>",
		);
		expect(feed.title).toBe("AB &unknown; &lt;");
	});
});
