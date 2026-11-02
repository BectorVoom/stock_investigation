//! ADR-0059: the J-Quants statements source and company-profile source over
//! a scripted transport, with answers captured live on 2026-11-02
//! (`tests/fixtures/jquants/`, trimmed to the fields the runner reads): the
//! request sent (URL, key header, limits), one gate admission per page,
//! paging, the status mapping with J-Quants' status unchanged (ADR-0037),
//! and no request at all without a key or a grant.
#![allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use research_application::ports::{
	FetchedDocument, SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use research_contracts::equity_financials::{
	EquityAccountingStandard, EquityMarket, EquityReportForm, EquityScope, EquitySyncClaim,
	EquitySyncFailureCode, EquitySyncRequest, JquantsSyncRequest,
};
use research_finance::equity_sync::{
	EquitySyncData, EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
};
use research_finance::jquants_financials::{
	CompanyProfileSource, JquantsFinancialsSource, JquantsProfileSource, JquantsProfilesData,
	JquantsProfilesFailure, JquantsProfilesFailureCode, JquantsProfilesQuery,
};
use research_finance::ports::{BeforeRequest, Secret};
use tokio_util::sync::CancellationToken;

const KEY: &str = "test-jquants-key-01";
const TOYOTA_URL: &str = "https://api.jquants.com/v2/fins/summary?code=72030";

fn fixture(name: &str) -> String {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/jquants");
	std::fs::read_to_string(path.join(name)).unwrap()
}

/// Answers each call with the next scripted answer (HTTP 404 once they are
/// used up) and records the URL and options of each.
struct Scripted {
	answers: Mutex<VecDeque<Result<String, SafeFetchError>>>,
	calls: Mutex<Vec<(String, SafeFetchOptions)>>,
}

impl Scripted {
	fn new(answers: Vec<Result<String, SafeFetchError>>) -> Arc<Self> {
		Arc::new(Self {
			answers: Mutex::new(answers.into()),
			calls: Mutex::new(Vec::new()),
		})
	}

	fn urls(&self) -> Vec<String> {
		self.calls
			.lock()
			.unwrap()
			.iter()
			.map(|(url, _)| url.clone())
			.collect()
	}
}

#[async_trait]
impl SafeFetcher for Scripted {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		self.calls
			.lock()
			.unwrap()
			.push((url.to_owned(), options.clone()));
		let answer = self
			.answers
			.lock()
			.unwrap()
			.pop_front()
			.unwrap_or_else(|| Err(SafeFetchError::http(404, "HTTP 404", None)));
		answer.map(|text| FetchedDocument {
			final_url: url.to_owned(),
			content_type: Some("application/json".to_owned()),
			text,
		})
	}
}

/// The runner's gate: grants `limit` admissions, counting every ask.
struct Gate {
	limit: usize,
	asked: AtomicUsize,
}

impl Gate {
	fn open() -> Self {
		Self::granting(usize::MAX)
	}
	fn granting(limit: usize) -> Self {
		Self {
			limit,
			asked: AtomicUsize::new(0),
		}
	}
	fn asked(&self) -> usize {
		self.asked.load(Ordering::SeqCst)
	}
}

#[async_trait]
impl BeforeRequest for Gate {
	async fn before_request(&self) -> bool {
		self.asked.fetch_add(1, Ordering::SeqCst) < self.limit
	}
}

fn claim(code: &str, known: &[&str]) -> EquitySyncClaim {
	EquitySyncClaim {
		company_id: "eqc_jp_1".to_owned(),
		market: EquityMarket::Jp,
		symbol: code.get(..4).unwrap().to_owned(),
		concepts: vec!["jquants:Sales".to_owned()],
		source: EquitySyncRequest::Jquants(JquantsSyncRequest {
			code: code.to_owned(),
			known_disclosures: known.iter().map(|id| (*id).to_owned()).collect(),
		}),
	}
}

async fn sync(
	fetcher: &Arc<Scripted>,
	key: Option<&str>,
	claim: &EquitySyncClaim,
	gate: &Gate,
) -> Result<EquitySyncData, EquitySyncFailure> {
	let source = JquantsFinancialsSource::new(
		key.map(Secret::new),
		Arc::clone(fetcher) as Arc<dyn SafeFetcher>,
	);
	let cancel = CancellationToken::new();
	source
		.sync(EquitySyncQuery {
			target: claim,
			cancel: &cancel,
			before_request: gate,
		})
		.await
}

