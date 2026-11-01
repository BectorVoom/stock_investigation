//! Port of `packages/domain/src/finance/businessDescription.ts` (ADR-0053):
//! where "Item 1. Business" lies among a converted 10-K's blocks, how a
//! section's blocks become stored paragraphs, and how many of them the
//! Company tab shows before "Show more".
//!
//! Pure and total. `business_section_bounds` is modelled in Lean
//! (`formal/ResearchFormal/BusinessSection.lean`, replayed by
//! `tests/lean_vectors.rs`); every function replays
//! `vectors/domain/business_description.json`. Lengths are UTF-16 code units,
//! as the TypeScript's `length`.

use std::sync::LazyLock;

use regex::Regex;
use research_js::{utf16, whitespace};
use serde::{Deserialize, Serialize};

use crate::literal::js_literal_enum;
use crate::text::truncate::truncate_text;

/// `BUSINESS_DESCRIPTION_LIMITS`.
pub mod limits {
	/// UTF-16 units of paragraph text one company keeps (the rest stays in the filing).
	pub const MAX_STORED_CHARS: usize = 20_000;
	/// Paragraphs one company keeps.
	pub const MAX_PARAGRAPHS: usize = 400;
	/// A heading is a short line without closing punctuation.
	pub const MAX_HEADING_CHARS: usize = 80;
	/// UTF-16 units the Company tab shows before "Show more".
	pub const SUMMARY_CHARS: usize = 700;
}

js_literal_enum! {
	/// `BUSINESS_PARAGRAPH_KINDS`.
	pub enum BusinessParagraphKind {
		/// A short line without closing punctuation.
		Heading = "heading",
		/// Everything else.
		Text = "text",
	}
}

/// `BusinessParagraph`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusinessParagraph {
	/// Heading or text.
	pub kind: BusinessParagraphKind,
	/// Whitespace-collapsed, trimmed, never empty.
	pub text: String,
}

/// `BusinessParagraphs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusinessParagraphs {
	/// The kept leading paragraphs.
	pub paragraphs: Vec<BusinessParagraph>,
	/// True when paragraphs were left out (or the first cut) to fit the limits.
	pub truncated: bool,
}

/* ---------- Locating the section ---------- */

js_literal_enum! {
	/// `SectionMark`: what one block of a converted filing is to the section search.
	pub enum SectionMark {
		/// The section's heading ("Item 1. Business").
		Start = "start",
		/// A heading that ends it ("Item 1A. Risk Factors", "Item 2. Properties", …).
		End = "end",
		/// Anything else.
		Other = "other",
	}
}

/// `SectionBounds`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionBounds {
	/// Index of the chosen start heading.
	pub start: usize,
	/// Index of the first end heading after it; the body is the blocks strictly between.
	pub end: usize,
}

/// `Number.MAX_SAFE_INTEGER`: the TypeScript counts a larger size as 0.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `businessSectionBounds` (ADR-0053 §3): every start heading followed by an
/// end heading is a candidate whose body runs to the first end heading after
/// it; the largest body (the sum of `sizes` strictly between) wins, the
/// earliest start among equals; `None` when no candidate has a non-empty body.
/// A missing size counts as 0. One backward pass: O(blocks).
#[must_use]
pub fn business_section_bounds(marks: &[SectionMark], sizes: &[u64]) -> Option<SectionBounds> {
	let mut best: Option<SectionBounds> = None;
	let mut best_size = 0u64;
	// Walking backwards, `next_end` is the first end heading after the current
	// index and `size_to_end` the sum of sizes from just after it up to that end.
	let mut next_end: Option<usize> = None;
	let mut size_to_end = 0u64;
	for (index, mark) in marks.iter().enumerate().rev() {
		match next_end {
			// `>=` while walking backwards keeps the earliest start among equals.
			Some(end)
				if *mark == SectionMark::Start && size_to_end > 0 && size_to_end >= best_size =>
			{
				best = Some(SectionBounds { start: index, end });
				best_size = size_to_end;
			}
			_ => {}
		}
		if *mark == SectionMark::End {
			next_end = Some(index);
			size_to_end = 0;
		} else {
			let size = sizes.get(index).copied().unwrap_or(0);
			if size <= MAX_SAFE_INTEGER {
				size_to_end = size_to_end.saturating_add(size);
			}
		}
	}
	best
}

