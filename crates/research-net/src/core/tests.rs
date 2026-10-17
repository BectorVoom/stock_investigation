//! The hop core over a scripted transport (no sockets): the behaviours of
//! `nodeSafeBinaryFetcher.test.ts` and the core rules that depend on time
//! (deadline, cancellation), which the conformance vectors cannot carry.

use std::collections::HashMap;
use std::sync::Mutex;

use research_application::ports::RedirectAuthorizer;

use super::*;

#[derive(Clone, Default)]
struct Page {
	status: u16,
	location: Option<String>,
	content_type: Option<String>,
	content_length: Option<u64>,
	chunks: Vec<Vec<u8>>,
	/// After the chunks, never end.
	stall: bool,
	error: Option<BodyError>,
}

fn ok_page(body: &[u8]) -> Page {
	Page {
		status: 200,
		content_type: Some("application/octet-stream".to_owned()),
		chunks: vec![body.to_vec()],
		..Page::default()
	}
}

fn redirect(status: u16, location: &str) -> Page {
	Page {
		status,
		location: Some(location.to_owned()),
		..Page::default()
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
	url: String,
	hostname: String,
	authorization: Option<String>,
	finnhub_token: Option<String>,
	user_agent: String,
}

#[derive(Default)]
struct Scripted {
	pages: HashMap<String, Page>,
	/// URL -> (unsafe destination?, detail).
	outcomes: HashMap<String, (bool, String)>,
	seen: Mutex<Vec<Seen>>,
}

impl Scripted {
	fn with(pages: &[(&str, Page)]) -> Self {
		Self {
			pages: pages
				.iter()
				.map(|(url, page)| ((*url).to_owned(), page.clone()))
				.collect(),
			..Self::default()
		}
	}

	fn seen(&self) -> Vec<Seen> {
		self.seen.lock().unwrap().clone()
	}
}

struct ScriptedBody {
	chunks: std::vec::IntoIter<Vec<u8>>,
	stall: bool,
	error: Option<BodyError>,
}

#[async_trait]
impl HopBody for ScriptedBody {
	async fn next_chunk(&mut self) -> Option<Result<Bytes, BodyError>> {
		if let Some(chunk) = self.chunks.next() {
			return Some(Ok(Bytes::from(chunk)));
		}
		if self.stall {
			std::future::pending::<()>().await;
		}
		self.error.take().map(Err)
	}
}

#[async_trait]
impl HopTransport for Scripted {
	async fn hop(&self, request: HopRequest<'_>) -> HopOutcome {
		self.seen.lock().unwrap().push(Seen {
			url: request.url.to_string(),
			hostname: request.hostname.to_owned(),
			authorization: request.headers.authorization.map(str::to_owned),
			finnhub_token: request.headers.finnhub_token.map(str::to_owned),
			user_agent: request.headers.user_agent.to_owned(),
		});
		if let Some((unsafe_destination, detail)) = self.outcomes.get(request.url.as_str()) {
			let detail = detail.clone();
			return if *unsafe_destination {
				HopOutcome::UnsafeDestination { detail }
			} else {
				HopOutcome::NetworkError { detail }
			};
		}
		let Some(page) = self.pages.get(request.url.as_str()).cloned() else {
			return HopOutcome::NetworkError {
				detail: "unscripted".to_owned(),
			};
		};
		HopOutcome::Response(HopResponse {
			status: page.status,
			location: page.location,
			content_type: page.content_type,
			content_length: page.content_length,
			body: Box::new(ScriptedBody {
				chunks: page.chunks.into_iter(),
				stall: page.stall,
				error: page.error,
			}),
		})
	}
}

fn options(max_bytes: usize) -> SafeFetchOptions {
	SafeFetchOptions {
		max_bytes,
		timeout_ms: 5_000,
		accept: "application/octet-stream".to_owned(),
		cancel: None,
		allowed_hosts: None,
		authorize_redirect: None,
		user_agent: None,
		authorization: None,
		finnhub_token: None,
		include_error_body: false,
	}
}

fn hosts(names: &[&str]) -> Option<BTreeSet<String>> {
	Some(names.iter().map(|name| (*name).to_owned()).collect())
}

fn error(code: SafeFetchErrorCode, detail: &str) -> SafeFetchError {
	SafeFetchError {
		code,
		detail: detail.to_owned(),
		body: None,
	}
}

const XLSX_MAGIC: [u8; 7] = [0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x89];

#[tokio::test]
async fn returns_the_exact_response_bytes_without_text_decoding() {
	let transport = Scripted::with(&[(
		"https://www.jpx.co.jp/kessan09_1009.xlsx",
		ok_page(&XLSX_MAGIC),
	)]);
	let mut limits = options(4_194_304);
	limits.allowed_hosts = hosts(&["www.jpx.co.jp"]);
	let fetcher = SafeFetchCore::new(Arc::new(transport));
	let document = fetcher
		.fetch_bytes("https://www.jpx.co.jp/kessan09_1009.xlsx", &limits)
		.await
		.unwrap();
	assert_eq!(
		document.final_url,
		"https://www.jpx.co.jp/kessan09_1009.xlsx"
	);
	assert_eq!(document.bytes, XLSX_MAGIC);
	assert_eq!(
		document.content_type.as_deref(),
		Some("application/octet-stream")
	);
}

#[tokio::test]
async fn enforces_the_decoded_byte_ceiling() {
	let transport = Scripted::with(&[(
		"https://www.jpx.co.jp/big.xlsx",
		Page {
			chunks: vec![vec![7; 6], vec![7; 5]],
			..ok_page(&[])
		},
	)]);
	let result = fetch_raw_bytes(&transport, "https://www.jpx.co.jp/big.xlsx", &options(10)).await;
	assert_eq!(
		result,
		Err(error(
			SafeFetchErrorCode::ResponseTooLarge,
			"body exceeds 10 bytes"
		))
	);
	let exact = Scripted::with(&[("https://www.jpx.co.jp/ten", ok_page(&[1; 10]))]);
	assert_eq!(
		fetch_raw_bytes(&exact, "https://www.jpx.co.jp/ten", &options(10))
			.await
			.unwrap()
			.bytes,
		vec![1; 10]
	);
	let declared = Scripted::with(&[(
		"https://www.jpx.co.jp/declared",
		Page {
			content_length: Some(11),
			..ok_page(&[1])
		},
	)]);
	assert_eq!(
		fetch_raw_bytes(&declared, "https://www.jpx.co.jp/declared", &options(10)).await,
		Err(error(
			SafeFetchErrorCode::ResponseTooLarge,
			"declared size exceeds 10 bytes"
		))
	);
	let transport_cap = Scripted::with(&[(
		"https://www.jpx.co.jp/wire",
		Page {
			error: Some(BodyError::TooLarge),
			..ok_page(&[])
		},
	)]);
	assert_eq!(
		fetch_raw_bytes(&transport_cap, "https://www.jpx.co.jp/wire", &options(10)).await,
		Err(error(
			SafeFetchErrorCode::ResponseTooLarge,
			"body exceeds 10 bytes"
		))
	);
}

#[tokio::test]
async fn follows_a_same_host_redirect_and_validates_every_hop() {
	let transport = Scripted::with(&[
		("https://www.jpx.co.jp/start", redirect(302, "/final.xlsx")),
		("https://www.jpx.co.jp/final.xlsx", ok_page(&XLSX_MAGIC)),
	]);
	let mut limits = options(1_000);
	limits.allowed_hosts = hosts(&["WWW.JPX.CO.JP."]);
	let document = fetch_raw_bytes(&transport, "https://www.jpx.co.jp/start", &limits)
		.await
		.unwrap();
	assert_eq!(document.final_url, "https://www.jpx.co.jp/final.xlsx");
	assert_eq!(document.bytes, XLSX_MAGIC);

	let off_host = Scripted::with(&[(
		"https://www.jpx.co.jp/start",
		redirect(302, "https://evil.example.com/x.xlsx"),
	)]);
	assert_eq!(
		fetch_raw_bytes(&off_host, "https://www.jpx.co.jp/start", &limits).await,
		Err(error(
			SafeFetchErrorCode::UnsafeRedirect,
			"redirect 1 rejected: host is not on the allowlist for this request"
		))
	);
	// The off-list host was never requested.
	assert_eq!(off_host.seen().len(), 1);
}

#[tokio::test]
async fn sends_api_keys_on_the_first_hop_only() {
	let transport = Scripted::with(&[
		(
			"https://finnhub.io/api/v1/x",
			redirect(307, "https://finnhub.io/api/v1/y"),
		),
		("https://finnhub.io/api/v1/y", ok_page(&[1, 2, 3])),
	]);
	let mut limits = options(1_000);
	limits.finnhub_token = Some("synthetic-key".to_owned());
	limits.authorization = Some("apikey k".to_owned());
	limits.user_agent = Some("custom-agent/1".to_owned());
	fetch_raw_bytes(&transport, "https://finnhub.io/api/v1/x", &limits)
		.await
		.unwrap();
	let seen = transport.seen();
	assert_eq!(seen[0].finnhub_token.as_deref(), Some("synthetic-key"));
	assert_eq!(seen[0].authorization.as_deref(), Some("apikey k"));
	assert_eq!(seen[1].finnhub_token, None);
	assert_eq!(seen[1].authorization, None);
	assert!(
		seen.iter()
			.all(|request| request.user_agent == "custom-agent/1")
	);
	let default_agent = Scripted::with(&[("https://finnhub.io/", ok_page(b""))]);
	fetch_raw_bytes(&default_agent, "https://finnhub.io/", &options(10))
		.await
		.unwrap();
	assert_eq!(default_agent.seen()[0].user_agent, DEFAULT_USER_AGENT);
}

#[tokio::test]
async fn refuses_unsupported_header_values_and_limits_before_any_request() {
	let transport = Scripted::with(&[("https://a.example.org/", ok_page(b"x"))]);
	let header_error = Err(error(
		SafeFetchErrorCode::NetworkError,
		"request header value contains unsupported characters",
	));
	let mut agent = options(10);
	agent.user_agent = Some("agent\u{e9}".to_owned());
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/", &agent).await,
		header_error
	);
	let mut accept = options(10);
	accept.accept = String::new();
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/", &accept).await,
		header_error
	);
	accept.accept = "a".repeat(301);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/", &accept).await,
		header_error
	);
	let mut key = options(10);
	key.authorization = Some("line\nbreak".to_owned());
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/", &key).await,
		header_error
	);
	let mut token = options(10);
	token.finnhub_token = Some(String::new());
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/", &token).await,
		header_error
	);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/", &options(0)).await,
		Err(error(
			SafeFetchErrorCode::ResponseTooLarge,
			"maxBytes must be a positive number"
		))
	);
	let mut instant = options(10);
	instant.timeout_ms = 0;
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/", &instant).await,
		Err(error(
			SafeFetchErrorCode::Timeout,
			"timeoutMs must be a positive number"
		))
	);
	assert!(transport.seen().is_empty());
}

