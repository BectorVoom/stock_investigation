//! Replays every real TypeScript tool transcript, including all boundary calls.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]
use async_trait::async_trait;
use research_agent_core::tools::*;
use research_application::ports::*;
use research_contracts::jobs::SubscribedSourceRef;
use research_js::json;
use research_tools::{
	news::{NewsToolDeps, create_news_tools},
	robots::*,
	search::{SearchToolDeps, Sleep, create_search_tools},
	web::{WebToolDeps, create_web_tools},
};
use serde_json::{Value, json};
use std::{
	collections::VecDeque,
	sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

struct Script {
	value: Value,
	fetched: Mutex<Vec<bool>>,
	hashes: Mutex<Vec<bool>>,
	clock: Mutex<VecDeque<i64>>,
	sleeps: Mutex<VecDeque<Value>>,
	archives: Mutex<VecDeque<Value>>,
}
fn code(text: &str) -> SafeFetchErrorCode {
	match text {
		"UNSAFE_URL" => SafeFetchErrorCode::UnsafeUrl,
		"HOST_NOT_ALLOWED" => SafeFetchErrorCode::HostNotAllowed,
		"UNSAFE_REDIRECT" => SafeFetchErrorCode::UnsafeRedirect,
		"TOO_MANY_REDIRECTS" => SafeFetchErrorCode::TooManyRedirects,
		"REDIRECT_NOT_AUTHORIZED" => SafeFetchErrorCode::RedirectNotAuthorized,
		"TIMEOUT" => SafeFetchErrorCode::Timeout,
		"HTTP_ERROR" => SafeFetchErrorCode::HttpError,
		"RESPONSE_TOO_LARGE" => SafeFetchErrorCode::ResponseTooLarge,
		"NETWORK_ERROR" => SafeFetchErrorCode::NetworkError,
		_ => panic!("unknown code {text}"),
	}
}
fn js(value: &Value) -> json::Value {
	json::parse(&value.to_string()).unwrap()
}
fn document(value: &Value) -> Result<FetchedDocument, SafeFetchError> {
	if value["ok"] == true {
		let v = &value["value"];
		Ok(FetchedDocument {
			final_url: v["finalUrl"].as_str().unwrap().into(),
			content_type: v["contentType"].as_str().map(str::to_owned),
			text: v["text"].as_str().unwrap().into(),
		})
	} else {
		let e = &value["error"];
		Err(SafeFetchError {
			code: code(e["code"].as_str().unwrap()),
			detail: e["detail"].as_str().unwrap().into(),
			body: e["body"].as_str().map(str::to_owned),
		})
	}
}
#[async_trait]
impl SafeFetcher for Script {
	async fn fetch_text(
		&self,
		url: &str,
		opts: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		let (index, entry) = {
			let mut used = self.fetched.lock().unwrap();
			let rows = self.value["fetches"].as_array().unwrap();
			// Fetches must arrive in the order the TypeScript made them.
			let index = used
				.iter()
				.position(|taken| !taken)
				.unwrap_or_else(|| panic!("unexpected extra fetch {url}"));
			assert_eq!(rows[index]["url"], url, "fetch {index} out of order");
			used[index] = true;
			(index, rows[index].clone())
		};
		let actual = json!({"maxBytes":opts.max_bytes,"timeoutMs":opts.timeout_ms,"accept":opts.accept,"allowedHosts":opts.allowed_hosts.as_ref().map(|h|h.iter().collect::<Vec<_>>()),"userAgent":opts.user_agent,"authorizeRedirect":opts.authorize_redirect.is_some(),"authorization":opts.authorization,"jsonBody":opts.json_body});
		assert_eq!(actual, entry["options"], "fetch {index} {url}");
		assert!(opts.finnhub_token.is_none() && !opts.include_error_body);
		assert!(opts.cancel.is_some());
		for redirect in entry["redirects"].as_array().unwrap() {
			let allowed = opts
				.authorize_redirect
				.as_ref()
				.unwrap()
				.authorize(redirect["url"].as_str().unwrap())
				.await;
			assert_eq!(allowed, redirect["output"].as_bool().unwrap());
		}
		if entry["aborted"] == true {
			opts.cancel.as_ref().unwrap().cancel();
		}
		document(&entry["output"])
	}
}
impl Hasher for Script {
	fn sha256_hex(&self, text: &str) -> String {
		let mut used = self.hashes.lock().unwrap();
		let rows = self.value["hashes"].as_array().unwrap();
		let index = rows
			.iter()
			.enumerate()
			.position(|(i, row)| !used[i] && row["text"] == text)
			.unwrap_or_else(|| panic!("unexpected hash input {text:?}"));
		used[index] = true;
		rows[index]["output"].as_str().unwrap().into()
	}
}
impl Clock for Script {
	fn now_ms(&self) -> i64 {
		self.clock
			.lock()
			.unwrap()
			.pop_front()
			.expect("unexpected clock read")
	}
	fn now_iso(&self) -> String {
		panic!("dependency nowIso is not used by tools")
	}
}
#[async_trait]
impl Sleep for Script {
	async fn sleep(&self, ms: u64, cancel: &CancellationToken) {
		let expected = self
			.sleeps
			.lock()
			.unwrap()
			.pop_front()
			.expect("unexpected sleep");
		assert_eq!(ms, expected["ms"].as_u64().unwrap());
		if expected["aborted"] == true {
			cancel.cancel();
		}
	}
}
#[async_trait]
impl PageArchive for Script {
	async fn save(&self, page: &ArchivedPage) -> Result<String, ArchiveWriteFailed> {
		let entry = self
			.archives
			.lock()
			.unwrap()
			.pop_front()
			.expect("unexpected archive save");
		let omitted = page.omitted.unwrap_or_default();
		let actual = json!({"sourceUrl":page.source_url,"finalUrl":page.final_url,"title":page.title,"retrievedAt":page.retrieved_at,"markdown":page.markdown,"omitted":{"boilerplateBlocks":omitted.boilerplate_blocks,"menuLists":omitted.menu_lists,"leadingBlocks":omitted.leading_blocks}});
		assert_eq!(actual, entry["page"]);
		if entry["output"]["ok"] == true {
			Ok(entry["output"]["value"]["fileName"]
				.as_str()
				.unwrap()
				.into())
		} else {
			Err(ArchiveWriteFailed {
				detail: entry["output"]["error"]["detail"].as_str().unwrap().into(),
			})
		}
	}
}
struct Ids(Mutex<VecDeque<Value>>);
impl IdAllocator for Ids {
	fn next_id(&self, prefix: &str) -> String {
		let entry = self.0.lock().unwrap().pop_front().expect("unexpected id");
		assert_eq!(prefix, entry["prefix"]);
		entry["output"].as_str().unwrap().into()
	}
}
fn output(result: Result<ToolOutput, ToolFailure>) -> Value {
	match result {
		Err(e) => {
			json!({"ok":false,"error":{"code":e.code,"detail":e.detail,"retryable":e.retryable}})
		}
		Ok(v) => {
			json!({"ok":true,"value":{"modelText":v.model_text,"evidence":v.evidence.iter().map(|c|json!({"evidence":c.evidence,"retrievedText":c.retrieved_text,"retainQuotes":c.retain_quotes})).collect::<Vec<_>>(),"securities":v.securities,"financialObservations":v.financial_observations,"positionObservations":v.position_observations,"investorFilings":v.investor_filings,"articles":v.articles}})
		}
	}
}
fn queue(value: &Value, key: &str) -> VecDeque<Value> {
	value[key].as_array().unwrap().iter().cloned().collect()
}
async fn transcript(value: Value) {
	let script = Arc::new(Script {
		fetched: Mutex::new(vec![false; value["fetches"].as_array().unwrap().len()]),
		hashes: Mutex::new(vec![false; value["hashes"].as_array().unwrap().len()]),
		clock: Mutex::new(
			value["milliseconds"]
				.as_array()
				.unwrap()
				.iter()
				.map(|v| v.as_i64().unwrap())
				.collect(),
		),
		sleeps: Mutex::new(queue(&value, "sleeps")),
		archives: Mutex::new(queue(&value, "archives")),
		value: value.clone(),
	});
	let tools = match value["kind"].as_str().unwrap() {
		"news" => create_news_tools(NewsToolDeps {
			fetcher: script.clone(),
			hasher: script.clone(),
			clock: script.clone(),
			feed_parser: Arc::new(research_feed::FastXmlFeedParser),
		}),
		"search" => create_search_tools(SearchToolDeps {
			fetcher: script.clone(),
			hasher: script.clone(),
			clock: script.clone(),
			sleep: script.clone(),
			tavily_api_key: value["tavilyApiKey"].as_str().map(str::to_owned),
		}),
		"web" => create_web_tools(WebToolDeps {
			fetcher: script.clone(),
			hasher: script.clone(),
			clock: script.clone(),
			sleep: script.clone(),
			page_archive: script.clone(),
		}),
		other => panic!("unknown factory {other}"),
	};
	for call in value["calls"].as_array().unwrap() {
		let times = Arc::new(Mutex::new(queue(call, "times")));
		let ids = Arc::new(Ids(Mutex::new(queue(call, "ids"))));
		let cancel = CancellationToken::new();
		if call["cancelled"] == true {
			cancel.cancel();
		}
		let sources = call["sources"]
			.as_array()
			.unwrap()
			.iter()
			.map(|v| research_contracts::parse::<SubscribedSourceRef>(&v.to_string()).unwrap())
			.collect::<Vec<_>>();
		let clock = times.clone();
		let context = ToolContext {
			run_id: "run_test".into(),
			cancel,
			now_iso: Arc::new(move || {
				clock
					.lock()
					.unwrap()
					.pop_front()
					.expect("unexpected nowIso")
					.as_str()
					.unwrap()
					.into()
			}),
			ids: ids.clone(),
			subscribed_sources: sources.into(),
		};
		let tool = tools
			.iter()
			.find(|tool| tool.meta().tool_id == call["toolId"].as_str().unwrap())
			.unwrap();
		let result = output(tool.execute(js(&call["args"]), context).await);
		assert_eq!(
			result,
			call["output"],
			"{} args {}",
			tool.meta().tool_id,
			call["args"]
		);
		assert!(ids.0.lock().unwrap().is_empty() && times.lock().unwrap().is_empty());
	}
	assert!(script.fetched.lock().unwrap().iter().all(|v| *v));
	assert!(script.hashes.lock().unwrap().iter().all(|v| *v));
	assert!(
		script.clock.lock().unwrap().is_empty(),
		"unused clock reads"
	);
	assert!(script.sleeps.lock().unwrap().is_empty());
	assert!(script.archives.lock().unwrap().is_empty());
}
fn files(prefix: &str) -> Vec<std::path::PathBuf> {
	let directory = format!("{}/../../vectors/tools", env!("CARGO_MANIFEST_DIR"));
	let mut files = std::fs::read_dir(directory)
		.unwrap()
		.map(|f| f.unwrap().path())
		.filter(|p| p.file_name().unwrap().to_str().unwrap().starts_with(prefix))
		.collect::<Vec<_>>();
	files.sort();
	files
}
#[tokio::test]
async fn tools_match_every_typescript_boundary_and_output() {
	let mut count = 0;
	for path in files("transcripts-") {
		let rows: Vec<Value> =
			serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
		for (index, row) in rows.into_iter().enumerate() {
			eprintln!("{} case {index}", path.display());
			transcript(row).await;
			count += 1;
		}
	}
	assert!(count >= 350, "only {count} transcripts");
}
#[test]
fn robots_match_typescript() {
	let mut count = 0;
	for path in files("robots-") {
		let rows: Vec<Value> =
			serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
		for row in rows {
			let input = &row["input"];
			let actual = match row["kind"].as_str().unwrap() {
				"robots-parse" => serde_json::to_value(parse_robots_txt(
					input["text"].as_str().unwrap(),
					input["token"].as_str().unwrap(),
				))
				.unwrap(),
				"robots-normalize" => json!(normalize_robots_path(input.as_str().unwrap())),
				"robots-allowed" => json!(is_path_allowed(
					&serde_json::from_value(input["rules"].clone()).unwrap(),
					input["path"].as_str().unwrap()
				)),
				other => panic!("unknown robot case {other}"),
			};
			assert_eq!(actual, row["output"], "{input}");
			count += 1;
		}
	}
	assert!(count >= 1000);
}

/// A clock frozen at the instant the model's operation names.
struct FrozenClock(i64);
impl Clock for FrozenClock {
	fn now_ms(&self) -> i64 {
		self.0
	}
	fn now_iso(&self) -> String {
		panic!("not used")
	}
}
/// A caller whose window is closed gives up instead of waiting: the model's
/// refused claim (it records nothing).
struct GiveUp;
#[async_trait]
impl Sleep for GiveUp {
	async fn sleep(&self, _: u64, cancel: &CancellationToken) {
		cancel.cancel();
	}
}

/// The verified Lean model (`formal/ResearchFormal/Spacing.lean`) against the
/// real claim path, `await_slot` with its retry loop and ticket queue: every
/// operation sequence of length 0..3. A refused claim is a caller that gives
/// up at its first wait, so it must leave no record.
#[tokio::test]
async fn spacing_ledger_matches_the_lean_model() {
	use research_tools::search::{Ledger, await_slot};
	let path = format!("{}/../../formal/vectors.json", env!("CARGO_MANIFEST_DIR"));
	let all: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
	let cases = all["spacing"].as_array().unwrap();
	assert!(cases.len() >= 1885);
	for case in cases {
		let interval = case["interval"].as_i64().unwrap();
		let ledger = Ledger::new(interval, 8);
		let mut starts = Vec::new();
		let mut outcomes = Vec::new();
		for op in case["ops"].as_array().unwrap() {
			let time = op[1].as_i64().unwrap_or(0);
			match op[0].as_str().unwrap() {
				"claim" => {
					let started = await_slot(
						&ledger,
						"k",
						&FrozenClock(time),
						&GiveUp,
						&CancellationToken::new(),
						false,
					)
					.await;
					outcomes.push(json!(started));
					if started {
						starts.insert(0, time);
					}
				}
				"note" => {
					ledger.note("k", time);
					outcomes.push(Value::Null);
				}
				other => panic!("unknown op {other}"),
			}
		}
		// The recorded start is observable as the wait of a far-past reader.
		let far_past = -1_000_000;
		let wait = ledger.peek_wait("k", far_past);
		let last = (wait > 0).then(|| far_past + wait - interval);
		assert_eq!(json!(outcomes), case["outcomes"], "{case}");
		assert_eq!(json!(starts), case["starts"], "{case}");
		assert_eq!(json!(last), case["last"], "{case}");
	}
}
