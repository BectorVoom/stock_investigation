//! Runtime-neutral core of the safe fetchers (port of
//! `packages/adapters/src/worker/safeFetchCore.ts`, SEC-002).
//!
//! The core owns everything that does not depend on how bytes reach the
//! network:
//!   URL policy -> allowlist -> one hop through the transport -> redirect
//!   handling (manual, re-validated per hop) -> status -> byte cap -> decode.
//! A [`HopTransport`] owns the one thing that differs: how a single GET is
//! sent, and which destination guarantees it can give.
//!
//! BYTE LIMIT: `max_bytes` bounds the body bytes the core receives from the
//! transport, i.e. the bytes AFTER content decoding. Bytes on the wire are
//! visible only to the transport, which is handed the same ceiling in
//! [`HopRequest::max_bytes`] and reports a breach as [`BodyError::TooLarge`].
//!
//! Cancellation: the TypeScript races every await against
//! `AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])`. Here every
//! await runs under [`AbortSignal::until_aborted`]; losing the race drops the
//! transport's future, which closes its connection.

use std::collections::BTreeSet;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::FutureExt;
use research_application::ports::{
	BinaryDocument, FetchedDocument, SafeBinaryFetcher, SafeFetchError, SafeFetchErrorCode,
	SafeFetchOptions, SafeFetcher,
};
use research_domain::news::url_policy::validate_fetch_url;
use research_js::text_decoder::{decode_utf8, decode_utf8_owned};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;

/// Redirects followed after the first request; one more is `TOO_MANY_REDIRECTS`.
pub const MAX_REDIRECT_HOPS: usize = 5;

/// Sent unless a caller identifies itself through `SafeFetchOptions::user_agent`.
pub const DEFAULT_USER_AGENT: &str =
	"stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)";

/// Header values of one hop. Already checked against the printable-ASCII rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HopHeaders<'a> {
	/// `Accept`.
	pub accept: &'a str,
	/// `User-Agent`.
	pub user_agent: &'a str,
	/// Caller-supplied `Authorization`, only on hop 0.
	pub authorization: Option<&'a str>,
	/// Caller-supplied `X-Finnhub-Token`, only on hop 0.
	pub finnhub_token: Option<&'a str>,
}

/// One GET the core asks a transport to perform.
#[derive(Clone, Copy)]
pub struct HopRequest<'a> {
	/// Already validated: https, no credentials, default port, public-looking host name.
	pub url: &'a Url,
	/// Lower-case host name without a trailing dot, as checked against policy and allowlist.
	pub hostname: &'a str,
	/// The request headers.
	pub headers: HopHeaders<'a>,
	/// The caller's byte ceiling. A transport that decodes content itself
	/// must also apply it to the encoded bytes it reads from the network.
	pub max_bytes: usize,
	/// Deadline and caller cancellation of the whole fetch.
	pub signal: &'a AbortSignal,
}

impl HopRequest<'_> {
	/// `${url.pathname}${url.search}`: JavaScript's `search` is empty for an
	/// empty query, so `https://a.b/?` requests `/`, not `/?`.
	#[must_use]
	pub fn path_and_query(&self) -> String {
		let path = self.url.path();
		match self.url.query() {
			Some(query) if !query.is_empty() => {
				let mut out = String::with_capacity(path.len() + 1 + query.len());
				out.push_str(path);
				out.push('?');
				out.push_str(query);
				out
			}
			_ => path.to_owned(),
		}
	}
}

/// Why a body stopped early.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BodyError {
	/// The transport stopped reading because a byte ceiling was passed
	/// (`ResponseBodyTooLargeError`).
	TooLarge,
	/// Any other failure, as a `describeError` label.
	Failed(String),
}

/// Decoded body bytes of a response. Dropping it releases (closes) the
/// connection unless the body was read to its end successfully.
#[async_trait]
pub trait HopBody: Send {
	/// The next chunk, `None` at the end of the body.
	async fn next_chunk(&mut self) -> Option<Result<Bytes, BodyError>>;
}

/// A response to one hop.
pub struct HopResponse {
	/// HTTP status code.
	pub status: u16,
	/// `Location`, as Latin-1 text.
	pub location: Option<String>,
	/// `Content-Type`, as Latin-1 text.
	pub content_type: Option<String>,
	/// Declared size of the body as transferred, when the server stated one.
	pub content_length: Option<u64>,
	/// Decoded body bytes. Dropping it is `discard()`.
	pub body: Box<dyn HopBody>,
}

