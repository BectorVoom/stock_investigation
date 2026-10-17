//! Character references: a port of entities 8.1.0's streaming `EntityDecoder`
//! (`src/decode.ts`) as htmlparser2 12.0.0 drives it — one `write` over the
//! whole remaining input, then `end()` at end of input.
//!
//! The named references are looked up in the very trie the package ships
//! (`entities_data.rs`, generated from `htmlDecodeTree`), walked node for
//! node like `stateNamedEntity`, so longest-match, legacy (no-semicolon)
//! names and the attribute-mode rules are the package's by construction.
//! Every comparison is against an ASCII byte, so walking UTF-8 bytes makes the
//! same decisions as the JavaScript walk over UTF-16 code units.

use crate::entities_data::HTML_DECODE_TREE;

const VALUE_LENGTH: u16 = 0b1100_0000_0000_0000;
const FLAG13: u16 = 0b0010_0000_0000_0000;
const BRANCH_LENGTH: u16 = 0b0001_1111_1000_0000;
const JUMP_TABLE: u16 = 0b0000_0000_0111_1111;
const VALUE_MASK: u16 = 0b0001_1111_1111_1111;

/// Windows-1252 replacements for numeric references to U+0080..U+009F
/// (`decode-codepoint.ts`); 0 keeps the code point.
const C1_REPLACEMENTS: [u32; 32] = [
	8364, 0, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 0, 381, 0, 0, 8216,
	8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 0, 382, 376,
];

/// Code points above this are invalid; numeric accumulation saturates just
/// past it, which decides exactly like the JavaScript double accumulator
/// (it only ever grows, so "> 0x10FFFF" is settled once crossed).
const PAST_UNICODE: u32 = 0x11_0000;

/// How a reference is decoded (`DecodingMode`; `Strict` is XML-only).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mode {
	/// Text and RCDATA: legacy names match without `;`.
	Legacy,
	/// Attribute values: a legacy match without `;` is refused before `=` or
	/// an ASCII letter or digit.
	Attribute,
}

/// What a decoded reference stands for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Reference {
	/// A numeric reference, after `replaceCodePoint`.
	Numeric(char),
	/// A named reference: one or two UTF-16 code units, as the trie stores
	/// them (an astral character is a surrogate pair here).
	Named(u16, Option<u16>),
}

/// A decoded reference and how many bytes it spans, `&` included.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Decoded {
	pub(crate) consumed: usize,
	pub(crate) reference: Reference,
}

fn word(index: usize) -> u16 {
	HTML_DECODE_TREE.get(index).copied().unwrap_or(0)
}

fn usize_of(value: u16) -> usize {
	usize::from(value)
}

const fn is_ascii_alnum_or_equals(byte: u8) -> bool {
	byte == b'=' || byte.is_ascii_alphanumeric()
}

/// Decodes the reference whose `&` sits just before `input` (the rest of the
/// document). `None` means the `&` is literal text.
pub(crate) fn decode(input: &[u8], mode: Mode) -> Option<Decoded> {
	match input.first() {
		Some(b'#') => numeric(input, mode),
		_ => named(input, mode),
	}
}

/// `stateNumericStart` / `stateNumericHex` / `stateNumericDecimal` /
/// `emitNumericEntity`, with `end()` applied when the input runs out.
fn numeric(input: &[u8], _mode: Mode) -> Option<Decoded> {
	// `&#` consumed so far.
	let mut consumed = 2usize;
	let mut offset = 1usize;
	let hex = matches!(input.get(offset), Some(byte) if byte | 0x20 == b'x');
	// `&#` at end of input: no digits.
	input.get(offset)?;
	if hex {
		consumed += 1;
		offset += 1;
	}
	let expected = if hex { 3 } else { 2 };
	let mut value = 0u32;
	let mut last = None;
	while let Some(&byte) = input.get(offset) {
		let digit = match byte {
			b'0'..=b'9' => u32::from(byte - b'0'),
			b'a'..=b'f' if hex => u32::from(byte - b'a') + 10,
			b'A'..=b'F' if hex => u32::from(byte - b'A') + 10,
			_ => {
				last = Some(byte);
				break;
			}
		};
		let base = if hex { 16 } else { 10 };
		value = value
			.saturating_mul(base)
			.saturating_add(digit)
			.min(PAST_UNICODE);
		consumed += 1;
		offset += 1;
	}
	if consumed <= expected {
		return None;
	}
	if last == Some(b';') {
		consumed += 1;
	}
	// Legacy and attribute modes both accept a missing `;` (only XML's strict mode refuses).
	Some(Decoded {
		consumed,
		reference: Reference::Numeric(replace_code_point(value)),
	})
}

