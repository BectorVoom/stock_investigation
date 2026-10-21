//! HTTPS client for the runner endpoints (port of `apps/runner/src/apiClient.ts`,
//! shell-wire spec section 2; API-007): every call has a timeout, a bounded
//! number of attempts with exponential backoff, and its response is
//! validated against the shared contract. Only transport failures, 429 and
//! 5xx (and CONFLICT) are retried; all runner endpoints are idempotent, so a
//! retry is safe.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper::body::Incoming;
use hyper::header::{CONNECTION, HOST};
use hyper_util::rt::TokioIo;
use research_contracts::api::{
	ApiErrorBody, ApiErrorCode, IssuedRunnerCredential, RUNNER_API_PREFIX,
};
use research_contracts::jobs::{
	ClaimJobRequest, ClaimJobResponse, CompleteJobRequest, CompleteJobResponse, EventsResponse,
	HeartbeatRequest, HeartbeatResponse, RunnerEventsRequest,
};
use research_contracts::json::to_js_json;
use research_contracts::{Contract, ContractError};
use research_finance::ports::Sleeper;
use rustls::ClientConfig;
use rustls_pki_types::ServerName;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_rustls::TlsConnector;
use url::{Host, Url};

/// Failure of one runner API call. `code` is the API's stable code or a
/// transport code. `detail` is never logged anywhere in the runner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerApiError {
	/// Stable API code, `HTTP_<status>`, `TRANSPORT_ERROR` or `INVALID_RESPONSE`.
	pub code: String,
	/// Free text for debugging; its exact wording is not part of the contract.
	pub detail: String,
	/// True when repeating the identical request later may succeed.
	pub transient: bool,
}

/// Result of one runner API call.
pub type RunnerApiResult<T> = Result<T, RunnerApiError>;

/// The runner's view of the Worker. A port, so job execution is testable
/// without HTTP.
#[async_trait]
pub trait RunnerApi: Send + Sync {
	/// `POST /jobs/claim`.
	async fn claim(&self, request: &ClaimJobRequest) -> RunnerApiResult<ClaimJobResponse>;
	/// `POST /jobs/{runId}/heartbeat`.
	async fn heartbeat(
		&self,
		run_id: &str,
		lease_generation: u64,
	) -> RunnerApiResult<HeartbeatResponse>;
	/// `POST /jobs/{runId}/events`; the answer says whether the owner asked to cancel.
	async fn events(
		&self,
		run_id: &str,
		request: &RunnerEventsRequest,
	) -> RunnerApiResult<EventsResponse>;
	/// `POST /jobs/{runId}/complete`.
	async fn complete(
		&self,
		run_id: &str,
		request: &CompleteJobRequest,
	) -> RunnerApiResult<CompleteJobResponse>;
	/// `POST /credentials/renew`.
	async fn renew_credential(
		&self,
		expires_in_days: u32,
	) -> RunnerApiResult<IssuedRunnerCredential>;
}

/// Timeout of one attempt (connect, headers and body).
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(20_000);
/// Attempts per call.
pub const MAX_ATTEMPTS: u32 = 4;
/// First backoff; doubled before each further attempt.
const BACKOFF_START_MS: u64 = 500;
/// A response body larger than this is a protocol fault, not a job.
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

/// Everything the client needs; secrets stay in this object.
#[derive(Clone)]
pub struct HttpRunnerApiOptions {
	/// Base URL of the Worker.
	pub api_url: String,
	/// The runner's bearer token.
	pub runner_token: String,
	/// Cloudflare Access service token id.
	pub access_client_id: Option<String>,
	/// Cloudflare Access service token secret.
	pub access_client_secret: Option<String>,
	/// Per-attempt timeout.
	pub request_timeout: Duration,
	/// Attempts per call.
	pub max_attempts: u32,
}

impl HttpRunnerApiOptions {
	/// Production timeout and attempt bound.
	#[must_use]
	pub fn new(
		api_url: String,
		runner_token: String,
		access_client_id: Option<String>,
		access_client_secret: Option<String>,
	) -> Self {
		Self {
			api_url,
			runner_token,
			access_client_id,
			access_client_secret,
			request_timeout: REQUEST_TIMEOUT,
			max_attempts: MAX_ATTEMPTS,
		}
	}
}

impl std::fmt::Debug for HttpRunnerApiOptions {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("HttpRunnerApiOptions")
			.field("api_url", &self.api_url)
			.field("max_attempts", &self.max_attempts)
			.finish_non_exhaustive()
	}
}

/// Why the HTTP client could not be built.
#[derive(Debug, thiserror::Error)]
pub enum ApiClientSetupError {
	/// `RESEARCH_API_URL` does not parse (configuration validates it first).
	#[error("RESEARCH_API_URL is not a URL")]
	InvalidUrl,
	/// A header value is not valid HTTP.
	#[error("a configured credential is not a valid header value")]
	InvalidHeader,
	/// rustls rejected its configuration.
	#[error("TLS configuration failed")]
	Tls,
}

