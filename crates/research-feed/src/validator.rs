//! Port of fast-xml-parser 5.11.2 `XMLValidator.validate` (`src/validator.js`)
//! with the options the feed parser uses (`allowBooleanAttributes: false`,
//! no unpaired tags). Only the verdict matters to the feed parser
//! (`validate(text) !== true` → `NOT_A_FEED`), so error objects are not built.
//!
//! The acceptance set is the library's, not XML's: multiple self-closing
//! root elements are accepted, an unterminated comment or PI at the end is
//! accepted, `&name` at the very end is accepted, DOCTYPE internal subsets
//! are skipped by bracket counting. Every loop below mirrors the original's
//! index arithmetic, including its `i--`/`continue` steps.

use crate::names::is_name;
use crate::units::{
	AMP, APOS, BANG, BOM, CR, DASH, EQ, GT, HASH, LF, LT, QUESTION, QUOTE, RBRACKET, SEMI, SLASH,
	SPACE, TAB, at, is, starts_with_ascii, trim,
};
use std::collections::HashSet;

/// The validator's own white space: space, tab, LF, CR.
const fn is_white_space(unit: Option<u16>) -> bool {
	matches!(unit, Some(SPACE | TAB | LF | CR))
}

/// `true` exactly when fast-xml-parser's `XMLValidator.validate(text)`
/// returns `true`.
#[must_use]
pub fn is_valid_xml(text: &[u16]) -> bool {
	let data = match text.split_first() {
		Some((&BOM, rest)) => rest,
		_ => text,
	};
	validate(data).unwrap_or(false)
}

/// `Some(true)` = valid; `None`/`Some(false)` = an error object.
fn validate(data: &[u16]) -> Option<bool> {
	let len = data.len();
	let mut tags: Vec<&[u16]> = Vec::new();
	let mut tag_found = false;
	// The root tag has been closed (depth 0 reached).
	let mut reached_root = false;
	let mut i = 0usize;
	while i < len {
		if is(data, i, LT) && is(data, i + 1, QUESTION) {
			i = read_pi(data, i + 2)?;
		} else if is(data, i, LT) {
			i += 1;
			if is(data, i, BANG) {
				i = read_comment_and_cdata(data, i);
				i += 1;
				continue;
			}
			let mut closing_tag = false;
			if is(data, i, SLASH) {
				closing_tag = true;
				i += 1;
			}
			let name_start = i;
			while i < len && !matches!(at(data, i), Some(GT | SPACE | TAB | LF | CR)) {
				i += 1;
			}
			let mut tag_name = trim(data.get(name_start..i).unwrap_or_default());
			if tag_name.last() == Some(&SLASH) {
				// Self-closing tag without attributes.
				tag_name = tag_name.get(..tag_name.len() - 1).unwrap_or_default();
				i = i.saturating_sub(1);
			}
			if !is_name(tag_name) {
				return Some(false);
			}
			let (mut attr_str, index, tag_closed) = read_attribute_str(data, i)?;
			i = index;
			if attr_str.last() == Some(&SLASH) {
				// Self-closing tag.
				attr_str = attr_str.get(..attr_str.len() - 1).unwrap_or_default();
				if !validate_attribute_string(attr_str) {
					return Some(false);
				}
				tag_found = true;
			} else if closing_tag {
				if !tag_closed || !trim(attr_str).is_empty() {
					return Some(false);
				}
				let opened = tags.pop()?;
				if tag_name != opened {
					return Some(false);
				}
				if tags.is_empty() {
					reached_root = true;
				}
			} else {
				if !validate_attribute_string(attr_str) || reached_root {
					return Some(false);
				}
				tags.push(tag_name);
				tag_found = true;
			}
			// Skip the tag's text value (it may include comments and CDATA).
			i += 1;
			while i < len {
				if is(data, i, LT) {
					if is(data, i + 1, BANG) {
						i = read_comment_and_cdata(data, i + 1);
						i += 1;
						continue;
					} else if is(data, i + 1, QUESTION) {
						i = read_pi(data, i + 1)?;
					} else {
						break;
					}
				} else if is(data, i, AMP) {
					i = validate_ampersand(data, i)?;
				} else if reached_root && !is_white_space(at(data, i)) {
					// Extra text at the end.
					return Some(false);
				}
				i += 1;
			}
			if is(data, i, LT) {
				i = i.saturating_sub(1);
			}
		} else if !is_white_space(at(data, i)) {
			return Some(false);
		}
		i += 1;
	}
	Some(tag_found && tags.is_empty())
}

