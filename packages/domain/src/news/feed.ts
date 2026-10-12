import { isoToEpochMs } from "../time.ts";
import { canonicalizeArticleUrl } from "./canonicalUrl.ts";
import type { UrlPolicyError } from "./urlPolicy.ts";

/** What may be retained from a publisher's content (DATA-010). */
export type LicensePolicy = "headline-and-link-only" | "short-excerpt-permitted";

/** Adapter-neutral shape produced by a feed parser; every field is untrusted text. */
export interface RawFeedItem {
	readonly title: string | null;
	readonly link: string | null;
	readonly publishedText: string | null;
	readonly summaryText: string | null;
}

export interface RawFeed {
	readonly kind: "rss" | "atom";
	readonly title: string | null;
	readonly siteLink: string | null;
	readonly items: readonly RawFeedItem[];
}

export interface ArticleCandidate {
	readonly canonicalUrl: string;
	readonly title: string;
	readonly publisher: string;
	/** null when the feed gave no parseable date; never back-filled with the retrieval time. */
	readonly publishedAt: string | null;
	readonly retrievedAt: string;
	readonly excerpt: string | null;
	readonly fingerprintMaterial: string;
}

export type FeedItemRejection =
	| { readonly reason: "MISSING_TITLE" | "MISSING_LINK"; readonly index: number }
	| { readonly reason: "UNSAFE_LINK"; readonly index: number; readonly detail: UrlPolicyError };

export interface NormalizedFeed {
	readonly articles: readonly ArticleCandidate[];
	readonly rejected: readonly FeedItemRejection[];
	/** Items beyond `maxItems` that were not examined. */
	readonly truncatedItemCount: number;
}

export const MAX_TITLE_LENGTH = 300;
export const MAX_EXCERPT_LENGTH = 500;

/** Names of U+00A0..U+00FF in code-point order (the HTML Latin-1 entity set). */
const LATIN1_ENTITY_NAMES =
	"nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
		" ",
	);

/**
 * The entities that occur in news prose: markup escapes, Latin-1, and common
 * typography. This is deliberately not the full HTML table (2,231 names); an
 * unknown name is left exactly as written rather than guessed. A Map, not an
 * object, so that "&constructor;" cannot reach Object.prototype.
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
	...LATIN1_ENTITY_NAMES.map((name, offset): [string, string] => [
		name,
		String.fromCodePoint(0xa0 + offset),
	]),
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["quot", '"'],
	["apos", "'"],
	// Spaces collapse to one ordinary space; invisible joiners and soft hyphens vanish, so a
	// quoted passage still matches the text a reader sees.
	["nbsp", " "],
	["ensp", " "],
	["emsp", " "],
	["thinsp", " "],
	["shy", ""],
	["zwnj", ""],
	["zwj", ""],
	["lrm", ""],
	["rlm", ""],
	["ndash", "\u2013"],
	["mdash", "\u2014"],
	["lsquo", "\u2018"],
	["rsquo", "\u2019"],
	["sbquo", "\u201a"],
	["ldquo", "\u201c"],
	["rdquo", "\u201d"],
	["bdquo", "\u201e"],
	["dagger", "\u2020"],
	["Dagger", "\u2021"],
	["bull", "\u2022"],
	["hellip", "\u2026"],
	["permil", "\u2030"],
	["prime", "\u2032"],
	["Prime", "\u2033"],
	["lsaquo", "\u2039"],
	["rsaquo", "\u203a"],
	["euro", "\u20ac"],
	["trade", "\u2122"],
	["larr", "\u2190"],
	["uarr", "\u2191"],
	["rarr", "\u2192"],
	["darr", "\u2193"],
	["minus", "\u2212"],
	["asymp", "\u2248"],
	["ne", "\u2260"],
	["le", "\u2264"],
	["ge", "\u2265"],
	["OElig", "\u0152"],
	["oelig", "\u0153"],
	["Scaron", "\u0160"],
	["scaron", "\u0161"],
	["Yuml", "\u0178"],
]);

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
		if (body.startsWith("#")) {
			const isHex = body[1]?.toLowerCase() === "x";
			const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
			return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: "";
		}
		// Names are case-sensitive (&Eacute; is not &eacute;); the lower-case retry only
		// tolerates shouted markup escapes such as "&AMP;".
		return NAMED_ENTITIES.get(body) ?? NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
	});
}

/**
 * Phrasing tags that sit inside a sentence. Removing them must not insert a space, or
 * "<a>Review</a>, down" becomes "Review , down" and "CO<sub>2</sub>" becomes "CO 2".
 */
const INLINE_TAG = /<\/?(?:a|abbr|b|cite|em|i|mark|small|strong|sub|sup|u)(?:\s[^>]*)?>/gi;

/**
 * Reduces untrusted feed markup to plain text. The result is only ever rendered
 * as a text node, so this is about readability, not about making HTML safe.
 */
