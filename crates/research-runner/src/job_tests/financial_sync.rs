//! `financial-sync` jobs through the shell (ADR-0048, ADR-0059; port of the
//! TypeScript runner's equity-sync job tests): the real SEC source over fake
//! transports serving `examples/fixtures/equity-sync` and the real J-Quants
//! source over J-Quants' live answers (`research-finance/tests/fixtures/jquants`),
//! the completion or failure the Worker receives, the request counts, the
//! pacing keys and the log events.

use std::path::PathBuf;
use std::sync::Mutex;

use research_application::ports::FetchedDocument;
use research_contracts::equity_financials::{
	EquityBusinessDescription, EquityFactsStatus, EquityProvider, EquityReportForm,
	EquitySyncFailureCode,
};
use research_finance::equity_sync::{
	EquitySyncData, EquitySyncDescriptionUnread, EquitySyncFailure, EquitySyncQuery,
	EquitySyncSource, UnconfiguredEquitySyncSource,
};
use research_finance::jquants_financials::JquantsFinancialsSource;
use research_finance::pacing::{JQUANTS_FINS_PACER_KEY, STOCK_PRICE_RATE_LIMIT_HOLD_MS};
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

const SEC_CONCEPTS: &str = r#"["ifrs-full:Assets","ifrs-full:CashAndCashEquivalents","ifrs-full:CashFlowsFromUsedInFinancingActivities","ifrs-full:CashFlowsFromUsedInInvestingActivities","ifrs-full:CashFlowsFromUsedInOperatingActivities","ifrs-full:Equity","ifrs-full:EquityAttributableToOwnersOfParent","ifrs-full:GrossProfit","ifrs-full:Liabilities","ifrs-full:ProfitLossAttributableToOwnersOfParent","ifrs-full:ProfitLossFromOperatingActivities","ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities","ifrs-full:Revenue","ifrs-full:RevenueFromContractsWithCustomers","us-gaap:Assets","us-gaap:CashAndCashEquivalentsAtCarryingValue","us-gaap:GrossProfit","us-gaap:Liabilities","us-gaap:NetCashProvidedByUsedInFinancingActivities","us-gaap:NetCashProvidedByUsedInInvestingActivities","us-gaap:NetCashProvidedByUsedInOperatingActivities","us-gaap:NetIncomeLoss","us-gaap:OperatingIncomeLoss","us-gaap:PaymentsToAcquirePropertyPlantAndEquipment","us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax","us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax","us-gaap:Revenues","us-gaap:SalesRevenueNet","us-gaap:StockholdersEquity","us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]"#;
const JQUANTS_CONCEPTS: &str = r#"["jquants:CFF","jquants:CFI","jquants:CFO","jquants:CashEq","jquants:Eq","jquants:NP","jquants:OP","jquants:OdP","jquants:Sales","jquants:TA"]"#;

fn sec_job(cik: &str, full_check: bool) -> ClaimedJob {
	parse(&format!(
		r#"{{{},"companyId":"co_synd","market":"US","symbol":"SYND","concepts":{SEC_CONCEPTS},"source":{{"provider":"sec","cik":{cik},"knownAccessions":[],"pendingFilings":[],"filedSince":"2020-10-31","fullCheck":{full_check},"describedDocumentId":null}}}}"#,
		lease("financial-sync", "run_financial", 4, 20_000)
	))
	.unwrap()
}

