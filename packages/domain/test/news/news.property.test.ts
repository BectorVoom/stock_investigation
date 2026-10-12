import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalizeArticleUrl } from "../../src/news/canonicalUrl.ts";
import {
	MAX_EXCERPT_LENGTH,
	MAX_TITLE_LENGTH,
	normalizeFeed,
	type RawFeedItem,
	toPlainText,
} from "../../src/news/feed.ts";
import { classifyIpAddress, looksLikeIpLiteral } from "../../src/news/ipClassification.ts";
import { validateFetchUrl } from "../../src/news/urlPolicy.ts";

/* ---------- Generators ---------- */

const octet = fc.integer({ min: 0, max: 255 });

type Ipv4 = readonly [number, number, number, number];

/** IPv4 addresses drawn only from ranges that must never be fetched. */
const nonPublicIpv4: fc.Arbitrary<Ipv4> = fc.oneof(
	fc.tuple(fc.constant(0), octet, octet, octet),
	fc.tuple(fc.constant(10), octet, octet, octet),
	fc.tuple(fc.constant(127), octet, octet, octet),
	fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), octet, octet),
	fc.tuple(fc.constant(169), fc.constant(254), octet, octet),
	fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), octet, octet),
	fc.tuple(fc.constant(192), fc.constant(168), octet, octet),
	fc.tuple(fc.constant(192), fc.constant(0), fc.constantFrom(0, 2), octet),
	fc.tuple(fc.constant(198), fc.constantFrom(18, 19), octet, octet),
	fc.tuple(fc.constant(198), fc.constant(51), fc.constant(100), octet),
	fc.tuple(fc.constant(203), fc.constant(0), fc.constant(113), octet),
	fc.tuple(fc.integer({ min: 224, max: 255 }), octet, octet, octet),
);

function dotted(ip: Ipv4): string {
	return ip.join(".");
}

function hexGroups(ip: Ipv4): readonly [string, string] {
	const [a, b, c, d] = ip;
	return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/** Every textual form in which an IPv4 destination can be smuggled into an address. */
function encodingsOf(ip: Ipv4): readonly string[] {
	const [high, low] = hexGroups(ip);
	return [
		dotted(ip),
		`::ffff:${dotted(ip)}`,
		`::ffff:${high}:${low}`,
		`0:0:0:0:0:ffff:${high}:${low}`,
		`::FFFF:${high.toUpperCase()}:${low.toUpperCase()}`,
		`::${dotted(ip)}`,
		`64:ff9b::${dotted(ip)}`,
		`64:ff9b::${high}:${low}`,
		`2002:${high}:${low}::1`,
		`2002:${high}:${low}:0:0:0:0:1`,
	];
}

const hexGroup = fc.integer({ min: 0, max: 0xffff }).map((group) => group.toString(16));

/** IPv6 addresses outside global unicast: ULA, link-local, site-local, multicast, documentation. */
const nonGlobalIpv6: fc.Arbitrary<string> = fc
	.tuple(
		fc.oneof(
			fc.integer({ min: 0xfc00, max: 0xfdff }),
			fc.integer({ min: 0xfe80, max: 0xfeff }),
			fc.integer({ min: 0xff00, max: 0xffff }),
			fc.integer({ min: 0x4000, max: 0xfbff }),
		),
		fc.array(hexGroup, { minLength: 7, maxLength: 7 }),
	)
	.map(([first, rest]) => [first.toString(16), ...rest].join(":"));

const hostLabel = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
const publicHost = fc
	.tuple(
		fc.array(hostLabel, { minLength: 1, maxLength: 2 }),
		fc.constantFrom("com", "org", "co.jp"),
	)
	.map(([labels, tld]) => `${labels.join(".")}.${tld}`);
const pathSegment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const paramName = fc
	.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,5}$/)
	.filter(
		(name) => !name.toLowerCase().startsWith("utm") && !TRACKING_NAMES.includes(name.toLowerCase()),
	);
const TRACKING_NAMES = [
	"fbclid",
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
];
const trackingName = fc.oneof(
	fc.constantFrom(...TRACKING_NAMES),
	fc.stringMatching(/^utm_[a-z]{1,8}$/),
);
const paramValue = fc.string({ unit: "grapheme", maxLength: 8 });
const params = fc.array(fc.tuple(paramName, paramValue), { maxLength: 5 });

interface UrlParts {
	readonly host: string;
	readonly segments: readonly string[];
	readonly params: readonly (readonly [string, string])[];
}