/* ---------- Paragraphs ---------- */

/// A bullet glyph: starts a list item with or without a space after it.
fn is_bullet_glyph(character: char) -> bool {
	matches!(character, '•' | '●' | '◦' | '▪' | '■' | '・')
}

/// A dash: starts a list item only when a space follows (it also starts
/// words and ranges).
fn is_dash(character: char) -> bool {
	matches!(character, '‐' | '–' | '—' | '-')
}

/// `CLOSING`: closing punctuation of a sentence or a lead-in.
fn is_closing(character: char) -> bool {
	matches!(
		character,
		'.' | '。'
			| '．' | ':'
			| '：' | ';'
			| '；' | '!'
			| '！' | '?'
			| '？' | ','
			| '，' | '、'
			| ')' | '）'
			| '」' | '』'
			| '"' | '”'
	)
}

/// `/\p{L}/u` (`regex` follows Unicode's General_Category, as V8 does).
static LETTER: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\p{L}").ok());

fn has_letter(text: &str) -> bool {
	match LETTER.as_ref() {
		Some(regex) => regex.is_match(text),
		None => text.chars().any(char::is_alphabetic),
	}
}

/// `isLoneBullet` (`/^[•●◦▪■・‐–—-]$/u`): whether a (trimmed) block is only a
/// list marker whose item is the next block.
#[must_use]
pub fn is_lone_bullet(text: &str) -> bool {
	let mut characters = text.chars();
	matches!(
		(characters.next(), characters.next()),
		(Some(first), None) if is_bullet_glyph(first) || is_dash(first)
	)
}

/// `BULLET_START` (`/^(?:[•●◦▪■・]|[‐–—-]\s)/u`): a bullet glyph, or a dash
/// followed by whitespace.
fn starts_with_bullet(text: &str) -> bool {
	let mut characters = text.chars();
	match (characters.next(), characters.next()) {
		(Some(first), _) if is_bullet_glyph(first) => true,
		(Some(first), Some(second)) => is_dash(first) && whitespace::is_js_whitespace(second),
		_ => false,
	}
}

/// `businessParagraphKind`: a heading is short, has a letter, is not a list
/// item and has no closing punctuation.
#[must_use]
pub fn business_paragraph_kind(text: &str) -> BusinessParagraphKind {
	let heading = utf16::utf16_len(text) <= limits::MAX_HEADING_CHARS
		&& has_letter(text)
		&& !starts_with_bullet(text)
		&& !text.chars().next_back().is_some_and(is_closing);
	if heading {
		BusinessParagraphKind::Heading
	} else {
		BusinessParagraphKind::Text
	}
}

