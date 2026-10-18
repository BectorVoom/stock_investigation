//! Replays `vectors/pipeline/ingest.json`: the real TypeScript `ingestSources`
//! against scripted fakes, comparing every request a fake received, the
//! order of clock reads, and the whole outcome.
use super::*;
use crate::ports::{NotAFeed, SafeFetchError, SafeFetchErrorCode};
use async_trait::async_trait;
use research_contracts::records::LicensePolicy;
use research_domain::news::raw_feed::{FeedKind, RawFeed, RawFeedItem};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

fn text(value: &Value, key: &str) -> String {
	value
		.get(key)
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_owned()
}
fn optional(value: &Value, key: &str) -> Option<String> {
	value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
	value
		.get(key)
		.and_then(Value::as_array)
		.map_or(&[], Vec::as_slice)
}

fn source(value: &Value) -> SubscribedSourceRef {
	SubscribedSourceRef {
		source_id: text(value, "sourceId"),
		canonical_url: text(value, "canonicalUrl"),
		publisher: text(value, "publisher"),
		title: text(value, "title"),
		license_policy: if text(value, "licensePolicy") == "short-excerpt-permitted" {
			LicensePolicy::ShortExcerptPermitted
		} else {
			LicensePolicy::HeadlineAndLinkOnly
		},
	}
}

fn feed(value: &Value) -> RawFeed {
	RawFeed {
		kind: if text(value, "kind") == "atom" {
			FeedKind::Atom
		} else {
			FeedKind::Rss
		},
		title: optional(value, "title"),
		site_link: optional(value, "siteLink"),
		items: array(value, "items")
			.iter()
			.map(|item| RawFeedItem {
				title: optional(item, "title"),
				link: optional(item, "link"),
				published_text: optional(item, "publishedText"),
				summary_text: optional(item, "summaryText"),
			})
			.collect(),
	}
}

struct Script {
	fetches: Vec<Value>,
	abort_on_fetch: Option<usize>,
	cancel: CancellationToken,
	calls: Mutex<Vec<Value>>,
}

#[async_trait]
impl SafeFetcher for Script {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		let number = {
			let mut calls = self.calls.lock().unwrap();
			calls.push(json!({
				"url": url,
				"maxBytes": options.max_bytes,
				"timeoutMs": options.timeout_ms,
				"accept": options.accept,
				"allowedHosts": options.allowed_hosts.as_ref().map(|hosts| hosts.iter().collect::<Vec<_>>()),
				"hasSignal": options.cancel.is_some(),
			}));
			calls.len()
		};
		if self.abort_on_fetch == Some(number) {
			self.cancel.cancel();
		}
		let scripted = self.fetches.get(number - 1).expect("fetch not scripted");
		if let Some(ok) = scripted.get("ok") {
			Ok(FetchedDocument {
				final_url: text(ok, "finalUrl"),
				content_type: optional(ok, "contentType"),
				text: text(ok, "text"),
			})
		} else {
			let error = scripted.get("err").expect("fetch result");
			let code = [
				SafeFetchErrorCode::UnsafeUrl,
				SafeFetchErrorCode::HostNotAllowed,
				SafeFetchErrorCode::UnsafeRedirect,
				SafeFetchErrorCode::TooManyRedirects,
				SafeFetchErrorCode::RedirectNotAuthorized,
				SafeFetchErrorCode::Timeout,
				SafeFetchErrorCode::HttpError,
				SafeFetchErrorCode::ResponseTooLarge,
				SafeFetchErrorCode::NetworkError,
			]
			.into_iter()
			.find(|code| code.as_str() == text(error, "code"))
			.expect("known code");
			Err(SafeFetchError {
				code,
				detail: text(error, "detail"),
				body: None,
			})
		}
	}
}

struct Parser {
	feeds: HashMap<String, RawFeed>,
	inputs: Mutex<Vec<String>>,
}
impl FeedParser for Parser {
	fn parse(&self, text: &str) -> Result<RawFeed, NotAFeed> {
		self.inputs.lock().unwrap().push(text.to_owned());
		self.feeds.get(text).cloned().ok_or(NotAFeed)
	}
}

