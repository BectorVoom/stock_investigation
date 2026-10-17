//! One HTTPS GET to an address the caller has ALREADY validated (port of
//! `packages/adapters/src/node/pinnedConnect.ts`, SEC-002), over a pooled
//! HTTP/1.1 connection when one is idle (ADR-0030 C1, see [`crate::pool`]).
//!
//! Request: `GET <path>` with the headers in the TypeScript's order — `host`
//! (the host name, virtual hosting), `accept`, `user-agent`,
//! [`authorization`], [`x-finnhub-token`], `accept-encoding: gzip`. Unlike
//! Node with `agent: false`, no `Connection: close` is sent.
//!
//! BODY SIZE: content decoding happens here, so this is the only place that
//! sees the bytes on the wire. For gzip/deflate/br responses the encoded
//! bytes are counted against `max_encoded_bytes` and the connection is
//! closed the moment that ceiling is passed — independently of how many
//! bytes (possibly none) the decoder produces. The decoded bytes are counted
//! by the caller. An identity body is passed through unchanged, so the
//! caller's count IS the wire count. Any other `Content-Encoding` is refused.
//! Only a success body is ever read; anything else is dropped unread.

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use bytes::Bytes;
use http::header::{
	ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONNECTION, CONTENT_ENCODING, CONTENT_LENGTH,
	CONTENT_TYPE, HOST, LOCATION, USER_AGENT,
};
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Version};
use http_body_util::{BodyExt, Empty};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;

use crate::core::{BodyError, HopBody, HopHeaders};
use crate::decode::{ContentDecoder, Encoding, encoding_for};
use crate::errors::hyper_error_code;
use crate::pool::{Connection, ConnectionPool, DriverGuard, PoolKey};
use crate::tls::{ConnectError, PinnedTls};

/// Decoded output produced per body step (bounds a compression bomb's
/// expansion between two byte-count checks).
const DECODE_CHUNK_BYTES: usize = 32 * 1024;

/// One GET to a validated address (`PinnedRequest`).
#[derive(Clone, Copy, Debug)]
pub struct PinnedRequest<'a> {
	/// SNI, certificate identity and `Host`. Never resolved again.
	pub hostname: &'a str,
	/// The validated public address the socket must connect to.
	pub address: IpAddr,
	/// Path and query, starting with "/".
	pub path: &'a str,
	/// Request headers.
	pub headers: HopHeaders<'a>,
	/// Ceiling on body bytes read from the socket before content decoding.
	pub max_encoded_bytes: usize,
}

/// The response head plus a streaming, content-decoded body (`PinnedResponse`).
pub struct PinnedResponse {
	/// HTTP status code.
	pub status: u16,
	/// `Location` (Latin-1 text).
	pub location: Option<String>,
	/// `Content-Type` (Latin-1 text).
	pub content_type: Option<String>,
	/// Size as transferred, when declared (`/^\d{1,15}$/` after trimming).
	pub content_length: Option<u64>,
	/// Decoded body; empty for a non-2xx status. Dropping it closes the
	/// connection unless it was read to its end.
	pub body: Box<dyn HopBody>,
}

impl std::fmt::Debug for PinnedResponse {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("PinnedResponse")
			.field("status", &self.status)
			.field("location", &self.location)
			.field("content_type", &self.content_type)
			.field("content_length", &self.content_length)
			.finish_non_exhaustive()
	}
}