/// `readPI`: skips a processing instruction starting at `start` (after
/// `<?`). `None` for an XML declaration that is not at the start.
fn read_pi(data: &[u16], start: usize) -> Option<usize> {
	let mut i = start;
	while i < data.len() {
		if matches!(at(data, i), Some(QUESTION | SPACE)) {
			let target = data.get(start..i).unwrap_or_default();
			if i > 5 && starts_with_ascii(target, 0, b"xml") && target.len() == 3 {
				return None;
			} else if is(data, i, QUESTION) && is(data, i + 1, GT) {
				i += 1;
				break;
			}
		}
		i += 1;
	}
	Some(i)
}

/// `readCommentAndCDATA` with `i` at the `!`.
fn read_comment_and_cdata(data: &[u16], start: usize) -> usize {
	let len = data.len();
	let mut i = start;
	if len > i + 5 && is(data, i + 1, DASH) && is(data, i + 2, DASH) {
		i += 3;
		while i < len {
			if is(data, i, DASH) && is(data, i + 1, DASH) && is(data, i + 2, GT) {
				i += 2;
				break;
			}
			i += 1;
		}
	} else if len > i + 8 && starts_with_ascii(data, i + 1, b"DOCTYPE") {
		let mut angle_brackets = 1usize;
		i += 8;
		while i < len {
			if is(data, i, LT) {
				angle_brackets += 1;
			} else if is(data, i, GT) {
				angle_brackets -= 1;
				if angle_brackets == 0 {
					break;
				}
			}
			i += 1;
		}
	} else if len > i + 9 && starts_with_ascii(data, i + 1, b"[CDATA[") {
		i += 8;
		while i < len {
			if is(data, i, RBRACKET) && is(data, i + 1, RBRACKET) && is(data, i + 2, GT) {
				i += 2;
				break;
			}
			i += 1;
		}
	}
	i
}

/// `readAttributeStr`: everything up to the `>` outside quotes. `None` when
/// a quote is still open at the end.
fn read_attribute_str(data: &[u16], start: usize) -> Option<(&[u16], usize, bool)> {
	let mut quote: Option<u16> = None;
	let mut tag_closed = false;
	let mut i = start;
	while let Some(unit) = at(data, i) {
		if unit == QUOTE || unit == APOS {
			match quote {
				None => quote = Some(unit),
				// The other quote character inside a value is allowed.
				Some(open) if open != unit => {}
				Some(_) => quote = None,
			}
		} else if unit == GT && quote.is_none() {
			tag_closed = true;
			break;
		}
		i += 1;
	}
	if quote.is_some() {
		return None;
	}
	Some((data.get(start..i).unwrap_or_default(), i, tag_closed))
}

