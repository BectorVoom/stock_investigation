//! Shared turn failures, JS-exact preflight and cancellation priorities.
use regex::Regex;
use research_agent_core::runtime::AgentRunContext;
use research_contracts::agent::{AgentEvent, AgentRequest};
use research_domain::upstream::is_upstream_status;
use std::{
	sync::{Arc, OnceLock},
	time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

/// Maximum UTF-16 model text units per turn.
pub const MAX_OUTPUT_TEXT_CHARS: usize = 2 * 1024 * 1024;
/// CLI decoded UTF-16 units (including newlines), or HTTP body bytes.
pub const MAX_RAW_STREAM_CHARS: usize = 32 * 1024 * 1024;
/// The ninth malformed line fails a turn.
pub const MAX_MALFORMED_LINES: usize = 8;
/// A stable provider failure, without provider-controlled text.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFailure {
	/// Stable machine-readable code.
	pub code: String,
	/// Whether retrying may help.
	pub retryable: bool,
	/// The status the provider's API answered with, unchanged
	/// (docs/rule/error_handling.md §4a). `None` when no API answer caused
	/// the failure. The code still classifies it; the status is never replaced.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub upstream_status: Option<u16>,
}
impl ProviderFailure {
	/// Built-in codes have exactly the retryability of the TypeScript table.
	pub fn new(code: &str) -> Self {
		Self {
			code: code.to_owned(),
			retryable: matches!(
				code,
				"PROVIDER_RATE_LIMITED"
					| "PROVIDER_UNAVAILABLE"
					| "PROVIDER_TIMEOUT"
					| "PROVIDER_OUTPUT_EMPTY"
			),
			upstream_status: None,
		}
	}
	/// Converts to the public terminal event; the provider's answer status
	/// rides along unchanged (§4a).
	pub fn event(self) -> AgentEvent {
		AgentEvent::Failed {
			code: self.code,
			retryable: self.retryable,
			upstream_status: self.upstream_status,
		}
	}
}
/// `failure` carrying the provider's answer status, unchanged
/// (`withUpstreamStatus`). A value that is not an HTTP status is dropped,
/// never corrected (§4a rule 2).
#[must_use]
pub fn with_upstream_status(failure: ProviderFailure, status: Option<u16>) -> ProviderFailure {
	match status {
		Some(status) if is_upstream_status(f64::from(status)) => ProviderFailure {
			upstream_status: Some(status),
			..failure
		},
		_ => failure,
	}
}
/// Current milliseconds since the epoch.
pub fn now_ms() -> f64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0.0, |v| v.as_secs_f64() * 1000.0)
}
/// A model id is safe to put in argv and at most 100 ASCII characters (AGT-012).
pub fn is_valid_model_id(value: &str) -> bool {
	let mut bytes = value.bytes();
	!value.is_empty()
		&& value.len() <= 100
		&& bytes
			.next()
			.is_some_and(|b| b.is_ascii_alphanumeric() || b"~@".contains(&b))
		&& bytes.all(|b| b.is_ascii_alphanumeric() || b"._:/#~@+-".contains(&b))
}
/// Abort, deadline and model validation, in the observable TypeScript order.
pub fn preflight_turn(
	request: &AgentRequest,
	context: &AgentRunContext,
	now: f64,
) -> Result<f64, ProviderFailure> {
	if context.cancel.is_cancelled() {
		return Err(ProviderFailure::new("ABORTED"));
	}
	let deadline = research_js::date::parse(&request.deadline);
	if !deadline.is_finite() {
		return Err(ProviderFailure::new("REQUEST_INVALID"));
	}
	if deadline <= now {
		return Err(ProviderFailure::new("DEADLINE_EXCEEDED"));
	}
	if context
		.model
		.as_ref()
		.is_some_and(|v| !is_valid_model_id(v))
	{
		return Err(ProviderFailure::new("PROVIDER_MODEL_INVALID"));
	}
	Ok(deadline)
}
/// First-wins reason a turn stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
	/// External abort.
	Aborted,
	/// Deadline expired.
	Deadline,
	/// No HTTP progress.
	Idle,
	/// Cleanup after normal completion.
	Finished,
}
/// Maps cancellation to a public failure.
pub fn failure_for_stop(reason: StopReason) -> ProviderFailure {
	ProviderFailure::new(match reason {
		StopReason::Deadline => "DEADLINE_EXCEEDED",
		StopReason::Idle => "PROVIDER_TIMEOUT",
		_ => "ABORTED",
	})
}
/// First-wins guard; dropping it removes the deadline and abort listener.
pub struct TurnGuard {
	/// Token passed to the process or HTTP request.
	pub cancel: CancellationToken,
	reason: Arc<OnceLock<StopReason>>,
	watcher: tokio::task::JoinHandle<()>,
}
impl TurnGuard {
	/// Starts a bounded deadline timer and follows the external token.
	pub fn new(external: CancellationToken, deadline: f64, now: f64) -> Self {
		let cancel = CancellationToken::new();
		let reason = Arc::new(OnceLock::new());
		if external.is_cancelled() {
			// The first stop reason wins; a later `set` is meant to lose.
			let _ = reason.set(StopReason::Aborted);
			cancel.cancel();
		}
		let token = cancel.clone();
		let why = reason.clone();
		let delay =
			Duration::from_secs_f64(((deadline - now).clamp(0.0, 2_147_483_647.0)) / 1000.0);
		let watcher = tokio::spawn(async move {
			let stopped = tokio::select! { biased;
				_ = token.cancelled() => return,
				_ = external.cancelled() => StopReason::Aborted,
				_ = tokio::time::sleep(delay) => StopReason::Deadline,
			};
			// The first stop reason wins; a later `set` is meant to lose.
			let _ = why.set(stopped);
			token.cancel();
		});
		Self {
			cancel,
			reason,
			watcher,
		}
	}
	/// Stops once; a late deadline cannot relabel an abort.
	pub fn stop(&self, reason: StopReason) {
		// The first stop reason wins; a later `set` is meant to lose.
		let _ = self.reason.set(reason);
		self.cancel.cancel();
	}
	/// The winning reason, if stopped.
	pub fn reason(&self) -> Option<StopReason> {
		self.reason.get().copied()
	}
}
impl Drop for TurnGuard {
	fn drop(&mut self) {
		self.watcher.abort();
		self.cancel.cancel();
	}
}
/// Free-text hint precedence: auth, payment, limit, unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureHint {
	/// Authentication.
	Auth,
	/// Payment.
	Payment,
	/// Quota or rate limit.
	RateLimit,
	/// Upstream outage.
	Unavailable,
}
/// Extracts only a fixed classification, never provider-controlled messages (SEC-010).
pub fn hint_from_text(text: &str) -> Option<FailureHint> {
	HINT_PATTERNS
		.iter()
		.find(|(pattern, _)| pattern.is_match(text))
		.map(|(_, hint)| *hint)
}
/// Fixed hint sources; `every_hint_pattern_compiles` fails the build if one is invalid,
/// so a broken pattern is never silently dropped at runtime.
const HINT_SOURCES: [(&str, FailureHint); 4] = [
	(
		r"not logged in|please run /login|log ?in required|unauthori[sz]ed|authentication|invalid api key|invalid credentials|\b401\b|\b403\b",
		FailureHint::Auth,
	),
	(
		r"insufficient credits|payment required|billing|\b402\b",
		FailureHint::Payment,
	),
	(
		r"rate limit|usage limit|limit reached|quota|too many requests|\b429\b",
		FailureHint::RateLimit,
	),
	(
		r"overloaded|service unavailable|bad gateway|\b50[0234]\b|\b529\b",
		FailureHint::Unavailable,
	),
];
static HINT_PATTERNS: std::sync::LazyLock<Vec<(Regex, FailureHint)>> =
	std::sync::LazyLock::new(|| {
		HINT_SOURCES
			.iter()
			.filter_map(|(p, h)| Regex::new(&format!("(?i-u:{p})")).ok().map(|r| (r, *h)))
			.collect()
	});
