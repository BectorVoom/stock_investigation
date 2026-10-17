//! A port of htmlparser2 12.0.0's `Parser` (HTML mode, lower-cased tag and
//! attribute names) with exactly the four callbacks the converter registers:
//! `onopentag`, `ontext`, `onclosetag`, `oncomment`.
//!
//! The open-element stack keeps htmlparser2's order of events (implied
//! closes innermost first, `end()` closing everything still open without
//! popping), but its lookups — `indexOf` on every close tag, `includes` for
//! nested forms and SVG integration points — use a per-name position index,
//! so each stack operation is O(1) instead of O(depth) (ADR-0030 decision 6).

use std::collections::HashSet;

use crate::entities::Reference;
use crate::names::{Known, NameId, Names};
use crate::tokenizer::{Sink, Tokenizer};

/// A tag as the handler sees it.
#[derive(Clone, Copy, Debug)]
pub struct Tag<'a> {
	/// The name htmlparser2 reports (lower-cased, SVG-adjusted, `image` → `img`).
	pub name: &'a str,
	/// The id of `name`.
	pub id: NameId,
	/// The id of `name.toLowerCase()` (differs only for SVG camel-case names).
	pub lower: NameId,
}

/// A start tag's attributes in source order: lower-cased names, the first
/// occurrence of a name wins, values with character references decoded.
#[derive(Default, Debug)]
pub struct Attributes {
	text: String,
	/// `(name_start, value_start, value_end)` into `text`.
	spans: Vec<(usize, usize, usize)>,
	/// Name set for tags with many attributes (keeps duplicate checks O(1)).
	many: HashSet<Box<str>>,
}

/// From this many attributes on, duplicates are found through a set.
const LINEAR_ATTRIBUTE_SCAN: usize = 16;

impl Attributes {
	fn clear(&mut self) {
		self.text.clear();
		self.spans.clear();
		self.many.clear();
	}

	fn contains(&self, name: &str) -> bool {
		if self.spans.len() >= LINEAR_ATTRIBUTE_SCAN {
			return self.many.contains(name);
		}
		self.iter().any(|(existing, _)| existing == name)
	}

	fn push(&mut self, name: &str, value: &str) {
		let name_start = self.text.len();
		self.text.push_str(name);
		let value_start = self.text.len();
		self.text.push_str(value);
		self.spans.push((name_start, value_start, self.text.len()));
		if self.spans.len() == LINEAR_ATTRIBUTE_SCAN {
			let names: Vec<Box<str>> = self.iter().map(|(name, _)| name.into()).collect();
			self.many.extend(names);
		} else if self.spans.len() > LINEAR_ATTRIBUTE_SCAN {
			self.many.insert(name.into());
		}
	}

	/// `(name, value)` pairs in insertion order.
	pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
		self.spans.iter().map(|&(name, value, end)| {
			(
				self.text.get(name..value).unwrap_or(""),
				self.text.get(value..end).unwrap_or(""),
			)
		})
	}

	/// Number of attributes.
	#[must_use]
	pub fn len(&self) -> usize {
		self.spans.len()
	}

	/// True when the tag has no attributes.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.spans.is_empty()
	}
}

