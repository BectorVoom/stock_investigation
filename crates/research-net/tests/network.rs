//! The production fetcher against a local TLS server: the behaviours of
//! `nodeSafeFetcher.test.ts` and `pinnedConnect.test.ts`, plus the
//! connection-reuse rules of ADR-0030 C1 (reuse, host-name keying, DNS
//! rebinding, closing after a cap breach / abort / error, idle timeout, caps).
//!
//! Certificates: `tests/fixtures/` holds a TEST-ONLY root (its private key
//! was discarded after signing) and a leaf for `*.synthetic-wire.org` test
//! names, valid until 2126, plus an expired copy of the leaf. Regenerate with
//! the `openssl` commands in `fixtures/ca.cnf` / `fixtures/leaf.cnf`.
//!
//! The DNS answers are scripted public addresses; the connector dials
//! 127.0.0.1 instead (the TypeScript's `loopbackConnect`), while every check,
//! log and pool key still sees the validated address.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::io::Write as _;
use std::net::IpAddr;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use research_application::ports::{
	SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use research_net::dns::LookupError;
use research_net::pool::PoolLimits;
use research_net::{
	ConnectError, DEFAULT_USER_AGENT, DnsLookup, NodeSafeFetcher, NodeSafeFetcherOverrides,
	PinnedConnect, PinnedHttpsConnect, PinnedRequest, PinnedResponse, PinnedTls,
	PinnedTlsOverrides, create_node_safe_fetcher_with,
};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const HOST_A: &str = "a.synthetic-wire.org";
const HOST_B: &str = "b.synthetic-wire.org";
const PUBLIC_V4: &str = "93.184.216.34";
const PUBLIC_V4_B: &str = "151.101.1.69";
const PUBLIC_V6: &str = "2606:2800:220:1:248:1893:25c8:1946";

const CA_PEM: &str = include_str!("fixtures/ca.pem");
const LEAF_PEM: &str = include_str!("fixtures/leaf.pem");
const LEAF_KEY: &str = include_str!("fixtures/leaf.key");
const EXPIRED_PEM: &str = include_str!("fixtures/expired.pem");

/// `brotliCompressSync('{"text":"brotli 応答"}')` from Node.
const BROTLI_JSON: &[u8] = &[
	0x8b, 0x0b, 0x80, 0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0x62, 0x72, 0x6f, 0x74,
	0x6c, 0x69, 0x20, 0xe5, 0xbf, 0x9c, 0xe7, 0xad, 0x94, 0x22, 0x7d, 0x03,
];

fn ip(text: &str) -> IpAddr {
	text.parse().unwrap()
}

/* ---------- local TLS server ---------- */

#[derive(Clone, Debug)]
struct SeenRequest {
	server_name: Option<String>,
	path: String,
	headers: Vec<(String, String)>,
}

impl SeenRequest {
	fn header(&self, name: &str) -> Option<&str> {
		self.headers
			.iter()
			.find(|(key, _)| key == name)
			.map(|(_, value)| value.as_str())
	}
}

#[derive(Default)]
struct ServerState {
	accepted: AtomicUsize,
	closed: AtomicUsize,
	requests: Mutex<Vec<SeenRequest>>,
	/// Bytes written to the endless-gzip client when it hung up; -1 = still open.
	endless_closed_after: AtomicI64,
}

struct Server {
	port: u16,
	state: Arc<ServerState>,
	task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
	fn drop(&mut self) {
		self.task.abort();
	}
}

impl Server {
	fn requests(&self) -> Vec<SeenRequest> {
		self.state.requests.lock().unwrap().clone()
	}

	fn accepted(&self) -> usize {
		self.state.accepted.load(Ordering::SeqCst)
	}

	fn closed(&self) -> usize {
		self.state.closed.load(Ordering::SeqCst)
	}

	/// Waits until the server has seen `count` connections end.
	async fn wait_closed(&self, count: usize) {
		let started = Instant::now();
		while self.closed() < count {
			assert!(
				started.elapsed() < Duration::from_secs(5),
				"server saw {} closes",
				self.closed()
			);
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	}
}

fn gzip(data: &[u8]) -> Vec<u8> {
	let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
	encoder.write_all(data).unwrap();
	encoder.finish().unwrap()
}

async fn start_server(certificate_pem: &'static str) -> Server {
	let chain = vec![CertificateDer::from_pem_slice(certificate_pem.as_bytes()).unwrap()];
	let key = PrivateKeyDer::from_pem_slice(LEAF_KEY.as_bytes()).unwrap();
	let config = rustls::ServerConfig::builder_with_provider(Arc::new(
		rustls::crypto::ring::default_provider(),
	))
	.with_safe_default_protocol_versions()
	.unwrap()
	.with_no_client_auth()
	.with_single_cert(chain, key)
	.unwrap();
	let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
	let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let port = listener.local_addr().unwrap().port();
	let state = Arc::new(ServerState {
		endless_closed_after: AtomicI64::new(-1),
		..ServerState::default()
	});
	let shared = Arc::clone(&state);
	let task = tokio::spawn(async move {
		loop {
			let Ok((tcp, _)) = listener.accept().await else {
				return;
			};
			let connection = shared.accepted.fetch_add(1, Ordering::SeqCst) + 1;
			let acceptor = acceptor.clone();
			let state = Arc::clone(&shared);
			tokio::spawn(async move {
				if let Ok(tls) = acceptor.accept(tcp).await {
					serve(tls, connection, &state).await;
				}
				state.closed.fetch_add(1, Ordering::SeqCst);
			});
		}
	});
	Server { port, state, task }
}

type Tls = tokio_rustls::server::TlsStream<tokio::net::TcpStream>;

/// Reads one request head; `None` when the client closed.
async fn read_head(stream: &mut Tls, buffer: &mut Vec<u8>) -> Option<String> {
	loop {
		if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
			let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
			buffer.drain(..end + 4);
			return Some(head);
		}
		let mut chunk = [0u8; 4096];
		match stream.read(&mut chunk).await {
			Ok(0) | Err(_) => return None,
			Ok(read) => buffer.extend_from_slice(&chunk[..read]),
		}
	}
}

/// Waits for the client to hang up (it never sends more on a stalled response).
async fn until_client_closes(stream: &mut Tls) {
	let mut sink = [0u8; 1024];
	while matches!(stream.read(&mut sink).await, Ok(read) if read > 0) {}
}

async fn respond(
	stream: &mut Tls,
	status: &str,
	headers: &[(&str, String)],
	body: &[u8],
) -> std::io::Result<()> {
	let mut head = format!("HTTP/1.1 {status}\r\n");
	for (name, value) in headers {
		head.push_str(&format!("{name}: {value}\r\n"));
	}
	let chunked = headers.iter().any(|(name, _)| *name == "transfer-encoding");
	if !chunked && !headers.iter().any(|(name, _)| *name == "content-length") {
		head.push_str(&format!("content-length: {}\r\n", body.len()));
	}
	head.push_str("\r\n");
	stream.write_all(head.as_bytes()).await?;
	if chunked {
		// What Node's `writeHead(…)` + `end(body)` sends: one chunk, then the end.
		write_chunk(stream, body).await?;
		return write_chunk(stream, b"").await;
	}
	stream.write_all(body).await?;
	stream.flush().await
}

async fn write_chunk(stream: &mut Tls, data: &[u8]) -> std::io::Result<()> {
	stream
		.write_all(format!("{:x}\r\n", data.len()).as_bytes())
		.await?;
	stream.write_all(data).await?;
	stream.write_all(b"\r\n").await?;
	stream.flush().await
}

async fn serve(mut stream: Tls, connection: usize, state: &ServerState) {
	let server_name = stream.get_ref().1.server_name().map(str::to_owned);
	let mut buffer = Vec::new();
	let mut served = 0usize;
	while let Some(head) = read_head(&mut stream, &mut buffer).await {
		served += 1;
		let mut lines = head.split("\r\n");
		let path = lines
			.next()
			.unwrap_or("")
			.split(' ')
			.nth(1)
			.unwrap_or("/")
			.to_owned();
		let headers: Vec<(String, String)> = lines
			.filter_map(|line| line.split_once(':'))
			.map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
			.collect();
		let request = SeenRequest {
			server_name: server_name.clone(),
			path: path.clone(),
			headers,
		};
		state.requests.lock().unwrap().push(request.clone());
		let host = request.header("host").unwrap_or("").to_owned();
		let text = |value: &str| vec![("content-type", value.to_owned())];
		let result = match path.as_str() {
			"/hello" => {
				let body = format!(
					"hello from {host}; ua={}; cookie={}",
					request.header("user-agent").unwrap_or(""),
					request.header("cookie").unwrap_or("none")
				);
				respond(
					&mut stream,
					"200 OK",
					&text("text/plain; charset=utf-8"),
					body.as_bytes(),
				)
				.await
			}
			"/conn" => {
				let body = format!("connection {connection} request {served}");
				respond(&mut stream, "200 OK", &text("text/plain"), body.as_bytes()).await
			}
			"/conn-slow" => {
				tokio::time::sleep(Duration::from_millis(150)).await;
				let body = format!("connection {connection}");
				respond(&mut stream, "200 OK", &text("text/plain"), body.as_bytes()).await
			}
			"/echo?x=1" => respond(&mut stream, "200 OK", &text("text/plain"), b"hello").await,
			"/to-b" => {
				let location = vec![("location", format!("https://{HOST_B}/hello"))];
				respond(&mut stream, "302 Found", &location, b"").await
			}
			"/relative" => {
				respond(
					&mut stream,
					"301 Moved",
					&[("location", "hello".to_owned())],
					b"",
				)
				.await
			}
			"/to-loopback-literal" => {
				let location = vec![("location", "https://127.0.0.1/admin".to_owned())];
				respond(&mut stream, "302 Found", &location, b"").await
			}
			"/to-http" => {
				let location = vec![("location", format!("http://{HOST_A}/hello"))];
				respond(&mut stream, "302 Found", &location, b"").await
			}
			"/declared-big" => respond(&mut stream, "200 OK", &[], &vec![b'x'; 50_000]).await,
			"/chunked-big" => {
				let mut outcome = stream
					.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n")
					.await;
				for _ in 0..200 {
					if outcome.is_err() {
						break;
					}
					outcome = write_chunk(&mut stream, &[b'y'; 1_000]).await;
					tokio::time::sleep(Duration::from_millis(1)).await;
				}
				if outcome.is_ok() {
					outcome = write_chunk(&mut stream, b"").await;
				}
				outcome
			}
			"/gzip-bomb" => {
				let headers = vec![("content-encoding", "gzip".to_owned())];
				respond(
					&mut stream,
					"200 OK",
					&headers,
					&gzip(&vec![0u8; 5_000_000]),
				)
				.await
			}
			"/gzip-empty-members" | "/gzip-empty-members-small" => {
				let members = if path.ends_with("small") { 500 } else { 5_001 };
				let body: Vec<u8> = (0..members).flat_map(|_| gzip(b"")).collect();
				let headers = vec![
					("content-encoding", "gzip".to_owned()),
					("transfer-encoding", "chunked".to_owned()),
				];
				respond(&mut stream, "200 OK", &headers, &body).await
			}
			"/gzip-endless-empty-members" => {
				let head = "HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ntransfer-encoding: chunked\r\n\r\n";
				let mut written = head.len();
				let member = gzip(b"");
				let mut outcome = stream.write_all(head.as_bytes()).await;
				while outcome.is_ok() {
					outcome = write_chunk(&mut stream, &member).await;
					if outcome.is_ok() {
						written += member.len();
						tokio::time::sleep(Duration::from_millis(1)).await;
					}
				}
				state
					.endless_closed_after
					.store(i64::try_from(written).unwrap(), Ordering::SeqCst);
				outcome
			}
			"/gzip" => {
				let headers = vec![
					("content-encoding", "gzip".to_owned()),
					("content-type", "application/json".to_owned()),
				];
				let body = gzip("{\"text\":\"圧縮された応答\"}".as_bytes());
				respond(&mut stream, "200 OK", &headers, &body).await
			}
			"/gzip-corrupt" => {
				let headers = vec![("content-encoding", "gzip".to_owned())];
				respond(&mut stream, "200 OK", &headers, b"not gzip at all").await
			}
			"/br" => {
				let headers = vec![("content-encoding", "br".to_owned())];
				respond(&mut stream, "200 OK", &headers, BROTLI_JSON).await
			}
			"/deflate" => {
				let mut encoder =
					flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
				encoder.write_all(b"deflated body").unwrap();
				let headers = vec![("content-encoding", "deflate".to_owned())];
				respond(&mut stream, "200 OK", &headers, &encoder.finish().unwrap()).await
			}
			"/weird-encoding" => {
				let headers = vec![("content-encoding", "zstd".to_owned())];
				respond(&mut stream, "200 OK", &headers, b"opaque").await
			}
			"/missing" => {
				let headers = vec![("content-encoding", "zstd".to_owned())];
				respond(&mut stream, "404 Not Found", &headers, b"not found page").await
			}
			"/close" => {
				let headers = vec![("connection", "close".to_owned())];
				let _ = respond(&mut stream, "200 OK", &headers, b"bye").await;
				return;
			}
			"/then-drop" => {
				// Keep-alive response, then the server drops the idle connection.
				let _ = respond(&mut stream, "200 OK", &text("text/plain"), b"once").await;
				tokio::time::sleep(Duration::from_millis(50)).await;
				return;
			}
			"/slow" => {
				let head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n";
				let _ = stream.write_all(head.as_bytes()).await;
				let _ = write_chunk(&mut stream, b"first part").await;
				// Never ends: the client must give up on its own.
				until_client_closes(&mut stream).await;
				return;
			}
			"/never" => {
				until_client_closes(&mut stream).await;
				return;
			}
			"/gone" => respond(&mut stream, "410 Gone", &[], b"gone").await,
			_ => respond(&mut stream, "404 Not Found", &[], b"not found").await,
		};
		if result.is_err() {
			return;
		}
	}
}

/* ---------- fetcher wiring ---------- */

struct ScriptedDns {
	answers: Mutex<HashMap<String, Vec<IpAddr>>>,
	lookups: Mutex<Vec<String>>,
}

#[async_trait]
impl DnsLookup for ScriptedDns {
	async fn lookup(&self, hostname: &str) -> Result<Vec<IpAddr>, LookupError> {
		self.lookups.lock().unwrap().push(hostname.to_owned());
		Ok(self
			.answers
			.lock()
			.unwrap()
			.get(hostname)
			.cloned()
			.unwrap_or_else(|| vec![ip(PUBLIC_V4)]))
	}
}

/// Records what the fetcher asked to connect to (the validated address).
struct Recording {
	inner: Arc<PinnedHttpsConnect>,
	requested: Mutex<Vec<(String, IpAddr)>>,
}

#[async_trait]
impl PinnedConnect for Recording {
	async fn connect(&self, request: PinnedRequest<'_>) -> Result<PinnedResponse, ConnectError> {
		self.requested
			.lock()
			.unwrap()
			.push((request.hostname.to_owned(), request.address));
		self.inner.connect(request).await
	}

	fn has_idle(&self, hostname: &str, address: IpAddr) -> bool {
		self.inner.has_idle(hostname, address)
	}
}

struct Harness {
	fetcher: NodeSafeFetcher,
	dns: Arc<ScriptedDns>,
	recording: Arc<Recording>,
}

impl Harness {
	fn requested(&self) -> Vec<(String, IpAddr)> {
		self.recording.requested.lock().unwrap().clone()
	}

	fn connector(&self) -> &PinnedHttpsConnect {
		&self.recording.inner
	}

	fn set_dns(&self, host: &str, answers: &[&str]) {
		self.dns.answers.lock().unwrap().insert(
			host.to_owned(),
			answers.iter().map(|answer| ip(answer)).collect(),
		);
	}

	fn lookups(&self) -> Vec<String> {
		self.dns.lookups.lock().unwrap().clone()
	}

	async fn get(&self, url: &str, options: &SafeFetchOptions) -> Result<String, SafeFetchError> {
		self.fetcher
			.fetch_text(url, options)
			.await
			.map(|document| document.text)
	}
}

fn harness_with(server: &Server, ca: Option<&str>, limits: PoolLimits) -> Harness {
	let tls = PinnedTls::with_overrides(&PinnedTlsOverrides {
		port: Some(server.port),
		extra_root_pem: ca.map(str::to_owned),
		dial_loopback: true,
	})
	.unwrap();
	let recording = Arc::new(Recording {
		inner: Arc::new(PinnedHttpsConnect::with_limits(tls, limits)),
		requested: Mutex::new(Vec::new()),
	});
	let dns = Arc::new(ScriptedDns {
		answers: Mutex::new(HashMap::new()),
		lookups: Mutex::new(Vec::new()),
	});
	let fetcher = create_node_safe_fetcher_with(NodeSafeFetcherOverrides {
		lookup: Some(dns.clone()),
		connect: Some(recording.clone()),
	})
	.unwrap();
	Harness {
		fetcher,
		dns,
		recording,
	}
}

fn harness(server: &Server) -> Harness {
	harness_with(server, Some(CA_PEM), PoolLimits::default())
}

fn limits() -> SafeFetchOptions {
	SafeFetchOptions {
		max_bytes: 10_000,
		timeout_ms: 2_000,
		accept: "text/plain".to_owned(),
		cancel: None,
		allowed_hosts: None,
		authorize_redirect: None,
		user_agent: None,
		authorization: None,
		finnhub_token: None,
		include_error_body: false,
	}
}

fn failure(code: SafeFetchErrorCode, detail: &str) -> SafeFetchError {
	SafeFetchError {
		code,
		detail: detail.to_owned(),
		body: None,
	}
}

/* ---------- nodeSafeFetcher.test.ts over a real TLS connection ---------- */

#[tokio::test]
async fn fetches_text_connecting_to_the_address_it_validated() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	harness.set_dns(HOST_A, &[PUBLIC_V4_B]);
	let document = harness
		.fetcher
		.fetch_text(&format!("https://{HOST_A}/hello"), &limits())
		.await
		.unwrap();
	assert_eq!(document.final_url, format!("https://{HOST_A}/hello"));
	assert_eq!(
		document.content_type.as_deref(),
		Some("text/plain; charset=utf-8")
	);
	assert_eq!(
		document.text,
		format!("hello from {HOST_A}; ua={DEFAULT_USER_AGENT}; cookie=none")
	);
	assert_eq!(harness.lookups(), [HOST_A]);
	assert_eq!(harness.requested(), [(HOST_A.to_owned(), ip(PUBLIC_V4_B))]);
	// SNI and Host are the host name; the wire request is the TypeScript's.
	let seen = &server.requests()[0];
	assert_eq!(seen.server_name.as_deref(), Some(HOST_A));
	let names: Vec<&str> = seen.headers.iter().map(|(name, _)| name.as_str()).collect();
	assert_eq!(names, ["host", "accept", "user-agent", "accept-encoding"]);
	assert_eq!(seen.header("accept-encoding"), Some("gzip"));
}

