//! Helpers every research tool shares (port of
//! `packages/adapters/src/tools/shared.ts`): evidence construction, bounded
//! model text and failure translation. Tool output is data for the model and
//! the verifier; nothing in here interprets retrieved content.

use research_agent_core::tools::{CollectedEvidence, ToolFailure};
use research_application::ports::{Hasher, SafeFetchError, SafeFetchErrorCode, upstream_status_of};
use research_contracts::records::{Evidence, SourceClass};
use research_domain::text::truncate::truncate_text;

/// UTF-8 byte ceiling for `ToolOutput::model_text` per call.
pub const MAX_MODEL_TEXT_BYTES: usize = 6_000;
/// Longest stored excerpt (UTF-16 units, `truncateText`).
pub const MAX_EXCERPT_CHARS: usize = 500;
/// Longest stored title or publisher (UTF-16 units).
pub const MAX_TITLE_CHARS: usize = 300;
/// Longest retrieved text kept for verification (UTF-16 units).
pub const MAX_RETRIEVED_TEXT_CHARS: usize = 20_000;

const TRUNCATION_NOTE: &str = "[output truncated]";

/// The longest prefix of whole characters within `max_bytes` UTF-8 bytes.
fn cut_to_bytes(text: &str, max_bytes: usize) -> &str {
	if text.len() <= max_bytes {
		return text;
	}
	let mut end = 0;
	for (index, character) in text.char_indices() {
		if index + character.len_utf8() > max_bytes {
			break;
		}
		end = index + character.len_utf8();
	}
	text.get(..end).unwrap_or("")
}

/// Joins lines into model text of at most [`MAX_MODEL_TEXT_BYTES`] UTF-8
/// bytes. The first line that does not fit is cut, later lines are dropped,
/// and the model is told that it happened.
#[must_use]
pub fn bound_model_text<S: AsRef<str>>(lines: &[S]) -> String {
	let budget_bytes = MAX_MODEL_TEXT_BYTES - (1 + TRUNCATION_NOTE.len());
	let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
	let mut used_bytes = 0usize;
	for line in lines {
		let line = line.as_ref();
		let line_bytes = line.len() + 1;
		if used_bytes + line_bytes <= budget_bytes {
			kept.push(line);
			used_bytes += line_bytes;
			continue;
		}
		// `budget - used - 1` can go negative in JavaScript (a cut to nothing).
		let room = budget_bytes.saturating_sub(used_bytes + 1);
		let partial = cut_to_bytes(line, room);
		if !partial.is_empty() {
			kept.push(partial);
		}
		kept.push(TRUNCATION_NOTE);
		break;
	}
	kept.join("\n")
}

/// The fields of one evidence record before bounding (`EvidenceInput`).
#[derive(Clone, Debug)]
pub struct EvidenceInput {
	/// Run-scoped evidence id.
	pub evidence_id: String,
	/// https source URL.
	pub source_url: String,
	/// Title as found.
	pub title: String,
	/// Publisher as found.
	pub publisher: String,
	/// Publication time, when known.
	pub published_at: Option<String>,
	/// Retrieval time.
	pub retrieved_at: String,
	/// As-of time the content describes, when known.
	pub effective_at: Option<String>,
	/// Source class.
	pub source_class: SourceClass,
	/// Text kept in memory for quote/number verification; hashed into the checksum.
	pub retrieved_text: String,
	/// Whether a verbatim passage of this evidence may be stored (DATA-010):
	/// true for sources licensed for short excerpts and for public-domain
	/// government data, false for headline-and-link-only sources and
	/// wherever the terms are unknown. Stated by every caller; there is
	/// deliberately no default.
	pub retain_quotes: bool,
	/// Excerpt to store. Dropped when `retain_quotes` is false, whatever is passed here.
	pub excerpt: Option<String>,
}

/// Builds one evidence record. Invariant relied on by verification:
/// `checksum == sha256(retrieved_text)`, so a later run can tell whether the
/// text a claim was checked against has changed.
#[must_use]
pub fn collect_evidence(hasher: &dyn Hasher, input: EvidenceInput) -> CollectedEvidence {
	let retrieved_text =
		truncate_text(&input.retrieved_text, MAX_RETRIEVED_TEXT_CHARS).into_owned();
	let excerpt = match (&input.excerpt, input.retain_quotes) {
		(Some(excerpt), true) => Some(truncate_text(excerpt, MAX_EXCERPT_CHARS).into_owned()),
		_ => None,
	};
	CollectedEvidence {
		evidence: Evidence {
			evidence_id: input.evidence_id,
			source_url: input.source_url,
			title: truncate_text(&input.title, MAX_TITLE_CHARS).into_owned(),
			publisher: truncate_text(&input.publisher, MAX_TITLE_CHARS).into_owned(),
			published_at: input.published_at,
			retrieved_at: input.retrieved_at,
			effective_at: input.effective_at,
			excerpt,
			checksum: hasher.sha256_hex(&retrieved_text),
			source_class: input.source_class,
		},
		retrieved_text,
		retain_quotes: input.retain_quotes,
	}
}

