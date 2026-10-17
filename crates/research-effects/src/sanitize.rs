//! Port of `sanitizeLogCall` (`logging.ts`): the content rule (SEC-010).

use research_js::utf16;

use crate::line::LogValue;

/// String field values longer than this (UTF-16 units), or spanning more
/// than one line, are never written. Identifiers, codes, model ids, short
/// reasons and counts all fit; prompts, page text and stack traces do not.
pub const MAX_LOG_FIELD_CHARS: usize = 200;

/// Event recorded when a log call's event is not a valid event name.
pub const INVALID_LOG_EVENT: &str = "invalid_log_event";

/// Field-name segments (compared case-insensitively) that mark a field as
/// sensitive: the field is dropped and counted in `redacted_fields`.
const SENSITIVE_FIELD_SEGMENTS: [&str; 16] = [
	"token",
	"secret",
	"password",
	"passwd",
	"authorization",
	"cookie",
	"credential",
	"apikey",
	"prompt",
	"content",
	"text",
	"body",
	"message",
	"stack",
	"quote",
	"excerpt",
];

/// `LOG_EVENT_PATTERN`: `/^[a-z][a-z0-9_]{1,63}$/` — a lowercase letter
/// followed by 1..=63 lowercase letters, digits or underscores.
#[must_use]
pub fn is_log_event_name(event: &str) -> bool {
	let bytes = event.as_bytes();
	matches!(bytes.first(), Some(b'a'..=b'z'))
		&& (2..=64).contains(&bytes.len())
		&& bytes
			.iter()
			.all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

/// `fieldSegments`: the name split on
/// `/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/`,
/// empty segments dropped, lower-cased — written without look-around.
fn field_segments(name: &str) -> Vec<String> {
	let characters: Vec<char> = name.chars().collect();
	let mut segments = Vec::new();
	let mut current = String::new();
	for (index, character) in characters.iter().enumerate() {
		if !character.is_ascii_alphanumeric() {
			if !current.is_empty() {
				segments.push(std::mem::take(&mut current));
			}
			continue;
		}
		if let Some(previous) = index
			.checked_sub(1)
			.and_then(|before| characters.get(before))
		{
			let lower_to_upper = (previous.is_ascii_lowercase() || previous.is_ascii_digit())
				&& character.is_ascii_uppercase();
			let acronym_end = previous.is_ascii_uppercase()
				&& character.is_ascii_uppercase()
				&& characters
					.get(index + 1)
					.is_some_and(char::is_ascii_lowercase);
			if (lower_to_upper || acronym_end) && !current.is_empty() {
				segments.push(std::mem::take(&mut current));
			}
		}
		current.push(character.to_ascii_lowercase());
	}
	if !current.is_empty() {
		segments.push(current);
	}
	segments
}

/// `isSensitiveFieldName`: true when a field name denotes sensitive
/// content. Matching is per whole word or per camelCase / snake_case /
/// kebab-case segment, so `runnerToken` and `apiKey` are caught while
/// `context` (one segment that merely contains "text") is not.
/// `credentialId` (an identifier, not the credential) and `promptVersion`
/// (the short template version, never prompt text) are the two exceptions.
#[must_use]
pub fn is_sensitive_field_name(name: &str) -> bool {
	let segments = field_segments(name);
	if segments.is_empty() {
		return false;
	}
	let joined = segments.concat();
	if joined == "credentialid" || joined == "promptversion" {
		return false;
	}
	segments
		.iter()
		.any(|segment| SENSITIVE_FIELD_SEGMENTS.contains(&segment.as_str()))
		|| SENSITIVE_FIELD_SEGMENTS.contains(&joined.as_str())
}

/// What a log call writes after the content rule.
#[derive(Clone, Debug, PartialEq)]
pub struct SanitizedLogCall<'a> {
	/// The event to record, or `invalid_log_event`.
	pub event: &'a str,
	/// The fields safe to write, in JavaScript object order of insertion
	/// (a repeated name keeps its first position and its last value).
	pub fields: Vec<(&'a str, LogValue<'a>)>,
	/// How many fields were dropped.
	pub redacted_fields: usize,
	/// The kind of the rejected event (`"string"`: in Rust an event is
	/// always text), when the event was rejected.
	pub rejected_kind: Option<&'static str>,
}