#[tokio::test]
async fn resolves_and_validates_every_redirect_hop_separately() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	harness.set_dns(HOST_A, &[PUBLIC_V4]);
	harness.set_dns(HOST_B, &[PUBLIC_V6]);
	let document = harness
		.fetcher
		.fetch_text(&format!("https://{HOST_A}/to-b"), &limits())
		.await
		.unwrap();
	assert_eq!(document.final_url, format!("https://{HOST_B}/hello"));
	assert_eq!(harness.lookups(), [HOST_A, HOST_B]);
	assert_eq!(
		harness.requested(),
		[
			(HOST_A.to_owned(), ip(PUBLIC_V4)),
			(HOST_B.to_owned(), ip(PUBLIC_V6))
		]
	);
	let relative = harness
		.fetcher
		.fetch_text(&format!("https://{HOST_A}/relative"), &limits())
		.await
		.unwrap();
	assert_eq!(relative.final_url, format!("https://{HOST_A}/hello"));
}

#[tokio::test]
async fn refuses_a_redirect_to_a_loopback_literal_or_to_http_after_one_connection() {
	let server = start_server(LEAF_PEM).await;
	for path in ["/to-loopback-literal", "/to-http"] {
		let harness = harness(&server);
		let result = harness
			.get(&format!("https://{HOST_A}{path}"), &limits())
			.await;
		assert_eq!(result.unwrap_err().code, SafeFetchErrorCode::UnsafeRedirect);
		assert_eq!(harness.requested().len(), 1);
	}
}