/// A response that arrived: the status and its whole body (`None` when
/// reading the body failed or ran into the attempt's deadline). A redirect
/// never gets here.
struct RawResponse {
	status: u16,
	body: Option<Bytes>,
}

/// A failure before a usable response (all `TRANSPORT_ERROR`).
struct TransportFailure(&'static str);

/// Anything a connection can run over (TCP or TLS).
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

type Sender = hyper::client::conn::http1::SendRequest<Full<Bytes>>;

/// An open HTTP/1.1 connection to the API host. Dropping it closes the socket.
struct Connection {
	sender: Sender,
	driver: JoinHandle<()>,
	idle_since: Instant,
}

impl Drop for Connection {
	fn drop(&mut self) {
		self.driver.abort();
	}
}

/// The fixed API host every call goes to.
struct Target {
	tls: bool,
	host: Host<String>,
	port: u16,
	authority: String,
	server_name: Option<ServerName<'static>>,
}

/// An idle connection is reused only this long (proxies and servers close
/// idle sockets after a while; a stale one costs a failed attempt).
const IDLE_LIMIT: Duration = Duration::from_secs(30);
/// Connection Attempt Delay of RFC 8305 (happy eyeballs).
const CONNECTION_ATTEMPT_DELAY: Duration = Duration::from_millis(250);

/// The production [`RunnerApi`]. Keeps one idle keep-alive connection to the
/// configured host: it is one fixed host, so reuse cannot send the token
/// anywhere else.
pub struct HttpRunnerApi {
	base: Url,
	target: Target,
	headers: Vec<(&'static str, String)>,
	tls: TlsConnector,
	sleeper: Arc<dyn Sleeper>,
	pool: Mutex<Option<Connection>>,
	timeout: Duration,
	max_attempts: u32,
}

impl std::fmt::Debug for HttpRunnerApi {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("HttpRunnerApi")
			.field("base", &self.base.as_str())
			.finish_non_exhaustive()
	}
}

fn tls_connector() -> Result<TlsConnector, ApiClientSetupError> {
	// Mozilla's roots like Node's bundled store; `NODE_EXTRA_CA_CERTS` is not honoured.
	let mut roots = rustls::RootCertStore::empty();
	roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
	let provider = Arc::new(rustls::crypto::ring::default_provider());
	let config = ClientConfig::builder_with_provider(provider)
		.with_safe_default_protocol_versions()
		.map_err(|_| ApiClientSetupError::Tls)?
		.with_root_certificates(roots)
		.with_no_client_auth();
	Ok(TlsConnector::from(Arc::new(config)))
}

impl HttpRunnerApi {
	/// Builds the client. `sleeper` waits out the backoff between attempts
	/// (production: tokio's clock).
	///
	/// # Errors
	/// An unparsable URL or header value, or a TLS setup failure.
	pub fn new(
		options: HttpRunnerApiOptions,
		sleeper: Arc<dyn Sleeper>,
	) -> Result<Self, ApiClientSetupError> {
		let base = Url::parse(&options.api_url).map_err(|_| ApiClientSetupError::InvalidUrl)?;
		let mut headers = vec![
			("authorization", format!("Bearer {}", options.runner_token)),
			("content-type", "application/json".to_owned()),
		];
		// The Access headers are sent only when both halves are configured.
		if let (Some(id), Some(secret)) = (options.access_client_id, options.access_client_secret) {
			headers.push(("cf-access-client-id", id));
			headers.push(("cf-access-client-secret", secret));
		}
		// Never an Origin or Cookie header: the Worker rejects them with FORBIDDEN.
		for (_, value) in &headers {
			http::HeaderValue::from_str(value).map_err(|_| ApiClientSetupError::InvalidHeader)?;
		}
		let host = base
			.host()
			.ok_or(ApiClientSetupError::InvalidUrl)?
			.to_owned();
		let port = base
			.port_or_known_default()
			.ok_or(ApiClientSetupError::InvalidUrl)?;
		let server_name = match &host {
			Host::Domain(domain) => ServerName::try_from(domain.clone()),
			Host::Ipv4(address) => Ok(ServerName::from(std::net::IpAddr::V4(*address))),
			Host::Ipv6(address) => Ok(ServerName::from(std::net::IpAddr::V6(*address))),
		}
		.map_err(|_| ApiClientSetupError::InvalidUrl)?;
		let host_text = base.host_str().unwrap_or_default();
		let authority = base.port().map_or_else(
			|| host_text.to_owned(),
			|explicit| format!("{host_text}:{explicit}"),
		);
		Ok(Self {
			target: Target {
				tls: base.scheme() == "https",
				host,
				port,
				authority,
				server_name: Some(server_name),
			},
			base,
			headers,
			tls: tls_connector()?,
			sleeper,
			pool: Mutex::new(None),
			timeout: options.request_timeout,
			max_attempts: options.max_attempts,
		})
	}

	/// Addresses of the host, IPv6 and IPv4 interleaved (IPv6 first).
	async fn resolve(&self) -> Result<Vec<SocketAddr>, TransportFailure> {
		let port = self.target.port;
		let found: Vec<SocketAddr> = match &self.target.host {
			Host::Domain(domain) => tokio::net::lookup_host((domain.as_str(), port))
				.await
				.map_err(|_| TransportFailure("LookupError"))?
				.collect(),
			Host::Ipv4(address) => vec![SocketAddr::new((*address).into(), port)],
			Host::Ipv6(address) => vec![SocketAddr::new((*address).into(), port)],
		};
		Ok(interleave(found))
	}

	/// Opens a connection: TCP (racing the addresses), TLS for https, HTTP/1.1.
	/// No proxy is ever consulted: the bearer token must not be routed through
	/// an inherited proxy variable.
	async fn connect(&self) -> Result<Connection, TransportFailure> {
		let addresses = self.resolve().await?;
		let tcp = race_connect(addresses)
			.await
			.map_err(|_| TransportFailure("ConnectError"))?;
		// Small requests go out at once.
		let _ = tcp.set_nodelay(true);
		let io: Box<dyn Io> = match (&self.target.server_name, self.target.tls) {
			(Some(name), true) => Box::new(
				self.tls
					.connect(name.clone(), tcp)
					.await
					.map_err(|_| TransportFailure("TlsError"))?,
			),
			_ => Box::new(tcp),
		};
		let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io))
			.await
			.map_err(|_| TransportFailure("HandshakeError"))?;
		Ok(Connection {
			sender,
			driver: tokio::spawn(async move {
				// A broken connection surfaces through the request that uses it.
				let _ = connection.await;
			}),
			idle_since: Instant::now(),
		})
	}

	/// The idle connection when it is still usable, else a new one.
	async fn acquire(&self, deadline: Instant) -> Result<(Connection, bool), TransportFailure> {
		let idle = self
			.pool
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.take();
		if let Some(mut connection) = idle
			&& connection.idle_since.elapsed() < IDLE_LIMIT
			&& matches!(
				tokio::time::timeout_at(deadline, connection.sender.ready()).await,
				Ok(Ok(()))
			) {
			return Ok((connection, true));
		}
		let fresh = tokio::time::timeout_at(deadline, self.connect())
			.await
			.unwrap_or(Err(TransportFailure("TimeoutError")))?;
		Ok((fresh, false))
	}

	fn release(&self, mut connection: Connection) {
		connection.idle_since = Instant::now();
		let mut slot = self
			.pool
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		if slot.is_none() {
			*slot = Some(connection);
		}
	}

	async fn send_once(
		&self,
		connection: &mut Connection,
		path: &str,
		body: &str,
		deadline: Instant,
	) -> Result<hyper::Response<Incoming>, TransportFailure> {
		let mut request = Request::builder()
			.method("POST")
			.uri(path)
			.header(HOST, &self.target.authority);
		for (name, value) in &self.headers {
			request = request.header(*name, value);
		}
		let request = request
			.body(Full::new(Bytes::copy_from_slice(body.as_bytes())))
			.map_err(|_| TransportFailure("TypeError"))?;
		match tokio::time::timeout_at(deadline, connection.sender.send_request(request)).await {
			Ok(Ok(response)) => Ok(response),
			Ok(Err(_)) => Err(TransportFailure("RequestError")),
			Err(_) => Err(TransportFailure("TimeoutError")),
		}
	}

	/// One request, bounded by the attempt timeout (connect, headers and body).
	async fn exchange(&self, path: &str, body: &str) -> Result<RawResponse, TransportFailure> {
		// The leading `/` replaces any path of the configured URL.
		let url = self
			.base
			.join(&format!("{RUNNER_API_PREFIX}{path}"))
			.map_err(|_| TransportFailure("TypeError"))?;
		let path = url.path();
		let deadline = Instant::now() + self.timeout;
		let (mut connection, reused) = self.acquire(deadline).await?;
		let response = match self.send_once(&mut connection, path, body, deadline).await {
			Ok(response) => response,
			// An idle connection the server closed meanwhile: the request never
			// reached it, so send it once more on a fresh connection.
			Err(TransportFailure("RequestError")) if reused => {
				connection = tokio::time::timeout_at(deadline, self.connect())
					.await
					.unwrap_or(Err(TransportFailure("TimeoutError")))?;
				self.send_once(&mut connection, path, body, deadline)
					.await?
			}
			Err(failure) => return Err(failure),
		};
		let status = response.status().as_u16();
		// `redirect: "error"`: a redirect makes the request fail before any body
		// is read, so the token never follows it. Other 3xx statuses (304) are
		// ordinary responses.
		if matches!(status, 301 | 302 | 303 | 307 | 308) {
			return Err(TransportFailure("RedirectError"));
		}
		let closing = response
			.headers()
			.get(CONNECTION)
			.is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"close"));
		let body = tokio::time::timeout_at(deadline, read_body(response.into_body()))
			.await
			.ok()
			.flatten();
		if body.is_some() && !closing {
			self.release(connection);
		}
		Ok(RawResponse { status, body })
	}

	/// One attempt, classified (spec section 2 table).
	async fn attempt<T: Contract>(&self, path: &str, body: &str) -> RunnerApiResult<T> {
		let raw = self
			.exchange(path, body)
			.await
			.map_err(|failure| RunnerApiError {
				code: "TRANSPORT_ERROR".to_owned(),
				detail: failure.0.to_owned(),
				transient: true,
			})?;
		// Like `response.json()` rejecting: a body that could not be read (or
		// timed out) is an invalid response, retried only for 5xx.
		let Some(bytes) = raw.body else {
			return Err(RunnerApiError {
				code: "INVALID_RESPONSE".to_owned(),
				detail: format!("HTTP {} with an unreadable body", raw.status),
				transient: raw.status >= 500,
			});
		};
		classify::<T>(raw.status, &bytes)
	}

	async fn post<T: Contract>(&self, path: &str, body: &impl Serialize) -> RunnerApiResult<T> {
		let text = to_js_json(body).map_err(|_| RunnerApiError {
			code: "INVALID_REQUEST".to_owned(),
			detail: "the request body could not be serialised".to_owned(),
			transient: false,
		})?;
		let mut result = self.attempt::<T>(path, &text).await;
		let mut tries = 1;
		while tries < self.max_attempts && matches!(&result, Err(error) if error.transient) {
			// Callers cancel a call by dropping its future (shutdown), which also
			// ends this wait.
			self.sleeper
				.sleep(BACKOFF_START_MS << (tries - 1), None)
				.await;
			result = self.attempt::<T>(path, &text).await;
			tries += 1;
		}
		result
	}
}