/// Receives the parser's events (htmlparser2's `Handler` subset).
pub trait Handler {
	/// `onopentag(name, attribs)`.
	fn on_open_tag(&mut self, tag: Tag<'_>, attributes: &Attributes);
	/// `ontext(data)`: one chunk, cut exactly where htmlparser2 cuts.
	fn on_text(&mut self, text: &str);
	/// An astral character from a named reference (`&Afr;`). htmlparser2
	/// delivers it as two text chunks of one lone surrogate each; a handler
	/// that treats chunks separately must treat this as two chunks.
	fn on_split_text(&mut self, character: char) {
		let mut buffer = [0u8; 4];
		self.on_text(character.encode_utf8(&mut buffer));
	}
	/// `onclosetag(name, isImplied)`.
	fn on_close_tag(&mut self, tag: Tag<'_>, implied: bool);
	/// `oncomment(data)`.
	fn on_comment(&mut self, _comment: &str) {}
}

/// Parses `html` (one `write` plus `end()`), driving `handler`.
pub fn parse<H: Handler>(html: &str, handler: &mut H) {
	let mut core = Core::new(handler);
	Tokenizer::new(html).run(&mut core);
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Foreign {
	None,
	Svg,
	MathMl,
}

/// htmlparser2's `openImpliesClose` sets as bits.
mod implies {
	pub(super) const FORM: u16 = 1 << 0;
	pub(super) const P: u16 = 1 << 1;
	pub(super) const HEADING: u16 = 1 << 2;
	pub(super) const TABLE_SECTION: u16 = 1 << 3;
	pub(super) const DDT: u16 = 1 << 4;
	pub(super) const RTP: u16 = 1 << 5;
	pub(super) const TR: u16 = 1 << 6;
	pub(super) const TH: u16 = 1 << 7;
	pub(super) const TD: u16 = 1 << 8;
	pub(super) const BODY: u16 = 1 << 9;
	pub(super) const A: u16 = 1 << 10;
	pub(super) const LI: u16 = 1 << 11;
	pub(super) const OPTION: u16 = 1 << 12;
	pub(super) const OPTGROUP: u16 = 1 << 13;
}

/// Which `openImpliesClose` sets contain `name`.
const fn member_of(name: Known) -> u16 {
	use Known as K;
	use implies::*;
	match name {
		K::Input | K::Select | K::Button | K::Datalist | K::Textarea => FORM,
		K::Option => FORM | OPTION | OPTGROUP,
		K::Optgroup => FORM | OPTGROUP,
		K::P => P | HEADING,
		K::H1 | K::H2 | K::H3 | K::H4 | K::H5 | K::H6 => HEADING,
		K::Thead => TABLE_SECTION | TD,
		K::Tbody => TABLE_SECTION,
		K::Dd | K::Dt => DDT,
		K::Rt | K::Rp => RTP,
		K::Tr => TR,
		K::Th => TR | TH | TD,
		K::Td => TR | TD,
		K::Head | K::Link | K::Script => BODY,
		K::A => A,
		K::Li => LI,
		_ => 0,
	}
}

/// The `openImpliesClose` set opening `name` pops while the current element is in it.
const fn implied_by(name: Known) -> u16 {
	use Known as K;
	use implies::*;
	match name {
		K::Tr => TR,
		K::Th => TH,
		K::Td => TD,
		K::Body => BODY,
		K::A => A,
		K::Li => LI,
		K::P => P,
		K::H1 | K::H2 | K::H3 | K::H4 | K::H5 | K::H6 => HEADING,
		K::Select | K::Input | K::Output | K::Button | K::Datalist | K::Textarea => FORM,
		K::Option => OPTION,
		K::Optgroup => OPTGROUP,
		K::Dd | K::Dt => DDT,
		K::Address
		| K::Article
		| K::Aside
		| K::Blockquote
		| K::Details
		| K::Div
		| K::Dl
		| K::Fieldset
		| K::Figcaption
		| K::Figure
		| K::Footer
		| K::Form
		| K::Header
		| K::Hr
		| K::Main
		| K::Nav
		| K::Ol
		| K::Pre
		| K::Section
		| K::Table
		| K::Ul => P,
		K::Rt | K::Rp => RTP,
		K::Tbody | K::Tfoot => TABLE_SECTION,
		_ => 0,
	}
}

fn is_void(id: NameId) -> bool {
	id.as_known().is_some_and(Known::is_parser_void)
}

fn foreign_of(id: NameId) -> Option<Foreign> {
	match id.as_known() {
		Some(Known::Svg) => Some(Foreign::Svg),
		Some(Known::Math) => Some(Foreign::MathMl),
		Some(known) if known.is_html_integration() => Some(Foreign::None),
		_ => None,
	}
}

fn tag_of(names: &Names, id: NameId) -> Tag<'_> {
	Tag {
		name: names.text(id),
		id,
		lower: names.lower_case(id),
	}
}

struct Core<'h, H> {
	handler: &'h mut H,
	names: Names,
	/// Open elements, innermost last.
	stack: Vec<NameId>,
	/// Per name: its positions in `stack`, innermost last.
	positions: Vec<Vec<usize>>,
	/// Foreign contexts, innermost last, over a base `None`.
	foreign: Vec<Foreign>,
	/// The open tag being read (`""` in the TypeScript is `None`).
	tag_name: Option<NameId>,
	/// `this.attribs !== null`.
	collecting: bool,
	attributes: Attributes,
	no_attributes: Attributes,
	attribute_name: String,
	attribute_value: String,
	lower_buffer: String,
}

impl<'h, H: Handler> Core<'h, H> {
	fn new(handler: &'h mut H) -> Self {
		Self {
			handler,
			names: Names::default(),
			stack: Vec::new(),
			positions: Vec::new(),
			foreign: vec![Foreign::None],
			tag_name: None,
			collecting: false,
			attributes: Attributes::default(),
			no_attributes: Attributes::default(),
			attribute_name: String::new(),
			attribute_value: String::new(),
			lower_buffer: String::new(),
		}
	}

