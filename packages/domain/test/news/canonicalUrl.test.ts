import { describe, expect, it } from "vitest";
import { canonicalizeArticleUrl } from "../../src/news/canonicalUrl.ts";
import { expectOk } from "../support/result.ts";

function canonical(url: string): string {
	return expectOk(canonicalizeArticleUrl(url));
}

describe("canonicalizeArticleUrl (FR-003)", () => {
	it("lower-cases the host, drops the fragment and tracking parameters, and sorts the rest", () => {
		expect(
			canonical("https://Example.COM/News/Story/?utm_source=x&b=2&a=1&fbclid=abc#section"),
		).toBe("https://example.com/News/Story?a=1&b=2");
	});

	it("preserves path case, which servers may treat as significant", () => {
		expect(canonical("https://example.com/Path/To/Article")).toBe(
			"https://example.com/Path/To/Article",
		);
	});

	it("keeps the root path's slash", () => {
		expect(canonical("https://example.com")).toBe("https://example.com/");
		expect(canonical("https://example.com/")).toBe("https://example.com/");
	});

	it("removes trailing slashes from non-root paths", () => {
		expect(canonical("https://example.com/a/b/")).toBe("https://example.com/a/b");
		expect(canonical("https://example.com/a/b///")).toBe("https://example.com/a/b");
	});

	it("drops an explicit default port", () => {
		expect(canonical("https://example.com:443/a")).toBe("https://example.com/a");
	});

	it("drops a trailing-dot host label", () => {
		expect(canonical("https://example.com./a")).toBe("https://example.com/a");
	});

	it("drops an empty query string", () => {
		expect(canonical("https://example.com/a?")).toBe("https://example.com/a");
		expect(canonical("https://example.com/a?utm_source=only")).toBe("https://example.com/a");
	});

	it.each([
		"utm_source",
		"utm_medium",
		"utm_campaign",
		"utm_term",
		"utm_content",
		"utm_id",
		"UTM_SOURCE",
		"fbclid",
		"FBCLID",
		"gclid",
		"dclid",
		"msclkid",
		"mc_cid",
		"mc_eid",
		"igshid",
		"yclid",
		"ref_src",
		"cmpid",
		"ocid",
	])("removes the tracking parameter %s", (name) => {
		expect(canonical(`https://example.com/a?id=7&${name}=abc`)).toBe("https://example.com/a?id=7");
	});

	it.each([
		"id",
		"page",
		"utm",
		"utmost",
		"ref",
		"source",
		"q",
	])("keeps the content parameter %s", (name) => {
		expect(canonical(`https://example.com/a?${name}=1`)).toBe(`https://example.com/a?${name}=1`);
	});

	it("orders repeated parameters by value so their order cannot matter", () => {
		expect(canonical("https://example.com/a?tag=b&tag=a&tag=c")).toBe(
			"https://example.com/a?tag=a&tag=b&tag=c",
		);
	});

	it("treats %20 and + as the same space", () => {
		expect(canonical("https://example.com/a?q=a%20b")).toBe(
			canonical("https://example.com/a?q=a+b"),
		);
	});

	it("maps URLs that differ only in ignorable respects to one identity", () => {
		const variants = [
			"https://example.com/story?id=7&lang=en",
			"https://EXAMPLE.com/story?lang=en&id=7",
			"https://example.com/story/?id=7&lang=en#comments",
			"https://example.com:443/story?utm_source=feed&id=7&lang=en",
			"https://example.com./story?id=7&gclid=xyz&lang=en",
		];
		expect(new Set(variants.map(canonical))).toEqual(
			new Set(["https://example.com/story?id=7&lang=en"]),
		);
	});

	it("keeps genuinely different articles distinct", () => {
		expect(canonical("https://example.com/story?id=7")).not.toBe(
			canonical("https://example.com/story?id=8"),
		);
		expect(canonical("https://example.com/story-a")).not.toBe(
			canonical("https://example.com/story-b"),
		);
		expect(canonical("https://example.com/Story")).not.toBe(canonical("https://example.com/story"));
	});

	it("orders parameters by code unit, not by locale collation", () => {
		// "é" precomposed (U+00E9) and decomposed (e + U+0301) collate as equal in ICU, as do
		// "a" and "a" followed by a control character. A collation-based sort would leave such
		// pairs in input order, giving one article two identities.
		const composed = "%C3%A9";
		const decomposed = "e%CC%81";
		expect(canonical(`https://example.com/a?v=${composed}&v=${decomposed}`)).toBe(
			canonical(`https://example.com/a?v=${decomposed}&v=${composed}`),
		);
		expect(canonical("https://example.com/a?k=a&k=a%01")).toBe(
			canonical("https://example.com/a?k=a%01&k=a"),
		);
		expect(canonical(`https://example.com/a?${composed}=1&${decomposed}=2`)).toBe(
			canonical(`https://example.com/a?${decomposed}=2&${composed}=1`),
		);
	});

	it("sorts upper-case names before lower-case ones, independent of the runtime locale", () => {
		// Code-unit order: "B" (0x42) < "a" (0x61). Locale collation would give a, B.
		expect(canonical("https://example.com/a?a=1&B=2")).toBe("https://example.com/a?B=2&a=1");
	});

	it.each([
		["http://example.com/a", "SCHEME_NOT_ALLOWED"],
		["https://user:pw@example.com/a", "CREDENTIALS_NOT_ALLOWED"],
		["https://example.com:8443/a", "PORT_NOT_ALLOWED"],
		["https://127.0.0.1/a", "IP_LITERAL_NOT_ALLOWED"],
		["https://localhost/a", "HOSTNAME_NOT_ALLOWED"],
		["not a url", "MALFORMED_URL"],
	])("refuses to canonicalize the unsafe URL %s (%s)", (url, code) => {
		expect(canonicalizeArticleUrl(url)).toEqual({ ok: false, error: code });
	});
});
