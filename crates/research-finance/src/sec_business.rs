//! "Item 1. Business" of a 10-K (port of
//! `packages/adapters/src/finance/secBusiness.ts`, ADR-0053 §3), pure: the
//! primary document's Markdown (`html_to_markdown`) in, the section's stored
//! paragraphs out.
//!
//! 1. Blocks are the Markdown's blank-line separated parts. A block whose
//!    every line starts with "|" is a table: its separator rows go and its
//!    non-empty cells are joined with one space; any other block loses a
//!    leading `#` heading marker. Both lose `**` / `__` emphasis markers, and
//!    whitespace runs collapse.
//! 2. Each block is marked (`sec_section_mark`) and `business_section_bounds`
//!    picks the section: the table of contents names Item 1 too, and some
//!    filings repeat it as a running page header.
//! 3. The body is cleaned for SEC: tables, page numbers, `---` page breaks,
//!    "Table of Contents", "Part I", a bare "Item 1" running header and short
//!    running footers naming "Form 10-K" go. Text before the first
//!    subheading goes when that subheading is the second or third paragraph
//!    (forward-looking-statement or defined-terms boilerplate).
//! 4. `business_paragraphs` keeps the leading paragraphs within the limits.
//!
//! The TypeScript's patterns are case-insensitive without the `u` flag, which
//! folds ASCII letters only, and its `\s` is JavaScript's whitespace: both
//! are matched by hand here, exactly. Lengths are UTF-16 code units.

use research_domain::finance::business_description::{
	BusinessParagraphKind, BusinessParagraphs, SectionMark, business_paragraph_kind,
	business_paragraphs, business_section_bounds, is_lone_bullet,
};
use research_js::utf16::utf16_len;
use research_js::whitespace::{self, is_js_whitespace};
use serde::Serialize;

/// A 10-K's primary document: 1–13 MB on the companies checked (ADR-0053 §2).
pub const SEC_TEN_K_MAX_BYTES: usize = 16_000_000;
/// Markdown kept of a primary document; Item 1 sits in its first part.
pub const SEC_TEN_K_MAX_MARKDOWN_CHARS: usize = 4_000_000;
/// The start heading is short: "Items 1 and 2. Business and Properties" is 38.
const MAX_START_CHARS: usize = 60;
/// An end heading may carry its title: "Item 1A. Risk Factors".
const MAX_END_CHARS: usize = 120;
/// Running footers ("Apple Inc. | 2025 Form 10-K | 3") are short.
const MAX_FOOTER_CHARS: usize = 100;

/// One block of the converted document (`SecBlock`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SecBlock {
	/// Whitespace-collapsed text without heading and emphasis markers.
	pub text: String,
	/// The block is a Markdown table.
	pub table: bool,
}

/* ---------- Text helpers (the TypeScript's regular expressions) ---------- */

/// `text.replace(/\s+/g, " ").trim()`.
fn collapse(text: &str) -> String {
	whitespace::trim(&whitespace::collapse(text)).to_owned()
}

/// `text.replace(/\*\*|__/g, "")`: one left-to-right scan, as the regex does.
fn without_emphasis(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	loop {
		if let Some(after) = rest.strip_prefix("**").or_else(|| rest.strip_prefix("__")) {
			rest = after;
			continue;
		}
		let mut characters = rest.chars();
		let Some(character) = characters.next() else {
			return out;
		};
		out.push(character);
		rest = characters.as_str();
	}
}

/// `text.replace(/^#+\s*/, "")`.
fn without_heading_marker(text: &str) -> &str {
	let hashes = text.trim_start_matches('#');
	if hashes.len() == text.len() {
		text
	} else {
		hashes.trim_start_matches(is_js_whitespace)
	}
}

/// `/^\|[\s:|-]+\|$/`.
fn is_table_separator_row(line: &str) -> bool {
	line.strip_prefix('|')
		.and_then(|inner| inner.strip_suffix('|'))
		.is_some_and(|inner| {
			!inner.is_empty()
				&& inner.chars().all(|character| {
					is_js_whitespace(character) || matches!(character, ':' | '|' | '-')
				})
		})
}

/// An ASCII case-insensitive prefix (`/…/i` without `u` on an ASCII pattern).
fn strip_ascii_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
	let head = text.as_bytes().get(..prefix.len())?;
	// The matched bytes are ASCII, so `prefix.len()` is a character boundary.
	if head.eq_ignore_ascii_case(prefix.as_bytes()) {
		text.get(prefix.len()..)
	} else {
		None
	}
}