fn is_retryable_fetch_error(error: &SafeFetchError) -> bool {
	match error.code {
		SafeFetchErrorCode::Timeout | SafeFetchErrorCode::NetworkError => true,
		SafeFetchErrorCode::HttpError => error
			.http_error_status()
			.is_some_and(|status| status == 429 || status >= 500),
		_ => false,
	}
}

/// A fetch failure as a tool failure (`fetchFailure`), keeping the external
/// service's status unchanged (docs/rule/error_handling.md §4a).
#[must_use]
pub fn fetch_failure(error: &SafeFetchError) -> ToolFailure {
	tool_failure_upstream(
		error.code.as_str(),
		&error.detail,
		is_retryable_fetch_error(error),
		upstream_status_of(error),
	)
}

/// `toolFailure(code, detail, retryable = false)`: a failure that is the
/// tool's own, so it carries no upstream status.
#[must_use]
pub fn tool_failure(code: &str, detail: &str, retryable: bool) -> ToolFailure {
	tool_failure_upstream(code, detail, retryable, None)
}

/// `toolFailure(code, detail, retryable, upstreamStatus)`: `upstream_status`
/// is the status the external service the tool called answered with, passed
/// through unchanged; `None` when nothing answered (§4a).
#[must_use]
pub fn tool_failure_upstream(
	code: &str,
	detail: &str,
	retryable: bool,
	upstream_status: Option<u16>,
) -> ToolFailure {
	ToolFailure {
		code: code.to_owned(),
		detail: detail.to_owned(),
		retryable,
		upstream_status,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	struct FixedHasher;
	impl Hasher for FixedHasher {
		fn sha256_hex(&self, text: &str) -> String {
			format!("h({text})")
		}
	}

	fn http_error(status: u16) -> SafeFetchError {
		SafeFetchError::http(status, format!("HTTP {status}"), None)
	}

	#[test]
	fn bounds_model_text_in_utf8_bytes() {
		assert_eq!(bound_model_text(&["a", "b"]), "a\nb");
		let long = "é".repeat(4000); // 8,000 bytes
		let bounded = bound_model_text(&["head", long.as_str(), "dropped"]);
		assert!(bounded.len() <= MAX_MODEL_TEXT_BYTES);
		assert!(bounded.starts_with("head\né"));
		assert!(bounded.ends_with("\n[output truncated]"));
		assert!(!bounded.contains("dropped"));
	}

	#[test]
	fn a_fetch_failure_keeps_the_status_unchanged() {
		assert!(fetch_failure(&http_error(429)).retryable);
		assert!(!fetch_failure(&http_error(404)).retryable);
		assert_eq!(fetch_failure(&http_error(529)).upstream_status, Some(529));
		assert_eq!(fetch_failure(&http_error(418)).upstream_status, Some(418));
		// Text that looks like a status is never read as one.
		let timeout = SafeFetchError::new(SafeFetchErrorCode::Timeout, "HTTP 503 after 30 s");
		assert_eq!(fetch_failure(&timeout).upstream_status, None);
		assert_eq!(tool_failure("X", "y", false).upstream_status, None);
	}

	#[test]
	fn drops_excerpts_without_quote_rights() {
		let input = EvidenceInput {
			evidence_id: "run_ev1".to_owned(),
			source_url: "https://a.org/".to_owned(),
			title: "T".to_owned(),
			publisher: "P".to_owned(),
			published_at: None,
			retrieved_at: "2026-10-17T00:00:00.000Z".to_owned(),
			effective_at: None,
			source_class: SourceClass::Other,
			retrieved_text: "text".to_owned(),
			retain_quotes: false,
			excerpt: Some("quote".to_owned()),
		};
		let collected = collect_evidence(&FixedHasher, input);
		assert_eq!(collected.evidence.excerpt, None);
		assert_eq!(collected.evidence.checksum, "h(text)");
	}
}
