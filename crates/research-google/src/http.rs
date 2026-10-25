//! Narrow Google HTTPS: one DNS answer, verified pinned TLS, no redirects, bounded bodies.
use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use research_net::{PinnedTls, ResolveError, ValidatedAddress};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
/// OAuth token and revocation host.
pub const GOOGLE_OAUTH_HOST: &str = "oauth2.googleapis.com";
/// Calendar host.
pub const GOOGLE_CALENDAR_HOST: &str = "www.googleapis.com";
/// Transport failure codes, never containing credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GoogleHttpErrorCode {
	/// Unpinned host or invalid path.
	HostNotAllowed,
	/// Failed/empty resolution.
	DnsFailed,
	/// Any address was nonpublic.
	UnsafeDestination,
	/// TCP/TLS/protocol failure.
	NetworkError,
	/// Caller abort or deadline.
	Timeout,
	/// Body exceeded one megabyte.
	ResponseTooLarge,
}
/// Log-safe transport error.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[error("{detail}")]
pub struct GoogleHttpError {
	/// Stable code.
	pub code: GoogleHttpErrorCode,
	/// Fixed or Node-compatible short detail.
	pub detail: String,
}
impl GoogleHttpError {
	fn new(code: GoogleHttpErrorCode, detail: &str) -> Self {
		Self {
			code,
			detail: detail.to_owned(),
		}
	}
}
/// A narrow Google request. Debug deliberately redacts path, headers and body.
pub struct GoogleHttpRequest<'a> {
	/// Exactly one of the two pinned hosts.
	pub host: &'a str,
	/// GET, POST, PUT or DELETE.
	pub method: &'a str,
	/// Path and query starting with slash.
	pub path: &'a str,
	/// Caller headers, after fixed host and user-agent.
	pub headers: &'a [(&'a str, &'a str)],
	/// Optional UTF-8 body.
	pub body: Option<&'a str>,
	/// Caller cancellation.
	pub cancel: &'a CancellationToken,
}
/// Complete response, including un-followed 3xx and error bodies.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleHttpResponse {
	/// HTTP status.
	pub status: u16,
	/// Location header.
	pub location: Option<String>,
	/// Content-Type header.
	pub content_type: Option<String>,
	/// UTF-8 replacement decoding with one BOM removed.
	pub text: String,
}
/// Injectable narrow HTTP port; scripted implementations never reach the real network.
#[async_trait]
pub trait GoogleHttp: Send + Sync {
	/// Sends one request without redirects or retries.
	async fn send(
		&self,
		request: GoogleHttpRequest<'_>,
	) -> Result<GoogleHttpResponse, GoogleHttpError>;
}
/// Production Google transport over research-net's verified connector.
pub struct PinnedGoogleHttp {
	tls: PinnedTls,
	/// TEST SEAM: resolve every pinned host to this address instead of DNS.
	#[cfg(test)]
	override_ip: Option<std::net::IpAddr>,
}
impl PinnedGoogleHttp {
	/// Configures verified production TLS. There is no production bypass for DNS or trust.
	pub fn new() -> Result<Self, research_net::tls::TlsSetupError> {
		Ok(Self {
			tls: PinnedTls::new()?,
			#[cfg(test)]
			override_ip: None,
		})
	}
	async fn resolve(&self, host: &str) -> Result<ValidatedAddress, GoogleHttpError> {
		#[cfg(test)]
		if let Some(ip) = self.override_ip {
			return Ok(ValidatedAddress::assume_validated(host, ip));
		}
		let addresses = research_net::resolve_public(host)
			.await
			.map_err(|e| match e {
				ResolveError::LookupFailed(code) => {
					GoogleHttpError::new(GoogleHttpErrorCode::DnsFailed, &code)
				}
				ResolveError::NoAddresses => GoogleHttpError::new(
					GoogleHttpErrorCode::DnsFailed,
					"DNS lookup returned no addresses",
				),
				ResolveError::NotPublic(_) => GoogleHttpError::new(
					GoogleHttpErrorCode::UnsafeDestination,
					"host resolves to a non-public address",
				),
			})?;
		addresses.into_iter().next().ok_or_else(|| {
			GoogleHttpError::new(
				GoogleHttpErrorCode::DnsFailed,
				"DNS lookup returned no addresses",
			)
		})
	}
	async fn exchange(
		&self,
		address: &ValidatedAddress,
		r: GoogleHttpRequest<'_>,
	) -> Result<GoogleHttpResponse, GoogleHttpError> {
		let not_sent =
			|| GoogleHttpError::new(GoogleHttpErrorCode::NetworkError, "REQUEST_NOT_SENT");
		// Node refuses controls, spaces and non-Latin-1 path characters synchronously.
		if !r.path.chars().all(|c| c > ' ' && c <= '\u{ff}')
			|| !matches!(r.method, "GET" | "POST" | "PUT" | "DELETE")
		{
			return Err(not_sent());
		}
		let mut builder = http::Request::builder().method(r.method).uri(r.path);
		let headers = builder.headers_mut().ok_or_else(not_sent)?;
		headers.insert("host", r.host.parse().map_err(|_| not_sent())?);
		headers.insert(
			"user-agent",
			http::HeaderValue::from_static("stock-investigation-runner/0.1"),
		);
		for (key, value) in r.headers {
			headers.insert(
				http::HeaderName::from_bytes(key.as_bytes()).map_err(|_| not_sent())?,
				value.parse().map_err(|_| not_sent())?,
			);
		}
		headers.insert("connection", http::HeaderValue::from_static("close"));
		if let Some(body) = r.body {
			headers.insert(
				"content-length",
				body.len().to_string().parse().map_err(|_| not_sent())?,
			);
		}
		let request = builder
			.body(Full::new(Bytes::copy_from_slice(
				r.body.unwrap_or("").as_bytes(),
			)))
			.map_err(|_| not_sent())?;
		let stream = self
			.tls
			.connect(address)
			.await
			.map_err(|e| GoogleHttpError::new(GoogleHttpErrorCode::NetworkError, &e.detail))?;
		let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
			.await
			.map_err(|e| network(&e))?;
		let driver = Driver(tokio::spawn(async move {
			let _ = connection.await;
		}));
		let response = sender
			.send_request(request)
			.await
			.map_err(|e| network(&e))?;
		let status = response.status().as_u16();
		let header = |name| {
			response.headers().get(name).map(|v| {
				v.as_bytes()
					.iter()
					.map(|b| char::from(*b))
					.collect::<String>()
			})
		};
		let location = header("location");
		let content_type = header("content-type");
		let mut body = response.into_body();
		let mut bytes = Vec::new();
		while let Some(frame) = body.frame().await {
			if let Ok(data) = frame.map_err(|e| network(&e))?.into_data() {
				if bytes.len().saturating_add(data.len()) > 1_000_000 {
					return Err(GoogleHttpError::new(
						GoogleHttpErrorCode::ResponseTooLarge,
						"response body exceeds the byte limit",
					));
				}
				bytes.extend_from_slice(&data);
			}
		}
		drop(driver);
		let text = String::from_utf8_lossy(&bytes);
		Ok(GoogleHttpResponse {
			status,
			location,
			content_type,
			text: text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned(),
		})
	}
}
fn network(error: &hyper::Error) -> GoogleHttpError {
	GoogleHttpError::new(
		GoogleHttpErrorCode::NetworkError,
		research_net::errors::hyper_error_code(error),
	)
}
struct Driver(tokio::task::JoinHandle<()>);
impl Drop for Driver {
	fn drop(&mut self) {
		self.0.abort();
	}
}
#[async_trait]
impl GoogleHttp for PinnedGoogleHttp {
	async fn send(&self, r: GoogleHttpRequest<'_>) -> Result<GoogleHttpResponse, GoogleHttpError> {
		if ![GOOGLE_OAUTH_HOST, GOOGLE_CALENDAR_HOST].contains(&r.host) {
			return Err(GoogleHttpError::new(
				GoogleHttpErrorCode::HostNotAllowed,
				"host is not a pinned Google host",
			));
		}
		if !r.path.starts_with('/') {
			return Err(GoogleHttpError::new(
				GoogleHttpErrorCode::HostNotAllowed,
				"request path must start with /",
			));
		}
		// The TS timeout begins after the single lookup, not before it.
		let address = self.resolve(r.host).await?;
		let cancel = r.cancel;
		tokio::select! {
			biased;
			() = cancel.cancelled() => Err(GoogleHttpError::new(GoogleHttpErrorCode::Timeout,"request was aborted")),
			result = tokio::time::timeout(std::time::Duration::from_secs(30),self.exchange(&address,r)) => result.unwrap_or_else(|_| Err(GoogleHttpError::new(GoogleHttpErrorCode::Timeout,"request timed out"))),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use research_net::PinnedTlsOverrides;
	use rustls::pki_types::pem::PemObject;
	use rustls::pki_types::{CertificateDer, PrivateKeyDer};
	use std::sync::{Arc, Mutex};
	use tokio::io::{AsyncReadExt, AsyncWriteExt};

	const CA_PEM: &str = include_str!("../tests/fixtures/ca.pem");
	const LEAF_PEM: &str = include_str!("../tests/fixtures/leaf.pem");
	const LEAF_KEY: &str = include_str!("../tests/fixtures/leaf.key");

	/// A local TLS server for `*.googleapis.com` names that answers every
	/// request with `reply` and records the raw request text.
	struct Server {
		port: u16,
		seen: Arc<Mutex<Vec<String>>>,
	}

	async fn serve(reply: Vec<u8>) -> Server {
		let certs: Vec<CertificateDer<'static>> =
			CertificateDer::pem_slice_iter(LEAF_PEM.as_bytes())
				.collect::<Result<_, _>>()
				.unwrap();
		let key = PrivateKeyDer::from_pem_slice(LEAF_KEY.as_bytes()).unwrap();
		let provider = Arc::new(rustls::crypto::ring::default_provider());
		let config = rustls::ServerConfig::builder_with_provider(provider)
			.with_safe_default_protocol_versions()
			.unwrap()
			.with_no_client_auth()
			.with_single_cert(certs, key)
			.unwrap();
		let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let port = listener.local_addr().unwrap().port();
		let seen = Arc::new(Mutex::new(Vec::new()));
		let record = seen.clone();
		tokio::spawn(async move {
			loop {
				let Ok((tcp, _)) = listener.accept().await else {
					return;
				};
				let acceptor = acceptor.clone();
				let reply = reply.clone();
				let record = record.clone();
				tokio::spawn(async move {
					let Ok(mut tls) = acceptor.accept(tcp).await else {
						return;
					};
					let mut request = Vec::new();
					let mut chunk = [0u8; 4096];
					loop {
						let Ok(n) = tls.read(&mut chunk).await else {
							return;
						};
						if n == 0 {
							return;
						}
						request.extend_from_slice(&chunk[..n]);
						let text = String::from_utf8_lossy(&request).into_owned();
						if let Some(head_end) = text.find("\r\n\r\n") {
							let length = text
								.lines()
								.find_map(|l| {
									l.to_ascii_lowercase()
										.strip_prefix("content-length: ")
										.map(str::to_owned)
								})
								.and_then(|v| v.trim().parse::<usize>().ok())
								.unwrap_or(0);
							if request.len() >= head_end + 4 + length {
								break;
							}
						}
					}
					record
						.lock()
						.unwrap()
						.push(String::from_utf8_lossy(&request).into_owned());
					let _ = tls.write_all(&reply).await;
					let _ = tls.shutdown().await;
				});
			}
		});
		Server { port, seen }
	}

	fn client(port: u16) -> PinnedGoogleHttp {
		PinnedGoogleHttp {
			tls: PinnedTls::with_overrides(&PinnedTlsOverrides {
				port: Some(port),
				extra_root_pem: Some(CA_PEM.to_owned()),
				dial_loopback: true,
			})
			.unwrap(),
			override_ip: Some("93.184.216.34".parse().unwrap()),
		}
	}

	fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
		let mut out = format!(
			"HTTP/1.1 {status}\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n",
			body.len()
		)
		.into_bytes();
		out.extend_from_slice(body);
		out
	}

	async fn post(
		http: &PinnedGoogleHttp,
		host: &str,
		path: &str,
		body: Option<&str>,
		cancel: &CancellationToken,
	) -> Result<GoogleHttpResponse, GoogleHttpError> {
		http.send(GoogleHttpRequest {
			host,
			method: "POST",
			path,
			headers: &[("content-type", "application/x-www-form-urlencoded")],
			body,
			cancel,
		})
		.await
	}

	#[tokio::test]
	async fn posts_a_form_through_verified_tls() {
		let server = serve(response(
			"200 OK",
			"content-type: application/json\r\n",
			br#"{"access_token":"at"}"#,
		))
		.await;
		let reply = post(
			&client(server.port),
			GOOGLE_OAUTH_HOST,
			"/token",
			Some("grant_type=refresh_token"),
			&CancellationToken::new(),
		)
		.await
		.unwrap();
		assert_eq!(reply.status, 200);
		assert!(reply.text.contains("access_token"));
		assert_eq!(reply.content_type.as_deref(), Some("application/json"));
		let seen = server.seen.lock().unwrap().clone();
		let request = seen.first().unwrap();
		assert!(request.starts_with("POST /token HTTP/1.1\r\n"));
		let lower = request.to_ascii_lowercase();
		assert!(lower.contains("host: oauth2.googleapis.com\r\n"));
		assert!(lower.contains("user-agent: stock-investigation-runner/0.1\r\n"));
		assert!(lower.contains("content-length: 24\r\n"));
		assert!(lower.contains("connection: close\r\n"));
		assert!(!lower.contains("accept-encoding"));
		assert!(request.ends_with("grant_type=refresh_token"));
	}

	#[tokio::test]
	async fn refuses_other_hosts_and_relative_paths_before_any_lookup() {
		// No override and no network: the refusal must come before resolution.
		let http = PinnedGoogleHttp::new().unwrap();
		let cancel = CancellationToken::new();
		let error = post(&http, "evil.example", "/x", None, &cancel)
			.await
			.unwrap_err();
		assert_eq!(error.code, GoogleHttpErrorCode::HostNotAllowed);
		assert_eq!(error.detail, "host is not a pinned Google host");
		let error = post(&http, GOOGLE_CALENDAR_HOST, "x", None, &cancel)
			.await
			.unwrap_err();
		assert_eq!(error.code, GoogleHttpErrorCode::HostNotAllowed);
		assert_eq!(error.detail, "request path must start with /");
	}

	#[tokio::test]
	async fn does_not_follow_redirects() {
		let server = serve(response(
			"302 Found",
			"location: https://oauth2.googleapis.com/elsewhere\r\n",
			b"",
		))
		.await;
		let reply = post(
			&client(server.port),
			GOOGLE_OAUTH_HOST,
			"/token",
			Some("a=b"),
			&CancellationToken::new(),
		)
		.await
		.unwrap();
		assert_eq!(reply.status, 302);
		assert_eq!(
			reply.location.as_deref(),
			Some("https://oauth2.googleapis.com/elsewhere")
		);
		assert_eq!(server.seen.lock().unwrap().len(), 1);
	}

	#[tokio::test]
	async fn caps_response_bodies_at_one_megabyte() {
		let big = serve(response("200 OK", "", &vec![b'x'; 1_000_001])).await;
		let error = post(
			&client(big.port),
			GOOGLE_OAUTH_HOST,
			"/token",
			None,
			&CancellationToken::new(),
		)
		.await
		.unwrap_err();
		assert_eq!(error.code, GoogleHttpErrorCode::ResponseTooLarge);
		let exact = serve(response("200 OK", "", &vec![b'x'; 1_000_000])).await;
		let reply = post(
			&client(exact.port),
			GOOGLE_OAUTH_HOST,
			"/token",
			None,
			&CancellationToken::new(),
		)
		.await
		.unwrap();
		assert_eq!(reply.text.len(), 1_000_000);
	}

	#[tokio::test]
	async fn decodes_text_like_text_decoder() {
		let server = serve(response("200 OK", "", b"\xef\xbb\xbf{\"a\":\"\xff\"}")).await;
		let reply = post(
			&client(server.port),
			GOOGLE_CALENDAR_HOST,
			"/x",
			None,
			&CancellationToken::new(),
		)
		.await
		.unwrap();
		assert_eq!(reply.text, "{\"a\":\"\u{fffd}\"}");
	}

	#[tokio::test]
	async fn verifies_the_certificate_against_the_host_name() {
		// The server certificate covers only the two Google names.
		let server = serve(response("200 OK", "", b"{}")).await;
		let http = client(server.port);
		let spoof = http
			.tls
			.connect(&ValidatedAddress::assume_validated(
				"evil.example",
				"93.184.216.34".parse().unwrap(),
			))
			.await;
		assert!(spoof.is_err());
	}

	#[tokio::test]
	async fn a_cancelled_request_times_out_as_aborted() {
		let cancel = CancellationToken::new();
		cancel.cancel();
		let server = serve(response("200 OK", "", b"{}")).await;
		let error = post(
			&client(server.port),
			GOOGLE_OAUTH_HOST,
			"/token",
			None,
			&cancel,
		)
		.await
		.unwrap_err();
		assert_eq!(error.code, GoogleHttpErrorCode::Timeout);
		assert_eq!(error.detail, "request was aborted");
	}

	#[tokio::test]
	async fn malformed_requests_are_never_sent() {
		let server = serve(response("200 OK", "", b"{}")).await;
		let error = post(
			&client(server.port),
			GOOGLE_OAUTH_HOST,
			"/a b",
			None,
			&CancellationToken::new(),
		)
		.await
		.unwrap_err();
		assert_eq!(error.code, GoogleHttpErrorCode::NetworkError);
		assert_eq!(error.detail, "REQUEST_NOT_SENT");
		assert!(server.seen.lock().unwrap().is_empty());
	}
}