/// `businessParagraphs` (ADR-0053 §4): whitespace runs collapse to one space,
/// empty blocks go, a lone list marker joins the next block ("• text"), each
/// block is a heading or text. Then the leading paragraphs that fit
/// `MAX_STORED_CHARS` and `MAX_PARAGRAPHS` are kept (when no text paragraph is
/// kept yet, the first that does not fit is cut with "…" to the room left), and
/// trailing headings are dropped.
#[must_use]
pub fn business_paragraphs<S: AsRef<str>>(blocks: &[S]) -> BusinessParagraphs {
	let mut texts: Vec<String> = Vec::with_capacity(blocks.len());
	let mut pending_bullet: Option<String> = None;
	for block in blocks {
		let collapsed = whitespace::collapse(block.as_ref());
		let text = whitespace::trim(&collapsed);
		if text.is_empty() {
			continue;
		}
		if is_lone_bullet(text) {
			pending_bullet = Some(text.to_owned());
			continue;
		}
		texts.push(match pending_bullet.take() {
			Some(bullet) => format!("{bullet} {text}"),
			None => text.to_owned(),
		});
	}
	let mut kept: Vec<BusinessParagraph> = Vec::new();
	let mut total = 0usize;
	let mut truncated = false;
	for text in texts {
		let length = utf16::utf16_len(&text);
		if kept.len() == limits::MAX_PARAGRAPHS || total + length > limits::MAX_STORED_CHARS {
			// Before any text is kept, the first text that does not fit is cut to
			// the room left, so a heading followed by one long paragraph still
			// describes the business.
			let room = limits::MAX_STORED_CHARS.saturating_sub(total);
			let has_text = kept
				.iter()
				.any(|paragraph| paragraph.kind == BusinessParagraphKind::Text);
			if !has_text && kept.len() < limits::MAX_PARAGRAPHS && room > 0 {
				let cut = truncate_text(&text, room).into_owned();
				kept.push(BusinessParagraph {
					kind: BusinessParagraphKind::Text,
					text: cut,
				});
			}
			truncated = true;
			break;
		}
		kept.push(BusinessParagraph {
			kind: business_paragraph_kind(&text),
			text,
		});
		total += length;
	}
	while kept.len() > 1
		&& kept
			.last()
			.is_some_and(|paragraph| paragraph.kind == BusinessParagraphKind::Heading)
	{
		kept.pop();
	}
	// A section of headings only describes nothing.
	if !kept
		.iter()
		.any(|paragraph| paragraph.kind == BusinessParagraphKind::Text)
	{
		return BusinessParagraphs {
			paragraphs: Vec::new(),
			truncated: false,
		};
	}
	BusinessParagraphs {
		paragraphs: kept,
		truncated,
	}
}

/// `businessSummaryCount` (ADR-0053 §6): how many leading paragraphs fit
/// `summary_chars`, but always through the first text paragraph, and never
/// ending on a heading that a later text paragraph belongs to.
#[must_use]
pub fn business_summary_count(paragraphs: &[BusinessParagraph], summary_chars: usize) -> usize {
	let Some(first_text) = paragraphs
		.iter()
		.position(|paragraph| paragraph.kind == BusinessParagraphKind::Text)
	else {
		return 0;
	};
	let mut count = 0usize;
	let mut total = 0usize;
	for paragraph in paragraphs {
		let length = utf16::utf16_len(&paragraph.text);
		if total + length > summary_chars {
			break;
		}
		total += length;
		count += 1;
	}
	while count > first_text + 1
		&& paragraphs
			.get(count - 1)
			.is_some_and(|paragraph| paragraph.kind == BusinessParagraphKind::Heading)
	{
		count -= 1;
	}
	count.max(first_text + 1)
}

#[cfg(test)]
mod tests {
	use super::*;
	use SectionMark::{End, Other, Start};

	#[test]
	fn the_body_section_beats_the_table_of_contents() {
		let marks = [Other, Start, End, End, Start, Other, Other, End, Other];
		let sizes = [500, 20, 25, 22, 20, 4_000, 3_000, 25, 9_000];
		assert_eq!(
			business_section_bounds(&marks, &sizes),
			Some(SectionBounds { start: 4, end: 7 })
		);
		assert_eq!(business_section_bounds(&[Start, End], &[9, 9]), None);
		assert_eq!(
			business_section_bounds(&[Start, Other, End], &[1, MAX_SAFE_INTEGER + 1, 1]),
			None
		);
	}

	#[test]
	fn paragraphs_join_bullets_and_drop_trailing_headings() {
		let result = business_paragraphs(&["Products", "•", " iPhone\u{a0} 16 ", "Services"]);
		assert_eq!(
			result.paragraphs,
			[
				BusinessParagraph {
					kind: BusinessParagraphKind::Heading,
					text: "Products".to_owned()
				},
				BusinessParagraph {
					kind: BusinessParagraphKind::Text,
					text: "• iPhone 16".to_owned()
				},
			]
		);
		assert!(!result.truncated);
		assert_eq!(
			business_paragraph_kind("当社は電子機器を製造しています。"),
			BusinessParagraphKind::Text
		);
		assert_eq!(
			business_paragraph_kind("事業の内容"),
			BusinessParagraphKind::Heading
		);
	}
}