/// A JP company's sync from J-Quants (ADR-0059 §2).
fn jquants_job(code: &str, known: &[&str]) -> ClaimedJob {
	let known: Vec<String> = known.iter().map(|id| format!(r#""{id}""#)).collect();
	parse(&format!(
		r#"{{{},"companyId":"co_toyota","market":"JP","symbol":"{}","concepts":{JQUANTS_CONCEPTS},"source":{{"provider":"jquants","code":"{code}","knownDisclosures":[{}]}}}}"#,
		lease("financial-sync", "run_financial", 4, 20_000),
		&code[..4],
		known.join(",")
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
			"https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm" => {
				"sec-10k-0009999981-25-000110.synthetic.htm"
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

/// The completion of the J-Quants first sync of Toyota (also a golden payload).
pub(super) async fn jquants_first_sync_completion() -> CompleteJobRequest {
	let api = FakeApi::new(ApiScript::default());
	let fake = FakeJquants::answering(Ok(jquants_fixture("fins-summary-code-7203.json")));
	let (harness, _) = jquants_harness(&api, &fake, Some(JQUANTS_KEY));
	run(jquants_job("72030", &[]), &harness).await;
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
		filings,
		more,
		fetched_at,
		description,
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
	assert!(!more);
	assert_eq!(filings.len(), 7);
	assert!(
		filings
			.iter()
			.all(|filing| filing.facts_status == EquityFactsStatus::Extracted)
	);
	// ADR-0053: no description is stored, so the newest 10-K is read too.
	assert_eq!(client.requested.lock().unwrap().len(), 4);
	let expected = research_js::json::parse(&fixture_text("e2e-sec.json")).unwrap();
	let expected: EquityBusinessDescription =
		research_contracts::validate(expected.as_object().unwrap().get("description").unwrap())
			.unwrap();
	assert_eq!(description.as_ref(), Some(&expected));
	let facts: usize = filings.iter().map(|filing| filing.facts.len()).sum();
	let lines = harness.log.lines();
	let logged: Vec<&String> = lines
		.iter()
		.filter(|line| line.contains(r#""event":"financial_sync_completed""#))
		.collect();
	assert_eq!(logged.len(), 1);
	assert!(logged[0].contains(&format!(
		r#""companyId":"co_synd","provider":"sec","filings":7,"facts":{facts},"more":false,"requests":4"#
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

/* ---------- J-Quants (ADR-0059 §2) ---------- */

fn jquants_fixture(name: &str) -> String {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../research-finance/tests/fixtures/jquants")
		.join(name);
	std::fs::read_to_string(path).unwrap()
}

/// J-Quants' summaries endpoint: one scripted answer for every request.
struct FakeJquants {
	answer: Result<String, SafeFetchError>,
	requested: Mutex<Vec<String>>,
}

impl FakeJquants {
	fn answering(answer: Result<String, SafeFetchError>) -> Arc<Self> {
		Arc::new(Self {
			answer,
			requested: Mutex::new(Vec::new()),
		})
	}
}

#[async_trait]
impl SafeFetcher for FakeJquants {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		assert_eq!(options.x_api_key.as_deref(), Some(JQUANTS_KEY));
		self.requested.lock().unwrap().push(url.to_owned());
		self.answer.clone().map(|text| FetchedDocument {
			final_url: url.to_owned(),
			content_type: Some("application/json".to_owned()),
			text,
		})
	}
}

const JQUANTS_KEY: &str = "jquants-key-0001";

/// A harness with the real J-Quants source over `fake` and a recording pacer.
fn jquants_harness(
	api: &Arc<FakeApi>,
	fake: &Arc<FakeJquants>,
	key: Option<&str>,
) -> (Harness, Arc<RecordingPacer>) {
	let source = JquantsFinancialsSource::new(
		key.map(Secret::new),
		Arc::clone(fake) as Arc<dyn SafeFetcher>,
	);
	let base = harness(
		Arc::clone(api),
		Options {
			equity_sync_sources: vec![(EquityProvider::Jquants, Arc::new(source))],
			..Options::default()
		},
	);
	let pacer = Arc::new(RecordingPacer::default());
	let harness = Harness {
		deps: Arc::new(JobDeps {
			pacer: Arc::clone(&pacer) as Arc<dyn research_finance::pacing::MarketPacer>,
			..clone_deps(&base.deps)
		}),
		..base
	};
	(harness, pacer)
}

fn paced(pacer: &RecordingPacer) -> Vec<serde_json::Value> {
	pacer.0.lock().unwrap().clone()
}

#[tokio::test]
async fn a_jquants_sync_completes_with_the_new_full_year_summaries() {
	let api = FakeApi::new(ApiScript::default());
	let fake = FakeJquants::answering(Ok(jquants_fixture("fins-summary-code-7203.json")));
	let (harness, pacer) = jquants_harness(&api, &fake, Some(JQUANTS_KEY));
	// The FY2025 summary is stored: only FY2026 is new.
	run(jquants_job("72030", &["20250425524402"]), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	let Some(CompleteJobRequest::FinancialSynced {
		provider,
		identity,
		filings,
		more,
		description,
		..
	}) = calls.completions.first()
	else {
		panic!("expected a financial-synced completion");
	};
	assert_eq!(*provider, EquityProvider::Jquants);
	assert!(!more && description.is_none());
	let identity = identity.as_ref().unwrap();
	assert_eq!(
		(
			identity.source_company_id.as_str(),
			identity.fiscal_year_end.as_deref()
		),
		("72030", Some("03-31"))
	);
	let [filing] = filings.as_slice() else {
		panic!("one new filing expected");
	};
	assert_eq!(
		(
			filing.metadata.source_document_id.as_str(),
			filing.metadata.form,
			filing.facts_status,
			filing.facts.len()
		),
		(
			"20260506517369",
			EquityReportForm::EarningsReport,
			EquityFactsStatus::Extracted,
			15
		)
	);
	assert_eq!(
		*fake.requested.lock().unwrap(),
		["https://api.jquants.com/v2/fins/summary?code=72030"]
	);
	// One `jquants-fins` grant per request, never the prices' `jquants`.
	assert_eq!(
		paced(&pacer),
		[serde_json::json!([JQUANTS_FINS_PACER_KEY, 1])]
	);
	let lines = harness.log.lines();
	assert!(lines.iter().any(|line| line.contains(
		r#""event":"financial_sync_completed","companyId":"co_toyota","provider":"jquants","filings":1,"facts":15,"more":false,"requests":1"#
	)));
	// The key never reaches a log line.
	assert!(lines.iter().all(|line| !line.contains(JQUANTS_KEY)));
}

#[tokio::test]
async fn jquants_without_a_key_fails_before_any_request() {
	let api = FakeApi::new(ApiScript::default());
	let fake = FakeJquants::answering(Ok(jquants_fixture("fins-summary-code-7203.json")));
	let (harness, pacer) = jquants_harness(&api, &fake, None);
	run(jquants_job("72030", &[]), &harness).await;
	assert_eq!(
		failed(&api.calls()),
		(
			"FINANCIAL_SOURCE_NOT_CONFIGURED".to_owned(),
			false,
			Tri::Absent
		)
	);
	assert!(fake.requested.lock().unwrap().is_empty());
	// The gate is asked before a request only; a source without a key asks nothing.
	assert!(paced(&pacer).is_empty());
}

#[tokio::test]
async fn jquants_answers_keep_their_status_and_a_429_holds_jquants_fins() {
	for (status, code, retryable) in [
		(400, "FINANCIAL_PARSE_FAILED", false),
		(401, "FINANCIAL_ACCESS_DENIED", false),
		(403, "FINANCIAL_ACCESS_DENIED", false),
		(429, "FINANCIAL_RATE_LIMITED", true),
		(503, "FINANCIAL_SOURCE_FAILED", true),
	] {
		let api = FakeApi::new(ApiScript::default());
		let fake = FakeJquants::answering(Err(SafeFetchError::http(status, "HTTP", None)));
		let (harness, pacer) = jquants_harness(&api, &fake, Some(JQUANTS_KEY));
		run(jquants_job("72030", &[]), &harness).await;
		assert_eq!(
			failed(&api.calls()),
			(code.to_owned(), retryable, Tri::Value(status))
		);
		let mut expected = vec![serde_json::json!([JQUANTS_FINS_PACER_KEY, 1])];
		if status == 429 {
			expected.push(serde_json::json!([
				JQUANTS_FINS_PACER_KEY,
				"hold",
				STOCK_PRICE_RATE_LIMIT_HOLD_MS
			]));
		}
		assert_eq!(paced(&pacer), expected, "{status}");
		assert!(
			harness
				.log
				.lines()
				.iter()
				.any(|line| line.contains(&format!(
					r#""provider":"jquants","code":"{code}","upstreamStatus":{status}"#
				)))
		);
	}
	// No answer at all: a retryable source failure without a status, no hold.
	let api = FakeApi::new(ApiScript::default());
	let fake = FakeJquants::answering(Err(SafeFetchError::new(
		SafeFetchErrorCode::Timeout,
		"timeout",
	)));
	let (harness, pacer) = jquants_harness(&api, &fake, Some(JQUANTS_KEY));
	run(jquants_job("72030", &[]), &harness).await;
	assert_eq!(
		failed(&api.calls()),
		("FINANCIAL_SOURCE_FAILED".to_owned(), true, Tri::Absent)
	);
	assert_eq!(paced(&pacer).len(), 1);
}

/// The same dependencies (and so the same sources) for another Worker.
pub(super) fn clone_deps(deps: &JobDeps) -> JobDeps {
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
		earnings_calendar_sources: deps.earnings_calendar_sources.clone(),
		stock_directory_sources: deps.stock_directory_sources.clone(),
		company_profiles: deps.company_profiles.clone(),
		equity_sync_sources: deps.equity_sync_sources.clone(),
		stock_price_sources: deps.stock_price_sources.clone(),
		pacer: Arc::clone(&deps.pacer),
		google: Arc::clone(&deps.google),
	}
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
			filings: twice,
			more: false,
			requests: 2,
			description: None,
			description_unread: None,
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

/// Records which provider gate each request asked and each hold (`paced`).
#[derive(Default)]
pub(super) struct RecordingPacer(pub(super) Mutex<Vec<serde_json::Value>>);

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
			.push(serde_json::json!([provider, requests]));
		true
	}
	async fn admit(
		&self,
		provider: &str,
		_cancel: &CancellationToken,
	) -> research_finance::ports::MarketRequestAdmission {
		self.0
			.lock()
			.unwrap()
			.push(serde_json::json!([provider, "admit"]));
		research_finance::ports::MarketRequestAdmission::Granted
	}
	fn hold(&self, provider: &str, ms: i64) {
		self.0
			.lock()
			.unwrap()
			.push(serde_json::json!([provider, "hold", ms]));
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
			filings: data["filings"]
				.as_array()
				.unwrap()
				.iter()
				.map(|filing| research_contracts::validate(&js(filing)).unwrap())
				.collect(),
			more: data["more"].as_bool().unwrap(),
			requests: usize::try_from(data["requests"].as_u64().unwrap()).unwrap(),
			description: (!data["description"].is_null())
				.then(|| research_contracts::validate(&js(&data["description"])).unwrap()),
			description_unread: (!data["descriptionUnread"].is_null()).then(|| {
				let unread = &data["descriptionUnread"];
				EquitySyncDescriptionUnread {
					code: EquitySyncFailureCode::from_str_value(unread["code"].as_str().unwrap())
						.unwrap(),
					upstream_status: unread["upstreamStatus"]
						.as_u64()
						.map(|status| u16::try_from(status).unwrap()),
				}
			}),
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
	assert!(
		cases
			.iter()
			.any(|case| case["job"]["source"]["provider"] == "jquants")
	);
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