#[tokio::test]
async fn refuses_a_redirect_whose_host_resolves_to_a_private_address() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	harness.set_dns(HOST_B, &["192.168.1.10"]);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/to-b"), &limits())
			.await,
		Err(failure(
			SafeFetchErrorCode::UnsafeRedirect,
			"redirect 1 rejected: host resolves to a non-public address"
		))
	);
	assert_eq!(harness.requested(), [(HOST_A.to_owned(), ip(PUBLIC_V4))]);
}

#[tokio::test]
async fn enforces_the_allowlist_on_redirect_hops_without_resolving_the_off_list_host() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	let mut allowlisted = limits();
	allowlisted.allowed_hosts = Some([HOST_A.to_owned()].into_iter().collect());
	let result = harness
		.get(&format!("https://{HOST_A}/to-b"), &allowlisted)
		.await;
	assert_eq!(result.unwrap_err().code, SafeFetchErrorCode::UnsafeRedirect);
	assert_eq!(harness.lookups(), [HOST_A]);
}

#[tokio::test]
async fn rejects_oversized_bodies_declared_or_streamed() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/declared-big"), &limits())
			.await,
		Err(failure(
			SafeFetchErrorCode::ResponseTooLarge,
			"declared size exceeds 10000 bytes"
		))
	);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/chunked-big"), &limits())
			.await,
		Err(failure(
			SafeFetchErrorCode::ResponseTooLarge,
			"body exceeds 10000 bytes"
		))
	);
}

