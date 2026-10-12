/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom parser behind the `FeedParser` port.
 *
 * Runtime-neutral (Worker and Node): only fast-xml-parser and web-standard
 * globals. The input is hostile until proven otherwise (SEC-001), so:
 *  - input larger than `MAX_FEED_BYTES` is rejected before any parsing;
 *  - entity processing is OFF, so DOCTYPE-declared entities are never expanded
 *    (billion laughs) and external entities are never resolved (XXE);
 *  - nesting depth is capped by the parser;
 *  - every failure, including a parser throw, becomes `NOT_A_FEED`.
 * Output is raw text only. All sanitizing, URL policy and license handling is
 * the domain's `normalizeFeed`.
 */
import type { FeedParser } from "@research/application";
import { err, ok, type RawFeed, type RawFeedItem, type Result } from "@research/domain";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
	ATTRIBUTE_PREFIX,
	attributeOf,
	CDATA_KEY,
	childrenOf,
	firstChildOf,
	firstNodeOf,
	isXmlNode,
	TEXT_KEY,
	textOf,
	type XmlNode,
} from "./xmlTree.ts";

export const MAX_FEED_BYTES = 2_000_000;
/** Deepest legitimate feeds (XHTML content inside Atom) stay far below this. */
export const MAX_FEED_NESTING = 64;

const MAX_TITLE_CHARS = 2_000;
const MAX_LINK_CHARS = 4_096;
const MAX_DATE_CHARS = 100;
const MAX_SUMMARY_CHARS = 20_000;

/** Atom elements are accepted bare (default namespace) or with the conventional prefix. */
function atom(name: string): readonly string[] {
	return [name, `atom:${name}`];
}

/** `value` is already entity-decoded by `textOf` / `attributeOf`. */
function boundedLink(value: string | null): string | null {
	if (value === null) return null;
	const link = value.trim();
	return link === "" || link.length > MAX_LINK_CHARS ? null : link;
}

function atomAlternateLink(node: XmlNode): string | null {
	const links = childrenOf(node, atom("link")).filter(isXmlNode);
	// RFC 4287: a link without `rel` is an "alternate" link.
	const alternate = links.find((link) => {
		const rel = attributeOf(link, "rel");
		return (rel === null || rel === "alternate") && attributeOf(link, "href") !== null;
	});
	return alternate === undefined ? null : boundedLink(attributeOf(alternate, "href"));
}

function rssLink(node: XmlNode): string | null {
	const direct = boundedLink(textOf(firstChildOf(node, ["link"]), MAX_LINK_CHARS));
	if (direct !== null) return direct;
	// RSS 2.0: a guid is a permalink unless it says otherwise.
	const guid = firstChildOf(node, ["guid"]);
	const guidIsPermalink = !isXmlNode(guid) || attributeOf(guid, "isPermaLink") !== "false";
	const guidLink = guidIsPermalink ? boundedLink(textOf(guid, MAX_LINK_CHARS)) : null;
	if (guidLink !== null && /^https?:\/\//i.test(guidLink)) return guidLink;
	return atomAlternateLink(node);
}

function firstText(node: XmlNode, names: readonly string[], maxLength: number): string | null {
	for (const name of names) {
		const text = textOf(firstChildOf(node, [name]), maxLength);
		if (text !== null) return text;
	}
	return null;
}

function rssItem(node: XmlNode): RawFeedItem {
	return {
		title: firstText(node, ["title"], MAX_TITLE_CHARS),
		link: rssLink(node),
		publishedText: firstText(node, ["pubDate", "dc:date"], MAX_DATE_CHARS),
		// The description is the publisher's own summary; full content is only a fallback.
		summaryText: firstText(node, ["description", "content:encoded"], MAX_SUMMARY_CHARS),
	};
}

function atomEntry(node: XmlNode): RawFeedItem {
	return {
		title: firstText(node, atom("title"), MAX_TITLE_CHARS),
		link: atomAlternateLink(node),
		publishedText: firstText(node, [...atom("published"), ...atom("updated")], MAX_DATE_CHARS),
		summaryText: firstText(node, [...atom("summary"), ...atom("content")], MAX_SUMMARY_CHARS),
	};
}

function rssFeed(channel: XmlNode, itemParent: XmlNode): RawFeed {
	return {
		kind: "rss",
		title: firstText(channel, ["title"], MAX_TITLE_CHARS),
		siteLink: boundedLink(textOf(firstChildOf(channel, ["link"]), MAX_LINK_CHARS)),
		items: childrenOf(itemParent, ["item"]).filter(isXmlNode).map(rssItem),
	};
}

function atomFeed(feed: XmlNode): RawFeed {
	return {
		kind: "atom",
		title: firstText(feed, atom("title"), MAX_TITLE_CHARS),
		siteLink: atomAlternateLink(feed),
		items: childrenOf(feed, atom("entry")).filter(isXmlNode).map(atomEntry),
	};
}

function looksLikeAtomFeed(feed: XmlNode): boolean {
	return (
		firstChildOf(feed, atom("title")) !== undefined ||
		firstChildOf(feed, atom("entry")) !== undefined ||
		firstChildOf(feed, atom("id")) !== undefined
	);
}

function toRawFeed(document: unknown): RawFeed | null {
	if (!isXmlNode(document)) return null;
	const rss = firstNodeOf(document, ["rss"]);
	if (rss !== null) {
		const channel = firstNodeOf(rss, ["channel"]);
		return channel === null ? null : rssFeed(channel, channel);
	}
	// RSS 1.0: items are siblings of the channel under the RDF root.
	const rdf = firstNodeOf(document, ["rdf:RDF"]);
	if (rdf !== null) {
		const channel = firstNodeOf(rdf, ["channel"]);
		return channel === null ? null : rssFeed(channel, rdf);
	}
	const feed = firstNodeOf(document, atom("feed"));
	if (feed !== null && looksLikeAtomFeed(feed)) return atomFeed(feed);
	return null;
}

function exceedsByteLimit(text: string): boolean {
	// UTF-8 never uses fewer bytes than UTF-16 code units, so this is a cheap early exit.
	if (text.length > MAX_FEED_BYTES) return true;
	return new TextEncoder().encode(text).byteLength > MAX_FEED_BYTES;
}

export function createFeedParser(): FeedParser {
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: ATTRIBUTE_PREFIX,
		textNodeName: TEXT_KEY,
		// Kept separate from ordinary text so CDATA is not entity-decoded a second time.
		cdataPropName: CDATA_KEY,
		// No DTD/entity expansion of any kind; see `decodeXmlText` for the five predefined ones.
		processEntities: false,
		htmlEntities: false,
		// Keep every value a string: "007" and "1e3" are text, not numbers.
		parseTagValue: false,
		parseAttributeValue: false,
		allowBooleanAttributes: false,
		trimValues: true,
		ignoreDeclaration: true,
		ignorePiTags: true,
		removeNSPrefix: false,
		maxNestedTags: MAX_FEED_NESTING,
	});
	return {
		parse(text: string): Result<RawFeed, "NOT_A_FEED"> {
			if (exceedsByteLimit(text)) return err("NOT_A_FEED");
			try {
				// Well-formedness first: HTML pages and truncated documents stop here.
				if (XMLValidator.validate(text) !== true) return err("NOT_A_FEED");
				const document: unknown = parser.parse(text);
				const feed = toRawFeed(document);
				return feed === null ? err("NOT_A_FEED") : ok(feed);
			} catch {
				// The parser throws on external entities, excessive nesting and reserved names.
				// All of those mean "this is not a feed we will process".
				return err("NOT_A_FEED");
			}
		},
	};
}