const urlParts: fc.Arbitrary<UrlParts> = fc.record({
	host: publicHost,
	segments: fc.array(pathSegment, { maxLength: 3 }),
	params,
});

function buildUrl(
	parts: UrlParts,
	extras: {
		readonly trailingSlash?: boolean;
		readonly fragment?: string;
		readonly upperCaseHost?: boolean;
	} = {},
): string {
	const host = extras.upperCaseHost === true ? parts.host.toUpperCase() : parts.host;
	const path = parts.segments.length === 0 ? "/" : `/${parts.segments.join("/")}`;
	const slash = extras.trailingSlash === true && path !== "/" ? "/" : "";
	const query = new URLSearchParams(parts.params.map(([name, value]) => [name, value])).toString();
	const fragment = extras.fragment === undefined ? "" : `#${encodeURIComponent(extras.fragment)}`;
	return `https://${host}${path}${slash}${query === "" ? "" : `?${query}`}${fragment}`;
}

function canonical(url: string): string {
	const result = canonicalizeArticleUrl(url);
	if (!result.ok) throw new Error(`expected ${url} to canonicalize, got ${result.error}`);
	return result.value;
}

/* ---------- Properties ---------- */

describe("classifyIpAddress properties (SEC-002)", () => {
	it("never returns public for a non-public IPv4 address in any encoding", () => {
		fc.assert(
			fc.property(nonPublicIpv4, (ip) => {
				for (const encoded of encodingsOf(ip)) {
					expect({ encoded, class: classifyIpAddress(encoded) }).toEqual({
						encoded,
						class: "non-public",
					});
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("never returns public for IPv6 addresses outside global unicast", () => {
		fc.assert(
			fc.property(nonGlobalIpv6, (address) => {
				expect(classifyIpAddress(address)).toBe("non-public");
			}),
			{ numRuns: 500 },
		);
	});

	it("never returns public for integer, hex or octal IPv4 aliases", () => {
		fc.assert(
			fc.property(fc.tuple(octet, octet, octet, octet), ([a, b, c, d]) => {
				const asInteger = a * 16_777_216 + b * 65_536 + c * 256 + d;
				const aliases = [
					String(asInteger),
					`0x${asInteger.toString(16)}`,
					`0${asInteger.toString(8)}`,
					`0x${a.toString(16)}.${b}.${c}.${d}`,
					`0${a.toString(8)}.0${b.toString(8)}.0${c.toString(8)}.0${d.toString(8)}`,
					`${a}.${b}.${c * 256 + d}`,
					`${a}.${b * 65_536 + c * 256 + d}`,
				];
				for (const alias of aliases) {
					// A plain dotted quad is the only accepted IPv4 spelling; anything else is invalid.
					if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(alias)) continue;
					expect({ alias, class: classifyIpAddress(alias) }).toEqual({ alias, class: "invalid" });
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("is total: arbitrary text is classified without throwing", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary", maxLength: 60 }), (text) => {
				expect(["public", "non-public", "invalid"]).toContain(classifyIpAddress(text));
			}),
			{ numRuns: 500 },
		);
	});

	it("agrees between the dotted and the IPv4-mapped spelling of any address", () => {
		fc.assert(
			fc.property(fc.tuple(octet, octet, octet, octet), (ip) => {
				expect(classifyIpAddress(`::ffff:${dotted(ip)}`)).toBe(classifyIpAddress(dotted(ip)));
			}),
			{ numRuns: 500 },
		);
	});
});

describe("validateFetchUrl properties (SEC-002)", () => {
	it("rejects every URL whose host is an IP literal, public or not, in any spelling", () => {
		fc.assert(
			fc.property(fc.tuple(octet, octet, octet, octet), pathSegment, (ip, segment) => {
				const [high, low] = hexGroups(ip);
				const asInteger = ip[0] * 16_777_216 + ip[1] * 65_536 + ip[2] * 256 + ip[3];
				const hosts = [
					dotted(ip),
					String(asInteger),
					`0x${asInteger.toString(16)}`,
					`[::ffff:${dotted(ip)}]`,
					`[::ffff:${high}:${low}]`,
					`[64:ff9b::${high}:${low}]`,
					`[2002:${high}:${low}::1]`,
				];
				for (const host of hosts) {
					const result = validateFetchUrl(`https://${host}/${segment}`);
					expect({ host, ok: result.ok }).toEqual({ host, ok: false });
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("never accepts anything but https, without credentials or port, on a dotted host name", () => {
		fc.assert(
			fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
				const result = validateFetchUrl(url);
				if (!result.ok) return;
				const parsed = new URL(result.value.href);
				expect(parsed.protocol).toBe("https:");
				expect(parsed.username).toBe("");
				expect(parsed.password).toBe("");
				expect(parsed.port).toBe("");
				expect(result.value.hostname).toBe(result.value.hostname.toLowerCase());
				expect(result.value.hostname).toContain(".");
				expect(looksLikeIpLiteral(result.value.hostname)).toBe(false);
			}),
			{ numRuns: 500 },
		);
	});

	it("is total and stable: arbitrary text never throws, and an accepted href is accepted again", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string({ unit: "binary", maxLength: 80 }),
					fc.string({ maxLength: 40 }).map((tail) => `https://${tail}`),
				),
				(text) => {
					const first = validateFetchUrl(text);
					if (!first.ok) return;
					expect(validateFetchUrl(first.value.href)).toEqual(first);
				},
			),
			{ numRuns: 1000 },
		);
	});

	it("accepts ordinary public https URLs", () => {
		fc.assert(
			fc.property(urlParts, (parts) => {
				const result = validateFetchUrl(buildUrl(parts));
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value.hostname).toBe(parts.host);
			}),
		);
	});
});

describe("canonicalizeArticleUrl properties (FR-003)", () => {
	it("is idempotent", () => {
		fc.assert(
			fc.property(urlParts, fc.boolean(), (parts, trailingSlash) => {
				const once = canonical(buildUrl(parts, { trailingSlash }));
				expect(canonical(once)).toBe(once);
			}),
			{ numRuns: 300 },
		);
	});

	it("is idempotent for arbitrary accepted URLs", () => {
		fc.assert(
			fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
				const once = canonicalizeArticleUrl(url.replace(/^http:/, "https:"));
				if (!once.ok) return;
				expect(canonicalizeArticleUrl(once.value)).toEqual(once);
			}),
			{ numRuns: 500 },
		);
	});

	it("ignores fragments, host case and a trailing slash", () => {
		fc.assert(
			fc.property(
				urlParts,
				fc.string({ maxLength: 10 }),
				fc.boolean(),
				fc.boolean(),
				(parts, fragment, upperCaseHost, trailingSlash) => {
					expect(canonical(buildUrl(parts, { fragment, upperCaseHost, trailingSlash }))).toBe(
						canonical(buildUrl(parts)),
					);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("ignores tracking parameters wherever they are inserted", () => {
		fc.assert(
			fc.property(
				urlParts,
				fc.array(fc.tuple(trackingName, paramValue, fc.nat({ max: 5 })), { maxLength: 4 }),
				(parts, tracking) => {
					const withTracking = [...parts.params];
					for (const [name, value, position] of tracking) {
						withTracking.splice(Math.min(position, withTracking.length), 0, [name, value]);
					}
					expect(canonical(buildUrl({ ...parts, params: withTracking }))).toBe(
						canonical(buildUrl(parts)),
					);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("ignores query parameter order, including repeated names and Unicode values", () => {
		fc.assert(
			fc.property(
				urlParts.chain((parts) =>
					fc.tuple(
						fc.constant(parts),
						fc.shuffledSubarray([...parts.params], { minLength: parts.params.length }),
					),
				),
				([parts, shuffled]) => {
					expect(canonical(buildUrl({ ...parts, params: shuffled }))).toBe(
						canonical(buildUrl(parts)),
					);
				},
			),
			{ numRuns: 500 },
		);
	});

	it("never yields a fragment, a tracking parameter or an upper-case host", () => {
		fc.assert(
			fc.property(
				urlParts,
				fc.array(fc.tuple(trackingName, paramValue), { maxLength: 3 }),
				(parts, tracking) => {
					const url = new URL(
						canonical(
							buildUrl(
								{ ...parts, params: [...tracking, ...parts.params] },
								{ fragment: "x", upperCaseHost: true },
							),
						),
					);
					expect(url.hash).toBe("");
					expect(url.hostname).toBe(parts.host);
					for (const name of url.searchParams.keys()) {
						expect(name.toLowerCase().startsWith("utm_")).toBe(false);
						expect(TRACKING_NAMES).not.toContain(name.toLowerCase());
					}
					// Content parameters survive, as a multiset.
					const sortPairs = (pairs: readonly (readonly [string, string])[]) =>
						pairs.map(([name, value]) => JSON.stringify([name, value])).sort();
					expect(sortPairs([...url.searchParams.entries()])).toEqual(sortPairs(parts.params));
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe("feed normalization properties", () => {
	const rawItem: fc.Arbitrary<RawFeedItem> = fc.record({
		title: fc.option(fc.string({ unit: "grapheme", maxLength: 400 }), { nil: null }),
		link: fc.option(
			fc.oneof(
				urlParts.map((parts) => buildUrl(parts)),
				fc.constantFrom(
					"https://news.example.com/a",
					"https://news.example.com/a?utm_source=x",
					"https://NEWS.example.com/a/#top",
					"http://news.example.com/a",
					"https://127.0.0.1/",
					"https://localhost/",
					"nonsense",
					"",
				),
			),
			{ nil: null },
		),
		publishedText: fc.option(
			fc.constantFrom("Sat, 10 Oct 2026 12:00:00 GMT", "2026-10-10T12:00:00Z", "garbage"),
			{ nil: null },
		),
		summaryText: fc.option(fc.string({ unit: "grapheme", maxLength: 700 }), { nil: null }),
	});

	it("accounts for every examined item and never emits duplicates or unsafe links", () => {
		fc.assert(
			fc.property(
				fc.array(rawItem, { maxLength: 12 }),
				fc.integer({ min: 0, max: 12 }),
				fc.constantFrom("headline-and-link-only" as const, "short-excerpt-permitted" as const),
				(items, maxItems, licensePolicy) => {
					const result = normalizeFeed(
						{ kind: "atom", title: null, siteLink: null, items },
						{ publisher: "P", retrievedAt: "2026-10-11T00:00:00.000Z", licensePolicy, maxItems },
					);
					const examined = Math.min(items.length, maxItems);
					expect(result.truncatedItemCount).toBe(items.length - examined);
					expect(result.articles.length + result.rejected.length).toBeLessThanOrEqual(examined);
					for (const rejection of result.rejected) {
						expect(rejection.index).toBeGreaterThanOrEqual(0);
						expect(rejection.index).toBeLessThan(examined);
					}
					const urls = result.articles.map((article) => article.canonicalUrl);
					expect(new Set(urls).size).toBe(urls.length);
					for (const article of result.articles) {
						expect(canonicalizeArticleUrl(article.canonicalUrl)).toEqual({
							ok: true,
							value: article.canonicalUrl,
						});
						expect(article.title.length).toBeGreaterThan(0);
						expect(article.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
						expect(article.title).toBe(toPlainText(article.title));
						if (licensePolicy === "headline-and-link-only") expect(article.excerpt).toBeNull();
						if (article.excerpt !== null) {
							expect(article.excerpt.length).toBeGreaterThan(0);
							expect(article.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
						}
					}
				},
			),
			{ numRuns: 300 },
		);
	});

	it("is idempotent on already-normalized feeds: a second ingestion finds the same articles", () => {
		fc.assert(
			fc.property(fc.array(rawItem, { maxLength: 10 }), (items) => {
				const feedOptions = {
					publisher: "P",
					retrievedAt: "2026-10-11T00:00:00.000Z",
					licensePolicy: "short-excerpt-permitted" as const,
					maxItems: 50,
				};
				const first = normalizeFeed(
					{ kind: "rss", title: null, siteLink: null, items },
					feedOptions,
				);
				const second = normalizeFeed(
					{
						kind: "rss",
						title: null,
						siteLink: null,
						items: first.articles.map((article) => ({
							title: article.title,
							link: article.canonicalUrl,
							publishedText: article.publishedAt,
							summaryText: article.excerpt,
						})),
					},
					feedOptions,
				);
				expect(second.rejected).toEqual([]);
				expect(second.articles.map((article) => article.canonicalUrl)).toEqual(
					first.articles.map((article) => article.canonicalUrl),
				);
			}),
			{ numRuns: 200 },
		);
	});

	it("toPlainText output never contains a complete tag and is stable under re-application", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.string({ unit: "grapheme", maxLength: 12 }),
						fc.constantFrom(
							"<b>",
							"</b>",
							"<script>",
							"</script>",
							"&lt;",
							"&gt;",
							"&amp;",
							"&#60;",
							"&#x3e;",
							"<",
							">",
							"<img src=x onerror=1>",
						),
					),
					{ maxLength: 12 },
				),
				(pieces) => {
					const text = toPlainText(pieces.join(""));
					expect(text).not.toMatch(/<[^>]*>/);
					expect(text).toBe(text.trim());
					expect(text).not.toMatch(/\s{2,}/);
				},
			),
			{ numRuns: 500 },
		);
	});
});
