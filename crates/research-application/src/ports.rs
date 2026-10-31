//! Environment and network ports (port of the matching parts of
//! `packages/application/src/ports.ts`). Use cases depend on these traits;
//! adapters implement them (ARCH-004).

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use research_domain::news::raw_feed::RawFeed;
use tokio_util::sync::CancellationToken;

/* ---------- Environment ports (ARCH-002: time and randomness are injected) ---------- */

/// Wall-clock time.
pub trait Clock: Send + Sync {
	/// Milliseconds since the Unix epoch (`Date.now()`).
	fn now_ms(&self) -> i64;
	/// The current time as `Date.prototype.toISOString` writes it
	/// (`2026-10-17T07:40:00.000Z`).
	fn now_iso(&self) -> String;
}

/// SHA-256 of UTF-8 text. Synchronous in Rust: hashing is pure CPU work
/// (the TypeScript port is async only because WebCrypto is).
pub trait Hasher: Send + Sync {
	/// Lower-case hex SHA-256 of `text`'s UTF-8 bytes.
	fn sha256_hex(&self, text: &str) -> String;
}

/* ---------- Network ports ---------- */

/// A text document retrieved by a [`SafeFetcher`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedDocument {
	/// URL after validated redirects.
	pub final_url: String,
	/// The `Content-Type` header as sent, if any.
	pub content_type: Option<String>,
	/// The body decoded by its declared charset (`decodeBody`: byte-order
	/// mark, `Content-Type` charset, XML declaration or HTML meta in the first
	/// bytes, else UTF-8 with `TextDecoder` semantics).
	pub text: String,
}

/// A binary document retrieved by a [`SafeBinaryFetcher`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryDocument {
	/// URL after validated redirects.
	pub final_url: String,
	/// The `Content-Type` header as sent, if any.
	pub content_type: Option<String>,
	/// The exact body bytes.
	pub bytes: Vec<u8>,
}

/// Why a safe fetch failed (`SafeFetchErrorCode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SafeFetchErrorCode {
	/// The URL failed the string-level policy, or its host resolved to a non-public address.
	UnsafeUrl,
	/// The host is not in the caller's allowlist.
	HostNotAllowed,
	/// A redirect hop failed validation.
	UnsafeRedirect,
	/// More than the allowed number of redirects, or a loop.
	TooManyRedirects,
	/// The caller's redirect authorizer refused a hop.
	RedirectNotAuthorized,
	/// No complete response in time, or the caller cancelled.
	Timeout,
	/// A non-success HTTP status.
	HttpError,
	/// The body exceeded the byte limit.
	ResponseTooLarge,
	/// A DNS, connection, TLS or protocol failure.
	NetworkError,
}

impl SafeFetchErrorCode {
	/// The TypeScript string literal, e.g. `"UNSAFE_URL"`.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::UnsafeUrl => "UNSAFE_URL",
			Self::HostNotAllowed => "HOST_NOT_ALLOWED",
			Self::UnsafeRedirect => "UNSAFE_REDIRECT",
			Self::TooManyRedirects => "TOO_MANY_REDIRECTS",
			Self::RedirectNotAuthorized => "REDIRECT_NOT_AUTHORIZED",
			Self::Timeout => "TIMEOUT",
			Self::HttpError => "HTTP_ERROR",
			Self::ResponseTooLarge => "RESPONSE_TOO_LARGE",
			Self::NetworkError => "NETWORK_ERROR",
		}
	}
}

/// A failed safe fetch. An `HTTP_ERROR` always carries `status`: the status
/// the external service answered with, exactly as received. Callers read it
/// from this field (never from `detail`) and pass it on unchanged as
/// `upstream_status` (docs/rule/error_handling.md §4a).
///
/// `#[non_exhaustive]`: other crates build one only through the
/// constructors. [`SafeFetchError::http`] is the one that builds an
/// `HttpError` (status required); [`SafeFetchError::new`] still accepts the
/// `HttpError` code (no compile-time block), so it must not be used for it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct SafeFetchError {
	/// What went wrong.
	pub code: SafeFetchErrorCode,
	/// A short, log-safe detail (never a remote address). For people reading
	/// a log line, never for parsing.
	pub detail: String,
	/// The status the external service answered with: always set on
	/// `HttpError`; on `RedirectNotAuthorized` the 3xx a POST refused to
	/// follow; `None` when nothing answered.
	pub status: Option<u16>,
	/// Body of an HTTP error status, only when the caller set
	/// `include_error_body`. Untrusted provider text: adapters parse it and
	/// never log, store or show it.
	pub body: Option<String>,
	/// The `Retry-After` header of an `HttpError` answer, as sent; `None`
	/// when the service sent none (or for every other code). Read with
	/// `research_net::retry_after::parse_retry_after_ms`.
	pub retry_after: Option<String>,
}

