//! XML name rules exactly as the TypeScript parser's dependencies spell them.
//!
//! Both regexes run without the `u` flag, so they test UTF-16 code units:
//! a character above U+FFFF (a surrogate pair) never matches any range.

/// fast-xml-parser `util.js` `nameStartChar` (a superset of XML 1.0's that
/// keeps U+0487).
const fn is_fxp_name_start(unit: u16) -> bool {
	matches!(
		unit,
		0x3A // ':'
			| 0x41..=0x5A
			| 0x5F // '_'
			| 0x61..=0x7A
			| 0xC0..=0xD6
			| 0xD8..=0xF6
			| 0xF8..=0x02FF
			| 0x0370..=0x037D
			| 0x037F..=0x1FFF
			| 0x200C..=0x200D
			| 0x2070..=0x218F
			| 0x2C00..=0x2FEF
			| 0x3001..=0xD7FF
			| 0xF900..=0xFDCF
			| 0xFDF0..=0xFFFD
	)
}

const fn is_fxp_name_char(unit: u16) -> bool {
	is_fxp_name_start(unit)
		|| matches!(unit, 0x2D | 0x2E | 0x30..=0x39 | 0xB7 | 0x0300..=0x036F | 0x203F..=0x2040)
}

/// fast-xml-parser `isName`: `^[nameStartChar][nameChar]*$`.
pub(crate) fn is_name(units: &[u16]) -> bool {
	match units.split_first() {
		Some((&first, rest)) => {
			is_fxp_name_start(first) && rest.iter().all(|&unit| is_fxp_name_char(unit))
		}
		None => false,
	}
}

/// xml-naming 0.3 XML 1.0 `NameStartChar` without `:` (it excludes U+0487).
const fn is_ncname_start(unit: u16) -> bool {
	matches!(
		unit,
		0x41..=0x5A
			| 0x5F
			| 0x61..=0x7A
			| 0xC0..=0xD6
			| 0xD8..=0xF6
			| 0xF8..=0x02FF
			| 0x0370..=0x037D
			| 0x037F..=0x0486
			| 0x0488..=0x1FFF
			| 0x200C..=0x200D
			| 0x2070..=0x218F
			| 0x2C00..=0x2FEF
			| 0x3001..=0xD7FF
			| 0xF900..=0xFDCF
			| 0xFDF0..=0xFFFD
	)
}

const fn is_ncname_char(unit: u16) -> bool {
	is_ncname_start(unit)
		|| matches!(unit, 0x2D | 0x2E | 0x30..=0x39 | 0xB7 | 0x0300..=0x036F | 0x203F..=0x2040)
}

fn is_ncname(units: &[u16]) -> bool {
	match units.split_first() {
		Some((&first, rest)) => {
			is_ncname_start(first) && rest.iter().all(|&unit| is_ncname_char(unit))
		}
		None => false,
	}
}

/// xml-naming `qName` for XML 1.0 (`NCName(:NCName)?`) — the DOCTYPE
/// reader's check of entity, element and notation names. The reader always
/// ends up with the 1.0 rules: it passes the version as a number (or an
/// object), never the string `"1.1"` the library compares with.
pub(crate) fn is_qname(units: &[u16]) -> bool {
	match units.iter().position(|&unit| unit == 0x3A) {
		Some(colon) => {
			let (prefix, rest) = units.split_at(colon);
			is_ncname(prefix) && rest.get(1..).is_some_and(is_ncname)
		}
		None => is_ncname(units),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn units(text: &str) -> Vec<u16> {
		text.encode_utf16().collect()
	}

	#[test]
	fn names_follow_the_fxp_regex() {
		assert!(is_name(&units("rss")));
		assert!(is_name(&units("atom:link")));
		assert!(is_name(&units(":a")));
		assert!(is_name(&units("a\u{FEFF}b")));
		assert!(!is_name(&units("1a")));
		assert!(!is_name(&units("")));
		assert!(!is_name(&units("a b")));
		assert!(!is_name(&units("a😀")));
		assert!(is_name(&units("\u{0487}")));
	}

	#[test]
	fn qnames_allow_one_colon_between_ncnames() {
		assert!(is_qname(&units("lol9")));
		assert!(is_qname(&units("a:b")));
		assert!(!is_qname(&units("a:b:c")));
		assert!(!is_qname(&units(":a")));
		assert!(!is_qname(&units("a:")));
		assert!(!is_qname(&units("%")));
		assert!(!is_qname(&units("\u{0487}")));
	}
}
