//! Decodes a fetched body by the charset it declares (`decodeBody` in
//! `packages/adapters/src/http/charset.ts`), so a Shift_JIS or EUC-JP feed or
//! page is not garbled. Both runners apply the same steps; the TypeScript
//! tests (`packages/adapters/test/charsetCases.ts`) and the tests below
//! share their cases.
//!
//! The first source that names a supported encoding wins:
//!  1. a byte-order mark (`EF BB BF` UTF-8, `FF FE` UTF-16LE, `FE FF` UTF-16BE);
//!  2. the `charset` parameter of `Content-Type`;
//!  3. in the first 1,024 bytes: an XML declaration's `encoding` (only at the
//!     very start), else the `charset` of the first `<meta …>` that has one;
//!  4. otherwise UTF-8.
//!
//! A label the WHATWG Encoding Standard does not know — or its "replacement"
//! encoding, which `TextDecoder` refuses — is skipped and the next source
//! tried. Decoding is non-fatal (U+FFFD for an invalid sequence); UTF-8 goes
//! through [`decode_utf8_owned`], exactly `TextDecoder("utf-8")`.

use encoding_rs::{Encoding, REPLACEMENT, UTF_8, UTF_16BE, UTF_16LE};
use research_js::{text_decoder::decode_utf8_owned, whitespace::trim};

/// How far into the body the XML declaration and HTML meta are looked for.
pub const CHARSET_SNIFF_BYTES: usize = 1024;

const fn is_xml_space(byte: Option<&u8>) -> bool {
	matches!(byte, Some(b' ' | b'\t' | b'\n' | b'\r'))
}

const fn is_html_space(byte: Option<&u8>) -> bool {
	matches!(byte, Some(b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
}

/// Index of `word` (lower-case ASCII) in `bytes[from..to]`; `None` when absent.
fn index_of_ascii(
	bytes: &[u8],
	word: &[u8],
	from: usize,
	to: usize,
	case_insensitive: bool,
) -> Option<usize> {
	let window = bytes.get(from..to)?;
	window
		.windows(word.len())
		.position(|candidate| {
			if case_insensitive {
				candidate.eq_ignore_ascii_case(word)
			} else {
				candidate == word
			}
		})
		.map(|offset| from + offset)
}

fn latin1(bytes: &[u8]) -> String {
	bytes.iter().map(|&byte| char::from(byte)).collect()
}

/// The encoding a label names, as `TextDecoder` accepts it.
fn supported(label: &str) -> Option<&'static Encoding> {
	Encoding::for_label(label.as_bytes()).filter(|encoding| *encoding != REPLACEMENT)
}

fn bom_encoding(bytes: &[u8]) -> Option<&'static Encoding> {
	if bytes.starts_with(b"\xEF\xBB\xBF") {
		Some(UTF_8)
	} else if bytes.starts_with(b"\xFF\xFE") {
		Some(UTF_16LE)
	} else if bytes.starts_with(b"\xFE\xFF") {
		Some(UTF_16BE)
	} else {
		None
	}
}

/// The `charset` parameter of a `Content-Type` value, unquoted
/// (`contentTypeCharset`); `None` when absent or empty.
#[must_use]
pub fn content_type_charset(content_type: Option<&str>) -> Option<String> {
	for parameter in content_type?.split(';').skip(1) {
		let Some((name, value)) = parameter.split_once('=') else {
			continue;
		};
		if trim(name).to_lowercase() != "charset" {
			continue;
		}
		let mut value = trim(value);
		let quoted = value.len() >= 2
			&& ((value.starts_with('"') && value.ends_with('"'))
				|| (value.starts_with('\'') && value.ends_with('\'')));
		if quoted {
			value = trim(value.get(1..value.len() - 1).unwrap_or_default());
		}
		return (!value.is_empty()).then(|| value.to_owned());
	}
	None
}

/// `<?xml … encoding="x" … ?>` at the very start of `head`.
fn xml_declaration_label(head: &[u8]) -> Option<String> {
	if !head.starts_with(b"<?xml") || !is_xml_space(head.get(5)) {
		return None;
	}
	let close = index_of_ascii(head, b"?>", 5, head.len(), false)?;
	let name = index_of_ascii(head, b"encoding", 5, close, false)?;
	let mut index = name + b"encoding".len();
	while index < close && is_xml_space(head.get(index)) {
		index += 1;
	}
	if head.get(index) != Some(&b'=') {
		return None;
	}
	index += 1;
	while index < close && is_xml_space(head.get(index)) {
		index += 1;
	}
	let quote = *head.get(index).filter(|q| **q == b'"' || **q == b'\'')?;
	let start = index + 1;
	let mut end = start;
	while end < close && head.get(end) != Some(&quote) {
		end += 1;
	}
	if end >= close || end == start {
		return None;
	}
	head.get(start..end).map(latin1)
}

const fn ends_meta_value(byte: u8) -> bool {
	matches!(
		byte,
		b'\t' | b'\n' | 0x0c | b'\r' | b' ' | b'"' | b'\'' | b';' | b'>' | b'/'
	)
}

