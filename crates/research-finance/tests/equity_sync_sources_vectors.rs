//! Replays `vectors/finance/equity_sync_sources.json` (ADR-0048): whole
//! SEC and EDINET source runs over a URL-keyed scripted transport, written by
//! Node from the TypeScript sources. Each run must send the same requests
//! (URL and fetch options), ask the pacing gate as often, and give the same
//! result; the SEC runs go through the real paced SEC client.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine;
use research_application::ports::{
	BinaryDocument, Clock, FetchedDocument, SafeBinaryFetcher, SafeFetchError, SafeFetchErrorCode,
	SafeFetchOptions, SafeFetcher,
};
use research_contracts::equity_financials::{EquityMarket, EquitySyncClaim, EquitySyncRequest};
use research_finance::edinet_sync::EdinetSource;
use research_finance::equity_sync::{EquitySyncQuery, EquitySyncSource};
use research_finance::ports::{BeforeRequest, Secret, Sleeper};
use research_finance::sec_annual::SecAnnualFilingsSource;
use research_finance::sec_client::{PacedSecClient, SecClient};
use serde_json::{Value as Json, json};
use tokio_util::sync::CancellationToken;

fn root() -> std::path::PathBuf {
	std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn js(value: &Json) -> research_js::json::Value {
	research_js::json::parse(&value.to_string()).unwrap()
}

/* ---------- the scripted transport ---------- */

#[derive(Clone)]
enum Answer {
	Text(String),
	Bytes(Vec<u8>),
	Error(SafeFetchError),
}

fn fetch_error(value: &Json) -> SafeFetchError {
	let codes = [
		SafeFetchErrorCode::UnsafeUrl,
		SafeFetchErrorCode::HostNotAllowed,
		SafeFetchErrorCode::UnsafeRedirect,
		SafeFetchErrorCode::TooManyRedirects,
		SafeFetchErrorCode::RedirectNotAuthorized,
		SafeFetchErrorCode::Timeout,
		SafeFetchErrorCode::HttpError,
		SafeFetchErrorCode::ResponseTooLarge,
		SafeFetchErrorCode::NetworkError,
	];
	let name = value["code"].as_str().unwrap();
	let code = codes
		.into_iter()
		.find(|code| code.as_str() == name)
		.unwrap();
	let detail = value["detail"].as_str().unwrap_or("");
	match value.get("status").and_then(Json::as_u64) {
		Some(status) if code == SafeFetchErrorCode::HttpError => {
			SafeFetchError::http(u16::try_from(status).unwrap(), detail, None)
		}
		Some(status) => SafeFetchError::answered(code, u16::try_from(status).unwrap(), detail),
		None => SafeFetchError::new(code, detail),
	}
}

fn answer_of(value: &Json) -> Answer {
	if let Some(name) = value.get("fixture").and_then(Json::as_str) {
		let path = root().join("examples/fixtures/equity-sync").join(name);
		return if name.ends_with(".zip") {
			Answer::Bytes(std::fs::read(path).unwrap())
		} else {
			Answer::Text(std::fs::read_to_string(path).unwrap())
		};
	}
	if let Some(text) = value.get("text").and_then(Json::as_str) {
		return Answer::Text(text.to_owned());
	}
	if let Some(encoded) = value.get("base64").and_then(Json::as_str) {
		return Answer::Bytes(
			base64::engine::general_purpose::STANDARD
				.decode(encoded)
				.unwrap(),
		);
	}
	Answer::Error(fetch_error(&value["error"]))
}

/// Answers by URL (anything unscripted is HTTP 404) and records each call
/// as `normalizeCall` does.
struct Scripted {
	answers: HashMap<String, Answer>,
	calls: Mutex<Vec<Json>>,
}

impl Scripted {
	fn record(&self, url: &str, options: &SafeFetchOptions, kind: &str) -> Answer {
		let mut hosts: Option<Vec<String>> = options
			.allowed_hosts
			.as_ref()
			.map(|hosts| hosts.iter().cloned().collect());
		if let Some(hosts) = hosts.as_mut() {
			hosts.sort();
		}
		self.calls.lock().unwrap().push(json!({
			"url": url,
			"accept": options.accept,
			"maxBytes": options.max_bytes,
			"timeoutMs": options.timeout_ms,
			"allowedHosts": hosts,
			"userAgent": options.user_agent,
			"authorization": options.authorization,
			"finnhubToken": options.finnhub_token,
			"includeErrorBody": options.include_error_body,
			"hasSignal": options.cancel.is_some(),
			"kind": kind,
		}));
		self.answers
			.get(url)
			.cloned()
			.unwrap_or_else(|| Answer::Error(SafeFetchError::http(404, "HTTP 404", None)))
	}
}

#[async_trait]
impl SafeFetcher for Scripted {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		match self.record(url, options, "text") {
			Answer::Text(text) => Ok(FetchedDocument {
				final_url: url.to_owned(),
				content_type: Some("application/json".to_owned()),
				text,
			}),
			Answer::Bytes(_) => Err(SafeFetchError::new(
				SafeFetchErrorCode::NetworkError,
				"bytes for text",
			)),
			Answer::Error(error) => Err(error),
		}
	}
}

