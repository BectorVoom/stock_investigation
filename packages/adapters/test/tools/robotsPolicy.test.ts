import { describe, expect, it } from "vitest";
import {
	ALLOW_ALL,
	DISALLOW_ALL,
	isPathAllowed,
	parseRobotsTxt,
} from "../../src/tools/robotsPolicy.ts";

function allow(text: string, path: string, token = "testbot"): boolean {
	return isPathAllowed(parseRobotsTxt(text, token), path);
}

describe("robotsPolicy RFC 9309 section 5 examples", () => {
	it("matches the section 5.1 calendar/junk example", () => {
		const text = "user-agent: *\ndisallow: /calendar/\ndisallow: /junk/\n";
		expect(allow(text, "/calendar/")).toBe(false);
		expect(allow(text, "/calendar/meeting")).toBe(false);
		expect(allow(text, "/junk/")).toBe(false);
		expect(allow(text, "/")).toBe(true);
		expect(allow(text, "/other")).toBe(true);
	});

	it("matches the section 5.2 path-prefix table", () => {
		const text = "user-agent: *\ndisallow: /fish\n";
		expect(allow(text, "/fish")).toBe(false);
		expect(allow(text, "/fish.html")).toBe(false);
		expect(allow(text, "/fish/salmon.html")).toBe(false);
		expect(allow(text, "/fishheads")).toBe(false);
		expect(allow(text, "/Fish")).toBe(true);
		expect(allow(text, "/shark")).toBe(true);
	});

	it("matches the wildcard and end-anchor table", () => {
		expect(allow("user-agent: *\ndisallow: /fish*\n", "/fishheads/catfish.html")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /fish/\n", "/fish")).toBe(true);
		expect(allow("user-agent: *\ndisallow: /fish/\n", "/fish/")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /*.php\n", "/folder/filename.php")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /*.php\n", "/filename.php?x=1")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /*.php$\n", "/filename.php")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /*.php$\n", "/filename.php?parameters")).toBe(true);
		expect(allow("user-agent: *\ndisallow: /fish*.php\n", "/fishheads/catfish.php?foo")).toBe(
			false,
		);
	});
});

describe("robotsPolicy group selection", () => {
	it("prefers the group naming our token over the * group", () => {
		const text = "user-agent: *\ndisallow: /\n\nuser-agent: testbot\nallow: /\n";
		expect(allow(text, "/anything")).toBe(true);
	});

	it("falls back to the * group for other tokens", () => {
		const text = "user-agent: *\ndisallow: /\n\nuser-agent: testbot\nallow: /\n";
		expect(allow(text, "/anything", "otherbot")).toBe(false);
	});

	it("merges several groups for the same token", () => {
		const text = [
			"user-agent: testbot",
			"disallow: /a",
			"",
			"user-agent: testbot",
			"disallow: /b",
			"",
			"user-agent: *",
			"allow: /",
		].join("\n");
		expect(allow(text, "/a/x")).toBe(false);
		expect(allow(text, "/b/x")).toBe(false);
		expect(allow(text, "/c")).toBe(true);
	});

	it("matches a group only when its user-agent equals our product token (RFC 9309 2.2.1)", () => {
		// A value our token merely starts with, or that starts with our token, is another crawler.
		for (const agent of ["research", "r", "research-workspace-extra", "research-work"]) {
			const text = `user-agent: *\nallow: /\n\nuser-agent: ${agent}\ndisallow: /\n`;
			expect(allow(text, "/article", "research-workspace")).toBe(true);
		}
		const exact = "user-agent: *\nallow: /\n\nuser-agent: Research-Workspace\ndisallow: /\n";
		expect(allow(exact, "/article", "research-workspace")).toBe(false);
		// Without an equal group, the `*` group applies, not a prefix group.
		const fallback = "user-agent: research\nallow: /\n\nuser-agent: *\ndisallow: /private\n";
		expect(allow(fallback, "/private/x", "research-workspace")).toBe(false);
		expect(allow(fallback, "/public", "research-workspace")).toBe(true);
	});

	it("allows everything when no group matches", () => {
		expect(allow("user-agent: someone-else\ndisallow: /\n", "/x", "testbot")).toBe(true);
		expect(allow("", "/x")).toBe(true);
	});

	it("treats an empty Disallow as allowing everything", () => {
		expect(allow("user-agent: *\ndisallow:\n", "/x")).toBe(true);
	});

	it("always allows /robots.txt itself", () => {
		expect(allow("user-agent: *\ndisallow: /\n", "/robots.txt")).toBe(true);
		expect(isPathAllowed(DISALLOW_ALL, "/robots.txt")).toBe(true);
		expect(isPathAllowed(DISALLOW_ALL, "/other")).toBe(false);
		expect(isPathAllowed(ALLOW_ALL, "/other")).toBe(true);
	});
});

describe("robotsPolicy precedence", () => {
	it("lets the longest matching rule win", () => {
		const text = ["user-agent: *", "allow: /", "disallow: /private/", "allow: /private/open"].join(
			"\n",
		);
		expect(allow(text, "/private/open/x")).toBe(true);
		expect(allow(text, "/private/closed")).toBe(false);
		expect(allow(text, "/public")).toBe(true);
	});

	it("lets Allow win a tie of equal length", () => {
		const text = ["user-agent: *", "disallow: /x", "allow: /x"].join("\n");
		expect(allow(text, "/x")).toBe(true);
		const swapped = ["user-agent: *", "allow: /x", "disallow: /x"].join("\n");
		expect(allow(text, "/x")).toBe(true);
		expect(allow(swapped, "/x")).toBe(true);
	});

	it("matches user agents case-insensitively", () => {
		const text = "User-Agent: TestBot\nDISALLOW: /secret\n";
		expect(allow(text, "/secret", "testbot")).toBe(false);
		expect(allow(text, "/secret", "TESTBOT")).toBe(false);
		expect(allow(text, "/open", "testbot")).toBe(true);
	});

	it("ignores comments, blank lines and unknown directives", () => {
		const text = [
			"# a comment",
			"user-agent: * # trailing comment",
			"sitemap: https://example.com/sitemap.xml",
			"crawl-delay: 10",
			"disallow: /hidden # because",
			"",
			"nonsense without a colon",
		].join("\n");
		expect(allow(text, "/hidden/x")).toBe(false);
		expect(allow(text, "/shown")).toBe(true);
	});
});

describe("robotsPolicy hostile input", () => {
	it("matches a pathological wildcard pattern in linear time", () => {
		const rules = parseRobotsTxt("user-agent: *\ndisallow: /a*a*a*a*a*a*a*a*b\n", "x");
		const target = `/${"a".repeat(100_000)}`;
		const started = Date.now();
		expect(isPathAllowed(rules, target)).toBe(true);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(isPathAllowed(rules, `${target}b`)).toBe(false);
	});

	it("treats garbage as no usable group", () => {
		expect(allow("\u0000\u0001\u0002:::###", "/x")).toBe(true);
		expect(allow("just some prose\nmore prose", "/x")).toBe(true);
	});

	it("ignores lines longer than 2,000 characters", () => {
		const text = `user-agent: *\ndisallow: /${"a".repeat(3_000)}\ndisallow: /short\n`;
		expect(allow(text, `/${"a".repeat(3_000)}`)).toBe(true);
		expect(allow(text, "/short/x")).toBe(false);
	});

	it("ignores anything past 500 KiB of input", () => {
		const padding = `# ${"p".repeat(600 * 1024)}\n`;
		const text = `${padding}user-agent: *\ndisallow: /late\n`;
		expect(allow(text, "/late")).toBe(true);
		const early = `user-agent: *\ndisallow: /early\n${padding}`;
		expect(allow(early, "/early/x")).toBe(false);
	});
});

describe("robotsPolicy percent-encoding (RFC 9309 section 2.2.2)", () => {
	it("does not let %70rivate bypass Disallow: /private", () => {
		const text = "user-agent: *\ndisallow: /private\n";
		expect(allow(text, "/private")).toBe(false);
		expect(allow(text, "/%70rivate")).toBe(false);
		// Decoding preserves case: %50 is 'P', so this is /Private (allowed).
		expect(allow(text, "/%50rivate")).toBe(true);
		expect(allow(text, "/%70%72ivate")).toBe(false);
		expect(allow(text, "/public")).toBe(true);
	});

	it("normalises hex case and decodes unreserved characters in rules and targets", () => {
		// %7e is '~' (unreserved): decoded on both sides, so these match.
		expect(allow("user-agent: *\ndisallow: /a%7eb\n", "/a~b")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /a~b\n", "/a%7Eb")).toBe(false);
		// Mixed-case hex of the same octet matches.
		expect(allow("user-agent: *\ndisallow: /x%2fb\n", "/x%2Fb")).toBe(false);
	});

	it("preserves reserved escapes: %2F never matches a literal slash", () => {
		expect(allow("user-agent: *\ndisallow: /foo%2Fbar\n", "/foo/bar")).toBe(true);
		expect(allow("user-agent: *\ndisallow: /foo%2Fbar\n", "/foo%2fbar")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /foo/bar\n", "/foo%2Fbar")).toBe(true);
	});

	it("matches literal-Unicode rules against encoded paths and the reverse", () => {
		const encoded = "/caf%C3%A9";
		expect(allow("user-agent: *\ndisallow: /café\n", encoded)).toBe(false);
		expect(allow(`user-agent: *\ndisallow: ${encoded}\n`, "/café")).toBe(false);
		expect(allow("user-agent: *\ndisallow: /café\n", "/other")).toBe(true);
	});
});

describe("robotsPolicy empty specific group", () => {
	it("allows everything when our group exists but carries no rules", () => {
		const text = "user-agent: *\ndisallow: /\n\nuser-agent: research-workspace\ndisallow:\n";
		expect(allow(text, "/article", "research-workspace")).toBe(true);
		expect(allow(text, "/", "research-workspace")).toBe(true);
		// Other tokens still inherit the wildcard's restrictions.
		expect(allow(text, "/article", "otherbot")).toBe(false);
	});
});
