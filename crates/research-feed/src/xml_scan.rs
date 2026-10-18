//! Tokenising pieces of fast-xml-parser 5.11.2 shared by the two tree
//! builders of this crate ([`crate::tree`] for feeds, [`crate::info_table`]
//! for SEC information tables): newline normalisation, reserved-name
//! handling, the tag-expression scanner and the DOCTYPE reader.
//!
//! TECH DEBT: the two parse loops are still separate copies that differ in
//! their options (attributes, namespace prefixes, CDATA, nesting limit); one
//! options-driven loop should replace them when the feed port is next opened.

use crate::names::is_qname;
use crate::tree::ParseError;
use crate::units::{
	APOS, CR, DASH, GT, LBRACKET, LF, LPAREN, LT, PERCENT, QUOTE, RPAREN, SPACE, TAB, at, is,
	is_js_space, starts_with_ascii, substring, to_string,
};

/// `xmlData.replace(/\r\n?/g, "\n")`.
pub(crate) fn normalize_newlines(text: &[u16]) -> Vec<u16> {
	let mut out = Vec::with_capacity(text.len());
	let mut index = 0;
	while let Some(unit) = at(text, index) {
		if unit == CR {
			out.push(LF);
			if is(text, index + 1, LF) {
				index += 1;
			}
		} else {
			out.push(unit);
		}
		index += 1;
	}
	out
}

/// Names that would reach `Object.prototype` (`criticalProperties` throw,
/// `DANGEROUS_PROPERTY_NAMES` are renamed with a `__` prefix).
pub(crate) fn sanitize_name(name: &str) -> Result<String, ParseError> {
	const CRITICAL: [&str; 3] = ["__proto__", "constructor", "prototype"];
	const DANGEROUS: [&str; 7] = [
		"hasOwnProperty",
		"toString",
		"valueOf",
		"__defineGetter__",
		"__defineSetter__",
		"__lookupGetter__",
		"__lookupSetter__",
	];
	if CRITICAL.contains(&name) {
		return Err(ParseError);
	}
	if DANGEROUS.contains(&name) {
		return Ok(format!("__{name}"));
	}
	Ok(name.to_owned())
}

/// `tagExpWithClosingIndex`: the tag expression up to `closing` outside
/// quotes, with tabs outside quotes turned into spaces; the index of the
/// closing sequence.
pub(crate) fn tag_exp_with_closing_index(
	data: &[u16],
	start: usize,
	closing: &[u8],
) -> Option<(Vec<u16>, usize)> {
	let close0 = u16::from(*closing.first()?);
	let close1 = closing.get(1).map(|&byte| u16::from(byte));
	let mut boundary: Option<u16> = None;
	let mut result = Vec::new();
	let mut segment_start = start;
	let mut index = start;
	while let Some(code) = at(data, index) {
		if let Some(open) = boundary {
			if code == open {
				boundary = None;
			}
		} else if code == QUOTE || code == APOS {
			boundary = Some(code);
		} else if code == close0 {
			if close1.is_none_or(|second| is(data, index + 1, second)) {
				result.extend_from_slice(data.get(segment_start..index).unwrap_or_default());
				return Some((result, index));
			}
		} else if code == TAB {
			result.extend_from_slice(data.get(segment_start..index).unwrap_or_default());
			result.push(SPACE);
			segment_start = index + 1;
		}
		index += 1;
	}
	None
}

/* ---------- DocTypeReader ---------- */

fn skip_spaces(data: &[u16], mut index: usize) -> usize {
	while at(data, index).is_some_and(is_js_space) {
		index += 1;
	}
	index
}

/// `hasSeq(data, seq, i)`: `seq` starts one unit after `i`.
fn has_seq(data: &[u16], seq: &[u8], index: usize) -> bool {
	starts_with_ascii(data, index + 1, seq)
}

/// JavaScript `toUpperCase` of `substring(start, start + 6)`.
fn upper_six(data: &[u16], start: usize) -> String {
	to_string(substring(data, start, start + 6)).to_uppercase()
}

/// `readIdentifierVal`: a quoted literal at `index`; the index after it and
/// whether it was empty.
fn read_identifier(data: &[u16], index: usize) -> Result<(usize, bool), ParseError> {
	let quote = at(data, index)
		.filter(|&unit| unit == QUOTE || unit == APOS)
		.ok_or(ParseError)?;
	let start = index + 1;
	let mut end = start;
	while at(data, end).is_some_and(|unit| unit != quote) {
		end += 1;
	}
	if !is(data, end, quote) {
		return Err(ParseError);
	}
	Ok((end + 1, end == start))
}

