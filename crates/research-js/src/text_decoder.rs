//! `new TextDecoder("utf-8").decode(bytes)` — the non-fatal WHATWG UTF-8
//! decoder every fetched body goes through (`safeFetchCore.ts`,
//! `googleHttp.ts`).
//!
//! Two rules matter: ONE leading byte-order mark (`EF BB BF`) is removed
//! (`ignoreBOM` defaults to false), and each invalid sequence becomes U+FFFD
//! by the "maximal subpart" rule. `String::from_utf8_lossy` follows the same
//! replacement rule but keeps the BOM, so the BOM is stripped first.
//! `vectors/net/text-decoder.json` pins the two against Node.

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Decodes `bytes` exactly as `new TextDecoder("utf-8").decode(bytes)` does.
#[must_use]
pub fn decode_utf8(bytes: &[u8]) -> String {
	let body = bytes.strip_prefix(BOM).unwrap_or(bytes);
	String::from_utf8_lossy(body).into_owned()
}

/// [`decode_utf8`] taking ownership: valid UTF-8 without a BOM (the common
/// case for a large page) is reused without copying.
#[must_use]
pub fn decode_utf8_owned(bytes: Vec<u8>) -> String {
	if bytes.starts_with(BOM) {
		return decode_utf8(&bytes);
	}
	match String::from_utf8(bytes) {
		Ok(text) => text,
		Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strips_one_bom_and_replaces_maximal_subparts() {
		assert_eq!(decode_utf8(b"\xEF\xBB\xBF\xEF\xBB\xBFa"), "\u{FEFF}a");
		assert_eq!(decode_utf8(b""), "");
		assert_eq!(decode_utf8(b"\xEF\xBB"), "\u{FFFD}");
		assert_eq!(
			decode_utf8(b"\xF0\x9F\x98\x41\xE2\x28\xA1\xC0\xAF\xED\xA0\x80"),
			"\u{FFFD}A\u{FFFD}(\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}"
		);
		assert_eq!(decode_utf8_owned(b"\xEF\xBB\xBFok".to_vec()), "ok");
		assert_eq!(decode_utf8_owned(b"ok\xFF".to_vec()), "ok\u{FFFD}");
	}
}
