//! Fixed-host, DNS-pinned HTTPS for OpenRouter. Redirects are transport errors.
use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{StreamExt, stream::BoxStream};
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1::SendRequest;
use hyper_util::rt::TokioIo;
use research_net::{PinnedTls, ValidatedAddress, resolve_public};
use std::{
	collections::BTreeMap,
	sync::Arc,
	time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Public chat endpoint; no owner-controlled URL can receive the key.
pub const CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
/// Public catalog endpoint; never receives Authorization.
pub const MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
/// Exact outbound request; Debug deliberately omits headers and body.
#[derive(Clone, PartialEq, Eq, serde::Serialize)]
pub struct HttpRequest {
	/// GET or POST.
	pub method: String,
	/// One of the two fixed endpoint URLs.
	pub url: String,
	/// Explicit headers (no proxy, cookies or inherited credentials).
	pub headers: BTreeMap<String, String>,
	/// JS-exact JSON text.
	pub body: String,
}
/// Streamed response; dropping its body closes an incomplete connection.
pub struct HttpResponse {
	/// HTTP status.
	pub status: u16,
	/// Lowercase response header names.
	pub headers: BTreeMap<String, String>,
	/// None when the server supplied no readable body.
	pub body: Option<BoxStream<'static, Result<Vec<u8>, TransportError>>>,
}
/// Fixed transport code without credential-bearing error text.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{0}")]
pub struct TransportError(pub &'static str);
/// HTTPS boundary. Scripted implementations belong in tests/testkit.
#[async_trait]
pub trait HttpClient: Send + Sync {
	/// Cancellation drops headers/body work; redirects must return an error.
	async fn send(
		&self,
		request: HttpRequest,
		cancel: CancellationToken,
	) -> Result<HttpResponse, TransportError>;
}
struct Pooled {
	sender: SendRequest<Full<Bytes>>,
	address: ValidatedAddress,
	since: Instant,
}
/// HTTP/1.1 reuse with a freshly validated DNS answer on every request (SEC-002).
#[derive(Clone)]
pub struct OpenRouterHttpClient {
	tls: PinnedTls,
	pool: Arc<Mutex<Option<Pooled>>>,
}
impl OpenRouterHttpClient {
	/// Uses research-net's verified TLS and public-address validation.
	pub fn new() -> Result<Self, research_net::tls::TlsSetupError> {
		Ok(Self {
			tls: PinnedTls::new()?,
			pool: Arc::new(Mutex::new(None)),
		})
	}
	async fn exchange(
		&self,
		request: HttpRequest,
		cancel: CancellationToken,
	) -> Result<HttpResponse, TransportError> {
		let path = match request.url.as_str() {
			CHAT_URL => "/api/v1/chat/completions",
			MODELS_URL => "/api/v1/models",
			_ => return Err(TransportError("HOST_REFUSED")),
		};
		let addresses = resolve_public("openrouter.ai")
			.await
			.map_err(|_| TransportError("DNS_FAILED"))?;
		let candidate = self.pool.lock().await.take();
		let mut connection = if let Some(pooled) = candidate.filter(|p| {
			p.since.elapsed() < Duration::from_secs(90)
				&& addresses.contains(&p.address)
				&& !p.sender.is_closed()
		}) {
			pooled
		} else {
			let mut connected = None;
			for address in addresses {
				if let Ok(socket) = self.tls.connect(&address).await {
					let (sender, connection) =
						hyper::client::conn::http1::handshake(TokioIo::new(socket))
							.await
							.map_err(|_| TransportError("HTTP_HANDSHAKE_FAILED"))?;
					// Hyper's connection future owns the socket; it ends when sender/body drop.
					tokio::spawn(async move {
						let _ = connection.await;
					});
					connected = Some(Pooled {
						sender,
						address,
						since: Instant::now(),
					});
					break;
				}
			}
			connected.ok_or(TransportError("CONNECT_FAILED"))?
		};
		let mut builder = hyper::Request::builder()
			.method(request.method.as_str())
			.uri(path)
			.header("host", "openrouter.ai");
		for (key, value) in request.headers {
			builder = builder.header(key, value);
		}
		let request = builder
			.body(Full::new(Bytes::from(request.body)))
			.map_err(|_| TransportError("REQUEST_INVALID"))?;
		let response = connection
			.sender
			.send_request(request)
			.await
			.map_err(|_| TransportError("HTTP_FAILED"))?;
		let status = response.status().as_u16();
		if (300..400).contains(&status) {
			return Err(TransportError("REDIRECT_REFUSED"));
		}
		let headers = response
			.headers()
			.iter()
			.filter_map(|(k, v)| {
				v.to_str()
					.ok()
					.map(|v| (k.as_str().to_owned(), v.to_owned()))
			})
			.collect();
		let pool = self.pool.clone();
		let body = response.into_body();
		let stream=futures_util::stream::unfold((body,Some(connection),pool,cancel,status),|(mut body,mut connection,pool,cancel,status)| async move {
            loop {
                let frame=tokio::select! { biased;_=cancel.cancelled()=>return None,frame=body.frame()=>frame };
                match frame {
                    None=>{
                        if (200..300).contains(&status) { if let Some(mut connection)=connection.take() { connection.since=Instant::now();*pool.lock().await=Some(connection); } }
                        return None;
                    },
                    Some(Err(_))=>return Some((Err(TransportError("BODY_FAILED")),(body,None,pool,cancel,status))),
                    Some(Ok(frame))=>if let Ok(data)=frame.into_data() { return Some((Ok(data.to_vec()),(body,connection,pool,cancel,status))); },
                }
            }
        }).boxed();
		Ok(HttpResponse {
			status,
			headers,
			body: Some(stream),
		})
	}
}
#[async_trait]
impl HttpClient for OpenRouterHttpClient {
	async fn send(
		&self,
		request: HttpRequest,
		cancel: CancellationToken,
	) -> Result<HttpResponse, TransportError> {
		tokio::select! { biased;_=cancel.cancelled()=>Err(TransportError("ABORTED")),result=self.exchange(request,cancel.clone())=>result }
	}
}
