/**
 * Feeds (crates `research-feed` and `research-domain`, module `news::feed`):
 * the fast-xml-parser-based `FeedParser`, the library's validator verdict
 * and object tree (key order included), `toPlainText`,
 * `articleFingerprintMaterial`, `parseFeedTimestamp` and `normalizeFeed`.
 *
 * Inputs: the feed fixtures and every literal of the TypeScript feed tests,
 * the fast-check arbitraries of `news.property.test.ts` (fixed seeds), and
 * seeded generators of RSS/Atom variants, malformed XML and markup soup.
 * Domain functions run with the process zone set to UTC (feed timestamps
 * never depend on it, but the vectors must not depend on the machine).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFeedParser } from "@research/adapters/feed";
import {
	articleFingerprintMaterial,
	type LicensePolicy,
	type NormalizeFeedOptions,
	normalizeFeed,
	parseFeedTimestamp,
	type RawFeed,
	type RawFeedItem,
	toPlainText,
} from "@research/domain";
import fc from "fast-check";
// fast-xml-parser is a dependency of the adapters package only (not hoisted).
import {
	XMLParser,
	XMLValidator,
} from "../../packages/adapters/node_modules/fast-xml-parser/src/fxp.js";
import { FEED_XML } from "../../tests/e2e/fixtures.ts";
import { seededRandom, type VectorExporter, wellFormed } from "./shared.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixture(name: string): string {
	return readFileSync(join(repoRoot, "examples", "fixtures", "feeds", name), "utf8");
}

const FIXTURES = [
	"atom-synthetic.xml",
	"rss2-synthetic.xml",
	"rss1-rdf-synthetic.xml",
	"billion-laughs-synthetic.xml",
	"xxe-synthetic.xml",
	"html-page-synthetic.html",
];

/** Every literal input of `packages/adapters/test/feed/feedParser.test.ts` (small ones). */
const PARSER_TEST_INPUTS = [
	'<rss version="2.0"><channel><title>t</title><item><title>a</title><guid isPermaLink="false">https://news.synthetic-wire.org/not-a-link</guid></item></channel></rss>',
	"<rss><channel><title>t</title><item><title>only</title><link>https://a.synthetic-wire.org/1</link></item></channel></rss>",
	"<rss><channel><title>t</title></channel></rss>",
	'<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>P</atom:title><atom:entry><atom:title>e</atom:title><atom:link href="https://synthetic-notes.org/p"/><atom:updated>2026-10-01T00:00:00Z</atom:updated></atom:entry></atom:feed>',
	"<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>",
	"<urlset><url><loc>https://a.synthetic-wire.org/</loc></url></urlset>",
	"<rss><notachannel/></rss>",
	"<feed><unrelated>1</unrelated></feed>",
	'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><thing/></rdf:RDF>',
	"",
	"   ",
	"plain text, no markup",
	"<rss><channel><item><title>unterminated",
	"<rss><channel><title>A & B</title></channel></rss>",
	"<rss><channel></rss></channel>",
	'{"json": true}',
	"\u0000\u0001\u0002<rss>",
	"<<<<>>>>",
	"<rss><channel><title>t</title><__proto__><polluted>yes</polluted></__proto__><constructor>x</constructor></channel></rss>",
	`<rss><channel><title>t</title><item><title>${"T".repeat(10_000)}</title><link>https://a.synthetic-wire.org/x</link><description>${"word ".repeat(5_000)}</description></item></channel></rss>`,
	"<rss><channel><title>&#x41;&#66;&#0;&#xD800; &unknown; &amp;lt;</title></channel></rss>",
	`${"<a>".repeat(70)}x${"</a>".repeat(70)}`,
	`<rss><channel><title>t</title><item><title>${"<a>".repeat(70)}x${"</a>".repeat(70)}</title></item></channel></rss>`,
	`<rss><channel><title>${"経".repeat(3000)}</title></channel></rss>`,
];

/** fast-xml-parser exactly as `createFeedParser` configures it. */
const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	textNodeName: "#text",
	cdataPropName: "#cdata",
	processEntities: false,
	htmlEntities: false,
	parseTagValue: false,
	parseAttributeValue: false,
	allowBooleanAttributes: false,
	trimValues: true,
	ignoreDeclaration: true,
	ignorePiTags: true,
	removeNSPrefix: false,
	maxNestedTags: 64,
});

const feedParser = createFeedParser();

function pick<T>(random: () => number, values: readonly T[]): T {
	const value = values[Math.floor(random() * values.length)];
	if (value === undefined) throw new Error("empty choice");
	return value;
}

function chance(random: () => number, probability: number): boolean {
	return random() < probability;
}

/* ---------- Random feeds ---------- */

