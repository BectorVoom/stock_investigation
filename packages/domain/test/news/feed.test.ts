import { describe, expect, it } from "vitest";
import {
	articleFingerprintMaterial,
	MAX_EXCERPT_LENGTH,
	MAX_TITLE_LENGTH,
	type NormalizeFeedOptions,
	normalizeFeed,
	type RawFeed,
	type RawFeedItem,
	toPlainText,
} from "../../src/news/feed.ts";
import { deepFreeze } from "../support/deepFreeze.ts";

const RETRIEVED_AT = "2026-10-11T03:00:00.000Z";

/** A high surrogate without its low half, or a low surrogate without its high half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const options: NormalizeFeedOptions = {
	publisher: "Example Wire",
	retrievedAt: RETRIEVED_AT,
	licensePolicy: "short-excerpt-permitted",
	maxItems: 50,
};

function item(overrides: Partial<RawFeedItem> = {}): RawFeedItem {
	return {
		title: "Battery makers expand capacity",
		link: "https://news.example.com/articles/battery-capacity",
		publishedText: "Sat, 10 Oct 2026 12:00:00 GMT",
		summaryText: "Three suppliers announced new plants.",
		...overrides,
	};
}

function feed(items: readonly RawFeedItem[]): RawFeed {
	return { kind: "rss", title: "Example Wire", siteLink: "https://news.example.com/", items };
}

describe("toPlainText", () => {
	it("strips tags and collapses whitespace", () => {
		expect(toPlainText("<p>Hello   <b>world</b></p>\n\n<br/>again")).toBe("Hello world again");
	});

	it("removes script and style blocks together with their content", () => {
		expect(toPlainText("Before<script>alert('x')</script>After")).toBe("Before After");
		expect(toPlainText("A<STYLE type='text/css'>p { color: red }</STYLE >B")).toBe("A B");
	});

	it("decodes named, decimal and hexadecimal entities", () => {
		expect(toPlainText("Fish &amp; Chips &lt;3 &quot;quoted&quot; &apos;x&apos;")).toBe(
			"Fish & Chips <3 \"quoted\" 'x'",
		);
		expect(toPlainText("&#65;&#x42;&#X43;")).toBe("ABC");
		expect(toPlainText("a&nbsp;b")).toBe("a b");
	});

	it("decodes the typographic and Latin-1 entities found in news prose", () => {
		// Both lines are verbatim from a real EIA article that used to keep its entities.
		expect(toPlainText("down from the 13&ndash;24% growth seen")).toBe(
			"down from the 13\u201324% growth seen",
		);
		expect(toPlainText("Gross withdrawals &mdash;the total volume&mdash;reached")).toBe(
			"Gross withdrawals \u2014the total volume\u2014reached",
		);
		expect(
			toPlainText("&ldquo;Caf&eacute;&rdquo; &euro;5 &plusmn;2&deg; &frac12; &copy; &hellip;"),
		).toBe("\u201cCaf\u00e9\u201d \u20ac5 \u00b12\u00b0 \u00bd \u00a9 \u2026");
		// Every Latin-1 name maps to its own code point (first, a middle one, last).
		expect(toPlainText("&iexcl;&times;&yuml;")).toBe("\u00a1\u00d7\u00ff");
	});

	it("treats entity names as case-sensitive, tolerating only shouted markup escapes", () => {
		expect(toPlainText("&Eacute;&eacute; &Prime;&prime;")).toBe("\u00c9\u00e9 \u2033\u2032");
		expect(toPlainText("A &AMP; B &LT; C")).toBe("A & B < C");
	});

	it("drops soft hyphens and invisible joiners so that quoted passages still match", () => {
		expect(toPlainText("infra&shy;structure x&zwnj;y a&ensp;b&thinsp;c")).toBe(
			"infrastructure xy a b c",
		);
	});

	it("never resolves an entity name through Object.prototype", () => {
		expect(toPlainText("&constructor; &toString; &hasOwnProperty;")).toBe(
			"&constructor; &toString; &hasOwnProperty;",
		);
	});

	it("removes inline tags without inserting a space, and block tags with one", () => {
		expect(toPlainText('in our <a href="/mer">Monthly Energy Review</a>, down')).toBe(
			"in our Monthly Energy Review, down",
		);
		expect(toPlainText("CO<sub>2</sub> and 1<sup>st</sup> <STRONG>bold</STRONG>.")).toBe(
			"CO2 and 1st bold.",
		);
		expect(toPlainText("<p>one</p><p>two</p><div>three</div>four<br>five")).toBe(
			"one two three four five",
		);
		// A tag that merely starts with an inline tag's name is not inline.
		expect(toPlainText("x<article>y</article>z<bdi>w</bdi>")).toBe("x y z w");
		// An inline tag revealed by decoding is removed the same way.
		expect(toPlainText("a&lt;b&gt;c&lt;/b&gt;d")).toBe("acd");
	});

	it("leaves unknown entities as written and drops impossible code points", () => {
		expect(toPlainText("&unknown; ok")).toBe("&unknown; ok");
		expect(toPlainText("a&#0;b&#x110000;c")).toBe("abc");
	});

	it("strips tags that only appear after entity decoding", () => {
		expect(toPlainText("&lt;b&gt;bold&lt;/b&gt; text")).toBe("bold text");
		expect(toPlainText("&lt;img src=x onerror=alert(1)&gt;caption")).toBe("caption");
	});

	it("returns an empty string for markup-only input", () => {
		expect(toPlainText("<p><br/></p>")).toBe("");
		expect(toPlainText("  \n\t ")).toBe("");
	});
});

describe("articleFingerprintMaterial", () => {
	it("is the lower-cased publisher, the publication day, the normalized title and the content", () => {
		expect(
			articleFingerprintMaterial({
				title: "Chips & Tariffs: What's Next?",
				publisher: "Example Wire",
				publishedAt: "2026-10-10T12:00:00.000Z",
				summary: "Tariffs RISE, again!",
				canonicalUrl: "https://news.example.com/a",
			}),
		).toBe("example wire\n2026-10-10\nchips tariffs what s next\nsummary:tariffs rise again");
	});

	const base = {
		title: "Battery makers expand capacity",
		publisher: "Example Wire",
		publishedAt: "2026-10-10T12:00:00.000Z",
		summary: "Three suppliers announced new plants.",
		canonicalUrl: "https://news.example.com/a",
	};

	it("identifies a summarized story by its content, whatever link carries it", () => {
		expect(
			articleFingerprintMaterial({ ...base, canonicalUrl: "https://syndication.example.net/x" }),
		).toBe(articleFingerprintMaterial(base));
	});

	it("does not merge two links on a headline alone", () => {
		// A publisher reuses headlines like "Market wrap" for different updates on one day.
		const first = articleFingerprintMaterial({ ...base, summary: null });
		const second = articleFingerprintMaterial({
			...base,
			summary: null,
			canonicalUrl: "https://news.example.com/b",
		});
		expect(first).not.toBe(second);
		expect(first).toBe(
			"example wire\n2026-10-10\nbattery makers expand capacity\nurl:https://news.example.com/a",
		);
	});

	it("distinguishes two stories with the same headline but different content", () => {
		expect(
			articleFingerprintMaterial({ ...base, summary: "Two suppliers closed plants." }),
		).not.toBe(articleFingerprintMaterial(base));
	});

	it("ignores case, punctuation and whitespace differences in the title", () => {
		expect(
			articleFingerprintMaterial({ ...base, title: "  BATTERY makers — expand   capacity!! " }),
		).toBe(articleFingerprintMaterial(base));
	});

	it("applies compatibility normalization (full-width forms)", () => {
		expect(
			articleFingerprintMaterial({ ...base, title: "ＢＡＴＴＥＲＹ makers expand capacity" }),
		).toBe(articleFingerprintMaterial(base));
	});

	it("ignores the publisher's case and the time of day", () => {
		expect(
			articleFingerprintMaterial({
				...base,
				publisher: "EXAMPLE WIRE",
				publishedAt: "2026-10-10T23:59:59.000Z",
			}),
		).toBe(articleFingerprintMaterial(base));
	});

	it("distinguishes different titles, publishers and publication days", () => {
		const reference = articleFingerprintMaterial(base);
		expect(articleFingerprintMaterial({ ...base, title: "Battery makers cut capacity" })).not.toBe(
			reference,
		);
		expect(articleFingerprintMaterial({ ...base, publisher: "Other Wire" })).not.toBe(reference);
		expect(
			articleFingerprintMaterial({ ...base, publishedAt: "2026-10-11T00:00:00.000Z" }),
		).not.toBe(reference);
	});

	it("marks undated articles explicitly instead of borrowing a date", () => {
		const undated = articleFingerprintMaterial({ ...base, publishedAt: null });
		expect(undated).toContain("undated");
		expect(undated).not.toBe(articleFingerprintMaterial(base));
	});

	it("keeps non-Latin titles distinguishable", () => {
		expect(articleFingerprintMaterial({ ...base, title: "蓄電池メーカーが増産" })).not.toBe(
			articleFingerprintMaterial({ ...base, title: "半導体メーカーが増産" }),
		);
	});
});

describe("normalizeFeed", () => {
	it("turns a well-formed item into an article candidate", () => {
		const result = normalizeFeed(feed([item()]), options);
		expect(result).toEqual({
			articles: [
				{
					canonicalUrl: "https://news.example.com/articles/battery-capacity",
					title: "Battery makers expand capacity",
					publisher: "Example Wire",
					// Sat, 10 Oct 2026 12:00:00 GMT
					publishedAt: "2026-10-10T12:00:00.000Z",
					retrievedAt: RETRIEVED_AT,
					excerpt: "Three suppliers announced new plants.",
					// lower-cased publisher, publication day, normalized title, normalized summary
					fingerprintMaterial:
						"example wire\n2026-10-10\nbattery makers expand capacity\nsummary:three suppliers announced new plants",
				},
			],
			rejected: [],
			truncatedItemCount: 0,
		});
	});

	it("does not mutate the feed it is given", () => {
		const frozen = deepFreeze(feed([item(), item({ link: "https://news.example.com/b" })]));
		expect(() => normalizeFeed(frozen, deepFreeze({ ...options }))).not.toThrow();
	});

	it("converts offset timestamps to UTC", () => {
		// 21:00 at +09:00 is 12:00 UTC the same day.
		const rfc822 = normalizeFeed(
			feed([item({ publishedText: "Sat, 10 Oct 2026 21:00:00 +0900" })]),
			options,
		);
		const iso = normalizeFeed(
			feed([item({ publishedText: "2026-10-10T21:00:00+09:00" })]),
			options,
		);
		expect(rfc822.articles[0]?.publishedAt).toBe("2026-10-10T12:00:00.000Z");
		expect(iso.articles[0]?.publishedAt).toBe("2026-10-10T12:00:00.000Z");
	});

	it.each([
		null,
		"",
		"yesterday-ish",
		"32 Foo 2026",
	])("leaves publishedAt null for the unparseable date %j, never the retrieval time", (text) => {
		const result = normalizeFeed(feed([item({ publishedText: text })]), options);
		expect(result.articles).toHaveLength(1);
		expect(result.articles[0]?.publishedAt).toBeNull();
		expect(result.articles[0]?.retrievedAt).toBe(RETRIEVED_AT);
		expect(result.articles[0]?.fingerprintMaterial).toContain("undated");
	});

	it.each([
		null,
		"",
		"   ",
		"<b></b>",
		"<script>alert(1)</script>",
	])("rejects an item whose title is %j", (title) => {
		const result = normalizeFeed(feed([item({ title })]), options);
		expect(result.articles).toEqual([]);
		expect(result.rejected).toEqual([{ reason: "MISSING_TITLE", index: 0 }]);
	});

	it.each([null, "", "   "])("rejects an item whose link is %j", (link) => {
		const result = normalizeFeed(feed([item({ link })]), options);
		expect(result.articles).toEqual([]);
		expect(result.rejected).toEqual([{ reason: "MISSING_LINK", index: 0 }]);
	});

	it.each([
		["http://news.example.com/a", "SCHEME_NOT_ALLOWED"],
		["https://127.0.0.1/a", "IP_LITERAL_NOT_ALLOWED"],
		["https://169.254.169.254/latest/meta-data/", "IP_LITERAL_NOT_ALLOWED"],
		["https://[::ffff:127.0.0.1]/a", "IP_LITERAL_NOT_ALLOWED"],
		["https://localhost/a", "HOSTNAME_NOT_ALLOWED"],
		["https://intranet.corp/a", "HOSTNAME_NOT_ALLOWED"],
		["https://user:pw@news.example.com/a", "CREDENTIALS_NOT_ALLOWED"],
		["https://news.example.com:8443/a", "PORT_NOT_ALLOWED"],
		["javascript:alert(1)", "SCHEME_NOT_ALLOWED"],
		["/relative/path", "MALFORMED_URL"],
	])("rejects the unsafe link %s with %s", (link, detail) => {
		const result = normalizeFeed(feed([item({ link })]), options);
		expect(result.articles).toEqual([]);
		expect(result.rejected).toEqual([{ reason: "UNSAFE_LINK", index: 0, detail }]);
	});

	it("reports each rejection with the item's position in the feed", () => {
		const result = normalizeFeed(
			feed([
				item({ link: "https://news.example.com/ok-1" }),
				item({ title: null }),
				item({ link: "https://news.example.com/ok-2" }),
				item({ link: "http://news.example.com/insecure" }),
				item({ link: null }),
			]),
			options,
		);
		expect(result.articles.map((article) => article.canonicalUrl)).toEqual([
			"https://news.example.com/ok-1",
			"https://news.example.com/ok-2",
		]);
		expect(result.rejected).toEqual([
			{ reason: "MISSING_TITLE", index: 1 },
			{ reason: "UNSAFE_LINK", index: 3, detail: "SCHEME_NOT_ALLOWED" },
			{ reason: "MISSING_LINK", index: 4 },
		]);
	});

	it("collapses items whose links canonicalize to the same URL, keeping the first", () => {
		const result = normalizeFeed(
			feed([
				item({ title: "First", link: "https://news.example.com/story?id=7" }),
				item({ title: "Second", link: "https://NEWS.example.com/story/?id=7&utm_source=rss#top" }),
				item({ title: "Third", link: " https://news.example.com/story?id=7 " }),
			]),
			options,
		);
		expect(result.articles).toHaveLength(1);
		expect(result.articles[0]?.title).toBe("First");
		expect(result.articles[0]?.canonicalUrl).toBe("https://news.example.com/story?id=7");
		expect(result.rejected).toEqual([]);
	});

	it("gives the same fingerprint material to one story syndicated under two links", () => {
		const result = normalizeFeed(
			feed([
				item({ link: "https://news.example.com/a" }),
				item({ link: "https://news.example.com/b" }),
			]),
			options,
		);
		expect(result.articles).toHaveLength(2);
		expect(result.articles[0]?.fingerprintMaterial).toBe(result.articles[1]?.fingerprintMaterial);
	});

	it("reduces title and summary markup to plain text", () => {
		const result = normalizeFeed(
			feed([
				item({
					title: "Chips &amp; <em>tariffs</em>",
					summaryText: "<p>Prices rose <script>steal()</script>sharply.</p>",
				}),
			]),
			options,
		);
		expect(result.articles[0]?.title).toBe("Chips & tariffs");
		expect(result.articles[0]?.excerpt).toBe("Prices rose sharply.");
	});

	it("stores no excerpt when the license allows only headline and link (DATA-010)", () => {
		const result = normalizeFeed(feed([item()]), {
			...options,
			licensePolicy: "headline-and-link-only",
		});
		expect(result.articles).toHaveLength(1);
		expect(result.articles[0]?.excerpt).toBeNull();
	});

	it("stores a null excerpt, not an empty string, when there is no summary", () => {
		for (const summaryText of [null, "", "<p></p>"]) {
			const result = normalizeFeed(feed([item({ summaryText })]), options);
			expect(result.articles[0]?.excerpt).toBeNull();
		}
	});

	it("bounds long titles and excerpts and marks the cut", () => {
		const result = normalizeFeed(
			feed([item({ title: "t".repeat(1000), summaryText: "s".repeat(5000) })]),
			options,
		);
		const article = result.articles[0];
		expect(article?.title).toHaveLength(MAX_TITLE_LENGTH);
		expect(article?.title.endsWith("…")).toBe(true);
		expect(article?.excerpt).toHaveLength(MAX_EXCERPT_LENGTH);
		expect(article?.excerpt?.endsWith("…")).toBe(true);
	});

	it("keeps text that is exactly at the limit untouched", () => {
		const title = "t".repeat(MAX_TITLE_LENGTH);
		const summaryText = "s".repeat(MAX_EXCERPT_LENGTH);
		const result = normalizeFeed(feed([item({ title, summaryText })]), options);
		expect(result.articles[0]?.title).toBe(title);
		expect(result.articles[0]?.excerpt).toBe(summaryText);
	});

	it("bounds titles made of astral characters without splitting a surrogate pair", () => {
		// Each emoji is two UTF-16 code units, so 200 of them is 400 units: over the 300 limit
		// that the stored-article contract enforces on `title.length`.
		const result = normalizeFeed(
			feed([item({ title: "📈".repeat(200), summaryText: "🔋".repeat(400) })]),
			options,
		);
		const article = result.articles[0];
		if (article === undefined || article.excerpt === null) {
			throw new Error("expected an article with an excerpt");
		}
		expect(article.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
		expect(article.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
		expect(article.title.endsWith("…")).toBe(true);
		expect(article.title).not.toMatch(LONE_SURROGATE);
		expect(article.excerpt).not.toMatch(LONE_SURROGATE);
	});

	it("examines at most maxItems items and reports how many were skipped", () => {
		const items = Array.from({ length: 7 }, (_unused, index) =>
			item({ link: `https://news.example.com/story-${index}` }),
		);
		const result = normalizeFeed(feed(items), { ...options, maxItems: 3 });
		expect(result.articles.map((article) => article.canonicalUrl)).toEqual([
			"https://news.example.com/story-0",
			"https://news.example.com/story-1",
			"https://news.example.com/story-2",
		]);
		expect(result.truncatedItemCount).toBe(4);
	});

	it("handles an empty feed", () => {
		expect(normalizeFeed(feed([]), options)).toEqual({
			articles: [],
			rejected: [],
			truncatedItemCount: 0,
		});
	});
});