/// `\s*`.
fn spaces(text: &str) -> &str {
	text.trim_start_matches(is_js_whitespace)
}

/// `\b` after a word character: the next character is not `[A-Za-z0-9_]`.
fn word_ends(text: &str) -> bool {
	!text
		.chars()
		.next()
		.is_some_and(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// `/^items?\s*1(?:\s*(?:and|&)\s*2)?\s*[.:\-–—]?\s*business\b/i`.
fn is_start_heading(text: &str) -> bool {
	let Some(rest) = strip_ascii_ci(text, "item") else {
		return false;
	};
	let rest = rest.strip_prefix(&['s', 'S'][..]).unwrap_or(rest);
	let Some(mut rest) = spaces(rest).strip_prefix('1') else {
		return false;
	};
	// The optional "and 2": when it matches, nothing else after "1" could.
	let joined = spaces(rest);
	if let Some(after) = strip_ascii_ci(joined, "and").or_else(|| joined.strip_prefix('&')) {
		if let Some(after) = spaces(after).strip_prefix('2') {
			rest = after;
		}
	}
	let rest = spaces(rest);
	let rest = rest
		.strip_prefix(&['.', ':', '-', '–', '—'][..])
		.unwrap_or(rest);
	strip_ascii_ci(spaces(rest), "business").is_some_and(word_ends)
}

/// `/^item\s*(?:1a|1b|1c|2|3)\b/i`.
fn is_end_heading(text: &str) -> bool {
	let Some(rest) = strip_ascii_ci(text, "item") else {
		return false;
	};
	let rest = spaces(rest);
	["1a", "1b", "1c", "2", "3"]
		.iter()
		.any(|number| strip_ascii_ci(rest, number).is_some_and(word_ends))
}

/// `/^part\s+[ivx]+$/i`.
fn is_part_heading(text: &str) -> bool {
	let Some(rest) = strip_ascii_ci(text, "part") else {
		return false;
	};
	let numeral = spaces(rest);
	numeral.len() < rest.len()
		&& !numeral.is_empty()
		&& numeral
			.bytes()
			.all(|byte| matches!(byte.to_ascii_lowercase(), b'i' | b'v' | b'x'))
}

/// `/^item\s*1\.?$/i`.
fn is_bare_item_one(text: &str) -> bool {
	strip_ascii_ci(text, "item")
		.and_then(|rest| spaces(rest).strip_prefix('1'))
		.is_some_and(|rest| rest.is_empty() || rest == ".")
}

/// `/form 10-k/i`.
fn names_form_10k(text: &str) -> bool {
	const NEEDLE: &[u8] = b"form 10-k";
	text.as_bytes()
		.windows(NEEDLE.len())
		.any(|window| window.eq_ignore_ascii_case(NEEDLE))
}

/* ---------- Blocks ---------- */

/// `secBlock`: a Markdown block's text (rule 1).
#[must_use]
pub fn sec_block(block: &str) -> SecBlock {
	if block.split('\n').all(|line| line.starts_with('|')) {
		let mut cells: Vec<String> = Vec::new();
		for line in block.split('\n') {
			if is_table_separator_row(whitespace::trim(line)) {
				continue;
			}
			for cell in line.split('|') {
				let text = collapse(&without_emphasis(cell));
				if !text.is_empty() {
					cells.push(text);
				}
			}
		}
		return SecBlock {
			text: cells.join(" "),
			table: true,
		};
	}
	SecBlock {
		text: collapse(&without_emphasis(without_heading_marker(block))),
		table: false,
	}
}

/// `markdown.split(/\n{2,}/)`.
fn split_blocks(markdown: &str) -> Vec<&str> {
	let mut parts = Vec::new();
	let mut rest = markdown;
	while let Some(at) = rest.find("\n\n") {
		let (head, tail) = rest.split_at(at);
		parts.push(head);
		rest = tail.trim_start_matches('\n');
	}
	parts.push(rest);
	parts
}

/// `secMarkdownBlocks`: the blocks of a converted primary document, in order.
#[must_use]
pub fn sec_markdown_blocks(markdown: &str) -> Vec<SecBlock> {
	split_blocks(markdown).into_iter().map(sec_block).collect()
}

/// `secSectionMark`: what a block is to the section search (ADR-0053 §3).
#[must_use]
pub fn sec_section_mark(text: &str) -> SectionMark {
	let length = utf16_len(text);
	if length <= MAX_START_CHARS && is_start_heading(text) {
		SectionMark::Start
	} else if length <= MAX_END_CHARS && is_end_heading(text) {
		SectionMark::End
	} else {
		SectionMark::Other
	}
}

/// A block of the section that is page furniture, not description (rule 3).
fn is_furniture(block: &SecBlock) -> bool {
	let text = block.text.as_str();
	block.table
		|| text.is_empty()
		|| text.bytes().all(|byte| byte.is_ascii_digit())
		|| (text.len() >= 3 && text.bytes().all(|byte| byte == b'-'))
		|| text.eq_ignore_ascii_case("table of contents")
		|| is_part_heading(text)
		|| is_bare_item_one(text)
		|| (utf16_len(text) < MAX_FOOTER_CHARS && names_form_10k(text))
}

/// Where the description starts among the cleaned blocks: at the first
/// subheading when it is paragraph 1 or 2 (what comes before it is
/// boilerplate), else at the first block. Paragraphs are counted as
/// `business_paragraphs` forms them: a lone list marker belongs to the next
/// block (and such a paragraph is never a heading).
fn preamble_end(texts: &[String]) -> usize {
	let mut paragraph = 0usize;
	let mut lone_previous = false;
	for (index, text) in texts.iter().enumerate() {
		if paragraph > 2 {
			break;
		}
		// A marker after a marker replaces it; the paragraph is the marker and the next text.
		if is_lone_bullet(text) {
			lone_previous = true;
			continue;
		}
		if lone_previous {
			lone_previous = false;
			paragraph += 1;
			continue;
		}
		if business_paragraph_kind(text) == BusinessParagraphKind::Heading {
			return if paragraph == 0 { 0 } else { index };
		}
		paragraph += 1;
	}
	0
}

/// `secBusinessBlocks`: the cleaned blocks of the 10-K's "Item 1. Business"
/// (rules 1–3), or `None` when the document has no such section with a body.
#[must_use]
pub fn sec_business_blocks(markdown: &str) -> Option<Vec<String>> {
	let blocks = sec_markdown_blocks(markdown);
	let marks: Vec<SectionMark> = blocks
		.iter()
		.map(|block| sec_section_mark(&block.text))
		.collect();
	let sizes: Vec<u64> = blocks
		.iter()
		.map(|block| u64::try_from(utf16_len(&block.text)).unwrap_or(u64::MAX))
		.collect();
	let bounds = business_section_bounds(&marks, &sizes)?;
	let texts: Vec<String> = blocks
		.into_iter()
		.take(bounds.end)
		.skip(bounds.start + 1)
		.filter(|block| !is_furniture(block))
		.map(|block| block.text)
		.collect();
	let start = preamble_end(&texts);
	Some(texts.into_iter().skip(start).collect())
}

/// `secBusinessParagraphs`: the stored paragraphs of a 10-K's business
/// section; no paragraphs when the document has none that could be read
/// (the description is then "not-found").
#[must_use]
pub fn sec_business_paragraphs(markdown: &str) -> BusinessParagraphs {
	match sec_business_blocks(markdown) {
		Some(blocks) => business_paragraphs(&blocks),
		None => BusinessParagraphs {
			paragraphs: Vec::new(),
			truncated: false,
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn headings_are_marked_like_the_typescript_patterns() {
		for start in [
			"Item 1. Business",
			"ITEM 1 — BUSINESS",
			"Items 1 and 2. Business and Properties",
			"Items 1 & 2 — Business",
			"item1business",
			"Item 1: Business Overview",
		] {
			assert_eq!(sec_section_mark(start), SectionMark::Start, "{start}");
		}
		for end in [
			"Item 1A",
			"ITEM 1A. RISK FACTORS",
			"Item 2. Properties",
			"Item 3",
		] {
			assert_eq!(sec_section_mark(end), SectionMark::End, "{end}");
		}
		for other in [
			"Item 1",
			"Item 12. Business Combinations",
			"Item 1 Businesses",
			"Item 10",
			"Item 1A Business",
		] {
			assert_ne!(sec_section_mark(other), SectionMark::Start, "{other}");
		}
		assert_eq!(sec_section_mark("Item 20"), SectionMark::Other);
	}

	#[test]
	fn blocks_lose_markers_and_tables_keep_their_cells() {
		assert_eq!(sec_block("## __Products__").text, "Products");
		assert_eq!(without_emphasis("_**_"), "__");
		let table = sec_block("| Item 1. | Business |\n| --- | --- |");
		assert_eq!(table.text, "Item 1. Business");
		assert!(table.table);
		assert_eq!(split_blocks("a\n\n\nb\n\n"), ["a", "b", ""]);
		assert_eq!(split_blocks(""), [""]);
	}
}
