//! The one `Retry-After` reader (RFC 9110 section 10.2.3) of the Rust runner:
//! the model providers, Google Calendar and Tavily all read the header here
//! (`packages/adapters/src/runtime/retryAfter.ts`). Each caller applies its own
//! cap; this only turns the header into a wait.

use research_js::whitespace::trim;

/// Reads a Retry-After header: delay-seconds or an HTTP date, as
/// milliseconds from `now` (a date in the past is 0). `None` when absent or
/// unreadable — a negative or fractional number, or text that is not a date.
/// A huge digit string stays huge (or infinite), so every cap refuses it.
#[must_use]
pub fn parse_retry_after_ms(value: Option<&str>, now: f64) -> Option<f64> {
	let value = trim(value?);
	if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
		return Some(value.parse::<f64>().unwrap_or(f64::INFINITY) * 1000.0);
	}
	// An HTTP date always names its weekday; this keeps "-5" from parsing as a year.
	let bytes = value.as_bytes();
	if !bytes
		.get(..3)
		.is_some_and(|b| b.iter().all(u8::is_ascii_alphabetic))
		|| bytes.get(3..5) != Some(b", ")
	{
		return None;
	}
	let at = research_js::date::parse(value);
	at.is_finite().then(|| (at - now).max(0.0))
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The cases of `packages/adapters/test/node/retryAfter.test.ts`.
	#[test]
	fn reads_seconds_and_dates_only() {
		let now = research_js::date::parse("2026-10-31T07:00:00.000Z");
		assert_eq!(parse_retry_after_ms(Some("7"), now), Some(7_000.0));
		assert_eq!(parse_retry_after_ms(Some(" 0 "), now), Some(0.0));
		assert_eq!(parse_retry_after_ms(Some("3600"), now), Some(3_600_000.0));
		assert_eq!(
			parse_retry_after_ms(Some("Sat, 31 Oct 2026 07:00:12 GMT"), now),
			Some(12_000.0)
		);
		assert_eq!(
			parse_retry_after_ms(Some("Sat, 31 Oct 2026 06:00:00 GMT"), now),
			Some(0.0)
		);
		for value in ["", "-5", "1.5", "soon", "12 s", "Sat 31 Oct 2026"] {
			assert_eq!(parse_retry_after_ms(Some(value), now), None, "{value}");
		}
		assert_eq!(parse_retry_after_ms(None, now), None);
	}
}
