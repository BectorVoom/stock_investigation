//! ADR-0048: the SEC and EDINET financial-statement sources.
//!
//! 1. Parity: the Rust extraction makes of the synthetic SEC and EDINET
//!    inputs (`examples/fixtures/equity-sync/*.synthetic.*`) exactly the
//!    completions the TypeScript made of them (`e2e-sec.json`,
//!    `e2e-edinet.json`, written by `scripts/vectors/finance/equitySyncFixtures.ts`).
//! 2. Behaviour over fake transports: request sequence and count, caches,
//!    caps, deferred and not-available filings, failure codes with the
//!    provider's status unchanged, and no request at all without a key.
// Test doubles outside `#[test]` functions may unwrap and panic as well.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use research_application::ports::{
	BinaryDocument, Clock, FetchedDocument, SafeBinaryFetcher, SafeFetchError, SafeFetchErrorCode,
	SafeFetchOptions, SafeFetcher,
};
use research_contracts::equity_financials::{
	EquityFactsStatus, EquityFilingResult, EquityMarket, EquitySyncClaim, EquitySyncFailureCode,
	EquitySyncRequest, SecSyncRequest,
};
use research_contracts::json::to_js_json;
use research_finance::edinet_csv::{EdinetReportProblem, extract_edinet_report};
use research_finance::edinet_documents::{
	EdinetListedRow, EdinetPlanInput, edinet_download_plan, edinet_identity,
	parse_edinet_document_list,
};
use research_finance::edinet_sync::EdinetSource;
use research_finance::equity_sync::{
	COMPLETION_CAPS, CompletionCaps, EquitySyncData, EquitySyncFailure, EquitySyncQuery,
	EquitySyncSource, compare_filings_newest_first,
};
use research_finance::ports::{BeforeRequest, Secret};
use research_finance::sec_annual::{
	SecAnnualFilingsSource, SecSyncInput, index_sec_company_facts, parse_sec_submissions,
	sec_sync_result,
};
use research_finance::sec_client::{SecClient, SecDocument, SecError, SecErrorCode, SecRequest};
use research_js::json::Value;
use tokio_util::sync::CancellationToken;

/* ---------- fixtures ---------- */

fn fixture_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/fixtures/equity-sync")
}

fn fixture_text(name: &str) -> String {
	std::fs::read_to_string(fixture_dir().join(name)).unwrap()
}

fn fixture_json(name: &str) -> Value {
	research_js::json::parse(&fixture_text(name)).unwrap()
}

/// Equal texts, or a panic showing where they first differ.
fn assert_same_text(rust: &str, typescript: &str) {
	if rust == typescript {
		return;
	}
	let at = rust
		.bytes()
		.zip(typescript.bytes())
		.position(|(a, b)| a != b)
		.unwrap_or(rust.len().min(typescript.len()));
	let window = |text: &str| {
		let from = at.saturating_sub(120);
		let to = (at + 120).min(text.len());
		String::from_utf8_lossy(&text.as_bytes()[from..to]).into_owned()
	};
	panic!(
		"first difference at byte {at}\n  rust:       {}\n  typescript: {}",
		window(rust),
		window(typescript)
	);
}

/// The expected filings in schema key order (the fixture files keep the
/// TypeScript objects' own key order; the API reads both through zod).
fn expected_filings(expected: &Value) -> String {
	let filings: Vec<EquityFilingResult> = member(expected, "filings")
		.as_array()
		.unwrap()
		.iter()
		.map(|filing| research_contracts::validate(filing).unwrap())
		.collect();
	to_js_json(&filings).unwrap()
}

fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
	value.as_object().unwrap().get(key).unwrap()
}

/// `equityConceptsOfProvider("sec")`.
const SEC_CONCEPTS: [&str; 16] = [
	"us-gaap:Assets",
	"us-gaap:CashAndCashEquivalentsAtCarryingValue",
	"us-gaap:GrossProfit",
	"us-gaap:Liabilities",
	"us-gaap:NetCashProvidedByUsedInFinancingActivities",
	"us-gaap:NetCashProvidedByUsedInInvestingActivities",
	"us-gaap:NetCashProvidedByUsedInOperatingActivities",
	"us-gaap:NetIncomeLoss",
	"us-gaap:OperatingIncomeLoss",
	"us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
	"us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
	"us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
	"us-gaap:Revenues",
	"us-gaap:SalesRevenueNet",
	"us-gaap:StockholdersEquity",
	"us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
];

