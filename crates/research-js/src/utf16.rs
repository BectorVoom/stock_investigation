//! String lengths and slices in UTF-16 code units, as JavaScript counts them.
//!
//! Every length limit in the TypeScript runner (`.length`, `.slice(0, n)`,
//! zod `.max(n)`) counts UTF-16 code units: an astral character such as an
//! emoji counts 2. These helpers make the same decisions on `&str`.

use std::borrow::Cow;

/// `text.length` in JavaScript: the number of UTF-16 code units.
#[must_use]
pub fn utf16_len(text: &str) -> usize {
	// ASCII-only text is the common case: one byte is one code unit.
	if text.is_ascii() {
		return text.len();
	}
	text.chars().map(char::len_utf16).sum()
}

/// Byte offset of the character boundary at or after UTF-16 offset `units`,
/// plus whether that offset fell inside a surrogate pair.
fn byte_offset(text: &str, units: usize) -> (usize, bool) {
	if text.is_ascii() {
		return (units.min(text.len()), false);
	}
	let mut seen = 0usize;
	for (index, character) in text.char_indices() {
		if seen == units {
			return (index, false);
		}
		let width = character.len_utf16();
		if seen + width > units {
			// `units` points between the two halves of a surrogate pair.
			return (index, true);
		}
		seen += width;
	}
	(text.len(), false)
}

/// `text.slice(start, end)` for non-negative indices, clamped like
/// JavaScript (an `end` before `start` gives the empty string).
///
/// When a boundary falls inside a surrogate pair, JavaScript keeps a lone
/// surrogate; this returns U+FFFD in its place (see the crate docs).
#[must_use]
pub fn slice(text: &str, start: usize, end: usize) -> Cow<'_, str> {
	if end <= start {
		return Cow::Borrowed("");
	}
	let (start_byte, start_split) = byte_offset(text, start);
	let (end_byte, end_split) = byte_offset(text, end);
	// A split start keeps the pair's low half; the character at `start_byte`
	// is that pair, so skip it and emit U+FFFD instead.
	let body_start = if start_split {
		text.get(start_byte..)
			.and_then(|rest| rest.chars().next())
			.map_or(start_byte, |pair| start_byte + pair.len_utf8())
	} else {
		start_byte
	};
	if !start_split && !end_split {
		return Cow::Borrowed(text.get(start_byte..end_byte).unwrap_or(""));
	}
	let mut sliced = String::new();
	if start_split {
		sliced.push('\u{FFFD}');
	}
	if body_start < end_byte {
		sliced.push_str(text.get(body_start..end_byte).unwrap_or(""));
	}
	if end_split {
		// The high half of the pair at `end_byte` is kept by JavaScript.
		sliced.push('\u{FFFD}');
	}
	Cow::Owned(sliced)
}

/// `text.slice(0, max)`: the first `max` UTF-16 code units.
#[must_use]
pub fn truncate(text: &str, max: usize) -> Cow<'_, str> {
	slice(text, 0, max)
}

/// The longest prefix of whole characters that fits in `max` UTF-16 code
/// units — the TypeScript `cutCodePoints` / `for (const ch of text)` idiom,
/// which never splits a surrogate pair.
#[must_use]
pub fn cut_code_points(text: &str, max: usize) -> &str {
	let (end, _) = boundary_at_or_before(text, max);
	text.get(..end).unwrap_or(text)
}

/// Byte offset of the last character boundary whose UTF-16 offset is at most
/// `units`, and that UTF-16 offset.
fn boundary_at_or_before(text: &str, units: usize) -> (usize, usize) {
	if text.is_ascii() {
		let end = units.min(text.len());
		return (end, end);
	}
	let mut seen = 0usize;
	for (index, character) in text.char_indices() {
		let width = character.len_utf16();
		if seen + width > units {
			return (index, seen);
		}
		seen += width;
	}
	(text.len(), seen)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn counts_astral_characters_as_two_units() {
		assert_eq!(utf16_len("abc"), 3);
		assert_eq!(utf16_len("é"), 1);
		assert_eq!(utf16_len("😀"), 2);
		assert_eq!(utf16_len("a😀b"), 4);
	}

	#[test]
	fn slices_like_javascript() {
		assert_eq!(slice("hello", 1, 3), "el");
		assert_eq!(slice("hello", 3, 1), "");
		assert_eq!(slice("hello", 2, 99), "llo");
		assert_eq!(slice("a😀b", 0, 3), "a😀");
		assert_eq!(slice("a😀b", 0, 2), "a\u{FFFD}");
		assert_eq!(slice("a😀b", 2, 4), "\u{FFFD}b");
		assert_eq!(slice("😀", 1, 2), "\u{FFFD}");
	}

	#[test]
	fn cuts_on_code_point_boundaries() {
		assert_eq!(cut_code_points("a😀b", 2), "a");
		assert_eq!(cut_code_points("a😀b", 3), "a😀");
		assert_eq!(cut_code_points("abc", 10), "abc");
	}
}
