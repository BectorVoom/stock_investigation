//! Replays `vectors/feed/{parse,tree}.json` (written by Node from the
//! TypeScript feed parser and fast-xml-parser itself:
//! `node scripts/vectors/index.ts feed`), plus the feed parser's own
//! TypeScript tests that need inputs too large to commit.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use rayon::prelude::*;
use research_domain::news::raw_feed::RawFeed;
use research_feed::tree::{self, Object, Value};
use research_feed::{MAX_FEED_BYTES, parse_feed, validator};
use serde::Deserialize;
use serde_json::{Value as Json, json};

fn vector_file(name: &str) -> String {
	let path = format!("{}/../../vectors/feed/{name}", env!("CARGO_MANIFEST_DIR"));
	std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn feed_json(feed: &RawFeed) -> Json {
	json!({
		"kind": feed.kind.as_str(),
		"title": feed.title,
		"siteLink": feed.site_link,
		"items": feed.items.iter().map(|item| json!({
			"title": item.title,
			"link": item.link,
			"publishedText": item.published_text,
			"summaryText": item.summary_text,
		})).collect::<Vec<_>>(),
	})
}

fn tree_json(value: &Value) -> Json {
	match value {
		Value::Text(text) => Json::String(text.clone()),
		Value::Object(object) => object_json(object),
		Value::Array(values) => json!({ "a": values.iter().map(tree_json).collect::<Vec<_>>() }),
	}
}

fn object_json(object: &Object) -> Json {
	json!({ "o": object.iter().map(|(key, value)| json!([key, tree_json(value)])).collect::<Vec<_>>() })
}

fn report(failures: &[String]) {
	assert!(
		failures.is_empty(),
		"{} mismatches, first: {:#?}",
		failures.len(),
		failures.iter().take(10).collect::<Vec<_>>()
	);
}

fn shorten(text: &str) -> String {
	if text.len() <= 300 {
		return text.to_owned();
	}
	let mut end = 300;
	while !text.is_char_boundary(end) {
		end -= 1;
	}
	format!("{}…", &text[..end])
}

#[derive(Deserialize)]
struct ParseCase {
	input: String,
	output: Json,
}

#[test]
fn feed_parser_matches_typescript() {
	let cases: Vec<ParseCase> = serde_json::from_str(&vector_file("parse.json")).unwrap();
	assert!(cases.len() > 2000);
	let failures: Vec<String> = cases
		.par_iter()
		.filter_map(|case| {
			let got = parse_feed(&case.input).map_or(Json::Null, |feed| feed_json(&feed));
			(got != case.output).then(|| {
				format!(
					"{:?}\n got {}\nwant {}",
					shorten(&case.input),
					shorten(&got.to_string()),
					shorten(&case.output.to_string())
				)
			})
		})
		.collect();
	report(&failures);
}

#[derive(Deserialize)]
struct TreeCase {
	input: String,
	valid: bool,
	tree: Json,
}

#[test]
fn validator_and_tree_match_fast_xml_parser() {
	let cases: Vec<TreeCase> = serde_json::from_str(&vector_file("tree.json")).unwrap();
	assert!(cases.len() > 3000);
	let failures: Vec<String> = cases
		.par_iter()
		.filter_map(|case| {
			let units: Vec<u16> = case.input.encode_utf16().collect();
			let valid = validator::is_valid_xml(&units);
			let tree = tree::parse(&units).map_or(Json::Null, |object| object_json(&object));
			(valid != case.valid || tree != case.tree).then(|| {
				format!(
					"{:?}: valid {valid} want {}\n got {}\nwant {}",
					case.input,
					case.valid,
					shorten(&tree.to_string()),
					shorten(&case.tree.to_string())
				)
			})
		})
		.collect();
	report(&failures);
}

/* ---------- feedParser.test.ts cases whose inputs are generated here ---------- */

#[test]
fn rejects_deeply_nested_junk_quickly() {
	let depth = 50_000;
	let junk = format!("{}x{}", "<a>".repeat(depth), "</a>".repeat(depth));
	let started = std::time::Instant::now();
	assert!(parse_feed(&junk).is_none());
	let wrapped =
		format!("<rss><channel><title>t</title><item><title>{junk}</title></item></channel></rss>");
	assert!(parse_feed(&wrapped).is_none());
	assert!(started.elapsed().as_millis() < 2000);
}

#[test]
fn rejects_input_above_the_size_limit_before_parsing() {
	let item = "<item><title>t</title><link>https://a.synthetic-wire.org/x</link></item>";
	let oversized = format!(
		"<rss><channel><title>t</title>{}</channel></rss>",
		item.repeat(MAX_FEED_BYTES / item.len() + 2)
	);
	assert!(oversized.len() > MAX_FEED_BYTES);
	assert!(parse_feed(&oversized).is_none());
	// Multi-byte text: under the limit in UTF-16 units, over it in bytes.
	let multibyte = format!(
		"<rss><channel><title>{}</title></channel></rss>",
		"経".repeat(700_000)
	);
	assert!(multibyte.encode_utf16().count() < MAX_FEED_BYTES);
	assert!(parse_feed(&multibyte).is_none());
}

#[test]
fn bounds_oversized_fields() {
	let feed = parse_feed(&format!(
		"<rss><channel><title>t</title><item><title>{}</title><link>https://a.synthetic-wire.org/x</link><description>{}</description></item></channel></rss>",
		"T".repeat(10_000),
		"word ".repeat(50_000)
	))
	.unwrap();
	let item = &feed.items[0];
	assert_eq!(item.title.as_deref().map(str::len), Some(2_000));
	assert!(item.summary_text.as_deref().unwrap().len() <= 20_000);
}

/// The twin of the TypeScript "treats an overlong link as absent" test.
#[test]
fn treats_an_overlong_link_as_absent_and_falls_back() {
	let long = format!("https://a.synthetic-wire.org/{}", "p".repeat(4_096));
	let at_limit = format!("https://a.synthetic-wire.org/{}", "q".repeat(4_096 - 29));
	assert_eq!(at_limit.len(), 4_096);
	let feed = parse_feed(&format!(
		"<rss xmlns:atom=\"http://www.w3.org/2005/Atom\"><channel><title>t</title><link>{long}</link>\
		<item><title>a</title><link>{long}</link><guid>https://a.synthetic-wire.org/guid</guid></item>\
		<item><title>b</title><link>{long}</link><guid>{long}</guid><atom:link href=\"https://a.synthetic-wire.org/atom\"/></item>\
		<item><title>c</title><link><![CDATA[{long}]]></link></item>\
		<item><title>d</title><link>{at_limit}</link></item></channel></rss>"
	))
	.unwrap();
	assert_eq!(feed.site_link, None);
	let links: Vec<_> = feed.items.iter().map(|item| item.link.clone()).collect();
	assert_eq!(
		links,
		[
			Some("https://a.synthetic-wire.org/guid".to_owned()),
			Some("https://a.synthetic-wire.org/atom".to_owned()),
			None,
			Some(at_limit),
		]
	);
}

/// The twin of the TypeScript "first Atom alternate link whose href is usable" test.
#[test]
fn takes_the_first_usable_atom_alternate_link() {
	let long = format!("https://a.synthetic-wire.org/{}", "p".repeat(4_096));
	let feed = parse_feed(&format!(
		"<feed xmlns=\"http://www.w3.org/2005/Atom\"><title>t</title>\
		<link href=\"{long}\"/><link rel=\"alternate\" href=\"https://a.synthetic-wire.org/\"/>\
		<entry><title>e</title><link href=\"  \"/><link rel=\"self\" href=\"https://a.synthetic-wire.org/self\"/>\
		<link rel=\"alternate\" href=\"{long}\"/><link href=\"https://a.synthetic-wire.org/e\"/></entry>\
		<entry><title>f</title><link href=\"{long}\"/></entry></feed>"
	))
	.unwrap();
	assert_eq!(
		feed.site_link.as_deref(),
		Some("https://a.synthetic-wire.org/")
	);
	let links: Vec<_> = feed.items.iter().map(|item| item.link.as_deref()).collect();
	assert_eq!(links, [Some("https://a.synthetic-wire.org/e"), None]);
}

/// The twin of the TypeScript "skips an Atom alternate link the article URL policy refuses" test.
#[test]
fn skips_an_atom_alternate_link_the_url_policy_refuses() {
	let feed = parse_feed(
		"<feed xmlns=\"http://www.w3.org/2005/Atom\"><title>t</title>\
		<link href=\"http://a.synthetic-wire.org/\"/><link href=\"https://a.synthetic-wire.org/\"/>\
		<entry><title>e</title><link href=\"javascript:alert(1)\"/><link rel=\"alternate\" href=\"https://10.0.0.1/x\"/>\
		<link href=\"https://a.synthetic-wire.org/e\"/></entry>\
		<entry><title>f</title><link href=\"javascript:bad\"/></entry></feed>",
	)
	.unwrap();
	assert_eq!(
		feed.site_link.as_deref(),
		Some("https://a.synthetic-wire.org/")
	);
	let links: Vec<_> = feed.items.iter().map(|item| item.link.as_deref()).collect();
	assert_eq!(links, [Some("https://a.synthetic-wire.org/e"), None]);
}

#[test]
fn never_expands_doctype_entities() {
	let billion_laughs = std::fs::read_to_string(format!(
		"{}/../../examples/fixtures/feeds/billion-laughs-synthetic.xml",
		env!("CARGO_MANIFEST_DIR")
	))
	.unwrap();
	let started = std::time::Instant::now();
	let feed = parse_feed(&billion_laughs).unwrap();
	assert!(started.elapsed().as_millis() < 1000);
	assert_eq!(feed.title.as_deref(), Some("&lol9;"));
}
