//! Port of fast-xml-parser 5.11.2's `XMLParser.parse` (OrderedObjParser,
//! DocTypeReader, node2json) for the options the feed parser sets:
//! attributes kept with the `@_` prefix, text under `#text`, CDATA under
//! `#cdata`, no entity processing, string values only, `trimValues`,
//! declarations and PIs ignored, namespace prefixes kept, at most 64 nested
//! tags.
//!
//! The result is the plain object the library returns, with JavaScript's
//! key order (`Object.entries`): child element names in first-appearance
//! order, `#cdata` at its first appearance, `#text` (the trimmed text pieces
//! concatenated WITHOUT a separator) after them, then the attributes.
//! JavaScript would list integer-like keys first, but none can occur: an
//! element name passes the validator's `isName` (never a digit first), and
//! attribute keys start with `@_`.

use crate::units::{
	APOS, BANG, DASH, LBRACKET, LT, QUESTION, QUOTE, SLASH, at, index_of, is, is_js_space,
	substring, to_string, trim, trim_start,
};
use crate::xml_scan::{
	normalize_newlines, read_doc_type, sanitize_name, tag_exp_with_closing_index,
};
use indexmap::IndexMap;

/// Deepest nesting the parser accepts (`maxNestedTags`).
pub const MAX_NESTED_TAGS: usize = 64;

/// The parser threw (unclosed construct, reserved name, nesting, DOCTYPE).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("fast-xml-parser would throw")]
pub struct ParseError;

/// A value of the parsed object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
	/// Text (an element with only text, `""` for an empty element, an
	/// attribute value, a CDATA section).
	Text(String),
	/// An element with children or attributes.
	Object(Object),
	/// Repeated sibling names, in document order.
	Array(Vec<Value>),
}

/// A JavaScript object: keys in insertion order (see the module docs).
pub type Object = IndexMap<String, Value>;

/// One entry of an element's ordered child list (`xmlNode.child`).
enum Child {
	Text(String),
	Cdata(String),
	Element(Element),
}

struct Element {
	name: String,
	children: Vec<Child>,
	attributes: Option<IndexMap<String, String>>,
}

impl Element {
	const fn new(name: String, attributes: Option<IndexMap<String, String>>) -> Self {
		Self {
			name,
			children: Vec::new(),
			attributes,
		}
	}
}

/// The document being built: the root pseudo-element (`!xml`) and the
/// elements still open (`tagsNodeStack` plus `currentNode`).
struct Builder {
	root: Element,
	open: Vec<Element>,
}

impl Builder {
	fn current(&mut self) -> &mut Element {
		match self.open.last_mut() {
			Some(element) => element,
			None => &mut self.root,
		}
	}

	/// `currentNode = tagsNodeStack.pop() || xmlObj`: the current element is
	/// complete (in JavaScript it was attached to its parent when opened).
	fn close_current(&mut self) {
		if let Some(element) = self.open.pop() {
			self.current().children.push(Child::Element(element));
		}
	}

	/// `saveTextToParentTag`: the trimmed pending text becomes a text child.
	fn save_text(&mut self, text_data: &mut Vec<u16>) {
		if text_data.is_empty() {
			return;
		}
		let trimmed = trim(text_data);
		if !trimmed.is_empty() {
			let text = to_string(trimmed);
			self.current().children.push(Child::Text(text));
		}
		text_data.clear();
	}
}

/// `new XMLParser(options).parse(text)` for the feed parser's options.
///
/// # Errors
/// [`ParseError`] wherever the library throws.
pub fn parse(text: &[u16]) -> Result<Object, ParseError> {
	let data = normalize_newlines(text);
	let mut builder = Builder {
		root: Element::new("!xml".to_owned(), None),
		open: Vec::new(),
	};
	let mut text_data: Vec<u16> = Vec::new();
	let mut doctype_found = false;
	let len = data.len();
	let mut i = 0usize;
	while i < len {
		if !is(&data, i, LT) {
			if let Some(unit) = at(&data, i) {
				text_data.push(unit);
			}
			i += 1;
			continue;
		}
		if is(&data, i + 1, SLASH) {
			// Closing tag.
			let close = index_of(&data, b">", i).ok_or(ParseError)?;
			let tag_name = trim(substring(&data, i + 2, close));
			sanitize_name(&to_string(tag_name))?;
			builder.save_text(&mut text_data);
			// A closing tag with no matching opening tag leaves the root current.
			builder.close_current();
			text_data.clear();
			i = close;
		} else if is(&data, i + 1, QUESTION) {
			// PI / XML declaration: ignored, but it ends the pending text.
			let (_, close) = tag_exp_with_closing_index(&data, i + 1, b"?>").ok_or(ParseError)?;
			builder.save_text(&mut text_data);
			i = close + 1;
		} else if is(&data, i + 1, BANG) && is(&data, i + 2, DASH) && is(&data, i + 3, DASH) {
			// Comment: skipped; text around it stays one piece.
			let end = index_of(&data, b"-->", i + 4).ok_or(ParseError)? + 2;
			i = end;
		} else if is(&data, i + 1, BANG) && is(&data, i + 2, u16::from(b'D')) {
			if doctype_found {
				return Err(ParseError);
			}
			doctype_found = true;
			i = read_doc_type(&data, i)?;
		} else if is(&data, i + 1, BANG) && is(&data, i + 2, LBRACKET) {
			let close = index_of(&data, b"]]>", i).ok_or(ParseError)?;
			// `substring` swaps its arguments when "]]>" comes early.
			let content = to_string(substring(&data, i + 9, close));
			builder.save_text(&mut text_data);
			builder.current().children.push(Child::Cdata(content));
			i = close + 2;
		} else {
			i = open_tag(&data, i, &mut builder, &mut text_data)?;
		}
		i += 1;
	}
	// Elements still open at the end were already attached in JavaScript.
	while !builder.open.is_empty() {
		builder.close_current();
	}
	Ok(compress(&builder.root.children))
}

