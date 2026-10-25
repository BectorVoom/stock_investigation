//! Concurrency, cancellation, metadata and an opt-in real-network measurement.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]
use async_trait::async_trait;
use research_agent_core::tools::*;
use research_application::ports::*;
use research_js::json;
use research_tools::{
	search::{SearchToolDeps, TokioSleep, create_search_tools},
	web::{WebToolDeps, create_web_tools},
};
use sha2::{Digest, Sha256};
use std::{
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
struct Hash;
impl Hasher for Hash {
	fn sha256_hex(&self, text: &str) -> String {
		format!("{:x}", Sha256::digest(text.as_bytes()))
	}
}
/// Virtual clock on tokio's paused time: sleeps advance it deterministically,
/// so concurrent callers interleave exactly as they would in real time.
struct Time {
	start: tokio::time::Instant,
}
impl Time {
	fn new() -> Self {
		Self {
			start: tokio::time::Instant::now(),
		}
	}
}
impl Clock for Time {
	fn now_ms(&self) -> i64 {
		1_792_195_200_000 + i64::try_from(self.start.elapsed().as_millis()).unwrap()
	}
	fn now_iso(&self) -> String {
		research_js::date::epoch_ms_to_iso(self.now_ms()).unwrap()
	}
}
struct Ids(AtomicUsize);
impl IdAllocator for Ids {
	fn next_id(&self, prefix: &str) -> String {
		format!(
			"run_test_{prefix}{}",
			self.0.fetch_add(1, Ordering::SeqCst) + 1
		)
	}
}
fn context() -> ToolContext {
	ToolContext {
		run_id: "run_test".into(),
		cancel: CancellationToken::new(),
		now_iso: Arc::new(|| "2026-10-17T00:00:00.000Z".into()),
		ids: Arc::new(Ids(AtomicUsize::new(0))),
		subscribed_sources: Arc::from([]),
	}
}
struct Fetch {
	clock: Arc<Time>,
	starts: Mutex<Vec<(String, i64)>>,
}
#[async_trait]
impl SafeFetcher for Fetch {
	async fn fetch_text(
		&self,
		url: &str,
		_: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		self.starts
			.lock()
			.unwrap()
			.push((url.into(), self.clock.now_ms()));
		Ok(FetchedDocument {
			final_url: url.into(),
			content_type: Some("text/plain".into()),
			text: if url.contains("gdelt") {
				"{}".into()
			} else if url.ends_with("robots.txt") {
				"User-agent: *\nAllow: /".into()
			} else {
				"Page text".into()
			},
		})
	}
}
struct Archive(AtomicUsize);

struct UnavailableSearch {
	calls: AtomicUsize,
	error: SafeFetchError,
	cancel_first: bool,
}

#[async_trait]
impl SafeFetcher for UnavailableSearch {
	async fn fetch_text(
		&self,
		url: &str,
		opts: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
			tokio::time::sleep(std::time::Duration::from_secs(15)).await;
			if self.cancel_first {
				opts.cancel.as_ref().unwrap().cancel();
			}
			return Err(self.error.clone());
		}
		Ok(FetchedDocument {
			final_url: url.into(),
			content_type: Some("application/json".into()),
			text: "{}".into(),
		})
	}
}

fn unavailable_search(
	error: SafeFetchError,
	cancel_first: bool,
) -> (Arc<dyn Tool>, Arc<UnavailableSearch>) {
	let fetcher = Arc::new(UnavailableSearch {
		calls: AtomicUsize::new(0),
		error,
		cancel_first,
	});
	let tool = create_search_tools(SearchToolDeps {
		fetcher: fetcher.clone(),
		clock: Arc::new(Time::new()),
		hasher: Arc::new(Hash),
		sleep: Arc::new(TokioSleep),
		tavily_api_key: None,
	})
	.remove(0);
	(tool, fetcher)
}

