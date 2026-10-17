//! `toPlainText` and `decodeEntities` of `packages/domain/src/news/feed.ts`.
//!
//! The TypeScript is a chain of regex replacements:
//! 1. `/<(script|style)\b[\s\S]*?<\/\1\s*>/gi` → `" "`
//! 2. `INLINE_TAG` → `""`, then `/<[^>]*>/g` → `" "`
//! 3. `decodeEntities`
//! 4. `INLINE_TAG` → `""`, then `/<[^>]*>/g` → `" "` (decoding can reveal tags)
//! 5. `/\s+/g` → `" "`, `trim()`
//!
//! Each pass is a forward byte scan here (every pattern is ASCII-driven;
//! `\s` is JavaScript's set, matched on its UTF-8 bytes; `/i` is ASCII-only
//! as in a non-`u` JavaScript regex). Pass 1 uses precomputed closing-tag
//! positions, so hostile input stays linear where the regex is quadratic.
//!
//! Lone surrogates: `&#xD83D;` decodes to a lone UTF-16 surrogate in
//! JavaScript, and two halves that end up adjacent (`&#xD83D;&#xDE00;`, or
//! with a removed tag between them) form one real character. The buffer is
//! therefore WTF-8 (a surrogate is its 3-byte generalized UTF-8 form) until
//! the end, where adjacent halves are joined and the rest become U+FFFD —
//! exactly the well-formed view of the JavaScript result.

/// Names of U+00A0..U+00FF in code-point order (the HTML Latin-1 entity set).
const LATIN1_ENTITY_NAMES: [&str; 96] = [
	"nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect", "uml", "copy", "ordf",
	"laquo", "not", "shy", "reg", "macr", "deg", "plusmn", "sup2", "sup3", "acute", "micro",
	"para", "middot", "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
	"Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute",
	"Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml", "ETH", "Ntilde", "Ograve", "Oacute",
	"Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute",
	"THORN", "szlig", "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil",
	"egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml", "eth", "ntilde",
	"ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc",
	"uuml", "yacute", "thorn", "yuml",
];

/// The entries after the Latin-1 names; a later Map entry overrides an
/// earlier one (`nbsp` is a plain space, `shy` vanishes).
const OTHER_ENTITIES: &[(&str, &str)] = &[
	("amp", "&"),
	("lt", "<"),
	("gt", ">"),
	("quot", "\""),
	("apos", "'"),
	// Spaces collapse to one ordinary space; invisible joiners and soft hyphens vanish, so a
	// quoted passage still matches the text a reader sees.
	("nbsp", " "),
	("ensp", " "),
	("emsp", " "),
	("thinsp", " "),
	("shy", ""),
	("zwnj", ""),
	("zwj", ""),
	("lrm", ""),
	("rlm", ""),
	("ndash", "\u{2013}"),
	("mdash", "\u{2014}"),
	("lsquo", "\u{2018}"),
	("rsquo", "\u{2019}"),
	("sbquo", "\u{201a}"),
	("ldquo", "\u{201c}"),
	("rdquo", "\u{201d}"),
	("bdquo", "\u{201e}"),
	("dagger", "\u{2020}"),
	("Dagger", "\u{2021}"),
	("bull", "\u{2022}"),
	("hellip", "\u{2026}"),
	("permil", "\u{2030}"),
	("prime", "\u{2032}"),
	("Prime", "\u{2033}"),
	("lsaquo", "\u{2039}"),
	("rsaquo", "\u{203a}"),
	("euro", "\u{20ac}"),
	("trade", "\u{2122}"),
	("larr", "\u{2190}"),
	("uarr", "\u{2191}"),
	("rarr", "\u{2192}"),
	("darr", "\u{2193}"),
	("minus", "\u{2212}"),
	("asymp", "\u{2248}"),
	("ne", "\u{2260}"),
	("le", "\u{2264}"),
	("ge", "\u{2265}"),
	("OElig", "\u{0152}"),
	("oelig", "\u{0153}"),
	("Scaron", "\u{0160}"),
	("scaron", "\u{0161}"),
	("Yuml", "\u{0178}"),
];