#[tokio::test]
async fn stops_after_five_redirects_and_on_a_loop() {
	let mut pages: Vec<(String, Page)> = (0..7)
		.map(|index| {
			(
				format!("https://a.example.org/{index}"),
				redirect(301, &format!("/{}", index + 1)),
			)
		})
		.collect();
	pages.push((
		"https://a.example.org/loop".to_owned(),
		redirect(302, "/loop"),
	));
	let transport = Scripted {
		pages: pages.into_iter().collect(),
		..Scripted::default()
	};
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/0", &options(10)).await,
		Err(error(
			SafeFetchErrorCode::TooManyRedirects,
			"more than 5 redirects"
		))
	);
	assert_eq!(transport.seen().len(), 6);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/loop", &options(10)).await,
		Err(error(SafeFetchErrorCode::TooManyRedirects, "redirect loop"))
	);
}

struct Authorizer {
	allow: bool,
	panics: bool,
	asked: Mutex<Vec<String>>,
}

#[async_trait]
impl RedirectAuthorizer for Authorizer {
	async fn authorize(&self, url: &str) -> bool {
		self.asked.lock().unwrap().push(url.to_owned());
		assert!(!self.panics, "authorizer failure");
		self.allow
	}
}

#[tokio::test]
async fn asks_the_authorizer_before_each_redirect_hop_is_validated_or_contacted() {
	let transport = Scripted::with(&[
		(
			"https://a.example.org/start",
			redirect(302, "http://127.0.0.1/admin"),
		),
		("https://a.example.org/two", redirect(302, "/three")),
		("https://a.example.org/three", ok_page(b"done")),
	]);
	for (allow, panics) in [(false, false), (true, true)] {
		let authorizer = Arc::new(Authorizer {
			allow,
			panics,
			asked: Mutex::new(Vec::new()),
		});
		let mut limits = options(100);
		limits.authorize_redirect = Some(authorizer.clone());
		assert_eq!(
			fetch_raw_bytes(&transport, "https://a.example.org/start", &limits).await,
			Err(error(
				SafeFetchErrorCode::RedirectNotAuthorized,
				"redirect 1 was not authorized"
			))
		);
		// Asked about the raw (still unvalidated) location; never about hop 0.
		assert_eq!(
			*authorizer.asked.lock().unwrap(),
			["http://127.0.0.1/admin"]
		);
	}
	let allowing = Arc::new(Authorizer {
		allow: true,
		panics: false,
		asked: Mutex::new(Vec::new()),
	});
	let mut limits = options(100);
	limits.authorize_redirect = Some(allowing.clone());
	let document = fetch_raw_bytes(&transport, "https://a.example.org/two", &limits)
		.await
		.unwrap();
	assert_eq!(document.bytes, b"done");
	assert_eq!(
		*allowing.asked.lock().unwrap(),
		["https://a.example.org/three"]
	);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/start", &limits).await,
		Err(error(
			SafeFetchErrorCode::UnsafeRedirect,
			"redirect 1 rejected: SCHEME_NOT_ALLOWED"
		))
	);
}