#[tokio::test]
async fn bounds_decompressed_and_encoded_bytes() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	let mut bomb = limits();
	bomb.max_bytes = 100_000;
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/gzip-bomb"), &bomb)
			.await
			.unwrap_err()
			.code,
		SafeFetchErrorCode::ResponseTooLarge
	);
	// ~100 kB on the wire that decodes to nothing.
	let mut tiny = limits();
	tiny.max_bytes = 32;
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/gzip-empty-members"), &tiny)
			.await,
		Err(failure(
			SafeFetchErrorCode::ResponseTooLarge,
			"body exceeds 32 bytes"
		))
	);
	let mut under = limits();
	under.max_bytes = 50_000;
	assert_eq!(
		harness
			.get(
				&format!("https://{HOST_A}/gzip-empty-members-small"),
				&under
			)
			.await,
		Ok(String::new())
	);
}

#[tokio::test]
async fn drops_the_connection_as_soon_as_the_encoded_ceiling_is_passed() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	let mut options = limits();
	options.max_bytes = 2_000;
	options.timeout_ms = 10_000;
	let started = Instant::now();
	let result = harness
		.get(
			&format!("https://{HOST_A}/gzip-endless-empty-members"),
			&options,
		)
		.await;
	assert_eq!(
		result.unwrap_err().code,
		SafeFetchErrorCode::ResponseTooLarge
	);
	// Cut off by the byte ceiling, long before the 10 s timeout would have ended it.
	assert!(started.elapsed() < Duration::from_secs(3));
	server.wait_closed(1).await;
	let written = server.state.endless_closed_after.load(Ordering::SeqCst);
	assert!(written > 2_000 && written < 200_000, "{written}");
	assert_eq!(harness.connector().pool().idle_count(), 0);
}