/// Sets `key` like a JavaScript property assignment: in place when present.
fn assign<'a>(fields: &mut Vec<(&'a str, LogValue<'a>)>, key: &'a str, value: LogValue<'a>) {
	match fields.iter_mut().find(|(existing, _)| *existing == key) {
		Some(slot) => slot.1 = value,
		None => fields.push((key, value)),
	}
}

/// `sanitizeLogCall`: the event must match the event pattern (else it
/// becomes `invalid_log_event` with `rejected: "string"`); a field whose
/// name is sensitive is dropped; a string longer than
/// [`MAX_LOG_FIELD_CHARS`] or containing `\n` / `\r` is dropped; every
/// dropped field is counted. `at`, `level` and `event` are reserved and
/// silently skipped.
#[must_use]
pub fn sanitize_log_call<'a>(
	event: &'a str,
	fields: &[(&'a str, LogValue<'a>)],
) -> SanitizedLogCall<'a> {
	let (event, rejected_kind) = if is_log_event_name(event) {
		(event, None)
	} else {
		(INVALID_LOG_EVENT, Some("string"))
	};
	let mut kept: Vec<(&'a str, LogValue<'a>)> = Vec::with_capacity(fields.len() + 2);
	// A repeated name is one JavaScript property: its first position, last value.
	let mut entries: Vec<(&'a str, &LogValue<'a>)> = Vec::with_capacity(fields.len());
	for (key, value) in fields {
		match entries.iter_mut().find(|(existing, _)| existing == key) {
			Some(slot) => slot.1 = value,
			None => entries.push((key, value)),
		}
	}
	let mut redacted_fields = 0usize;
	for (key, value) in entries {
		if matches!(key, "at" | "level" | "event") {
			continue;
		}
		if is_sensitive_field_name(key) {
			redacted_fields += 1;
			continue;
		}
		if let LogValue::Str(text) = value {
			let too_long = utf16::utf16_len(text) > MAX_LOG_FIELD_CHARS;
			if too_long || text.contains(['\n', '\r']) {
				redacted_fields += 1;
				continue;
			}
		}
		kept.push((key, value.clone()));
	}
	if let Some(kind) = rejected_kind {
		assign(&mut kept, "rejected", LogValue::Str(kind.into()));
	}
	if redacted_fields > 0 {
		let count = i64::try_from(redacted_fields).unwrap_or(i64::MAX);
		assign(&mut kept, "redacted_fields", LogValue::Int(count));
	}
	SanitizedLogCall {
		event,
		fields: kept,
		redacted_fields,
		rejected_kind,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn splits_field_names_like_the_typescript_regex() {
		assert_eq!(field_segments("runnerToken"), ["runner", "token"]);
		assert_eq!(field_segments("APIKey"), ["api", "key"]);
		assert_eq!(field_segments("api_key"), ["api", "key"]);
		assert_eq!(field_segments("aBC"), ["a", "bc"]);
		assert_eq!(field_segments("x2Y"), ["x2", "y"]);
		assert_eq!(field_segments("é-text"), ["text"]);
		assert!(field_segments("__").is_empty());
	}

	#[test]
	fn knows_the_sensitive_names_and_exceptions() {
		for name in [
			"token",
			"runnerToken",
			"apiKey",
			"api_key",
			"Password",
			"COOKIE",
			"Prompt",
		] {
			assert!(is_sensitive_field_name(name), "{name}");
		}
		for name in [
			"credentialId",
			"promptVersion",
			"context",
			"runId",
			"",
			"__",
		] {
			assert!(!is_sensitive_field_name(name), "{name}");
		}
	}

	#[test]
	fn checks_event_names() {
		assert!(is_log_event_name("job_claimed"));
		assert!(!is_log_event_name("j"));
		assert!(!is_log_event_name("Job_Claimed"));
		assert!(!is_log_event_name("9lives"));
		assert!(is_log_event_name(&format!("a{}", "b".repeat(63))));
		assert!(!is_log_event_name(&format!("a{}", "b".repeat(64))));
	}
}