/// A name up to white space (and, for entities, up to a quote).
fn read_name(data: &[u16], start: usize, stop_at_quote: bool) -> (usize, &[u16]) {
	let mut end = start;
	while at(data, end).is_some_and(|unit| {
		!is_js_space(unit) && !(stop_at_quote && (unit == QUOTE || unit == APOS))
	}) {
		end += 1;
	}
	(end, data.get(start..end).unwrap_or_default())
}

fn read_entity(data: &[u16], start: usize) -> Result<usize, ParseError> {
	let (index, name) = read_name(data, skip_spaces(data, start), true);
	if !is_qname(name) {
		return Err(ParseError);
	}
	let index = skip_spaces(data, index);
	// External and parameter entities are refused (XXE).
	if upper_six(data, index) == "SYSTEM" || is(data, index, PERCENT) {
		return Err(ParseError);
	}
	let (after, _) = read_identifier(data, index)?;
	Ok(after - 1)
}

fn read_element(data: &[u16], start: usize) -> Result<usize, ParseError> {
	let (index, name) = read_name(data, skip_spaces(data, start), false);
	if !is_qname(name) {
		return Err(ParseError);
	}
	let mut index = skip_spaces(data, index);
	if is(data, index, u16::from(b'E')) && has_seq(data, b"MPTY", index) {
		index += 4;
	} else if is(data, index, u16::from(b'A')) && has_seq(data, b"NY", index) {
		index += 2;
	} else if is(data, index, LPAREN) {
		index += 1;
		while at(data, index).is_some_and(|unit| unit != RPAREN) {
			index += 1;
		}
		if !is(data, index, RPAREN) {
			return Err(ParseError);
		}
	} else {
		return Err(ParseError);
	}
	Ok(index)
}

fn read_notation(data: &[u16], start: usize) -> Result<usize, ParseError> {
	let (index, name) = read_name(data, skip_spaces(data, start), false);
	if !is_qname(name) {
		return Err(ParseError);
	}
	let index = skip_spaces(data, index);
	let kind = upper_six(data, index);
	if kind != "SYSTEM" && kind != "PUBLIC" {
		return Err(ParseError);
	}
	let mut index = skip_spaces(data, index + 6);
	if kind == "PUBLIC" {
		index = read_identifier(data, index)?.0;
		index = skip_spaces(data, index);
		if matches!(at(data, index), Some(QUOTE | APOS)) {
			index = read_identifier(data, index)?.0;
		}
	} else {
		let (after, empty) = read_identifier(data, index)?;
		if empty {
			return Err(ParseError);
		}
		index = after;
	}
	Ok(index - 1)
}

/// `readDocType` with `start` at the `<` of `<!D…`: the index of the `>`
/// that closes the declaration. Entities are read (and validated) but never
/// stored or expanded: entity processing is off.
pub(crate) fn read_doc_type(data: &[u16], start: usize) -> Result<usize, ParseError> {
	if !starts_with_ascii(data, start + 3, b"OCTYPE") {
		return Err(ParseError);
	}
	let mut i = start + 9;
	let mut angle_brackets = 1i64;
	let mut has_body = false;
	let mut comment = false;
	let mut quote: Option<u16> = None;
	while let Some(unit) = at(data, i) {
		// Inside a quoted external-identifier literal '<' and '>' are data.
		if let Some(open) = quote {
			if unit == open {
				quote = None;
			}
			i += 1;
			continue;
		}
		if !has_body && !comment && (unit == QUOTE || unit == APOS) {
			quote = Some(unit);
			i += 1;
			continue;
		}
		if unit == LT && !comment {
			if has_body && has_seq(data, b"!ENTITY", i) {
				i = read_entity(data, i + 8)?;
			} else if has_body && has_seq(data, b"!ELEMENT", i) {
				i = read_element(data, i + 9)?;
			} else if has_body && has_seq(data, b"!ATTLIST", i) {
				i += 8;
			} else if has_body && has_seq(data, b"!NOTATION", i) {
				i = read_notation(data, i + 10)?;
			} else if has_seq(data, b"!--", i) {
				comment = true;
			} else {
				return Err(ParseError);
			}
			angle_brackets += 1;
		} else if unit == GT {
			if comment {
				if i >= 2 && is(data, i - 1, DASH) && is(data, i - 2, DASH) {
					comment = false;
					angle_brackets -= 1;
				}
			} else {
				angle_brackets -= 1;
			}
			if angle_brackets == 0 {
				break;
			}
		} else if unit == LBRACKET {
			has_body = true;
		}
		i += 1;
	}
	if quote.is_some() || angle_brackets != 0 {
		return Err(ParseError);
	}
	Ok(i)
}