/// Performs one pinned GET (`PinnedConnect`). `Err` on any connection, TLS
/// or protocol failure, and for an unsupported content encoding.
#[async_trait]
pub trait PinnedConnect: Send + Sync {
	/// Sends the request.
	async fn connect(&self, request: PinnedRequest<'_>) -> Result<PinnedResponse, ConnectError>;

	/// Whether an idle pooled connection to (`hostname`, `address`) exists;
	/// the transport tries such addresses first.
	fn has_idle(&self, _hostname: &str, _address: IpAddr) -> bool {
		false
	}
}

/// The production [`PinnedConnect`]: verified TLS to the pinned address,
/// HTTP/1.1, with the keep-alive pool.
#[derive(Debug)]
pub struct PinnedHttpsConnect {
	tls: PinnedTls,
	pool: Arc<ConnectionPool>,
	opened: AtomicU64,
}

/// Node's `headerText` + Latin-1 decoding of the first value.
fn header_text(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
	headers.get(name).map(|value| latin1(value.as_bytes()))
}

/// Node keeps header bytes as Latin-1 characters (bytes ≥ 0x80 become
/// U+0080–U+00FF, which `new URL` then percent-encodes as UTF-8).
fn latin1(bytes: &[u8]) -> String {
	bytes.iter().map(|&byte| char::from(byte)).collect()
}

/// `content-encoding` duplicates are joined with ", " by Node (so two
/// headers become an unsupported list, exactly as in the TypeScript).
fn content_encoding(headers: &HeaderMap) -> Option<String> {
	let mut values = headers.get_all(CONTENT_ENCODING).iter();
	let first = values.next()?;
	let mut joined = latin1(first.as_bytes());
	for value in values {
		joined.push_str(", ");
		joined.push_str(&latin1(value.as_bytes()));
	}
	Some(joined)
}

/// `headerInteger`: `/^\d{1,15}$/` on the JS-trimmed value.
#[must_use]
pub fn header_integer(value: Option<&str>) -> Option<u64> {
	let trimmed = research_js::whitespace::trim(value?);
	if (1..=15).contains(&trimmed.len()) && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
		trimmed.parse().ok()
	} else {
		None
	}
}

/// Whether the server allows the connection to carry another request.
fn keeps_alive(version: Version, headers: &HeaderMap) -> bool {
	let has_token = |token: &str| {
		headers.get_all(CONNECTION).iter().any(|value| {
			value
				.as_bytes()
				.split(|&byte| byte == b',')
				.any(|part| part.trim_ascii().eq_ignore_ascii_case(token.as_bytes()))
		})
	};
	match version {
		Version::HTTP_11 => !has_token("close"),
		Version::HTTP_10 => has_token("keep-alive") && !has_token("close"),
		_ => false,
	}
}

fn build_request(request: &PinnedRequest<'_>) -> Result<Request<Empty<Bytes>>, ConnectError> {
	// Values were checked against the printable-ASCII rule by the core and
	// the host name by the URL policy; a failure here is a bug, reported in
	// Node's words.
	let value = |text: &str| {
		HeaderValue::from_str(text).map_err(|_| ConnectError::code("ERR_INVALID_CHAR"))
	};
	let mut builder = Request::builder()
		.method(Method::GET)
		.uri(request.path)
		.header(HOST, value(request.hostname)?)
		.header(ACCEPT, value(request.headers.accept)?)
		.header(USER_AGENT, value(request.headers.user_agent)?);
	if let Some(authorization) = request.headers.authorization {
		builder = builder.header(AUTHORIZATION, value(authorization)?);
	}
	if let Some(token) = request.headers.finnhub_token {
		builder = builder.header(HeaderName::from_static("x-finnhub-token"), value(token)?);
	}
	builder
		.header(ACCEPT_ENCODING, HeaderValue::from_static("gzip"))
		.body(Empty::new())
		.map_err(|_| ConnectError::code("ERR_UNESCAPED_CHARACTERS"))
}

enum SendFailure {
	/// The connection was closed under us before a response arrived; for a
	/// pooled connection the request is retried on a fresh one (GET is
	/// idempotent and no response byte was seen).
	Closed(ConnectError),
	/// Any other failure.
	Failed(ConnectError),
}

impl PinnedHttpsConnect {
	/// The production connector.
	#[must_use]
	pub fn new(tls: PinnedTls) -> Self {
		Self {
			tls,
			pool: Arc::new(ConnectionPool::default()),
			opened: AtomicU64::new(0),
		}
	}