/// `validateAttributeString` over the tokens of `scanAttributeTokens`.
fn validate_attribute_string(attr: &[u16]) -> bool {
	let len = attr.len();
	let space = |index: usize| is_white_space(at(attr, index));
	let mut names: HashSet<&[u16]> = HashSet::new();
	let mut i = 0usize;
	while i < len {
		let token_start = i;
		while i < len && space(i) {
			i += 1;
		}
		if i >= len {
			break;
		}
		if is(attr, i, EQ) {
			// No name before this '=': the scanner retries one position later,
			// which lands on this same '=' until it starts there and steps
			// past it. Jumping straight past it is the same outcome without
			// the quadratic rescans.
			i += 1;
			continue;
		}
		let leading_space = i - token_start;
		let name_start = i;
		while i < len && !space(i) && !is(attr, i, EQ) {
			i += 1;
		}
		let name = attr.get(name_start..i).unwrap_or_default();
		let mut has_equals = false;
		let mut j = i;
		while j < len && space(j) {
			j += 1;
		}
		if is(attr, j, EQ) {
			has_equals = true;
			i = j + 1;
		}
		let mut has_value = false;
		let mut k = i;
		while k < len && space(k) {
			k += 1;
		}
		if let Some(quote @ (QUOTE | APOS)) = at(attr, k) {
			let value_start = k + 1;
			if let Some(close) = attr
				.get(value_start..)
				.and_then(|rest| rest.iter().position(|&unit| unit == quote))
			{
				has_value = true;
				i = value_start + close + 1;
			}
		}
		// No space before the name (a="1"b="2"), `a=` without a value, a
		// boolean attribute, an invalid name, a repeated name.
		if leading_space == 0
			|| (has_equals && !has_value)
			|| !has_equals
			|| !is_name(name)
			|| !names.insert(name)
		{
			return false;
		}
	}
	true
}

/// `validateAmpersand` with `i` at the `&`: the index of the `;` that ends
/// the reference (or the end of input), `None` when `&` is not expected.
fn validate_ampersand(data: &[u16], amp: usize) -> Option<usize> {
	let mut i = amp + 1;
	if is(data, i, SEMI) {
		return None;
	}
	if is(data, i, HASH) {
		i += 1;
		let hex = is(data, i, u16::from(b'x'));
		if hex {
			i += 1;
		}
		while let Some(unit) = at(data, i) {
			if unit == SEMI {
				return Some(i);
			}
			let digit = (0x30..=0x39).contains(&unit);
			let hex_letter = (0x41..=0x46).contains(&unit) || (0x61..=0x66).contains(&unit);
			if !(digit || (hex && hex_letter)) {
				break;
			}
			i += 1;
		}
		return None;
	}
	let mut count = 0usize;
	while let Some(unit) = at(data, i) {
		let word = unit == u16::from(b'_')
			|| (0x30..=0x39).contains(&unit)
			|| (0x41..=0x5A).contains(&unit)
			|| (0x61..=0x7A).contains(&unit);
		if word && count < 20 {
			i += 1;
			count += 1;
			continue;
		}
		if unit == SEMI {
			break;
		}
		return None;
	}
	Some(i)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn valid(text: &str) -> bool {
		is_valid_xml(&text.encode_utf16().collect::<Vec<_>>())
	}

	#[test]
	fn mirrors_the_library_acceptance_set() {
		assert!(valid("<r/><s/>"));
		assert!(!valid("<r></r><s></s>"));
		assert!(valid("<a>x &amp; y &#x41; &#65; &lol;</a>"));
		assert!(!valid("<a>A & B</a>"));
		assert!(!valid("<a x=\"1\" x=\"2\"/>"));
		assert!(!valid("<a x/>"));
		assert!(!valid("<br>"));
		assert!(!valid("<a></b>"));
		assert!(valid("<!DOCTYPE r [<!ENTITY e \"v\">]><r/>"));
		assert!(valid("\u{FEFF}<?xml version=\"1.0\"?><r/>"));
		assert!(!valid(" <?xml version=\"1.0\"?><r/>"));
		assert!(!valid(""));
		assert!(!valid("plain"));
		assert!(valid("<r/><!-- unterminated"));
		assert!(valid("<a><![FOO[x]]></a>"));
		assert!(!valid("<a>x</a>y"));
		assert!(valid("<a b='1' c=\"2\">t</a>"));
		assert!(!valid("<a b=\"1\"c=\"2\">t</a>"));
	}
}
