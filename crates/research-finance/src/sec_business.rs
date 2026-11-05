//! "Item 1. Business" of a 10-K (ADR-0053 §3) and Item 4.B "Business
//! Overview" (else Item 4 "Information on the Company") of a 20-F (ADR-0058
//! §5) — port of `packages/adapters/src/finance/secBusiness.ts`, pure: the
//! primary document's Markdown (`html_to_markdown`) in, the section's stored
//! paragraphs out.
//!
//! 1. Blocks are the Markdown's blank-line separated parts. A block whose
//!    every line starts with "|" is a table: its separator rows go and its
//!    non-empty cells are joined with one space; any other block loses a
//!    leading `#` heading marker. Both lose `**` / `__` emphasis markers, and
//!    whitespace runs collapse.
//! 2. Each block is marked (`sec_section_mark`) for a section and
//!    `business_section_bounds` picks it: the table of contents names the
//!    item too, and some filings repeat it as a running page header. A
//!    form's sections are tried in turn (`SecDescribedForm::sections`); the
//!    first found is read — a 20-F's Item 4.B before Item 4, whose 4.A is the
//!    company's history.
//! 3. The body is cleaned for SEC: tables, page numbers, `---` page breaks,
//!    "Table of Contents", "Part I", a bare "Item 1" (20-F: "Item 4") running
//!    header and short running footers naming "Form 10-K" (20-F: "Form
//!    20-F") go; in a 20-F also a short note incorporating text "by
//!    reference". Text before the first subheading goes when that subheading
//!    is the second or third paragraph (forward-looking-statement or
//!    defined-terms boilerplate).
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
use serde::{Deserialize, Serialize};

/// A 10-K's (or 20-F's) primary document: 1–13 MB on the companies first
/// checked (ADR-0053 §2); Regency Centers' and BlackRock TCP Capital's are
/// 21 MB (2026-11-04).
pub const SEC_TEN_K_MAX_BYTES: usize = 32_000_000;
/// Markdown kept of a primary document; Item 1 sits in its first part.
pub const SEC_TEN_K_MAX_MARKDOWN_CHARS: usize = 4_000_000;
/// The start heading is short: "Items 1 and 2. Business and Properties" is 38.
const MAX_START_CHARS: usize = 60;
/// An end heading may carry its title: "Item 1A. Risk Factors".
const MAX_END_CHARS: usize = 120;
/// Running footers ("Apple Inc. | 2025 Form 10-K | 3") are short.
const MAX_FOOTER_CHARS: usize = 100;
/// A 20-F's cross-reference note ("… is incorporated herein by reference.") is short.
const MAX_CROSS_REFERENCE_CHARS: usize = 400;

/// `SecDescribedForm`: the primary documents a description is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecDescribedForm {
	/// An original 10-K.
	#[serde(rename = "10-K")]
	TenK,
	/// An original 20-F.
	#[serde(rename = "20-F")]
	TwentyF,
}

/// `SecBusinessSection`: the section a description is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecBusinessSection {
	/// A 10-K's "Item 1. Business".
	#[serde(rename = "10-K item 1")]
	TenKItemOne,
	/// A 20-F's Item 4.B "Business Overview".
	#[serde(rename = "20-F item 4B")]
	TwentyFItemFourB,
	/// A 20-F's Item 4 "Information on the Company".
	#[serde(rename = "20-F item 4")]
	TwentyFItemFour,
}

impl SecDescribedForm {
	/// `SEC_SECTIONS_OF_FORM`: the form's sections, in the order tried.
	#[must_use]
	pub const fn sections(self) -> &'static [SecBusinessSection] {
		match self {
			Self::TenK => &[SecBusinessSection::TenKItemOne],
			Self::TwentyF => &[
				SecBusinessSection::TwentyFItemFourB,
				SecBusinessSection::TwentyFItemFour,
			],
		}
	}
}

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

