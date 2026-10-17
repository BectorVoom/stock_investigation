//! `encodeURIComponent`.

/// Characters `encodeURIComponent` leaves as they are.
const fn is_unreserved(byte: u8) -> bool {
	matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
}

/// `encodeURIComponent(text)`: every byte of the UTF-8 encoding outside the
/// unreserved set becomes `%XX` with upper-case hex.
#[must_use]
pub fn encode_uri_component(text: &str) -> String {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let mut encoded = String::with_capacity(text.len());
	for &byte in text.as_bytes() {
		if is_unreserved(byte) {
			encoded.push(char::from(byte));
		} else {
			encoded.push('%');
			encoded.push(char::from(
				HEX.get(usize::from(byte >> 4)).copied().unwrap_or(b'0'),
			));
			encoded.push(char::from(
				HEX.get(usize::from(byte & 0x0F)).copied().unwrap_or(b'0'),
			));
		}
	}
	encoded
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn encodes_like_javascript() {
		assert_eq!(
			encode_uri_component("gold price 2026"),
			"gold%20price%202026"
		);
		assert_eq!(encode_uri_component("a&b=c/d?e#f"), "a%26b%3Dc%2Fd%3Fe%23f");
		assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
		assert_eq!(encode_uri_component("é😀"), "%C3%A9%F0%9F%98%80");
	}
}