/// The replacement for an entity name, as the `NAMED_ENTITIES` Map holds it.
fn named_entity(name: &[u8], out: &mut Vec<u8>) -> bool {
	if let Some((_, value)) = OTHER_ENTITIES
		.iter()
		.find(|(key, _)| key.as_bytes() == name)
	{
		out.extend_from_slice(value.as_bytes());
		return true;
	}
	if let Some(offset) = LATIN1_ENTITY_NAMES
		.iter()
		.position(|key| key.as_bytes() == name)
	{
		let code_point = 0xA0 + u32::try_from(offset).unwrap_or_default();
		push_code_point(out, code_point);
		return true;
	}
	false
}

/// Appends a code point as (generalized) UTF-8: a surrogate gets its 3-byte
/// WTF-8 form.
fn push_code_point(out: &mut Vec<u8>, code_point: u32) {
	if code_point < 0x80 {
		out.push(byte(code_point));
	} else if code_point < 0x800 {
		out.extend_from_slice(&[0xC0 | byte(code_point >> 6), 0x80 | byte(code_point & 0x3F)]);
	} else if code_point < 0x1_0000 {
		out.extend_from_slice(&[
			0xE0 | byte(code_point >> 12),
			0x80 | byte((code_point >> 6) & 0x3F),
			0x80 | byte(code_point & 0x3F),
		]);
	} else {
		out.extend_from_slice(&[
			0xF0 | byte(code_point >> 18),
			0x80 | byte((code_point >> 12) & 0x3F),
			0x80 | byte((code_point >> 6) & 0x3F),
			0x80 | byte(code_point & 0x3F),
		]);
	}
}

/// The low byte of a value already masked or shifted below 256.
fn byte(value: u32) -> u8 {
	u8::try_from(value & 0xFF).unwrap_or_default()
}

/// Length of the JavaScript white-space character (`\s`) at `index`, 0 if
/// there is none.
fn js_space_len(bytes: &[u8], index: usize) -> usize {
	match bytes.get(index..) {
		Some([0x09..=0x0D | 0x20, ..]) => 1,
		Some([0xC2, 0xA0, ..]) => 2,
		Some(
			[0xE1, 0x9A, 0x80, ..]
			| [0xE2, 0x80, 0x80..=0x8A | 0xA8 | 0xA9 | 0xAF, ..]
			| [0xE2, 0x81, 0x9F, ..]
			| [0xE3, 0x80, 0x80, ..]
			| [0xEF, 0xBB, 0xBF, ..],
		) => 3,
		_ => 0,
	}
}