/// An opening or self-closing tag at `start` (the `<`). Returns the index of
/// its `>`.
fn open_tag(
	data: &[u16],
	start: usize,
	builder: &mut Builder,
	text_data: &mut Vec<u16>,
) -> Result<usize, ParseError> {
	let (expression, close) =
		tag_exp_with_closing_index(data, start + 1, b">").ok_or(ParseError)?;
	let (raw_name, mut tag_exp) = match expression.iter().position(|&unit| is_js_space(unit)) {
		Some(separator) => (
			expression.get(..separator).unwrap_or_default(),
			trim_start(expression.get(separator + 1..).unwrap_or_default()),
		),
		None => (expression.as_slice(), expression.as_slice()),
	};
	let mut tag_name = sanitize_name(&to_string(raw_name))?;
	let mut tag_exp_text = to_string(tag_exp);
	let mut attr_exp_present = true;
	if tag_name == "#cdata" || tag_name == "#text" {
		return Err(ParseError);
	}
	// Text before a tag is saved unless the current node is the root.
	if !text_data.is_empty() && !builder.open.is_empty() {
		builder.save_text(text_data);
	}
	let mut self_closing = false;
	if tag_exp.last() == Some(&SLASH) {
		self_closing = true;
		if tag_name.ends_with('/') {
			tag_name.pop();
			tag_exp_text.clone_from(&tag_name);
		} else {
			tag_exp = tag_exp.get(..tag_exp.len() - 1).unwrap_or_default();
			tag_exp_text = to_string(tag_exp);
		}
		attr_exp_present = tag_name != tag_exp_text;
	}
	let attributes = if tag_name != tag_exp_text && attr_exp_present {
		// After a self-closing cleanup `tag_exp` may be stale; the text is
		// the authoritative expression.
		build_attributes(&tag_exp_text.encode_utf16().collect::<Vec<_>>())
	} else {
		None
	};
	if self_closing {
		let name = sanitize_name(&tag_name)?;
		builder
			.current()
			.children
			.push(Child::Element(Element::new(name, attributes)));
	} else {
		if builder.open.len() > MAX_NESTED_TAGS {
			return Err(ParseError);
		}
		builder.open.push(Element::new(tag_name, attributes));
	}
	text_data.clear();
	Ok(close)
}

/// `buildAttributesMap`: `/([^\s=]+)\s*(=\s*(['"])([\s\S]*?)\3)?/g` over the
/// attribute expression; only names with a quoted value are kept (boolean
/// attributes are off), values trimmed; a repeated name keeps its first
/// position and its last value.
fn build_attributes(expression: &[u16]) -> Option<IndexMap<String, String>> {
	let len = expression.len();
	let mut attributes = IndexMap::new();
	let mut i = 0usize;
	while i < len {
		// A match starts at a unit that is neither white space nor '='.
		while i < len
			&& at(expression, i).is_some_and(|unit| is_js_space(unit) || unit == u16::from(b'='))
		{
			i += 1;
		}
		if i >= len {
			break;
		}
		let name_start = i;
		while at(expression, i).is_some_and(|unit| !is_js_space(unit) && unit != u16::from(b'=')) {
			i += 1;
		}
		let name = expression.get(name_start..i).unwrap_or_default();
		while at(expression, i).is_some_and(is_js_space) {
			i += 1;
		}
		let after_spaces = i;
		let mut value = None;
		if is(expression, i, u16::from(b'=')) {
			let mut k = i + 1;
			while at(expression, k).is_some_and(is_js_space) {
				k += 1;
			}
			if let Some(quote @ (QUOTE | APOS)) = at(expression, k) {
				let value_start = k + 1;
				if let Some(offset) = expression
					.get(value_start..)
					.and_then(|rest| rest.iter().position(|&unit| unit == quote))
				{
					value = expression.get(value_start..value_start + offset);
					i = value_start + offset + 1;
				}
			}
		}
		if value.is_none() {
			// The optional group failed: the match is the name plus `\s*`.
			i = after_spaces;
		}
		if let Some(value) = value {
			attributes.insert(format!("@_{}", to_string(name)), to_string(trim(value)));
		}
	}
	if attributes.is_empty() {
		None
	} else {
		Some(attributes)
	}
}

