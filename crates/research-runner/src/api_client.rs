//! HTTPS client for the runner endpoints (port of `apps/runner/src/apiClient.ts`,
//! shell-wire spec section 2; API-007): every call has a timeout, a bounded
//! number of attempts with exponential backoff, and its response is
//! validated against the shared contract. Only transport failures, 429 and
//! 5xx (and CONFLICT) are retried; all runner endpoints are idempotent, so a
//! retry is safe.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
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
use tokio::net::TcpStream;
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

/// A response that arrived: status and body bytes (3xx never gets here).
struct RawResponse {
	status: u16,
	body: Bytes,
}

/// A failure before a usable response (all `TRANSPORT_ERROR`).
struct TransportFailure(&'static str);

/// The production [`RunnerApi`].
pub struct HttpRunnerApi {
	base: Url,
	headers: Vec<(&'static str, String)>,
	tls: TlsConnector,
	sleeper: Arc<dyn Sleeper>,
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
		Ok(Self {
			base,
			headers,
			tls: tls_connector()?,
			sleeper,
			timeout: options.request_timeout,
			max_attempts: options.max_attempts,
		})
	}

	/// One request on a fresh connection, bounded by the attempt timeout.
	async fn exchange(&self, path: &str, body: &str) -> Result<RawResponse, TransportFailure> {
		// The leading `/` replaces any path of the configured URL.
		let url = self
			.base
			.join(&format!("{RUNNER_API_PREFIX}{path}"))
			.map_err(|_| TransportFailure("TypeError"))?;
		tokio::time::timeout(self.timeout, self.exchange_untimed(&url, body))
			.await
			.unwrap_or(Err(TransportFailure("TimeoutError")))
	}

	async fn exchange_untimed(
		&self,
		url: &Url,
		body: &str,
	) -> Result<RawResponse, TransportFailure> {
		let fail = |name| TransportFailure(name);
		let port = url
			.port_or_known_default()
			.ok_or_else(|| fail("TypeError"))?;
		let host = url.host().ok_or_else(|| fail("TypeError"))?;
		// No proxy is ever consulted: the bearer token must not be routed
		// through an inherited proxy variable.
		let tcp = match &host {
			Host::Domain(domain) => TcpStream::connect((&**domain, port)).await,
			Host::Ipv4(address) => TcpStream::connect((*address, port)).await,
			Host::Ipv6(address) => TcpStream::connect((*address, port)).await,
		}
		.map_err(|_| fail("ConnectError"))?;
		// Small requests go out at once.
		let _ = tcp.set_nodelay(true);
		let authority = match url.port() {
			Some(explicit) => format!("{}:{explicit}", url.host_str().unwrap_or_default()),
			None => url.host_str().unwrap_or_default().to_owned(),
		};
		let mut request = Request::builder()
			.method("POST")
			.uri(format!(
				"{}{}",
				url.path(),
				url.query()
					.map_or(String::new(), |query| format!("?{query}"))
			))
			.header(HOST, authority)
			// One request per connection: nothing idles on the owner's network.
			.header(CONNECTION, "close");
		for (name, value) in &self.headers {
			request = request.header(*name, value);
		}
		let request = request
			.body(Full::new(Bytes::copy_from_slice(body.as_bytes())))
			.map_err(|_| fail("TypeError"))?;
		let response = if url.scheme() == "https" {
			let name = match &host {
				Host::Domain(domain) => ServerName::try_from(domain.to_string()),
				Host::Ipv4(address) => Ok(ServerName::from(std::net::IpAddr::V4(*address))),
				Host::Ipv6(address) => Ok(ServerName::from(std::net::IpAddr::V6(*address))),
			}
			.map_err(|_| fail("TypeError"))?;
			let stream = self
				.tls
				.connect(name, tcp)
				.await
				.map_err(|_| fail("TlsError"))?;
			send(TokioIo::new(stream), request).await?
		} else {
			send(TokioIo::new(tcp), request).await?
		};
		Ok(response)
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
		classify::<T>(raw.status, &raw.body)
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
			// Not interruptible by shutdown, like the TypeScript client.
			self.sleeper
				.sleep(BACKOFF_START_MS << (tries - 1), None)
				.await;
			result = self.attempt::<T>(path, &text).await;
			tries += 1;
		}
		result
	}
}