impl SafeFetchError {
	/// A failure without an answer status, for every code but `HttpError`
	/// (which [`SafeFetchError::http`] builds, status included).
	#[must_use]
	pub fn new(code: SafeFetchErrorCode, detail: impl Into<String>) -> Self {
		Self {
			code,
			detail: detail.into(),
			status: None,
			body: None,
			retry_after: None,
		}
	}

	/// An HTTP error answer. `status` is the external service's status
	/// exactly as received; callers pass it on unchanged (§4a). `detail`
	/// repeats it for people reading a log line, never for parsing.
	#[must_use]
	pub fn http(status: u16, detail: impl Into<String>, body: Option<String>) -> Self {
		Self {
			code: SafeFetchErrorCode::HttpError,
			detail: detail.into(),
			status: Some(status),
			body,
			retry_after: None,
		}
	}

	/// The same error carrying the answer's `Retry-After` header.
	#[must_use]
	pub fn with_retry_after(mut self, retry_after: Option<String>) -> Self {
		self.retry_after = retry_after;
		self
	}

	/// A failure built from an answer that is not an `HttpError` (a redirect
	/// a POST may not follow): `code` with the answer's `status` kept.
	#[must_use]
	pub fn answered(code: SafeFetchErrorCode, status: u16, detail: impl Into<String>) -> Self {
		Self {
			code,
			detail: detail.into(),
			status: Some(status),
			body: None,
			retry_after: None,
		}
	}

	/// The `HttpError` status, `None` for every other code: for decisions
	/// (retry, outage, robots) that only an HTTP error answer may drive.
	#[must_use]
	pub fn http_error_status(&self) -> Option<u16> {
		if self.code == SafeFetchErrorCode::HttpError {
			self.status
		} else {
			None
		}
	}
}

/// The status an external service answered with, or `None` when nothing
/// answered (`upstreamStatusOf`, docs/rule/error_handling.md §4a).
#[must_use]
pub fn upstream_status_of(error: &SafeFetchError) -> Option<u16> {
	error.status
}

/// Consulted before each redirect hop is contacted (never for the initial
/// URL). `false` ends the fetch with `REDIRECT_NOT_AUTHORIZED` before the hop
/// is requested, so robots approval can precede every page request.
#[async_trait]
pub trait RedirectAuthorizer: Send + Sync {
	/// Whether the fetcher may request `url`.
	async fn authorize(&self, url: &str) -> bool;
}

/// Options of one safe fetch (`SafeFetchOptions`).
#[derive(Clone)]
pub struct SafeFetchOptions {
	/// Ceiling on body bytes (after content decoding; the transport also caps wire bytes).
	pub max_bytes: usize,
	/// Deadline for the whole fetch including redirects, in milliseconds.
	pub timeout_ms: u64,
	/// The `Accept` header.
	pub accept: String,
	/// Cancellation from the caller (the run's abort signal).
	pub cancel: Option<CancellationToken>,
	/// When set, the target and every redirect hop must be one of these hosts.
	pub allowed_hosts: Option<BTreeSet<String>>,
	/// See [`RedirectAuthorizer`].
	pub authorize_redirect: Option<Arc<dyn RedirectAuthorizer>>,
	/// `User-Agent`; a generic descriptive value is sent when absent.
	pub user_agent: Option<String>,
	/// `Authorization` value for the initial request only (fixed header allowlist).
	pub authorization: Option<String>,
	/// `X-Finnhub-Token` value for the initial request only (fixed header allowlist).
	pub finnhub_token: Option<String>,
	/// Read the bounded body of an HTTP error status into [`SafeFetchError::body`].
	pub include_error_body: bool,
	/// When set, the initial request is a `POST` with `Content-Type:
	/// application/json` and exactly this body, UTF-8 encoded (a provider
	/// search API such as Tavily). Narrow by design:
	///  - requires `allowed_hosts` (a pinned destination); without it the
	///    fetch fails with `HOST_NOT_ALLOWED` before any byte is sent;
	///  - at most [`MAX_JSON_BODY_BYTES`] (64 KiB) of UTF-8, or the fetch
	///    fails with `NETWORK_ERROR` before any byte is sent;
	///  - a POST is never redirected: any 3xx ends the fetch with
	///    `REDIRECT_NOT_AUTHORIZED` and the body is sent nowhere else;
	///  - the body is sent at most once: no retry once it may have reached
	///    the server (a refused connection may still try the next validated
	///    address, as for a GET).
	///
	/// Response handling (status, `max_bytes`, `timeout_ms`,
	/// `include_error_body`, decoding) is unchanged. The body may carry the
	/// owner's query: never log it.
	pub json_body: Option<String>,
}