/// Reads the whole body; `None` on a read error or a body over the cap.
async fn read_body(mut body: Incoming) -> Option<Bytes> {
	let mut bytes = Vec::new();
	while let Some(frame) = body.frame().await {
		if let Ok(data) = frame.ok()?.into_data() {
			if bytes.len().saturating_add(data.len()) > MAX_RESPONSE_BYTES {
				return None;
			}
			bytes.extend_from_slice(&data);
		}
	}
	Some(Bytes::from(bytes))
}

/// IPv6 and IPv4 addresses alternating, IPv6 first, each family in resolver order.
fn interleave(found: Vec<SocketAddr>) -> Vec<SocketAddr> {
	let (mut six, mut four): (Vec<_>, Vec<_>) = found.into_iter().partition(SocketAddr::is_ipv6);
	six.reverse();
	four.reverse();
	let mut ordered = Vec::new();
	while !six.is_empty() || !four.is_empty() {
		ordered.extend(six.pop());
		ordered.extend(four.pop());
	}
	ordered
}

/// Happy eyeballs (RFC 8305): attempt `i` starts `i` delays after the first, so
/// a black-holed address family costs 250 ms, not the whole attempt timeout;
/// the first connection wins and the rest are dropped.
async fn race_connect(addresses: Vec<SocketAddr>) -> std::io::Result<TcpStream> {
	let mut attempts = FuturesUnordered::new();
	for (index, address) in addresses.into_iter().enumerate() {
		attempts.push(async move {
			if let Ok(position) = u32::try_from(index)
				&& position > 0
			{
				tokio::time::sleep(CONNECTION_ATTEMPT_DELAY * position).await;
			}
			TcpStream::connect(address).await
		});
	}
	let mut last = std::io::Error::other("no addresses");
	while let Some(result) = attempts.next().await {
		match result {
			Ok(stream) => return Ok(stream),
			Err(error) => last = error,
		}
	}
	Err(last)
}