/// `equityConceptsOfProvider("edinet")`.
const EDINET_CONCEPTS: [&str; 15] = [
	"jppfs_cor:Assets",
	"jppfs_cor:CashAndCashEquivalents",
	"jppfs_cor:GrossProfit",
	"jppfs_cor:Liabilities",
	"jppfs_cor:NetAssets",
	"jppfs_cor:NetCashProvidedByUsedInFinancingActivities",
	"jppfs_cor:NetCashProvidedByUsedInInvestingActivities",
	"jppfs_cor:NetCashProvidedByUsedInOperatingActivities",
	"jppfs_cor:NetSales",
	"jppfs_cor:OperatingIncome",
	"jppfs_cor:OperatingRevenue1",
	"jppfs_cor:OrdinaryIncome",
	"jppfs_cor:ProfitLoss",
	"jppfs_cor:ProfitLossAttributableToOwnersOfParent",
	"jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF",
];

const SEC_CIK: &str = "0009999981";
const SEC_FILED_SINCE: &str = "2020-10-31";
const EDINET_SEC_CODE: &str = "99990";
const EDINET_DATES: [&str; 8] = [
	"2020-06-26",
	"2021-06-25",
	"2022-06-24",
	"2023-06-23",
	"2024-06-21",
	"2024-09-10",
	"2025-06-20",
	"2025-07-01",
];
/// The amendment listed with `csvFlag` "0" (not in the E2E completion).
const EDINET_NO_CSV_DATE: &str = "2025-07-01";
const EDINET_NO_CSV_DOC: &str = "S100SYB5";

fn concepts(list: &[&str]) -> Vec<String> {
	list.iter().map(|concept| (*concept).to_owned()).collect()
}

fn sec_request(cik: Option<&str>, known: &[&str], full_check: bool) -> SecSyncRequest {
	SecSyncRequest {
		cik: cik.map(str::to_owned),
		known_accessions: known.iter().map(|id| (*id).to_owned()).collect(),
		pending_filings: Vec::new(),
		filed_since: SEC_FILED_SINCE.to_owned(),
		full_check,
	}
}

/* ---------- 1. parity with the TypeScript extraction ---------- */

#[test]
fn the_sec_extraction_reproduces_the_typescript_completion() {
	let expected = fixture_json("e2e-sec.json");
	let request = sec_request(Some(SEC_CIK), &[], true);
	let submissions = parse_sec_submissions(&fixture_json(
		"sec-submissions-CIK0009999981.synthetic.json",
	))
	.unwrap();
	let facts = index_sec_company_facts(
		&fixture_json("sec-companyfacts-CIK0009999981.synthetic.json"),
		&concepts(&SEC_CONCEPTS),
	)
	.unwrap();
	let result = sec_sync_result(
		&SecSyncInput {
			request: &request,
			cik: SEC_CIK,
			submissions: &submissions,
			facts: Some(&facts),
		},
		COMPLETION_CAPS,
	);
	assert!(!result.more);
	assert_same_text(
		&to_js_json(&result.identity).unwrap(),
		&research_js::json::stringify(member(&expected, "identity")),
	);
	assert_same_text(
		&to_js_json(&result.filings).unwrap(),
		&expected_filings(&expected),
	);
}

fn edinet_zip(doc_id: &str) -> Vec<u8> {
	std::fs::read(fixture_dir().join(format!("edinet-{doc_id}.synthetic.zip"))).unwrap()
}

#[test]
fn the_edinet_extraction_reproduces_the_typescript_completion() {
	let expected = fixture_json("e2e-edinet.json");
	let listed: Vec<_> = EDINET_DATES
		.iter()
		.filter(|date| **date != EDINET_NO_CSV_DATE)
		.flat_map(|date| {
			parse_edinet_document_list(&fixture_json(&format!(
				"edinet-documents-{date}.synthetic.json"
			)))
			.unwrap()
		})
		.filter(|row| row.sec_code.as_deref() == Some(EDINET_SEC_CODE))
		.collect();
	// The source's own plan: an amendment's list row has no period, it takes its original's.
	let found: Vec<EdinetListedRow> = listed
		.iter()
		.map(|row| EdinetListedRow {
			row: row.clone(),
			listed_on: row.submit_date_time.get(..10).unwrap().to_owned(),
		})
		.collect();
	let plan = edinet_download_plan(&EdinetPlanInput {
		pending: &[],
		found: &found,
		known_doc_ids: &[],
		max_downloads: found.len(),
	});
	let mut filings: Vec<EquityFilingResult> = plan
		.into_iter()
		.map(|document| {
			let metadata = document.metadata.complete().unwrap();
			let report = extract_edinet_report(
				&edinet_zip(&metadata.source_document_id),
				&concepts(&EDINET_CONCEPTS),
			)
			.unwrap();
			EquityFilingResult {
				metadata,
				accounting_standard: report.accounting_standard,
				facts_status: EquityFactsStatus::Extracted,
				facts: report.facts,
			}
		})
		.collect();
	filings.sort_by(compare_filings_newest_first);
	assert_same_text(
		&to_js_json(&edinet_identity(listed.iter(), None)).unwrap(),
		&research_js::json::stringify(member(&expected, "identity")),
	);
	assert_same_text(&to_js_json(&filings).unwrap(), &expected_filings(&expected));
}