/// Largest [`SafeFetchOptions::json_body`], in UTF-8 bytes (`MAX_JSON_BODY_BYTES`).
pub const MAX_JSON_BODY_BYTES: usize = 64 * 1024;

impl std::fmt::Debug for SafeFetchOptions {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		// Header values may carry API keys and the body the owner's query: never print them.
		formatter
			.debug_struct("SafeFetchOptions")
			.field("max_bytes", &self.max_bytes)
			.field("timeout_ms", &self.timeout_ms)
			.field("accept", &self.accept)
			.field("allowed_hosts", &self.allowed_hosts)
			.field("has_authorize_redirect", &self.authorize_redirect.is_some())
			.field("has_authorization", &self.authorization.is_some())
			.field("has_finnhub_token", &self.finnhub_token.is_some())
			.field("include_error_body", &self.include_error_body)
			.field("has_json_body", &self.json_body.is_some())
			.finish_non_exhaustive()
	}
}

/// Outbound text fetch with SSRF defences (SEC-002): https only, per-hop
/// redirect validation, byte and time limits, and a destination check the
/// adapter enforces at connection time.
#[async_trait]
pub trait SafeFetcher: Send + Sync {
	/// Fetches `url` as text.
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError>;
}

/// The binary twin of [`SafeFetcher`] (FR-018 workbooks); same defences.
#[async_trait]
pub trait SafeBinaryFetcher: Send + Sync {
	/// Fetches `url` as exact bytes.
	async fn fetch_bytes(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<BinaryDocument, SafeFetchError>;
}

/// The only way a feed parser fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotAFeed;

/// Parses RSS/Atom text.
pub trait FeedParser: Send + Sync {
	/// `Err(NotAFeed)` for anything that is not an RSS or Atom document.
	fn parse(&self, text: &str) -> Result<RawFeed, NotAFeed>;
}

/* ---------- Retrieved-page archive (research web access) ---------- */

/// Heuristic drops counted by the page-to-Markdown converter.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OmittedCounts {
	/// Navigation, footers, cookie banners and similar chrome.
	pub boilerplate_blocks: u32,
	/// Link-only lists treated as menus.
	pub menu_lists: u32,
	/// Blocks before the article's heading.
	pub leading_blocks: u32,
}

/// A retrieved page to archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchivedPage {
	/// URL that was requested.
	pub source_url: String,
	/// URL after redirects.
	pub final_url: String,
	/// Page title, if any.
	pub title: Option<String>,
	/// ISO timestamp of retrieval.
	pub retrieved_at: String,
	/// The converted Markdown.
	pub markdown: String,
	/// What the converter dropped; `None` when the page was plain text.
	pub omitted: Option<OmittedCounts>,
}

/// Why archiving failed (always `ARCHIVE_WRITE_FAILED`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveWriteFailed {
	/// Log-safe detail.
	pub detail: String,
}

/// Stores a retrieved page as a Markdown file on the machine that retrieved it.
#[async_trait]
pub trait PageArchive: Send + Sync {
	/// Writes the page; returns the file name it was saved under.
	async fn save(&self, page: &ArchivedPage) -> Result<String, ArchiveWriteFailed>;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn an_http_error_keeps_the_status_it_was_answered_with() {
		// 418 and 529 are named by no mapping table: they must come out as they went in.
		for status in [418, 529, 404, 503] {
			let error = SafeFetchError::http(status, format!("HTTP {status}"), None);
			assert_eq!(error.code, SafeFetchErrorCode::HttpError);
			assert_eq!(error.status, Some(status));
			assert_eq!(upstream_status_of(&error), Some(status));
			assert_eq!(error.http_error_status(), Some(status));
		}
	}

	#[test]
	fn the_status_never_comes_from_the_detail() {
		let error = SafeFetchError::new(SafeFetchErrorCode::Timeout, "HTTP 503 in the text");
		assert_eq!(upstream_status_of(&error), None);
		let refused = SafeFetchError::answered(
			SafeFetchErrorCode::RedirectNotAuthorized,
			307,
			"HTTP 307: a POST request is never redirected",
		);
		assert_eq!(upstream_status_of(&refused), Some(307));
		// Only an HTTP error answer drives retry/outage decisions.
		assert_eq!(refused.http_error_status(), None);
	}
}
