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
	/// The body decoded as UTF-8 (`TextDecoder("utf-8")` semantics).
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

/// A failed safe fetch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafeFetchError {
	/// What went wrong.
	pub code: SafeFetchErrorCode,
	/// A short, log-safe detail (never a remote address).
	pub detail: String,
	/// Body of an HTTP error status, only when the caller set
	/// `include_error_body`. Untrusted provider text: adapters parse it and
	/// never log, store or show it.
	pub body: Option<String>,
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
}

impl std::fmt::Debug for SafeFetchOptions {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		// Header values may carry API keys: never print them.
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