	fn in_foreign(&self) -> bool {
		self.foreign.last() != Some(&Foreign::None)
	}

	fn is_open(&self, id: NameId) -> bool {
		self.positions
			.get(id.index())
			.is_some_and(|positions| !positions.is_empty())
	}

	/// `toLowerCase()` of a name, then interned.
	fn intern_lower(&mut self, raw: &str) -> NameId {
		if !raw.bytes().any(|byte| byte.is_ascii_uppercase()) {
			if raw.is_ascii() {
				return self.names.intern(raw);
			}
			let lower = raw.to_lowercase();
			return self.names.intern(&lower);
		}
		if raw.is_ascii() {
			let mut buffer = std::mem::take(&mut self.lower_buffer);
			buffer.clear();
			buffer.extend(
				raw.bytes()
					.map(|byte| char::from(byte.to_ascii_lowercase())),
			);
			let id = self.names.intern(&buffer);
			self.lower_buffer = buffer;
			return id;
		}
		let lower = raw.to_lowercase();
		self.names.intern(&lower)
	}

	/// `readTagName`.
	fn read_tag_name(&mut self, raw: &str) -> NameId {
		let name = self.intern_lower(raw);
		let adjusted = name
			.as_known()
			.and_then(Known::svg_adjusted)
			.map(NameId::known);
		if self.foreign.last() == Some(&Foreign::Svg) {
			return adjusted.unwrap_or(name);
		}
		// Closing an SVG element from inside one of its integration points.
		if self.foreign.len() > 1 {
			if let Some(adjusted) = adjusted.filter(|&adjusted| self.is_open(adjusted)) {
				return adjusted;
			}
		}
		if !self.in_foreign() && name == NameId::known(Known::Image) {
			return NameId::known(Known::Img);
		}
		name
	}

	fn push_element(&mut self, id: NameId) {
		let index = id.index();
		if self.positions.len() <= index {
			self.positions.resize_with(index + 1, Vec::new);
		}
		if let Some(positions) = self.positions.get_mut(index) {
			positions.push(self.stack.len());
		}
		self.stack.push(id);
	}

	/// `popElement`.
	fn pop_element(&mut self, implied: bool) {
		let Some(id) = self.stack.pop() else { return };
		if let Some(positions) = self.positions.get_mut(id.index()) {
			positions.pop();
		}
		if foreign_of(id).is_some() {
			self.foreign.pop();
		}
		let tag = tag_of(&self.names, id);
		self.handler.on_close_tag(tag, implied);
	}

	/// `emitOpenTag`.
	fn emit_open_tag(&mut self, id: NameId) {
		self.tag_name = Some(id);
		// A second `<form>` while one is open is ignored entirely.
		if id == NameId::known(Known::Form) && self.is_open(id) {
			self.tag_name = None;
			return;
		}
		if let Some(implied) = id.as_known().map(implied_by).filter(|&set| set != 0) {
			while let Some(&top) = self.stack.last() {
				let member = top.as_known().map_or(0, member_of);
				if member & implied == 0 {
					break;
				}
				self.pop_element(true);
			}
		}
		if !is_void(id) {
			self.push_element(id);
			if let Some(context) = foreign_of(id) {
				self.foreign.push(context);
			}
		}
		self.attributes.clear();
		self.collecting = true;
	}

	/// `endOpenTag`.
	fn end_open_tag(&mut self) {
		let Some(id) = self.tag_name.take() else {
			self.collecting = false;
			return;
		};
		if self.collecting {
			self.collecting = false;
			let tag = tag_of(&self.names, id);
			self.handler.on_open_tag(tag, &self.attributes);
		}
		if is_void(id) {
			let tag = tag_of(&self.names, id);
			self.handler.on_close_tag(tag, true);
		}
	}

	/// `closeCurrentTag`.
	fn close_current_tag(&mut self, is_open_implied: bool) {
		let name = self.tag_name;
		self.end_open_tag();
		if name.is_some() && self.stack.last().copied() == name {
			self.pop_element(!is_open_implied);
		}
	}

