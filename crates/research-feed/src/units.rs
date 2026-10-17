//! UTF-16 code-unit helpers. fast-xml-parser indexes JavaScript strings, so
//! the port works on the same code units to keep every index, `substring`
//! and `trim` decision identical.

pub(crate) const TAB: u16 = 0x09;
pub(crate) const LF: u16 = 0x0A;
pub(crate) const CR: u16 = 0x0D;
pub(crate) const SPACE: u16 = 0x20;
pub(crate) const BANG: u16 = 0x21;
pub(crate) const QUOTE: u16 = 0x22;
pub(crate) const HASH: u16 = 0x23;
pub(crate) const PERCENT: u16 = 0x25;
pub(crate) const AMP: u16 = 0x26;
pub(crate) const APOS: u16 = 0x27;
pub(crate) const LPAREN: u16 = 0x28;
pub(crate) const RPAREN: u16 = 0x29;
pub(crate) const DASH: u16 = 0x2D;
pub(crate) const SLASH: u16 = 0x2F;
pub(crate) const SEMI: u16 = 0x3B;
pub(crate) const LT: u16 = 0x3C;
pub(crate) const EQ: u16 = 0x3D;
pub(crate) const GT: u16 = 0x3E;
pub(crate) const QUESTION: u16 = 0x3F;
pub(crate) const LBRACKET: u16 = 0x5B;
pub(crate) const RBRACKET: u16 = 0x5D;
pub(crate) const BOM: u16 = 0xFEFF;

/// The unit at `index`, or `None` past the end (JavaScript's `undefined`).
#[inline]
pub(crate) fn at(units: &[u16], index: usize) -> Option<u16> {
	units.get(index).copied()
}

/// `true` when the unit at `index` is `wanted`.
#[inline]
pub(crate) fn is(units: &[u16], index: usize, wanted: u16) -> bool {
	units.get(index) == Some(&wanted)
}

/// `true` when `units[index..]` starts with the ASCII `text`.
pub(crate) fn starts_with_ascii(units: &[u16], index: usize, text: &[u8]) -> bool {
	units.get(index..).is_some_and(|rest| {
		rest.len() >= text.len()
			&& rest
				.iter()
				.zip(text)
				.all(|(&unit, &byte)| unit == u16::from(byte))
	})
}

/// JavaScript `\s` (and `trim`) for one code unit: every JS white-space and
/// line-terminator character is in the BMP.
#[inline]
pub(crate) const fn is_js_space(unit: u16) -> bool {
	matches!(
		unit,
		0x09..=0x0D
			| 0x20 | 0xA0
			| 0x1680 | 0x2000..=0x200A
			| 0x2028 | 0x2029
			| 0x202F | 0x205F
			| 0x3000 | 0xFEFF
	)
}

/// `text.trim()`.
pub(crate) fn trim(units: &[u16]) -> &[u16] {
	let start = units
		.iter()
		.position(|&unit| !is_js_space(unit))
		.unwrap_or(units.len());
	let end = units
		.iter()
		.rposition(|&unit| !is_js_space(unit))
		.map_or(start, |last| last + 1);
	units.get(start..end).unwrap_or_default()
}

/// `text.trimStart()`.
pub(crate) fn trim_start(units: &[u16]) -> &[u16] {
	let start = units
		.iter()
		.position(|&unit| !is_js_space(unit))
		.unwrap_or(units.len());
	units.get(start..).unwrap_or_default()
}

/// `text.indexOf(needle, from)` for an ASCII needle.
pub(crate) fn index_of(units: &[u16], needle: &[u8], from: usize) -> Option<usize> {
	let first = u16::from(*needle.first()?);
	let mut index = from;
	while index < units.len() {
		let offset = units.get(index..)?.iter().position(|&unit| unit == first)?;
		index += offset;
		if starts_with_ascii(units, index, needle) {
			return Some(index);
		}
		index += 1;
	}
	None
}

/// `text.substring(start, end)`: clamped to the length, arguments swapped
/// when `start > end`.
pub(crate) fn substring(units: &[u16], start: usize, end: usize) -> &[u16] {
	let start = start.min(units.len());
	let end = end.min(units.len());
	let (low, high) = if start <= end {
		(start, end)
	} else {
		(end, start)
	};
	units.get(low..high).unwrap_or_default()
}

/// Code units to a Rust string; a lone surrogate becomes U+FFFD (the
/// crate-wide convention of `research-js`).
pub(crate) fn to_string(units: &[u16]) -> String {
	String::from_utf16_lossy(units)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn units(text: &str) -> Vec<u16> {
		text.encode_utf16().collect()
	}

	#[test]
	fn substring_swaps_and_clamps_like_javascript() {
		let text = units("<![FOO[x]]>");
		assert_eq!(to_string(substring(&text, 9, 8)), "]");
		assert_eq!(to_string(substring(&text, 3, 99)), "FOO[x]]>");
	}

	#[test]
	fn trims_javascript_white_space() {
		assert_eq!(to_string(trim(&units("\u{FEFF} a\u{3000}"))), "a");
		assert_eq!(to_string(trim(&units("\u{0085}a"))), "\u{0085}a");
		assert_eq!(to_string(trim_start(&units("  a "))), "a ");
		assert_eq!(index_of(&units("a]]]>"), b"]]>", 0), Some(2));
	}
}