	/// The pool (tests and diagnostics).
	#[must_use]
	pub fn pool(&self) -> &ConnectionPool {
		&self.pool
	}

	/// How many TCP+TLS connections this connector has opened.
	#[must_use]
	pub fn connections_opened(&self) -> u64 {
		self.opened.load(Ordering::Relaxed)
	}

	async fn open(&self, hostname: &str, address: IpAddr) -> Result<Connection, ConnectError> {
		let stream = self.tls.connect(hostname, address).await?;
		self.opened.fetch_add(1, Ordering::Relaxed);
		let (sender, connection) = hyper::client::conn::http1::Builder::new()
			.handshake::<_, Empty<Bytes>>(TokioIo::new(stream))
			.await
			.map_err(|error| ConnectError::code(hyper_error_code(&error)))?;
		let driver = tokio::spawn(async move {
			// The outcome is observed through the request/response futures.
			let _ = connection.await;
		});
		Ok(Connection {
			sender,
			_driver: DriverGuard(driver.abort_handle()),
		})
	}

	async fn send(
		&self,
		mut connection: Connection,
		key: PoolKey,
		request: &PinnedRequest<'_>,
	) -> Result<PinnedResponse, SendFailure> {
		let outgoing = build_request(request).map_err(SendFailure::Failed)?;
		if connection.sender.ready().await.is_err() {
			return Err(SendFailure::Closed(ConnectError::code("ECONNRESET")));
		}
		let response = match connection.sender.send_request(outgoing).await {
			Ok(response) => response,
			Err(error) => {
				let detail = ConnectError::code(hyper_error_code(&error));
				return Err(if error.is_parse() || error.is_parse_status() {
					SendFailure::Failed(detail)
				} else {
					SendFailure::Closed(detail)
				});
			}
		};
		let (head, body) = response.into_parts();
		let status = head.status.as_u16();
		let location = header_text(&head.headers, &LOCATION);
		let content_type = header_text(&head.headers, &CONTENT_TYPE);
		let content_length = header_integer(header_text(&head.headers, &CONTENT_LENGTH).as_deref());
		if !(200..=299).contains(&status) {
			// Never read, never pooled: dropping `connection` closes it.
			return Ok(PinnedResponse {
				status,
				location,
				content_type,
				content_length,
				body: Box::new(EmptyBody),
			});
		}
		let decoder = match encoding_for(content_encoding(&head.headers).as_deref()) {
			Encoding::Identity => None,
			Encoding::Decoded(decoder) => Some(decoder),
			Encoding::Unsupported => {
				return Err(SendFailure::Failed(ConnectError::code(
					"UNSUPPORTED_CONTENT_ENCODING",
				)));
			}
		};
		let reusable = keeps_alive(head.version, &head.headers);
		Ok(PinnedResponse {
			status,
			location,
			content_type,
			content_length,
			body: Box::new(PinnedBody {
				incoming: body,
				release: Some(Release {
					pool: Arc::clone(&self.pool),
					key,
					connection,
					reusable,
				}),
				decoder,
				pending: Bytes::new(),
				wire_bytes: 0,
				max_encoded_bytes: request.max_encoded_bytes,
				wire_done: false,
				finished: false,
				buffer: Vec::new(),
			}),
		})
	}
}

#[async_trait]
impl PinnedConnect for PinnedHttpsConnect {
	async fn connect(&self, request: PinnedRequest<'_>) -> Result<PinnedResponse, ConnectError> {
		let key: PoolKey = (request.hostname.to_owned(), request.address);
		if let Some(idle) = self.pool.take(request.hostname, request.address) {
			match self.send(idle, key.clone(), &request).await {
				Ok(response) => return Ok(response),
				// The server closed the idle connection: fall through to a fresh one.
				Err(SendFailure::Closed(_)) => {}
				Err(SendFailure::Failed(error)) => return Err(error),
			}
		}
		let connection = self.open(request.hostname, request.address).await?;
		match self.send(connection, key, &request).await {
			Ok(response) => Ok(response),
			Err(SendFailure::Closed(error) | SendFailure::Failed(error)) => Err(error),
		}
	}

