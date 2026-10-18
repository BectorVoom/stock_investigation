//! Port of fast-xml-parser 5.11.2's `XMLParser.parse` (OrderedObjParser,
//! DocTypeReader, node2json) for the options the SEC 13F information-table
//! parser sets: attributes ignored, namespace prefixes removed, text under
//! `#text`, CDATA folded into the text (no `cdataPropName`), no entity
//! processing, string values only, `trimValues`, declarations and PIs
//! ignored, at most 16 nested tags.
//!
//! This is [`crate::tree`] re-parameterised for those options (a NEW module,
//! so the feed parser's port stays untouched): the tokenising helpers and the
//! DOCTYPE reader are the same code. TECH DEBT: the two modules should share
//! one options-driven implementation once the feed port is next opened.
//!
//! The result is the plain object the library returns, with JavaScript's key
//! order: child element names in first-appearance order, `#text` (the trimmed
//! text pieces concatenated WITHOUT a separator) after them. JavaScript would
//! list integer-like keys first; a tag name that becomes integer-like only
//! after its namespace prefix is removed (`<a:1>`) is the one case this port
//! does not reorder.

use crate::tree::{Object, ParseError, Value};
use crate::units::{
	BANG, DASH, LBRACKET, LT, QUESTION, SLASH, at, index_of, is, is_js_space, substring, to_string,
	trim, trim_start,
};
use crate::xml_scan::{
	normalize_newlines, read_doc_type, sanitize_name, tag_exp_with_closing_index,
};

/// Deepest nesting the information-table parser accepts (`maxNestedTags`).
pub const INFO_TABLE_MAX_NESTED_TAGS: usize = 16;

/// One entry of an element's ordered child list (`xmlNode.child`).
enum Child {
	Text(String),
	Element(Element),
}

struct Element {
	name: String,
	children: Vec<Child>,
}

impl Element {
	const fn new(name: String) -> Self {
		Self {
			name,
			children: Vec::new(),
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

	/// `currentNode = tagsNodeStack.pop() || xmlObj`.
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

/// `tagName.substr(tagName.indexOf(":") + 1)` when a colon exists
/// (`removeNSPrefix`: everything up to the FIRST colon goes).
fn remove_ns_prefix(name: &str) -> &str {
	name.split_once(':').map_or(name, |(_, local)| local)
}

/// `new XMLParser(options).parse(text)` for the information-table options.
///
/// # Errors
/// [`ParseError`] wherever the library throws.
pub fn parse(text: &[u16]) -> Result<Object, ParseError> {
	let data = normalize_newlines(text);
	let mut builder = Builder {
		root: Element::new("!xml".to_owned()),
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
			let raw = to_string(trim(substring(&data, i + 2, close)));
			sanitize_name(remove_ns_prefix(&raw))?;
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
			// Without `cdataPropName` the section is a text node of its own,
			// neither trimmed nor entity-decoded here.
			builder.current().children.push(Child::Text(content));
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
/// its `>`. Attributes are ignored, but the tag expression is still split the
/// way the library splits it, because that decides the name and self-closing.
fn open_tag(
	data: &[u16],
	start: usize,
	builder: &mut Builder,
	text_data: &mut Vec<u16>,
) -> Result<usize, ParseError> {
	let (expression, close) =
		tag_exp_with_closing_index(data, start + 1, b">").ok_or(ParseError)?;
	let (raw_name, tag_exp) = match expression.iter().position(|&unit| is_js_space(unit)) {
		Some(separator) => (
			expression.get(..separator).unwrap_or_default(),
			trim_start(expression.get(separator + 1..).unwrap_or_default()),
		),
		None => (expression.as_slice(), expression.as_slice()),
	};
	let raw_name = to_string(raw_name);
	let mut tag_name = sanitize_name(remove_ns_prefix(&raw_name))?;
	if tag_name == "#text" {
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
		}
	}
	if self_closing {
		let name = sanitize_name(&tag_name)?;
		builder
			.current()
			.children
			.push(Child::Element(Element::new(name)));
	} else {
		if builder.open.len() > INFO_TABLE_MAX_NESTED_TAGS {
			return Err(ParseError);
		}
		builder.open.push(Element::new(tag_name));
	}
	text_data.clear();
	Ok(close)
}

/* ---------- node2json ---------- */

/// `compress`: an ordered child list to the plain object.
fn compress(children: &[Child]) -> Object {
	let mut text: Option<String> = None;
	let mut object = Object::new();
	for child in children {
		match child {
			Child::Text(piece) => text.get_or_insert_with(String::new).push_str(piece),
			Child::Element(element) => {
				let mut value = compress(&element.children);
				let compressed = if value.len() == 1 && value.contains_key("#text") {
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
	fn removes_namespace_prefixes_and_ignores_attributes() {
		let parsed = tree(r#"<ns1:a x="1"><ns1:b y='2'>v</ns1:b><ns1:c/></ns1:a>"#).unwrap();
		let Some(Value::Object(a)) = parsed.get("a") else {
			panic!("{parsed:?}")
		};
		assert_eq!(a.get("b"), Some(&text("v")));
		assert_eq!(a.get("c"), Some(&text("")));
		// Everything before the FIRST colon goes.
		assert!(tree("<a:b:c>x</a:b:c>").unwrap().contains_key("b:c"));
	}

	#[test]
	fn cdata_is_plain_text() {
		let parsed = tree("<a><![CDATA[ x & y ]]></a>").unwrap();
		assert_eq!(parsed.get("a"), Some(&text(" x & y ")));
		assert_eq!(
			tree("<a><![CDATA[]]></a>").unwrap().get("a"),
			Some(&text(""))
		);
	}

	#[test]
	fn limits_nesting_to_sixteen_open_parents() {
		let ok = format!("{}{}", "<a>".repeat(17), "</a>".repeat(17));
		assert!(tree(&ok).is_ok());
		let deep = format!("{}{}", "<a>".repeat(18), "</a>".repeat(18));
		assert_eq!(tree(&deep), Err(ParseError));
	}

	#[test]
	fn throws_where_the_library_throws() {
		assert_eq!(tree("<__proto__>x</__proto__>"), Err(ParseError));
		assert_eq!(tree("<ns:constructor/>"), Err(ParseError));
		assert_eq!(tree("<r><!-- open"), Err(ParseError));
	}
}
