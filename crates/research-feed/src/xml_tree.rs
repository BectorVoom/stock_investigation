//! Port of `packages/adapters/src/feed/xmlTree.ts`: read-only helpers over
//! the parsed object. Lengths are UTF-16 code units, as in TypeScript.

use crate::tree::{Object, Value};
use research_js::{utf16, whitespace};

/// Attribute keys carry this prefix.
pub const ATTRIBUTE_PREFIX: &str = "@_";
/// CDATA sections are kept under this key.
pub const CDATA_KEY: &str = "#cdata";

/// `isXmlNode`: an element object (not text, not an array).
#[must_use]
pub const fn as_node(value: &Value) -> Option<&Object> {
	match value {
		Value::Object(object) => Some(object),
		_ => None,
	}
}

/// `asArray`: an array's entries, or the value alone.
fn as_slice(value: &Value) -> &[Value] {
	match value {
		Value::Array(values) => values,
		single => std::slice::from_ref(single),
	}
}

/// `childrenOf`: all children with any of `names`, in NAME order, then
/// document order (so `["title", "atom:title"]` lists every bare one first).
pub fn children_of<'a>(
	node: &'a Object,
	names: &'a [&str],
) -> impl Iterator<Item = &'a Value> + 'a {
	names
		.iter()
		.filter_map(|name| node.get(*name))
		.flat_map(as_slice)
}

/// `firstChildOf`.
#[must_use]
pub fn first_child_of<'a>(node: &'a Object, names: &[&str]) -> Option<&'a Value> {
	names
		.iter()
		.filter_map(|name| node.get(*name))
		.flat_map(as_slice)
		.next()
}

/// `firstNodeOf`: the first child with one of `names` that is an element
/// object.
#[must_use]
pub fn first_node_of<'a>(node: &'a Object, names: &[&str]) -> Option<&'a Object> {
	names
		.iter()
		.filter_map(|name| node.get(*name))
		.flat_map(as_slice)
		.find_map(as_node)
}

/// `decodeXmlText`: ONE pass of
/// `/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g`. Custom
/// references such as `&lol;` stay literal (no DTD can define anything); a
/// numeric reference to 0, a surrogate or beyond U+10FFFF is dropped.
#[must_use]
pub fn decode_xml_text(text: &str) -> String {
	let bytes = text.as_bytes();
	let Some(first) = memchr::memchr(b'&', bytes) else {
		return text.to_owned();
	};
	let mut out = String::with_capacity(text.len());
	out.push_str(text.get(..first).unwrap_or_default());
	let mut index = first;
	while index < bytes.len() {
		if bytes.get(index) != Some(&b'&') {
			let next = memchr::memchr(b'&', bytes.get(index..).unwrap_or_default())
				.map_or(bytes.len(), |offset| index + offset);
			out.push_str(text.get(index..next).unwrap_or_default());
			index = next;
			continue;
		}
		match reference_at(bytes, index) {
			Some((replacement, end)) => {
				if let Some(character) = replacement {
					out.push(character);
				}
				index = end;
			}
			None => {
				out.push('&');
				index += 1;
			}
		}
	}
	out
}

