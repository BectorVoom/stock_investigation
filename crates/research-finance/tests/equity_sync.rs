//! ADR-0048: the SEC financial-statement source (J-Quants:
//! `jquants_financials.rs`).
//!
//! 1. Parity: the Rust extraction makes of the synthetic SEC inputs
//!    (`examples/fixtures/equity-sync/*.synthetic.*`) exactly the completion
//!    the TypeScript made of them (`e2e-sec.json`, written by
//!    `scripts/vectors/finance/equitySyncFixtures.ts`).
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
use research_application::ports::Clock;
use research_contracts::equity_financials::{
	EquityAccountingStandard, EquityBusinessDescription, EquityBusinessForm, EquityBusinessStatus,
	EquityFactsStatus, EquityFilingResult, EquityMarket, EquityReportForm, EquitySyncClaim,
	EquitySyncFailureCode, EquitySyncRequest, SecSyncRequest,
};
use research_contracts::json::to_js_json;
use research_finance::equity_sync::{
	COMPLETION_CAPS, CompletionCaps, EquitySyncData, EquitySyncDescriptionUnread,
	EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
};
use research_finance::ports::BeforeRequest;
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

/// `equityConceptsOfProvider("sec")`: US GAAP and IFRS (ADR-0058 §5).
const SEC_CONCEPTS: [&str; 30] = [
	"ifrs-full:Assets",
	"ifrs-full:CashAndCashEquivalents",
	"ifrs-full:CashFlowsFromUsedInFinancingActivities",
	"ifrs-full:CashFlowsFromUsedInInvestingActivities",
	"ifrs-full:CashFlowsFromUsedInOperatingActivities",
	"ifrs-full:Equity",
	"ifrs-full:EquityAttributableToOwnersOfParent",
	"ifrs-full:GrossProfit",
	"ifrs-full:Liabilities",
	"ifrs-full:ProfitLossAttributableToOwnersOfParent",
	"ifrs-full:ProfitLossFromOperatingActivities",
	"ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
	"ifrs-full:Revenue",
	"ifrs-full:RevenueFromContractsWithCustomers",
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

const SEC_CIK: &str = "0009999981";
const SEC_FILED_SINCE: &str = "2020-10-31";
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
		// The 10-K's description is stored: most tests are about the facts.
		described_document_id: Some(TEN_K_ACCESSION.to_owned()),
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
/// The newest original 10-K of the synthetic submissions, and its primary document.
const TEN_K_ACCESSION: &str = "0009999981-25-000110";
const TEN_K_URL: &str =
	"https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm";

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
			(
				TEN_K_URL.to_owned(),
				Ok(fixture_text("sec-10k-0009999981-25-000110.synthetic.htm")),
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
	let mut first = sec_request(None, &[], true);
	first.described_document_id = None;
	let data = sync(&source, &sec_claim(first), &Open).await.unwrap();
	assert_eq!(
		client.requested(),
		[TICKER_DIRECTORY_URL, SUBMISSIONS_URL, FACTS_URL, TEN_K_URL]
	);
	assert_eq!(data.requests, 4);
	assert!(!data.more);
	let expected = fixture_json("e2e-sec.json");
	assert_same_text(
		&to_js_json(&data.filings).unwrap(),
		&expected_filings(&expected),
	);
	// ADR-0053: the 10-K's "Item 1. Business", as the TypeScript reads it.
	let description: EquityBusinessDescription =
		research_contracts::validate(member(&expected, "description")).unwrap();
	assert_eq!(data.description, Some(description));
	assert_eq!(data.description_unread, None);
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

/// A sync that reads the 10-K (nothing stored describes it), with `answer` for its primary document.
async fn sync_reading_the_ten_k(
	answer: Result<String, SecError>,
	gate: &dyn BeforeRequest,
) -> (Arc<FakeSec>, Result<EquitySyncData, EquitySyncFailure>) {
	let client = FakeSec::new();
	client.answer(TEN_K_URL, answer);
	let all = [
		"0009999981-26-000005",
		"0009999981-25-000110",
		"0009999981-24-000108",
	];
	let mut request = sec_request(Some(SEC_CIK), &all, false);
	request.described_document_id = Some("0009999981-24-000108".to_owned());
	let result = sync(&sec_source(&client), &sec_claim(request), gate).await;
	(client, result)
}

#[tokio::test]
async fn a_ten_k_not_described_yet_is_read_once_for_its_business_section() {
	let html = fixture_text("sec-10k-0009999981-25-000110.synthetic.htm");
	let (client, result) = sync_reading_the_ten_k(Ok(html), &Open).await;
	let data = result.unwrap();
	assert_eq!(client.requested(), [SUBMISSIONS_URL, TEN_K_URL]);
	assert_eq!(data.requests, 2);
	let description = data.description.unwrap();
	assert_eq!(description.source.source_document_id, TEN_K_ACCESSION);
	assert_eq!(description.source.source_url, TEN_K_URL);
	assert_eq!(description.status, EquityBusinessStatus::Extracted);
}

#[tokio::test]
async fn a_failed_ten_k_download_is_no_description_and_says_why() {
	let (_, result) =
		sync_reading_the_ten_k(Err(sec_error(SecErrorCode::RateLimited, Some(429))), &Open).await;
	let data = result.unwrap();
	assert_eq!(data.description, None);
	assert_eq!(
		data.description_unread,
		Some(EquitySyncDescriptionUnread {
			code: EquitySyncFailureCode::RateLimited,
			upstream_status: Some(429),
		})
	);
}

#[tokio::test]
async fn an_oversized_ten_k_is_recorded_not_found() {
	let (_, result) =
		sync_reading_the_ten_k(Err(sec_error(SecErrorCode::ResponseTooLarge, None)), &Open).await;
	let data = result.unwrap();
	let description = data.description.unwrap();
	assert_eq!(description.status, EquityBusinessStatus::NotFound);
	assert!(description.paragraphs.is_empty());
	assert_eq!(data.description_unread, None);
}

/// Admits the first request only (the job stops while waiting for the second).
struct FirstOnly(AtomicI64);

#[async_trait]
impl BeforeRequest for FirstOnly {
	async fn before_request(&self) -> bool {
		self.0.fetch_add(1, Ordering::SeqCst) == 0
	}
}

#[tokio::test]
async fn a_job_stopped_before_the_ten_k_fails_as_stopped() {
	let html = fixture_text("sec-10k-0009999981-25-000110.synthetic.htm");
	let (client, result) = sync_reading_the_ten_k(Ok(html), &FirstOnly(AtomicI64::new(0))).await;
	assert_eq!(client.requested(), [SUBMISSIONS_URL]);
	assert_eq!(
		result.unwrap_err(),
		EquitySyncFailure::own(EquitySyncFailureCode::SourceFailed, 1)
	);
}

/* ---------- A foreign private issuer: 20-F under IFRS (ADR-0058 §5) ---------- */

const FOREIGN_SUBMISSIONS_URL: &str = "https://data.sec.gov/submissions/CIK0009999983.json";
const FOREIGN_FACTS_URL: &str = "https://data.sec.gov/api/xbrl/companyfacts/CIK0009999983.json";
const TWENTY_F_ACCESSION: &str = "0009999983-25-000018";
const TWENTY_F_URL: &str =
	"https://www.sec.gov/Archives/edgar/data/9999983/000999998325000018/synm-20241231x20f.htm";

fn foreign_client(submissions: String) -> Arc<FakeSec> {
	let client = FakeSec::new();
	client.answer(FOREIGN_SUBMISSIONS_URL, Ok(submissions));
	client.answer(
		FOREIGN_FACTS_URL,
		Ok(fixture_text(
			"sec-companyfacts-CIK0009999983.synthetic.json",
		)),
	);
	client.answer(
		TWENTY_F_URL,
		Ok(fixture_text(&format!(
			"sec-20f-{TWENTY_F_ACCESSION}.synthetic.htm"
		))),
	);
	client
}

fn foreign_request() -> SecSyncRequest {
	SecSyncRequest {
		cik: Some("0009999983".to_owned()),
		known_accessions: Vec::new(),
		pending_filings: Vec::new(),
		filed_since: "2020-01-01".to_owned(),
		full_check: true,
		described_document_id: None,
	}
}

#[tokio::test]
async fn a_20_f_filer_has_ifrs_filings_and_its_item_4b_as_description() {
	let client = foreign_client(fixture_text("sec-submissions-CIK0009999983.synthetic.json"));
	let data = sync(&sec_source(&client), &sec_claim(foreign_request()), &Open)
		.await
		.unwrap();
	assert_eq!(
		client.requested(),
		[FOREIGN_SUBMISSIONS_URL, FOREIGN_FACTS_URL, TWENTY_F_URL]
	);
	let standards: Vec<_> = data
		.filings
		.iter()
		.map(|filing| {
			(
				filing.metadata.source_document_id.as_str(),
				filing.metadata.form,
				filing.accounting_standard,
			)
		})
		.collect();
	assert_eq!(
		standards,
		[
			(
				"0009999983-25-000044",
				EquityReportForm::TwentyFA,
				Some(EquityAccountingStandard::Ifrs)
			),
			(
				TWENTY_F_ACCESSION,
				EquityReportForm::TwentyF,
				Some(EquityAccountingStandard::Ifrs)
			),
			(
				"0009999983-24-000015",
				EquityReportForm::TwentyF,
				Some(EquityAccountingStandard::Ifrs)
			),
			(
				"0009999983-23-000012",
				EquityReportForm::TwentyF,
				Some(EquityAccountingStandard::UsGaap)
			),
		]
	);
	let description = data.description.unwrap();
	assert_eq!(description.source.form, EquityBusinessForm::TwentyF);
	assert_eq!(description.source.source_document_id, TWENTY_F_ACCESSION);
	assert_eq!(description.status, EquityBusinessStatus::Extracted);
	assert_eq!(description.paragraphs.len(), 3);
}

#[tokio::test]
async fn a_40_f_is_recorded_not_found_without_a_download() {
	let submissions =
		fixture_text("sec-submissions-CIK0009999983.synthetic.json").replace("\"20-F", "\"40-F");
	let client = foreign_client(submissions);
	let mut request = foreign_request();
	request.full_check = false;
	request.known_accessions = [
		"0009999983-25-000044",
		TWENTY_F_ACCESSION,
		"0009999983-24-000015",
		"0009999983-23-000012",
	]
	.map(str::to_owned)
	.to_vec();
	let data = sync(&sec_source(&client), &sec_claim(request), &Open)
		.await
		.unwrap();
	assert_eq!(client.requested(), [FOREIGN_SUBMISSIONS_URL]);
	assert_eq!(data.requests, 1);
	let description = data.description.unwrap();
	assert_eq!(description.source.form, EquityBusinessForm::FortyF);
	assert_eq!(description.status, EquityBusinessStatus::NotFound);
	assert!(description.paragraphs.is_empty());
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
