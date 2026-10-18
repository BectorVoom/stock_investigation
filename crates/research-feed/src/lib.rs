//! RSS 2.0 / RSS 1.0 (RDF) / Atom parser behind the `FeedParser` port — a
//! port of `packages/adapters/src/feed/index.ts` and the parts of
//! fast-xml-parser 5.11.2 it relies on (ADR-0030).
//!
//! The input is hostile until proven otherwise (SEC-001), so:
//!  - input larger than [`MAX_FEED_BYTES`] is rejected before any parsing;
//!  - entity processing is OFF, so DOCTYPE-declared entities are never
//!    expanded (billion laughs) and external entities are refused (XXE);
//!  - nesting depth is capped by the parser ([`tree::MAX_NESTED_TAGS`]);
//!  - every failure, including what would be a parser throw, is `NOT_A_FEED`.
//!
//! Output is raw text only. All sanitizing, URL policy and license handling
//! is the domain's `normalize_feed`.
//!
//! Parity: the validator ([`validator`]), the tree builder ([`tree`]) and the
//! text helpers ([`xml_tree`]) reproduce the library's acceptance set, its
//! text concatenation (trimmed pieces joined without a separator) and its
//! `Object.entries` key order; `vectors/feed/*.json` pin them against the
//! TypeScript.

pub mod info_table;
mod names;
pub mod tree;
mod units;
pub mod validator;
mod xml_scan;
pub mod xml_tree;

use research_application::ports::{FeedParser, NotAFeed};
use research_domain::news::raw_feed::{FeedKind, RawFeed, RawFeedItem};
use research_js::{utf16, whitespace};
use tree::Object;
use xml_tree::{as_node, attribute_of, children_of, first_child_of, first_node_of, text_of};

/// Largest feed accepted, in UTF-8 bytes of the decoded text.
pub const MAX_FEED_BYTES: usize = 2_000_000;

const MAX_TITLE_CHARS: usize = 2_000;
const MAX_LINK_CHARS: usize = 4_096;
const MAX_DATE_CHARS: usize = 100;
const MAX_SUMMARY_CHARS: usize = 20_000;

/// Atom elements are accepted bare (default namespace) or with the
/// conventional prefix.
const ATOM_TITLE: [&str; 2] = ["title", "atom:title"];
const ATOM_LINK: [&str; 2] = ["link", "atom:link"];
const ATOM_ENTRY: [&str; 2] = ["entry", "atom:entry"];
const ATOM_ID: [&str; 2] = ["id", "atom:id"];
const ATOM_FEED: [&str; 2] = ["feed", "atom:feed"];
const ATOM_DATES: [&str; 4] = ["published", "atom:published", "updated", "atom:updated"];
const ATOM_SUMMARIES: [&str; 4] = ["summary", "atom:summary", "content", "atom:content"];

/// The fast-xml-parser-compatible feed parser (`createFeedParser`).
#[derive(Clone, Copy, Debug, Default)]
pub struct FastXmlFeedParser;

impl FeedParser for FastXmlFeedParser {
	fn parse(&self, text: &str) -> Result<RawFeed, NotAFeed> {
		parse_feed(text).ok_or(NotAFeed)
	}
}

/// `createFeedParser().parse(text)`; `None` is `NOT_A_FEED`.
#[must_use]
pub fn parse_feed(text: &str) -> Option<RawFeed> {
	// UTF-8 never uses fewer bytes than UTF-16 code units, so the TypeScript's
	// two checks (UTF-16 length, then UTF-8 bytes) are this one.
	if text.len() > MAX_FEED_BYTES {
		return None;
	}
	let units: Vec<u16> = text.encode_utf16().collect();
	// Well-formedness first: HTML pages and truncated documents stop here.
	if !validator::is_valid_xml(&units) {
		return None;
	}
	// The parser throws on excessive nesting, reserved names and bad DOCTYPEs.
	let document = tree::parse(&units).ok()?;
	to_raw_feed(&document)
}

/// `boundedLink`: trimmed; empty or longer than 4,096 units → `None`.
fn bounded_link(value: Option<String>) -> Option<String> {
	let value = value?;
	let link = whitespace::trim(&value);
	if link.is_empty() || utf16::utf16_len(link) > MAX_LINK_CHARS {
		None
	} else {
		Some(link.to_owned())
	}
}