/// Whether a status is retried: `429 || >= 500`.
const fn retryable_status(status: u16) -> bool {
	status == 429 || status >= 500
}

/// Result classification of one attempt (`apiClient.ts:74-123`).
fn classify<T: Contract>(status: u16, body: &[u8]) -> RunnerApiResult<T> {
	let success = (200..300).contains(&status);
	if !success {
		let payload = research_contracts::parse_bytes::<ApiErrorBody>(body);
		return Err(match payload {
			// A non-JSON body is INVALID_RESPONSE, retried only for 5xx.
			Err(ContractError::Json(_)) => RunnerApiError {
				code: "INVALID_RESPONSE".to_owned(),
				detail: format!("HTTP {status} with a non-JSON body"),
				transient: status >= 500,
			},
			Ok(parsed) => RunnerApiError {
				code: parsed.error.code.as_str().to_owned(),
				detail: parsed.error.detail.unwrap_or_default(),
				// CONFLICT means "a version moved under you; send the same request
				// again" — the Worker stops retrying inside one request to stay
				// within its query budget.
				transient: retryable_status(status) || parsed.error.code == ApiErrorCode::Conflict,
			},
			// Unknown code or extra keys: only the status counts.
			Err(ContractError::Invalid(_)) => RunnerApiError {
				code: format!("HTTP_{status}"),
				detail: String::new(),
				transient: retryable_status(status),
			},
		});
	}
	match research_contracts::parse_bytes::<T>(body) {
		Ok(value) => Ok(value),
		Err(ContractError::Json(_)) => Err(RunnerApiError {
			code: "INVALID_RESPONSE".to_owned(),
			detail: format!("HTTP {status} with a non-JSON body"),
			transient: status >= 500,
		}),
		Err(ContractError::Invalid(_)) => Err(RunnerApiError {
			code: "INVALID_RESPONSE".to_owned(),
			detail: "response failed contract validation".to_owned(),
			transient: false,
		}),
	}
}