	fn has_idle(&self, hostname: &str, address: IpAddr) -> bool {
		self.pool.has_idle(hostname, address)
	}
}

/// The body of a non-2xx response: never read.
struct EmptyBody;

#[async_trait]
impl HopBody for EmptyBody {
	async fn next_chunk(&mut self) -> Option<Result<Bytes, BodyError>> {
		None
	}
}

/// Where a cleanly finished connection goes.
struct Release {
	pool: Arc<ConnectionPool>,
	key: PoolKey,
	connection: Connection,
	reusable: bool,
}

struct PinnedBody {
	incoming: Incoming,
	/// `Some` until the body ends; dropping it (any early exit) closes the socket.
	release: Option<Release>,
	decoder: Option<ContentDecoder>,
	/// Wire bytes not yet fed to the decoder.
	pending: Bytes,
	wire_bytes: usize,
	max_encoded_bytes: usize,
	wire_done: bool,
	finished: bool,
	buffer: Vec<u8>,
}

impl PinnedBody {
	fn fail(&mut self, error: BodyError) -> Option<Result<Bytes, BodyError>> {
		self.finished = true;
		self.release = None;
		Some(Err(error))
	}

	/// End of a complete, successfully decoded body: pool the connection.
	fn complete(&mut self) -> Option<Result<Bytes, BodyError>> {
		self.finished = true;
		if let Some(release) = self.release.take() {
			if release.reusable {
				release.pool.put(release.key, release.connection);
			}
		}
		None
	}

	/// Decodes pending wire bytes; `Some(chunk)` when output was produced.
	fn decode_pending(&mut self) -> Result<Option<Bytes>, BodyError> {
		let Some(decoder) = self.decoder.as_mut() else {
			return Ok(None);
		};
		if self.buffer.len() != DECODE_CHUNK_BYTES {
			self.buffer.resize(DECODE_CHUNK_BYTES, 0);
		}
		while !self.pending.is_empty() {
			let step = decoder
				.step(&self.pending, &mut self.buffer)
				.map_err(|error| BodyError::Failed(error.0))?;
			let consumed = step.consumed.min(self.pending.len());
			let _ = self.pending.split_to(consumed);
			if step.produced > 0 {
				let produced = step.produced.min(self.buffer.len());
				return Ok(Some(Bytes::copy_from_slice(
					self.buffer.get(..produced).unwrap_or(&[]),
				)));
			}
			if consumed == 0 {
				// No progress on non-empty input cannot end well; fail closed.
				return Err(BodyError::Failed("Z_DATA_ERROR".to_owned()));
			}
		}
		Ok(None)
	}
}

