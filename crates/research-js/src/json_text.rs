//! `JSON.stringify` for strings and numbers.
//!
//! Prompts and model-facing text embed JSON written by `JSON.stringify`, so
//! its exact escaping matters: only `"`, `\` and C0 controls are escaped,
//! the common controls with their short forms, the rest as `\u00xx` with
//! lower-case hex; U+2028, U+2029 and DEL are written as they are.

use crate::number::{push_js_string, to_js_string};

/// Appends `JSON.stringify(text)` to `out`.
pub fn push_quoted(out: &mut String, text: &str) {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	out.push('"');
	for character in text.chars() {
		match character {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\u{0008}' => out.push_str("\\b"),
			'\u{000C}' => out.push_str("\\f"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			control if u32::from(control) < 0x20 => {
				let code = u32::from(control);
				out.push_str("\\u00");
				let high = usize::try_from(code >> 4).unwrap_or(0);
				let low = usize::try_from(code & 0x0F).unwrap_or(0);
				out.push(char::from(HEX.get(high).copied().unwrap_or(b'0')));
				out.push(char::from(HEX.get(low).copied().unwrap_or(b'0')));
			}
			other => out.push(other),
		}
	}
	out.push('"');
}

/// `JSON.stringify(text)`.
#[must_use]
pub fn quote(text: &str) -> String {
	let mut out = String::with_capacity(text.len() + 2);
	push_quoted(&mut out, text);
	out
}

/// Appends `JSON.stringify(value)` for a number: non-finite numbers become `null`.
pub fn push_number(out: &mut String, value: f64) {
	if value.is_finite() {
		push_js_string(out, value);
	} else {
		out.push_str("null");
	}
}

/// `JSON.stringify(value)` for a number: non-finite numbers become `null`.
#[must_use]
pub fn number(value: f64) -> String {
	if value.is_finite() {
		to_js_string(value)
	} else {
		"null".to_owned()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn escapes_like_json_stringify() {
		assert_eq!(quote("a\"b\\c"), r#""a\"b\\c""#);
		assert_eq!(quote("\u{0001}\u{001F}\n\t"), r#""\u0001\u001f\n\t""#);
		assert_eq!(quote("\u{2028}\u{007F}é"), "\"\u{2028}\u{007F}é\"");
		assert_eq!(number(f64::NAN), "null");
		assert_eq!(number(1e21), "1e+21");
	}
}