impl std::fmt::Debug for HopResponse {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("HopResponse")
			.field("status", &self.status)
			.field("location", &self.location)
			.field("content_type", &self.content_type)
			.field("content_length", &self.content_length)
			.finish_non_exhaustive()
	}
}

/// What one hop produced (`HopOutcome`).
#[derive(Debug)]
pub enum HopOutcome {
	/// The server answered.
	Response(HopResponse),
	/// The transport established that the destination is not a public address.
	UnsafeDestination {
		/// Log-safe detail (never the address).
		detail: String,
	},
	/// DNS, connection, TLS or protocol failure.
	NetworkError {
		/// A `describeError`-style label.
		detail: String,
	},
}

/// Performs exactly one GET without following redirects.
#[async_trait]
pub trait HopTransport: Send + Sync {
	/// Sends `request` and returns the response head with a streaming body.
	async fn hop(&self, request: HopRequest<'_>) -> HopOutcome;
}

/// `AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])`.
#[derive(Clone, Debug)]
pub struct AbortSignal {
	deadline: Instant,
	caller: Option<CancellationToken>,
}

impl AbortSignal {
	/// A signal that fires after `timeout` or when `caller` is cancelled.
	#[must_use]
	pub fn new(timeout: Duration, caller: Option<CancellationToken>) -> Self {
		let now = Instant::now();
		Self {
			deadline: now
				.checked_add(timeout)
				.unwrap_or(now + Duration::from_secs(86_400 * 365)),
			caller,
		}
	}

	/// Whether the caller cancelled (the TIMEOUT detail distinguishes this).
	#[must_use]
	pub fn caller_aborted(&self) -> bool {
		self.caller
			.as_ref()
			.is_some_and(CancellationToken::is_cancelled)
	}

	/// `signal.aborted`.
	#[must_use]
	pub fn aborted(&self) -> bool {
		self.caller_aborted() || Instant::now() >= self.deadline
	}

	/// Completes when the signal fires.
	pub async fn fired(&self) {
		let deadline = tokio::time::sleep_until(self.deadline);
		match &self.caller {
			Some(token) => {
				tokio::select! {
					() = deadline => {}
					() = token.cancelled() => {}
				}
			}
			None => deadline.await,
		}
	}

	/// `untilAborted(work, signal)`: `None` as soon as the signal fires
	/// (dropping `work`), or immediately when it already has.
	pub async fn until_aborted<F: Future>(&self, work: F) -> Option<F::Output> {
		if self.aborted() {
			return None;
		}
		tokio::select! {
			biased;
			output = work => Some(output),
			() = self.fired() => None,
		}
	}
}

/// The bytes of a successful fetch, before any text decoding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawDocument {
	/// URL after validated redirects.
	pub final_url: String,
	/// `Content-Type`, if sent.
	pub content_type: Option<String>,
	/// Decoded body bytes.
	pub bytes: Vec<u8>,
}