/// `{"leaseGeneration":n}`.
pub(crate) fn heartbeat_request(lease_generation: u64) -> HeartbeatRequest {
	HeartbeatRequest { lease_generation }
}

/// `{"expiresInDays":n}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenewRequest {
	expires_in_days: u32,
}

#[async_trait]
impl RunnerApi for HttpRunnerApi {
	async fn claim(&self, request: &ClaimJobRequest) -> RunnerApiResult<ClaimJobResponse> {
		self.post("/jobs/claim", request).await
	}

	async fn heartbeat(
		&self,
		run_id: &str,
		lease_generation: u64,
	) -> RunnerApiResult<HeartbeatResponse> {
		self.post(
			&format!("/jobs/{run_id}/heartbeat"),
			&heartbeat_request(lease_generation),
		)
		.await
	}

	async fn events(
		&self,
		run_id: &str,
		request: &RunnerEventsRequest,
	) -> RunnerApiResult<EventsResponse> {
		self.post(&format!("/jobs/{run_id}/events"), request).await
	}

	async fn complete(
		&self,
		run_id: &str,
		request: &CompleteJobRequest,
	) -> RunnerApiResult<CompleteJobResponse> {
		self.post(&format!("/jobs/{run_id}/complete"), request)
			.await
	}

	async fn renew_credential(
		&self,
		expires_in_days: u32,
	) -> RunnerApiResult<IssuedRunnerCredential> {
		self.post("/credentials/renew", &RenewRequest { expires_in_days })
			.await
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Mutex;

	use research_finance::ports::TokioSleeper;
	use tokio::net::TcpListener;
	use tokio_util::sync::CancellationToken;

	use super::*;
	use crate::test_support::{Reply, json, serve};

	/// Records requested sleeps instead of waiting.
	#[derive(Default)]
	struct RecordingSleeper(Mutex<Vec<u64>>);

	#[async_trait]
	impl Sleeper for RecordingSleeper {
		async fn sleep(&self, ms: u64, _cancel: Option<&CancellationToken>) {
			self.0.lock().unwrap().push(ms);
		}
	}

	fn token() -> String {
		format!("rk_{}", "a".repeat(64))
	}

	fn client(url: &str, sleeper: Arc<dyn Sleeper>) -> HttpRunnerApi {
		HttpRunnerApi::new(
			HttpRunnerApiOptions::new(url.to_owned(), token(), None, None),
			sleeper,
		)
		.unwrap()
	}

	const IDLE: &str = r#"{"job":null,"pollAfterMs":15000}"#;
	const BEAT: &str = r#"{"leaseExpiresAt":"2026-10-11T00:03:00.000Z","cancelRequested":false}"#;

	fn empty_claim() -> ClaimJobRequest {
		ClaimJobRequest {
			runner_version: "t".to_owned(),
			agents: vec![],
		}
	}

	#[tokio::test]
	async fn sends_the_bearer_token_only_to_the_configured_origin_and_refuses_redirects() {
		let worker = serve(vec![json(200, IDLE)]).await;
		let api = client(&worker.url, Arc::new(TokioSleeper));
		let result = api.claim(&empty_claim()).await.unwrap();
		assert_eq!(result.poll_after_ms, 15_000);
		let request = &worker.requests()[0];
		assert_eq!(request.path, "/api/v1/runner/jobs/claim");
		assert_eq!(request.body, r#"{"runnerVersion":"t","agents":[]}"#);
		assert_eq!(
			request.header("authorization"),
			Some(format!("Bearer {}", token()).as_str())
		);
		assert_eq!(request.header("content-type"), Some("application/json"));
		for forbidden in [
			"origin",
			"cookie",
			"cf-access-client-id",
			"cf-access-client-secret",
		] {
			assert_eq!(request.header(forbidden), None, "{forbidden}");
		}

		// A redirect is a transport error; the token never follows it.
		let target = serve(vec![json(200, IDLE)]).await;
		let redirecting = serve(vec![Reply::Redirect(format!("{}/steal", target.url))]).await;
		let sleeper = Arc::new(RecordingSleeper::default());
		let api = client(&redirecting.url, sleeper.clone());
		let error = api.claim(&empty_claim()).await.unwrap_err();
		assert_eq!(error.code, "TRANSPORT_ERROR");
		assert!(error.transient);
		assert!(target.requests().is_empty());
		assert_eq!(redirecting.requests().len(), 4);
	}

	#[tokio::test]
	async fn sends_access_headers_only_when_both_are_configured() {
		let worker = serve(vec![json(200, IDLE)]).await;
		let both = HttpRunnerApi::new(
			HttpRunnerApiOptions::new(
				worker.url.clone(),
				token(),
				Some("id".to_owned()),
				Some("secret".to_owned()),
			),
			Arc::new(TokioSleeper),
		)
		.unwrap();
		both.claim(&empty_claim()).await.unwrap();
		let half = HttpRunnerApi::new(
			HttpRunnerApiOptions::new(worker.url.clone(), token(), Some("id".to_owned()), None),
			Arc::new(TokioSleeper),
		)
		.unwrap();
		half.claim(&empty_claim()).await.unwrap();
		let seen = worker.requests();
		assert_eq!(seen[0].header("cf-access-client-id"), Some("id"));
		assert_eq!(seen[0].header("cf-access-client-secret"), Some("secret"));
		assert_eq!(seen[1].header("cf-access-client-id"), None);
	}

	#[tokio::test]
	async fn a_path_in_the_api_url_is_replaced_not_appended() {
		let worker = serve(vec![json(200, BEAT)]).await;
		let api = client(
			&format!("{}/some/prefix/", worker.url),
			Arc::new(TokioSleeper),
		);
		api.heartbeat("run_x", 7).await.unwrap();
		let request = &worker.requests()[0];
		assert_eq!(request.path, "/api/v1/runner/jobs/run_x/heartbeat");
		assert_eq!(request.body, r#"{"leaseGeneration":7}"#);
	}

	#[tokio::test]
	async fn retries_transport_errors_429_and_5xx_with_backoff_up_to_a_bound() {
		let internal = r#"{"error":{"code":"INTERNAL","message":"x"}}"#;
		let limited = r#"{"error":{"code":"RATE_LIMITED","message":"x"}}"#;
		let worker = serve(vec![
			Reply::Raw(200, "not json".to_owned()),
			json(503, internal),
			json(429, limited),
			json(200, BEAT),
		])
		.await;
		let sleeper = Arc::new(RecordingSleeper::default());
		let api = client(&worker.url, sleeper.clone());
		// The first reply is a 200 whose body is not JSON: INVALID_RESPONSE, not transient on 2xx.
		assert_eq!(
			api.heartbeat("run_x", 1).await.unwrap_err().code,
			"INVALID_RESPONSE"
		);
		let worker = serve(vec![
			json(503, internal),
			json(429, limited),
			Reply::Raw(502, "<html>".to_owned()),
			json(200, BEAT),
		])
		.await;
		let api = client(&worker.url, sleeper.clone());
		assert!(api.heartbeat("run_x", 1).await.is_ok());
		assert_eq!(worker.requests().len(), 4);
		assert_eq!(*sleeper.0.lock().unwrap(), vec![500, 1_000, 2_000]);

		let always_down = serve(vec![json(503, internal)]).await;
		let error = client(&always_down.url, Arc::new(RecordingSleeper::default()))
			.heartbeat("run_x", 1)
			.await
			.unwrap_err();
		assert_eq!(error.code, "INTERNAL");
		assert!(error.transient);
		assert_eq!(always_down.requests().len(), 4);
	}

	#[tokio::test]
	async fn does_not_retry_a_definitive_rejection_and_surfaces_its_stable_code() {
		let worker = serve(vec![json(
			409,
			r#"{"error":{"code":"STALE_LEASE","message":"x","detail":"STALE_LEASE"}}"#,
		)])
		.await;
		let error = client(&worker.url, Arc::new(TokioSleeper))
			.heartbeat("run_x", 1)
			.await
			.unwrap_err();
		assert_eq!(
			error,
			RunnerApiError {
				code: "STALE_LEASE".to_owned(),
				detail: "STALE_LEASE".to_owned(),
				transient: false
			}
		);
		assert_eq!(worker.requests().len(), 1);
	}

	#[tokio::test]
	async fn classifies_every_failure_shape() {
		let cases = [
			(
				409,
				r#"{"error":{"code":"CONFLICT","message":"x"}}"#,
				"CONFLICT",
				true,
			),
			(
				400,
				r#"{"error":{"code":"NOPE","message":"x"}}"#,
				"HTTP_400",
				false,
			),
			(
				500,
				r#"{"error":{"code":"INTERNAL","message":"x","extra":1}}"#,
				"HTTP_500",
				true,
			),
			(400, "oops", "INVALID_RESPONSE", false),
			(502, "oops", "INVALID_RESPONSE", true),
			(429, "{}", "HTTP_429", true),
		];
		for (status, body, code, transient) in cases {
			let error = classify::<HeartbeatResponse>(status, body.as_bytes()).unwrap_err();
			assert_eq!(
				(error.code.as_str(), error.transient),
				(code, transient),
				"{body}"
			);
		}
	}

	#[tokio::test]
	async fn rejects_a_success_response_that_violates_the_contract() {
		let worker = serve(vec![json(
			200,
			r#"{"job":{"kind":"exec"},"pollAfterMs":1}"#,
		)])
		.await;
		let error = client(&worker.url, Arc::new(TokioSleeper))
			.claim(&empty_claim())
			.await
			.unwrap_err();
		assert_eq!(
			(error.code.as_str(), error.transient),
			("INVALID_RESPONSE", false)
		);
		assert_eq!(worker.requests().len(), 1);
	}

	#[tokio::test]
	async fn an_events_response_with_extra_keys_is_accepted() {
		let worker = serve(vec![json(200, r#"{"cancelRequested":true,"extra":1}"#)]).await;
		let request = RunnerEventsRequest {
			lease_generation: 1,
			events: vec![],
		};
		let response = client(&worker.url, Arc::new(TokioSleeper))
			.events("run_x", &request)
			.await
			.unwrap();
		assert!(response.cancel_requested);
	}

	#[tokio::test]
	async fn a_silent_server_times_out_as_a_transport_error() {
		let worker = serve(vec![Reply::Hang]).await;
		let mut options = HttpRunnerApiOptions::new(worker.url.clone(), token(), None, None);
		options.request_timeout = Duration::from_millis(150);
		options.max_attempts = 1;
		let api = HttpRunnerApi::new(options, Arc::new(TokioSleeper)).unwrap();
		let error = api.claim(&empty_claim()).await.unwrap_err();
		assert_eq!(
			(error.code.as_str(), error.transient),
			("TRANSPORT_ERROR", true)
		);
	}

	#[tokio::test]
	async fn a_closed_port_is_a_transport_error() {
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let url = format!("http://{}", listener.local_addr().unwrap());
		drop(listener);
		let error = client(&url, Arc::new(RecordingSleeper::default()))
			.claim(&empty_claim())
			.await
			.unwrap_err();
		assert_eq!(error.code, "TRANSPORT_ERROR");
	}

	#[tokio::test]
	async fn renewal_posts_the_expiry_and_returns_the_token() {
		let credential = format!(
			r#"{{"credential":{{"credentialId":"c1","label":"runner","createdAt":"2026-10-11T00:00:00.000Z","expiresAt":"2026-11-10T00:00:00.000Z","revokedAt":null,"lastUsedAt":null}},"token":"{}"}}"#,
			"t".repeat(48)
		);
		let worker = serve(vec![json(200, &credential)]).await;
		let issued = client(&worker.url, Arc::new(TokioSleeper))
			.renew_credential(30)
			.await
			.unwrap();
		assert_eq!(issued.token, "t".repeat(48));
		let request = &worker.requests()[0];
		assert_eq!(request.path, "/api/v1/runner/credentials/renew");
		assert_eq!(request.body, r#"{"expiresInDays":30}"#);
	}

	/// A keep-alive server: answers every request on a connection with
	/// `payload`, counts connections, and optionally closes each connection
	/// right after its first answer without announcing it.
	async fn serve_keep_alive(
		payload: &'static str,
		close_after_first: bool,
	) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
		use std::sync::atomic::Ordering;
		use tokio::io::{AsyncReadExt, AsyncWriteExt};
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let url = format!("http://{}", listener.local_addr().unwrap());
		let connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
		let counter = Arc::clone(&connections);
		tokio::spawn(async move {
			loop {
				let Ok((mut stream, _)) = listener.accept().await else {
					return;
				};
				counter.fetch_add(1, Ordering::SeqCst);
				tokio::spawn(async move {
					let mut buffer = Vec::new();
					let mut chunk = [0_u8; 4096];
					loop {
						let read = stream.read(&mut chunk).await.unwrap_or(0);
						if read == 0 {
							return;
						}
						buffer.extend_from_slice(&chunk[..read]);
						// Requests here are small and arrive whole.
						if !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
							continue;
						}
						buffer.clear();
						let response = format!(
							"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{payload}",
							payload.len()
						);
						if stream.write_all(response.as_bytes()).await.is_err() || close_after_first
						{
							return;
						}
					}
				});
			}
		});
		(url, connections)
	}

	#[tokio::test]
	async fn reuses_one_keep_alive_connection_across_calls() {
		use std::sync::atomic::Ordering;
		let (url, connections) = serve_keep_alive(BEAT, false).await;
		let api = client(&url, Arc::new(TokioSleeper));
		for _ in 0..4 {
			api.heartbeat("run_x", 1).await.unwrap();
		}
		assert_eq!(connections.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn a_connection_the_server_closed_while_idle_is_replaced_without_failing_the_call() {
		use std::sync::atomic::Ordering;
		let (url, connections) = serve_keep_alive(BEAT, true).await;
		let api = client(&url, Arc::new(RecordingSleeper::default()));
		api.heartbeat("run_x", 1).await.unwrap();
		tokio::time::sleep(Duration::from_millis(100)).await;
		api.heartbeat("run_x", 1).await.unwrap();
		// Immediately again: no time for the close to be noticed, the retry covers it.
		api.heartbeat("run_x", 1).await.unwrap();
		assert_eq!(connections.load(Ordering::SeqCst), 3);
	}

	#[tokio::test]
	async fn a_304_is_an_invalid_response_that_is_not_retried_but_other_redirects_are_refused() {
		let worker = serve(vec![Reply::Raw(304, String::new())]).await;
		let error = client(&worker.url, Arc::new(RecordingSleeper::default()))
			.claim(&empty_claim())
			.await
			.unwrap_err();
		assert_eq!(
			(error.code.as_str(), error.transient),
			("INVALID_RESPONSE", false)
		);
		assert_eq!(worker.requests().len(), 1);
		for status in [301_u16, 303, 307, 308] {
			let worker = serve(vec![Reply::Raw(status, String::new())]).await;
			let mut options = HttpRunnerApiOptions::new(worker.url.clone(), token(), None, None);
			options.max_attempts = 1;
			let error = HttpRunnerApi::new(options, Arc::new(TokioSleeper))
				.unwrap()
				.claim(&empty_claim())
				.await
				.unwrap_err();
			assert_eq!(error.code, "TRANSPORT_ERROR", "{status}");
		}
	}

	#[tokio::test]
	async fn a_body_that_cannot_be_read_is_an_invalid_response_retried_only_for_5xx() {
		for (reply, transient) in [
			(Reply::Truncated(200), false),
			(Reply::Truncated(503), true),
			(Reply::StallBody(200), false),
		] {
			let worker = serve(vec![reply]).await;
			let mut options = HttpRunnerApiOptions::new(worker.url.clone(), token(), None, None);
			options.request_timeout = Duration::from_millis(300);
			options.max_attempts = 2;
			let sleeper = Arc::new(RecordingSleeper::default());
			let error = HttpRunnerApi::new(options, sleeper.clone())
				.unwrap()
				.claim(&empty_claim())
				.await
				.unwrap_err();
			assert_eq!(
				(error.code.as_str(), error.transient),
				("INVALID_RESPONSE", transient)
			);
			assert_eq!(worker.requests().len(), if transient { 2 } else { 1 });
		}
	}

	#[tokio::test]
	async fn an_unknown_job_kind_is_rejected_like_the_typescript_schema_does() {
		// zod's strict discriminated union fails the whole claim response.
		let error = classify::<ClaimJobResponse>(
			200,
			br#"{"job":{"kind":"quantum","runId":"r"},"pollAfterMs":1}"#,
		)
		.unwrap_err();
		assert_eq!(
			(error.code.as_str(), error.transient),
			("INVALID_RESPONSE", false)
		);
	}

	#[test]
	fn addresses_interleave_ipv6_first() {
		let addresses: Vec<SocketAddr> = [
			"10.0.0.1:443",
			"10.0.0.2:443",
			"[2001:db8::1]:443",
			"[2001:db8::2]:443",
			"10.0.0.3:443",
		]
		.iter()
		.map(|text| text.parse().unwrap())
		.collect();
		let ordered: Vec<String> = interleave(addresses)
			.iter()
			.map(ToString::to_string)
			.collect();
		assert_eq!(
			ordered,
			[
				"[2001:db8::1]:443",
				"10.0.0.1:443",
				"[2001:db8::2]:443",
				"10.0.0.2:443",
				"10.0.0.3:443"
			]
		);
	}

	#[tokio::test]
	async fn a_dead_first_address_does_not_block_the_one_that_answers() {
		let closed = {
			let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
			listener.local_addr().unwrap()
		};
		let open = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let started = std::time::Instant::now();
		let stream = race_connect(vec![closed, open.local_addr().unwrap()]).await;
		assert!(stream.is_ok());
		// The second attempt starts after one delay at most, not after a timeout.
		assert!(started.elapsed() < Duration::from_secs(2));
	}

	/// Latency of the real client against a live Worker (never in CI): run with
	/// `RESEARCH_API_URL=… RUNNER_TOKEN=… cargo test -p research-runner --lib
	/// measure_latency -- --ignored --nocapture`.
	#[tokio::test]
	#[ignore = "needs a running Worker"]
	async fn measure_latency() {
		let api = HttpRunnerApi::new(
			HttpRunnerApiOptions::new(
				std::env::var("RESEARCH_API_URL").unwrap(),
				std::env::var("RUNNER_TOKEN").unwrap(),
				None,
				None,
			),
			Arc::new(TokioSleeper),
		)
		.unwrap();
		let mut claims = Vec::new();
		let mut beats = Vec::new();
		for _ in 0..40 {
			let started = std::time::Instant::now();
			let _ = api.claim(&empty_claim()).await;
			claims.push(started.elapsed());
			let started = std::time::Instant::now();
			let _ = api.heartbeat("run_none", 1).await;
			beats.push(started.elapsed());
		}
		for (name, mut samples) in [("claim", claims), ("heartbeat", beats)] {
			samples.sort();
			let ms = |index: usize| samples[index].as_secs_f64() * 1000.0;
			println!(
				"{name}: first {:.2} ms, median {:.2} ms, p90 {:.2} ms",
				ms(0).max(0.0),
				ms(samples.len() / 2),
				ms(samples.len() * 9 / 10)
			);
		}
	}
}