#[async_trait]
impl SafeBinaryFetcher for Scripted {
	async fn fetch_bytes(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<BinaryDocument, SafeFetchError> {
		match self.record(url, options, "bytes") {
			Answer::Text(text) => Ok(BinaryDocument {
				final_url: url.to_owned(),
				content_type: None,
				bytes: text.into_bytes(),
			}),
			Answer::Bytes(bytes) => Ok(BinaryDocument {
				final_url: url.to_owned(),
				content_type: None,
				bytes,
			}),
			Answer::Error(error) => Err(error),
		}
	}
}

struct VectorClock(AtomicI64);

impl Clock for VectorClock {
	fn now_ms(&self) -> i64 {
		self.0.load(Ordering::SeqCst)
	}
	fn now_iso(&self) -> String {
		research_js::date::epoch_ms_to_iso(self.now_ms()).unwrap()
	}
}

/// The TypeScript's `sleep: async () => {}`.
struct NoSleep;

#[async_trait]
impl Sleeper for NoSleep {
	async fn sleep(&self, _ms: u64, _cancel: Option<&CancellationToken>) {}
}

/// Answers the scripted grants in order (true once they are used up).
struct Grants {
	answers: Vec<bool>,
	asked: AtomicUsize,
}

#[async_trait]
impl BeforeRequest for Grants {
	async fn before_request(&self) -> bool {
		let index = self.asked.fetch_add(1, Ordering::SeqCst);
		self.answers.get(index).copied().unwrap_or(true)
	}
}

fn claim_of(target: &Json) -> EquitySyncClaim {
	EquitySyncClaim {
		company_id: target["companyId"].as_str().unwrap().to_owned(),
		market: EquityMarket::from_str_value(target["market"].as_str().unwrap()).unwrap(),
		symbol: target["symbol"].as_str().unwrap().to_owned(),
		concepts: target["concepts"]
			.as_array()
			.unwrap()
			.iter()
			.map(|concept| concept.as_str().unwrap().to_owned())
			.collect(),
		source: research_contracts::validate::<EquitySyncRequest>(&js(&target["source"])).unwrap(),
	}
}

#[tokio::test]
async fn whole_source_runs_match_typescript() {
	let path = root().join("vectors/finance/equity_sync_sources.json");
	let file: Json = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
	let start = file["startMs"].as_i64().unwrap();
	let scenarios = file["scenarios"].as_array().unwrap();
	assert!(scenarios.len() >= 40);
	let mut failures = Vec::new();
	let mut runs = 0;
	for scenario in scenarios {
		let name = scenario["name"].as_str().unwrap();
		let answers = scenario["answers"]
			.as_array()
			.unwrap()
			.iter()
			.map(|pair| (pair[0].as_str().unwrap().to_owned(), answer_of(&pair[1])))
			.collect();
		let transport = Arc::new(Scripted {
			answers,
			calls: Mutex::new(Vec::new()),
		});
		let clock = Arc::new(VectorClock(AtomicI64::new(start)));
		let credential = scenario["credential"].as_str();
		let source: Box<dyn EquitySyncSource> = if scenario["provider"] == "sec" {
			let client: Arc<dyn SecClient> = Arc::new(PacedSecClient::new(
				Arc::clone(&transport) as Arc<dyn SafeFetcher>,
				Arc::clone(&clock) as Arc<dyn Clock>,
				Arc::new(NoSleep),
				credential.map(str::to_owned),
			));
			Box::new(SecAnnualFilingsSource::new(
				client,
				Arc::clone(&clock) as Arc<dyn Clock>,
				credential,
			))
		} else {
			Box::new(EdinetSource::new(
				Arc::clone(&transport) as Arc<dyn SafeFetcher>,
				Arc::clone(&transport) as Arc<dyn SafeBinaryFetcher>,
				credential.map(Secret::new),
				Arc::clone(&clock) as Arc<dyn Clock>,
			))
		};
		let jobs = scenario["jobs"].as_array().unwrap();
		let expected_runs = scenario["runs"].as_array().unwrap();
		for (index, (job, expected)) in jobs.iter().zip(expected_runs).enumerate() {
			runs += 1;
			clock
				.0
				.fetch_add(job["advanceMs"].as_i64().unwrap(), Ordering::SeqCst);
			transport.calls.lock().unwrap().clear();
			let grants = Grants {
				answers: job["grants"]
					.as_array()
					.unwrap()
					.iter()
					.map(|grant| grant.as_bool().unwrap())
					.collect(),
				asked: AtomicUsize::new(0),
			};
			let claim = claim_of(&job["target"]);
			let cancel = CancellationToken::new();
			let result = source
				.sync(EquitySyncQuery {
					target: &claim,
					cancel: &cancel,
					before_request: &grants,
				})
				.await;
			let actual = json!({
				"requests": *transport.calls.lock().unwrap(),
				"grants": grants.asked.load(Ordering::SeqCst),
				"result": match result {
					Ok(data) => json!({ "ok": data }),
					Err(failure) => json!({ "err": failure }),
				},
			});
			if &actual != expected {
				failures.push(format!(
					"{name} (job {index})\n   rust:       {}\n   typescript: {}",
					truncate(&actual.to_string()),
					truncate(&expected.to_string())
				));
			}
		}
	}
	assert!(runs >= 50, "only {runs} runs");
	assert!(
		failures.is_empty(),
		"{} of {runs} runs differ:\n{}",
		failures.len(),
		failures
			.iter()
			.take(6)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n")
	);
}

fn truncate(text: &str) -> String {
	if text.chars().count() > 900 {
		format!("{}…", text.chars().take(900).collect::<String>())
	} else {
		text.to_owned()
	}
}