/// `HEADER_VALUE = /^[\x20-\x7e]{1,300}$/`.
fn is_header_value(value: &str) -> bool {
	(1..=300).contains(&value.len()) && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// `host.toLowerCase().replace(/\.$/, "")`.
fn normalize_host(host: &str) -> String {
	let mut lower = host.to_lowercase();
	if lower.ends_with('.') {
		lower.pop();
	}
	lower
}

/// `${n}` for a count: JavaScript prints the nearest double, which equals
/// the integer for every safe integer.
fn js_count(value: u64) -> String {
	const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
	if value <= MAX_SAFE_INTEGER {
		return value.to_string();
	}
	// Above 2^53 the TypeScript holds a double too; print what it prints.
	#[allow(clippy::cast_precision_loss)]
	let double = value as f64;
	research_js::number::to_js_string(double)
}

fn usize_count(value: usize) -> String {
	js_count(u64::try_from(value).unwrap_or(u64::MAX))
}

fn fail<T>(code: SafeFetchErrorCode, detail: impl Into<String>) -> Result<T, SafeFetchError> {
	Err(SafeFetchError {
		code,
		detail: detail.into(),
		body: None,
	})
}

struct HopTarget {
	url: Url,
	hostname: String,
}

enum HopRejection {
	UnsafeUrl(&'static str),
	HostNotAllowed,
}

impl HopRejection {
	fn detail(&self) -> &'static str {
		match self {
			Self::UnsafeUrl(detail) => detail,
			Self::HostNotAllowed => "host is not on the allowlist for this request",
		}
	}

	fn code(&self) -> SafeFetchErrorCode {
		match self {
			Self::UnsafeUrl(_) => SafeFetchErrorCode::UnsafeUrl,
			Self::HostNotAllowed => SafeFetchErrorCode::HostNotAllowed,
		}
	}
}

fn validate_hop(
	raw_url: &str,
	allowed_hosts: Option<&BTreeSet<String>>,
) -> Result<HopTarget, HopRejection> {
	let validated =
		validate_fetch_url(raw_url).map_err(|error| HopRejection::UnsafeUrl(error.as_str()))?;
	if allowed_hosts.is_some_and(|hosts| !hosts.contains(&validated.hostname)) {
		return Err(HopRejection::HostNotAllowed);
	}
	// `new URL(validated.href)`: the href came out of the same parser, so this cannot fail.
	let url = Url::parse(&validated.href).map_err(|_| HopRejection::UnsafeUrl("MALFORMED_URL"))?;
	Ok(HopTarget {
		url,
		hostname: validated.hostname,
	})
}

/// `new URL(location, base)` as Node's URL parser (Ada) computes it, or
/// `None` where `URL.canParse` is false. Ada differs from the `url` crate in
/// one observable way: a location with no path or query of its own (empty,
/// or only a fragment, after the WHATWG trimming) does not inherit an EMPTY
/// base query — `new URL("", "https://a.b/?")` is `https://a.b/`. Pinned by
/// `vectors/net/hop-core.json`.
fn resolve_location(base: &Url, location: &str) -> Option<Url> {
	let mut next = base.join(location).ok()?;
	let significant = location
		.trim_matches(|character: char| character <= ' ')
		.chars()
		.find(|character| !matches!(character, '\t' | '\n' | '\r'));
	let inherits_query = significant.is_none_or(|first| first == '#');
	if inherits_query && base.query() == Some("") && next.query() == Some("") {
		next.set_query(None);
	}
	Some(next)
}

enum BodyRead {
	Complete(Vec<u8>),
	TooLarge,
	Aborted,
	Failed(String),
}

/// Streams the body and stops the moment it exceeds `max_bytes`; never
/// buffers more than that (`readBounded`).
async fn read_bounded(
	body: &mut dyn HopBody,
	max_bytes: usize,
	size_hint: Option<u64>,
	signal: &AbortSignal,
) -> BodyRead {
	let capacity = size_hint
		.and_then(|declared| usize::try_from(declared).ok())
		.map_or(0, |declared| declared.min(max_bytes));
	let mut bytes = Vec::with_capacity(capacity);
	loop {
		let Some(next) = signal.until_aborted(body.next_chunk()).await else {
			return BodyRead::Aborted;
		};
		match next {
			None => return BodyRead::Complete(bytes),
			Some(Ok(chunk)) => {
				// Checked BEFORE buffering the chunk, like the TypeScript.
				if bytes.len().saturating_add(chunk.len()) > max_bytes {
					return BodyRead::TooLarge;
				}
				bytes.extend_from_slice(&chunk);
			}
			Some(Err(BodyError::TooLarge)) => return BodyRead::TooLarge,
			Some(Err(BodyError::Failed(detail))) => {
				return if signal.aborted() {
					BodyRead::Aborted
				} else {
					BodyRead::Failed(detail)
				};
			}
		}
	}
}

fn optional_header(value: Option<&str>) -> Result<Option<&str>, SafeFetchError> {
	match value {
		None => Ok(None),
		Some(value) if is_header_value(value) => Ok(Some(value)),
		Some(_) => fail(
			SafeFetchErrorCode::NetworkError,
			"request header value contains unsupported characters",
		),
	}
}

/// The shared hop loop behind `fetch_text` and `fetch_bytes` (`fetchRawBytes`).
///
/// # Errors
/// Every failure of the port contract, with the TypeScript's codes and details.
pub async fn fetch_raw_bytes(
	transport: &(impl HopTransport + ?Sized),
	url: &str,
	options: &SafeFetchOptions,
) -> Result<RawDocument, SafeFetchError> {
	if options.max_bytes == 0 {
		return fail(
			SafeFetchErrorCode::ResponseTooLarge,
			"maxBytes must be a positive number",
		);
	}
	if options.timeout_ms == 0 {
		return fail(
			SafeFetchErrorCode::Timeout,
			"timeoutMs must be a positive number",
		);
	}
	let user_agent = match options.user_agent.as_deref() {
		None => Some(DEFAULT_USER_AGENT),
		Some(value) => is_header_value(value).then_some(value),
	};
	let Some(user_agent) = user_agent.filter(|_| is_header_value(&options.accept)) else {
		return fail(
			SafeFetchErrorCode::NetworkError,
			"request header value contains unsupported characters",
		);
	};
	// The fixed header allowlist (provider API keys). A value outside
	// printable ASCII fails the request before any byte is sent.
	let authorization = optional_header(options.authorization.as_deref())?;
	let finnhub_token = optional_header(options.finnhub_token.as_deref())?;
	let allowed_hosts: Option<BTreeSet<String>> = options
		.allowed_hosts
		.as_ref()
		.map(|hosts| hosts.iter().map(|host| normalize_host(host)).collect());

	let signal = AbortSignal::new(
		Duration::from_millis(options.timeout_ms),
		options.cancel.clone(),
	);
	let timed_out = |signal: &AbortSignal| {
		fail::<RawDocument>(
			SafeFetchErrorCode::Timeout,
			if signal.caller_aborted() {
				"aborted by the caller".to_owned()
			} else {
				format!(
					"no complete response within {} ms",
					js_count(options.timeout_ms)
				)
			},
		)
	};

	let mut visited: BTreeSet<String> = BTreeSet::new();
	let mut current_url = url.to_owned();
	// hop 0 is the original request; hops 1..=MAX_REDIRECT_HOPS are redirects. A further
	// redirect ends the loop and is reported below without being validated or requested.
	for hop in 0..=MAX_REDIRECT_HOPS {
		let is_redirect_hop = hop > 0;
		if let Some(authorizer) = options
			.authorize_redirect
			.as_ref()
			.filter(|_| is_redirect_hop)
		{
			// Robots/allowlist approval precedes every page request: a refusal
			// (or a panic, the TypeScript's throw) ends the fetch before the
			// hop is contacted.
			let authorized = AssertUnwindSafe(authorizer.authorize(&current_url))
				.catch_unwind()
				.await
				.unwrap_or(false);
			if !authorized {
				return fail(
					SafeFetchErrorCode::RedirectNotAuthorized,
					format!("redirect {hop} was not authorized"),
				);
			}
		}
		let target = match validate_hop(&current_url, allowed_hosts.as_ref()) {
			Ok(target) => target,
			Err(rejection) if is_redirect_hop => {
				return fail(
					SafeFetchErrorCode::UnsafeRedirect,
					format!("redirect {hop} rejected: {}", rejection.detail()),
				);
			}
			Err(rejection) => return fail(rejection.code(), rejection.detail()),
		};
		if !visited.insert(target.url.as_str().to_owned()) {
			return fail(SafeFetchErrorCode::TooManyRedirects, "redirect loop");
		}
		if signal.aborted() {
			return timed_out(&signal);
		}

		let request = HopRequest {
			url: &target.url,
			hostname: &target.hostname,
			headers: HopHeaders {
				accept: &options.accept,
				user_agent,
				// A key must never travel to a host the caller did not
				// address: redirects get neither header.
				authorization: if hop == 0 { authorization } else { None },
				finnhub_token: if hop == 0 { finnhub_token } else { None },
			},
			max_bytes: options.max_bytes,
			signal: &signal,
		};
		let outcome = signal.until_aborted(transport.hop(request)).await;
		let response = match outcome {
			// Dropping a response discards it (closes its connection).
			None => return timed_out(&signal),
			Some(_) if signal.aborted() => return timed_out(&signal),
			Some(HopOutcome::NetworkError { detail }) => {
				return fail(SafeFetchErrorCode::NetworkError, detail);
			}
			Some(HopOutcome::UnsafeDestination { detail }) => {
				return if is_redirect_hop {
					fail(
						SafeFetchErrorCode::UnsafeRedirect,
						format!("redirect {hop} rejected: {detail}"),
					)
				} else {
					fail(SafeFetchErrorCode::UnsafeUrl, detail)
				};
			}
			Some(HopOutcome::Response(response)) => response,
		};

		if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
			let HopResponse {
				status, location, ..
			} = response;
			let Some(location) = location else {
				return fail(
					SafeFetchErrorCode::HttpError,
					format!("HTTP {status} without a Location header"),
				);
			};
			// Relative locations resolve against the hop that issued them, then get the full policy.
			let Some(next) = resolve_location(&target.url, &location) else {
				return fail(
					SafeFetchErrorCode::UnsafeRedirect,
					format!("redirect {} rejected: MALFORMED_URL", hop + 1),
				);
			};
			current_url = next.into();
			continue;
		}
		let mut response = response;
		if !(200..=299).contains(&response.status) {
			let status = response.status;
			// Opt-in only (FRED's 400 carries the error code in JSON): read
			// the bounded error body so the adapter can map it. The body is
			// untrusted provider text; only the adapter ever sees it.
			if options.include_error_body {
				let error_body =
					read_bounded(response.body.as_mut(), options.max_bytes, None, &signal).await;
				drop(response);
				return match error_body {
					BodyRead::Aborted => timed_out(&signal),
					BodyRead::Complete(bytes) => Err(SafeFetchError {
						code: SafeFetchErrorCode::HttpError,
						detail: format!("HTTP {status}"),
						body: Some(decode_utf8(&bytes)),
					}),
					BodyRead::TooLarge | BodyRead::Failed(_) => {
						fail(SafeFetchErrorCode::HttpError, format!("HTTP {status}"))
					}
				};
			}
			return fail(SafeFetchErrorCode::HttpError, format!("HTTP {status}"));
		}
		if response
			.content_length
			.is_some_and(|declared| declared > u64::try_from(options.max_bytes).unwrap_or(u64::MAX))
		{
			return fail(
				SafeFetchErrorCode::ResponseTooLarge,
				format!(
					"declared size exceeds {} bytes",
					usize_count(options.max_bytes)
				),
			);
		}
		let body = read_bounded(
			response.body.as_mut(),
			options.max_bytes,
			response.content_length,
			&signal,
		)
		.await;
		let HopResponse { content_type, .. } = response;
		return match body {
			BodyRead::Aborted => timed_out(&signal),
			BodyRead::TooLarge => fail(
				SafeFetchErrorCode::ResponseTooLarge,
				format!("body exceeds {} bytes", usize_count(options.max_bytes)),
			),
			BodyRead::Failed(detail) => fail(SafeFetchErrorCode::NetworkError, detail),
			BodyRead::Complete(bytes) => Ok(RawDocument {
				final_url: target.url.into(),
				content_type,
				bytes,
			}),
		};
	}
	fail(
		SafeFetchErrorCode::TooManyRedirects,
		format!("more than {MAX_REDIRECT_HOPS} redirects"),
	)
}

