//! Replays `vectors/html/*.json` (written by Node from the real
//! htmlparser2 12.0.0, entities 8.1.0 and `htmlToMarkdown.ts`:
//! `node scripts/vectors/index.ts html`). Conversions replay through
//! `convert_many`, i.e. on the rayon pool.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use rayon::prelude::*;
use research_html::parser::{self, Attributes, Handler, Tag};
use research_html::{MarkdownPage, Options, convert_many};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn vector_file(name: &str) -> String {
	let path = format!("{}/../../vectors/html/{name}", env!("CARGO_MANIFEST_DIR"));
	std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

/// Records events in the exporter's encoding (`scripts/vectors/html/events.ts`).
#[derive(Default)]
struct Recorder {
	events: Vec<Value>,
}

/// JavaScript object key order: array-index keys ascending, then the rest in insertion order.
fn js_key_order(attributes: &Attributes) -> Vec<Value> {
	let index_of = |key: &str| -> Option<u64> {
		let canonical =
			key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
		if !canonical || key.is_empty() {
			return None;
		}
		key.parse::<u64>()
			.ok()
			.filter(|&value| value < 4_294_967_295)
	};
	let mut indexed: Vec<(u64, &str, &str)> = Vec::new();
	let mut named: Vec<(&str, &str)> = Vec::new();
	for (key, value) in attributes.iter() {
		match index_of(key) {
			Some(index) => indexed.push((index, key, value)),
			None => named.push((key, value)),
		}
	}
	indexed.sort_by_key(|&(index, _, _)| index);
	indexed
		.into_iter()
		.map(|(_, key, value)| json!([key, value]))
		.chain(named.into_iter().map(|(key, value)| json!([key, value])))
		.collect()
}

impl Handler for Recorder {
	fn on_open_tag(&mut self, tag: Tag<'_>, attributes: &Attributes) {
		self.events
			.push(json!(["o", tag.name, js_key_order(attributes)]));
	}

	fn on_text(&mut self, text: &str) {
		self.events.push(json!(["t", text]));
	}

	fn on_split_text(&mut self, _character: char) {
		// Two lone-surrogate chunks in JavaScript, each U+FFFD once well-formed.
		self.events.push(json!(["t", "\u{FFFD}"]));
		self.events.push(json!(["t", "\u{FFFD}"]));
	}

	fn on_close_tag(&mut self, tag: Tag<'_>, implied: bool) {
		self.events.push(json!(["c", tag.name, implied]));
	}

	fn on_comment(&mut self, comment: &str) {
		self.events.push(json!(["m", comment]));
	}
}

fn events_of(html: &str) -> Value {
	let mut recorder = Recorder::default();
	parser::parse(html, &mut recorder);
	Value::Array(recorder.events)
}

#[derive(Deserialize)]
struct EntityVectors {
	#[serde(rename = "trieLength")]
	trie_length: usize,
	#[serde(rename = "trieSha256")]
	trie_sha256: String,
	names: Vec<EntityCase>,
}

#[derive(Deserialize)]
struct EntityCase {
	name: String,
	events: String,
}

/// `entityDocument` in `scripts/vectors/html.ts`.
fn entity_document(name: &str) -> String {
	format!(
		"&{name};|&{name}|&{name}x|&{name}=|<a t=\"&{name};|&{name}|&{name}x|&{name}=|&{name}\">|</a>"
	)
}

#[test]
fn every_named_reference_decodes_like_htmlparser2() {
	let vectors: EntityVectors = serde_json::from_str(&vector_file("entities.json")).unwrap();
	assert_eq!(
		vectors.names.len(),
		2125,
		"every WHATWG name (2,231 entries, 106 legacy pairs)"
	);
	assert_eq!(research_html::entity_trie().len(), vectors.trie_length);
	let mut hasher = Sha256::new();
	for word in research_html::entity_trie() {
		hasher.update(word.to_le_bytes());
	}
	assert_eq!(
		hex::encode(hasher.finalize()),
		vectors.trie_sha256,
		"entities_data.rs is stale"
	);
	let failures: Vec<String> = vectors
		.names
		.par_iter()
		.filter_map(|case| {
			let expected: Value = serde_json::from_str(&case.events).unwrap();
			let actual = events_of(&entity_document(&case.name));
			(actual != expected)
				.then(|| format!("&{};\n  rust {actual}\n  ts   {expected}", case.name))
		})
		.collect();
	assert!(
		failures.is_empty(),
		"{} names differ:\n{}",
		failures.len(),
		failures.join("\n")
	);
}

#[derive(Deserialize)]
struct EventCase {
	input: String,
	events: String,
}

#[test]
fn parser_events_match_htmlparser2() {
	let cases: Vec<EventCase> = serde_json::from_str(&vector_file("events.json")).unwrap();
	assert!(cases.len() > 1_000);
	let failures: Vec<String> = cases
		.par_iter()
		.filter_map(|case| {
			let expected: Value = serde_json::from_str(&case.events).unwrap();
			let actual = events_of(&case.input);
			(actual != expected)
				.then(|| format!("{:?}\n  rust {actual}\n  ts   {expected}", case.input))
		})
		.collect();
	assert!(
		failures.is_empty(),
		"{} of {} inputs differ:\n{}",
		failures.len(),
		cases.len(),
		failures
			.iter()
			.take(10)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n")
	);
}

/// An input: a plain string, or `[piece | [piece, count]]` (`testInputs.ts`).
#[derive(Deserialize)]
#[serde(untagged)]
enum Input {
	Text(String),
	Pieces(Vec<Piece>),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Piece {
	Text(String),
	Repeat(String, usize),
}

impl Input {
	fn build(&self) -> String {
		match self {
			Self::Text(text) => text.clone(),
			Self::Pieces(pieces) => pieces
				.iter()
				.map(|piece| match piece {
					Piece::Text(text) => text.clone(),
					Piece::Repeat(text, count) => text.repeat(*count),
				})
				.collect(),
		}
	}
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
struct Omitted {
	#[serde(rename = "boilerplateBlocks")]
	boilerplate_blocks: usize,
	#[serde(rename = "menuLists")]
	menu_lists: usize,
	#[serde(rename = "leadingBlocks")]
	leading_blocks: usize,
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
struct Page {
	title: Option<String>,
	markdown: String,
	truncated: bool,
	omitted: Omitted,
}

impl From<&MarkdownPage> for Page {
	fn from(page: &MarkdownPage) -> Self {
		Self {
			title: page.title.clone(),
			markdown: page.markdown.clone(),
			truncated: page.truncated,
			omitted: Omitted {
				boilerplate_blocks: page.omitted.boilerplate_blocks,
				menu_lists: page.omitted.menu_lists,
				leading_blocks: page.omitted.leading_blocks,
			},
		}
	}
}

#[derive(Deserialize)]
struct ConvertCase {
	html: Input,
	#[serde(rename = "baseUrl")]
	base_url: String,
	#[serde(rename = "maxChars")]
	max_chars: usize,
	output: Page,
}

fn replay(file: &str, minimum: usize) {
	let cases: Vec<ConvertCase> = serde_json::from_str(&vector_file(file)).unwrap();
	assert!(cases.len() >= minimum, "{file}: {} cases", cases.len());
	let inputs: Vec<String> = cases.iter().map(|case| case.html.build()).collect();
	let pages: Vec<(&str, Options<'_>)> = cases
		.iter()
		.zip(&inputs)
		.map(|(case, html)| {
			(
				html.as_str(),
				Options {
					base_url: &case.base_url,
					max_chars: case.max_chars,
				},
			)
		})
		.collect();
	let outputs = convert_many(&pages);
	let failures: Vec<String> = cases
		.iter()
		.zip(&inputs)
		.zip(&outputs)
		.filter(|((case, _), output)| Page::from(*output) != case.output)
		.map(|((case, html), output)| {
			let shown: String = html.chars().take(300).collect();
			format!(
				"{shown:?} (base {:?}, max {})\n  rust {:?}\n  ts   {:?}",
				case.base_url,
				case.max_chars,
				Page::from(output),
				case.output
			)
		})
		.collect();
	assert!(
		failures.is_empty(),
		"{file}: {} of {} cases differ:\n{}",
		failures.len(),
		cases.len(),
		failures
			.iter()
			.take(8)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n")
	);
}

#[test]
fn converts_every_typescript_test_input() {
	replay("convert-tests.json", 400);
}

#[test]
fn converts_edge_cases() {
	replay("convert-tricky.json", 800);
}

#[test]
fn converts_fast_check_samples() {
	replay("convert-property.json", 2_500);
}

#[test]
fn converts_seeded_tag_soup() {
	for part in 0..4 {
		replay(&format!("convert-soup-{part}.json"), 1_000);
	}
}

#[derive(Deserialize)]
struct BenchCase {
	name: String,
	#[serde(rename = "inputLength")]
	input_length: usize,
	#[serde(rename = "inputSha256")]
	input_sha256: String,
	#[serde(rename = "baseUrl")]
	base_url: String,
	#[serde(rename = "maxChars")]
	max_chars: usize,
	output: BenchOutput,
	markdown: Option<String>,
}

#[derive(Deserialize)]
struct BenchOutput {
	title: Option<String>,
	truncated: bool,
	omitted: Omitted,
	#[serde(rename = "markdownLength")]
	markdown_length: usize,
	#[serde(rename = "markdownSha256")]
	markdown_sha256: String,
}

/// The `scripts/bench.ts` article (`benchArticleHtml` in the exporter).
fn bench_article_html() -> String {
	let sentence =
		"Grid-scale battery orders doubled year over year to 1,250 units as utilities restocked. ";
	let mut html = String::from(
		"<html><head><title>Grid battery orders double &amp; margins hold</title><style>p{color:red}</style>",
	);
	html.push_str(
		"<script>window.tracker=\"x\";</script></head><body><nav><a href=\"/home\">home</a></nav><main><article><h1>Grid battery orders double</h1>",
	);
	for section in 0..1_000 {
		html.push_str(&format!(
			"<h2>Section {section}</h2><p>{}<strong>strong {section}</strong> <a href=\"/a/{section}\">link {section}</a></p>",
			sentence.repeat(8)
		));
		html.push_str(&format!(
			"<ul><li>item {section} a</li><li>item {section} b<ul><li>nested {section}</li></ul></li></ul>"
		));
		html.push_str(&format!(
			"<table><tr><th>Metric</th><th>Value</th></tr><tr><td>orders|units</td><td>{section}</td></tr></table>"
		));
		html.push_str(&format!(
			"<blockquote><p>quoted {section}</p></blockquote><pre>code {section}\n  indented</pre>"
		));
	}
	html.push_str("</article></main><aside>sidebar</aside><footer>footer</footer></body></html>");
	html
}

/// The `scripts/bench.ts` hostile nesting page.
fn bench_deep_nesting_html() -> String {
	let long_line = format!("x{}", "y".repeat(1999));
	format!(
		"{}<p>{}</p>{}",
		"<blockquote><ul><li><strong><em>".repeat(4_000),
		format!("{long_line}<br>").repeat(900),
		"</em></strong></li></ul></blockquote>".repeat(4_000)
	)
}

fn sha256(text: &str) -> String {
	hex::encode(Sha256::digest(text.as_bytes()))
}

#[test]
fn converts_the_bench_pages() {
	let cases: Vec<BenchCase> = serde_json::from_str(&vector_file("convert-bench.json")).unwrap();
	let article = bench_article_html();
	let deep = bench_deep_nesting_html();
	for case in &cases {
		let html = if case.name == "article" {
			&article
		} else {
			&deep
		};
		assert_eq!(html.len(), case.input_length, "{} recipe", case.name);
		assert_eq!(sha256(html), case.input_sha256, "{} recipe", case.name);
		let page = research_html::html_to_markdown(
			html,
			&Options {
				base_url: &case.base_url,
				max_chars: case.max_chars,
			},
		);
		if let Some(markdown) = &case.markdown {
			assert_eq!(
				&page.markdown, markdown,
				"{} at {}",
				case.name, case.max_chars
			);
		}
		assert_eq!(
			page.markdown.encode_utf16().count(),
			case.output.markdown_length
		);
		assert_eq!(
			sha256(&page.markdown),
			case.output.markdown_sha256,
			"{} at {}",
			case.name,
			case.max_chars
		);
		assert_eq!(page.title, case.output.title);
		assert_eq!(page.truncated, case.output.truncated);
		assert_eq!(
			Omitted {
				boilerplate_blocks: page.omitted.boilerplate_blocks,
				menu_lists: page.omitted.menu_lists,
				leading_blocks: page.omitted.leading_blocks,
			},
			case.output.omitted
		);
	}
}
