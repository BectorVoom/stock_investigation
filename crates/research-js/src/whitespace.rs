//! JavaScript whitespace: the `\s` class and `String.prototype.trim`.
//!
//! JavaScript's set is WhiteSpace ∪ LineTerminator. It differs from Rust's
//! `char::is_whitespace` in two code points: JavaScript includes U+FEFF (BOM)
//! and excludes U+0085 (NEL). Text from feeds and pages contains both.

/// True for every code point matched by the JavaScript regex `\s`.
#[must_use]
pub const fn is_js_whitespace(character: char) -> bool {
	matches!(
		character,
		'\u{0009}'..='\u{000D}'
			| '\u{0020}'
			| '\u{00A0}'
			| '\u{1680}'
			| '\u{2000}'..='\u{200A}'
			| '\u{2028}'
			| '\u{2029}'
			| '\u{202F}'
			| '\u{205F}'
			| '\u{3000}'
			| '\u{FEFF}'
	)
}

/// `text.trim()`.
#[must_use]
pub fn trim(text: &str) -> &str {
	text.trim_matches(is_js_whitespace)
}

/// `text.trimStart()`.
#[must_use]
pub fn trim_start(text: &str) -> &str {
	text.trim_start_matches(is_js_whitespace)
}

/// `text.trimEnd()`.
#[must_use]
pub fn trim_end(text: &str) -> &str {
	text.trim_end_matches(is_js_whitespace)
}

/// `text.replace(/\s+/g, " ")`: every run of JS whitespace becomes one space.
#[must_use]
pub fn collapse(text: &str) -> String {
	let mut collapsed = String::with_capacity(text.len());
	let mut in_run = false;
	for character in text.chars() {
		if is_js_whitespace(character) {
			if !in_run {
				collapsed.push(' ');
				in_run = true;
			}
		} else {
			collapsed.push(character);
			in_run = false;
		}
	}
	collapsed
}

/// `text.split(/\s+/).filter((part) => part !== "")`.
pub fn split(text: &str) -> impl Iterator<Item = &str> {
	text.split(is_js_whitespace).filter(|part| !part.is_empty())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn differs_from_rust_on_bom_and_nel() {
		assert!(is_js_whitespace('\u{FEFF}'));
		assert!(!is_js_whitespace('\u{0085}'));
		assert_eq!(trim("\u{FEFF} a \u{3000}"), "a");
		assert_eq!(trim("\u{0085}a"), "\u{0085}a");
	}

	#[test]
	fn collapses_runs() {
		assert_eq!(collapse("a \t\n b\u{00A0}\u{00A0}c"), "a b c");
		assert_eq!(split("  a  b ").collect::<Vec<_>>(), ["a", "b"]);
	}
}
