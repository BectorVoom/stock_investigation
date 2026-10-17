//! A port of htmlparser2 12.0.0's `Tokenizer` (HTML mode, `decodeEntities:
//! true`, one `write` of the whole document followed by `end()`).
//!
//! Each state below mirrors the TypeScript method of the same name; the
//! parse loop processes one byte per iteration and then advances, exactly as
//! the TypeScript processes one UTF-16 code unit. Every structural decision
//! compares ASCII bytes (`c | 0x20`, the five whitespace bytes, `< > / = " '
//! & ; # ! ? - [ ]`), so the UTF-8 byte walk makes the same decisions and
//! every slice boundary falls on a character boundary. Where the TypeScript
//! loops over characters that cannot change anything, the port jumps with
//! `memchr` (text, raw text, comments, quoted attribute values) — the result
//! is the same, the work is not.
//!
//! Quirks kept on purpose (they change converter output): text is cut before
//! every `<` and around every decoded reference; `</x a` at end of input
//! emits the last character as text (the TypeScript slices from index -1);
//! a trailing `<scr` (an unfinished special tag name) is text; U+001C acts as
//! `<` at the start of a raw-text end-tag match (`(c | 0x20) === "<"`).

use memchr::{memchr, memchr2, memchr3};

use crate::entities::{self, Mode, Reference};