fn is_about_heading(text: &str) -> bool {
	let Some(rest) = text.strip_prefix("about ") else {
		return false;
	};
	let rest = rest.strip_suffix('.').unwrap_or(rest);
	(2..=61).contains(&utf16_len(rest))
		&& rest.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
		&& rest
			.chars()
			.all(|c| c.is_ascii_lowercase() || matches!(c, ' ' | '&' | '’' | '\'' | '-'))
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

/// `(?:part\s+i\s*[.,:\-–—]?\s*)?` at the start: "Part I." before an item
/// heading (Expedia). When it matches, the text without it is tried; a text
/// that starts with "part" can match no item heading otherwise.
fn without_part_one(text: &str) -> &str {
	strip_ascii_ci(text, "part")
		.and_then(spaces1)
		.and_then(|rest| strip_ascii_ci(rest, "i"))
		.map(|rest| {
			let rest = spaces(rest);
			spaces(
				rest.strip_prefix(&['.', ',', ':', '-', '–', '—'][..])
					.unwrap_or(rest),
			)
		})
		.unwrap_or(text)
}

/// `(?:description\s+of\s+(?:the\s+)?)?` before "business" ("Item 1.
/// Description of Business", World Acceptance).
fn without_description_of(text: &str) -> &str {
	strip_ascii_ci(text, "description")
		.and_then(spaces1)
		.and_then(|rest| strip_ascii_ci(rest, "of"))
		.and_then(spaces1)
		.map(|rest| {
			strip_ascii_ci(rest, "the")
				.and_then(spaces1)
				.unwrap_or(rest)
		})
		.unwrap_or(text)
}

/// `/^(?:part\s+i\s*[.,:\-–—]?\s*)?items?\s*1\.?(?:\s*(?:and|&)\s*2\.?)?\s*[.:\-–—|]?\s*(?:description\s+of\s+(?:the\s+)?)?business\b/i`.
/// A "." taken after a number is never needed back: the punctuation that
/// could take it instead is optional and followed by the same "business".
fn is_start_heading(text: &str) -> bool {
	let Some(rest) = strip_ascii_ci(without_part_one(text), "item") else {
		return false;
	};
	let rest = rest.strip_prefix(&['s', 'S'][..]).unwrap_or(rest);
	let Some(rest) = spaces(rest).strip_prefix('1') else {
		return false;
	};
	let mut rest = rest.strip_prefix('.').unwrap_or(rest);
	// The optional "and 2": when it matches, nothing else after "1" could.
	let joined = spaces(rest);
	if let Some(after) = strip_ascii_ci(joined, "and").or_else(|| joined.strip_prefix('&')) {
		if let Some(after) = spaces(after).strip_prefix('2') {
			rest = after.strip_prefix('.').unwrap_or(after);
		}
	}
	let rest = spaces(rest);
	let rest = rest
		.strip_prefix(&['.', ':', '-', '–', '—', '|'][..])
		.unwrap_or(rest);
	strip_ascii_ci(without_description_of(spaces(rest)), "business").is_some_and(word_ends)
}

/// `/^(?:part\s+i\s*[.,:\-–—]?\s*)?item\s*(?:1a|1b|1c|2|3)\b/i`.
fn is_end_heading(text: &str) -> bool {
	let Some(rest) = strip_ascii_ci(without_part_one(text), "item") else {
		return false;
	};
	let rest = spaces(rest);
	["1a", "1b", "1c", "2", "3"]
		.iter()
		.any(|number| strip_ascii_ci(rest, number).is_some_and(word_ends))
}

/// `\s+`: at least one whitespace character.
fn spaces1(text: &str) -> Option<&str> {
	let rest = spaces(text);
	(rest.len() < text.len()).then_some(rest)
}

/// `[.:\-–—]?`.
fn heading_punctuation(text: &str) -> &str {
	text.strip_prefix(&['.', ':', '-', '–', '—'][..])
		.unwrap_or(text)
}

/// `(?:item\s*)?4`: what follows the "4", or `None`.
fn item_four(text: &str) -> Option<&str> {
	strip_ascii_ci(text, "item")
		.map_or(text, spaces)
		.strip_prefix('4')
}

/// `/^(?:(?:item\s*)?4\s*\.?\s*)?b\s*[.:\-–—]?\s*business\s+overview\b/i`. The
/// optional prefix starts with "i" or "4" and the rest with "b", so a
/// prefix that matched is never undone by backtracking.
fn is_overview_heading(text: &str) -> bool {
	let rest = item_four(text).map_or(text, |after| {
		let after = spaces(after);
		spaces(after.strip_prefix('.').unwrap_or(after))
	});
	let Some(rest) = strip_ascii_ci(rest, "b") else {
		return false;
	};
	let rest = spaces(heading_punctuation(spaces(rest)));
	strip_ascii_ci(rest, "business")
		.and_then(spaces1)
		.and_then(|rest| strip_ascii_ci(rest, "overview"))
		.is_some_and(word_ends)
}

/// `/^item\s*4\s*[.:\-–—]?\s*information\s+on\s+(?:the|our)\s+company\b/i`.
fn is_company_heading(text: &str) -> bool {
	let Some(rest) = strip_ascii_ci(text, "item").and_then(|rest| spaces(rest).strip_prefix('4'))
	else {
		return false;
	};
	let mut rest = spaces(heading_punctuation(spaces(rest)));
	for word in ["information", "on"] {
		let Some(after) = strip_ascii_ci(rest, word).and_then(spaces1) else {
			return false;
		};
		rest = after;
	}
	let Some(rest) = strip_ascii_ci(rest, "the")
		.or_else(|| strip_ascii_ci(rest, "our"))
		.and_then(spaces1)
	else {
		return false;
	};
	strip_ascii_ci(rest, "company").is_some_and(word_ends)
}

/// `TWENTY_F_END_HEADINGS`: `/^(?:item\s*)?4\s*\.?\s*[cd]\b/i`,
/// `/^[cd]\s*[.:\-–—]\s*(?:organi[sz]ational\s+structure|propert(?:y|ies))\b/i`
/// and `/^item\s*(?:4a|5)\b/i`.
fn is_twenty_f_end_heading(text: &str) -> bool {
	let sub_item = item_four(text).is_some_and(|after| {
		let after = spaces(after);
		let after = spaces(after.strip_prefix('.').unwrap_or(after));
		(strip_ascii_ci(after, "c").or_else(|| strip_ascii_ci(after, "d"))).is_some_and(word_ends)
	});
	let titled = strip_ascii_ci(text, "c")
		.or_else(|| strip_ascii_ci(text, "d"))
		.and_then(|rest| spaces(rest).strip_prefix(&['.', ':', '-', '–', '—'][..]))
		.is_some_and(|rest| {
			let rest = spaces(rest);
			let organizational = strip_ascii_ci(rest, "organi")
				.and_then(|rest| rest.strip_prefix(&['s', 'S', 'z', 'Z'][..]))
				.and_then(|rest| strip_ascii_ci(rest, "ational"))
				.and_then(spaces1)
				.and_then(|rest| strip_ascii_ci(rest, "structure"))
				.is_some_and(word_ends);
			let property = strip_ascii_ci(rest, "propert").is_some_and(|rest| {
				strip_ascii_ci(rest, "y").is_some_and(word_ends)
					|| strip_ascii_ci(rest, "ies").is_some_and(word_ends)
			});
			organizational || property
		});
	let item = strip_ascii_ci(text, "item").is_some_and(|rest| {
		let rest = spaces(rest);
		strip_ascii_ci(rest, "4a").is_some_and(word_ends)
			|| rest.strip_prefix('5').is_some_and(word_ends)
	});
	sub_item || titled || item
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

/// `/^business\.?$/i`: the title of a start heading split from its bare "Item 1.".
fn is_split_start_title(text: &str) -> bool {
	strip_ascii_ci(text, "business").is_some_and(|rest| rest.is_empty() || rest == ".")
}

/// `/^risk\s+factors\.?$/i`: Item 1A's title where a 10-K writes no item numbers.
fn is_bare_end_title(text: &str) -> bool {
	strip_ascii_ci(text, "risk")
		.and_then(spaces1)
		.and_then(|rest| strip_ascii_ci(rest, "factors"))
		.is_some_and(|rest| rest.is_empty() || rest == ".")
}

/// `/^item\s*4\.?$/i`.
fn is_bare_item_four(text: &str) -> bool {
	strip_ascii_ci(text, "item")
		.and_then(|rest| spaces(rest).strip_prefix('4'))
		.is_some_and(|rest| rest.is_empty() || rest == ".")
}

/// An ASCII case-insensitive substring (`/form 10-k/i`, `/form 20-f/i`, `/by reference/i`).
fn contains_ascii_ci(text: &str, needle: &str) -> bool {
	text.as_bytes()
		.windows(needle.len())
		.any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
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
	split_blocks(markdown)
		.into_iter()
		.map(sec_block)
		.flat_map(|block| {
			if !block.table {
				if let Some((heading, body)) = block.text.split_once(". ") {
					if heading.starts_with("ABOUT ")
						&& is_about_heading(&heading.to_ascii_lowercase())
						&& heading.chars().all(|c| !c.is_ascii_lowercase())
					{
						return vec![
							SecBlock {
								text: format!("{heading}."),
								table: false,
							},
							SecBlock {
								text: body.to_owned(),
								table: false,
							},
						];
					}
				}
			}
			vec![block]
		})
		.collect()
}

/// `secSectionMark`: what a block is to the search for one section
/// (ADR-0053 §3, ADR-0058 §5), read without italic `*` markers
/// ("Item 1. *Business*").
#[must_use]
pub fn sec_section_mark(text: &str, section: SecBusinessSection) -> SectionMark {
	let plain = text.replace('*', "");
	let text = plain.as_str();
	let length = utf16_len(text);
	let start = match section {
		SecBusinessSection::TenKItemOne => is_start_heading(text),
		SecBusinessSection::TwentyFItemFourB => is_overview_heading(text),
		SecBusinessSection::TwentyFItemFour => is_company_heading(text),
	};
	let end = || match section {
		SecBusinessSection::TenKItemOne => is_end_heading(text),
		SecBusinessSection::TwentyFItemFourB | SecBusinessSection::TwentyFItemFour => {
			is_twenty_f_end_heading(text)
		}
	};
	if length <= MAX_START_CHARS && start {
		SectionMark::Start
	} else if length <= MAX_END_CHARS && end() {
		SectionMark::End
	} else {
		SectionMark::Other
	}
}

/// `secSectionMarks`: every block's mark for one section — `sec_section_mark`,
/// and in a 10-K a "Business" block right after a bare "Item 1." block also
/// starts the section (the heading split in two). A 10-K with no start
/// heading at all (item numbers only in its table of contents: Morgan
/// Stanley, Cardinal Health) starts at a bare "Business" block and ends at a
/// bare "Risk Factors" block, table rows aside.
#[must_use]
pub fn sec_section_marks(blocks: &[SecBlock], section: SecBusinessSection) -> Vec<SectionMark> {
	let mut marks: Vec<SectionMark> = blocks
		.iter()
		.map(|block| sec_section_mark(&block.text, section))
		.collect();
	if section == SecBusinessSection::TenKItemOne {
		for (index, pair) in blocks.windows(2).enumerate() {
			if let [previous, block] = pair {
				if is_bare_item_one(&previous.text) && is_split_start_title(&block.text) {
					if let Some(mark) = marks.get_mut(index + 1) {
						*mark = SectionMark::Start;
					}
				}
			}
		}
		if !blocks
			.iter()
			.zip(&marks)
			.any(|(block, mark)| !block.table && *mark == SectionMark::Start)
		{
			let report_marks: Vec<SectionMark> = blocks
				.iter()
				.map(|block| {
					if block.table {
						return SectionMark::Other;
					}
					let lower = block.text.to_ascii_lowercase();
					if lower == "our business"
						|| lower == "business summary"
						|| is_about_heading(&lower)
					{
						SectionMark::Start
					} else if lower.starts_with("management’s discussion and analysis")
						|| lower.starts_with("management's discussion and analysis")
						|| lower.starts_with("risk factors")
					{
						SectionMark::End
					} else {
						SectionMark::Other
					}
				})
				.collect();
			if report_marks.contains(&SectionMark::Start) {
				return report_marks;
			}
		}
		if !marks.contains(&SectionMark::Start) {
			for (block, mark) in blocks.iter().zip(marks.iter_mut()) {
				if block.table {
					continue;
				}
				if is_split_start_title(&block.text) {
					*mark = SectionMark::Start;
				} else if is_bare_end_title(&block.text) {
					*mark = SectionMark::End;
				}
			}
		}
	}
	marks
}

/// A block of the section that is page furniture, not description (rule 3).
fn is_furniture(block: &SecBlock, form: SecDescribedForm) -> bool {
	let text = block.text.as_str();
	if block.table
		|| text.is_empty()
		|| text.bytes().all(|byte| byte.is_ascii_digit())
		|| (text.len() >= 3 && text.bytes().all(|byte| byte == b'-'))
		|| text.eq_ignore_ascii_case("table of contents")
		|| is_part_heading(text)
	{
		return true;
	}
	let length = utf16_len(text);
	match form {
		SecDescribedForm::TenK => {
			is_bare_item_one(text)
				// A start heading repeated as a running page header ("ITEM 1 | Business", AIG).
				|| (length <= MAX_START_CHARS && is_start_heading(text))
				|| (length < MAX_FOOTER_CHARS && contains_ascii_ci(text, "form 10-k"))
		}
		SecDescribedForm::TwentyF => {
			is_bare_item_four(text)
				|| (length < MAX_FOOTER_CHARS && contains_ascii_ci(text, "form 20-f"))
				|| (length < MAX_CROSS_REFERENCE_CHARS && contains_ascii_ci(text, "by reference"))
		}
	}
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

/// `secBusinessBlocks`: the cleaned blocks of the form's business section
/// (rules 1–3) — the first of its sections the document has with a body —
/// or `None` when it has none.
#[must_use]
pub fn sec_business_blocks(markdown: &str, form: SecDescribedForm) -> Option<Vec<String>> {
	let blocks = sec_markdown_blocks(markdown);
	let sizes: Vec<u64> = blocks
		.iter()
		.map(|block| u64::try_from(utf16_len(&block.text)).unwrap_or(u64::MAX))
		.collect();
	let bounds = form.sections().iter().find_map(|section| {
		business_section_bounds(&sec_section_marks(&blocks, *section), &sizes)
	})?;
	let texts: Vec<String> = blocks
		.into_iter()
		.take(bounds.end)
		.skip(bounds.start + 1)
		.filter(|block| !is_furniture(block, form))
		.map(|block| block.text)
		.collect();
	let start = preamble_end(&texts);
	Some(texts.into_iter().skip(start).collect())
}

/// `secBusinessParagraphs`: the stored paragraphs of a 10-K's or 20-F's
/// business section; no paragraphs when the document has none that could
/// be read (the description is then "not-found").
#[must_use]
pub fn sec_business_paragraphs(markdown: &str, form: SecDescribedForm) -> BusinessParagraphs {
	match sec_business_blocks(markdown, form) {
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
			"Items 1. and 2. Business and Properties.",
			"Item 1. *Business*",
		] {
			assert_eq!(
				sec_section_mark(start, SecBusinessSection::TenKItemOne),
				SectionMark::Start,
				"{start}"
			);
		}
		for end in [
			"Item 1A",
			"ITEM 1A. RISK FACTORS",
			"Item 2. Properties",
			"Item 3",
		] {
			assert_eq!(
				sec_section_mark(end, SecBusinessSection::TenKItemOne),
				SectionMark::End,
				"{end}"
			);
		}
		for other in [
			"Item 1",
			"Item 12. Business Combinations",
			"Item 1 Businesses",
			"Item 10",
			"Item 1A Business",
		] {
			assert_ne!(
				sec_section_mark(other, SecBusinessSection::TenKItemOne),
				SectionMark::Start,
				"{other}"
			);
		}
		assert_eq!(
			sec_section_mark("Item 20", SecBusinessSection::TenKItemOne),
			SectionMark::Other
		);
	}

	#[test]
	fn twenty_f_headings_are_marked_like_the_typescript_patterns() {
		use SecBusinessSection::{TwentyFItemFour, TwentyFItemFourB};
		for (text, section) in [
			("Item 4.B Business Overview", TwentyFItemFourB),
			("4B. Business overview", TwentyFItemFourB),
			("B. Business Overview", TwentyFItemFourB),
			("Item 4. B. Business Overview", TwentyFItemFourB),
			("item4bbusiness overview", TwentyFItemFourB),
			("Item 4. Information on the Company", TwentyFItemFour),
			("ITEM 4 — INFORMATION ON THE COMPANY", TwentyFItemFour),
			("Item 4. Information On Our Company", TwentyFItemFour),
		] {
			assert_eq!(
				sec_section_mark(text, section),
				SectionMark::Start,
				"{text}"
			);
		}
		for end in [
			"Item 4.C Organizational Structure",
			"4.D Property, plants and equipment",
			"4D",
			"C. Organisational structure",
			"D. Properties",
			"Item 4A. Unresolved Staff Comments",
			"Item 5",
		] {
			assert_eq!(
				sec_section_mark(end, TwentyFItemFourB),
				SectionMark::End,
				"{end}"
			);
		}
		for other in [
			"Item 4",
			"Item 4.A History",
			"Business Overview",
			"B. Business Overviews",
			"Item b Business Overview",
			"C. Organizational",
			"D. Propertyless",
			"Item 40",
			"Item 4E",
		] {
			assert_eq!(
				sec_section_mark(other, TwentyFItemFourB),
				SectionMark::Other,
				"{other}"
			);
		}
	}

	#[test]
	fn a_start_heading_split_from_its_bare_item_one_starts_the_section() {
		let body =
			"The Company is a financial holding company with banking offices in three states.";
		let markdown = [
			"Item 1. Business",
			"Item 1A. Risk Factors",
			"PART I",
			"Item 1.",
			"Business",
			"Overview",
			body,
			"Item 1A.",
			"Risk Factors",
		]
		.join("\n\n");
		assert_eq!(
			sec_business_blocks(&markdown, SecDescribedForm::TenK),
			Some(vec!["Overview".to_owned(), body.to_owned()])
		);
		// A longer body after a lookalike is not read while the 10-K has an Item 1 heading.
		let longer = [body, body, body].join(" ");
		for lookalike in [["Item 1.", "Businesses"], ["Item 2.", "Business"]] {
			let markdown = [
				"Item 1. Business",
				body,
				"Item 1A",
				lookalike[0],
				lookalike[1],
				longer.as_str(),
				"Item 2",
			]
			.join("\n\n");
			assert_eq!(
				sec_business_blocks(&markdown, SecDescribedForm::TenK),
				Some(vec![body.to_owned()])
			);
		}
	}

	#[test]
	fn a_ten_k_with_item_numbers_only_in_its_contents_starts_at_a_bare_business() {
		let body = "We are a global financial services firm.";
		let risk = "Our results can be affected by many factors.";
		let markdown = [
			"| Table of Contents | Part | Item | Page |",
			"| --- | --- | --- | --- |",
			"| Business | I | 1 | 5 |",
			"| Business |  |  |",
			"Business",
			"Overview",
			body,
			"Risk Factors",
			risk,
		]
		.join("\n\n");
		assert_eq!(
			sec_business_blocks(&markdown, SecDescribedForm::TenK),
			Some(vec!["Overview".to_owned(), body.to_owned()])
		);
		let with_item_one = [
			"Item 1. Business",
			risk,
			"Item 1A",
			"Business",
			body,
			"Risk Factors",
		]
		.join("\n\n");
		assert_eq!(
			sec_business_blocks(&with_item_one, SecDescribedForm::TenK),
			Some(vec![risk.to_owned()])
		);
		let table_row = ["| Business |", body, "Risk Factors"].join("\n\n");
		assert_eq!(
			sec_business_blocks(&table_row, SecDescribedForm::TenK),
			None
		);
	}

	#[test]
	fn item_one_after_part_one_with_a_pipe_or_as_description_of_business() {
		let body = "We are a global financial services firm.";
		let risk = "Our results can be affected by many factors.";
		for heading in [
			"Part I. Item 1. Business",
			"ITEM 1 | Business",
			"| Item 1. | Description of Business |",
		] {
			let markdown = [
				heading,
				body,
				heading,
				risk,
				"Part I. Item 1A. Risk Factors",
			]
			.join("\n\n");
			assert_eq!(
				sec_business_blocks(&markdown, SecDescribedForm::TenK),
				Some(vec![body.to_owned(), risk.to_owned()]),
				"{heading}"
			);
		}
		assert!(!is_start_heading("Part II. Item 1. Business"));
		assert!(!is_start_heading("Item 1. Description of Properties"));
		assert!(is_end_heading("Part I, Item 1A"));
		assert!(is_bare_end_title("Risk  Factors."));
		assert!(!is_bare_end_title("Risk Factors Summary"));
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