/// The fixture's records split into two pages, the first naming `key`.
fn two_pages(name: &str, key: &str) -> (String, String) {
	let text = fixture(name);
	let at = text.find("\n\t\t},").unwrap() + "\n\t\t}".len();
	let (head, tail) = text.split_at(at);
	let first = format!("{head}\n\t],\n\t\"pagination_key\": \"{key}\"\n}}");
	let second = format!("{{\n\t\"data\": [{}", tail.strip_prefix(',').unwrap());
	(first, second)
}

#[tokio::test]
async fn toyotas_full_year_summaries_become_two_filings() {
	let fetcher = Scripted::new(vec![Ok(fixture("fins-summary-code-7203.json"))]);
	let gate = Gate::open();
	let data = sync(&fetcher, Some(KEY), &claim("72030", &[]), &gate)
		.await
		.unwrap();
	assert_eq!(fetcher.urls(), [TOYOTA_URL]);
	let (_, options) = fetcher.calls.lock().unwrap()[0].clone();
	assert_eq!(options.x_api_key.as_deref(), Some(KEY));
	assert_eq!(options.accept, "application/json");
	assert_eq!(options.max_bytes, 8_000_000);
	assert!(
		options
			.allowed_hosts
			.as_ref()
			.unwrap()
			.contains("api.jquants.com")
	);
	assert_eq!((gate.asked(), data.requests), (1, 1));
	assert!(!data.more && data.description.is_none());
	let identity = data.identity.unwrap();
	assert_eq!(
		(
			identity.source_company_id.as_str(),
			identity.fiscal_year_end.as_deref()
		),
		("72030", Some("03-31"))
	);
	// Newest first; the quarters are not filings.
	let ids: Vec<&str> = data
		.filings
		.iter()
		.map(|filing| filing.metadata.source_document_id.as_str())
		.collect();
	assert_eq!(ids, ["20260506517369", "20250425524402"]);
	let newest = &data.filings[0];
	assert_eq!(newest.metadata.form, EquityReportForm::EarningsReport);
	assert_eq!(
		newest.metadata.submitted_at.as_deref(),
		Some("2026-05-08T04:55:00.000Z")
	);
	assert_eq!(
		newest.metadata.source_url,
		"https://api.jquants.com/v2/fins/summary?code=72030&date=2026-05-08"
	);
	assert_eq!(
		newest.accounting_standard,
		Some(EquityAccountingStandard::Ifrs)
	);
	// Nine consolidated items (IFRS: no OdP) and six NC items, NCOdP included.
	assert_eq!(newest.facts.len(), 15);
	let sales: Vec<(&str, EquityScope)> = newest
		.facts
		.iter()
		.filter(|fact| fact.concept == "jquants:Sales")
		.map(|fact| (fact.value_decimal.as_str(), fact.scope))
		.collect();
	// `compare_facts` order: the value before the scope.
	assert_eq!(
		sales,
		[
			("18259979000000", EquityScope::Separate),
			("50684952000000", EquityScope::Consolidated)
		]
	);
	assert!(
		newest
			.facts
			.iter()
			.any(|fact| fact.concept == "jquants:OdP" && fact.scope == EquityScope::Separate)
	);
}

#[tokio::test]
async fn a_correction_amends_the_summary_before_it_and_known_ones_are_not_sent() {
	let fetcher = Scripted::new(vec![Ok(fixture("fins-summary-code-2914.json"))]);
	// JT's FY2024 original (2025-02-13) is stored; its correction (2025-03-10) is new.
	let data = sync(
		&fetcher,
		Some(KEY),
		&claim("29140", &["20250212569311"]),
		&Gate::open(),
	)
	.await
	.unwrap();
	let filings: Vec<(&str, EquityReportForm, Option<&str>)> = data
		.filings
		.iter()
		.map(|filing| {
			(
				filing.metadata.source_document_id.as_str(),
				filing.metadata.form,
				filing.metadata.amends_source_document_id.as_deref(),
			)
		})
		.collect();
	assert_eq!(
		filings,
		[
			("20260212555840", EquityReportForm::EarningsReport, None),
			(
				"20250310590632",
				EquityReportForm::AmendedEarningsReport,
				Some("20250212569311")
			),
		]
	);
	assert_eq!(
		data.identity.unwrap().fiscal_year_end.as_deref(),
		Some("12-31")
	);
}