const fn is_ascii_word(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `true` when `bytes[index..]` starts with `name`, ASCII case-insensitively.
fn starts_with_ignore_case(bytes: &[u8], index: usize, name: &[u8]) -> bool {
	bytes
		.get(index..index + name.len())
		.is_some_and(|slice| slice.eq_ignore_ascii_case(name))
}

/// Positions `(start, end)` of every `</name\s*>` (name ASCII
/// case-insensitive), in order.
fn closing_tags(bytes: &[u8], name: &[u8]) -> Vec<(usize, usize)> {
	let mut found = Vec::new();
	for start in memchr::memchr_iter(b'<', bytes) {
		if bytes.get(start + 1) != Some(&b'/') || !starts_with_ignore_case(bytes, start + 2, name) {
			continue;
		}
		let mut index = start + 2 + name.len();
		loop {
			let width = js_space_len(bytes, index);
			if width == 0 {
				break;
			}
			index += width;
		}
		if bytes.get(index) == Some(&b'>') {
			found.push((start, index + 1));
		}
	}
	found
}

/// Pass 1: `/<(script|style)\b[\s\S]*?<\/\1\s*>/gi` → `" "`.
fn remove_blocks(bytes: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(bytes.len());
	let names: [&[u8]; 2] = [b"script", b"style"];
	let closes = [closing_tags(bytes, names[0]), closing_tags(bytes, names[1])];
	// Searches start at increasing positions, so each cursor only moves forward.
	let mut cursors = [0usize; 2];
	let mut copied = 0usize;
	let mut index = 0usize;
	while let Some(offset) = bytes
		.get(index..)
		.and_then(|rest| memchr::memchr(b'<', rest))
	{
		let start = index + offset;
		let mut matched = None;
		for (which, name) in names.iter().enumerate() {
			let name_end = start + 1 + name.len();
			if !starts_with_ignore_case(bytes, start + 1, name)
				|| bytes.get(name_end).copied().is_some_and(is_ascii_word)
			{
				continue;
			}
			let (Some(list), Some(cursor)) = (closes.get(which), cursors.get_mut(which)) else {
				continue;
			};
			while list
				.get(*cursor)
				.is_some_and(|&(close_start, _)| close_start < name_end)
			{
				*cursor += 1;
			}
			if let Some(&(_, close_end)) = list.get(*cursor) {
				matched = Some(close_end);
			}
			break;
		}
		match matched {
			Some(end) => {
				out.extend_from_slice(bytes.get(copied..start).unwrap_or_default());
				out.push(b' ');
				copied = end;
				index = end;
			}
			None => index = start + 1,
		}
	}
	out.extend_from_slice(bytes.get(copied..).unwrap_or_default());
	out
}

/// `INLINE_TAG` alternatives in their regex order.
const INLINE_NAMES: [&[u8]; 12] = [
	b"a", b"abbr", b"b", b"cite", b"em", b"i", b"mark", b"small", b"strong", b"sub", b"sup", b"u",
];

/// The end of an `INLINE_TAG` match starting at the `<` at `start`:
/// `/<\/?(?:a|abbr|…|u)(?:\s[^>]*)?>/i`.
fn inline_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut name_start = start + 1;
	if bytes.get(name_start) == Some(&b'/') {
		name_start += 1;
	}
	for name in INLINE_NAMES {
		if !starts_with_ignore_case(bytes, name_start, name) {
			continue;
		}
		let after = name_start + name.len();
		if bytes.get(after) == Some(&b'>') {
			return Some(after + 1);
		}
		let width = js_space_len(bytes, after);
		if width > 0 {
			if let Some(offset) = bytes
				.get(after + width..)
				.and_then(|rest| memchr::memchr(b'>', rest))
			{
				return Some(after + width + offset + 1);
			}
		}
	}
	None
}

/// `text.replace(INLINE_TAG, "").replace(/<[^>]*>/g, " ")`.
fn strip_tags(bytes: &[u8]) -> Vec<u8> {
	let mut without_inline = Vec::with_capacity(bytes.len());
	let mut copied = 0usize;
	for start in memchr::memchr_iter(b'<', bytes) {
		if start < copied {
			continue;
		}
		if let Some(end) = inline_tag_end(bytes, start) {
			without_inline.extend_from_slice(bytes.get(copied..start).unwrap_or_default());
			copied = end;
		}
	}
	without_inline.extend_from_slice(bytes.get(copied..).unwrap_or_default());
	let mut out = Vec::with_capacity(without_inline.len());
	let mut copied = 0usize;
	let mut index = 0usize;
	while let Some(offset) = without_inline
		.get(index..)
		.and_then(|rest| memchr::memchr(b'<', rest))
	{
		let start = index + offset;
		// No '>' after this '<' means none after any later '<' either.
		let Some(close) = without_inline
			.get(start..)
			.and_then(|rest| memchr::memchr(b'>', rest))
		else {
			break;
		};
		out.extend_from_slice(without_inline.get(copied..start).unwrap_or_default());
		out.push(b' ');
		copied = start + close + 1;
		index = copied;
	}
	out.extend_from_slice(without_inline.get(copied..).unwrap_or_default());
	out
}