/// Sends the request over an established stream and reads the whole body.
async fn send<S>(
	io: TokioIo<S>,
	request: Request<Full<Bytes>>,
) -> Result<RawResponse, TransportFailure>
where
	S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
	let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
		.await
		.map_err(|_| TransportFailure("HandshakeError"))?;
	let driver = tokio::spawn(async move {
		let _ = connection.await;
	});
	let outcome = async {
		let response = sender
			.send_request(request)
			.await
			.map_err(|_| TransportFailure("RequestError"))?;
		let status = response.status();
		// `redirect: "error"`: a 3xx makes the request fail before any body is read.
		if status.is_redirection() {
			return Err(TransportFailure("RedirectError"));
		}
		let mut body = response.into_body();
		let mut bytes = Vec::new();
		while let Some(frame) = body.frame().await {
			let frame = frame.map_err(|_| TransportFailure("BodyError"))?;
			if let Ok(data) = frame.into_data() {
				if bytes.len().saturating_add(data.len()) > MAX_RESPONSE_BYTES {
					return Err(TransportFailure("BodyTooLarge"));
				}
				bytes.extend_from_slice(&data);
			}
		}
		Ok(RawResponse {
			status: status.as_u16(),
			body: Bytes::from(bytes),
		})
	}
	.await;
	driver.abort();
	outcome
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
fn heartbeat_request(lease_generation: u64) -> HeartbeatRequest {
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
	use tokio::io::{AsyncReadExt, AsyncWriteExt};
	use tokio::net::TcpListener;
	use tokio_util::sync::CancellationToken;

	use super::*;

	/// What the fake Worker saw.
	#[derive(Clone, Debug)]
	struct Recorded {
		path: String,
		headers: Vec<(String, String)>,
		body: String,
	}

	impl Recorded {
		fn header(&self, name: &str) -> Option<&str> {
			self.headers
				.iter()
				.find(|(key, _)| key == name)
				.map(|(_, value)| value.as_str())
		}
	}

	#[derive(Clone)]
	enum Reply {
		Json(u16, String),
		Redirect(String),
		Raw(u16, String),
		Hang,
	}

	fn json(status: u16, payload: &str) -> Reply {
		Reply::Json(status, payload.to_owned())
	}

	struct FakeWorker {
		url: String,
		seen: Arc<Mutex<Vec<Recorded>>>,
	}

	impl FakeWorker {
		fn requests(&self) -> Vec<Recorded> {
			self.seen.lock().unwrap().clone()
		}
	}

	/// Serves the scripted replies in order (the last one repeats), one request per connection.
	async fn serve(script: Vec<Reply>) -> FakeWorker {
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let url = format!("http://{}", listener.local_addr().unwrap());
		let seen = Arc::new(Mutex::new(Vec::<Recorded>::new()));
		let record = Arc::clone(&seen);
		tokio::spawn(async move {
			loop {
				let Ok((mut stream, _)) = listener.accept().await else {
					return;
				};
				let mut buffer = Vec::new();
				let mut chunk = [0_u8; 4096];
				let (head_end, length) = loop {
					let read = stream.read(&mut chunk).await.unwrap_or(0);
					if read == 0 {
						break (0, 0);
					}
					buffer.extend_from_slice(&chunk[..read]);
					let text = String::from_utf8_lossy(&buffer).into_owned();
					if let Some(end) = text.find("\r\n\r\n") {
						let length = text[..end]
							.lines()
							.find_map(|line| {
								line.to_ascii_lowercase()
									.strip_prefix("content-length:")
									.and_then(|value| value.trim().parse::<usize>().ok())
							})
							.unwrap_or(0);
						break (end + 4, length);
					}
				};
				if head_end == 0 {
					continue;
				}
				while buffer.len() < head_end + length {
					let read = stream.read(&mut chunk).await.unwrap_or(0);
					if read == 0 {
						break;
					}
					buffer.extend_from_slice(&chunk[..read]);
				}
				let text = String::from_utf8_lossy(&buffer).into_owned();
				let mut lines = text[..head_end].lines();
				let request_line = lines.next().unwrap_or_default().to_owned();
				let headers = lines
					.filter_map(|line| line.split_once(':'))
					.map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
					.collect();
				let index = {
					let mut seen = record.lock().unwrap();
					seen.push(Recorded {
						path: request_line
							.split(' ')
							.nth(1)
							.unwrap_or_default()
							.to_owned(),
						headers,
						body: text[head_end..].to_owned(),
					});
					seen.len() - 1
				};
				let reply = script
					.get(index)
					.or_else(|| script.last())
					.cloned()
					.unwrap_or(Reply::Hang);
				let response = match reply {
					Reply::Json(status, body) => format!(
						"HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
						body.len()
					),
					Reply::Raw(status, body) => format!(
						"HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
						body.len()
					),
					Reply::Redirect(location) => format!(
						"HTTP/1.1 302 Found\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
					),
					Reply::Hang => {
						// Keep the socket open and silent until the client gives up.
						tokio::spawn(async move {
							let mut sink = [0_u8; 64];
							while stream.read(&mut sink).await.unwrap_or(0) > 0 {}
						});
						continue;
					}
				};
				let _ = stream.write_all(response.as_bytes()).await;
				let _ = stream.shutdown().await;
			}
		});
		FakeWorker { url, seen }
	}

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
}
