//! The status an external service answered with (docs/rule/error_handling.md
//! §4a "External-service errors keep their status"), a port of
//! `packages/domain/src/upstream.ts`.
//!
//! When a third-party service (a feed host, SEC, JPX, FRED, Twelve Data,
//! Finnhub, Tavily, GDELT, Google, the Claude API, OpenRouter, a model CLI
//! reporting its API's status) answers with an error, the code that receives
//! the answer keeps that status as a number, exactly as received, and every
//! failure built from it carries it unchanged. Our own codes classify the
//! failure; they never replace the status.

use serde_json::Value;

/// HTTP status codes are three digits, 1xx–5xx (RFC 9110 §15).
pub const UPSTREAM_STATUS_MIN: u16 = 100;
/// The largest status an external service can answer with.
pub const UPSTREAM_STATUS_MAX: u16 = 599;

/// A value that can be an HTTP status an external service answered with
/// (`isUpstreamStatus`: an integer in 100..=599).
#[must_use]
pub fn is_upstream_status(value: f64) -> bool {
	value.fract() == 0.0
		&& value >= f64::from(UPSTREAM_STATUS_MIN)
		&& value <= f64::from(UPSTREAM_STATUS_MAX)
}

/// `value` as a status when it can be one an external service answered with,
/// else `None`. For statuses read from a parsed provider document (a CLI's
/// `api_error_status`, a JSON error `code`), which may hold anything.
#[must_use]
pub fn upstream_status_from_number(value: f64) -> Option<u16> {
	if !is_upstream_status(value) {
		return None;
	}
	// Checked above: integral and in 100..=599, so the conversion is exact.
	#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
	let status = value as u16;
	Some(status)
}

/// `upstreamStatusOrNull(value: unknown)`: the JSON value as a status when it
/// is a number that can be one, else `None` (a string, a fraction, 1234 …).
#[must_use]
pub fn upstream_status_or_null(value: &Value) -> Option<u16> {
	value.as_f64().and_then(upstream_status_from_number)
}

/// The HTTP status our API answers with for a failure an external service
/// caused: the upstream's own status when it is an error status (4xx/5xx),
/// otherwise `fallback`. A 1xx–3xx is kept in the failure body unchanged but
/// cannot be the status line of our error response, because a browser reads
/// those as "continue" or "go elsewhere", not as a failure.
#[must_use]
pub fn response_status_for_upstream(upstream_status: Option<u16>, fallback: u16) -> u16 {
	match upstream_status {
		Some(status)
			if (UPSTREAM_STATUS_MIN..=UPSTREAM_STATUS_MAX).contains(&status) && status >= 400 =>
		{
			status
		}
		_ => fallback,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn accepts_exactly_the_three_digit_statuses() {
		for value in [100.0, 200.0, 404.0, 418.0, 529.0, 599.0] {
			assert!(is_upstream_status(value), "{value}");
		}
		for value in [
			99.0,
			600.0,
			0.0,
			-404.0,
			404.5,
			f64::NAN,
			f64::INFINITY,
			1234.0,
		] {
			assert!(!is_upstream_status(value), "{value}");
		}
	}

	#[test]
	fn reads_a_status_from_a_parsed_document_without_correcting_it() {
		assert_eq!(upstream_status_or_null(&json!(529)), Some(529));
		assert_eq!(upstream_status_or_null(&json!(418.0)), Some(418));
		assert_eq!(upstream_status_or_null(&json!(100)), Some(100));
		assert_eq!(upstream_status_or_null(&json!(1234)), None);
		assert_eq!(upstream_status_or_null(&json!(404.5)), None);
		assert_eq!(upstream_status_or_null(&json!("404")), None);
		assert_eq!(upstream_status_or_null(&Value::Null), None);
		assert_eq!(upstream_status_from_number(503.0), Some(503));
		assert_eq!(upstream_status_from_number(-1.0), None);
	}

	#[test]
	fn answers_with_the_upstream_error_status_only() {
		assert_eq!(response_status_for_upstream(Some(529), 502), 529);
		assert_eq!(response_status_for_upstream(Some(404), 502), 404);
		assert_eq!(response_status_for_upstream(Some(400), 502), 400);
		// A 1xx–3xx stays in the body; the status line keeps the code's own.
		assert_eq!(response_status_for_upstream(Some(302), 502), 502);
		assert_eq!(response_status_for_upstream(Some(200), 502), 502);
		assert_eq!(response_status_for_upstream(Some(600), 502), 502);
		assert_eq!(response_status_for_upstream(None, 504), 504);
	}
}