/// `decodeEntities`: `/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi`.
fn decode_entities(bytes: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(bytes.len());
	let mut copied = 0usize;
	let mut index = 0usize;
	while let Some(offset) = bytes
		.get(index..)
		.and_then(|rest| memchr::memchr(b'&', rest))
	{
		let start = index + offset;
		index = start + 1;
		let Some((body_end, kind)) = entity_body(bytes, start + 1) else {
			continue;
		};
		out.extend_from_slice(bytes.get(copied..start).unwrap_or_default());
		let body = bytes.get(start + 1..body_end).unwrap_or_default();
		match kind {
			EntityKind::Numeric { radix, digits_from } => {
				// `Number.parseInt` then `1 <= cp <= 0x10FFFF` (surrogates allowed).
				let digits = body.get(digits_from..).unwrap_or_default();
				if let Some(code_point) = parse_code_point(digits, radix) {
					push_code_point(&mut out, code_point);
				}
			}
			EntityKind::Named => {
				// Names are case-sensitive (&Eacute; is not &eacute;); the lower-case retry only
				// tolerates shouted markup escapes such as "&AMP;".
				if !named_entity(body, &mut out)
					&& !named_entity(&body.to_ascii_lowercase(), &mut out)
				{
					out.extend_from_slice(bytes.get(start..=body_end).unwrap_or_default());
				}
			}
		}
		copied = body_end + 1;
		index = copied;
	}
	out.extend_from_slice(bytes.get(copied..).unwrap_or_default());
	out
}

enum EntityKind {
	Numeric { radix: u32, digits_from: usize },
	Named,
}

/// The body of the entity starting at `start` (after the `&`): the index of
/// its `;` and its kind.
fn entity_body(bytes: &[u8], start: usize) -> Option<(usize, EntityKind)> {
	let run_end = |from: usize, accept: fn(&u8) -> bool| {
		from + bytes.get(from..).map_or(0, |rest| {
			rest.iter().take_while(|byte| accept(byte)).count()
		})
	};
	let first = *bytes.get(start)?;
	if first == b'#' {
		if bytes
			.get(start + 1)
			.is_some_and(|byte| byte.eq_ignore_ascii_case(&b'x'))
		{
			let end = run_end(start + 2, u8::is_ascii_hexdigit);
			if end > start + 2 && bytes.get(end) == Some(&b';') {
				return Some((
					end,
					EntityKind::Numeric {
						radix: 16,
						digits_from: 2,
					},
				));
			}
		}
		let end = run_end(start + 1, u8::is_ascii_digit);
		if end > start + 1 && bytes.get(end) == Some(&b';') {
			return Some((
				end,
				EntityKind::Numeric {
					radix: 10,
					digits_from: 1,
				},
			));
		}
		return None;
	}
	if !first.is_ascii_alphabetic() {
		return None;
	}
	let end = run_end(start + 1, u8::is_ascii_alphanumeric);
	(bytes.get(end) == Some(&b';')).then_some((end, EntityKind::Named))
}

/// The value of ASCII digits in `radix` if it is within 1..=0x10FFFF.
fn parse_code_point(digits: &[u8], radix: u32) -> Option<u32> {
	let mut value: u32 = 0;
	for &digit in digits {
		let digit = char::from(digit).to_digit(radix)?;
		value = value.checked_mul(radix)?.checked_add(digit)?;
		if value > 0x10_FFFF {
			return None;
		}
	}
	(value > 0).then_some(value)
}

/// `/\s+/g` → `" "`, then `trim()`.
fn collapse_and_trim(bytes: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0usize;
	let mut pending_space = false;
	while let Some(&current) = bytes.get(index) {
		let width = js_space_len(bytes, index);
		if width > 0 {
			pending_space = !out.is_empty();
			index += width;
			continue;
		}
		if pending_space {
			out.push(b' ');
			pending_space = false;
		}
		out.push(current);
		index += 1;
	}
	out
}