#[tokio::test]
async fn decodes_gzip_brotli_and_deflate_as_utf8() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/gzip"), &limits())
			.await,
		Ok("{\"text\":\"圧縮された応答\"}".to_owned())
	);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/br"), &limits())
			.await,
		Ok("{\"text\":\"brotli 応答\"}".to_owned())
	);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/deflate"), &limits())
			.await,
		Ok("deflated body".to_owned())
	);
}

#[tokio::test]
async fn times_out_on_a_stalled_body_and_on_a_server_that_never_answers() {
	let server = start_server(LEAF_PEM).await;
	for path in ["/slow", "/never"] {
		let harness = harness(&server);
		let mut options = limits();
		options.timeout_ms = 150;
		let started = Instant::now();
		assert_eq!(
			harness
				.get(&format!("https://{HOST_A}{path}"), &options)
				.await,
			Err(failure(
				SafeFetchErrorCode::Timeout,
				"no complete response within 150 ms"
			))
		);
		assert!(started.elapsed() < Duration::from_millis(1_500));
		assert_eq!(harness.connector().pool().idle_count(), 0);
	}
	// Both abandoned connections are closed, not left open in a pool.
	server.wait_closed(2).await;
}

#[tokio::test]
async fn stops_when_the_caller_aborts_and_closes_the_connection() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	let token = CancellationToken::new();
	let mut options = limits();
	options.cancel = Some(token.clone());
	let cancel = tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(50)).await;
		token.cancel();
	});
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/slow"), &options)
			.await,
		Err(failure(
			SafeFetchErrorCode::Timeout,
			"aborted by the caller"
		))
	);
	cancel.await.unwrap();
	server.wait_closed(1).await;
	assert_eq!(harness.connector().pool().idle_count(), 0);
}

#[tokio::test]
async fn reports_non_2xx_responses_with_their_status() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/gone"), &limits())
			.await,
		Err(failure(SafeFetchErrorCode::HttpError, "HTTP 410"))
	);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/nothing-here"), &limits())
			.await,
		Err(failure(SafeFetchErrorCode::HttpError, "HTTP 404"))
	);
	// pinnedConnect.ts: a non-2xx body is never read, so the error body is empty.
	let mut with_body = limits();
	with_body.include_error_body = true;
	let error = harness
		.get(&format!("https://{HOST_A}/gone"), &with_body)
		.await
		.unwrap_err();
	assert_eq!(error.body.as_deref(), Some(""));
	// An unknown encoding on an error status is irrelevant: the body is not read.
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/missing"), &limits())
			.await,
		Err(failure(SafeFetchErrorCode::HttpError, "HTTP 404"))
	);
	assert_eq!(harness.connector().pool().idle_count(), 0);
}

#[tokio::test]
async fn refuses_an_unsupported_content_encoding_trying_each_validated_address() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	harness.set_dns(HOST_A, &[PUBLIC_V4, PUBLIC_V4_B]);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/weird-encoding"), &limits())
			.await,
		Err(failure(
			SafeFetchErrorCode::NetworkError,
			"UNSUPPORTED_CONTENT_ENCODING"
		))
	);
	// The TypeScript quirk, kept for parity: the failure moves on to the next address.
	assert_eq!(harness.requested().len(), 2);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/gzip-corrupt"), &limits())
			.await,
		Err(failure(SafeFetchErrorCode::NetworkError, "Z_DATA_ERROR"))
	);
	assert_eq!(harness.connector().pool().idle_count(), 0);
}

#[tokio::test]
async fn fails_tls_verification_for_an_uncovered_name_an_unknown_root_and_an_expired_leaf() {
	let server = start_server(LEAF_PEM).await;
	assert_eq!(
		harness(&server)
			.get("https://uncovered.synthetic-wire.org/hello", &limits())
			.await,
		Err(failure(
			SafeFetchErrorCode::NetworkError,
			"ERR_TLS_CERT_ALTNAME_INVALID"
		))
	);
	let untrusted = harness_with(&server, None, PoolLimits::default());
	assert_eq!(
		untrusted
			.get(&format!("https://{HOST_A}/hello"), &limits())
			.await,
		Err(failure(
			SafeFetchErrorCode::NetworkError,
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE"
		))
	);
	let expired = start_server(EXPIRED_PEM).await;
	assert_eq!(
		harness(&expired)
			.get(&format!("https://{HOST_A}/hello"), &limits())
			.await,
		Err(failure(
			SafeFetchErrorCode::NetworkError,
			"CERT_HAS_EXPIRED"
		))
	);
}