const TEXTS = [
	"Grid battery orders double",
	"Heat pump shipments rise 12%",
	"  padded title  ",
	"",
	"   ",
	"　  wide spaces 　",
	"Fish &amp; Chips &lt;3",
	"&#x41;&#66;&#0;&#xD800;&#xD83D;&#xDE00;",
	"&lol9; &unknown; &amp;amp; &#X41; &#x1234567;",
	"&quot;quoted&quot; &apos;x&apos; &gt;",
	"&lt;b&gt;bold&lt;/b&gt; &amp;nbsp;",
	"合成経済ニュース",
	"emoji 📈 and 🔋",
	"tab\tand\nnewline\r\nand CR\r",
	"﻿bom inside",
	"x\u0085y",
];
const MARKUP = [
	"<b>bold</b>",
	"<em>tail</em>",
	'<a href="https://x.org/">link</a>',
	"<br/>",
	"<p>para</p><p>two</p>",
	"<div><span>deep <i>nested</i></span></div>",
	"<x:y>ns</x:y>",
	"<toString>t</toString>",
	"<hasOwnProperty>h</hasOwnProperty>",
	"<b>1</b><b>2</b><b k='v'>3</b>",
];
const LINKS = [
	"https://news.synthetic-wire.org/2026/10/a?utm_source=rss&amp;id=7",
	"https://news.synthetic-wire.org/b",
	" https://news.synthetic-wire.org/c ",
	"http://192.168.1.1/x",
	"/relative/path",
	"",
	"   ",
	"HTTPS://Synthetic-Notes.org/Upper/",
	"https://synthetic-notes.org/posts/x?b=2&amp;a=1#frag",
	"javascript:alert(1)",
	"https://[::1]/",
];
/** Just over `MAX_LINK_CHARS` (4,096) once trimmed; used sparingly to keep the file small. */
const LONG_LINK = `https://a.synthetic-wire.org/${"p".repeat(4070)}`;

function link(random: () => number): string {
	return chance(random, 0.01) ? LONG_LINK : pick(random, LINKS);
}

const DATES = [
	"Mon, 05 Oct 2026 09:30:00 GMT",
	"2026-10-04T08:00:00+09:00",
	"2026-10-05T06:00:00Z",
	"Sat, 10 Oct 2026 21:00:00 +0900",
	"2026-02-30",
	"garbage",
	"",
	"  2026-10-10T12:00:00Z  ",
	"10 Oct 2026 12:00 EST",
	"2026-10-10 12:00",
	"Sat, 10 Oct 2026 12:00:00",
	`${"9".repeat(120)}`,
];

function textPiece(random: () => number): string {
	const roll = random();
	if (roll < 0.45) return pick(random, TEXTS);
	if (roll < 0.6)
		return `<![CDATA[${pick(random, ["<b>raw</b> & bare", "", "]]", "x]]y", "  spaced  "])}]]>`;
	if (roll < 0.8) return `${pick(random, TEXTS)}${pick(random, MARKUP)}${pick(random, TEXTS)}`;
	if (roll < 0.9) return `${pick(random, TEXTS)}<!-- comment -->${pick(random, TEXTS)}`;
	return `${pick(random, TEXTS)}<?pi data?>${pick(random, TEXTS)}`;
}

function element(random: () => number, name: string, content: string, attributes = ""): string {
	if (content === "" && chance(random, 0.3)) return `<${name}${attributes}/>`;
	return `<${name}${attributes}>${content}</${name}>`;
}

function rssItem(random: () => number): string {
	const parts: string[] = [];
	if (chance(random, 0.9)) parts.push(element(random, "title", textPiece(random)));
	if (chance(random, 0.2)) parts.push(element(random, "title", textPiece(random)));
	if (chance(random, 0.75)) parts.push(element(random, "link", link(random)));
	if (chance(random, 0.4)) {
		const permalink = pick(random, [
			"",
			' isPermaLink="false"',
			' isPermaLink="true"',
			" isPermaLink='false'",
		]);
		parts.push(element(random, "guid", link(random), permalink));
	}
	if (chance(random, 0.2))
		parts.push(
			`<atom:link rel="${pick(random, ["alternate", "self", "enclosure"])}" href="${link(random)}"/>`,
		);
	if (chance(random, 0.6))
		parts.push(element(random, pick(random, ["pubDate", "dc:date"]), pick(random, DATES)));
	if (chance(random, 0.6))
		parts.push(
			element(random, pick(random, ["description", "content:encoded"]), textPiece(random)),
		);
	if (chance(random, 0.2)) parts.push(element(random, "category", pick(random, TEXTS)));
	shuffle(random, parts);
	return `<item>${parts.join(pick(random, ["", "\n", "\n\t\t"]))}</item>`;
}

function atomLink(random: () => number): string {
	const rel = pick(random, [
		"",
		' rel="alternate"',
		' rel="self"',
		' rel="enclosure"',
		" rel='alternate'",
	]);
	const href = chance(random, 0.9) ? ` href="${link(random)}"` : "";
	const type = chance(random, 0.3) ? ' type="text/html"' : "";
	return `<${pick(random, ["link", "link", "atom:link"])}${rel}${type}${href}/>`;
}