#[tokio::test(start_paused = true)]
async fn unavailable_search_fails_fast_then_recovers_after_cooldown() {
	for (error, status) in [
		(SafeFetchError::http(429, "HTTP 429", None), Some(429)),
		(SafeFetchError::http(503, "HTTP 503", None), Some(503)),
		(SafeFetchError::http(529, "HTTP 529", None), Some(529)),
		(
			SafeFetchError::new(SafeFetchErrorCode::NetworkError, "connection failed"),
			None,
		),
		(
			SafeFetchError::new(SafeFetchErrorCode::Timeout, "request timed out"),
			None,
		),
	] {
		let (tool, fetcher) = unavailable_search(error, false);
		let start = tokio::time::Instant::now();
		let args = json::parse(r#"{"query":"gold price"}"#).unwrap();
		let failure = tool.execute(args.clone(), context()).await.unwrap_err();
		assert_eq!(failure.code, "SEARCH_FAILED");
		// The provider's status travels unchanged (§4a).
		assert_eq!(failure.upstream_status, status);
		let failed_at = tokio::time::Instant::now();
		assert_eq!(failed_at - start, std::time::Duration::from_secs(15));
		// Different queries hit the same unavailable provider; neither network
		// attempts nor five-second spacing sleeps should be repeated.
		for query in ["battery", "oil", "gold", "copper"] {
			let args = json::Value::Object(json::Object::from_iter([(
				"query".into(),
				json::Value::from(query),
			)]));
			assert_eq!(
				tool.execute(args, context()).await.unwrap_err().code,
				"SEARCH_COOLDOWN"
			);
		}
		assert_eq!(tokio::time::Instant::now(), failed_at);
		assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
		tokio::time::advance(std::time::Duration::from_secs(60)).await;
		assert!(tool.execute(args, context()).await.is_ok());
		assert_eq!(fetcher.calls.load(Ordering::SeqCst), 2);
	}
}

#[tokio::test(start_paused = true)]
async fn query_errors_and_cancellation_do_not_disable_other_searches() {
	for (error, cancel_first) in [
		(SafeFetchError::http(400, "HTTP 400", None), false),
		(
			SafeFetchError::new(SafeFetchErrorCode::Timeout, "cancelled"),
			true,
		),
	] {
		let (tool, fetcher) = unavailable_search(error, cancel_first);
		let args = json::parse(r#"{"query":"gold price"}"#).unwrap();
		assert!(tool.execute(args.clone(), context()).await.is_err());
		assert!(tool.execute(args, context()).await.is_ok());
		assert_eq!(fetcher.calls.load(Ordering::SeqCst), 2);
	}
}

#[tokio::test(start_paused = true)]
async fn cancelled_search_during_cooldown_still_reports_abort() {
	let (tool, fetcher) = unavailable_search(SafeFetchError::http(429, "HTTP 429", None), false);
	let args = json::parse(r#"{"query":"gold price"}"#).unwrap();
	assert!(tool.execute(args.clone(), context()).await.is_err());
	let cancelled = context();
	cancelled.cancel.cancel();
	assert_eq!(
		tool.execute(args, cancelled).await.unwrap_err().code,
		"TOOL_ABORTED"
	);
	assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
}

#[async_trait]
impl PageArchive for Archive {
	async fn save(&self, _: &ArchivedPage) -> Result<String, ArchiveWriteFailed> {
		self.0.fetch_add(1, Ordering::SeqCst);
		Ok("test.md".into())
	}
}
#[tokio::test(start_paused = true)]
async fn concurrent_gdelt_calls_keep_five_second_start_spacing() {
	let time = Arc::new(Time::new());
	let fetcher = Arc::new(Fetch {
		clock: time.clone(),
		starts: Mutex::new(Vec::new()),
	});
	let tool = create_search_tools(SearchToolDeps {
		fetcher: fetcher.clone(),
		clock: time.clone(),
		hasher: Arc::new(Hash),
		sleep: Arc::new(TokioSleep),
		tavily_api_key: None,
	})
	.remove(0);
	let (a, b, c) = tokio::join!(
		tool.execute(json::parse(r#"{"query":"gold"}"#).unwrap(), context()),
		tool.execute(json::parse(r#"{"query":"battery"}"#).unwrap(), context()),
		tool.execute(json::parse(r#"{"query":"oil"}"#).unwrap(), context())
	);
	assert!(a.is_ok() && b.is_ok() && c.is_ok());
	let starts = fetcher
		.starts
		.lock()
		.unwrap()
		.iter()
		.filter(|(url, _)| url.contains("gdelt"))
		.map(|(_, at)| *at)
		.collect::<Vec<_>>();
	assert_eq!(starts.len(), 3);
	assert!(starts.windows(2).all(|pair| pair[1] - pair[0] >= 5000));
}
#[tokio::test(start_paused = true)]
async fn concurrent_page_calls_reserve_different_host_slots() {
	let time = Arc::new(Time::new());
	let fetcher = Arc::new(Fetch {
		clock: time.clone(),
		starts: Mutex::new(Vec::new()),
	});
	let tool = create_web_tools(WebToolDeps {
		fetcher: fetcher.clone(),
		clock: time.clone(),
		hasher: Arc::new(Hash),
		sleep: Arc::new(TokioSleep),
		page_archive: Arc::new(Archive(AtomicUsize::new(0))),
	})
	.remove(0);
	let args = json::parse(r#"{"url":"https://news.synthetic-wire.org/article"}"#).unwrap();
	let (a, b, c) = tokio::join!(
		tool.execute(args.clone(), context()),
		tool.execute(args.clone(), context()),
		tool.execute(args, context())
	);
	assert!(a.is_ok() && b.is_ok() && c.is_ok());
	let starts = fetcher
		.starts
		.lock()
		.unwrap()
		.iter()
		.filter(|(url, _)| !url.ends_with("robots.txt"))
		.map(|(_, at)| *at)
		.collect::<Vec<_>>();
	assert_eq!(starts.len(), 3);
	assert!(starts.windows(2).all(|pair| pair[1] - pair[0] >= 1000));
}
fn gdelt_starts(fetcher: &Fetch) -> Vec<i64> {
	fetcher
		.starts
		.lock()
		.unwrap()
		.iter()
		.filter(|(url, _)| url.contains("gdelt"))
		.map(|(_, at)| *at)
		.collect()
}
fn gdelt_search() -> (Arc<dyn Tool>, Arc<Fetch>) {
	let time = Arc::new(Time::new());
	let fetcher = Arc::new(Fetch {
		clock: time.clone(),
		starts: Mutex::new(Vec::new()),
	});
	let tool = create_search_tools(SearchToolDeps {
		fetcher: fetcher.clone(),
		clock: time,
		hasher: Arc::new(Hash),
		sleep: Arc::new(TokioSleep),
		tavily_api_key: None,
	})
	.remove(0);
	(tool, fetcher)
}
async fn search_after(
	tool: Arc<dyn Tool>,
	delay_ms: u64,
	query: &str,
	cancel: CancellationToken,
) -> Result<ToolOutput, ToolFailure> {
	tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
	let mut ctx = context();
	ctx.cancel = cancel;
	tool.execute(
		json::parse(&format!(r#"{{"query":"{query}"}}"#)).unwrap(),
		ctx,
	)
	.await
}
fn spaced(starts: &[i64], interval: i64) -> bool {
	starts.windows(2).all(|pair| pair[1] - pair[0] >= interval)
}

/// Callers are served first come, first served and starts stay 5 s apart.
#[tokio::test(start_paused = true)]
async fn waiting_callers_are_served_in_arrival_order() {
	let (tool, fetcher) = gdelt_search();
	let queries = ["aa", "bb", "cc", "dd", "ee"];
	let calls = queries.iter().enumerate().map(|(i, q)| {
		search_after(
			tool.clone(),
			u64::try_from(i).unwrap() * 100,
			q,
			CancellationToken::new(),
		)
	});
	let results = futures_util::future::join_all(calls).await;
	assert!(results.iter().all(Result::is_ok));
	let order: Vec<String> = fetcher
		.starts
		.lock()
		.unwrap()
		.iter()
		.filter(|(url, _)| url.contains("gdelt"))
		.map(|(url, _)| url.clone())
		.collect();
	let expected: Vec<bool> = queries
		.iter()
		.zip(&order)
		.map(|(q, url)| url.contains(&format!("query={q}%20")))
		.collect();
	assert!(
		expected.iter().all(|ok| *ok) && order.len() == 5,
		"{order:?}"
	);
	let starts = gdelt_starts(&fetcher);
	assert!(spaced(&starts, 5000), "{starts:?}");
	// Nobody is starved: the fifth caller starts after exactly four intervals.
	assert_eq!(starts[4] - starts[0], 20_000, "{starts:?}");
}

/// A caller cancelled at any instant records nothing and leaves the queue, so
/// the others keep their order and spacing whatever the abort time.
#[tokio::test(start_paused = true)]
async fn aborts_at_every_point_never_break_spacing_or_order() {
	for cancel_at in (0..=26_000_u64).step_by(250) {
		let (tool, fetcher) = gdelt_search();
		let doomed = CancellationToken::new();
		let trigger = doomed.clone();
		let abort = async move {
			tokio::time::sleep(std::time::Duration::from_millis(cancel_at)).await;
			trigger.cancel();
		};
		let (a, b, c, d, e, ()) = tokio::join!(
			search_after(tool.clone(), 0, "p0", CancellationToken::new()),
			search_after(tool.clone(), 1000, "xx", CancellationToken::new()),
			search_after(tool.clone(), 2000, "aa", doomed),
			search_after(tool.clone(), 3000, "yy", CancellationToken::new()),
			search_after(tool.clone(), 10_000, "dd", CancellationToken::new()),
			abort,
		);
		let starts = gdelt_starts(&fetcher);
		assert!(spaced(&starts, 5000), "cancel at {cancel_at}: {starts:?}");
		for survivor in [&a, &b, &d, &e] {
			assert!(survivor.is_ok(), "cancel at {cancel_at}");
		}
		// A cancelled caller either never started or started exactly once.
		assert!(c.is_ok() || c.as_ref().unwrap_err().code == "TOOL_ABORTED");
		let sent = starts.len();
		assert_eq!(sent, 4 + usize::from(c.is_ok()), "cancel at {cancel_at}");
		let order: Vec<String> = fetcher
			.starts
			.lock()
			.unwrap()
			.iter()
			.filter(|(url, _)| url.contains("gdelt"))
			.map(|(url, _)| url.clone())
			.collect();
		let position = |q: &str| {
			order
				.iter()
				.position(|u| u.contains(&format!("query={q}%20")))
		};
		assert!(position("p0") < position("xx") && position("xx") < position("yy"));
	}
}

/// Politeness after a redirect: the redirect's end must not move a host's
/// recorded start back over a later caller's start.
struct RedirectFetch {
	clock: Arc<Time>,
	b_starts: Mutex<Vec<i64>>,
}
#[async_trait]
impl SafeFetcher for RedirectFetch {
	async fn fetch_text(
		&self,
		url: &str,
		opts: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		let document = |final_url: &str, text: &str| {
			Ok(FetchedDocument {
				final_url: final_url.into(),
				content_type: Some("text/plain".into()),
				text: text.into(),
			})
		};
		if url.ends_with("robots.txt") {
			return document(url, "User-agent: *\nAllow: /");
		}
		if url == "https://a.example.org/r" {
			let allowed = opts
				.authorize_redirect
				.as_ref()
				.unwrap()
				.authorize("https://b.example.org/page")
				.await;
			assert!(allowed);
			self.b_starts.lock().unwrap().push(self.clock.now_ms());
			// Body download: the redirect's end comes after later callers reserved.
			tokio::time::sleep(std::time::Duration::from_millis(500)).await;
			return document("https://b.example.org/page", "redirected text");
		}
		self.b_starts.lock().unwrap().push(self.clock.now_ms());
		document(url, "text")
	}
}
#[tokio::test(start_paused = true)]
async fn a_redirects_end_never_rewinds_a_later_politeness_start() {
	let time = Arc::new(Time::new());
	let fetcher = Arc::new(RedirectFetch {
		clock: time.clone(),
		b_starts: Mutex::new(Vec::new()),
	});
	let tool = create_web_tools(WebToolDeps {
		fetcher: fetcher.clone(),
		clock: time,
		hasher: Arc::new(Hash),
		sleep: Arc::new(TokioSleep),
		page_archive: Arc::new(Archive(AtomicUsize::new(0))),
	})
	.remove(0);
	let call = |delay_ms: u64, url: &'static str| {
		let tool = tool.clone();
		async move {
			tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
			tool.execute(
				json::parse(&format!(r#"{{"url":"{url}"}}"#)).unwrap(),
				context(),
			)
			.await
		}
	};
	let (first, second, third) = tokio::join!(
		call(0, "https://a.example.org/r"),
		call(100, "https://b.example.org/x"),
		call(1100, "https://b.example.org/y"),
	);
	assert!(first.is_ok() && second.is_ok() && third.is_ok());
	let starts = fetcher.b_starts.lock().unwrap().clone();
	assert_eq!(starts.len(), 3);
	assert!(spaced(&starts, 1000), "{starts:?}");
}

struct CancelledFetch;
#[async_trait]
impl SafeFetcher for CancelledFetch {
	async fn fetch_text(
		&self,
		url: &str,
		opts: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		if !url.ends_with("robots.txt") {
			opts.cancel.as_ref().unwrap().cancel();
		}
		Ok(FetchedDocument {
			final_url: url.into(),
			content_type: Some("text/html".into()),
			text: if url.ends_with("robots.txt") {
				"User-agent: *\nAllow: /".into()
			} else {
				"<h1>Title</h1><p>Text</p>".into()
			},
		})
	}
}
#[tokio::test]
async fn cancellation_before_conversion_never_reaches_the_archive() {
	let archive = Arc::new(Archive(AtomicUsize::new(0)));
	let tool = create_web_tools(WebToolDeps {
		fetcher: Arc::new(CancelledFetch),
		clock: Arc::new(Time::new()),
		hasher: Arc::new(Hash),
		sleep: Arc::new(TokioSleep),
		page_archive: archive.clone(),
	})
	.remove(0);
	let result = tool
		.execute(
			json::parse(r#"{"url":"https://news.synthetic-wire.org/article"}"#).unwrap(),
			context(),
		)
		.await;
	assert_eq!(result.unwrap_err().code, "TOOL_ABORTED");
	assert_eq!(archive.0.load(Ordering::SeqCst), 0);
}
struct RealTime;
impl Clock for RealTime {
	fn now_ms(&self) -> i64 {
		i64::try_from(
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_millis(),
		)
		.unwrap()
	}
	fn now_iso(&self) -> String {
		research_js::date::epoch_ms_to_iso(self.now_ms()).unwrap()
	}
}
#[tokio::test]
#[ignore = "explicit real-network comparison, up to four GDELT requests"]
async fn measure_real_network_tools() {
	let fetcher = Arc::new(research_net::create_node_safe_fetcher().unwrap());
	let clock = Arc::new(RealTime);
	let hash = Arc::new(Hash);
	let sleep = Arc::new(TokioSleep);
	let directory = tempfile::tempdir().unwrap();
	let search = create_search_tools(SearchToolDeps {
		fetcher: fetcher.clone(),
		clock: clock.clone(),
		hasher: hash.clone(),
		sleep: sleep.clone(),
		tavily_api_key: None,
	})
	.remove(0);
	let web = create_web_tools(WebToolDeps {
		fetcher,
		clock,
		hasher: hash.clone(),
		sleep,
		page_archive: Arc::new(research_net::FilePageArchive::new(directory.path(), hash)),
	})
	.remove(0);
	let mut rows = Vec::new();
	for (kind, input) in [
		("search", "gold price"),
		("search", "battery storage"),
		("search", "gold price"),
		("search", "battery storage"),
		("page", "https://www.rfc-editor.org/rfc/rfc9309.txt"),
		("page", "https://www.rfc-editor.org/rfc/rfc9110.txt"),
		("page", "https://www.iana.org/domains/reserved"),
		("page", "https://www.iana.org/help/example-domains"),
	] {
		let args = json::Value::Object(json::Object::from_iter([(
			if kind == "search" { "query" } else { "url" }.into(),
			json::Value::from(input),
		)]));
		let started = Instant::now();
		let result = if kind == "search" {
			search.execute(args, context()).await
		} else {
			web.execute(args, context()).await
		};
		let status = result.as_ref().map_or_else(|e| e.code.as_str(), |_| "ok");
		let detail = result.as_ref().map_or_else(
			|e| e.detail.clone(),
			|v| {
				v.model_text
					.lines()
					.filter(|line| line.contains("search failed"))
					.collect::<Vec<_>>()
					.join("\n")
			},
		);
		let row = serde_json::json!({"runtime":"Rust","kind":kind,"input":input,"ms":started.elapsed().as_millis(),"status":status,"detail":detail,"evidence":result.as_ref().map_or(0,|v|v.evidence.len())});
		println!("{row}");
		rows.push(row);
	}
	std::fs::write(
		"/tmp/rr-tools-live-rust.json",
		serde_json::to_string_pretty(&rows).unwrap(),
	)
	.unwrap();
}

/// One real request to `api.tavily.com` through the runner's own fetcher: the
/// JSON POST, the pinned host and the `Authorization` header. With
/// `TAVILY_API_KEY` set it expects results; without it a dummy key must be
/// refused with HTTP 401, which pauses the provider so the next call sends nothing.
#[tokio::test]
#[ignore = "explicit real-network check, one Tavily request (one credit with a real key)"]
async fn real_tavily_search_reaches_the_api() {
	let key = std::env::var("TAVILY_API_KEY")
		.ok()
		.filter(|key| !key.trim().is_empty());
	let real_key = key.is_some();
	let tools = create_search_tools(SearchToolDeps {
		fetcher: Arc::new(research_net::create_node_safe_fetcher().unwrap()),
		clock: Arc::new(RealTime),
		hasher: Arc::new(Hash),
		sleep: Arc::new(TokioSleep),
		tavily_api_key: Some(key.unwrap_or_else(|| "tvly-invalid-key-for-test".into())),
	});
	let web = tools
		.iter()
		.find(|tool| tool.meta().tool_id == "web.search")
		.unwrap();
	let args = json::parse(r#"{"query":"Apple quarterly revenue"}"#).unwrap();
	let started = Instant::now();
	let result = web.execute(args.clone(), context()).await;
	println!(
		"{}",
		serde_json::json!({
			"ms": started.elapsed().as_millis(),
			"status": result.as_ref().map_or_else(|e| e.code.clone(), |_| "ok".into()),
			"detail": result.as_ref().map_or_else(|e| e.detail.clone(), |v| v.model_text.lines().take(4).collect::<Vec<_>>().join("\n")),
			"evidence": result.as_ref().map_or(0, |v| v.evidence.len()),
		})
	);
	if real_key {
		assert!(!result.unwrap().evidence.is_empty());
	} else {
		let failure = result.unwrap_err();
		assert_eq!(failure.code, "SEARCH_FAILED");
		assert_eq!(failure.detail, "HTTP_ERROR: HTTP 401");
		let started = Instant::now();
		assert_eq!(
			web.execute(args, context()).await.unwrap_err().code,
			"SEARCH_COOLDOWN"
		);
		assert!(started.elapsed() < std::time::Duration::from_millis(50));
	}
}