#[tokio::test]
async fn reports_a_refused_connection_by_its_code() {
	// Bind and drop a listener: its port now refuses connections.
	let port = {
		let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
		listener.local_addr().unwrap().port()
	};
	let tls = PinnedTls::with_overrides(&PinnedTlsOverrides {
		port: Some(port),
		extra_root_pem: Some(CA_PEM.to_owned()),
		dial_loopback: true,
	})
	.unwrap();
	let connect = PinnedHttpsConnect::new(tls);
	let request = PinnedRequest {
		hostname: HOST_A,
		address: ip(PUBLIC_V4),
		path: "/",
		headers: research_net::core::HopHeaders {
			accept: "text/plain",
			user_agent: "t",
			authorization: None,
			finnhub_token: None,
		},
		max_encoded_bytes: 10,
	};
	assert_eq!(
		connect.connect(request).await.unwrap_err(),
		ConnectError::code("ECONNREFUSED")
	);
}

/* ---------- pinnedConnect.test.ts ---------- */

fn pinned(path: &str, max_encoded_bytes: usize) -> PinnedRequest<'_> {
	PinnedRequest {
		hostname: "pinned.synthetic-wire.org",
		address: ip(PUBLIC_V4),
		path,
		headers: research_net::core::HopHeaders {
			accept: "text/plain",
			user_agent: "pinned-connect-test",
			authorization: None,
			finnhub_token: None,
		},
		max_encoded_bytes,
	}
}

async fn read_all(mut response: PinnedResponse) -> Result<Vec<u8>, research_net::core::BodyError> {
	let mut bytes = Vec::new();
	while let Some(chunk) = response.body.next_chunk().await {
		bytes.extend_from_slice(&chunk?);
	}
	Ok(bytes)
}

fn connector(server: &Server) -> PinnedHttpsConnect {
	PinnedHttpsConnect::new(
		PinnedTls::with_overrides(&PinnedTlsOverrides {
			port: Some(server.port),
			extra_root_pem: Some(CA_PEM.to_owned()),
			dial_loopback: true,
		})
		.unwrap(),
	)
}

#[tokio::test]
async fn pinned_connect_reaches_the_pinned_address_with_sni_and_host_set_to_the_name() {
	let server = start_server(LEAF_PEM).await;
	let connect = connector(&server);
	let response = connect
		.connect(pinned("/echo?x=1", 1_000_000))
		.await
		.unwrap();
	assert_eq!(response.status, 200);
	assert_eq!(response.content_type.as_deref(), Some("text/plain"));
	assert_eq!(response.content_length, Some(5));
	assert_eq!(read_all(response).await.unwrap(), b"hello");
	let seen = server.requests().pop().unwrap();
	assert_eq!(
		seen.server_name.as_deref(),
		Some("pinned.synthetic-wire.org")
	);
	assert_eq!(seen.header("host"), Some("pinned.synthetic-wire.org"));
	assert_eq!(seen.path, "/echo?x=1");
	assert_eq!(seen.header("cookie"), None);
	assert_eq!(seen.header("connection"), None);
}

#[tokio::test]
async fn pinned_connect_stops_at_the_encoded_ceiling_even_when_nothing_decodes() {
	let server = start_server(LEAF_PEM).await;
	let connect = connector(&server);
	let response = connect
		.connect(pinned("/gzip-empty-members-small", 64))
		.await
		.unwrap();
	assert_eq!(
		read_all(response).await,
		Err(research_net::core::BodyError::TooLarge)
	);
	let under = connect
		.connect(pinned("/gzip-empty-members-small", 50_000))
		.await
		.unwrap();
	assert_eq!(read_all(under).await.unwrap(), b"");
	let gzip = connect.connect(pinned("/gzip", 1_000)).await.unwrap();
	assert_eq!(
		read_all(gzip).await.unwrap(),
		"{\"text\":\"圧縮された応答\"}".as_bytes()
	);
}

#[tokio::test]
async fn pinned_connect_refuses_an_unknown_encoding_only_for_bodies_it_would_read() {
	let server = start_server(LEAF_PEM).await;
	let connect = connector(&server);
	assert_eq!(
		connect
			.connect(pinned("/weird-encoding", 1_000))
			.await
			.unwrap_err(),
		ConnectError::code("UNSUPPORTED_CONTENT_ENCODING")
	);
	let missing = connect.connect(pinned("/missing", 1_000)).await.unwrap();
	assert_eq!(missing.status, 404);
	assert_eq!(read_all(missing).await.unwrap(), b"");
}

/* ---------- ADR-0030 C1: connection reuse ---------- */

#[tokio::test]
async fn a_second_request_to_the_same_host_reuses_the_connection() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	let url = format!("https://{HOST_A}/conn");
	assert_eq!(
		harness.get(&url, &limits()).await,
		Ok("connection 1 request 1".to_owned())
	);
	assert_eq!(harness.connector().pool().idle_count(), 1);
	assert_eq!(
		harness.get(&url, &limits()).await,
		Ok("connection 1 request 2".to_owned())
	);
	assert_eq!(
		harness.get(&url, &limits()).await,
		Ok("connection 1 request 3".to_owned())
	);
	assert_eq!(server.accepted(), 1);
	assert_eq!(harness.connector().connections_opened(), 1);
	// Every request still resolved and validated its answer.
	assert_eq!(harness.lookups(), [HOST_A, HOST_A, HOST_A]);
}