function atomEntry(random: () => number, prefix: string): string {
	const parts: string[] = [];
	if (chance(random, 0.9))
		parts.push(
			element(
				random,
				`${prefix}title`,
				textPiece(random),
				chance(random, 0.3) ? ' type="html"' : "",
			),
		);
	const links = Math.floor(random() * 4);
	for (let index = 0; index < links; index += 1) parts.push(atomLink(random));
	if (chance(random, 0.5)) parts.push(element(random, `${prefix}published`, pick(random, DATES)));
	if (chance(random, 0.5)) parts.push(element(random, `${prefix}updated`, pick(random, DATES)));
	if (chance(random, 0.4)) parts.push(element(random, `${prefix}summary`, textPiece(random)));
	if (chance(random, 0.4)) {
		const xhtml = `<div xmlns="http://www.w3.org/1999/xhtml">${textPiece(random)}<p>${pick(random, TEXTS)}</p></div>`;
		parts.push(
			element(
				random,
				`${prefix}content`,
				chance(random, 0.5) ? xhtml : textPiece(random),
				' type="xhtml"',
			),
		);
	}
	if (chance(random, 0.5)) parts.push(element(random, `${prefix}id`, "urn:uuid:1"));
	shuffle(random, parts);
	return `<${prefix}entry>${parts.join("")}</${prefix}entry>`;
}

function shuffle<T>(random: () => number, values: T[]): void {
	for (let index = values.length - 1; index > 0; index -= 1) {
		const other = Math.floor(random() * (index + 1));
		const swap = values[index] as T;
		values[index] = values[other] as T;
		values[other] = swap;
	}
}