/// The `charset` of the first `<meta …>` in `head` that names one.
fn meta_charset_label(head: &[u8]) -> Option<String> {
	let end = head.len();
	let mut from = 0;
	loop {
		let tag = index_of_ascii(head, b"<meta", from, end, true)?;
		from = tag + 5;
		let after = head.get(from);
		if !(is_html_space(after) || after == Some(&b'/')) {
			continue;
		}
		let mut tag_end = from;
		while tag_end < end && head.get(tag_end) != Some(&b'>') {
			tag_end += 1;
		}
		let mut search = from;
		while let Some(name) = index_of_ascii(head, b"charset", search, tag_end, true) {
			search = name + b"charset".len();
			let mut index = search;
			while index < tag_end && is_html_space(head.get(index)) {
				index += 1;
			}
			if head.get(index) != Some(&b'=') {
				continue;
			}
			index += 1;
			while index < tag_end && is_html_space(head.get(index)) {
				index += 1;
			}
			if matches!(head.get(index), Some(b'"' | b'\'')) {
				index += 1;
			}
			while index < tag_end && is_html_space(head.get(index)) {
				index += 1;
			}
			let mut value_end = index;
			while value_end < tag_end && !head.get(value_end).is_none_or(|b| ends_meta_value(*b)) {
				value_end += 1;
			}
			if value_end > index {
				return head.get(index..value_end).map(latin1);
			}
		}
		from = tag_end;
	}
}

/// The encoding [`decode_body`] decodes `bytes` with (`bodyEncoding`).
#[must_use]
pub fn body_encoding(bytes: &[u8], content_type: Option<&str>) -> &'static Encoding {
	if let Some(bom) = bom_encoding(bytes) {
		return bom;
	}
	if let Some(encoding) = content_type_charset(content_type)
		.as_deref()
		.and_then(supported)
	{
		return encoding;
	}
	let head = bytes.get(..CHARSET_SNIFF_BYTES).unwrap_or(bytes);
	xml_declaration_label(head)
		.as_deref()
		.and_then(supported)
		.or_else(|| meta_charset_label(head).as_deref().and_then(supported))
		.unwrap_or(UTF_8)
}

/// `bytes` as text, decoded by the charset they declare (`decodeBody`).
#[must_use]
pub fn decode_body(bytes: Vec<u8>, content_type: Option<&str>) -> String {
	let encoding = body_encoding(&bytes, content_type);
	if encoding == UTF_8 {
		return decode_utf8_owned(bytes);
	}
	// Like `TextDecoder(label)`: that encoding's own byte-order mark is dropped.
	encoding.decode_with_bom_removal(&bytes).0.into_owned()
}

#[cfg(test)]
mod tests {
	use super::*;

	/// "日本語" in Shift_JIS and EUC-JP.
	const SJIS: &[u8] = b"\x93\xFA\x96\x7B\x8C\xEA";
	const EUC: &[u8] = b"\xC6\xFC\xCB\xDC\xB8\xEC";

	fn with(prefix: &[u8], body: &[u8], suffix: &[u8]) -> Vec<u8> {
		[prefix, body, suffix].concat()
	}

	/// The cases of `packages/adapters/test/charsetCases.ts`.
	#[test]
	fn decodes_by_header_then_declaration_then_meta_else_utf8() {
		assert_eq!(
			decode_body(SJIS.to_vec(), Some("text/html; charset=Shift_JIS")),
			"日本語"
		);
		assert_eq!(
			decode_body(EUC.to_vec(), Some("text/xml; Charset=\"euc-jp\"")),
			"日本語"
		);
		let xml = with(
			b"<?xml version=\"1.0\" encoding='Shift_JIS'?><rss><title>",
			SJIS,
			b"</title></rss>",
		);
		assert!(decode_body(xml.clone(), Some("text/xml")).contains("<title>日本語</title>"));
		// The header wins over the declaration.
		assert!(!decode_body(xml, Some("text/xml; charset=utf-8")).contains("日本語"));
		let meta = with(
			b"<html><head><META http-equiv=\"Content-Type\" content=\"text/html; charset=euc-jp\">",
			EUC,
			b"",
		);
		assert!(decode_body(meta, None).ends_with("日本語"));
		let meta5 = with(b"<meta charset=shift_jis><p>", SJIS, b"");
		assert!(decode_body(meta5, Some("text/html")).ends_with("日本語"));
		// Unknown labels (and "replacement") are skipped; then UTF-8.
		let unknown = with(b"<meta charset=\"x-unknown\"><p>", "日本語".as_bytes(), b"");
		assert!(decode_body(unknown, Some("text/html; charset=bogus")).ends_with("日本語"));
		assert_eq!(
			decode_body(
				"é".as_bytes().to_vec(),
				Some("text/html; charset=iso-2022-kr")
			),
			"é"
		);
		// A declaration not at the very start, or past the first 1,024 bytes, is not read.
		let late = with(
			b" <?xml version=\"1.0\" encoding=\"shift_jis\"?>",
			SJIS,
			b"",
		);
		assert!(decode_body(late, None).ends_with('\u{FFFD}'));
		let far = with(&[b' '; 1024], b"<meta charset=shift_jis>", SJIS);
		assert!(decode_body(far, None).contains('\u{FFFD}'));
		// A byte-order mark beats everything and is dropped.
		assert_eq!(
			decode_body(
				b"\xFF\xFEa\x00".to_vec(),
				Some("text/plain; charset=shift_jis")
			),
			"a"
		);
		assert_eq!(decode_body(b"\xEF\xBB\xBFa".to_vec(), None), "a");
		// windows-1252 (latin1 label) for an 8-bit page.
		assert_eq!(
			decode_body(b"caf\xE9".to_vec(), Some("text/html; charset=ISO-8859-1")),
			"café"
		);
	}

	#[test]
	fn reads_the_content_type_charset_parameter() {
		assert_eq!(
			content_type_charset(Some("text/html; charset=UTF-8")).as_deref(),
			Some("UTF-8")
		);
		assert_eq!(
			content_type_charset(Some("text/html;charset='x'")).as_deref(),
			Some("x")
		);
		assert_eq!(content_type_charset(Some("text/html; charset=")), None);
		assert_eq!(content_type_charset(Some("charset=utf-8")), None);
		assert_eq!(content_type_charset(None), None);
	}
}
