//! Replays `vectors/finance/edinet_index.json` (ADR-0058 §4), written by
//! Node from the TypeScript index (`scripts/vectors/finance/edinetIndex.ts`):
//! the day-row mapping (`edinetIndexDocument`), a day's list
//! (`edinetIndexDay`) and whole `edinet-index` source runs over a URL-keyed
//! scripted transport — the same requests (URL and fetch options), as many
//! pacing grants, and the same result.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use research_application::ports::{
	FetchedDocument, SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use research_contracts::edinet_index::limits;
use research_finance::edinet_documents::{EdinetAnnualRow, EdinetListProblem};
use research_finance::edinet_index::{
	EdinetIndex, EdinetIndexDayProblem, EdinetIndexQuery, EdinetIndexSource, edinet_index_day,
	edinet_index_document,
};
use research_finance::ports::{BeforeRequest, Secret};
use serde_json::{Value as Json, json};
use tokio_util::sync::CancellationToken;

fn root() -> std::path::PathBuf {
	std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture_text(name: &str) -> String {
	std::fs::read_to_string(root().join("examples/fixtures/equity-sync").join(name)).unwrap()
}

fn load() -> Json {
	let path = root().join("vectors/finance/edinet_index.json");
	serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `generatedList(count)`: `count` distinct period-less amendments of one filer.
fn generated_list(count: usize) -> String {
	let rows: Vec<String> = (0..count)
		.map(|index| {
			format!(
				r#"{{"docID":"S{index:07}","edinetCode":"E99991","secCode":"99990","filerName":"名","docTypeCode":"130","submitDateTime":"2025-06-20 15:00","withdrawalStatus":"0","csvFlag":"1"}}"#
			)
		})
		.collect();
	format!(
		r#"{{"metadata":{{"status":"200"}},"results":[{}]}}"#,
		rows.join(",")
	)
}

fn count_of(value: &Json) -> usize {
	usize::try_from(value.as_u64().unwrap()).unwrap()
}

/// A list input: a fixture file, an inline value or a generated list.
fn list_of(input: &Json) -> research_js::json::Value {
	let text = if let Some(name) = input.get("fixture").and_then(Json::as_str) {
		fixture_text(name)
	} else if let Some(count) = input.get("generated") {
		generated_list(count_of(count))
	} else {
		input["inline"].to_string()
	};
	research_js::json::parse(&text).unwrap()
}

fn day_problem(problem: EdinetIndexDayProblem) -> Json {
	match problem {
		EdinetIndexDayProblem::List(EdinetListProblem::Parse) => json!({ "kind": "parse" }),
		EdinetIndexDayProblem::List(EdinetListProblem::Status(status)) => {
			json!({ "kind": "status", "status": status })
		}
		EdinetIndexDayProblem::TooMany => json!({ "kind": "too-many" }),
	}
}

fn report(failures: &[String], total: usize) {
	assert!(
		failures.is_empty(),
		"{} of {total} cases differ:\n{}",
		failures.len(),
		failures
			.iter()
			.take(6)
			.map(|failure| failure.chars().take(1_500).collect::<String>())
			.collect::<Vec<_>>()
			.join("\n")
	);
}

#[test]
fn the_limits_are_the_typescript_ones() {
	let file = load();
	assert_eq!(
		file["limits"],
		json!({
			"maxDaysPerJob": limits::MAX_DAYS_PER_JOB,
			"maxDocumentsPerDay": limits::MAX_DOCUMENTS_PER_DAY,
			"maxFilerNameChars": limits::MAX_FILER_NAME_CHARS,
		})
	);
}

#[test]
fn the_day_row_mapping_matches_typescript() {
	let file = load();
	let cases = file["edinetIndexDocument"].as_array().unwrap();
	assert!(cases.len() >= 30);
	let mut failures = Vec::new();
	for case in cases {
		let row: EdinetAnnualRow = serde_json::from_value(case["row"].clone()).unwrap();
		let actual = serde_json::to_value(edinet_index_document(&row)).unwrap();
		if actual != case["output"] {
			failures.push(format!(
				"{}\n   rust:       {actual}\n   typescript: {}",
				case["row"], case["output"]
			));
		}
	}
	report(&failures, cases.len());
}

#[test]
fn a_days_list_matches_typescript() {
	let file = load();
	let cases = file["edinetIndexDay"].as_array().unwrap();
	assert!(cases.len() >= 15);
	let mut failures = Vec::new();
	for case in cases {
		let input = &case["list"];
		let actual = match edinet_index_day(&list_of(input)) {
			Ok(day) if input.get("generated").is_some() => json!({
				"ok": { "documentCount": day.documents.len(), "dropped": day.dropped }
			}),
			Ok(day) => json!({ "ok": day }),
			Err(problem) => json!({ "err": day_problem(problem) }),
		};
		if actual != case["output"] {
			failures.push(format!(
				"{input}\n   rust:       {actual}\n   typescript: {}",
				case["output"]
			));
		}
	}
	report(&failures, cases.len());
}

/* ---------- whole source runs ---------- */

#[derive(Clone)]
enum Answer {
	Text(String),
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
		return Answer::Text(fixture_text(name));
	}
	if let Some(text) = value.get("text").and_then(Json::as_str) {
		return Answer::Text(text.to_owned());
	}
	if let Some(count) = value.get("generated") {
		return Answer::Text(generated_list(count_of(count)));
	}
	Answer::Error(fetch_error(&value["error"]))
}

/// Answers by URL (anything unscripted is HTTP 404) and records each call
/// as `normalizeCall` does.
struct Scripted {
	answers: HashMap<String, Answer>,
	calls: Mutex<Vec<Json>>,
}

#[async_trait]
impl SafeFetcher for Scripted {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
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
			"kind": "text",
		}));
		match self.answers.get(url).cloned() {
			Some(Answer::Text(text)) => Ok(FetchedDocument {
				final_url: url.to_owned(),
				content_type: Some("application/json".to_owned()),
				text,
			}),
			Some(Answer::Error(error)) => Err(error),
			None => Err(SafeFetchError::http(404, "HTTP 404", None)),
		}
	}
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

