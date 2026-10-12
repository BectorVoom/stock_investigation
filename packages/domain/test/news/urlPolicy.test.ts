import { describe, expect, it } from "vitest";
import { MAX_URL_LENGTH, type UrlPolicyError, validateFetchUrl } from "../../src/news/urlPolicy.ts";
import { expectOk } from "../support/result.ts";

function rejection(url: string): UrlPolicyError | "ACCEPTED" {
	const result = validateFetchUrl(url);
	return result.ok ? "ACCEPTED" : result.error;
}

describe("validateFetchUrl accepts ordinary public https URLs", () => {
	it.each([
		["https://example.com/", "example.com"],
		["https://www.reuters.com/markets/", "www.reuters.com"],
		["https://news.example.co.jp/rss?category=tech", "news.example.co.jp"],
		["https://feeds.example.org/a/b/c.xml", "feeds.example.org"],
		["https://sub-domain.example-site.com/path#fragment", "sub-domain.example-site.com"],
		["https://example.com:443/default-port", "example.com"],
		["https://xn--bcher-kva.example.org/", "xn--bcher-kva.example.org"],
	])("%s", (url, hostname) => {
		expect(expectOk(validateFetchUrl(url)).hostname).toBe(hostname);
	});

	it("lower-cases the host and returns a normalized href", () => {
		expect(validateFetchUrl("HTTPS://EXAMPLE.com/Path?Q=1")).toEqual({
			ok: true,
			value: { href: "https://example.com/Path?Q=1", hostname: "example.com" },
		});
	});

	it("normalizes an internationalized host to punycode", () => {
		expect(expectOk(validateFetchUrl("https://bücher.example.org/")).hostname).toBe(
			"xn--bcher-kva.example.org",
		);
	});

	it("reports a fully-qualified (single trailing dot) public host without the dot", () => {
		expect(expectOk(validateFetchUrl("https://example.com./feed")).hostname).toBe("example.com");
	});
});

describe("validateFetchUrl scheme policy", () => {
	it.each([
		"http://example.com/",
		"HTTP://example.com/",
		"ftp://example.com/file",
		"file:///etc/passwd",
		"gopher://example.com/",
		"ws://example.com/",
		"wss://example.com/",
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"blob:https://example.com/uuid",
		"view-source:https://example.com/",
	])("rejects %s", (url) => {
		expect(rejection(url)).toBe("SCHEME_NOT_ALLOWED");
	});
});

describe("validateFetchUrl credential policy", () => {
	it.each([
		"https://user:pass@example.com/",
		"https://user@example.com/",
		"https://:pass@example.com/",
		// Classic confusion: the real host is evil.example.org, "example.com" is a user name.
		"https://example.com@evil.example.org/",
		"https://example.com:443@evil.example.org/",
	])("rejects %s", (url) => {
		expect(rejection(url)).toBe("CREDENTIALS_NOT_ALLOWED");
	});
});

describe("validateFetchUrl port policy", () => {
	it.each([
		"https://example.com:80/",
		"https://example.com:8080/",
		"https://example.com:8443/",
		"https://example.com:22/",
		"https://example.com:25/",
		"https://example.com:3306/",
		"https://example.com:6379/",
		"https://example.com:444/",
		"https://example.com:0/",
	])("rejects %s", (url) => {
		expect(rejection(url)).toBe("PORT_NOT_ALLOWED");
	});
});

