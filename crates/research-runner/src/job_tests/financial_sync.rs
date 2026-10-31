//! `financial-sync` jobs through the shell (ADR-0045; port of the TypeScript
//! runner's equity-sync job tests): the real SEC and EDINET sources over fake
//! transports serving `examples/fixtures/equity-sync`, the completion or
//! failure the Worker receives, the request counts and the log events.

use std::path::PathBuf;
use std::sync::Mutex;

use research_application::ports::{BinaryDocument, SafeBinaryFetcher};
use research_contracts::equity_financials::{EquityFactsStatus, EquityProvider};
use research_finance::edinet_sync::EdinetSource;
use research_finance::equity_sync::{
	EquitySyncData, EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
	UnconfiguredEquitySyncSource,
};
use research_finance::ports::Secret;
use research_finance::sec_annual::SecAnnualFilingsSource;
use research_finance::sec_client::{SecClient, SecDocument, SecError, SecErrorCode, SecRequest};

use super::*;

fn fixture_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/fixtures/equity-sync")
}

fn fixture_text(name: &str) -> String {
	std::fs::read_to_string(fixture_dir().join(name)).unwrap()
}

const SEC_CONCEPTS: &str = r#"["us-gaap:Assets","us-gaap:CashAndCashEquivalentsAtCarryingValue","us-gaap:GrossProfit","us-gaap:Liabilities","us-gaap:NetCashProvidedByUsedInFinancingActivities","us-gaap:NetCashProvidedByUsedInInvestingActivities","us-gaap:NetCashProvidedByUsedInOperatingActivities","us-gaap:NetIncomeLoss","us-gaap:OperatingIncomeLoss","us-gaap:PaymentsToAcquirePropertyPlantAndEquipment","us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax","us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax","us-gaap:Revenues","us-gaap:SalesRevenueNet","us-gaap:StockholdersEquity","us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]"#;
const EDINET_CONCEPTS: &str = r#"["jppfs_cor:Assets","jppfs_cor:CashAndCashEquivalents","jppfs_cor:GrossProfit","jppfs_cor:Liabilities","jppfs_cor:NetAssets","jppfs_cor:NetCashProvidedByUsedInFinancingActivities","jppfs_cor:NetCashProvidedByUsedInInvestingActivities","jppfs_cor:NetCashProvidedByUsedInOperatingActivities","jppfs_cor:NetSales","jppfs_cor:OperatingIncome","jppfs_cor:OperatingRevenue1","jppfs_cor:OrdinaryIncome","jppfs_cor:ProfitLoss","jppfs_cor:ProfitLossAttributableToOwnersOfParent","jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF"]"#;

fn sec_job(cik: &str, full_check: bool) -> ClaimedJob {
	parse(&format!(
		r#"{{{},"companyId":"co_synd","market":"US","symbol":"SYND","concepts":{SEC_CONCEPTS},"source":{{"provider":"sec","cik":{cik},"knownAccessions":[],"pendingFilings":[],"filedSince":"2020-10-31","fullCheck":{full_check}}}}}"#,
		lease("financial-sync", "run_financial", 4, 20_000)
	))
	.unwrap()
}

fn edinet_job(scan_days: &[&str]) -> ClaimedJob {
	let days: Vec<String> = scan_days.iter().map(|day| format!("\"{day}\"")).collect();
	parse(&format!(
		r#"{{{},"companyId":"co_synth_jp","market":"JP","symbol":"9999","concepts":{EDINET_CONCEPTS},"source":{{"provider":"edinet","secCode":"99990","edinetCode":null,"knownDocIds":[],"pendingFilings":[],"scanDays":[{}]}}}}"#,
		lease("financial-sync", "run_financial", 4, 20_000),
		days.join(",")
	))
	.unwrap()
}

/* ---------- fake transports ---------- */

/// SEC answered from the synthetic files.
struct FakeSec {
	requested: Mutex<Vec<String>>,
}

#[async_trait]
impl SecClient for FakeSec {
	async fn fetch_document(
		&self,
		url: &str,
		_request: SecRequest<'_>,
	) -> Result<SecDocument, SecError> {
		self.requested.lock().unwrap().push(url.to_owned());
		let file = match url {
			"https://www.sec.gov/files/company_tickers_exchange.json" => {
				return Ok(SecDocument {
					url: url.to_owned(),
					text: r#"{"fields":["cik","name","ticker","exchange"],"data":[[9999981,"Synthetic Devices Inc.","SYND","Nasdaq"]]}"#.to_owned(),
				});
			}
			"https://data.sec.gov/submissions/CIK0009999981.json" => {
				"sec-submissions-CIK0009999981.synthetic.json"
			}
			"https://data.sec.gov/api/xbrl/companyfacts/CIK0009999981.json" => {
				"sec-companyfacts-CIK0009999981.synthetic.json"
			}
			_ => {
				return Err(SecError {
					code: SecErrorCode::NotFound,
					detail: String::new(),
					retryable: false,
					upstream_status: Some(404),
				});
			}
		};
		Ok(SecDocument {
			url: url.to_owned(),
			text: fixture_text(file),
		})
	}
}