/// Callbacks the tokenizer drives (htmlparser2's `Callbacks`, minus the XML
/// processing instructions and with slices instead of indices).
pub(crate) trait Sink<'a> {
	fn text(&mut self, text: &'a str);
	fn text_entity(&mut self, reference: Reference);
	fn attrib_data(&mut self, data: &'a str);
	fn attrib_entity(&mut self, reference: Reference);
	fn attrib_end(&mut self);
	fn attrib_name(&mut self, name: &'a str);
	fn cdata(&mut self, data: &'a str);
	fn close_tag(&mut self, name: &'a str);
	fn comment(&mut self, data: &'a str);
	fn open_tag_end(&mut self);
	fn open_tag_name(&mut self, name: &'a str);
	fn self_closing_tag(&mut self);
	fn end(&mut self);
	fn in_foreign_context(&self) -> bool;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
	Text,
	BeforeTagName,
	InTagName,
	InSelfClosingTag,
	BeforeClosingTagName,
	InClosingTagName,
	AfterClosingTagName,
	BeforeAttributeName,
	InAttributeName,
	AfterAttributeName,
	BeforeAttributeValue,
	InAttributeValueDq,
	InAttributeValueSq,
	InAttributeValueNq,
	BeforeDeclaration,
	InDeclaration,
	BeforeComment,
	CdataSequence,
	DeclarationSequence,
	InSpecialComment,
	InCommentLike,
	SpecialStartSequence,
	InSpecialTag,
	InPlainText,
}

/// htmlparser2's `Sequences`, compared by identity like the TypeScript.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Sequence {
	Empty,
	Cdata,
	CdataEnd,
	CommentEnd,
	Doctype,
	IframeEnd,
	NoembedEnd,
	NoframesEnd,
	Plaintext,
	ScriptEnd,
	StyleEnd,
	TitleEnd,
	TextareaEnd,
	XmpEnd,
}

impl Sequence {
	const fn bytes(self) -> &'static [u8] {
		match self {
			Self::Empty => b"",
			Self::Cdata => b"CDATA[",
			Self::CdataEnd => b"]]>",
			Self::CommentEnd => b"--!>",
			Self::Doctype => b"doctype",
			Self::IframeEnd => b"</iframe",
			Self::NoembedEnd => b"</noembed",
			Self::NoframesEnd => b"</noframes",
			Self::Plaintext => b"</plaintext",
			Self::ScriptEnd => b"</script",
			Self::StyleEnd => b"</style",
			Self::TitleEnd => b"</title",
			Self::TextareaEnd => b"</textarea",
			Self::XmpEnd => b"</xmp",
		}
	}

	fn at(self, index: usize) -> Option<u8> {
		self.bytes().get(index).copied()
	}

	const fn len(self) -> usize {
		self.bytes().len()
	}

	/// `specialStartSequences`: keyed by the lower-cased first name letter.
	const fn special_start(lower: u8) -> Option<Self> {
		match lower {
			b'i' => Some(Self::IframeEnd),
			b'n' => Some(Self::NoembedEnd),
			b'p' => Some(Self::Plaintext),
			b's' => Some(Self::ScriptEnd),
			b't' => Some(Self::TitleEnd),
			b'x' => Some(Self::XmpEnd),
			_ => None,
		}
	}
}

const fn is_whitespace(c: u8) -> bool {
	matches!(c, b' ' | b'\n' | b'\t' | 0x0c | b'\r')
}

const fn is_end_of_tag_section(c: u8) -> bool {
	c == b'/' || c == b'>' || is_whitespace(c)
}

/// `sectionStart = -1` in the TypeScript (after a tag or attribute name).
const NO_SECTION: usize = usize::MAX;

pub(crate) struct Tokenizer<'a> {
	input: &'a str,
	bytes: &'a [u8],
	state: State,
	section_start: usize,
	index: usize,
	entity_start: usize,
	base_state: State,
	is_special: bool,
	sequence: Sequence,
	sequence_index: usize,
}

impl<'a> Tokenizer<'a> {
	pub(crate) fn new(input: &'a str) -> Self {
		Self {
			input,
			bytes: input.as_bytes(),
			state: State::Text,
			section_start: 0,
			index: 0,
			entity_start: 0,
			base_state: State::Text,
			is_special: false,
			sequence: Sequence::Empty,
			sequence_index: 0,
		}
	}

	/// `write(input)` followed by `end()`.
	pub(crate) fn run<S: Sink<'a>>(&mut self, sink: &mut S) {
		self.parse(sink);
		self.handle_trailing_data(sink);
		sink.end();
	}

	fn slice(&self, start: usize, end: usize) -> &'a str {
		if start >= end {
			return "";
		}
		self.input.get(start..end).unwrap_or("")
	}

	fn byte(&self, index: usize) -> u8 {
		self.bytes.get(index).copied().unwrap_or(0)
	}

	/// `fastForwardTo`: moves `index` onto the next `c`, or onto the last
	/// byte when there is none (the loop then steps past the end).
	fn fast_forward_to(&mut self, c: u8) -> bool {
		let from = self.index + 1;
		match self.bytes.get(from..).and_then(|rest| memchr(c, rest)) {
			Some(offset) => {
				self.index = from + offset;
				true
			}
			None => {
				self.index = self.bytes.len().saturating_sub(1);
				false
			}
		}
	}

	/// Moves `index` so that the next iteration lands on `found` (an offset
	/// from `index + 1`), or past the end.
	fn skip_to(&mut self, found: Option<usize>) {
		self.index = match found {
			Some(offset) => self.index + offset,
			None => self.bytes.len().saturating_sub(1),
		};
	}

	fn parse<S: Sink<'a>>(&mut self, sink: &mut S) {
		while self.index < self.bytes.len() {
			let c = self.byte(self.index);
			match self.state {
				State::Text => self.state_text(c, sink),
				State::InPlainText => self.index = self.bytes.len().saturating_sub(1),
				State::SpecialStartSequence => self.state_special_start_sequence(c, sink),
				State::InSpecialTag => self.state_in_special_tag(c, sink),
				State::CdataSequence => self.state_cdata_sequence(c, sink),
				State::DeclarationSequence => self.state_declaration_sequence(c, sink),
				State::InAttributeValueDq => self.handle_in_attribute_value(c, b'"', sink),
				State::InAttributeName => self.state_in_attribute_name(c, sink),
				State::InCommentLike => self.state_in_comment_like(c, sink),
				State::InSpecialComment => self.state_in_special_comment(c, sink),
				State::BeforeAttributeName => self.state_before_attribute_name(c, sink),
				State::InTagName => self.state_in_tag_name(c, sink),
				State::InClosingTagName => self.state_in_closing_tag_name(c, sink),
				State::BeforeTagName => self.state_before_tag_name(c, sink),
				State::AfterAttributeName => self.state_after_attribute_name(c, sink),
				State::InAttributeValueSq => self.handle_in_attribute_value(c, b'\'', sink),
				State::BeforeAttributeValue => self.state_before_attribute_value(c, sink),
				State::BeforeClosingTagName => self.state_before_closing_tag_name(c),
				State::AfterClosingTagName => self.state_after_closing_tag_name(c),
				State::InAttributeValueNq => self.state_in_attribute_value_no_quotes(c, sink),
				State::InSelfClosingTag => self.state_in_self_closing_tag(c, sink),
				State::InDeclaration => self.state_in_declaration(c),
				State::BeforeDeclaration => self.state_before_declaration(c, sink),
				State::BeforeComment => self.state_before_comment(c, sink),
			}
			self.index += 1;
		}
		self.cleanup(sink);
	}

	fn state_text<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'<' {
			if self.index > self.section_start {
				sink.text(self.slice(self.section_start, self.index));
			}
			self.state = State::BeforeTagName;
			self.section_start = self.index;
		} else if c == b'&' {
			self.start_entity(sink);
		} else {
			// Every other byte is plain text: go straight to the next `<` or `&`.
			let found = self
				.bytes
				.get(self.index + 1..)
				.and_then(|rest| memchr2(b'<', b'&', rest));
			self.skip_to(found);
		}
	}

	fn enter_tag_body(&mut self) {
		if self.sequence == Sequence::Plaintext {
			self.sequence = Sequence::Empty;
			self.state = State::InPlainText;
		} else if self.is_special {
			self.state = State::InSpecialTag;
			self.sequence_index = 0;
		} else {
			self.state = State::Text;
		}
	}

	fn state_special_start_sequence<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		let lower = c | 0x20;
		if self.sequence_index < self.sequence.len() {
			if Some(lower) == self.sequence.at(self.sequence_index) {
				self.sequence_index += 1;
				return;
			}
			if self.sequence_index == 3 {
				if self.sequence == Sequence::ScriptEnd && Some(lower) == Sequence::StyleEnd.at(3) {
					self.sequence = Sequence::StyleEnd;
					self.sequence_index = 4;
					return;
				}
				if self.sequence == Sequence::TitleEnd && Some(lower) == Sequence::TextareaEnd.at(3)
				{
					self.sequence = Sequence::TextareaEnd;
					self.sequence_index = 4;
					return;
				}
			} else if self.sequence_index == 4
				&& self.sequence == Sequence::NoembedEnd
				&& Some(lower) == Sequence::NoframesEnd.at(4)
			{
				self.sequence = Sequence::NoframesEnd;
				self.sequence_index = 5;
				return;
			}
		} else if is_end_of_tag_section(c) {
			// Full match on a tag boundary: keep the sequence.
			self.sequence_index = 0;
			self.state = State::InTagName;
			self.state_in_tag_name(c, sink);
			return;
		}
		// No match: not a special tag after all.
		self.is_special = false;
		self.sequence = Sequence::Empty;
		self.sequence_index = 0;
		self.state = State::InTagName;
		self.state_in_tag_name(c, sink);
	}

	fn state_cdata_sequence<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if Some(c) == Sequence::Cdata.at(self.sequence_index) {
			self.sequence_index += 1;
			if self.sequence_index == Sequence::Cdata.len() {
				self.state = State::InCommentLike;
				self.sequence = Sequence::CdataEnd;
				self.sequence_index = 0;
				self.section_start = self.index + 1;
			}
		} else {
			self.sequence_index = 0;
			self.state = State::InSpecialComment;
			self.state_in_special_comment(c, sink);
		}
	}

	fn emit_comment<S: Sink<'a>>(&mut self, offset: usize, sink: &mut S) {
		sink.comment(self.slice(self.section_start, self.index.saturating_sub(offset)));
		self.sequence_index = 0;
		self.section_start = self.index + 1;
		self.state = State::Text;
	}

	fn state_in_comment_like<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		let is_comment = self.sequence == Sequence::CommentEnd;
		if is_comment
			&& self.sequence_index <= 1
			&& self.index == self.section_start.saturating_add(self.sequence_index)
			&& c == b'>'
		{
			// Abruptly closed empty comment (`<!-->`, `<!--->`).
			self.emit_comment(self.sequence_index, sink);
		} else if is_comment && self.sequence_index == 2 && c == b'>' {
			// The `!` of `--!>` is optional.
			self.emit_comment(2, sink);
		} else if is_comment && self.sequence_index == self.sequence.len() - 1 && c != b'>' {
			self.sequence_index = usize::from(c == b'-');
		} else if Some(c) == self.sequence.at(self.sequence_index) {
			self.sequence_index += 1;
			if self.sequence_index == self.sequence.len() {
				if self.sequence == Sequence::CdataEnd {
					sink.cdata(self.slice(self.section_start, self.index.saturating_sub(2)));
				} else {
					sink.comment(self.slice(self.section_start, self.index.saturating_sub(3)));
				}
				self.sequence_index = 0;
				self.section_start = self.index + 1;
				self.state = State::Text;
			}
		} else if self.sequence_index == 0 {
			let first = self.sequence.at(0).unwrap_or(b'-');
			if self.fast_forward_to(first) {
				self.sequence_index = 1;
			}
		} else if Some(c) != self.sequence.at(self.sequence_index - 1) {
			// Long runs (`--->`, `]]]>`) keep the partial match.
			self.sequence_index = 0;
		}
	}

	fn state_in_special_tag<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if self.sequence_index == self.sequence.len() {
			if is_end_of_tag_section(c) {
				let end_of_text = self.index.saturating_sub(self.sequence.len());
				if self.section_start < end_of_text {
					sink.text(self.slice(self.section_start, end_of_text));
				}
				self.is_special = false;
				// Skip over the `</`.
				self.section_start = end_of_text + 2;
				self.state_in_closing_tag_name(c, sink);
				return;
			}
			self.sequence_index = 0;
		}
		if Some(c | 0x20) == self.sequence.at(self.sequence_index) {
			self.sequence_index += 1;
		} else if self.sequence_index == 0 {
			if matches!(self.sequence, Sequence::TitleEnd | Sequence::TextareaEnd) {
				// RCDATA: entities are decoded while looking for the end tag.
				if c == b'&' {
					self.start_entity(sink);
				} else {
					// Only `<`, U+001C (`| 0x20` is `<`) and `&` matter here.
					let found = self
						.bytes
						.get(self.index + 1..)
						.and_then(|rest| memchr3(b'<', 0x1c, b'&', rest));
					self.skip_to(found);
				}
			} else if self.fast_forward_to(b'<') {
				self.sequence_index = 1;
			}
		} else {
			// A `<` restarts the match (`<</script>`).
			self.sequence_index = usize::from(c == b'<');
		}
	}

	fn state_before_tag_name<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'!' {
			self.state = State::BeforeDeclaration;
			self.section_start = self.index + 1;
		} else if c == b'?' {
			self.state = State::InSpecialComment;
			self.section_start = self.index;
		} else if c.is_ascii_alphabetic() {
			self.section_start = self.index;
			let special = if sink.in_foreign_context() {
				None
			} else {
				Sequence::special_start(c | 0x20)
			};
			match special {
				None => self.state = State::InTagName,
				Some(sequence) => {
					self.is_special = true;
					self.sequence = sequence;
					self.sequence_index = 3;
					self.state = State::SpecialStartSequence;
				}
			}
		} else if c == b'/' {
			self.state = State::BeforeClosingTagName;
		} else {
			self.state = State::Text;
			self.state_text(c, sink);
		}
	}

	fn state_in_tag_name<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if is_end_of_tag_section(c) {
			sink.open_tag_name(self.slice(self.section_start, self.index));
			self.section_start = NO_SECTION;
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c, sink);
		}
	}

	fn state_before_closing_tag_name(&mut self, c: u8) {
		if is_whitespace(c) {
			self.state = State::InSpecialComment;
			self.section_start = self.index;
		} else if c == b'>' {
			self.state = State::Text;
			self.section_start = self.index + 1;
		} else {
			self.state = if c.is_ascii_alphabetic() {
				State::InClosingTagName
			} else {
				State::InSpecialComment
			};
			self.section_start = self.index;
		}
	}

	fn state_in_closing_tag_name<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if is_end_of_tag_section(c) {
			sink.close_tag(self.slice(self.section_start, self.index));
			self.section_start = NO_SECTION;
			self.state = State::AfterClosingTagName;
			self.state_after_closing_tag_name(c);
		}
	}

	fn state_after_closing_tag_name(&mut self, c: u8) {
		// Skip everything until `>`.
		if c == b'>' || self.fast_forward_to(b'>') {
			self.state = State::Text;
			self.section_start = self.index + 1;
		}
	}

	fn state_before_attribute_name<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'>' {
			sink.open_tag_end();
			self.enter_tag_body();
			self.section_start = self.index + 1;
		} else if c == b'/' {
			self.state = State::InSelfClosingTag;
		} else if !is_whitespace(c) {
			self.state = State::InAttributeName;
			self.section_start = self.index;
		}
	}

	fn state_in_self_closing_tag<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'>' {
			sink.self_closing_tag();
			self.section_start = self.index + 1;
			// HTML mode does not recognise self-closing tags in the tokenizer:
			// `<script/>` still opens raw text.
			self.enter_tag_body();
		} else if !is_whitespace(c) {
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c, sink);
		}
	}

	fn state_in_attribute_name<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'=' || is_end_of_tag_section(c) {
			sink.attrib_name(self.slice(self.section_start, self.index));
			self.section_start = self.index;
			self.state = State::AfterAttributeName;
			self.state_after_attribute_name(c, sink);
		}
	}

	fn state_after_attribute_name<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'=' {
			self.state = State::BeforeAttributeValue;
		} else if c == b'/' || c == b'>' {
			sink.attrib_end();
			self.section_start = NO_SECTION;
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c, sink);
		} else if !is_whitespace(c) {
			sink.attrib_end();
			self.state = State::InAttributeName;
			self.section_start = self.index;
		}
	}

	fn state_before_attribute_value<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'"' {
			self.state = State::InAttributeValueDq;
			self.section_start = self.index + 1;
		} else if c == b'\'' {
			self.state = State::InAttributeValueSq;
			self.section_start = self.index + 1;
		} else if !is_whitespace(c) {
			self.section_start = self.index;
			self.state = State::InAttributeValueNq;
			self.state_in_attribute_value_no_quotes(c, sink);
		}
	}

	fn handle_in_attribute_value<S: Sink<'a>>(&mut self, c: u8, quote: u8, sink: &mut S) {
		if c == quote {
			sink.attrib_data(self.slice(self.section_start, self.index));
			self.section_start = NO_SECTION;
			sink.attrib_end();
			self.state = State::BeforeAttributeName;
		} else if c == b'&' {
			self.start_entity(sink);
		} else {
			let found = self
				.bytes
				.get(self.index + 1..)
				.and_then(|rest| memchr2(quote, b'&', rest));
			self.skip_to(found);
		}
	}

	fn state_in_attribute_value_no_quotes<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if is_whitespace(c) || c == b'>' {
			sink.attrib_data(self.slice(self.section_start, self.index));
			self.section_start = NO_SECTION;
			sink.attrib_end();
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c, sink);
		} else if c == b'&' {
			self.start_entity(sink);
		}
	}

	fn state_before_declaration<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'[' {
			self.state = State::CdataSequence;
			self.sequence_index = 0;
		} else if Some(c | 0x20) == Sequence::Doctype.at(0) {
			self.state = State::DeclarationSequence;
			self.sequence = Sequence::Doctype;
			self.sequence_index = 1;
		} else if c == b'>' {
			sink.comment(self.slice(self.section_start, self.index));
			self.state = State::Text;
			self.section_start = self.index + 1;
		} else if c == b'-' {
			self.state = State::BeforeComment;
		} else {
			self.state = State::InSpecialComment;
		}
	}

	fn state_declaration_sequence<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if self.sequence_index == self.sequence.len() {
			self.state = State::InDeclaration;
			self.state_in_declaration(c);
		} else if Some(c | 0x20) == self.sequence.at(self.sequence_index) {
			self.sequence_index += 1;
		} else if c == b'>' {
			sink.comment(self.slice(self.section_start, self.index));
			self.state = State::Text;
			self.section_start = self.index + 1;
		} else {
			self.state = State::InSpecialComment;
		}
	}

	/// A doctype: htmlparser2 reports it as a processing instruction, which
	/// the converter does not listen to.
	fn state_in_declaration(&mut self, c: u8) {
		if c == b'>' || self.fast_forward_to(b'>') {
			self.state = State::Text;
			self.section_start = self.index + 1;
		}
	}

	fn state_before_comment<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'-' {
			self.state = State::InCommentLike;
			self.sequence = Sequence::CommentEnd;
			self.sequence_index = 0;
			self.section_start = self.index + 1;
		} else if c == b'>' {
			sink.comment(self.slice(self.section_start, self.index));
			self.state = State::Text;
			self.section_start = self.index + 1;
		} else {
			self.state = State::InSpecialComment;
		}
	}

	fn state_in_special_comment<S: Sink<'a>>(&mut self, c: u8, sink: &mut S) {
		if c == b'>' || self.fast_forward_to(b'>') {
			sink.comment(self.slice(self.section_start, self.index));
			self.state = State::Text;
			self.section_start = self.index + 1;
		}
	}

	/// `startEntity` + `stateInEntity` + `emitCodePoint` in one step: the
	/// decoder sees the whole rest of the document (one `write`), so it
	/// either decodes, refuses (the `&` stays text and scanning resumes right
	/// after it) or reaches the end of input, where `end()` decides.
	fn start_entity<S: Sink<'a>>(&mut self, sink: &mut S) {
		self.base_state = self.state;
		self.entity_start = self.index;
		let in_text = matches!(self.base_state, State::Text | State::InSpecialTag);
		let mode = if in_text {
			Mode::Legacy
		} else {
			Mode::Attribute
		};
		let rest = self.bytes.get(self.index + 1..).unwrap_or(&[]);
		let Some(decoded) = entities::decode(rest, mode) else {
			return;
		};
		if self.section_start < self.entity_start {
			let before = self.slice(self.section_start, self.entity_start);
			if in_text {
				sink.text(before)
			} else {
				sink.attrib_data(before)
			}
		}
		self.section_start = self.entity_start + decoded.consumed;
		self.index = self.section_start - 1;
		if in_text {
			sink.text_entity(decoded.reference);
		} else {
			sink.attrib_entity(decoded.reference);
		}
	}

	/// Emits what has been read of a text or attribute value at the end of the buffer.
	fn cleanup<S: Sink<'a>>(&mut self, sink: &mut S) {
		if self.section_start == self.index || self.section_start == NO_SECTION {
			return;
		}
		match self.state {
			State::Text | State::InPlainText => {}
			State::InSpecialTag if self.sequence_index == 0 => {}
			State::InAttributeValueDq | State::InAttributeValueSq | State::InAttributeValueNq => {
				sink.attrib_data(self.slice(self.section_start, self.index));
				self.section_start = self.index;
				return;
			}
			_ => return,
		}
		sink.text(self.slice(self.section_start, self.index));
		self.section_start = self.index;
	}

	fn handle_trailing_data<S: Sink<'a>>(&mut self, sink: &mut S) {
		let end = self.bytes.len();
		if self.state == State::InCommentLike {
			if self.sequence == Sequence::CdataEnd {
				// Unclosed CDATA is a bogus comment, starting at its `[`.
				let cdata_start = self.section_start.saturating_sub(Sequence::Cdata.len() + 1);
				sink.comment(self.slice(cdata_start, end));
			} else {
				let offset = self.sequence_index.min(Sequence::CommentEnd.len() - 1);
				sink.comment(self.slice(self.section_start, end.saturating_sub(offset)));
			}
			return;
		}
		match self.state {
			State::BeforeDeclaration
			| State::InSpecialComment
			| State::BeforeComment
			| State::CdataSequence => {
				sink.comment(self.slice(self.section_start, end));
				return;
			}
			State::DeclarationSequence => {
				if self.sequence_index != Sequence::Doctype.len() {
					sink.comment(self.slice(self.section_start, end));
				}
				return;
			}
			State::InDeclaration => return,
			_ => {}
		}
		if self.section_start != NO_SECTION && self.section_start >= end {
			return;
		}
		match self.state {
			// An unfinished open or close tag is dropped.
			State::InTagName
			| State::BeforeAttributeName
			| State::BeforeAttributeValue
			| State::AfterAttributeName
			| State::InAttributeName
			| State::InAttributeValueSq
			| State::InAttributeValueDq
			| State::InAttributeValueNq
			| State::InClosingTagName => {}
			_ if self.section_start == NO_SECTION => sink.text(self.last_code_unit()),
			_ => sink.text(self.slice(self.section_start, end)),
		}
	}

	/// `buffer.slice(-1)`: the TypeScript reaches here with `sectionStart`
	/// still -1 (after `</x ` or `<x /` at end of input). The last UTF-16 unit
	/// of an astral character is a lone surrogate, which a Rust string holds
	/// as U+FFFD.
	fn last_code_unit(&self) -> &'a str {
		let Some(last) = self.input.chars().next_back() else {
			return "";
		};
		if last.len_utf16() == 2 {
			return "\u{FFFD}";
		}
		self.slice(self.input.len() - last.len_utf8(), self.input.len())
	}
}