/// The reference starting at the `&` at `start`: its replacement (`None` =
/// dropped) and the index after the `;`.
fn reference_at(bytes: &[u8], start: usize) -> Option<(Option<char>, usize)> {
	let body = bytes.get(start + 1..)?;
	for (name, character) in [
		("lt", '<'),
		("gt", '>'),
		("amp", '&'),
		("quot", '"'),
		("apos", '\''),
	] {
		if body.starts_with(name.as_bytes()) && body.get(name.len()) == Some(&b';') {
			return Some((Some(character), start + name.len() + 2));
		}
	}
	if body.first() != Some(&b'#') {
		return None;
	}
	let (radix, digits_start, max_digits) = if body.get(1) == Some(&b'x') {
		(16, 2, 6)
	} else {
		(10, 1, 7)
	};
	let digits = body.get(digits_start..)?;
	let count = digits
		.iter()
		.take_while(|byte| {
			if radix == 16 {
				byte.is_ascii_hexdigit()
			} else {
				byte.is_ascii_digit()
			}
		})
		.count();
	// `{1,6}` / `{1,7}` then `;`: more digits than allowed cannot match.
	if count == 0 || count > max_digits || digits.get(count) != Some(&b';') {
		return None;
	}
	let text = std::str::from_utf8(digits.get(..count)?).ok()?;
	let code_point = u32::from_str_radix(text, radix).ok()?;
	// `isXmlCharacter`: 1..=0x10FFFF and not a surrogate; `char::from_u32`
	// rejects exactly the surrogates and the values above U+10FFFF.
	let character = if code_point == 0 {
		None
	} else {
		char::from_u32(code_point)
	};
	Some((character, start + digits_start + count + 2))
}

/// `attributeOf`: the decoded attribute value, `None` when absent.
#[must_use]
pub fn attribute_of(node: &Object, name: &str) -> Option<String> {
	match node.get(format!("{ATTRIBUTE_PREFIX}{name}").as_str()) {
		Some(Value::Text(value)) => Some(decode_xml_text(value)),
		_ => None,
	}
}

/// `collectText`: text in `Object.entries` order; text decoded, CDATA kept
/// literal, attributes skipped. The budget counts RAW (pre-decode) UTF-16
/// units and is checked only on entry.
fn collect_text(value: &Value, parts: &mut Vec<String>, remaining: &mut i64) {
	if *remaining <= 0 {
		return;
	}
	match value {
		Value::Text(text) => {
			parts.push(decode_xml_text(text));
			*remaining -= units(text);
		}
		Value::Array(values) => {
			for entry in values {
				collect_text(entry, parts, remaining);
			}
		}
		Value::Object(object) => {
			for (key, child) in object {
				if key.starts_with(ATTRIBUTE_PREFIX) {
					continue;
				}
				if key == CDATA_KEY {
					// CDATA is literal character data: never entity-decoded.
					for section in as_slice(child) {
						if let Value::Text(section) = section {
							parts.push(section.clone());
							*remaining -= units(section);
						}
					}
					continue;
				}
				collect_text(child, parts, remaining);
			}
		}
	}
}

fn units(text: &str) -> i64 {
	i64::try_from(utf16::utf16_len(text)).unwrap_or(i64::MAX)
}

/// `textOf`: the element's character data as one string (parts joined with
/// one space, trimmed), `None` when empty, cut to `max_length` UTF-16 units
/// (a cut through a surrogate pair leaves U+FFFD, see `research-js`).
#[must_use]
pub fn text_of(value: Option<&Value>, max_length: usize) -> Option<String> {
	let value = value?;
	let mut parts = Vec::new();
	let mut remaining = i64::try_from(max_length).unwrap_or(i64::MAX);
	collect_text(value, &mut parts, &mut remaining);
	let joined = parts.join(" ");
	let text = whitespace::trim(&joined);
	if text.is_empty() {
		return None;
	}
	Some(utf16::truncate(text, max_length).into_owned())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn decodes_one_layer_of_predefined_and_numeric_references() {
		assert_eq!(
			decode_xml_text("&#x41;&#66;&#0;&#xD800; &unknown; &amp;lt;"),
			"AB &unknown; &lt;"
		);
		assert_eq!(
			decode_xml_text("&#X41; &#x1234567; &#12345678; &#x10FFFF; &#x110000;"),
			"&#X41; &#x1234567; &#12345678; \u{10FFFF} "
		);
		assert_eq!(
			decode_xml_text("a & b &amp &quot;&apos;&lt;&gt;"),
			"a & b &amp \"'<>"
		);
		assert_eq!(decode_xml_text("&#0065;"), "A");
	}
}