#[tokio::test]
async fn a_pooled_connection_never_serves_another_host_name_at_the_same_address() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	harness.set_dns(HOST_A, &[PUBLIC_V4]);
	harness.set_dns(HOST_B, &[PUBLIC_V4]);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/conn"), &limits())
			.await,
		Ok("connection 1 request 1".to_owned())
	);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_B}/conn"), &limits())
			.await,
		Ok("connection 2 request 1".to_owned())
	);
	let names: Vec<Option<String>> = server
		.requests()
		.into_iter()
		.map(|request| request.server_name)
		.collect();
	assert_eq!(names, [Some(HOST_A.to_owned()), Some(HOST_B.to_owned())]);
	assert_eq!(harness.connector().pool().idle_count(), 2);
}

#[tokio::test]
async fn rebinding_to_a_private_address_is_refused_even_with_a_pooled_public_connection() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	let url = format!("https://{HOST_A}/conn");
	harness.get(&url, &limits()).await.unwrap();
	assert_eq!(harness.connector().pool().idle_count(), 1);
	for answers in [&["192.168.1.10"][..], &[PUBLIC_V4, "10.0.0.1"], &["::1"]] {
		harness.set_dns(HOST_A, answers);
		assert_eq!(
			harness.get(&url, &limits()).await,
			Err(failure(
				SafeFetchErrorCode::UnsafeUrl,
				"host resolves to a non-public address"
			))
		);
	}
	// Nothing was requested on the pooled connection or on a new one.
	assert_eq!(server.requests().len(), 1);
	assert_eq!(harness.requested().len(), 1);
	// The name now resolves to a different public address: a fresh connection,
	// because the pooled IP is not in the current answer.
	harness.set_dns(HOST_A, &[PUBLIC_V4_B]);
	assert_eq!(
		harness.get(&url, &limits()).await,
		Ok("connection 2 request 1".to_owned())
	);
	// Back to the pooled address: reused.
	harness.set_dns(HOST_A, &[PUBLIC_V4]);
	assert_eq!(
		harness.get(&url, &limits()).await,
		Ok("connection 1 request 2".to_owned())
	);
}

#[tokio::test]
async fn a_connection_that_ended_a_response_abnormally_is_never_pooled() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	let base = format!("https://{HOST_A}");
	let mut fast_timeout = limits();
	fast_timeout.timeout_ms = 150;
	let mut cases: Vec<(String, SafeFetchOptions)> = [
		"/declared-big",
		"/chunked-big",
		"/gzip-corrupt",
		"/gone",
		"/close",
	]
	.iter()
	.map(|path| (format!("{base}{path}"), limits()))
	.collect();
	cases.push((format!("{base}/slow"), fast_timeout));
	for (index, (url, options)) in cases.iter().enumerate() {
		let _ = harness.get(url, options).await;
		assert_eq!(harness.connector().pool().idle_count(), 0, "{url}");
		server.wait_closed(index + 1).await;
	}
	// A redirect closes the connection that carried it; the final hop's
	// complete 2xx response is pooled.
	harness.set_dns(HOST_B, &[PUBLIC_V4_B]);
	harness
		.get(&format!("{base}/to-b"), &limits())
		.await
		.unwrap();
	server.wait_closed(cases.len() + 1).await;
	assert_eq!(harness.connector().pool().idle_count(), 1);
	assert!(harness.connector().has_idle(HOST_B, ip(PUBLIC_V4_B)));
	assert!(!harness.connector().has_idle(HOST_A, ip(PUBLIC_V4)));
	// The next request opens a fresh connection and works.
	assert!(
		harness
			.get(&format!("{base}/conn"), &limits())
			.await
			.unwrap()
			.ends_with("request 1")
	);
}

#[tokio::test]
async fn a_pooled_connection_the_server_closed_is_replaced_transparently() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness(&server);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/then-drop"), &limits())
			.await,
		Ok("once".to_owned())
	);
	server.wait_closed(1).await;
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/conn"), &limits())
			.await,
		Ok("connection 2 request 1".to_owned())
	);
	assert_eq!(harness.connector().connections_opened(), 2);
}

#[tokio::test]
async fn idle_connections_close_after_the_idle_timeout() {
	let server = start_server(LEAF_PEM).await;
	let harness = harness_with(
		&server,
		Some(CA_PEM),
		PoolLimits {
			idle_timeout: Duration::from_millis(200),
			..PoolLimits::default()
		},
	);
	harness
		.get(&format!("https://{HOST_A}/conn"), &limits())
		.await
		.unwrap();
	assert_eq!(harness.connector().pool().idle_count(), 1);
	// The sweeper closes it without any further request.
	server.wait_closed(1).await;
	assert_eq!(harness.connector().pool().idle_count(), 0);
	assert_eq!(
		harness
			.get(&format!("https://{HOST_A}/conn"), &limits())
			.await,
		Ok("connection 2 request 1".to_owned())
	);
}

#[tokio::test]
async fn the_pool_keeps_at_most_the_configured_idle_connections() {
	let server = start_server(LEAF_PEM).await;
	let harness = Arc::new(harness_with(
		&server,
		Some(CA_PEM),
		PoolLimits {
			max_idle_per_key: 4,
			max_idle_total: 5,
			..PoolLimits::default()
		},
	));
	harness.set_dns(HOST_A, &[PUBLIC_V4]);
	harness.set_dns(HOST_B, &[PUBLIC_V4]);
	let mut tasks = Vec::new();
	for host in [
		HOST_A, HOST_A, HOST_A, HOST_A, HOST_A, HOST_A, HOST_B, HOST_B,
	] {
		let harness = Arc::clone(&harness);
		tasks.push(tokio::spawn(async move {
			harness
				.get(&format!("https://{host}/conn-slow"), &limits())
				.await
				.unwrap()
		}));
	}
	for task in tasks {
		task.await.unwrap();
	}
	assert_eq!(server.accepted(), 8);
	assert_eq!(harness.connector().pool().idle_count(), 5);
	server.wait_closed(3).await;
	// Both host names still have reusable connections.
	harness
		.get(&format!("https://{HOST_B}/conn"), &limits())
		.await
		.unwrap();
	harness
		.get(&format!("https://{HOST_A}/conn"), &limits())
		.await
		.unwrap();
	assert_eq!(server.accepted(), 8);
}