/// Status hint; 408 is handled by the HTTP adapter.
pub fn hint_from_http_status(status: f64) -> Option<FailureHint> {
	match status {
		401.0 | 403.0 => Some(FailureHint::Auth),
		402.0 => Some(FailureHint::Payment),
		429.0 => Some(FailureHint::RateLimit),
		n if n >= 500.0 => Some(FailureHint::Unavailable),
		_ => None,
	}
}
/// Converts a hint to its stable failure.
pub fn failure_for_hint(hint: FailureHint) -> ProviderFailure {
	ProviderFailure::new(match hint {
		FailureHint::Auth => "PROVIDER_AUTH",
		FailureHint::Payment => "PROVIDER_PAYMENT_REQUIRED",
		FailureHint::RateLimit => "PROVIDER_RATE_LIMITED",
		FailureHint::Unavailable => "PROVIDER_UNAVAILABLE",
	})
}
/// Costs are known only when finite and nonnegative.
pub fn as_known_cost_usd(value: Option<f64>) -> Option<f64> {
	value.filter(|v| v.is_finite() && *v >= 0.0)
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn every_hint_pattern_compiles() {
		assert_eq!(HINT_PATTERNS.len(), HINT_SOURCES.len());
		assert_eq!(
			hint_from_text("HTTP 429 slow down"),
			Some(FailureHint::RateLimit)
		);
	}

	#[test]
	fn a_provider_status_travels_unchanged_beside_our_code() {
		// 529 (overloaded) is named by no table: the code classifies it, the
		// number itself comes out as it went in (§4a).
		let failure = crate::http_turn::failure_for_http_status(529);
		assert_eq!(failure.code, "PROVIDER_UNAVAILABLE");
		assert_eq!(failure.upstream_status, Some(529));
		assert_eq!(
			failure.clone().event(),
			AgentEvent::Failed {
				code: "PROVIDER_UNAVAILABLE".to_owned(),
				retryable: true,
				upstream_status: Some(529),
			}
		);
		let timeout = crate::http_turn::failure_for_http_status(408);
		assert_eq!(
			(timeout.code.as_str(), timeout.upstream_status),
			("PROVIDER_TIMEOUT", Some(408))
		);
		let model = crate::claude_api::failure_for_claude_rejection(404, None);
		assert_eq!(
			(model.code.as_str(), model.upstream_status),
			("PROVIDER_MODEL_UNAVAILABLE", Some(404))
		);
	}

	#[test]
	fn a_value_that_is_not_a_status_is_dropped_never_corrected() {
		let base = ProviderFailure::new("PROVIDER_ERROR");
		assert_eq!(with_upstream_status(base.clone(), Some(600)), base);
		assert_eq!(with_upstream_status(base.clone(), Some(99)), base);
		assert_eq!(with_upstream_status(base.clone(), None), base);
		assert_eq!(
			with_upstream_status(base, Some(418)).upstream_status,
			Some(418)
		);
		// No status: the event carries no key at all.
		assert_eq!(
			serde_json::to_value(ProviderFailure::new("ABORTED")).unwrap(),
			serde_json::json!({"code": "ABORTED", "retryable": false})
		);
	}
}
