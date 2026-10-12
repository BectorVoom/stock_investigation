import { recommendedSourceSchema } from "@research/contracts";
import { validateFetchUrl } from "@research/domain";
import { describe, expect, it } from "vitest";
import { discoverFeedLinks, RECOMMENDED_SOURCES } from "../src/index.ts";

describe("feed auto-discovery", () => {
	const page = "https://news.example.org/section/";

	it("finds advertised RSS and Atom feeds and resolves relative links", () => {
		const html = `
			<link rel="stylesheet" href="/site.css">
			<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
			<LINK HREF='atom.xml' TYPE='application/atom+xml' REL='alternate nofollow'>
			<link rel="alternate" type="text/html" href="/amp">
			<link rel="alternate" type="application/rss+xml" href="/feed.xml">`;
		expect(discoverFeedLinks(html, page)).toEqual([
			"https://news.example.org/feed.xml",
			"https://news.example.org/section/atom.xml",
		]);
	});

	it("returns nothing for pages without feed links or with unusable hrefs", () => {
		expect(discoverFeedLinks("<html><body>plain</body></html>", page)).toEqual([]);
		expect(discoverFeedLinks('<link rel="alternate" type="application/rss+xml">', page)).toEqual(
			[],
		);
	});

	it("only ever returns URLs; whether they are safe is decided by the URL policy", () => {
		const hostile =
			'<link rel="alternate" type="application/rss+xml" href="http://169.254.169.254/latest">';
		const [found] = discoverFeedLinks(hostile, page);
		expect(found).toBe("http://169.254.169.254/latest");
		expect(validateFetchUrl(found ?? "").ok).toBe(false);
	});
});

describe("recommended source catalog (FR-002)", () => {
	it("is schema-valid, unique and passes the same URL policy as owner-entered sources", () => {
		expect(RECOMMENDED_SOURCES.length).toBeGreaterThan(0);
		for (const entry of RECOMMENDED_SOURCES) {
			expect(recommendedSourceSchema.safeParse(entry).success, entry.catalogId).toBe(true);
			expect(validateFetchUrl(entry.feedUrl).ok, entry.feedUrl).toBe(true);
			expect(validateFetchUrl(entry.homepageUrl).ok, entry.homepageUrl).toBe(true);
		}
		const unique = (values: readonly string[]) => new Set(values).size === values.length;
		expect(unique(RECOMMENDED_SOURCES.map((entry) => entry.catalogId))).toBe(true);
		expect(unique(RECOMMENDED_SOURCES.map((entry) => entry.feedUrl))).toBe(true);
	});

	it("covers both target markets", () => {
		const regions = new Set(RECOMMENDED_SOURCES.map((entry) => entry.region));
		expect(regions.has("JP")).toBe(true);
		expect(regions.has("US")).toBe(true);
	});

	it("defaults to headline-and-link-only except for sources marked official", () => {
		for (const entry of RECOMMENDED_SOURCES) {
			if (entry.licensePolicy === "short-excerpt-permitted") {
				expect(entry.trustClassification, entry.catalogId).toBe("official");
			}
		}
	});
});
