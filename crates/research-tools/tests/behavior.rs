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
			text: if url.contains("gdelt") || url.contains("wikipedia") {
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
		preconnect: None,
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
		preconnect: Some(fetcher.clone()),
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