/// `replaceCodePoint`: NUL, surrogates and out-of-range values become U+FFFD,
/// C1 controls their Windows-1252 characters.
fn replace_code_point(code_point: u32) -> char {
	if code_point == 0 || (0xd800..=0xdfff).contains(&code_point) || code_point > 0x10_ffff {
		return '\u{FFFD}';
	}
	let replaced = code_point
		.checked_sub(128)
		.and_then(|offset| usize::try_from(offset).ok())
		.and_then(|offset| C1_REPLACEMENTS.get(offset))
		.copied()
		.filter(|&replacement| replacement != 0)
		.unwrap_or(code_point);
	char::from_u32(replaced).unwrap_or('\u{FFFD}')
}

/// Walk state flushed into the failure / end-of-input decisions.
struct Walk {
	/// Trie index of the best legacy match so far (0 = none).
	result: usize,
	consumed: usize,
	excess: usize,
	tree_index: usize,
}

impl Walk {
	/// `flushAndEmitLegacyOrReject`.
	fn fail(&self, mode: Mode, byte: u8, value_length: u16) -> Option<Decoded> {
		let refused = self.result == 0
			|| (mode == Mode::Attribute
				&& (value_length == 0 || self.excess > 1 || is_ascii_alnum_or_equals(byte)));
		if refused {
			None
		} else {
			Some(self.emit_legacy())
		}
	}

	/// `end()` in the named state: the recorded legacy match, in attribute
	/// mode only when the walk stopped exactly on it.
	fn end(&self, mode: Mode) -> Option<Decoded> {
		let accepted =
			self.result != 0 && (mode != Mode::Attribute || self.result == self.tree_index);
		accepted.then(|| self.emit_legacy())
	}

	/// `emitNotTerminatedNamedEntity`.
	fn emit_legacy(&self) -> Decoded {
		emit_named(self.result, word(self.result) >> 14, self.consumed)
	}
}

/// `emitNamedEntityData`.
fn emit_named(node: usize, value_length: u16, consumed: usize) -> Decoded {
	let first = if value_length == 1 {
		word(node) & VALUE_MASK
	} else {
		word(node + 1)
	};
	let second = (value_length == 3).then(|| word(node + 2));
	Decoded {
		consumed,
		reference: Reference::Named(first, second),
	}
}

/// `determineBranch`: the child reached by `byte`, if any.
fn determine_branch(current: u16, node_index: usize, byte: u8) -> Option<usize> {
	let branch_count = usize_of((current & BRANCH_LENGTH) >> 7);
	let jump_offset = current & JUMP_TABLE;
	let character = u16::from(byte);
	if jump_offset != 0 {
		if branch_count == 0 {
			return (character == jump_offset).then_some(node_index);
		}
		let slot = usize_of(character.checked_sub(jump_offset)?);
		if slot >= branch_count {
			return None;
		}
		let stored = usize_of(word(node_index + slot));
		if stored == 0 {
			return None;
		}
		return Some((node_index + branch_count + stored - 1) & 0xffff);
	}
	if branch_count == 0 {
		return None;
	}
	let packed_key_slots = (branch_count + 1) >> 1;
	let branch_end = node_index + packed_key_slots + branch_count;
	for index in 0..branch_count {
		let packed = word(node_index + (index >> 1));
		let key = (packed >> ((index & 1) << 3)) & 0xff;
		if key == character {
			let pointer = usize_of(word(node_index + packed_key_slots + index));
			return Some((branch_end + pointer) & 0xffff);
		}
		// Keys are sorted; past `byte` no match is possible.
		if key > character {
			return None;
		}
	}
	None
}