#[tokio::test]
async fn every_page_is_read_and_admitted() {
	let (first, second) = two_pages("fins-summary-code-7203.json", "page-2");
	let fetcher = Scripted::new(vec![Ok(first), Ok(second)]);
	let gate = Gate::open();
	let paged = sync(&fetcher, Some(KEY), &claim("72030", &[]), &gate)
		.await
		.unwrap();
	assert_eq!(
		fetcher.urls(),
		[
			TOYOTA_URL.to_owned(),
			format!("{TOYOTA_URL}&pagination_key=page-2")
		]
	);
	assert_eq!((gate.asked(), paged.requests), (2, 2));
	let whole = sync(
		&Scripted::new(vec![Ok(fixture("fins-summary-code-7203.json"))]),
		Some(KEY),
		&claim("72030", &[]),
		&Gate::open(),
	)
	.await
	.unwrap();
	assert_eq!(paged.filings, whole.filings);
	assert_eq!(paged.identity, whole.identity);
}

#[tokio::test]
async fn more_than_twenty_pages_is_a_parse_failure() {
	let page = r#"{"data": [], "pagination_key": "again"}"#.to_owned();
	let fetcher = Scripted::new((0..25).map(|_| Ok(page.clone())).collect());
	let failure = sync(&fetcher, Some(KEY), &claim("72030", &[]), &Gate::open())
		.await
		.unwrap_err();
	assert_eq!(
		(failure.code, failure.upstream_status, failure.requests),
		(EquitySyncFailureCode::ParseFailed, None, 20)
	);
}

#[tokio::test]
async fn an_empty_answer_is_a_success_without_filings() {
	let fetcher = Scripted::new(vec![Ok(fixture("fins-summary-code-99999.json"))]);
	let data = sync(&fetcher, Some(KEY), &claim("99990", &[]), &Gate::open())
		.await
		.unwrap();
	assert!(data.identity.is_none() && data.filings.is_empty() && !data.more);
}

