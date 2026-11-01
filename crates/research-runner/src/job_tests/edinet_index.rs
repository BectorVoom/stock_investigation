//! `edinet-index` jobs through the shell (ADR-0058 §4; port of the
//! TypeScript runner's edinet-index tests): the real index source over a
//! fake transport serving `examples/fixtures/equity-sync` lists, the
//! completion or failure the Worker receives, the request counts and the log
//! events; and the job body replayed from `vectors/finance/edinet_index.json`.

use std::path::PathBuf;
use std::sync::Mutex;

use research_contracts::edinet_index::{EdinetIndexDayResult, EdinetIndexDocument};
use research_contracts::equity_financials::EquitySyncFailureCode;
use research_finance::edinet_index::{
	EdinetIndex, EdinetIndexData, EdinetIndexDayFailure, EdinetIndexQuery, EdinetIndexSource,
};
use research_finance::equity_sync::EquitySyncFailure;
use research_finance::ports::Secret;

use super::financial_sync::clone_deps;
use super::*;

fn fixture_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/fixtures/equity-sync")
}

fn index_job(days: &[&str]) -> ClaimedJob {
	let days: Vec<String> = days.iter().map(|day| format!("\"{day}\"")).collect();
	parse(&format!(
		r#"{{{},"days":[{}]}}"#,
		lease("edinet-index", "run_edinet_index", 4, 20_000),
		days.join(",")
	))
	.unwrap()
}

/// EDINET's list endpoint: the synthetic lists unless a date is scripted.
#[derive(Default)]
struct FakeLists {
	failing: HashMap<String, SafeFetchError>,
	requested: Mutex<Vec<String>>,
}

#[async_trait]
impl SafeFetcher for FakeLists {
	async fn fetch_text(
		&self,
		url: &str,
		_options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		self.requested.lock().unwrap().push(url.to_owned());
		let date = url
			.split("date=")
			.nth(1)
			.unwrap()
			.split('&')
			.next()
			.unwrap();
		if let Some(error) = self.failing.get(date) {
			return Err(error.clone());
		}
		std::fs::read_to_string(
			fixture_dir().join(format!("edinet-documents-{date}.synthetic.json")),
		)
		.map(|text| FetchedDocument {
			final_url: url.to_owned(),
			content_type: None,
			text,
		})
		.map_err(|_| SafeFetchError::http(404, "HTTP 404", None))
	}
}

fn index_harness(api: &Arc<FakeApi>, fake: &Arc<FakeLists>, key: Option<&str>) -> Harness {
	harness(
		Arc::clone(api),
		Options {
			edinet_index: Some(Arc::new(EdinetIndex::new(
				Arc::clone(fake) as Arc<dyn SafeFetcher>,
				key.map(Secret::new),
			))),
			..Options::default()
		},
	)
}

fn failed(calls: &ApiCalls) -> (String, bool, Tri<u16>) {
	match calls.completions.first() {
		Some(CompleteJobRequest::Failed {
			failure_code,
			retryable,
			failure_upstream_status,
			..
		}) => (
			failure_code.clone(),
			*retryable,
			failure_upstream_status.clone(),
		),
		other => panic!("expected a failed completion, got {other:?}"),
	}
}

const KEY: &str = "edinet-key-0001";
const DATES: [&str; 3] = ["2025-07-01", "2025-06-20", "2024-09-10"];