function randomFeed(random: () => number): string {
	const kind = Math.floor(random() * 6);
	const items = Math.floor(random() * 5);
	let body: string;
	if (kind <= 1) {
		const channel = [
			chance(random, 0.9) ? element(random, "title", textPiece(random)) : "",
			chance(random, 0.7) ? element(random, "link", link(random)) : "",
			chance(random, 0.3) ? atomLink(random) : "",
			...Array.from({ length: items }, () => rssItem(random)),
		].join("\n");
		body = `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>${channel}</channel></rss>`;
	} else if (kind === 2) {
		const rdfItems = Array.from({ length: items }, () => rssItem(random)).join("");
		body = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel>${element(random, "title", textPiece(random))}<link>${link(random)}</link></channel>${rdfItems}</rdf:RDF>`;
	} else if (kind <= 4) {
		const prefix = kind === 4 ? "atom:" : "";
		const head = [
			chance(random, 0.8) ? element(random, `${prefix}title`, textPiece(random)) : "",
			chance(random, 0.6) ? atomLink(random) : "",
			chance(random, 0.3) ? element(random, `${prefix}id`, "urn:x") : "",
		].join("");
		const entries = Array.from({ length: items }, () => atomEntry(random, prefix)).join("");
		const xmlns =
			prefix === ""
				? ' xmlns="http://www.w3.org/2005/Atom"'
				: ' xmlns:atom="http://www.w3.org/2005/Atom"';
		body = `<${prefix}feed${xmlns}>${head}${entries}</${prefix}feed>`;
	} else {
		body = pick(random, [
			"<urlset><url><loc>x</loc></url></urlset>",
			"<rss/>",
			"<rss><channel/></rss>",
			"<feed/>",
			"<feed><entry/></feed>",
			"<rss><channel>t</channel></rss>",
			"<r/><rss><channel><title>second root</title></channel></rss>",
		]);
	}
	const prolog = pick(random, [
		"",
		'<?xml version="1.0" encoding="UTF-8"?>\n',
		'<?xml version="1.0"?><!-- lead -->\n',
		"﻿<?xml version='1.0'?>",
		'<!DOCTYPE rss [<!ENTITY lol "lol"><!ELEMENT rss ANY>]>\n',
		'<!DOCTYPE feed SYSTEM "x.dtd">',
		"<?xml-stylesheet href='a.xsl'?>\n",
		"  \n",
	]);
	let text = `${prolog}${body}${pick(random, ["", "\n", "<!-- tail -->", "  "])}`;
	if (chance(random, 0.15)) text = text.replace(/\n/g, "\r\n");
	if (chance(random, 0.2)) text = mutate(random, text);
	return text;
}

function mutate(random: () => number, text: string): string {
	const alphabet = "<>/&;\"'=! ?[]-#xa ﻿";
	const at = Math.floor(random() * (text.length + 1));
	const ch = alphabet[Math.floor(random() * alphabet.length)] ?? "";
	const kind = Math.floor(random() * 3);
	if (kind === 0) return text.slice(0, at) + ch + text.slice(at);
	if (kind === 1) return text.slice(0, at) + text.slice(at + 1);
	return text.slice(0, at) + ch + text.slice(at + 1);
}

/* ---------- Random XML snippets (validator and tree) ---------- */

const SNIPPET_TOKENS = [
	"<a>",
	"</a>",
	"<a/>",
	"<a />",
	"<b>",
	"</b>",
	"<b/>",
	'<a x="1">',
	"<a x='1' y=\"2\">",
	'<a x="1"/>',
	'<a x="1" x="2">',
	"<a x>",
	"<a x=1>",
	'<a x="1"y="2">',
	'<a\tx="1">',
	'<a x="1">',
	'<a﻿x="1">',
	"< a>",
	"<a﻿>",
	"<a:b>",
	"</a:b>",
	"<1a>",
	"< a>",
	"</ a>",
	"</a >",
	"<a/ >",
	"</a/>",
	"text",
	"  spaced  ",
	"　",
	"\r\n",
	"\r",
	"\n",
	"&amp;",
	"&",
	"& ",
	"&;",
	"&#;",
	"&#x;",
	"&#x41;",
	"&#65",
	"&lol;",
	"&abcdefghijklmnopqrstuvwxyz;",
	"<![CDATA[c]]>",
	"<![CDATA[]]>",
	"<![CDATA[x]]y]]>",
	"<![FOO[x]]>",
	"<![CDATA[unterminated",
	"<!-- c -->",
	"<!---->",
	"<!-->",
	"<!-- unterminated",
	"<?pi x?>",
	'<?xml version="1.0"?>',
	"<??>",
	"<?pi",
	'<!DOCTYPE r [<!ENTITY e "v">]>',
	"<!DOCTYPE r>",
	"<!DOCTYPEr>",
	"<!Dx>",
	"<!x>",
	'<!DOCTYPE r [<!ENTITY e SYSTEM "f">]>',
	'<!DOCTYPE r [<!ENTITY % p "v">]>',
	"<!DOCTYPE r [<!ELEMENT r (#PCDATA)>]>",
	'<!DOCTYPE r [<!NOTATION n SYSTEM "x">]>',
	"<!DOCTYPE r [<!ATTLIST r a CDATA #IMPLIED>]>",
	"<!DOCTYPE r [<!BOGUS>]>",
	"<toString>",
	"</toString>",
	"<__proto__>",
	"<constructor/>",
	"<prototype>",
	"<valueOf/>",
	"<#text>",
	"﻿",
	">",
	"<",
	"]]>",
	'"',
	"'",
];

function randomSnippet(random: () => number): string {
	if (chance(random, 0.5)) {
		// A well-formed tree with mixed content, so the tree shape is exercised.
		return wellFormedTree(random, 0);
	}
	const count = 1 + Math.floor(random() * 10);
	let text = "";
	for (let index = 0; index < count; index += 1) text += pick(random, SNIPPET_TOKENS);
	return text;
}

function wellFormedTree(random: () => number, depth: number): string {
	const name = pick(random, ["a", "b", "c", "atom:t", "toString", "x-y", "_u", "é"]);
	const attributes = chance(random, 0.3)
		? ` k="${pick(random, ["1", " v ", "&amp;", "<", ""])}"`
		: "";
	if (depth > 3 || chance(random, 0.25))
		return chance(random, 0.5)
			? `<${name}${attributes}/>`
			: `<${name}${attributes}>${pick(random, ["", " ", "t", " t ", "&#x41;", "<![CDATA[ c ]]>"])}</${name}>`;
	const children = Math.floor(random() * 4);
	let inner = "";
	for (let index = 0; index < children; index += 1) {
		if (chance(random, 0.5))
			inner += pick(random, ["x", " y ", "\n", "<!-- c -->", "<![CDATA[d]]>", "<?p?>", "&amp;"]);
		inner += wellFormedTree(random, depth + 1);
	}
	if (chance(random, 0.5)) inner += pick(random, ["tail", " ", ""]);
	return `<${name}${attributes}>${inner}</${name}>`;
}

/* ---------- Encoding ---------- */

/** A Rust string cannot hold a lone surrogate (a mutation can split a pair). */
function isWellFormed(text: string): boolean {
	return wellFormed(text) === text;
}

type Encoded =
	| string
	| { readonly o: readonly (readonly [string, Encoded])[] }
	| { readonly a: readonly Encoded[] };

function encodeTree(value: unknown): Encoded {
	if (typeof value === "string") return wellFormed(value);
	if (Array.isArray(value)) return { a: value.map(encodeTree) };
	if (typeof value === "object" && value !== null) {
		return {
			o: Object.entries(value).map(([key, child]): readonly [string, Encoded] => [
				wellFormed(key),
				encodeTree(child),
			]),
		};
	}
	throw new Error(`unexpected tree value ${String(value)}`);
}

function encodeFeed(feed: RawFeed): unknown {
	const text = (value: string | null) => (value === null ? null : wellFormed(value));
	return {
		kind: feed.kind,
		title: text(feed.title),
		siteLink: text(feed.siteLink),
		items: feed.items.map((item) => ({
			title: text(item.title),
			link: text(item.link),
			publishedText: text(item.publishedText),
			summaryText: text(item.summaryText),
		})),
	};
}

/** The feed as Rust sees it: lone surrogates already U+FFFD. */
function wellFormedFeed(feed: RawFeed): RawFeed {
	const text = (value: string | null) => (value === null ? null : wellFormed(value));
	return {
		kind: feed.kind,
		title: text(feed.title),
		siteLink: text(feed.siteLink),
		items: feed.items.map((item) => ({
			title: text(item.title),
			link: text(item.link),
			publishedText: text(item.publishedText),
			summaryText: text(item.summaryText),
		})),
	};
}

function encodeNormalized(feed: RawFeed, options: NormalizeFeedOptions): unknown {
	const result = normalizeFeed(feed, options);
	return {
		articles: result.articles.map((article) => ({
			canonicalUrl: wellFormed(article.canonicalUrl),
			title: wellFormed(article.title),
			publisher: wellFormed(article.publisher),
			publishedAt: article.publishedAt,
			retrievedAt: article.retrievedAt,
			excerpt: article.excerpt === null ? null : wellFormed(article.excerpt),
			fingerprintMaterial: wellFormed(article.fingerprintMaterial),
		})),
		rejected: result.rejected,
		truncatedItemCount: result.truncatedItemCount,
	};
}

/* ---------- Domain corpora ---------- */

/** Every literal `toPlainText` input of `feed.test.ts`. */
const PLAIN_TEXT_TEST_INPUTS = [
	"<p>Hello   <b>world</b></p>\n\n<br/>again",
	"Before<script>alert('x')</script>After",
	"A<STYLE type='text/css'>p { color: red }</STYLE >B",
	"Fish &amp; Chips &lt;3 &quot;quoted&quot; &apos;x&apos;",
	"&#65;&#x42;&#X43;",
	"a&nbsp;b",
	"down from the 13&ndash;24% growth seen",
	"Gross withdrawals &mdash;the total volume&mdash;reached",
	"&ldquo;Caf&eacute;&rdquo; &euro;5 &plusmn;2&deg; &frac12; &copy; &hellip;",
	"&iexcl;&times;&yuml;",
	"&Eacute;&eacute; &Prime;&prime;",
	"A &AMP; B &LT; C",
	"infra&shy;structure x&zwnj;y a&ensp;b&thinsp;c",
	"&constructor; &toString; &hasOwnProperty;",
	'in our <a href="/mer">Monthly Energy Review</a>, down',
	"CO<sub>2</sub> and 1<sup>st</sup> <STRONG>bold</STRONG>.",
	"<p>one</p><p>two</p><div>three</div>four<br>five",
	"x<article>y</article>z<bdi>w</bdi>",
	"a&lt;b&gt;c&lt;/b&gt;d",
	"&unknown; ok",
	"a&#0;b&#x110000;c",
	"&lt;b&gt;bold&lt;/b&gt; text",
	"&lt;img src=x onerror=alert(1)&gt;caption",
	"<p><br/></p>",
	"  \n\t ",
	"<b></b>",
	"<script>alert(1)</script>",
	"Chips &amp; <em>tariffs</em>",
	"<p>Prices rose <script>steal()</script>sharply.</p>",
];

const PLAIN_PIECES = [
	"<b>",
	"</b>",
	"<B >",
	"</b\n>",
	"<b x>",
	"<b　>",
	"<abbr title='x'>",
	"<a\thref=1>",
	"<i/>",
	"<sub>",
	"<u>",
	"<ul>",
	"<script>",
	"</script>",
	"</SCRIPT >",
	"</script >",
	"</script x>",
	"<script",
	"<scripts>",
	"<style>",
	"</style>",
	"<STYLE\n>",
	"<img src=x onerror=1>",
	"<",
	">",
	"<<",
	">>",
	"< b>",
	"<!-- c -->",
	"<br/>",
	"&lt;",
	"&gt;",
	"&amp;",
	"&#60;",
	"&#x3e;",
	"&#X3C;",
	"&#0;",
	"&#xD800;",
	"&#xD83D;",
	"&#xDE00;",
	"&#xDC00;",
	"&#x110000;",
	"&#99999999999;",
	`&#${"9".repeat(400)};`,
	"&#00065;",
	"&nbsp;",
	"&NBSP;",
	"&Nbsp;",
	"&shy;",
	"&yuml;",
	"&Yuml;",
	"&YUML;",
	"&eacute;",
	"&EACUTE;",
	"&ndash;",
	"&notanentity;",
	"&;",
	"&#;",
	"&#x;",
	"&a1;",
	"&1a;",
	"&amp",
	"&amp;lt;b&amp;gt;",
	"text",
	" ",
	"\t",
	"\n",
	" ",
	"　",
	"﻿",
	"\u0085",
	" ",
	"é",
	"日本",
	"📈",
	"Ｆｕｌｌ",
];

function plainTextInputs(random: () => number): string[] {
	const out = [...PLAIN_TEXT_TEST_INPUTS];
	// The `toPlainText` property of news.property.test.ts, same arbitrary.
	const pieces = fc.array(
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
	);
	for (const sample of fc.sample(pieces, { seed: 20_261_011, numRuns: 1500 }))
		out.push(sample.join(""));
	for (let index = 0; index < 5000; index += 1) {
		const count = 1 + Math.floor(random() * 12);
		let text = "";
		for (let part = 0; part < count; part += 1) text += pick(random, PLAIN_PIECES);
		out.push(text);
	}
	out.push(`${"<script>".repeat(300)}x`);
	out.push(`${"<b x ".repeat(300)}`);
	out.push(`${"&lt;b&gt;".repeat(500)}`);
	return out;
}

const TIMESTAMP_SHAPES = [
	"Sat, 10 Oct 2026 12:00:00 GMT",
	"2026-10-10T12:00:00Z",
	"Sat, 10 Oct 2026 21:00:00 +0900",
	"2026-10-10T21:00:00+09:00",
	"yesterday-ish",
	"32 Foo 2026",
	"",
	"garbage",
];

function timestampInputs(random: () => number): (string | null)[] {
	const out: (string | null)[] = [null, ...TIMESTAMP_SHAPES];
	const dates = [
		"2026-10-10",
		"2026-02-30",
		"2026-13-01",
		"0000-01-01",
		"9999-12-31",
		"2026-1-01",
		"20261010",
	];
	const times = [
		"",
		"T12:00",
		" 12:00",
		"t12:00:59",
		"T24:00",
		"T23:59:60",
		"T12:00:00.1",
		"T12:00:00.123456789",
		"T12:00:00.1234567890",
		"T25:00",
	];
	const zones = ["", "Z", "z", "+09:00", "-0530", " Z", "  +0900", "+9", "+24:00", "GMT"];
	for (const date of dates)
		for (const time of times) for (const zone of zones) out.push(`${date}${time}${zone}`);
	const days = ["1", "01", "31", "32", "0", "123"];
	const months = ["Oct", "oct", "OCT", "Feb", "Dec", "Foo", "Octo"];
	const years = ["2026", "2026", "0049", "0099", "1969", "26", "12345"];
	const clocks = ["12:00", "12:00:00", "09:30:00", "23:59:61", "24:00", "12:60", "1:00"];
	const rfcZones = [
		"",
		"GMT",
		"utc",
		"UT",
		"Z",
		"EST",
		"pdt",
		"+0900",
		"-0000",
		"+2400",
		"+09:00",
		"JST",
	];
	for (let index = 0; index < 6000; index += 1) {
		const weekday = pick(random, ["", "", "Sat, ", "sat,", "Sat,  ", "Saturday, ", "Xyz, "]);
		const separator = pick(random, [" ", "  ", "\t", " ", " "]);
		const parts = [
			pick(random, days),
			pick(random, months),
			pick(random, years),
			pick(random, clocks),
		];
		const zone = pick(random, rfcZones);
		out.push(
			`${pick(random, ["", " ", "　"])}${weekday}${parts.join(separator)}${zone === "" ? "" : pick(random, [" ", "", "  "])}${zone}${pick(random, ["", " ", "﻿"])}`,
		);
	}
	return out;
}

/* ---------- normalizeFeed corpora ---------- */

const RETRIEVED_AT = "2026-10-11T03:00:00.000Z";

function testItem(overrides: Partial<RawFeedItem> = {}): RawFeedItem {
	return {
		title: "Battery makers expand capacity",
		link: "https://news.example.com/articles/battery-capacity",
		publishedText: "Sat, 10 Oct 2026 12:00:00 GMT",
		summaryText: "Three suppliers announced new plants.",
		...overrides,
	};
}

function testFeed(items: readonly RawFeedItem[]): RawFeed {
	return { kind: "rss", title: "Example Wire", siteLink: "https://news.example.com/", items };
}

const TEST_OPTIONS: NormalizeFeedOptions = {
	publisher: "Example Wire",
	retrievedAt: RETRIEVED_AT,
	licensePolicy: "short-excerpt-permitted",
	maxItems: 50,
};

/** The `normalizeFeed` cases of feed.test.ts. */
function testFeeds(): [RawFeed, NormalizeFeedOptions][] {
	const cases: [RawFeed, NormalizeFeedOptions][] = [
		[testFeed([testItem()]), TEST_OPTIONS],
		[testFeed([testItem(), testItem({ link: "https://news.example.com/b" })]), TEST_OPTIONS],
		[testFeed([testItem({ publishedText: "Sat, 10 Oct 2026 21:00:00 +0900" })]), TEST_OPTIONS],
		[testFeed([testItem({ publishedText: "2026-10-10T21:00:00+09:00" })]), TEST_OPTIONS],
		[
			testFeed([
				testItem({ link: "https://news.example.com/ok-1" }),
				testItem({ title: null }),
				testItem({ link: "https://news.example.com/ok-2" }),
				testItem({ link: "http://news.example.com/insecure" }),
				testItem({ link: null }),
			]),
			TEST_OPTIONS,
		],
		[
			testFeed([
				testItem({ title: "First", link: "https://news.example.com/story?id=7" }),
				testItem({
					title: "Second",
					link: "https://NEWS.example.com/story/?id=7&utm_source=rss#top",
				}),
				testItem({ title: "Third", link: " https://news.example.com/story?id=7 " }),
			]),
			TEST_OPTIONS,
		],
		[
			testFeed([
				testItem({ link: "https://news.example.com/a" }),
				testItem({ link: "https://news.example.com/b" }),
			]),
			TEST_OPTIONS,
		],
		[
			testFeed([
				testItem({
					title: "Chips &amp; <em>tariffs</em>",
					summaryText: "<p>Prices rose <script>steal()</script>sharply.</p>",
				}),
			]),
			TEST_OPTIONS,
		],
		[testFeed([testItem()]), { ...TEST_OPTIONS, licensePolicy: "headline-and-link-only" }],
		[
			testFeed([testItem({ title: "t".repeat(1000), summaryText: "s".repeat(5000) })]),
			TEST_OPTIONS,
		],
		[testFeed([testItem({ title: "t".repeat(300), summaryText: "s".repeat(500) })]), TEST_OPTIONS],
		[testFeed([testItem({ title: "t".repeat(301), summaryText: "s".repeat(501) })]), TEST_OPTIONS],
		[
			testFeed([testItem({ title: "📈".repeat(200), summaryText: "🔋".repeat(400) })]),
			TEST_OPTIONS,
		],
		[
			testFeed([testItem({ title: `${"t".repeat(298)}📈`, summaryText: `${"s".repeat(498)}🔋x` })]),
			TEST_OPTIONS,
		],
		[
			testFeed(
				Array.from({ length: 7 }, (_unused, index) =>
					testItem({ link: `https://news.example.com/story-${index}` }),
				),
			),
			{ ...TEST_OPTIONS, maxItems: 3 },
		],
		[testFeed([]), TEST_OPTIONS],
		[testFeed([testItem()]), { ...TEST_OPTIONS, maxItems: 0 }],
	];
	for (const publishedText of [null, "", "yesterday-ish", "32 Foo 2026"])
		cases.push([testFeed([testItem({ publishedText })]), TEST_OPTIONS]);
	for (const title of [null, "", "   ", "<b></b>", "<script>alert(1)</script>"])
		cases.push([testFeed([testItem({ title })]), TEST_OPTIONS]);
	for (const link of [null, "", "   "]) cases.push([testFeed([testItem({ link })]), TEST_OPTIONS]);
	for (const link of [
		"http://news.example.com/a",
		"https://127.0.0.1/a",
		"https://169.254.169.254/latest/meta-data/",
		"https://[::ffff:127.0.0.1]/a",
		"https://localhost/a",
		"https://intranet.corp/a",
		"https://user:pw@news.example.com/a",
		"https://news.example.com:8443/a",
		"javascript:alert(1)",
		"/relative/path",
	]) {
		cases.push([testFeed([testItem({ link })]), TEST_OPTIONS]);
	}
	for (const summaryText of [null, "", "<p></p>"])
		cases.push([testFeed([testItem({ summaryText })]), TEST_OPTIONS]);
	return cases;
}

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
const paramValue = fc.string({ unit: "grapheme", maxLength: 8 });
const urlParts = fc.record({
	host: publicHost,
	segments: fc.array(pathSegment, { maxLength: 3 }),
	params: fc.array(fc.tuple(paramName, paramValue), { maxLength: 5 }),
});

/** `buildUrl` of news.property.test.ts (without extras). */
function buildUrl(parts: {
	host: string;
	segments: readonly string[];
	params: readonly (readonly [string, string])[];
}): string {
	const path = parts.segments.length === 0 ? "/" : `/${parts.segments.join("/")}`;
	const query = new URLSearchParams(parts.params.map(([name, value]) => [name, value])).toString();
	return `https://${parts.host}${path}${query === "" ? "" : `?${query}`}`;
}

/** The `rawItem` arbitrary of news.property.test.ts. */
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

function propertyFeeds(): [RawFeed, NormalizeFeedOptions][] {
	const arbitrary = fc.tuple(
		fc.array(rawItem, { maxLength: 12 }),
		fc.integer({ min: 0, max: 12 }),
		fc.constantFrom<LicensePolicy>("headline-and-link-only", "short-excerpt-permitted"),
	);
	return fc
		.sample(arbitrary, { seed: 20_261_011, numRuns: 300 })
		.map(([items, maxItems, licensePolicy]) => [
			{ kind: "atom", title: null, siteLink: null, items },
			{ publisher: "P", retrievedAt: "2026-10-11T00:00:00.000Z", licensePolicy, maxItems },
		]);
}

function fingerprintCases(
	random: () => number,
): Parameters<typeof articleFingerprintMaterial>[0][] {
	const base = {
		title: "Battery makers expand capacity",
		publisher: "Example Wire",
		publishedAt: "2026-10-10T12:00:00.000Z",
		summary: "Three suppliers announced new plants.",
		canonicalUrl: "https://news.example.com/a",
	};
	const cases: Parameters<typeof articleFingerprintMaterial>[0][] = [
		{
			title: "Chips & Tariffs: What's Next?",
			publisher: "Example Wire",
			publishedAt: "2026-10-10T12:00:00.000Z",
			summary: "Tariffs RISE, again!",
			canonicalUrl: "https://news.example.com/a",
		},
		base,
		{ ...base, canonicalUrl: "https://syndication.example.net/x" },
		{ ...base, summary: null },
		{ ...base, summary: null, canonicalUrl: "https://news.example.com/b" },
		{ ...base, summary: "Two suppliers closed plants." },
		{ ...base, title: "  BATTERY makers — expand   capacity!! " },
		{ ...base, title: "ＢＡＴＴＥＲＹ makers expand capacity" },
		{ ...base, publisher: "EXAMPLE WIRE", publishedAt: "2026-10-10T23:59:59.000Z" },
		{ ...base, title: "Battery makers cut capacity" },
		{ ...base, publisher: "Other Wire" },
		{ ...base, publishedAt: "2026-10-11T00:00:00.000Z" },
		{ ...base, publishedAt: null },
		{ ...base, title: "蓄電池メーカーが増産" },
		{ ...base, title: "半導体メーカーが増産" },
		{ ...base, summary: "" },
		{ ...base, summary: "!!!" },
		{ ...base, title: "", publisher: "" },
	];
	const pieces = [
		"Battery",
		"ＢＡＴＴＥＲＹ",
		"makers",
		"—",
		"!!",
		"  ",
		"　",
		"Ⅻ",
		"½",
		"ﬁ",
		"Σ",
		"ΑΣ",
		"İstanbul",
		"Straße",
		"ǅ",
		"①",
		"٣",
		"à",
		"à",
		"한국",
		"📈",
		"‍",
		"_",
		"-",
		"x2",
		"\u0085",
		"﻿",
		"Ꭰ",
		"ꭰ",
	];
	for (let index = 0; index < 1500; index += 1) {
		const text = (count: number) =>
			Array.from({ length: count }, () => pick(random, pieces)).join(pick(random, ["", " "]));
		cases.push({
			title: text(1 + Math.floor(random() * 6)),
			publisher: text(1 + Math.floor(random() * 2)),
			publishedAt: pick(random, [
				null,
				"2026-10-10T12:00:00.000Z",
				"+012345-01-01T00:00:00.000Z",
				"short",
			]),
			summary: chance(random, 0.3) ? null : text(Math.floor(random() * 8)),
			canonicalUrl: "https://news.example.com/a",
		});
	}
	return cases;
}

/** Runs `run` with the process zone set to `zone`, restoring it afterwards. */
function withTimeZone<T>(zone: string, run: () => T): T {
	const original = process.env.TZ;
	process.env.TZ = zone;
	try {
		return run();
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}
}

function parsedOrNull(text: string): unknown {
	const parsed = feedParser.parse(text);
	return parsed.ok ? encodeFeed(parsed.value) : null;
}

function treeOrNull(text: string): Encoded | null {
	try {
		return encodeTree(xmlParser.parse(text));
	} catch {
		return null;
	}
}

export const feedExporter: VectorExporter = {
	name: "feed",
	async build() {
		return withTimeZone("UTC", () => {
			const random = seededRandom(20_261_018);
			const documents = [
				...FIXTURES.map(fixture),
				FEED_XML,
				...PARSER_TEST_INPUTS,
				...Array.from({ length: 2600 }, () => randomFeed(random)),
			];
			const parse = documents
				.filter(isWellFormed)
				.map((input) => ({ input, output: parsedOrNull(input) }));
			const snippets = [
				...new Set([
					...PARSER_TEST_INPUTS.filter((text) => text.length < 400),
					...Array.from({ length: 5000 }, () => randomSnippet(random)),
				]),
			].filter(isWellFormed);
			const tree = snippets.map((input) => ({
				input,
				valid: XMLValidator.validate(input) === true,
				tree: treeOrNull(input),
			}));
			const plainText = plainTextInputs(random).map((input) => [
				input,
				wellFormed(toPlainText(input)),
			]);
			const fingerprint = fingerprintCases(random).map((input) => ({
				input,
				output: wellFormed(articleFingerprintMaterial(input)),
			}));
			const timestamps = timestampInputs(random).map((input) => [input, parseFeedTimestamp(input)]);
			const feeds: [RawFeed, NormalizeFeedOptions][] = [...testFeeds(), ...propertyFeeds()];
			for (const [index, document] of documents.filter(isWellFormed).entries()) {
				const parsed = feedParser.parse(document);
				if (!parsed.ok) continue;
				const licensePolicy: LicensePolicy =
					index % 2 === 0 ? "short-excerpt-permitted" : "headline-and-link-only";
				feeds.push([
					wellFormedFeed(parsed.value),
					{
						publisher: "Synthetic Wire",
						retrievedAt: RETRIEVED_AT,
						licensePolicy,
						maxItems: index % 7 === 0 ? 2 : 100,
					},
				]);
			}
			const normalize = feeds.map(([feed, options]) => ({
				feed: encodeFeed(feed),
				options,
				output: encodeNormalized(feed, options),
			}));
			return [
				{ path: "feed/parse.json", content: parse },
				{ path: "feed/tree.json", content: tree },
				{ path: "feed/plain-text.json", content: plainText },
				{ path: "feed/fingerprint.json", content: fingerprint },
				{ path: "feed/timestamps.json", content: timestamps },
				{ path: "feed/normalize.json", content: normalize },
			];
		});
	},
};