/// A [`SafeFetcher`] and [`SafeBinaryFetcher`] over one transport
/// (`createSafeFetcher` / `createSafeBinaryFetcher`). Cloning shares the
/// transport, and with it the connection pool.
pub struct SafeFetchCore<T: ?Sized> {
	transport: Arc<T>,
}

impl<T: ?Sized> Clone for SafeFetchCore<T> {
	fn clone(&self) -> Self {
		Self {
			transport: Arc::clone(&self.transport),
		}
	}
}

impl<T: HopTransport + ?Sized> SafeFetchCore<T> {
	/// Wraps a transport.
	#[must_use]
	pub fn new(transport: Arc<T>) -> Self {
		Self { transport }
	}

	/// The transport (tests inspect the pool through it).
	#[must_use]
	pub fn transport(&self) -> &Arc<T> {
		&self.transport
	}
}

#[async_trait]
impl<T: HopTransport + ?Sized> SafeFetcher for SafeFetchCore<T> {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		let raw = fetch_raw_bytes(self.transport.as_ref(), url, options).await?;
		Ok(FetchedDocument {
			final_url: raw.final_url,
			content_type: raw.content_type,
			text: decode_utf8_owned(raw.bytes),
		})
	}
}

#[async_trait]
impl<T: HopTransport + ?Sized> SafeBinaryFetcher for SafeFetchCore<T> {
	async fn fetch_bytes(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<BinaryDocument, SafeFetchError> {
		let raw = fetch_raw_bytes(self.transport.as_ref(), url, options).await?;
		Ok(BinaryDocument {
			final_url: raw.final_url,
			content_type: raw.content_type,
			bytes: raw.bytes,
		})
	}
}

#[cfg(test)]
mod tests;