struct CountingClock(AtomicU64);
impl Clock for CountingClock {
	fn now_ms(&self) -> i64 {
		0
	}
	fn now_iso(&self) -> String {
		let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
		let epoch = 1_792_195_200_000_i64 + i64::try_from(n).unwrap() * 1000;
		research_js::date::epoch_ms_to_iso(epoch).unwrap()
	}
}

struct Sha;
impl Hasher for Sha {
	fn sha256_hex(&self, text: &str) -> String {
		hex::encode(Sha256::digest(text.as_bytes()))
	}
}

#[tokio::test]
async fn ingest_matches_the_typescript_transcripts() {
	let path = format!(
		"{}/../../vectors/pipeline/ingest.json",
		env!("CARGO_MANIFEST_DIR")
	);
	let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
	assert!(cases.len() >= 160, "only {} ingest cases", cases.len());
	for case in &cases {
		let input = &case["input"];
		let name = text(input, "name");
		let cancel = CancellationToken::new();
		let script = Arc::new(Script {
			fetches: array(input, "fetches").to_vec(),
			abort_on_fetch: input["abortOnFetch"]
				.as_u64()
				.map(|n| usize::try_from(n).unwrap()),
			cancel: cancel.clone(),
			calls: Mutex::new(Vec::new()),
		});
		let parser = Arc::new(Parser {
			feeds: input["feeds"]
				.as_object()
				.unwrap()
				.iter()
				.map(|(k, v)| (k.clone(), feed(v)))
				.collect(),
			inputs: Mutex::new(Vec::new()),
		});
		let clock = Arc::new(CountingClock(AtomicU64::new(0)));
		let deps = IngestDeps {
			fetcher: script.clone(),
			feed_parser: parser.clone(),
			hasher: Arc::new(Sha),
			clock: clock.clone(),
		};
		let sources: Vec<_> = array(input, "sources").iter().map(source).collect();
		let result = ingest_sources(
			&sources,
			&deps,
			IngestOptions {
				cancel,
				max_articles: usize::try_from(input["maxArticles"].as_u64().unwrap()).unwrap(),
			},
		)
		.await;
		let calls = Value::Array(script.calls.lock().unwrap().clone());
		let expected = &case["output"];
		assert_eq!(calls, expected["calls"], "{name}: fetch requests");
		match result {
			Ok(outcome) => {
				assert!(expected.get("threw").is_none(), "{name}: TypeScript threw");
				assert_eq!(
					json!(*parser.inputs.lock().unwrap()),
					expected["parserInputs"],
					"{name}: parser inputs"
				);
				assert_eq!(
					clock.0.load(Ordering::SeqCst),
					expected["clockCalls"].as_u64().unwrap(),
					"{name}: clock reads"
				);
				assert_eq!(
					serde_json::to_value(&outcome).unwrap(),
					expected["outcome"],
					"{name}: outcome"
				);
			}
			Err(error) => {
				assert!(matches!(error, IngestError::InvalidStoredUrl(_)), "{name}");
				assert_eq!(expected["threw"], "TypeError", "{name}");
			}
		}
	}
}

#[tokio::test]
async fn fetch_source_articles_reports_a_non_feed_as_not_a_feed() {
	let deps = IngestDeps {
		fetcher: Arc::new(Script {
			fetches: vec![json!({"ok": {"finalUrl": "u", "contentType": null, "text": "<html>"}})],
			abort_on_fetch: None,
			cancel: CancellationToken::new(),
			calls: Mutex::new(Vec::new()),
		}),
		feed_parser: Arc::new(Parser {
			feeds: HashMap::new(),
			inputs: Mutex::new(Vec::new()),
		}),
		hasher: Arc::new(Sha),
		clock: Arc::new(CountingClock(AtomicU64::new(0))),
	};
	let source = source(&json!({
		"sourceId": "src_1", "canonicalUrl": "https://news.example.com/feed.xml",
		"publisher": "P", "title": "T", "licensePolicy": "headline-and-link-only",
	}));
	let error = fetch_source_articles(&source, &deps, None)
		.await
		.unwrap()
		.unwrap_err();
	assert_eq!(error.code, "NOT_A_FEED");
	assert_eq!(error.detail, "response is not an RSS or Atom feed");
}