/* ---------- real network (run by hand) ---------- */

/// `cargo test -p research-net --test network -- --ignored --nocapture`:
/// the web.search URLs of `searchTools.ts`, two requests per host 6 s apart
/// on one fetcher (fresh, then reused).
#[tokio::test]
#[ignore = "real network"]
async fn measure_fresh_and_reused_search_requests() {
	let connect = Arc::new(PinnedHttpsConnect::new(PinnedTls::new().unwrap()));
	let fetcher = create_node_safe_fetcher_with(NodeSafeFetcherOverrides {
		lookup: None,
		connect: Some(connect.clone()),
	})
	.unwrap();
	let query = research_js::uri::encode_uri_component("gold price sourcelang:english");
	let gdelt = format!(
		"https://api.gdeltproject.org/api/v2/doc/doc?query={query}&mode=artlist&format=json&maxrecords=10&sort=hybridrel"
	);
	let wikipedia = format!(
		"https://en.wikipedia.org/w/rest.php/v1/search/page?q={}&limit=3",
		research_js::uri::encode_uri_component("gold price")
	);
	let options = |host: &str| SafeFetchOptions {
		max_bytes: 1_000_000,
		timeout_ms: 15_000,
		accept: "application/json".to_owned(),
		cancel: None,
		allowed_hosts: Some([host.to_owned()].into_iter().collect()),
		authorize_redirect: None,
		user_agent: Some("research-workspace/1.0 (personal research tool)".to_owned()),
		authorization: None,
		finnhub_token: None,
		include_error_body: false,
	};
	for (name, url, host) in [
		("GDELT", gdelt.as_str(), "api.gdeltproject.org"),
		("Wikipedia", wikipedia.as_str(), "en.wikipedia.org"),
	] {
		for attempt in ["fresh", "reused"] {
			let opened_before = connect.connections_opened();
			let started = Instant::now();
			let result = fetcher.fetch_text(url, &options(host)).await;
			let elapsed = started.elapsed();
			let opened = connect.connections_opened() - opened_before;
			match &result {
				Ok(document) => println!(
					"{name} {attempt}: {:.0} ms, {} bytes, new connections {opened}",
					elapsed.as_secs_f64() * 1_000.0,
					document.text.len()
				),
				Err(error) => println!(
					"{name} {attempt}: {:.0} ms, {} {}, new connections {opened}",
					elapsed.as_secs_f64() * 1_000.0,
					error.code.as_str(),
					error.detail
				),
			}
			tokio::time::sleep(Duration::from_secs(6)).await;
		}
	}
}

/// `cargo test -p research-net --test network measure_gdelt -- --ignored --nocapture`:
/// the handshake cost on api.gdeltproject.org versus requests on the open
/// connection (GDELT answers even `robots.txt` with a non-2xx, which the pool
/// never keeps, so this drives one pinned connection directly).
#[tokio::test]
#[ignore = "real network"]
async fn measure_gdelt_handshake_versus_warm_requests() {
	use http_body_util::BodyExt as _;
	let host = "api.gdeltproject.org";
	let address = tokio::net::lookup_host((host, 443))
		.await
		.unwrap()
		.next()
		.unwrap()
		.ip();
	let tls = PinnedTls::new().unwrap();
	let started = Instant::now();
	let stream = tls.connect(host, address).await.unwrap();
	println!(
		"GDELT TCP+TLS, first: {:.0} ms",
		started.elapsed().as_secs_f64() * 1_000.0
	);
	// A second handshake with the same client config may resume the TLS session.
	let started = Instant::now();
	let second = tls.connect(host, address).await.unwrap();
	let resumed = second.get_ref().1.handshake_kind();
	println!(
		"GDELT TCP+TLS, second: {:.0} ms ({resumed:?})",
		started.elapsed().as_secs_f64() * 1_000.0
	);
	drop(second);
	let (mut sender, connection) = hyper::client::conn::http1::handshake::<
		_,
		http_body_util::Empty<bytes::Bytes>,
	>(hyper_util::rt::TokioIo::new(stream))
	.await
	.unwrap();
	tokio::spawn(connection);
	let gaps = [0_u64, 1, 3, 5];
	for gap in gaps {
		tokio::time::sleep(Duration::from_secs(gap)).await;
		if sender.is_closed() {
			println!("GDELT closed the idle connection within {gap} s");
			break;
		}
		let request = http::Request::get("/robots.txt")
			.header("host", host)
			.header(
				"user-agent",
				"research-workspace/1.0 (personal research tool)",
			)
			.body(http_body_util::Empty::new())
			.unwrap();
		let started = Instant::now();
		sender.ready().await.unwrap();
		let response = sender.send_request(request).await.unwrap();
		let status = response.status();
		let keep_alive = format!(
			"connection={:?} keep-alive={:?}",
			response.headers().get("connection"),
			response.headers().get("keep-alive")
		);
		response.into_body().collect().await.unwrap();
		println!(
			"GDELT request on open connection after {gap} s idle: {:.0} ms (HTTP {status}, {keep_alive})",
			started.elapsed().as_secs_f64() * 1_000.0
		);
	}
}