/// `stateNamedEntity` over the whole rest of the document, then `end()`.
fn named(input: &[u8], mode: Mode) -> Option<Decoded> {
	let mut walk = Walk {
		result: 0,
		consumed: 1,
		excess: 1,
		tree_index: 0,
	};
	let mut current = word(0);
	let mut offset = 0usize;
	let length = input.len();
	while offset < length {
		// Value-less jump-table nodes (and the single-branch encoding) inline.
		while (current & (VALUE_LENGTH | FLAG13)) == 0 && (current & JUMP_TABLE) != 0 {
			let Some(&byte) = input.get(offset) else {
				break;
			};
			let jump_offset = current & JUMP_TABLE;
			let branch_count = usize_of((current & BRANCH_LENGTH) >> 7);
			if branch_count == 0 {
				if u16::from(byte) != jump_offset {
					return walk.fail(mode, byte, 0);
				}
				walk.tree_index += 1;
			} else {
				let slot = u16::from(byte).checked_sub(jump_offset).map(usize_of);
				let Some(slot) = slot.filter(|&slot| slot < branch_count) else {
					return walk.fail(mode, byte, 0);
				};
				let stored = usize_of(word(walk.tree_index + 1 + slot));
				if stored == 0 {
					return walk.fail(mode, byte, 0);
				}
				walk.tree_index = (walk.tree_index + branch_count + stored) & 0xffff;
			}
			current = word(walk.tree_index);
			offset += 1;
			walk.excess += 1;
			if offset >= length {
				break;
			}
		}
		let Some(&byte) = input.get(offset) else {
			break;
		};

		// Compact runs: a chain of single-child nodes stored as packed bytes.
		if (current & (VALUE_LENGTH | FLAG13)) == FLAG13 {
			let run_length = usize_of((current & BRANCH_LENGTH) >> 7);
			if u16::from(byte) != (current & JUMP_TABLE) {
				return walk.fail(mode, byte, 0);
			}
			offset += 1;
			walk.excess += 1;
			let mut run_consumed = 1usize;
			while run_consumed < run_length {
				let Some(&byte) = input.get(offset) else {
					// Input ends inside the run: `end()` with the walk state as is.
					return walk.end(mode);
				};
				let char_index = run_consumed - 1;
				let packed = word(walk.tree_index + 1 + (char_index >> 1));
				let expected = (packed >> ((char_index & 1) << 3)) & 0xff;
				if u16::from(byte) != expected {
					return walk.fail(mode, byte, 0);
				}
				offset += 1;
				walk.excess += 1;
				run_consumed += 1;
			}
			walk.tree_index += 1 + (run_length >> 1);
			current = word(walk.tree_index);
			continue;
		}

		let value_length = current >> 14;
		if value_length != 0 {
			// A legacy match (FLAG13 clear: semicolon optional) is recorded.
			if (current & FLAG13) == 0 {
				walk.result = walk.tree_index;
				walk.consumed += walk.excess - 1;
				walk.excess = 1;
			}
			if byte == b';' {
				return Some(emit_named(
					walk.tree_index,
					value_length,
					walk.consumed + walk.excess,
				));
			}
			// An inline value marks a leaf: no branches to follow.
			if value_length == 1 {
				return walk.fail(mode, byte, value_length);
			}
		}
		let branch_data = walk.tree_index + usize_of(value_length.max(1));
		let Some(next) = determine_branch(current, branch_data, byte) else {
			return walk.fail(mode, byte, value_length);
		};
		walk.tree_index = next;
		current = word(walk.tree_index);
		offset += 1;
		walk.excess += 1;
	}
	// Input exhausted: record a legacy match we may sit on, then `end()`.
	if (current >> 14) != 0 && (current & FLAG13) == 0 {
		walk.result = walk.tree_index;
		walk.consumed += walk.excess - 1;
		walk.excess = 1;
	}
	walk.end(mode)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn text(input: &str) -> Option<(usize, String)> {
		decode(input.as_bytes(), Mode::Legacy).map(|decoded| (decoded.consumed, render(decoded)))
	}

	fn attribute(input: &str) -> Option<(usize, String)> {
		decode(input.as_bytes(), Mode::Attribute).map(|decoded| (decoded.consumed, render(decoded)))
	}

	fn render(decoded: Decoded) -> String {
		match decoded.reference {
			Reference::Numeric(character) => character.to_string(),
			Reference::Named(first, second) => {
				let units: Vec<u16> = std::iter::once(first).chain(second).collect();
				String::from_utf16_lossy(&units)
			}
		}
	}

	#[test]
	fn named_references_take_the_longest_match() {
		assert_eq!(text("amp;x"), Some((5, "&".to_owned())));
		assert_eq!(text("ampx"), Some((4, "&".to_owned())));
		assert_eq!(text("notin;"), Some((7, "∉".to_owned())));
		assert_eq!(text("notinx"), Some((4, "¬".to_owned())));
		assert_eq!(text("notin"), Some((4, "¬".to_owned())));
		assert_eq!(text("zzz;"), None);
		assert_eq!(text("Afr;"), Some((5, "𝔄".to_owned())));
		assert_eq!(text("NotEqualTilde;"), Some((15, "≂\u{338}".to_owned())));
	}

	#[test]
	fn attribute_mode_refuses_unterminated_legacy_names_before_alnum_or_equals() {
		assert_eq!(attribute("copy=2"), None);
		assert_eq!(attribute("notx"), None);
		assert_eq!(attribute("not;"), Some((5, "¬".to_owned())));
		assert_eq!(attribute("not "), Some((4, "¬".to_owned())));
		// A legacy match passed on the way to a longer, failed name is refused.
		assert_eq!(attribute("notin "), None);
		assert_eq!(text("notin "), Some((4, "¬".to_owned())));
	}

	#[test]
	fn numeric_references_follow_replace_code_point() {
		assert_eq!(text("#65;"), Some((5, "A".to_owned())));
		assert_eq!(text("#x41"), Some((5, "A".to_owned())));
		assert_eq!(text("#X41;"), Some((6, "A".to_owned())));
		assert_eq!(text("#x80;"), Some((6, "€".to_owned())));
		assert_eq!(text("#x81;"), Some((6, "\u{81}".to_owned())));
		assert_eq!(text("#0;"), Some((4, "\u{FFFD}".to_owned())));
		assert_eq!(text("#xD800;"), Some((8, "\u{FFFD}".to_owned())));
		assert_eq!(text("#99999999999;"), Some((14, "\u{FFFD}".to_owned())));
		assert_eq!(text("#x1F600;"), Some((9, "😀".to_owned())));
		assert_eq!(text("#;"), None);
		assert_eq!(text("#x;"), None);
		assert_eq!(text("#"), None);
	}
}