/// `atomAlternateLink`: the first `link`/`atom:link` element (bare ones
/// first) whose `rel` is absent or `alternate` and that has an `href`.
fn atom_alternate_link(node: &Object) -> Option<String> {
	// RFC 4287: a link without `rel` is an "alternate" link.
	let alternate = children_of(node, &ATOM_LINK)
		.filter_map(as_node)
		.find(|link| {
			let rel = attribute_of(link, "rel");
			(rel.is_none() || rel.as_deref() == Some("alternate"))
				&& attribute_of(link, "href").is_some()
		})?;
	bounded_link(attribute_of(alternate, "href"))
}

/// `/^https?:\/\//i`.
fn is_http_url(link: &str) -> bool {
	let bytes = link.as_bytes();
	let scheme = |text: &[u8]| {
		bytes.len() >= text.len()
			&& bytes
				.iter()
				.zip(text)
				.all(|(byte, expected)| byte.to_ascii_lowercase() == *expected)
	};
	scheme(b"http://") || scheme(b"https://")
}

fn rss_link(node: &Object) -> Option<String> {
	let direct = bounded_link(text_of(first_child_of(node, &["link"]), MAX_LINK_CHARS));
	if direct.is_some() {
		return direct;
	}
	// RSS 2.0: a guid is a permalink unless it says otherwise.
	let guid = first_child_of(node, &["guid"]);
	let guid_is_permalink = guid
		.and_then(as_node)
		.is_none_or(|guid| attribute_of(guid, "isPermaLink").as_deref() != Some("false"));
	let guid_link = if guid_is_permalink {
		bounded_link(text_of(guid, MAX_LINK_CHARS))
	} else {
		None
	};
	if let Some(link) = guid_link.filter(|link| is_http_url(link)) {
		return Some(link);
	}
	atom_alternate_link(node)
}

fn first_text(node: &Object, names: &[&str], max_length: usize) -> Option<String> {
	names
		.iter()
		.find_map(|name| text_of(first_child_of(node, &[name]), max_length))
}

fn rss_item(node: &Object) -> RawFeedItem {
	RawFeedItem {
		title: first_text(node, &["title"], MAX_TITLE_CHARS),
		link: rss_link(node),
		published_text: first_text(node, &["pubDate", "dc:date"], MAX_DATE_CHARS),
		// The description is the publisher's own summary; full content is only a fallback.
		summary_text: first_text(node, &["description", "content:encoded"], MAX_SUMMARY_CHARS),
	}
}

fn atom_entry(node: &Object) -> RawFeedItem {
	RawFeedItem {
		title: first_text(node, &ATOM_TITLE, MAX_TITLE_CHARS),
		link: atom_alternate_link(node),
		published_text: first_text(node, &ATOM_DATES, MAX_DATE_CHARS),
		summary_text: first_text(node, &ATOM_SUMMARIES, MAX_SUMMARY_CHARS),
	}
}

fn rss_feed(channel: &Object, item_parent: &Object) -> RawFeed {
	RawFeed {
		kind: FeedKind::Rss,
		title: first_text(channel, &["title"], MAX_TITLE_CHARS),
		site_link: bounded_link(text_of(first_child_of(channel, &["link"]), MAX_LINK_CHARS)),
		items: children_of(item_parent, &["item"])
			.filter_map(as_node)
			.map(rss_item)
			.collect(),
	}
}

fn atom_feed(feed: &Object) -> RawFeed {
	RawFeed {
		kind: FeedKind::Atom,
		title: first_text(feed, &ATOM_TITLE, MAX_TITLE_CHARS),
		site_link: atom_alternate_link(feed),
		items: children_of(feed, &ATOM_ENTRY)
			.filter_map(as_node)
			.map(atom_entry)
			.collect(),
	}
}

fn looks_like_atom_feed(feed: &Object) -> bool {
	first_child_of(feed, &ATOM_TITLE).is_some()
		|| first_child_of(feed, &ATOM_ENTRY).is_some()
		|| first_child_of(feed, &ATOM_ID).is_some()
}

fn to_raw_feed(document: &Object) -> Option<RawFeed> {
	if let Some(rss) = first_node_of(document, &["rss"]) {
		let channel = first_node_of(rss, &["channel"])?;
		return Some(rss_feed(channel, channel));
	}
	// RSS 1.0: items are siblings of the channel under the RDF root.
	if let Some(rdf) = first_node_of(document, &["rdf:RDF"]) {
		let channel = first_node_of(rdf, &["channel"])?;
		return Some(rss_feed(channel, rdf));
	}
	let feed = first_node_of(document, &ATOM_FEED)?;
	looks_like_atom_feed(feed).then(|| atom_feed(feed))
}