/// WTF-8 to UTF-8: adjacent surrogate halves become their character, a lone
/// half becomes U+FFFD.
fn into_string(bytes: Vec<u8>) -> String {
	match String::from_utf8(bytes) {
		Ok(text) => text,
		Err(error) => {
			let bytes = error.into_bytes();
			let mut out = Vec::with_capacity(bytes.len());
			let mut index = 0usize;
			while let Some(&current) = bytes.get(index) {
				if let Some(high) = surrogate_at(&bytes, index, 0xA0..=0xAF) {
					if let Some(low) = surrogate_at(&bytes, index + 3, 0xB0..=0xBF) {
						let code_point = 0x1_0000 + ((high - 0xD800) << 10) + (low - 0xDC00);
						push_code_point(&mut out, code_point);
						index += 6;
						continue;
					}
				}
				if surrogate_at(&bytes, index, 0xA0..=0xBF).is_some() {
					out.extend_from_slice("\u{FFFD}".as_bytes());
					index += 3;
					continue;
				}
				out.push(current);
				index += 1;
			}
			String::from_utf8(out)
				.unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
		}
	}
}

/// The surrogate code unit encoded at `index` (`ED xx yy` with `xx` in
/// `second`).
fn surrogate_at(bytes: &[u8], index: usize, second: std::ops::RangeInclusive<u8>) -> Option<u32> {
	match bytes.get(index..index + 3)? {
		[0xED, middle, last] if second.contains(middle) && (0x80..=0xBF).contains(last) => {
			Some(0xD000 | (u32::from(*middle & 0x3F) << 6) | u32::from(*last & 0x3F))
		}
		_ => None,
	}
}

/// `toPlainText`: reduces untrusted feed markup to plain text. The result is
/// only ever rendered as a text node, so this is about readability, not
/// about making HTML safe.
#[must_use]
pub fn to_plain_text(markup: &str) -> String {
	let bytes = markup.as_bytes();
	if memchr::memchr2(b'<', b'&', bytes).is_none() {
		return into_string(collapse_and_trim(bytes));
	}
	let without_tags = strip_tags(&remove_blocks(bytes));
	// Decoding can reveal a second layer of tags (e.g. "&lt;b&gt;"); strip those too.
	let decoded = decode_entities(&without_tags);
	into_string(collapse_and_trim(&strip_tags(&decoded)))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn mirrors_the_typescript_tests() {
		assert_eq!(
			to_plain_text("<p>Hello   <b>world</b></p>\n\n<br/>again"),
			"Hello world again"
		);
		assert_eq!(
			to_plain_text("Before<script>alert('x')</script>After"),
			"Before After"
		);
		assert_eq!(
			to_plain_text("A<STYLE type='text/css'>p { color: red }</STYLE >B"),
			"A B"
		);
		assert_eq!(to_plain_text("&#65;&#x42;&#X43;"), "ABC");
		assert_eq!(to_plain_text("A &AMP; B &LT; C"), "A & B < C");
		assert_eq!(
			to_plain_text("&constructor; &toString;"),
			"&constructor; &toString;"
		);
		assert_eq!(
			to_plain_text("x<article>y</article>z<bdi>w</bdi>"),
			"x y z w"
		);
		assert_eq!(to_plain_text("a&lt;b&gt;c&lt;/b&gt;d"), "acd");
		assert_eq!(to_plain_text("a&#0;b&#x110000;c"), "abc");
		assert_eq!(
			to_plain_text("infra&shy;structure a&nbsp;b"),
			"infrastructure a b"
		);
	}

	#[test]
	fn joins_surrogate_halves_like_javascript() {
		assert_eq!(to_plain_text("&#xD83D;&#xDE00;"), "😀");
		assert_eq!(to_plain_text("&#xD83D;<b>&#xDE00;"), "😀");
		assert_eq!(to_plain_text("&#xD83D; &#xDE00;"), "\u{FFFD} \u{FFFD}");
		assert_eq!(to_plain_text("&#xDE00;&#xD83D;"), "\u{FFFD}\u{FFFD}");
	}

	#[test]
	fn stays_linear_on_unclosed_blocks() {
		let hostile = "<script>".repeat(50_000);
		let started = std::time::Instant::now();
		assert_eq!(to_plain_text(&hostile), "");
		assert!(started.elapsed().as_millis() < 2000);
	}
}
