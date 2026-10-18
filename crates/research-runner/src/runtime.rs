//! The environment ports of the application layer (ARCH-002: time and
//! randomness are injected): the system clock, SHA-256 and fence tokens.

use std::time::{SystemTime, UNIX_EPOCH};

use research_application::ports::{Clock, Hasher};
use sha2::{Digest, Sha256};

/// `systemClock`: epoch milliseconds and `Date.prototype.toISOString`
/// (UTC, millisecond truncation, always three fraction digits and `Z`).
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
	fn now_ms(&self) -> i64 {
		let elapsed = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default();
		i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
	}

	fn now_iso(&self) -> String {
		// The system clock is always inside JavaScript's date range.
		research_js::date::epoch_ms_to_iso(self.now_ms()).unwrap_or_default()
	}
}

/// `webCryptoHasher`: lowercase hex SHA-256 of the UTF-8 text.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sha256Hasher;

impl Hasher for Sha256Hasher {
	fn sha256_hex(&self, text: &str) -> String {
		hex::encode(Sha256::digest(text.as_bytes()))
	}
}

/// The panic payload when the operating system has no randomness.
struct RandomnessUnavailable;

/// `crypto.randomUUID()`: a lowercase hyphenated UUID v4. The token fences
/// untrusted text inside a prompt (AGT-007), so it must be unguessable; with
/// no randomness the job faults instead of using a weak token.
#[must_use]
pub fn new_fence_token() -> String {
	let mut bytes = [0_u8; 16];
	if getrandom::getrandom(&mut bytes).is_err() {
		std::panic::resume_unwind(Box::new(RandomnessUnavailable));
	}
	format_uuid_v4(bytes)
}

/// Sets the version and variant bits and formats as `8-4-4-4-12`.
fn format_uuid_v4(mut bytes: [u8; 16]) -> String {
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let hex = hex::encode(bytes);
	format!(
		"{}-{}-{}-{}-{}",
		&hex[0..8],
		&hex[8..12],
		&hex[12..16],
		&hex[16..20],
		&hex[20..32]
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_clock_prints_javascript_iso_strings() {
		let iso = SystemClock.now_iso();
		assert_eq!(iso.len(), 24, "{iso}");
		assert!(iso.ends_with('Z') && iso.as_bytes().get(10) == Some(&b'T'));
		assert!(SystemClock.now_ms() > 1_790_000_000_000);
	}

	#[test]
	fn sha256_matches_the_known_digest() {
		assert_eq!(
			Sha256Hasher.sha256_hex("abc"),
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
		);
		assert_eq!(
			Sha256Hasher.sha256_hex(""),
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
	}

	#[test]
	fn fence_tokens_are_lowercase_uuid_v4_and_unique() {
		let first = new_fence_token();
		let second = new_fence_token();
		assert_ne!(first, second);
		for token in [&first, &second] {
			assert_eq!(token.len(), 36);
			assert!(
				token
					.chars()
					.all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c))
			);
			assert_eq!(token.as_bytes().get(14), Some(&b'4'));
			assert!(matches!(
				token.as_bytes().get(19),
				Some(b'8' | b'9' | b'a' | b'b')
			));
		}
		assert_eq!(
			format_uuid_v4([0xff; 16]),
			"ffffffff-ffff-4fff-bfff-ffffffffffff"
		);
	}
}