/* ---------- node2json ---------- */

/// `compress`: an ordered child list to the plain object.
fn compress(children: &[Child]) -> Object {
	let mut text: Option<String> = None;
	let mut object = Object::new();
	for child in children {
		match child {
			Child::Text(piece) => text.get_or_insert_with(String::new).push_str(piece),
			Child::Cdata(content) => {
				// `{"#cdata": [{"#text": content}]}` compresses to the content
				// (an empty section to "").
				insert_or_append(&mut object, "#cdata", Value::Text(content.clone()));
			}
			Child::Element(element) => {
				let mut value = compress(&element.children);
				let compressed = if let Some(attributes) = &element.attributes {
					for (name, attribute) in attributes {
						value.insert(name.clone(), Value::Text(attribute.clone()));
					}
					Value::Object(value)
				} else if value.len() == 1 && value.contains_key("#text") {
					value
						.swap_remove("#text")
						.unwrap_or(Value::Text(String::new()))
				} else if value.is_empty() {
					Value::Text(String::new())
				} else {
					Value::Object(value)
				};
				insert_or_append(&mut object, &element.name, compressed);
			}
		}
	}
	if let Some(text) = text.filter(|text| !text.is_empty()) {
		object.insert("#text".to_owned(), Value::Text(text));
	}
	object
}

/// A second sibling with the same name turns the value into an array.
fn insert_or_append(object: &mut Object, key: &str, value: Value) {
	match object.get_mut(key) {
		Some(Value::Array(values)) => values.push(value),
		Some(existing) => {
			let first = std::mem::replace(existing, Value::Array(Vec::new()));
			*existing = Value::Array(vec![first, value]);
		}
		None => {
			object.insert(key.to_owned(), value);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tree(text: &str) -> Result<Object, ParseError> {
		parse(&text.encode_utf16().collect::<Vec<_>>())
	}

	fn text(value: &str) -> Value {
		Value::Text(value.to_owned())
	}

	#[test]
	fn concatenates_trimmed_text_pieces_without_separator() {
		let parsed = tree("<title>A <b>bold</b> tail</title>").unwrap();
		let Some(Value::Object(title)) = parsed.get("title") else {
			panic!("{parsed:?}")
		};
		assert_eq!(title.keys().collect::<Vec<_>>(), ["b", "#text"]);
		assert_eq!(title.get("#text"), Some(&text("Atail")));
		assert_eq!(
			tree("<a>x<!-- c -->y</a>").unwrap().get("a"),
			Some(&text("xy"))
		);
		assert_eq!(
			tree("<a>one<b/>two<c/>three</a>")
				.unwrap()
				.get("a")
				.map(|_| ()),
			Some(())
		);
	}

	#[test]
	fn promotes_repeated_names_to_arrays_in_document_order() {
		let parsed = tree("<r><i>1</i><i>2</i><i x=\"1\">3</i></r>").unwrap();
		let Some(Value::Object(root)) = parsed.get("r") else {
			panic!()
		};
		let Some(Value::Array(items)) = root.get("i") else {
			panic!()
		};
		assert_eq!(items.len(), 3);
		assert_eq!(items.first(), Some(&text("1")));
	}

	#[test]
	fn throws_where_the_library_throws() {
		assert_eq!(tree("<__proto__>x</__proto__>"), Err(ParseError));
		assert_eq!(tree("<constructor/>"), Err(ParseError));
		assert_eq!(tree("<r><!-- open"), Err(ParseError));
		let deep = format!("{}{}", "<a>".repeat(66), "</a>".repeat(66));
		assert_eq!(tree(&deep), Err(ParseError));
		let ok = format!("{}{}", "<a>".repeat(65), "</a>".repeat(65));
		assert!(tree(&ok).is_ok());
		assert_eq!(
			tree("<!DOCTYPE r [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><r>&x;</r>"),
			Err(ParseError)
		);
	}

	#[test]
	fn renames_dangerous_names() {
		assert!(
			tree("<toString>x</toString>")
				.unwrap()
				.contains_key("__toString")
		);
	}
}