#[tokio::test]
async fn without_a_key_the_index_fails_before_any_request() {
	let api = FakeApi::new(ApiScript::default());
	let fake = Arc::new(FakeLists::default());
	let harness = index_harness(&api, &fake, None);
	run(index_job(&DATES), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	assert_eq!(
		failed(&calls),
		(
			"FINANCIAL_SOURCE_NOT_CONFIGURED".to_owned(),
			false,
			Tri::Absent
		)
	);
	assert!(fake.requested.lock().unwrap().is_empty());
	// The default harness composes the same unconfigured source.
	let api = FakeApi::new(ApiScript::default());
	run(index_job(&DATES), &harness_default(&api)).await;
	assert_eq!(failed(&api.calls()).0, "FINANCIAL_SOURCE_NOT_CONFIGURED");
}

fn harness_default(api: &Arc<FakeApi>) -> Harness {
	harness(Arc::clone(api), Options::default())
}

#[tokio::test]
async fn the_index_lists_every_claimed_date_for_every_filer() {
	let api = FakeApi::new(ApiScript::default());
	let fake = Arc::new(FakeLists::default());
	let harness = index_harness(&api, &fake, Some(KEY));
	run(index_job(&DATES), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	let Some(CompleteJobRequest::EdinetIndexed {
		lease_generation,
		fetched_at,
		days,
		..
	}) = calls.completions.first()
	else {
		panic!("expected an edinet-indexed completion");
	};
	assert_eq!(*lease_generation, 4);
	assert_eq!(fetched_at, "2026-10-11T00:00:00.000Z");
	let listed: Vec<(&str, Vec<&str>)> = days
		.iter()
		.map(|day| {
			(
				day.date.as_str(),
				day.documents
					.iter()
					.map(|document| document.doc_id.as_str())
					.collect(),
			)
		})
		.collect();
	assert_eq!(
		listed,
		[
			// S100SYB5 has no XBRL-to-CSV (csvFlag "0"): not indexed.
			("2025-07-01", vec!["S10701OT"]),
			("2025-06-20", vec!["S10620OT", "S100SY25"]),
			("2024-09-10", vec!["S10910OT", "S100SYA4"]),
		]
	);
	assert_eq!(fake.requested.lock().unwrap().len(), 3);
	let lines = harness.log.lines();
	assert!(lines.iter().any(|line| line.contains(
		r#""event":"edinet_index_completed","runId":"run_edinet_index","days":3,"failedDays":0,"skippedDays":0,"documents":5,"droppedRows":1,"requests":3"#
	)));
	assert!(lines.iter().all(|line| !line.contains(KEY)));
}

#[tokio::test]
async fn a_failed_date_is_left_out_and_logged_and_no_date_fails_the_job() {
	let api = FakeApi::new(ApiScript::default());
	let fake = Arc::new(FakeLists {
		failing: HashMap::from([(
			"2025-06-20".to_owned(),
			SafeFetchError::http(500, "HTTP 500", None),
		)]),
		..FakeLists::default()
	});
	let harness = index_harness(&api, &fake, Some(KEY));
	run(index_job(&DATES), &harness).await;
	let Some(CompleteJobRequest::EdinetIndexed { days, .. }) =
		api.calls().completions.first().cloned()
	else {
		panic!("expected an edinet-indexed completion");
	};
	let dates: Vec<String> = days.into_iter().map(|day| day.date).collect();
	assert_eq!(dates, ["2025-07-01", "2024-09-10"]);
	assert!(harness.log.lines().iter().any(|line| line.contains(
		r#""event":"edinet_index_day_failed","runId":"run_edinet_index","date":"2025-06-20","code":"FINANCIAL_SOURCE_FAILED","upstreamStatus":500"#
	)));

	for (status, code, retryable) in [
		(401, "FINANCIAL_ACCESS_DENIED", false),
		(429, "FINANCIAL_RATE_LIMITED", true),
		(503, "FINANCIAL_SOURCE_FAILED", true),
	] {
		let api = FakeApi::new(ApiScript::default());
		let fake = Arc::new(FakeLists {
			failing: HashMap::from([(
				"2025-06-20".to_owned(),
				SafeFetchError::http(status, "HTTP", None),
			)]),
			..FakeLists::default()
		});
		let harness = index_harness(&api, &fake, Some(KEY));
		run(index_job(&["2025-06-20"]), &harness).await;
		assert_eq!(
			failed(&api.calls()),
			(code.to_owned(), retryable, Tri::Value(status))
		);
	}
}

/* ---------- vectors/finance/edinet_index.json (jobs) ---------- */

/// Records which provider gate each request asked (`paced`).
struct RecordingPacer(Mutex<Vec<serde_json::Value>>);

#[async_trait]
impl research_finance::pacing::MarketPacer for RecordingPacer {
	async fn pace(
		&self,
		provider: &str,
		_cancel: &CancellationToken,
		requests: Option<usize>,
	) -> bool {
		self.0
			.lock()
			.unwrap()
			.push(serde_json::json!([provider, requests.unwrap_or(1)]));
		true
	}
}

fn code_of(value: &serde_json::Value) -> EquitySyncFailureCode {
	EquitySyncFailureCode::from_str_value(value.as_str().unwrap()).unwrap()
}

fn status_of(value: &serde_json::Value) -> Option<u16> {
	value.as_u64().map(|status| u16::try_from(status).unwrap())
}

fn count_of(value: &serde_json::Value) -> usize {
	usize::try_from(value.as_u64().unwrap()).unwrap()
}

/// The vector's scripted answer: asks the gate once, then answers.
struct VectorIndex(serde_json::Value);

#[async_trait]
impl EdinetIndexSource for VectorIndex {
	async fn list(
		&self,
		query: EdinetIndexQuery<'_>,
	) -> Result<EdinetIndexData, EquitySyncFailure> {
		query.before_request.before_request().await;
		let answer = &self.0;
		if answer.get("throws").is_some() {
			panic!("the scripted index source threw");
		}
		if let Some(failure) = answer.get("err") {
			return Err(EquitySyncFailure {
				code: code_of(&failure["code"]),
				upstream_status: status_of(&failure["upstreamStatus"]),
				requests: count_of(&failure["requests"]),
			});
		}
		let data = &answer["ok"];
		let js = |value: &serde_json::Value| research_js::json::parse(&value.to_string()).unwrap();
		Ok(EdinetIndexData {
			// Day by day: a vector may hold a completion the contract refuses
			// (the runner must catch it before sending).
			days: data["days"]
				.as_array()
				.unwrap()
				.iter()
				.map(|day| EdinetIndexDayResult {
					date: day["date"].as_str().unwrap().to_owned(),
					documents: day["documents"]
						.as_array()
						.unwrap()
						.iter()
						.map(|document| {
							research_contracts::validate::<EdinetIndexDocument>(&js(document))
								.unwrap()
						})
						.collect(),
				})
				.collect(),
			failed_days: data["failedDays"]
				.as_array()
				.unwrap()
				.iter()
				.map(|day| EdinetIndexDayFailure {
					date: day["date"].as_str().unwrap().to_owned(),
					code: code_of(&day["code"]),
					upstream_status: status_of(&day["upstreamStatus"]),
				})
				.collect(),
			skipped_days: count_of(&data["skippedDays"]),
			dropped_rows: count_of(&data["droppedRows"]),
			requests: count_of(&data["requests"]),
		})
	}
}

#[tokio::test]
async fn the_index_job_body_matches_the_typescript_vectors() {
	let path =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/finance/edinet_index.json");
	let file: serde_json::Value =
		serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
	let cases = file["jobs"].as_array().unwrap();
	assert!(cases.len() >= 20);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let job: ClaimedJob = parse(&case["job"].to_string()).unwrap();
		let answer = &case["answer"];
		let api = FakeApi::new(ApiScript::default());
		let base = harness(
			Arc::clone(&api),
			Options {
				edinet_index: Some(Arc::new(VectorIndex(answer.clone()))),
				..Options::default()
			},
		);
		let pacer = Arc::new(RecordingPacer(Mutex::new(Vec::new())));
		let harness = Harness {
			deps: Arc::new(JobDeps {
				pacer: Arc::clone(&pacer) as Arc<dyn research_finance::pacing::MarketPacer>,
				..clone_deps(&base.deps)
			}),
			..base
		};
		run(job, &harness).await;
		let completion = api.calls().completions.first().map(|completion| {
			serde_json::from_str::<serde_json::Value>(&wire(completion)).unwrap()
		});
		let logs: Vec<serde_json::Value> = harness
			.log
			.lines()
			.iter()
			.map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
			.filter(|line| {
				let event = line["event"].as_str().unwrap_or("");
				event.starts_with("edinet_index") || event == "job_finished"
			})
			.map(|mut line| {
				line.as_object_mut().unwrap().remove("at");
				// A panic is the Rust form of a TypeScript throw; it has no
				// class name of its own and is logged as "Error".
				if line["event"] == "edinet_index_source_failed" && line["error"] == "Error" {
					line["error"] = answer["throws"].clone();
				}
				line
			})
			.collect();
		let actual = serde_json::json!({
			"completion": completion,
			"logs": logs,
			"paced": *pacer.0.lock().unwrap(),
		});
		if actual != case["output"] {
			failures.push(format!(
				"case {index}\n   rust:       {actual}\n   typescript: {}",
				case["output"]
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} cases differ:\n{}",
		failures.len(),
		cases.len(),
		failures
			.iter()
			.take(3)
			.map(|failure| failure.chars().take(2_000).collect::<String>())
			.collect::<Vec<_>>()
			.join("\n")
	);
}