#[async_trait]
impl HopBody for PinnedBody {
	async fn next_chunk(&mut self) -> Option<Result<Bytes, BodyError>> {
		if self.finished {
			return None;
		}
		loop {
			if self.decoder.is_some() {
				match self.decode_pending() {
					Ok(Some(chunk)) => return Some(Ok(chunk)),
					Ok(None) => {}
					Err(error) => return self.fail(error),
				}
				if self.wire_done {
					let drained = match self.decoder.as_mut() {
						Some(decoder) => decoder.drain(&mut self.buffer),
						None => Ok(0),
					};
					match drained {
						Ok(0) => {}
						Ok(produced) => {
							let produced = produced.min(self.buffer.len());
							return Some(Ok(Bytes::copy_from_slice(
								self.buffer.get(..produced).unwrap_or(&[]),
							)));
						}
						Err(error) => return self.fail(BodyError::Failed(error.0)),
					}
					let finished = self.decoder.as_ref().map_or(Ok(()), ContentDecoder::finish);
					return match finished {
						Ok(()) => self.complete(),
						Err(error) => self.fail(BodyError::Failed(error.0)),
					};
				}
			}
			match self.incoming.frame().await {
				None => {
					self.wire_done = true;
					if self.decoder.is_none() {
						return self.complete();
					}
				}
				Some(Err(error)) => {
					return self.fail(BodyError::Failed(hyper_error_code(&error).to_owned()));
				}
				Some(Ok(frame)) => {
					let Ok(data) = frame.into_data() else {
						continue; // trailers
					};
					if self.decoder.is_none() {
						if data.is_empty() {
							continue;
						}
						return Some(Ok(data));
					}
					self.wire_bytes = self.wire_bytes.saturating_add(data.len());
					if self.wire_bytes > self.max_encoded_bytes {
						return self.fail(BodyError::TooLarge);
					}
					self.pending = data;
				}
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_content_length_like_node() {
		assert_eq!(header_integer(Some("5")), Some(5));
		assert_eq!(header_integer(Some(" 42\u{FEFF}")), Some(42));
		assert_eq!(
			header_integer(Some("999999999999999")),
			Some(999_999_999_999_999)
		);
		assert_eq!(header_integer(Some("1000000000000000")), None);
		assert_eq!(header_integer(Some("-1")), None);
		assert_eq!(header_integer(Some("1e3")), None);
		assert_eq!(header_integer(Some("")), None);
		assert_eq!(header_integer(None), None);
	}

	#[test]
	fn decides_keep_alive_from_version_and_connection() {
		let mut headers = HeaderMap::new();
		assert!(keeps_alive(Version::HTTP_11, &headers));
		assert!(!keeps_alive(Version::HTTP_10, &headers));
		headers.insert(CONNECTION, HeaderValue::from_static("Keep-Alive, Close"));
		assert!(!keeps_alive(Version::HTTP_11, &headers));
		headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
		assert!(keeps_alive(Version::HTTP_10, &headers));
	}

	#[test]
	fn builds_the_request_with_the_typescript_header_order() {
		let request = PinnedRequest {
			hostname: "pinned.synthetic-wire.org",
			address: "93.184.216.34".parse().unwrap(),
			path: "/echo?x=1",
			headers: HopHeaders {
				accept: "text/plain",
				user_agent: "pinned-connect-test",
				authorization: Some("apikey k"),
				finnhub_token: Some("k"),
			},
			max_encoded_bytes: 10,
		};
		let built = build_request(&request).unwrap();
		assert_eq!(built.method(), Method::GET);
		assert_eq!(built.uri(), "/echo?x=1");
		let names: Vec<&str> = built.headers().keys().map(HeaderName::as_str).collect();
		assert_eq!(
			names,
			[
				"host",
				"accept",
				"user-agent",
				"authorization",
				"x-finnhub-token",
				"accept-encoding"
			]
		);
		assert_eq!(built.headers()[HOST], "pinned.synthetic-wire.org");
		assert_eq!(built.headers()[ACCEPT_ENCODING], "gzip");
		let plain = build_request(&PinnedRequest {
			headers: HopHeaders {
				authorization: None,
				finnhub_token: None,
				..request.headers
			},
			..request
		})
		.unwrap();
		assert!(!plain.headers().contains_key(AUTHORIZATION));
		assert!(!plain.headers().contains_key("x-finnhub-token"));
		assert!(!plain.headers().contains_key(CONNECTION));
	}

	#[test]
	fn joins_duplicate_content_encodings_like_node() {
		let mut headers = HeaderMap::new();
		headers.append(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
		headers.append(CONTENT_ENCODING, HeaderValue::from_static("br"));
		assert_eq!(content_encoding(&headers).as_deref(), Some("gzip, br"));
		assert_eq!(latin1(b"caf\xE9"), "café");
	}
}