export function toPlainText(markup: string): string {
	const withoutBlocks = markup.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
	const withoutTags = decodeEntities(
		withoutBlocks.replace(INLINE_TAG, "").replace(/<[^>]*>/g, " "),
	);
	// Decoding can reveal a second layer of tags (e.g. "&lt;b&gt;"); strip those too.
	return withoutTags
		.replace(INLINE_TAG, "")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Cuts on a code-point boundary so the result never exceeds `maxLength` UTF-16 code units. */
function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	let kept = "";
	for (const codePoint of text) {
		if (kept.length + codePoint.length > maxLength - 1) break;
		kept += codePoint;
	}
	return `${kept}…`;
}

/**
 * Text hashed into the stable content fingerprint. When the feed supplies a
 * summary, identity is the content itself (publisher, day, headline, summary),
 * so the same story syndicated under two links collapses to one. When there is
 * no summary, a headline alone is too weak to call two links the same article
 * — a publisher reuses headlines such as "Market wrap" for different updates —
 * so the canonical URL becomes part of the identity instead.
 */
export function articleFingerprintMaterial(input: {
	readonly title: string;
	readonly publisher: string;
	readonly publishedAt: string | null;
	readonly summary: string | null;
	readonly canonicalUrl: string;
}): string {
	const normalize = (text: string) =>
		text
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	const day = input.publishedAt === null ? "undated" : input.publishedAt.slice(0, 10);
	const summary = input.summary === null ? "" : normalize(input.summary);
	const body = summary === "" ? `url:${input.canonicalUrl}` : `summary:${summary}`;
	return `${input.publisher.toLowerCase()}\n${day}\n${normalize(input.title)}\n${body}`;
}

const ISO_DATE_TIME =
	/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const RFC_822_DATE_TIME =
	/^(?:[A-Za-z]{3},\s*)?(\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?)\s*(GMT|UTC|UT|Z|[ECMP][SD]T|[+-]\d{4})?$/i;

/**
 * Parses a feed timestamp into a UTC ISO instant. Only ISO 8601 and RFC 822
 * shapes are accepted, and a timestamp without a zone is read as UTC — never in
 * the machine's local zone — so the Worker and the runner agree (ARCH-011).
 */
export function parseFeedTimestamp(text: string | null): string | null {
	if (text === null) return null;
	const trimmed = text.trim();
	const iso = ISO_DATE_TIME.exec(trimmed);
	let candidate: string | null = null;
	if (iso !== null) {
		const [, date = "", time, zone] = iso;
		candidate = time === undefined ? date : `${date}T${time}${zone ?? "Z"}`;
	} else {
		const rfc = RFC_822_DATE_TIME.exec(trimmed);
		if (rfc !== null) candidate = `${rfc[1]} ${rfc[2] ?? "UTC"}`;
	}
	if (candidate === null) return null;
	const ms = isoToEpochMs(candidate);
	return ms === null ? null : new Date(ms).toISOString();
}

export interface NormalizeFeedOptions {
	readonly publisher: string;
	readonly retrievedAt: string;
	readonly licensePolicy: LicensePolicy;
	readonly maxItems: number;
}

/** Pure normalization of parsed feed items into article candidates, deduplicated within the feed. */
export function normalizeFeed(feed: RawFeed, options: NormalizeFeedOptions): NormalizedFeed {
	const articles: ArticleCandidate[] = [];
	const rejected: FeedItemRejection[] = [];
	const seenUrls = new Set<string>();
	const examined = feed.items.slice(0, options.maxItems);
	examined.forEach((item, index) => {
		const title = item.title === null ? "" : toPlainText(item.title);
		if (title === "") {
			rejected.push({ reason: "MISSING_TITLE", index });
			return;
		}
		if (item.link === null || item.link.trim() === "") {
			rejected.push({ reason: "MISSING_LINK", index });
			return;
		}
		const canonical = canonicalizeArticleUrl(item.link.trim());
		if (!canonical.ok) {
			rejected.push({ reason: "UNSAFE_LINK", index, detail: canonical.error });
			return;
		}
		if (seenUrls.has(canonical.value)) return;
		seenUrls.add(canonical.value);
		const publishedAt = parseFeedTimestamp(item.publishedText);
		const boundedTitle = truncate(title, MAX_TITLE_LENGTH);
		const summary = item.summaryText === null ? "" : toPlainText(item.summaryText);
		const excerpt =
			options.licensePolicy === "short-excerpt-permitted" && summary !== ""
				? truncate(summary, MAX_EXCERPT_LENGTH)
				: null;
		articles.push({
			canonicalUrl: canonical.value,
			title: boundedTitle,
			publisher: options.publisher,
			publishedAt,
			retrievedAt: options.retrievedAt,
			excerpt,
			fingerprintMaterial: articleFingerprintMaterial({
				title: boundedTitle,
				publisher: options.publisher,
				publishedAt,
				// The full summary identifies the content even when licensing forbids storing it.
				summary: summary === "" ? null : summary,
				canonicalUrl: canonical.value,
			}),
		});
	});
	return {
		articles,
		rejected,
		truncatedItemCount: Math.max(0, feed.items.length - examined.length),
	};
}
