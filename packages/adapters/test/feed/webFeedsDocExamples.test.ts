/**
 * The documented feed, page and robots.txt bodies
 * (docs/external-apis/apis/web-feeds-and-pages.md) go through the TypeScript
 * runner's own readers: the feed parser and `normalizeFeed`, `htmlToMarkdown`,
 * and the robots.txt policy.
 */
import { normalizeFeed } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createFeedParser } from "../../src/feed/index.ts";
import { htmlToMarkdown } from "../../src/tools/htmlToMarkdown.ts";
import { isPathAllowed, parseRobotsTxt } from "../../src/tools/robotsPolicy.ts";
import { docExampleText } from "../docExamples.ts";

const parser = createFeedParser();

function parseFeed(text: string) {
	const parsed = parser.parse(text);
	if (!parsed.ok) throw new Error("expected a feed");
	return parsed.value;
}

function normalize(text: string) {
	return normalizeFeed(parseFeed(text), {
		publisher: "Example publisher",
		retrievedAt: "2026-10-31T05:00:00.000Z",
		licensePolicy: "short-excerpt-permitted",
		maxItems: 100,
	});
}

describe("web feeds and pages document examples", () => {
	it("web-feeds-rss-fed-press: RSS 2.0 parses and normalises", () => {
		const text = docExampleText("web-feeds-and-pages", "web-feeds-rss-fed-press");
		const feed = parseFeed(text);
		expect(feed.kind).toBe("rss");
		expect(feed.title).toBe("FRB: Press Release - All Releases");
		expect(feed.siteLink).toBe("https://www.federalreserve.gov/feeds/feeds.htm");
		const { articles, rejected } = normalize(text);
		expect(rejected).toEqual([]);
		expect(articles[1]?.canonicalUrl).toBe(
			"https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm",
		);
		expect(articles[1]?.title).toBe("Federal Reserve issues FOMC statement");
		expect(articles[1]?.publishedAt).toBe("2026-10-28T18:00:00.000Z");
	});

	it("web-feeds-rdf-cao: RSS 1.0 items beside the channel are read, links trimmed", () => {
		const text = docExampleText("web-feeds-and-pages", "web-feeds-rdf-cao");
		const feed = parseFeed(text);
		expect(feed.kind).toBe("rss");
		expect(feed.items).toHaveLength(2);
		const { articles } = normalize(text);
		expect(articles[1]?.canonicalUrl).toBe(
			"https://www.cao.go.jp/consumer/kabusoshiki/ai_technology/013/shiryou/index.html",
		);
		expect(articles[0]?.publishedAt).toBe("2026-10-30T07:28:00.000Z");
	});

	it("web-feeds-atom-rfc4287: Atom parses; its only (http) link is not usable, so the entry has none", () => {
		const text = docExampleText("web-feeds-and-pages", "web-feeds-atom-rfc4287");
		const feed = parseFeed(text);
		expect(feed.kind).toBe("atom");
		// The article URL policy is applied while choosing the alternate link.
		expect(feed.items[0]?.link).toBeNull();
		expect(feed.items[0]?.publishedText).toBe("2003-12-13T18:30:02Z");
		expect(normalize(text).rejected[0]?.reason).toBe("MISSING_LINK");
	});

	it("web-feeds-page-fed-press: the page converts to Markdown with its title", () => {
		const page = htmlToMarkdown(docExampleText("web-feeds-and-pages", "web-feeds-page-fed-press"), {
			baseUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm",
			maxChars: 20_000,
		});
		expect(page.title).toBe("Federal Reserve Board - Federal Reserve issues FOMC statement");
		expect(page.markdown).toContain("maintain the target range for the federal funds rate");
	});

	it("web-feeds-robots-nist: the wildcard group applies to our token", () => {
		const rules = parseRobotsTxt(
			docExampleText("web-feeds-and-pages", "web-feeds-robots-nist"),
			"research-workspace",
		);
		expect(isPathAllowed(rules, "/core/misc/drupal.js")).toBe(true);
		expect(isPathAllowed(rules, "/core/install.php")).toBe(false);
		expect(isPathAllowed(rules, "/news-events/news")).toBe(true);
	});
});
