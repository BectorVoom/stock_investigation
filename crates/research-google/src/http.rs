//! Narrow Google HTTPS: one DNS answer, verified pinned TLS, no redirects, bounded bodies.
use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt,Full};
use hyper_util::rt::TokioIo;
use research_net::{PinnedTls,ValidatedAddress,ResolveError};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
/// OAuth token and revocation host.
pub const GOOGLE_OAUTH_HOST: &str = "oauth2.googleapis.com";
/// Calendar host.
pub const GOOGLE_CALENDAR_HOST: &str = "www.googleapis.com";
/// Transport failure codes, never containing credentials.
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize)]
#[serde(rename_all="SCREAMING_SNAKE_CASE")]
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
#[derive(Clone,Debug,Serialize,thiserror::Error)]
#[error("{detail}")]
pub struct GoogleHttpError {
	/// Stable code.
	pub code: GoogleHttpErrorCode,
	/// Fixed or Node-compatible short detail.
	pub detail: String,
}
impl GoogleHttpError {
	fn new(code: GoogleHttpErrorCode,detail: &str) -> Self { Self { code,detail: detail.to_owned() } }
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
	pub headers: &'a [(&'a str,&'a str)],
	/// Optional UTF-8 body.
	pub body: Option<&'a str>,
	/// Caller cancellation.
	pub cancel: &'a CancellationToken,
}
/// Complete response, including un-followed 3xx and error bodies.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
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
	async fn send(&self,request: GoogleHttpRequest<'_>) -> Result<GoogleHttpResponse,GoogleHttpError>;
}
/// Production Google transport over research-net's verified connector.
pub struct PinnedGoogleHttp {
	tls: PinnedTls,
	#[cfg(test)]
	address: Option<ValidatedAddress>,
}
impl PinnedGoogleHttp {
	/// Configures verified production TLS. There is no production bypass for DNS or trust.
	pub fn new() -> Result<Self,research_net::tls::TlsSetupError> { Ok(Self { tls: PinnedTls::new()?,#[cfg(test)] address: None }) }
	async fn resolve(&self,host: &str) -> Result<ValidatedAddress,GoogleHttpError> {
		#[cfg(test)]
		if let Some(address) = &self.address { return Ok(address.clone()); }
		let addresses = research_net::resolve_public(host).await.map_err(|e| match e {
			ResolveError::LookupFailed(code) => GoogleHttpError::new(GoogleHttpErrorCode::DnsFailed,&code),
			ResolveError::NoAddresses => GoogleHttpError::new(GoogleHttpErrorCode::DnsFailed,"DNS lookup returned no addresses"),
			ResolveError::NotPublic(_) => GoogleHttpError::new(GoogleHttpErrorCode::UnsafeDestination,"host resolves to a non-public address"),
		})?;
		addresses.into_iter().next().ok_or_else(|| GoogleHttpError::new(GoogleHttpErrorCode::DnsFailed,"DNS lookup returned no addresses"))
	}
	async fn exchange(&self,address: &ValidatedAddress,r: GoogleHttpRequest<'_>) -> Result<GoogleHttpResponse,GoogleHttpError> {
		let not_sent = || GoogleHttpError::new(GoogleHttpErrorCode::NetworkError,"REQUEST_NOT_SENT");
		// Node refuses controls, spaces and non-Latin-1 path characters synchronously.
		if !r.path.chars().all(|c| c>' ' && c<='\u{ff}') || !matches!(r.method,"GET"|"POST"|"PUT"|"DELETE") { return Err(not_sent()); }
		let mut builder = http::Request::builder().method(r.method).uri(r.path);
		let headers = builder.headers_mut().ok_or_else(not_sent)?;
		headers.insert("host",r.host.parse().map_err(|_| not_sent())?);
		headers.insert("user-agent",http::HeaderValue::from_static("stock-investigation-runner/0.1"));
		for (key,value) in r.headers { headers.insert(http::HeaderName::from_bytes(key.as_bytes()).map_err(|_| not_sent())?,value.parse().map_err(|_| not_sent())?); }
		headers.insert("connection",http::HeaderValue::from_static("close"));
		if let Some(body) = r.body { headers.insert("content-length",body.len().to_string().parse().map_err(|_| not_sent())?); }
		let request = builder.body(Full::new(Bytes::copy_from_slice(r.body.unwrap_or("").as_bytes()))).map_err(|_| not_sent())?;
		let stream = self.tls.connect(address).await.map_err(|e| GoogleHttpError::new(GoogleHttpErrorCode::NetworkError,&e.0))?;
		let (mut sender,connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| network(&e))?;
		let driver = Driver(tokio::spawn(async move { let _ = connection.await; }));
		let response = sender.send_request(request).await.map_err(|e| network(&e))?;
		let status = response.status().as_u16();
		let header = |name| response.headers().get(name).map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect::<String>());
		let location = header("location"); let content_type = header("content-type");
		let mut body = response.into_body(); let mut bytes = Vec::new();
		while let Some(frame) = body.frame().await {
			if let Ok(data) = frame.map_err(|e| network(&e))?.into_data() {
				if bytes.len().saturating_add(data.len())>1_000_000 { return Err(GoogleHttpError::new(GoogleHttpErrorCode::ResponseTooLarge,"response body exceeds the byte limit")); }
				bytes.extend_from_slice(&data);
			}
		}
		drop(driver);
		let text = String::from_utf8_lossy(&bytes);
		Ok(GoogleHttpResponse { status,location,content_type,text: text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned() })
	}
}
fn network(error: &hyper::Error) -> GoogleHttpError { GoogleHttpError::new(GoogleHttpErrorCode::NetworkError,research_net::errors::hyper_error_code(error)) }
struct Driver(tokio::task::JoinHandle<()>);
impl Drop for Driver { fn drop(&mut self) { self.0.abort(); } }
#[async_trait]
impl GoogleHttp for PinnedGoogleHttp {
	async fn send(&self,r: GoogleHttpRequest<'_>) -> Result<GoogleHttpResponse,GoogleHttpError> {
		if ![GOOGLE_OAUTH_HOST,GOOGLE_CALENDAR_HOST].contains(&r.host) { return Err(GoogleHttpError::new(GoogleHttpErrorCode::HostNotAllowed,"host is not a pinned Google host")); }
		if !r.path.starts_with('/') { return Err(GoogleHttpError::new(GoogleHttpErrorCode::HostNotAllowed,"request path must start with /")); }
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