describe("validateFetchUrl IP-literal policy (SSRF)", () => {
	it.each([
		["https://127.0.0.1/", "loopback"],
		["https://127.0.0.1./", "loopback with trailing dot"],
		["https://10.0.0.1/", "RFC1918"],
		["https://172.16.0.1/", "RFC1918"],
		["https://192.168.1.1/admin", "RFC1918"],
		["https://169.254.169.254/latest/meta-data/", "cloud metadata"],
		["https://100.64.0.1/", "CGNAT"],
		["https://0.0.0.0/", "unspecified"],
		["https://8.8.8.8/", "public literal: hosts must be named"],
		["https://2130706433/", "decimal alias of 127.0.0.1"],
		["https://0x7f.0.0.1/", "hex alias of 127.0.0.1"],
		["https://0x7f000001/", "hex integer alias of 127.0.0.1"],
		["https://0177.0.0.1/", "octal alias of 127.0.0.1"],
		["https://017700000001/", "octal integer alias of 127.0.0.1"],
		["https://127.1/", "short alias of 127.0.0.1"],
		["https://[::1]/", "IPv6 loopback"],
		["https://[::]/", "IPv6 unspecified"],
		["https://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
		["https://[::ffff:7f00:1]/", "IPv4-mapped loopback, hex"],
		["https://[::ffff:169.254.169.254]/", "IPv4-mapped cloud metadata"],
		["https://[64:ff9b::7f00:1]/", "NAT64 loopback"],
		["https://[2002:7f00:1::]/", "6to4 loopback"],
		["https://[fd00::1]/", "unique local"],
		["https://[fe80::1]/", "link-local"],
		["https://[2606:4700:4700::1111]/", "public IPv6 literal"],
	])("rejects %s (%s)", (url) => {
		expect(rejection(url)).toBe("IP_LITERAL_NOT_ALLOWED");
	});
});

describe("validateFetchUrl hostname policy (SSRF)", () => {
	it.each([
		["https://localhost/", "localhost"],
		["https://LOCALHOST/", "localhost, upper case"],
		["https://localhost./", "localhost with trailing dot"],
		["https://ｌｏｃａｌｈｏｓｔ/", "full-width localhost"],
		["https://%6c%6f%63%61%6c%68%6f%73%74/", "percent-encoded localhost"],
		["https://intranet/", "single-label host"],
		["https://metadata/", "single-label host"],
		["https://kubernetes/", "single-label host"],
		["https://router./", "single-label host with trailing dot"],
		["https://foo.localhost/", ".localhost"],
		["https://printer.local/", ".local (mDNS)"],
		["https://metadata.google.internal/", ".internal"],
		["https://db.internal./", ".internal with trailing dot"],
		["https://DB.INTERNAL/", ".internal, upper case"],
		["https://wiki.intranet/", ".intranet"],
		["https://nas.lan/", ".lan"],
		["https://box.home/", ".home"],
		["https://ad.corp/", ".corp"],
		["https://gw.home.arpa/", ".home.arpa"],
		["https://a.test/", ".test"],
		["https://a.invalid/", ".invalid"],
		["https://a.example/", ".example"],
		["https://abcdefghijklmnop.onion/", ".onion"],
	])("rejects %s (%s)", (url) => {
		expect(rejection(url)).toBe("HOSTNAME_NOT_ALLOWED");
	});

	it.each([
		"https://localhost../",
		"https://db.internal../",
		"https://printer.local.../",
		"https://example.com../",
		"https://a..example.com/",
	])("rejects %s, a host with empty labels that would dodge the suffix checks", (url) => {
		expect(validateFetchUrl(url).ok).toBe(false);
	});
});

describe("validateFetchUrl malformed and oversized input", () => {
	it.each([
		"",
		"   ",
		"not a url",
		"example.com",
		"//example.com/path",
		"/relative/path",
		"https://",
		"https://exa mple.com/",
		"https://example.com:99999/",
		"https://[::1/",
	])("rejects %j as malformed", (url) => {
		expect(rejection(url)).toBe("MALFORMED_URL");
	});

	it("accepts a URL of exactly the maximum length and rejects one character more", () => {
		const prefix = "https://example.com/";
		const atLimit = prefix + "a".repeat(MAX_URL_LENGTH - prefix.length);
		expect(atLimit).toHaveLength(MAX_URL_LENGTH);
		expect(validateFetchUrl(atLimit).ok).toBe(true);
		expect(rejection(`${atLimit}a`)).toBe("URL_TOO_LONG");
	});

	it("applies the length limit before parsing", () => {
		expect(rejection("x".repeat(MAX_URL_LENGTH + 1))).toBe("URL_TOO_LONG");
	});
});