#[tokio::test]
async fn times_out_on_a_stalled_body_and_reports_caller_cancellation() {
	let transport = Scripted::with(&[(
		"https://a.example.org/slow",
		Page {
			stall: true,
			..ok_page(b"first part")
		},
	)]);
	let mut limits = options(100);
	limits.timeout_ms = 150;
	let started = std::time::Instant::now();
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/slow", &limits).await,
		Err(error(
			SafeFetchErrorCode::Timeout,
			"no complete response within 150 ms"
		))
	);
	assert!(started.elapsed() < Duration::from_millis(1_500));

	let token = CancellationToken::new();
	let mut cancellable = options(100);
	cancellable.cancel = Some(token.clone());
	let cancel_later = tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(50)).await;
		token.cancel();
	});
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/slow", &cancellable).await,
		Err(error(SafeFetchErrorCode::Timeout, "aborted by the caller"))
	);
	cancel_later.await.unwrap();
	// Already cancelled: no request at all.
	let before = transport.seen().len();
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/slow", &cancellable).await,
		Err(error(SafeFetchErrorCode::Timeout, "aborted by the caller"))
	);
	assert_eq!(transport.seen().len(), before);
}

#[tokio::test]
async fn reports_http_errors_with_the_bounded_body_only_on_request() {
	let transport = Scripted::with(&[(
		"https://api.example.org/series",
		Page {
			status: 400,
			chunks: vec![b"\xEF\xBB\xBF{\"error_code\":400}".to_vec()],
			..Page::default()
		},
	)]);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://api.example.org/series", &options(100)).await,
		Err(error(SafeFetchErrorCode::HttpError, "HTTP 400"))
	);
	let mut with_body = options(100);
	with_body.include_error_body = true;
	let failure = fetch_raw_bytes(&transport, "https://api.example.org/series", &with_body)
		.await
		.unwrap_err();
	assert_eq!(failure.body.as_deref(), Some("{\"error_code\":400}"));
	with_body.max_bytes = 5;
	assert_eq!(
		fetch_raw_bytes(&transport, "https://api.example.org/series", &with_body).await,
		Err(error(SafeFetchErrorCode::HttpError, "HTTP 400"))
	);
	let no_location = Scripted::with(&[(
		"https://api.example.org/moved",
		Page {
			status: 308,
			..Page::default()
		},
	)]);
	assert_eq!(
		fetch_raw_bytes(&no_location, "https://api.example.org/moved", &options(100)).await,
		Err(error(
			SafeFetchErrorCode::HttpError,
			"HTTP 308 without a Location header"
		))
	);
}