/* ---------- 2. fake transports ---------- */

struct TestClock(AtomicI64);

impl Clock for TestClock {
	fn now_ms(&self) -> i64 {
		self.0.load(Ordering::SeqCst)
	}
	fn now_iso(&self) -> String {
		"2026-10-31T00:00:00.000Z".to_owned()
	}
}

fn clock() -> Arc<TestClock> {
	Arc::new(TestClock(AtomicI64::new(1_793_404_800_000)))
}

/// Admits every request.
struct Open;

#[async_trait]
impl BeforeRequest for Open {
	async fn before_request(&self) -> bool {
		true
	}
}

/// Refuses every request (the job stopped while waiting).
struct Closed;

#[async_trait]
impl BeforeRequest for Closed {
	async fn before_request(&self) -> bool {
		false
	}
}

fn sec_error(code: SecErrorCode, status: Option<u16>) -> SecError {
	SecError {
		code,
		detail: String::new(),
		retryable: false,
		upstream_status: status,
	}
}

const TICKER_DIRECTORY_URL: &str = "https://www.sec.gov/files/company_tickers_exchange.json";
const SUBMISSIONS_URL: &str = "https://data.sec.gov/submissions/CIK0009999981.json";
const FACTS_URL: &str = "https://data.sec.gov/api/xbrl/companyfacts/CIK0009999981.json";

/// SEC answered from the synthetic files; anything else is SEC's 404.
struct FakeSec {
	answers: Mutex<HashMap<String, Result<String, SecError>>>,
	requested: Mutex<Vec<String>>,
}

