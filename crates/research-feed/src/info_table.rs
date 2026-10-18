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

use crate::names::is_qname;
use crate::tree::{Object, ParseError, Value};
use crate::units::{
	APOS, BANG, CR, DASH, GT, LBRACKET, LF, LPAREN, LT, PERCENT, QUESTION, QUOTE, RPAREN, SLASH,
	SPACE, TAB, at, index_of, is, is_js_space, starts_with_ascii, substring, to_string, trim,
	trim_start,
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

/// `xmlData.replace(/\r\n?/g, "\n")`.
fn normalize_newlines(text: &[u16]) -> Vec<u16> {
	let mut out = Vec::with_capacity(text.len());
	let mut index = 0;
	while let Some(unit) = at(text, index) {
		if unit == CR {
			out.push(LF);
			if is(text, index + 1, LF) {
				index += 1;
			}
		} else {
			out.push(unit);
		}
		index += 1;
	}
	out
}

/// Names that would reach `Object.prototype` (`criticalProperties` throw,
/// `DANGEROUS_PROPERTY_NAMES` are renamed with a `__` prefix).
fn sanitize_name(name: &str) -> Result<String, ParseError> {
	const CRITICAL: [&str; 3] = ["__proto__", "constructor", "prototype"];
	const DANGEROUS: [&str; 7] = [
		"hasOwnProperty",
		"toString",
		"valueOf",
		"__defineGetter__",
		"__defineSetter__",
		"__lookupGetter__",
		"__lookupSetter__",
	];
	if CRITICAL.contains(&name) {
		return Err(ParseError);
	}
	if DANGEROUS.contains(&name) {
		return Ok(format!("__{name}"));
	}
	Ok(name.to_owned())
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

/// `tagExpWithClosingIndex`: the tag expression up to `closing` outside
/// quotes, with tabs outside quotes turned into spaces; the index of the
/// closing sequence.
fn tag_exp_with_closing_index(
	data: &[u16],
	start: usize,
	closing: &[u8],
) -> Option<(Vec<u16>, usize)> {
	let close0 = u16::from(*closing.first()?);
	let close1 = closing.get(1).map(|&byte| u16::from(byte));
	let mut boundary: Option<u16> = None;
	let mut result = Vec::new();
	let mut segment_start = start;
	let mut index = start;
	while let Some(code) = at(data, index) {
		if let Some(open) = boundary {
			if code == open {
				boundary = None;
			}
		} else if code == QUOTE || code == APOS {
			boundary = Some(code);
		} else if code == close0 {
			if close1.is_none_or(|second| is(data, index + 1, second)) {
				result.extend_from_slice(data.get(segment_start..index).unwrap_or_default());
				return Some((result, index));
			}
		} else if code == TAB {
			result.extend_from_slice(data.get(segment_start..index).unwrap_or_default());
			result.push(SPACE);
			segment_start = index + 1;
		}
		index += 1;
	}
	None
}

/* ---------- DocTypeReader ---------- */

fn skip_spaces(data: &[u16], mut index: usize) -> usize {
	while at(data, index).is_some_and(is_js_space) {
		index += 1;
	}
	index
}

/// `hasSeq(data, seq, i)`: `seq` starts one unit after `i`.
fn has_seq(data: &[u16], seq: &[u8], index: usize) -> bool {
	starts_with_ascii(data, index + 1, seq)
}

/// JavaScript `toUpperCase` of `substring(start, start + 6)`.
fn upper_six(data: &[u16], start: usize) -> String {
	to_string(substring(data, start, start + 6)).to_uppercase()
}

/// `readIdentifierVal`: a quoted literal at `index`; the index after it and
/// whether it was empty.
fn read_identifier(data: &[u16], index: usize) -> Result<(usize, bool), ParseError> {
	let quote = at(data, index)
		.filter(|&unit| unit == QUOTE || unit == APOS)
		.ok_or(ParseError)?;
	let start = index + 1;
	let mut end = start;
	while at(data, end).is_some_and(|unit| unit != quote) {
		end += 1;
	}
	if !is(data, end, quote) {
		return Err(ParseError);
	}
	Ok((end + 1, end == start))
}

/// A name up to white space (and, for entities, up to a quote).
fn read_name(data: &[u16], start: usize, stop_at_quote: bool) -> (usize, &[u16]) {
	let mut end = start;
	while at(data, end).is_some_and(|unit| {
		!is_js_space(unit) && !(stop_at_quote && (unit == QUOTE || unit == APOS))
	}) {
		end += 1;
	}
	(end, data.get(start..end).unwrap_or_default())
}

fn read_entity(data: &[u16], start: usize) -> Result<usize, ParseError> {
	let (index, name) = read_name(data, skip_spaces(data, start), true);
	if !is_qname(name) {
		return Err(ParseError);
	}
	let index = skip_spaces(data, index);
	// External and parameter entities are refused (XXE).
	if upper_six(data, index) == "SYSTEM" || is(data, index, PERCENT) {
		return Err(ParseError);
	}
	let (after, _) = read_identifier(data, index)?;
	Ok(after - 1)
}

fn read_element(data: &[u16], start: usize) -> Result<usize, ParseError> {
	let (index, name) = read_name(data, skip_spaces(data, start), false);
	if !is_qname(name) {
		return Err(ParseError);
	}
	let mut index = skip_spaces(data, index);
	if is(data, index, u16::from(b'E')) && has_seq(data, b"MPTY", index) {
		index += 4;
	} else if is(data, index, u16::from(b'A')) && has_seq(data, b"NY", index) {
		index += 2;
	} else if is(data, index, LPAREN) {
		index += 1;
		while at(data, index).is_some_and(|unit| unit != RPAREN) {
			index += 1;
		}
		if !is(data, index, RPAREN) {
			return Err(ParseError);
		}
	} else {
		return Err(ParseError);
	}
	Ok(index)
}

fn read_notation(data: &[u16], start: usize) -> Result<usize, ParseError> {
	let (index, name) = read_name(data, skip_spaces(data, start), false);
	if !is_qname(name) {
		return Err(ParseError);
	}
	let index = skip_spaces(data, index);
	let kind = upper_six(data, index);
	if kind != "SYSTEM" && kind != "PUBLIC" {
		return Err(ParseError);
	}
	let mut index = skip_spaces(data, index + 6);
	if kind == "PUBLIC" {
		index = read_identifier(data, index)?.0;
		index = skip_spaces(data, index);
		if matches!(at(data, index), Some(QUOTE | APOS)) {
			index = read_identifier(data, index)?.0;
		}
	} else {
		let (after, empty) = read_identifier(data, index)?;
		if empty {
			return Err(ParseError);
		}
		index = after;
	}
	Ok(index - 1)
}

/// `readDocType` with `start` at the `<` of `<!D…`: the index of the `>`
/// that closes the declaration. Entities are read (and validated) but never
/// stored or expanded: entity processing is off.
fn read_doc_type(data: &[u16], start: usize) -> Result<usize, ParseError> {
	if !starts_with_ascii(data, start + 3, b"OCTYPE") {
		return Err(ParseError);
	}
	let mut i = start + 9;
	let mut angle_brackets = 1i64;
	let mut has_body = false;
	let mut comment = false;
	let mut quote: Option<u16> = None;
	while let Some(unit) = at(data, i) {
		// Inside a quoted external-identifier literal '<' and '>' are data.
		if let Some(open) = quote {
			if unit == open {
				quote = None;
			}
			i += 1;
			continue;
		}
		if !has_body && !comment && (unit == QUOTE || unit == APOS) {
			quote = Some(unit);
			i += 1;
			continue;
		}
		if unit == LT && !comment {
			if has_body && has_seq(data, b"!ENTITY", i) {
				i = read_entity(data, i + 8)?;
			} else if has_body && has_seq(data, b"!ELEMENT", i) {
				i = read_element(data, i + 9)?;
			} else if has_body && has_seq(data, b"!ATTLIST", i) {
				i += 8;
			} else if has_body && has_seq(data, b"!NOTATION", i) {
				i = read_notation(data, i + 10)?;
			} else if has_seq(data, b"!--", i) {
				comment = true;
			} else {
				return Err(ParseError);
			}
			angle_brackets += 1;
		} else if unit == GT {
			if comment {
				if i >= 2 && is(data, i - 1, DASH) && is(data, i - 2, DASH) {
					comment = false;
					angle_brackets -= 1;
				}
			} else {
				angle_brackets -= 1;
			}
			if angle_brackets == 0 {
				break;
			}
		} else if unit == LBRACKET {
			has_body = true;
		}
		i += 1;
	}
	if quote.is_some() || angle_brackets != 0 {
		return Err(ParseError);
	}
	Ok(i)
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