/// EDINET's two endpoints: lists from the synthetic files unless scripted,
/// documents from the synthetic ZIPs (anything else is a 404).
#[derive(Default)]
struct FakeEdinet {
	list_answer: Option<SafeFetchError>,
	requested: Mutex<Vec<String>>,
}

#[async_trait]
impl SafeFetcher for FakeEdinet {
	async fn fetch_text(
		&self,
		url: &str,
		_options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		self.requested.lock().unwrap().push(url.to_owned());
		if let Some(error) = &self.list_answer {
			return Err(error.clone());
		}
		let date = url
			.split("date=")
			.nth(1)
			.unwrap()
			.split('&')
			.next()
			.unwrap();
		let text = std::fs::read_to_string(
			fixture_dir().join(format!("edinet-documents-{date}.synthetic.json")),
		)
		.unwrap_or_else(|_| r#"{"metadata":{"status":"200"},"results":[]}"#.to_owned());
		Ok(FetchedDocument {
			final_url: url.to_owned(),
			content_type: None,
			text,
		})
	}
}

#[async_trait]
impl SafeBinaryFetcher for FakeEdinet {
	async fn fetch_bytes(
		&self,
		url: &str,
		_options: &SafeFetchOptions,
	) -> Result<BinaryDocument, SafeFetchError> {
		self.requested.lock().unwrap().push(url.to_owned());
		let doc = url
			.split("/documents/")
			.nth(1)
			.unwrap()
			.split('?')
			.next()
			.unwrap();
		std::fs::read(fixture_dir().join(format!("edinet-{doc}.synthetic.zip")))
			.map(|bytes| BinaryDocument {
				final_url: url.to_owned(),
				content_type: None,
				bytes,
			})
			.map_err(|_| SafeFetchError::http(404, "HTTP 404", None))
	}
}

fn sec_harness(api: &Arc<FakeApi>) -> (Harness, Arc<FakeSec>) {
	let client = Arc::new(FakeSec {
		requested: Mutex::new(Vec::new()),
	});
	let source = SecAnnualFilingsSource::new(
		Arc::clone(&client) as Arc<dyn SecClient>,
		Arc::new(FixedClock),
		Some("Research Owner owner@example.com"),
	);
	let harness = harness(
		Arc::clone(api),
		Options {
			equity_sync_sources: vec![(EquityProvider::Sec, Arc::new(source))],
			..Options::default()
		},
	);
	(harness, client)
}

fn edinet_harness(api: &Arc<FakeApi>, fake: &Arc<FakeEdinet>, key: Option<&str>) -> Harness {
	let source = EdinetSource::new(
		Arc::clone(fake) as Arc<dyn SafeFetcher>,
		Arc::clone(fake) as Arc<dyn SafeBinaryFetcher>,
		key.map(Secret::new),
		Arc::new(FixedClock),
	);
	harness(
		Arc::clone(api),
		Options {
			equity_sync_sources: vec![(EquityProvider::Edinet, Arc::new(source))],
			..Options::default()
		},
	)
}

/// The failed completion's code, retryability and upstream status.
fn failed(calls: &ApiCalls) -> (String, bool, Tri<u16>) {
	match calls.completions.first() {
		Some(CompleteJobRequest::Failed {
			failure_code,
			retryable,
			failure_upstream_status,
			failure_detail: Tri::Absent,
			..
		}) => (
			failure_code.clone(),
			*retryable,
			failure_upstream_status.clone(),
		),
		other => panic!("expected a failed completion, got {other:?}"),
	}
}

/// The completion of the SEC first sync (also the golden payload).
pub(super) async fn sec_first_sync_completion() -> CompleteJobRequest {
	let api = FakeApi::new(ApiScript::default());
	let (harness, _) = sec_harness(&api);
	run(sec_job("null", true), &harness).await;
	first_completion(&api)
}

/* ---------- tests ---------- */

#[tokio::test]
async fn a_first_sec_sync_completes_with_every_annual_filing() {
	let api = FakeApi::new(ApiScript::default());
	let (harness, client) = sec_harness(&api);
	run(sec_job("null", true), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	let Some(CompleteJobRequest::FinancialSynced {
		lease_generation,
		company_id,
		provider,
		identity,
		scanned_days,
		filings,
		more,
		fetched_at,
		..
	}) = calls.completions.first()
	else {
		panic!("expected a financial-synced completion");
	};
	assert_eq!(*lease_generation, 4);
	assert_eq!(company_id, "co_synd");
	assert_eq!(*provider, EquityProvider::Sec);
	assert_eq!(fetched_at, "2026-10-11T00:00:00.000Z");
	assert_eq!(
		identity
			.as_ref()
			.map(|identity| identity.source_company_id.as_str()),
		Some("0009999981")
	);
	assert!(scanned_days.is_empty() && !more);
	assert_eq!(filings.len(), 7);
	assert!(
		filings
			.iter()
			.all(|filing| filing.facts_status == EquityFactsStatus::Extracted)
	);
	assert_eq!(client.requested.lock().unwrap().len(), 3);
	let facts: usize = filings.iter().map(|filing| filing.facts.len()).sum();
	let lines = harness.log.lines();
	let logged: Vec<&String> = lines
		.iter()
		.filter(|line| line.contains(r#""event":"financial_sync_completed""#))
		.collect();
	assert_eq!(logged.len(), 1);
	assert!(logged[0].contains(&format!(
		r#""companyId":"co_synd","provider":"sec","filings":7,"facts":{facts},"scannedDays":0,"more":false,"requests":3"#
	)));
}

#[tokio::test]
async fn a_provider_without_a_source_fails_as_not_configured_without_a_request() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(sec_job(r#""0009999981""#, false), &harness).await;
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
	assert!(harness.log.lines().iter().any(|line| line.contains(
		r#""event":"financial_sync_failed","companyId":"co_synd","provider":"sec","code":"FINANCIAL_SOURCE_NOT_CONFIGURED","upstreamStatus":null"#
	)));
	// The composed "unconfigured" source answers the same, also without a request.
	let api = FakeApi::new(ApiScript::default());
	let harness = super::harness(
		Arc::clone(&api),
		Options {
			equity_sync_sources: vec![(
				EquityProvider::Sec,
				Arc::new(UnconfiguredEquitySyncSource(EquityProvider::Sec)),
			)],
			..Options::default()
		},
	);
	run(sec_job("null", true), &harness).await;
	assert_eq!(failed(&api.calls()).0, "FINANCIAL_SOURCE_NOT_CONFIGURED");
}

#[tokio::test]
async fn edinet_without_a_key_fails_before_any_request() {
	let api = FakeApi::new(ApiScript::default());
	let fake = Arc::new(FakeEdinet::default());
	let harness = edinet_harness(&api, &fake, None);
	run(edinet_job(&["2025-06-20"]), &harness).await;
	assert_eq!(
		failed(&api.calls()),
		(
			"FINANCIAL_SOURCE_NOT_CONFIGURED".to_owned(),
			false,
			Tri::Absent
		)
	);
	assert!(fake.requested.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_edinet_scan_completes_and_the_next_job_reuses_the_listings() {
	let api = FakeApi::new(ApiScript::default());
	let fake = Arc::new(FakeEdinet::default());
	let harness = edinet_harness(&api, &fake, Some("edinet-key-0001"));
	let days = ["2024-06-21", "2024-09-10", "2025-06-20", "2025-07-01"];
	run(edinet_job(&days), &harness).await;
	let Some(CompleteJobRequest::FinancialSynced {
		provider,
		identity,
		scanned_days,
		filings,
		more,
		..
	}) = api.calls().completions.first().cloned()
	else {
		panic!("expected a financial-synced completion");
	};
	assert_eq!(provider, EquityProvider::Edinet);
	assert_eq!(scanned_days, days);
	assert!(!more);
	assert_eq!(
		identity.map(|identity| identity.source_company_id),
		Some("E99991".to_owned())
	);
	let statuses: Vec<(&str, EquityFactsStatus)> = filings
		.iter()
		.map(|filing| {
			(
				filing.metadata.source_document_id.as_str(),
				filing.facts_status,
			)
		})
		.collect();
	assert_eq!(
		statuses,
		[
			("S100SYB5", EquityFactsStatus::NotAvailable),
			("S100SY25", EquityFactsStatus::Extracted),
			("S100SYA4", EquityFactsStatus::Extracted),
			("S100SY24", EquityFactsStatus::Extracted),
		]
	);
	// Four lists and three downloads; the CSV-less amendment needs none.
	assert_eq!(fake.requested.lock().unwrap().len(), 7);
	// The key never reaches a log line.
	assert!(
		harness
			.log
			.lines()
			.iter()
			.all(|line| !line.contains("edinet-key-0001"))
	);

	// A second job within the day lists nothing again.
	let second = FakeApi::new(ApiScript::default());
	let next = Harness {
		deps: Arc::new(JobDeps {
			api: Arc::clone(&second) as Arc<dyn RunnerApi>,
			..clone_deps(&harness.deps)
		}),
		..harness
	};
	run(edinet_job(&days), &next).await;
	assert_eq!(fake.requested.lock().unwrap().len(), 10);
	assert!(matches!(
		second.calls().completions.first(),
		Some(CompleteJobRequest::FinancialSynced { .. })
	));
}

/// The same dependencies (and so the same source and its cache) for another Worker.
fn clone_deps(deps: &JobDeps) -> JobDeps {
	JobDeps {
		api: Arc::clone(&deps.api),
		agents: Arc::clone(&deps.agents),
		tools: deps.tools.clone(),
		ingest: IngestDeps {
			fetcher: Arc::clone(&deps.ingest.fetcher),
			feed_parser: Arc::clone(&deps.ingest.feed_parser),
			hasher: Arc::clone(&deps.ingest.hasher),
			clock: Arc::clone(&deps.ingest.clock),
		},
		clock: Arc::clone(&deps.clock),
		logger: Arc::clone(&deps.logger),
		scratch: Arc::clone(&deps.scratch),
		new_fence_token: Arc::clone(&deps.new_fence_token),
		allow_unverified_tool_isolation: deps.allow_unverified_tool_isolation,
		market_sources: deps.market_sources.clone(),
		earnings_sources: deps.earnings_sources.clone(),
		stock_directory_sources: deps.stock_directory_sources.clone(),
		equity_sync_sources: deps.equity_sync_sources.clone(),
		pacer: Arc::clone(&deps.pacer),
		google: Arc::clone(&deps.google),
	}
}

#[tokio::test]
async fn provider_answers_keep_their_status_and_only_transient_ones_are_retried() {
	for (status, code, retryable) in [
		(401, "FINANCIAL_ACCESS_DENIED", false),
		(403, "FINANCIAL_ACCESS_DENIED", false),
		(429, "FINANCIAL_RATE_LIMITED", true),
		(503, "FINANCIAL_SOURCE_FAILED", true),
	] {
		let api = FakeApi::new(ApiScript::default());
		let fake = Arc::new(FakeEdinet {
			list_answer: Some(SafeFetchError::http(status, "HTTP", None)),
			..FakeEdinet::default()
		});
		let harness = edinet_harness(&api, &fake, Some("edinet-key-0001"));
		run(edinet_job(&["2025-06-20"]), &harness).await;
		assert_eq!(
			failed(&api.calls()),
			(code.to_owned(), retryable, Tri::Value(status))
		);
		assert!(
			harness
				.log
				.lines()
				.iter()
				.any(|line| line.contains(&format!(r#""code":"{code}","upstreamStatus":{status}"#)))
		);
	}
	// No answer at all: a retryable source failure without a status.
	let api = FakeApi::new(ApiScript::default());
	let fake = Arc::new(FakeEdinet {
		list_answer: Some(SafeFetchError::new(SafeFetchErrorCode::Timeout, "timeout")),
		..FakeEdinet::default()
	});
	let harness = edinet_harness(&api, &fake, Some("edinet-key-0001"));
	run(edinet_job(&["2025-06-20"]), &harness).await;
	assert_eq!(
		failed(&api.calls()),
		("FINANCIAL_SOURCE_FAILED".to_owned(), true, Tri::Absent)
	);
}

/// A source answering scripted data, or panicking.
struct Scripted(Option<EquitySyncData>);

#[async_trait]
impl EquitySyncSource for Scripted {
	fn provider(&self) -> EquityProvider {
		EquityProvider::Sec
	}
	async fn sync(&self, _query: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure> {
		match &self.0 {
			Some(data) => Ok(data.clone()),
			None => panic!("the financial source exploded"),
		}
	}
}

fn scripted_harness(api: &Arc<FakeApi>, data: Option<EquitySyncData>) -> Harness {
	harness(
		Arc::clone(api),
		Options {
			equity_sync_sources: vec![(EquityProvider::Sec, Arc::new(Scripted(data)))],
			..Options::default()
		},
	)
}

#[tokio::test]
async fn a_completion_the_api_would_refuse_fails_as_parse_failed() {
	let Some(CompleteJobRequest::FinancialSynced {
		identity, filings, ..
	}) = Some(sec_first_sync_completion().await)
	else {
		panic!("expected a financial-synced completion");
	};
	let mut twice = filings.clone();
	twice.push(filings[0].clone());
	let api = FakeApi::new(ApiScript::default());
	let harness = scripted_harness(
		&api,
		Some(EquitySyncData {
			identity,
			scanned_days: Vec::new(),
			filings: twice,
			more: false,
			requests: 2,
		}),
	);
	run(sec_job("null", true), &harness).await;
	assert_eq!(
		failed(&api.calls()),
		("FINANCIAL_PARSE_FAILED".to_owned(), false, Tri::Absent)
	);
}

#[tokio::test]
async fn a_panicking_source_fails_retryably_and_is_logged_by_class() {
	let api = FakeApi::new(ApiScript::default());
	let harness = scripted_harness(&api, None);
	run(sec_job("null", true), &harness).await;
	assert_eq!(
		failed(&api.calls()),
		("FINANCIAL_SOURCE_FAILED".to_owned(), true, Tri::Absent)
	);
	let lines = harness.log.lines();
	assert!(lines.iter().any(|line| {
		line.contains(r#""event":"financial_sync_source_failed","provider":"sec","error":"Error""#)
	}));
	assert!(
		lines
			.iter()
			.any(|line| line.contains(r#""event":"financial_sync_failed""#))
	);
	assert!(lines.iter().all(|line| !line.contains("exploded")));
}

/* ---------- vectors/finance/equity_sync_jobs.json ---------- */

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

/// The vector's scripted answer: asks the gate once, then answers.
struct VectorSource {
	provider: EquityProvider,
	answer: serde_json::Value,
}

#[async_trait]
impl EquitySyncSource for VectorSource {
	fn provider(&self) -> EquityProvider {
		self.provider
	}
	async fn sync(&self, query: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure> {
		query.before_request.before_request().await;
		if self.answer.get("throws").is_some() {
			panic!("the scripted source threw");
		}
		if let Some(failure) = self.answer.get("err") {
			let code =
				research_contracts::equity_financials::EquitySyncFailureCode::from_str_value(
					failure["code"].as_str().unwrap(),
				)
				.unwrap();
			return Err(EquitySyncFailure {
				code,
				upstream_status: failure["upstreamStatus"]
					.as_u64()
					.map(|status| u16::try_from(status).unwrap()),
				requests: usize::try_from(failure["requests"].as_u64().unwrap()).unwrap(),
			});
		}
		let data = &self.answer["ok"];
		let js = |value: &serde_json::Value| research_js::json::parse(&value.to_string()).unwrap();
		Ok(EquitySyncData {
			identity: (!data["identity"].is_null())
				.then(|| research_contracts::validate(&js(&data["identity"])).unwrap()),
			scanned_days: serde_json::from_value(data["scannedDays"].clone()).unwrap(),
			filings: data["filings"]
				.as_array()
				.unwrap()
				.iter()
				.map(|filing| research_contracts::validate(&js(filing)).unwrap())
				.collect(),
			more: data["more"].as_bool().unwrap(),
			requests: usize::try_from(data["requests"].as_u64().unwrap()).unwrap(),
		})
	}
}

#[tokio::test]
async fn the_job_body_matches_the_typescript_vectors() {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../../vectors/finance/equity_sync_jobs.json");
	let file: serde_json::Value =
		serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
	let cases = file["cases"].as_array().unwrap();
	assert!(cases.len() >= 30);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let job: ClaimedJob = parse(&case["job"].to_string()).unwrap();
		let provider = match &job {
			ClaimedJob::FinancialSync(job) => job.claim.source.provider(),
			_ => panic!("a financial-sync job"),
		};
		let answer = &case["answer"];
		let sources: Vec<(EquityProvider, Arc<dyn EquitySyncSource>)> = if answer == "absent" {
			Vec::new()
		} else {
			vec![(
				provider,
				Arc::new(VectorSource {
					provider,
					answer: answer.clone(),
				}),
			)]
		};
		let api = FakeApi::new(ApiScript::default());
		let base = harness(
			Arc::clone(&api),
			Options {
				equity_sync_sources: sources,
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
				event.starts_with("financial_sync") || event == "job_finished"
			})
			.map(|mut line| {
				line.as_object_mut().unwrap().remove("at");
				// A panic is the Rust form of a TypeScript throw; it has no
				// class name of its own and is logged as "Error".
				if line["event"] == "financial_sync_source_failed" && line["error"] == "Error" {
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
				"case {index} ({answer})\n   rust:       {actual}\n   typescript: {}",
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