impl FakeSec {
	fn new() -> Arc<Self> {
		let answers = HashMap::from([
			(
				TICKER_DIRECTORY_URL.to_owned(),
				Ok(r#"{"fields":["cik","name","ticker","exchange"],"data":[[9999981,"Synthetic Devices Inc.","SYND","Nasdaq"]]}"#.to_owned()),
			),
			(
				SUBMISSIONS_URL.to_owned(),
				Ok(fixture_text("sec-submissions-CIK0009999981.synthetic.json")),
			),
			(
				FACTS_URL.to_owned(),
				Ok(fixture_text("sec-companyfacts-CIK0009999981.synthetic.json")),
			),
		]);
		Arc::new(Self {
			answers: Mutex::new(answers),
			requested: Mutex::new(Vec::new()),
		})
	}

	fn answer(&self, url: &str, answer: Result<String, SecError>) {
		self.answers.lock().unwrap().insert(url.to_owned(), answer);
	}

	fn requested(&self) -> Vec<String> {
		self.requested.lock().unwrap().clone()
	}
}

#[async_trait]
impl SecClient for FakeSec {
	async fn fetch_document(
		&self,
		url: &str,
		_request: SecRequest<'_>,
	) -> Result<SecDocument, SecError> {
		self.requested.lock().unwrap().push(url.to_owned());
		let answer = self.answers.lock().unwrap().get(url).cloned();
		answer
			.unwrap_or_else(|| Err(sec_error(SecErrorCode::NotFound, Some(404))))
			.map(|text| SecDocument {
				url: url.to_owned(),
				text,
			})
	}
}

fn sec_source(client: &Arc<FakeSec>) -> SecAnnualFilingsSource {
	SecAnnualFilingsSource::new(
		Arc::clone(client) as Arc<dyn SecClient>,
		clock(),
		Some("Research Owner owner@example.com"),
	)
}

fn sec_claim(request: SecSyncRequest) -> EquitySyncClaim {
	EquitySyncClaim {
		company_id: "co_synd".to_owned(),
		market: EquityMarket::Us,
		symbol: "SYND".to_owned(),
		concepts: concepts(&SEC_CONCEPTS),
		source: EquitySyncRequest::Sec(request),
	}
}

async fn sync(
	source: &dyn EquitySyncSource,
	claim: &EquitySyncClaim,
	gate: &dyn BeforeRequest,
) -> Result<EquitySyncData, EquitySyncFailure> {
	let cancel = CancellationToken::new();
	source
		.sync(EquitySyncQuery {
			target: claim,
			cancel: &cancel,
			before_request: gate,
		})
		.await
}

fn ids(filings: &[EquityFilingResult]) -> Vec<&str> {
	filings
		.iter()
		.map(|filing| filing.metadata.source_document_id.as_str())
		.collect()
}

/* ---------- SEC ---------- */

#[tokio::test]
async fn a_first_sec_sync_resolves_the_cik_and_reads_both_documents() {
	let client = FakeSec::new();
	let source = sec_source(&client);
	let data = sync(&source, &sec_claim(sec_request(None, &[], true)), &Open)
		.await
		.unwrap();
	assert_eq!(
		client.requested(),
		[TICKER_DIRECTORY_URL, SUBMISSIONS_URL, FACTS_URL]
	);
	assert_eq!(data.requests, 3);
	assert!(data.scanned_days.is_empty() && !data.more);
	let expected = fixture_json("e2e-sec.json");
	assert_same_text(
		&to_js_json(&data.filings).unwrap(),
		&expected_filings(&expected),
	);
	assert_eq!(
		data.identity
			.as_ref()
			.map(|identity| identity.source_company_id.as_str()),
		Some(SEC_CIK)
	);
	// The ticker list is cached: the next first sync of the same source asks only SEC's documents.
	let again = sync(&source, &sec_claim(sec_request(None, &[], true)), &Open)
		.await
		.unwrap();
	assert_eq!(again.requests, 2);
}

#[tokio::test]
async fn a_sync_with_nothing_new_reads_the_submissions_only() {
	let client = FakeSec::new();
	let known = [
		"0009999981-26-000005",
		"0009999981-25-000110",
		"0009999981-24-000108",
	];
	let data = sync(
		&sec_source(&client),
		&sec_claim(sec_request(Some(SEC_CIK), &known, false)),
		&Open,
	)
	.await
	.unwrap();
	assert_eq!(client.requested(), [SUBMISSIONS_URL]);
	assert_eq!(data.requests, 1);
	assert!(data.filings.is_empty() && !data.more);
	assert!(data.identity.is_some());
}

#[tokio::test]
async fn a_new_annual_filing_reads_the_facts_of_new_filings_only() {
	let client = FakeSec::new();
	let known = ["0009999981-25-000110", "0009999981-24-000108"];
	let data = sync(
		&sec_source(&client),
		&sec_claim(sec_request(Some(SEC_CIK), &known, false)),
		&Open,
	)
	.await
	.unwrap();
	assert_eq!(client.requested(), [SUBMISSIONS_URL, FACTS_URL]);
	// The amendment is new; older annual filings only company facts list are
	// new too (filed since filedSince, not stored); the stored ones are not repeated.
	let found = ids(&data.filings);
	assert!(found.contains(&"0009999981-26-000005"));
	assert!(!found.contains(&"0009999981-25-000110"));
	assert!(!found.contains(&"0009999981-24-000108"));
}

#[tokio::test]
async fn a_pending_filing_is_offered_again_with_its_stored_metadata() {
	let client = FakeSec::new();
	let expected = fixture_json("e2e-sec.json");
	let stored: EquityFilingResult =
		research_contracts::validate(&member(&expected, "filings").as_array().unwrap()[1]).unwrap();
	let mut pending = stored.metadata.clone();
	// The stored metadata wins over what SEC states now.
	pending.source_url = "https://www.sec.gov/stored-link".to_owned();
	let all = [
		"0009999981-26-000005",
		"0009999981-25-000110",
		"0009999981-24-000108",
		"0009999981-23-000106",
		"0009999981-22-000104",
		"0009999981-21-000107",
		"0009999981-20-000105",
	];
	let mut request = sec_request(Some(SEC_CIK), &all, false);
	request.pending_filings = vec![pending.clone()];
	let data = sync(&sec_source(&client), &sec_claim(request), &Open)
		.await
		.unwrap();
	assert_eq!(client.requested(), [SUBMISSIONS_URL, FACTS_URL]);
	assert_eq!(ids(&data.filings), ["0009999981-25-000110"]);
	let filing = &data.filings[0];
	assert_eq!(filing.metadata, pending);
	assert_eq!(filing.facts_status, EquityFactsStatus::Extracted);
	assert_eq!(filing.facts, stored.facts);
}

#[tokio::test]
async fn company_facts_without_the_filing_report_it_not_available() {
	let client = FakeSec::new();
	client.answer(FACTS_URL, Err(sec_error(SecErrorCode::NotFound, Some(404))));
	let data = sync(
		&sec_source(&client),
		&sec_claim(sec_request(Some(SEC_CIK), &[], false)),
		&Open,
	)
	.await
	.unwrap();
	assert!(!data.filings.is_empty());
	assert!(data.filings.iter().all(|filing| filing.facts_status
		== EquityFactsStatus::NotAvailable
		&& filing.facts.is_empty()
		&& filing.accounting_standard.is_none()));
}

#[tokio::test]
async fn sec_failures_keep_secs_status() {
	for (error, code, status) in [
		(
			sec_error(SecErrorCode::AccessDenied, Some(403)),
			EquitySyncFailureCode::AccessDenied,
			Some(403),
		),
		(
			sec_error(SecErrorCode::FetchFailed, Some(401)),
			EquitySyncFailureCode::AccessDenied,
			Some(401),
		),
		(
			sec_error(SecErrorCode::RateLimited, Some(429)),
			EquitySyncFailureCode::RateLimited,
			Some(429),
		),
		(
			sec_error(SecErrorCode::FetchFailed, Some(503)),
			EquitySyncFailureCode::SourceFailed,
			Some(503),
		),
		(
			sec_error(SecErrorCode::NotFound, Some(404)),
			EquitySyncFailureCode::SourceFailed,
			Some(404),
		),
		(
			sec_error(SecErrorCode::FetchFailed, None),
			EquitySyncFailureCode::SourceFailed,
			None,
		),
		(
			sec_error(SecErrorCode::ResponseTooLarge, None),
			EquitySyncFailureCode::ParseFailed,
			None,
		),
	] {
		let client = FakeSec::new();
		client.answer(SUBMISSIONS_URL, Err(error));
		let failure = sync(
			&sec_source(&client),
			&sec_claim(sec_request(Some(SEC_CIK), &[], false)),
			&Open,
		)
		.await
		.unwrap_err();
		assert_eq!((failure.code, failure.upstream_status), (code, status));
		assert_eq!(failure.requests, 1);
	}
}

#[tokio::test]
async fn a_malformed_submissions_document_is_a_parse_failure() {
	let client = FakeSec::new();
	client.answer(SUBMISSIONS_URL, Ok(r#"{"name":"x"}"#.to_owned()));
	let failure = sync(
		&sec_source(&client),
		&sec_claim(sec_request(Some(SEC_CIK), &[], false)),
		&Open,
	)
	.await
	.unwrap_err();
	assert_eq!(failure.code, EquitySyncFailureCode::ParseFailed);
	client.answer(SUBMISSIONS_URL, Ok("not json".to_owned()));
	let failure = sync(
		&sec_source(&client),
		&sec_claim(sec_request(Some(SEC_CIK), &[], false)),
		&Open,
	)
	.await
	.unwrap_err();
	assert_eq!(failure.code, EquitySyncFailureCode::ParseFailed);
}

#[tokio::test]
async fn a_ticker_sec_does_not_list_is_company_not_found() {
	let client = FakeSec::new();
	let mut claim = sec_claim(sec_request(None, &[], false));
	claim.symbol = "NOPE".to_owned();
	let failure = sync(&sec_source(&client), &claim, &Open).await.unwrap_err();
	assert_eq!(failure.code, EquitySyncFailureCode::CompanyNotFound);
	assert_eq!((failure.upstream_status, failure.requests), (None, 1));
	// The ticker list itself missing is also "not found", with SEC's status.
	let client = FakeSec::new();
	client.answer(
		TICKER_DIRECTORY_URL,
		Err(sec_error(SecErrorCode::NotFound, Some(404))),
	);
	let failure = sync(&sec_source(&client), &claim, &Open).await.unwrap_err();
	assert_eq!(
		(failure.code, failure.upstream_status),
		(EquitySyncFailureCode::CompanyNotFound, Some(404))
	);
}

#[tokio::test]
async fn sec_without_a_user_agent_or_a_grant_sends_nothing() {
	let client = FakeSec::new();
	let unconfigured =
		SecAnnualFilingsSource::new(Arc::clone(&client) as Arc<dyn SecClient>, clock(), None);
	let claim = sec_claim(sec_request(Some(SEC_CIK), &[], false));
	let failure = sync(&unconfigured, &claim, &Open).await.unwrap_err();
	assert_eq!(
		(failure.code, failure.requests),
		(EquitySyncFailureCode::SourceNotConfigured, 0)
	);
	let failure = sync(&sec_source(&client), &claim, &Closed)
		.await
		.unwrap_err();
	assert_eq!(
		(failure.code, failure.requests),
		(EquitySyncFailureCode::SourceFailed, 0)
	);
	assert!(client.requested().is_empty());
}

#[test]
fn completion_caps_cut_whole_filings_and_say_more() {
	let request = sec_request(Some(SEC_CIK), &[], true);
	let submissions = parse_sec_submissions(&fixture_json(
		"sec-submissions-CIK0009999981.synthetic.json",
	))
	.unwrap();
	let facts = index_sec_company_facts(
		&fixture_json("sec-companyfacts-CIK0009999981.synthetic.json"),
		&concepts(&SEC_CONCEPTS),
	)
	.unwrap();
	let input = SecSyncInput {
		request: &request,
		cik: SEC_CIK,
		submissions: &submissions,
		facts: Some(&facts),
	};
	let by_filings = sec_sync_result(
		&input,
		CompletionCaps {
			max_filings: 2,
			max_facts: 3_000,
		},
	);
	assert!(by_filings.more);
	assert_eq!(
		ids(&by_filings.filings),
		["0009999981-26-000005", "0009999981-25-000110"]
	);
	let by_facts = sec_sync_result(
		&input,
		CompletionCaps {
			max_filings: 60,
			max_facts: 70,
		},
	);
	assert!(by_facts.more);
	assert_eq!(by_facts.filings.len(), 2);
}

/* ---------- EDINET ---------- */

const EMPTY_LIST: &str = r#"{"metadata":{"status":"200","message":"OK"},"results":[]}"#;

/// EDINET answered from the synthetic files (or scripted answers); a date
/// without a file lists nothing, a document without a file is a 404.
struct FakeEdinet {
	lists: Mutex<HashMap<String, Result<String, SafeFetchError>>>,
	documents: Mutex<HashMap<String, Result<Vec<u8>, SafeFetchError>>>,
	requested: Mutex<Vec<String>>,
}

impl FakeEdinet {
	fn new() -> Arc<Self> {
		let lists = EDINET_DATES
			.iter()
			.map(|date| {
				(
					(*date).to_owned(),
					Ok(fixture_text(&format!(
						"edinet-documents-{date}.synthetic.json"
					))),
				)
			})
			.collect();
		let documents = [
			"S100SY20", "S100SY21", "S100SY22", "S100SY23", "S100SY24", "S100SYA4", "S100SY25",
		]
		.into_iter()
		.map(|doc| (doc.to_owned(), Ok(edinet_zip(doc))))
		.collect();
		Arc::new(Self {
			lists: Mutex::new(lists),
			documents: Mutex::new(documents),
			requested: Mutex::new(Vec::new()),
		})
	}

	fn requested(&self) -> Vec<String> {
		self.requested.lock().unwrap().clone()
	}

	fn key_of(url: &str, marker: &str, end: char) -> String {
		let start = url.find(marker).unwrap() + marker.len();
		url[start..].split(end).next().unwrap().to_owned()
	}
}

#[async_trait]
impl SafeFetcher for FakeEdinet {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		assert!(url.ends_with("&Subscription-Key=edinet-key-0001"));
		assert!(
			options
				.allowed_hosts
				.as_ref()
				.unwrap()
				.contains("api.edinet-fsa.go.jp")
		);
		self.requested.lock().unwrap().push(url.to_owned());
		let date = Self::key_of(url, "date=", '&');
		let answer = self.lists.lock().unwrap().get(&date).cloned();
		answer
			.unwrap_or_else(|| Ok(EMPTY_LIST.to_owned()))
			.map(|text| FetchedDocument {
				final_url: url.to_owned(),
				content_type: Some("application/json".to_owned()),
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
		let doc = Self::key_of(url, "/documents/", '?');
		let answer = self.documents.lock().unwrap().get(&doc).cloned();
		answer
			.unwrap_or_else(|| Err(SafeFetchError::http(404, "HTTP 404", None)))
			.map(|bytes| BinaryDocument {
				final_url: url.to_owned(),
				content_type: Some("application/octet-stream".to_owned()),
				bytes,
			})
	}
}

fn edinet_source(fake: &Arc<FakeEdinet>, key: Option<&str>) -> EdinetSource {
	EdinetSource::new(
		Arc::clone(fake) as Arc<dyn SafeFetcher>,
		Arc::clone(fake) as Arc<dyn SafeBinaryFetcher>,
		key.map(Secret::new),
		clock(),
	)
}

fn edinet_claim(scan_days: &[&str], known: &[&str]) -> EquitySyncClaim {
	EquitySyncClaim {
		company_id: "co_synth_jp".to_owned(),
		market: EquityMarket::Jp,
		symbol: "9999".to_owned(),
		concepts: concepts(&EDINET_CONCEPTS),
		source: EquitySyncRequest::Edinet(
			research_contracts::equity_financials::EdinetSyncRequest {
				sec_code: EDINET_SEC_CODE.to_owned(),
				edinet_code: None,
				known_doc_ids: known.iter().map(|id| (*id).to_owned()).collect(),
				pending_filings: Vec::new(),
				scan_days: scan_days.iter().map(|day| (*day).to_owned()).collect(),
			},
		),
	}
}

const KEY: Option<&str> = Some("edinet-key-0001");

#[tokio::test]
async fn an_edinet_scan_lists_each_date_and_downloads_new_reports() {
	let fake = FakeEdinet::new();
	let data = sync(
		&edinet_source(&fake, KEY),
		&edinet_claim(&EDINET_DATES, &[]),
		&Open,
	)
	.await
	.unwrap();
	// Eight lists, seven downloads; the CSV-less amendment needs no request.
	assert_eq!(data.requests, 15);
	assert_eq!(fake.requested().len(), 15);
	assert_eq!(data.scanned_days, EDINET_DATES);
	assert!(!data.more);
	let expected = fixture_json("e2e-edinet.json");
	let extracted: Vec<EquityFilingResult> = data
		.filings
		.iter()
		.filter(|filing| filing.metadata.source_document_id != EDINET_NO_CSV_DOC)
		.cloned()
		.collect();
	assert_same_text(
		&to_js_json(&extracted).unwrap(),
		&expected_filings(&expected),
	);
	let no_csv = data
		.filings
		.iter()
		.find(|filing| filing.metadata.source_document_id == EDINET_NO_CSV_DOC)
		.unwrap();
	assert_eq!(no_csv.facts_status, EquityFactsStatus::NotAvailable);
	assert_eq!(
		no_csv.metadata.amends_source_document_id.as_deref(),
		Some("S100SY25")
	);
	assert_same_text(
		&to_js_json(&data.identity).unwrap(),
		&research_js::json::stringify(member(&expected, "identity")),
	);
}

#[tokio::test]
async fn a_listed_date_is_reused_by_the_next_job_for_a_day() {
	let fake = FakeEdinet::new();
	let source = edinet_source(&fake, KEY);
	let all = [
		"S100SY20",
		"S100SY21",
		"S100SY22",
		"S100SY23",
		"S100SY24",
		"S100SYA4",
		"S100SY25",
		EDINET_NO_CSV_DOC,
	];
	let first = sync(&source, &edinet_claim(&EDINET_DATES, &all), &Open)
		.await
		.unwrap();
	assert_eq!(first.requests, 8);
	assert!(first.filings.is_empty());
	// Another company synced next shares the listings: no request at all.
	let second = sync(&source, &edinet_claim(&EDINET_DATES, &all), &Open)
		.await
		.unwrap();
	assert_eq!(second.requests, 0);
	assert_eq!(second.scanned_days, EDINET_DATES);
	assert_eq!(fake.requested().len(), 8);
}

fn listing_of(count: usize) -> String {
	let rows: Vec<String> = (0..count)
		.map(|index| {
			let (hour, minute) = (10 + index / 60, index % 60);
			format!(
				r#"{{"docID":"S1DEF{index:03}","edinetCode":"E99991","secCode":"99990","filerName":"シンセティック工業株式会社","docTypeCode":"120","periodStart":"2024-04-01","periodEnd":"2025-03-31","submitDateTime":"2025-06-23 {hour}:{minute:02}","parentDocID":null,"withdrawalStatus":"0","csvFlag":"1"}}"#
			)
		})
		.collect();
	format!(
		r#"{{"metadata":{{"status":"200"}},"results":[{}]}}"#,
		rows.join(",")
	)
}

#[tokio::test]
async fn downloads_beyond_the_cap_are_deferred_oldest_first() {
	let fake = FakeEdinet::new();
	fake.lists
		.lock()
		.unwrap()
		.insert("2025-06-23".to_owned(), Ok(listing_of(10)));
	let data = sync(
		&edinet_source(&fake, KEY),
		&edinet_claim(&["2025-06-23"], &[]),
		&Open,
	)
	.await
	.unwrap();
	// One list and eight downloads (each a 404: not available yet).
	assert_eq!(data.requests, 9);
	let deferred: Vec<&str> = data
		.filings
		.iter()
		.filter(|filing| filing.facts_status == EquityFactsStatus::Deferred)
		.map(|filing| filing.metadata.source_document_id.as_str())
		.collect();
	assert_eq!(deferred, ["S1DEF009", "S1DEF008"]);
	assert_eq!(
		data.filings
			.iter()
			.filter(|filing| filing.facts_status == EquityFactsStatus::NotAvailable)
			.count(),
		8
	);
}

#[tokio::test]
async fn edinet_without_a_key_or_a_grant_sends_nothing() {
	let fake = FakeEdinet::new();
	let failure = sync(
		&edinet_source(&fake, None),
		&edinet_claim(&EDINET_DATES, &[]),
		&Open,
	)
	.await
	.unwrap_err();
	assert_eq!(
		(failure.code, failure.upstream_status, failure.requests),
		(EquitySyncFailureCode::SourceNotConfigured, None, 0)
	);
	let failure = sync(
		&edinet_source(&fake, KEY),
		&edinet_claim(&EDINET_DATES, &[]),
		&Closed,
	)
	.await
	.unwrap_err();
	assert_eq!(
		(failure.code, failure.requests),
		(EquitySyncFailureCode::SourceFailed, 0)
	);
	assert!(fake.requested().is_empty());
}

#[tokio::test]
async fn edinet_failures_keep_edinets_status() {
	for (answer, code, status) in [
		(
			Err(SafeFetchError::http(401, "HTTP 401", None)),
			EquitySyncFailureCode::AccessDenied,
			Some(401),
		),
		(
			Err(SafeFetchError::http(429, "HTTP 429", None)),
			EquitySyncFailureCode::RateLimited,
			Some(429),
		),
		(
			Err(SafeFetchError::http(503, "HTTP 503", None)),
			EquitySyncFailureCode::SourceFailed,
			Some(503),
		),
		(
			Err(SafeFetchError::new(SafeFetchErrorCode::Timeout, "timeout")),
			EquitySyncFailureCode::SourceFailed,
			None,
		),
		(
			Ok(r#"{"metadata":{"status":"401","message":"Access denied"}}"#.to_owned()),
			EquitySyncFailureCode::AccessDenied,
			Some(401),
		),
		(
			Ok(r#"{"metadata":{"status":"500"}}"#.to_owned()),
			EquitySyncFailureCode::SourceFailed,
			Some(500),
		),
		(
			Ok(r#"{"results":[]}"#.to_owned()),
			EquitySyncFailureCode::ParseFailed,
			None,
		),
	] {
		let fake = FakeEdinet::new();
		fake.lists
			.lock()
			.unwrap()
			.insert("2024-06-21".to_owned(), answer);
		let failure = sync(
			&edinet_source(&fake, KEY),
			&edinet_claim(&["2020-06-26", "2024-06-21", "2025-06-20"], &[]),
			&Open,
		)
		.await
		.unwrap_err();
		assert_eq!((failure.code, failure.upstream_status), (code, status));
		// The failing date stops the scan.
		assert_eq!(failure.requests, 2);
	}
}

#[tokio::test]
async fn a_document_answer_decides_by_edinets_status() {
	for (answer, outcome) in [
		// HTTP 200 with EDINET's 404 body: the CSV is not there yet.
		(
			Ok(br#"{"metadata":{"status":"404","message":"Not Found"}}"#.to_vec()),
			Ok(None),
		),
		(Err(SafeFetchError::http(404, "HTTP 404", None)), Ok(None)),
		(
			Ok(br#"{"StatusCode":401,"message":"Access denied"}"#.to_vec()),
			Err((EquitySyncFailureCode::AccessDenied, Some(401))),
		),
		(
			Err(SafeFetchError::http(429, "HTTP 429", None)),
			Err((EquitySyncFailureCode::RateLimited, Some(429))),
		),
		(
			// An unreadable document is not available (and listed), not a failed job.
			Ok(b"PK\x03\x04 not really a zip".to_vec()),
			Ok(Some(EdinetReportProblem::NotAZip)),
		),
		(
			Ok(b"<html>maintenance</html>".to_vec()),
			Ok(Some(EdinetReportProblem::NotAZip)),
		),
		(
			Err(SafeFetchError::new(
				SafeFetchErrorCode::ResponseTooLarge,
				"too large",
			)),
			Err((EquitySyncFailureCode::ParseFailed, None)),
		),
	] {
		let fake = FakeEdinet::new();
		fake.documents
			.lock()
			.unwrap()
			.insert("S100SY24".to_owned(), answer);
		let result = sync(
			&edinet_source(&fake, KEY),
			&edinet_claim(&["2024-06-21"], &[]),
			&Open,
		)
		.await;
		match outcome {
			Ok(problem) => {
				let data = result.unwrap();
				assert_eq!(data.filings.len(), 1);
				assert_eq!(
					data.filings[0].facts_status,
					EquityFactsStatus::NotAvailable
				);
				assert!(data.filings[0].facts.is_empty());
				let unreadable: Vec<_> = data
					.unreadable_documents
					.iter()
					.map(|document| (document.source_document_id.as_str(), document.problem))
					.collect();
				assert_eq!(
					unreadable,
					problem
						.map(|problem| ("S100SY24", problem))
						.into_iter()
						.collect::<Vec<_>>()
				);
			}
			Err((code, status)) => {
				let failure = result.unwrap_err();
				assert_eq!((failure.code, failure.upstream_status), (code, status));
				assert_eq!(failure.requests, 2);
			}
		}
	}
}

#[tokio::test]
async fn a_report_cut_by_the_caps_leaves_its_date_unscanned() {
	// One list of 70 reports: 8 downloads (404) and 62 deferred; 60 fit, so
	// that date is listed again by the next job; the empty date is done.
	let fake = FakeEdinet::new();
	fake.lists
		.lock()
		.unwrap()
		.insert("2025-06-23".to_owned(), Ok(listing_of(70)));
	let data = sync(
		&edinet_source(&fake, KEY),
		&edinet_claim(&["2025-06-24", "2025-06-23"], &[]),
		&Open,
	)
	.await
	.unwrap();
	assert!(data.more);
	assert_eq!(data.filings.len(), 60);
	assert_eq!(data.scanned_days, ["2025-06-24"]);
}
