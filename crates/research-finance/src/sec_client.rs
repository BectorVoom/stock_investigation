//! SEC EDGAR fair-access client; contact identification is owner configuration.
use crate::{
	market_fetch::{fetch_options, http_status_of},
	ports::Sleeper,
};
use async_trait::async_trait;
use research_application::ports::{Clock, SafeFetchError, SafeFetchErrorCode, SafeFetcher};
use research_js::{
	json::{self, Value},
	whitespace::trim,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
/// Publisher name used in evidence.
pub const SEC_PUBLISHER: &str = "U.S. Securities and Exchange Commission (EDGAR)";
/// Eight request starts per second, below the SEC ceiling.
pub const SEC_MIN_REQUEST_INTERVAL_MS: i64 = 125;
/// Stable SEC failure codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SecErrorCode {
	/// Owner contact missing.
	NotConfigured,
	/// Invalid CIK or ticker.
	InvalidIdentifier,
	/// HTTP 404.
	NotFound,
	/// HTTP 403.
	AccessDenied,
	/// HTTP 429.
	RateLimited,
	/// Transport failure.
	FetchFailed,
	/// Body cap exceeded.
	ResponseTooLarge,
	/// Unexpected JSON/XML shape.
	UnexpectedResponse,
	/// No eligible report.
	NoData,
}
impl SecErrorCode {
	/// The TypeScript literal, e.g. `"NOT_CONFIGURED"`.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NotConfigured => "NOT_CONFIGURED",
			Self::InvalidIdentifier => "INVALID_IDENTIFIER",
			Self::NotFound => "NOT_FOUND",
			Self::AccessDenied => "ACCESS_DENIED",
			Self::RateLimited => "RATE_LIMITED",
			Self::FetchFailed => "FETCH_FAILED",
			Self::ResponseTooLarge => "RESPONSE_TOO_LARGE",
			Self::UnexpectedResponse => "UNEXPECTED_RESPONSE",
			Self::NoData => "NO_DATA",
		}
	}
}
/// A log-safe error with explicit retryability.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[error("{detail}")]
pub struct SecError {
	/// Stable code.
	pub code: SecErrorCode,
	/// Log-safe detail.
	pub detail: String,
	/// Whether retry can help.
	pub retryable: bool,
}
impl SecError {
	/// Non-retryable error with a fixed detail.
	pub fn new(code: SecErrorCode, detail: impl Into<String>) -> Self {
		Self {
			code,
			detail: detail.into(),
			retryable: false,
		}
	}
}
/// One retrieved SEC document.
#[derive(Clone, Debug, Serialize)]
pub struct SecDocument {
	/// Final URL.
	pub url: String,
	/// Body text.
	pub text: String,
}
/// SEC request caps.
pub struct SecRequest<'a> {
	/// Maximum body bytes.
	pub max_bytes: usize,
	/// Accept header.
	pub accept: &'a str,
	/// Optional run cancellation.
	pub cancel: Option<&'a CancellationToken>,
}
/// SEC document port shared by company financials and 13F sources.
#[async_trait]
pub trait SecClient: Send + Sync {
	/// Fetches with caller caps and client-wide fair-access pacing.
	async fn fetch_document(
		&self,
		url: &str,
		request: SecRequest<'_>,
	) -> Result<SecDocument, SecError>;
}
/// True for a printable owner contact containing an email-shaped string:
/// `^[\x20-\x7e]{8,200}$` and `[^\s@]+@[^\s@]+\.[^\s@]+` (the user agent is
/// printable ASCII by then, so the only whitespace is the space).
pub fn is_usable_sec_user_agent(user_agent: Option<&str>) -> bool {
	let Some(ua) = user_agent.filter(|text| {
		(8..=200).contains(&text.len()) && text.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
	}) else {
		return false;
	};
	let bytes = ua.as_bytes();
	let plain = |byte: u8| byte != b' ' && byte != b'@';
	bytes.iter().enumerate().any(|(at, byte)| {
		if *byte != b'@' || at == 0 || !bytes.get(at - 1).is_some_and(|b| plain(*b)) {
			return false;
		}
		// The run after the '@' needs a '.' with a character on both sides of
		// it inside the run.
		let run: Vec<u8> = bytes
			.iter()
			.skip(at + 1)
			.take_while(|b| plain(**b))
			.copied()
			.collect();
		run.iter()
			.enumerate()
			.any(|(k, b)| *b == b'.' && k >= 1 && k + 2 <= run.len())
	})
}
/// Ten-digit nonzero CIK; strips a single leading CIK after JS trimming.
pub fn normalize_cik(text: &str) -> Option<String> {
	let text = trim(text);
	let digits = if text.get(..3).is_some_and(|s| s.eq_ignore_ascii_case("CIK")) {
		text.get(3..)?
	} else {
		text
	};
	if !(1..=10).contains(&digits.len())
		|| !digits.bytes().all(|b| b.is_ascii_digit())
		|| digits.bytes().all(|b| b == b'0')
	{
		return None;
	}
	Some(format!("{digits:0>10}"))
}
/// Midnight instant for an SEC civil date.
pub fn iso_date_to_instant(date: &str) -> String {
	format!("{date}T00:00:00.000Z")
}
/// Parses JSON with JS semantics and a fixed error detail.
pub fn parse_sec_json(document: &SecDocument) -> Result<Value, SecError> {
	json::parse(&document.text).map_err(|_| {
		SecError::new(
			SecErrorCode::UnexpectedResponse,
			"SEC response is not valid JSON",
		)
	})
}
/// Production fair-access client over the pinned SafeFetcher.
pub struct PacedSecClient {
	fetcher: Arc<dyn SafeFetcher>,
	clock: Arc<dyn Clock>,
	sleep: Arc<dyn Sleeper>,
	user_agent: Option<String>,
	next_slot: Mutex<i64>,
}
impl PacedSecClient {
	/// Constructs one shared SEC request queue.
	pub fn new(
		fetcher: Arc<dyn SafeFetcher>,
		clock: Arc<dyn Clock>,
		sleep: Arc<dyn Sleeper>,
		user_agent: Option<String>,
	) -> Self {
		Self {
			fetcher,
			clock,
			sleep,
			user_agent,
			next_slot: Mutex::new(0),
		}
	}
}
fn translate(error: SafeFetchError) -> SecError {
	use SecErrorCode::*;
	let status = http_status_of(&error);
	match status {
		Some(404) => return SecError::new(NotFound, "SEC has no document at this address"),
		Some(403) => {
			return SecError::new(
				AccessDenied,
				"SEC refused the request (HTTP 403): check the configured User-Agent contact details and request rate",
			);
		}
		Some(429) => {
			return SecError {
				code: RateLimited,
				detail: "SEC rate limit reached (HTTP 429)".to_owned(),
				retryable: true,
			};
		}
		_ => {}
	}
	if error.code == SafeFetchErrorCode::ResponseTooLarge {
		return SecError::new(ResponseTooLarge, error.detail);
	}
	SecError {
		code: FetchFailed,
		detail: format!("{}: {}", error.code.as_str(), error.detail),
		retryable: matches!(
			error.code,
			SafeFetchErrorCode::Timeout | SafeFetchErrorCode::NetworkError
		) || status.is_some_and(|s| s >= 500),
	}
}
#[async_trait]
impl SecClient for PacedSecClient {
	async fn fetch_document(
		&self,
		url: &str,
		request: SecRequest<'_>,
	) -> Result<SecDocument, SecError> {
		if !is_usable_sec_user_agent(self.user_agent.as_deref()) {
			return Err(SecError::new(
				SecErrorCode::NotConfigured,
				"SEC EDGAR access is not configured: set a descriptive User-Agent with a contact e-mail address (SEC fair-access policy)",
			));
		}
		let delay = {
			let now = self.clock.now_ms();
			let mut next = self.next_slot.lock().map_err(|_| {
				SecError::new(
					SecErrorCode::FetchFailed,
					"SEC request queue is unavailable",
				)
			})?;
			let slot = now.max(*next);
			*next = slot.saturating_add(SEC_MIN_REQUEST_INTERVAL_MS);
			slot.saturating_sub(now)
		};
		// F2: this wait intentionally ignores cancellation, matching TypeScript.
		if delay > 0 {
			self.sleep
				.sleep(u64::try_from(delay).unwrap_or(0), None)
				.await;
		}
		let cancel = request.cancel.cloned().unwrap_or_default();
		let mut options = fetch_options("www.sec.gov", request.accept, &cancel);
		options.allowed_hosts = Some(["www.sec.gov".to_owned(), "data.sec.gov".to_owned()].into());
		options.max_bytes = request.max_bytes;
		options.user_agent = self.user_agent.clone();
		options.cancel = request.cancel.cloned();
		let document = self
			.fetcher
			.fetch_text(url, &options)
			.await
			.map_err(translate)?;
		Ok(SecDocument {
			url: document.final_url,
			text: document.text,
		})
	}
}