#[tokio::test]
async fn whole_index_runs_match_typescript() {
	let file = load();
	let scenarios = file["sources"].as_array().unwrap();
	assert!(scenarios.len() >= 20);
	let mut failures = Vec::new();
	for scenario in scenarios {
		let name = scenario["name"].as_str().unwrap();
		let transport = std::sync::Arc::new(Scripted {
			answers: scenario["answers"]
				.as_array()
				.unwrap()
				.iter()
				.map(|pair| (pair[0].as_str().unwrap().to_owned(), answer_of(&pair[1])))
				.collect(),
			calls: Mutex::new(Vec::new()),
		});
		let source = EdinetIndex::new(
			std::sync::Arc::clone(&transport) as std::sync::Arc<dyn SafeFetcher>,
			scenario["credential"].as_str().map(Secret::new),
		);
		let grants = Grants {
			answers: scenario["grants"]
				.as_array()
				.unwrap()
				.iter()
				.map(|grant| grant.as_bool().unwrap())
				.collect(),
			asked: AtomicUsize::new(0),
		};
		let days: Vec<String> = serde_json::from_value(scenario["days"].clone()).unwrap();
		let cancel = CancellationToken::new();
		let result = source
			.list(EdinetIndexQuery {
				days: &days,
				cancel: &cancel,
				before_request: &grants,
			})
			.await;
		let result = match result {
			Ok(data) => json!({ "ok": {
				"days": data.days,
				"failedDays": data.failed_days.iter().map(|day| json!({
					"date": day.date,
					"code": day.code.as_str(),
					"upstreamStatus": day.upstream_status,
				})).collect::<Vec<_>>(),
				"skippedDays": data.skipped_days,
				"droppedRows": data.dropped_rows,
				"requests": data.requests,
			}}),
			Err(failure) => json!({ "err": {
				"code": failure.code.as_str(),
				"upstreamStatus": failure.upstream_status,
				"requests": failure.requests,
			}}),
		};
		let actual = json!({
			"requests": *transport.calls.lock().unwrap(),
			"grants": grants.asked.load(Ordering::SeqCst),
			"result": result,
		});
		if actual != scenario["output"] {
			failures.push(format!(
				"{name}\n   rust:       {actual}\n   typescript: {}",
				scenario["output"]
			));
		}
	}
	report(&failures, scenarios.len());
}