#[tokio::test]
async fn maps_transport_verdicts_by_hop() {
	let mut transport = Scripted::with(&[(
		"https://a.example.org/to-b",
		redirect(302, "https://b.example.org/"),
	)]);
	transport.outcomes.insert(
		"https://b.example.org/".to_owned(),
		(true, "host resolves to a non-public address".to_owned()),
	);
	transport.outcomes.insert(
		"https://c.example.org/".to_owned(),
		(true, "host resolves to a invalid address".to_owned()),
	);
	transport.outcomes.insert(
		"https://d.example.org/".to_owned(),
		(false, "DNS lookup failed: ENOTFOUND".to_owned()),
	);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://a.example.org/to-b", &options(10)).await,
		Err(error(
			SafeFetchErrorCode::UnsafeRedirect,
			"redirect 1 rejected: host resolves to a non-public address"
		))
	);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://c.example.org/", &options(10)).await,
		Err(error(
			SafeFetchErrorCode::UnsafeUrl,
			"host resolves to a invalid address"
		))
	);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://d.example.org/", &options(10)).await,
		Err(error(
			SafeFetchErrorCode::NetworkError,
			"DNS lookup failed: ENOTFOUND"
		))
	);
	assert_eq!(
		fetch_raw_bytes(&transport, "https://localhost/", &options(10)).await,
		Err(error(SafeFetchErrorCode::UnsafeUrl, "HOSTNAME_NOT_ALLOWED"))
	);
	let failing = Scripted::with(&[(
		"https://e.example.org/",
		Page {
			error: Some(BodyError::Failed("ECONNRESET".to_owned())),
			..ok_page(b"partial")
		},
	)]);
	assert_eq!(
		fetch_raw_bytes(&failing, "https://e.example.org/", &options(100)).await,
		Err(error(SafeFetchErrorCode::NetworkError, "ECONNRESET"))
	);
}

#[tokio::test]
async fn decodes_text_like_text_decoder() {
	let transport = Scripted::with(&[(
		"https://a.example.org/",
		Page {
			content_type: Some("text/plain".to_owned()),
			chunks: vec![
				b"\xEF\xBB".to_vec(),
				b"\xBFh\xC3".to_vec(),
				b"\xA9\xFF".to_vec(),
			],
			..ok_page(b"")
		},
	)]);
	let fetcher = SafeFetchCore::new(Arc::new(transport));
	let document = fetcher
		.fetch_text("https://a.example.org/", &options(100))
		.await
		.unwrap();
	assert_eq!(document.text, "h\u{e9}\u{FFFD}");
	assert_eq!(document.content_type.as_deref(), Some("text/plain"));
}

#[test]
fn prints_counts_like_javascript() {
	assert_eq!(js_count(10_000), "10000");
	assert_eq!(js_count(u64::MAX), "18446744073709552000");
	assert_eq!(normalize_host("WWW.Example.ORG."), "www.example.org");
	assert_eq!(normalize_host("a.."), "a.");
}