#[tokio::test]
async fn statuses_keep_j_quants_status() {
	let http = |status: u16, body: Option<String>| {
		Err(SafeFetchError::http(status, format!("HTTP {status}"), body))
	};
	let cases = [
		(
			http(400, Some(fixture("fins-summary-code-abc.json"))),
			EquitySyncFailureCode::ParseFailed,
			Some(400),
		),
		(
			http(401, None),
			EquitySyncFailureCode::AccessDenied,
			Some(401),
		),
		(
			http(403, None),
			EquitySyncFailureCode::AccessDenied,
			Some(403),
		),
		(
			http(429, None),
			EquitySyncFailureCode::RateLimited,
			Some(429),
		),
		(
			http(404, None),
			EquitySyncFailureCode::SourceFailed,
			Some(404),
		),
		(
			http(503, None),
			EquitySyncFailureCode::SourceFailed,
			Some(503),
		),
		(
			Err(SafeFetchError::new(SafeFetchErrorCode::Timeout, "timeout")),
			EquitySyncFailureCode::SourceFailed,
			None,
		),
		(
			Err(SafeFetchError::new(
				SafeFetchErrorCode::ResponseTooLarge,
				"too large",
			)),
			EquitySyncFailureCode::ParseFailed,
			None,
		),
		// Not JSON: a transport failure, as for the prices.
		(
			Ok("<html>maintenance</html>".to_owned()),
			EquitySyncFailureCode::SourceFailed,
			None,
		),
		// JSON without a `data` array.
		(
			Ok(r#"{"message": "x"}"#.to_owned()),
			EquitySyncFailureCode::ParseFailed,
			None,
		),
	];
	for (answer, code, status) in cases {
		let fetcher = Scripted::new(vec![answer]);
		let failure = sync(&fetcher, Some(KEY), &claim("72030", &[]), &Gate::open())
			.await
			.unwrap_err();
		assert_eq!(
			(failure.code, failure.upstream_status, failure.requests),
			(code, status, 1),
			"{code:?}"
		);
	}
}

#[tokio::test]
async fn no_key_or_no_grant_sends_nothing() {
	let fetcher = Scripted::new(Vec::new());
	let gate = Gate::open();
	let failure = sync(&fetcher, None, &claim("72030", &[]), &gate)
		.await
		.unwrap_err();
	assert_eq!(
		(failure.code, failure.requests, gate.asked()),
		(EquitySyncFailureCode::SourceNotConfigured, 0, 0)
	);
	let refused = Gate::granting(0);
	let failure = sync(&fetcher, Some(KEY), &claim("72030", &[]), &refused)
		.await
		.unwrap_err();
	assert_eq!(
		(failure.code, failure.requests, refused.asked()),
		(EquitySyncFailureCode::SourceFailed, 0, 1)
	);
	assert!(fetcher.urls().is_empty());
}

/* ---------- Company profiles (ADR-0059 §3) ---------- */

async fn profiles(
	fetcher: &Arc<Scripted>,
	gate: &Gate,
) -> Result<JquantsProfilesData, JquantsProfilesFailure> {
	let source = JquantsProfileSource::new(
		Secret::new(KEY),
		Arc::clone(fetcher) as Arc<dyn SafeFetcher>,
	);
	let cancel = CancellationToken::new();
	source
		.fetch_profiles(JquantsProfilesQuery {
			cancel: &cancel,
			before_request: gate,
		})
		.await
}

#[tokio::test]
async fn the_master_gives_toyotas_profile() {
	let fetcher = Scripted::new(vec![Ok(fixture("equities-master-code-7203.json"))]);
	let gate = Gate::open();
	let data = profiles(&fetcher, &gate).await.unwrap();
	assert_eq!(
		fetcher.urls(),
		["https://api.jquants.com/v2/equities/master"]
	);
	assert_eq!((gate.asked(), data.requests), (1, 1));
	let [toyota] = data.profiles.as_slice() else {
		panic!("one profile expected: {:?}", data.profiles);
	};
	assert_eq!(toyota.symbol, "7203");
	assert_eq!(toyota.name_en.as_deref(), Some("TOYOTA MOTOR CORPORATION"));
	assert_eq!(
		(toyota.sector33_code.as_str(), toyota.sector33_name.as_str()),
		("3700", "輸送用機器")
	);
	assert_eq!(toyota.scale_category.as_deref(), Some("TOPIX Core30"));
	assert_eq!(
		(
			toyota.market_segment_code.as_str(),
			toyota.market_segment_name.as_str()
		),
		("0111", "プライム")
	);
	assert_eq!(toyota.as_of, "2026-08-10");
}

#[tokio::test]
async fn a_failed_master_names_its_code_and_status() {
	let cases = [
		(
			Err(SafeFetchError::http(403, "HTTP 403", None)),
			JquantsProfilesFailureCode::AccessDenied,
			Some(403),
		),
		(
			Err(SafeFetchError::http(429, "HTTP 429", None)),
			JquantsProfilesFailureCode::RateLimited,
			Some(429),
		),
		// Unlike the statements, a 400 is just a failed source here.
		(
			Err(SafeFetchError::http(400, "HTTP 400", None)),
			JquantsProfilesFailureCode::SourceFailed,
			Some(400),
		),
		(
			Ok(r#"{"data": {}}"#.to_owned()),
			JquantsProfilesFailureCode::ParseFailed,
			None,
		),
	];
	for (answer, code, status) in cases {
		let failure = profiles(&Scripted::new(vec![answer]), &Gate::open())
			.await
			.unwrap_err();
		assert_eq!(
			(failure.code, failure.upstream_status, failure.requests),
			(code, status, 1)
		);
	}
	let refused = profiles(&Scripted::new(Vec::new()), &Gate::granting(0))
		.await
		.unwrap_err();
	assert_eq!(
		(refused.code, refused.requests),
		(JquantsProfilesFailureCode::SourceFailed, 0)
	);
}