	fn emit_reference(&mut self, reference: Reference, into_attribute: bool) {
		match reference {
			Reference::Numeric(character) => {
				if into_attribute {
					self.attribute_value.push(character);
				} else {
					let mut buffer = [0u8; 4];
					self.handler.on_text(character.encode_utf8(&mut buffer));
				}
			}
			Reference::Named(first, second) => {
				let pair = second.and_then(|second| {
					char::decode_utf16([first, second])
						.next()
						.and_then(Result::ok)
				});
				match (pair, second) {
					(Some(character), Some(_)) if character.len_utf16() == 2 => {
						if into_attribute {
							self.attribute_value.push(character);
						} else {
							self.handler.on_split_text(character);
						}
					}
					_ => {
						for unit in std::iter::once(first).chain(second) {
							let character = char::from_u32(u32::from(unit)).unwrap_or('\u{FFFD}');
							if into_attribute {
								self.attribute_value.push(character);
							} else {
								let mut buffer = [0u8; 4];
								self.handler.on_text(character.encode_utf8(&mut buffer));
							}
						}
					}
				}
			}
		}
	}
}

impl<'a, H: Handler> Sink<'a> for Core<'_, H> {
	fn text(&mut self, text: &'a str) {
		self.handler.on_text(text);
	}

	fn text_entity(&mut self, reference: Reference) {
		self.emit_reference(reference, false);
	}

	fn attrib_data(&mut self, data: &'a str) {
		self.attribute_value.push_str(data);
	}

	fn attrib_entity(&mut self, reference: Reference) {
		self.emit_reference(reference, true);
	}

	fn attrib_end(&mut self) {
		// `attribs[name] = value` on a plain object: the first occurrence wins,
		// and `__proto__` hits the prototype setter, which ignores strings.
		if self.collecting
			&& self.attribute_name != "__proto__"
			&& !self.attributes.contains(&self.attribute_name)
		{
			self.attributes
				.push(&self.attribute_name, &self.attribute_value);
		}
		self.attribute_value.clear();
	}

	fn attrib_name(&mut self, name: &'a str) {
		self.attribute_name.clear();
		if name.is_ascii() {
			self.attribute_name.extend(
				name.bytes()
					.map(|byte| char::from(byte.to_ascii_lowercase())),
			);
		} else {
			self.attribute_name.push_str(&name.to_lowercase());
		}
	}

	fn cdata(&mut self, data: &'a str) {
		if self.in_foreign() {
			self.handler.on_text(data);
		} else {
			let comment = format!("[CDATA[{data}]]");
			self.handler.on_comment(&comment);
		}
	}

	fn close_tag(&mut self, raw: &'a str) {
		let id = self.read_tag_name(raw);
		if !is_void(id) {
			let innermost = self
				.positions
				.get(id.index())
				.and_then(|positions| positions.last());
			if let Some(&position) = innermost {
				for _ in position + 1..self.stack.len() {
					self.pop_element(true);
				}
				self.pop_element(false);
			} else if id == NameId::known(Known::P) {
				// `</p>` without an open `p`: an implied empty paragraph.
				self.emit_open_tag(id);
				self.close_current_tag(true);
			}
		} else if id == NameId::known(Known::Br) {
			// `</br>` is an implied `<br>` (not through emitOpenTag, which would close it twice).
			let tag = tag_of(&self.names, id);
			self.handler.on_open_tag(tag, &self.no_attributes);
			let tag = tag_of(&self.names, id);
			self.handler.on_close_tag(tag, false);
		}
	}

	fn comment(&mut self, data: &'a str) {
		self.handler.on_comment(data);
	}

	fn open_tag_end(&mut self) {
		self.end_open_tag();
	}

	fn open_tag_name(&mut self, raw: &'a str) {
		let id = self.read_tag_name(raw);
		self.emit_open_tag(id);
	}

	fn self_closing_tag(&mut self) {
		if self.in_foreign() {
			self.close_current_tag(false);
		} else {
			self.end_open_tag();
		}
	}

	fn end(&mut self) {
		// Every element still open closes, innermost first, without popping.
		for index in (0..self.stack.len()).rev() {
			if let Some(&id) = self.stack.get(index) {
				let tag = tag_of(&self.names, id);
				self.handler.on_close_tag(tag, true);
			}
		}
	}

	fn in_foreign_context(&self) -> bool {
		self.in_foreign()
	}
}
