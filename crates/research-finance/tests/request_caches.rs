//! ADR-0039: the FRED metadata cache and the 13F filing cache send fewer
//! requests without changing what a call returns.
// Test doubles outside `#[test]` functions may unwrap and panic as well.
#![allow(clippy::unwrap_used, clippy::panic)]
use async_trait::async_trait;
use research_application::ports::{
	Clock, FetchedDocument, SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use research_contracts::market::MarketUnavailableCode;
use research_finance::fred::{FRED_META_CACHE_ENTRIES, FRED_META_TTL_MS, FredSeriesSource};
use research_finance::ports::{
	AdmitRequest, MarketRequestAdmission, MarketSeriesSource, Secret, SeriesQuery,
};
use research_finance::sec_13f::{Edgar13FSource, Sec13FSource};
use research_finance::sec_client::{SecClient, SecDocument, SecError, SecErrorCode, SecRequest};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

struct TestClock(AtomicI64);
impl TestClock {
	fn advance(&self, ms: i64) {
		self.0.fetch_add(ms, Ordering::SeqCst);
	}
}
impl Clock for TestClock {
	fn now_ms(&self) -> i64 {
		self.0.load(Ordering::SeqCst)
	}
	fn now_iso(&self) -> String {
		String::new()
	}
}

/* ---------- FRED ---------- */

const META: &str = r#"{"seriess":[{"id":"VIXCLS","title":"CBOE Volatility Index: VIX","units":"Index","frequency_short":"D","seasonal_adjustment_short":"NSA"}]}"#;
const OBSERVATIONS: &str =
	r#"{"observations":[{"date":"2026-10-23","value":"16.4"},{"date":"2026-10-22","value":"."}]}"#;

/// Answers `/fred/series` and `/fred/series/observations` with whatever the
/// test set last, and records which of the two each request was.
struct FredFetcher {
	meta: Mutex<Result<String, SafeFetchError>>,
	observations: Mutex<Result<String, SafeFetchError>>,
	requests: Mutex<Vec<String>>,
}
impl FredFetcher {
	fn new() -> Self {
		Self {
			meta: Mutex::new(Ok(META.to_owned())),
			observations: Mutex::new(Ok(OBSERVATIONS.to_owned())),
			requests: Mutex::new(Vec::new()),
		}
	}
	fn set_meta(&self, answer: Result<&str, SafeFetchError>) {
		*self.meta.lock().unwrap() = answer.map(str::to_owned);
	}
	fn set_observations(&self, answer: Result<&str, SafeFetchError>) {
		*self.observations.lock().unwrap() = answer.map(str::to_owned);
	}
	/// The requests since the last call, as `meta:<id>` / `observations:<id>`.
	fn take(&self) -> Vec<String> {
		std::mem::take(&mut *self.requests.lock().unwrap())
	}
}
#[async_trait]
impl SafeFetcher for FredFetcher {
	async fn fetch_text(
		&self,
		url: &str,
		_: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		let parsed = url::Url::parse(url).unwrap();
		let id = parsed
			.query_pairs()
			.find(|(key, _)| key == "series_id")
			.map(|(_, value)| value.into_owned())
			.unwrap();
		let (kind, answer) = match parsed.path() {
			"/fred/series" => ("meta", &self.meta),
			"/fred/series/observations" => ("observations", &self.observations),
			other => panic!("unexpected FRED path {other}"),
		};
		self.requests.lock().unwrap().push(format!("{kind}:{id}"));
		let text = answer.lock().unwrap().clone()?;
		Ok(FetchedDocument {
			final_url: url.to_owned(),
			content_type: Some("application/json".to_owned()),
			text,
		})
	}
}

fn fred() -> (FredSeriesSource, Arc<FredFetcher>, Arc<TestClock>) {
	let fetcher = Arc::new(FredFetcher::new());
	let clock = Arc::new(TestClock(AtomicI64::new(1_790_000_000_000)));
	let source =
		FredSeriesSource::new(Secret::new("fred-test-key"), fetcher.clone(), clock.clone());
	(source, fetcher, clock)
}

/// Answers the scripted admissions in turn (then `Granted`) and counts them.
#[derive(Default)]
struct Admissions {
	answers: Vec<MarketRequestAdmission>,
	asked: Mutex<usize>,
}
impl Admissions {
	fn new(answers: &[MarketRequestAdmission]) -> Self {
		Self {
			answers: answers.to_vec(),
			asked: Mutex::new(0),
		}
	}
	fn asked(&self) -> usize {
		*self.asked.lock().unwrap()
	}
}
#[async_trait]
impl AdmitRequest for Admissions {
	async fn admit(&self) -> MarketRequestAdmission {
		let mut asked = self.asked.lock().unwrap();
		let answer = self
			.answers
			.get(*asked)
			.copied()
			.unwrap_or(MarketRequestAdmission::Granted);
		*asked += 1;
		answer
	}
}

async fn fetch_admitted(
	source: &FredSeriesSource,
	symbol: &str,
	gate: &Admissions,
) -> Result<research_finance::ports::SeriesData, research_finance::ports::MarketUnavailable> {
	let cancel = CancellationToken::new();
	source
		.fetch_series(SeriesQuery {
			symbol,
			from: None,
			max_observations: 10,
			cancel: &cancel,
			before_request: gate,
		})
		.await
}

async fn fetch(
	source: &FredSeriesSource,
	symbol: &str,
) -> Result<research_finance::ports::SeriesData, research_finance::ports::MarketUnavailable> {
	fetch_admitted(source, symbol, &Admissions::default()).await
}

#[tokio::test]
async fn fred_asks_twice_for_an_uncached_series_and_once_when_the_metadata_is_cached() {
	let (source, fetcher, _) = fred();
	let first = Admissions::default();
	assert!(fetch_admitted(&source, "VIXCLS", &first).await.is_ok());
	assert_eq!(first.asked(), 2);
	assert_eq!(fetcher.take(), ["meta:VIXCLS", "observations:VIXCLS"]);
	let second = Admissions::default();
	assert!(fetch_admitted(&source, "VIXCLS", &second).await.is_ok());
	assert_eq!(second.asked(), 1);
	assert_eq!(fetcher.take(), ["observations:VIXCLS"]);
}

#[tokio::test]
async fn fred_sends_nothing_it_was_not_admitted_for() {
	let (source, fetcher, _) = fred();
	let spent = Admissions::new(&[MarketRequestAdmission::BudgetSpent]);
	let error = fetch_admitted(&source, "VIXCLS", &spent)
		.await
		.err()
		.unwrap();
	assert_eq!(error.code, MarketUnavailableCode::RateLimited);
	// Nothing was sent, so FRED answered nothing (§4a).
	assert_eq!(error.upstream_status, None);
	assert!(fetcher.take().is_empty());
	// Stopped between the two: the metadata was fetched (and cached), the observations were not.
	let stopped = Admissions::new(&[
		MarketRequestAdmission::Granted,
		MarketRequestAdmission::Stopped,
	]);
	assert!(fetch_admitted(&source, "VIXCLS", &stopped).await.is_err());
	assert_eq!(fetcher.take(), ["meta:VIXCLS"]);
	let after = Admissions::default();
	assert!(fetch_admitted(&source, "VIXCLS", &after).await.is_ok());
	assert_eq!(after.asked(), 1);
}

#[tokio::test]
async fn fred_second_fetch_within_a_day_sends_only_the_observations_request() {
	let (source, fetcher, clock) = fred();
	let first = fetch(&source, "VIXCLS").await.unwrap();
	assert_eq!(fetcher.take(), ["meta:VIXCLS", "observations:VIXCLS"]);
	clock.advance(FRED_META_TTL_MS - 1);
	let second = fetch(&source, "VIXCLS").await.unwrap();
	assert_eq!(fetcher.take(), ["observations:VIXCLS"]);
	assert_eq!(second.meta, first.meta);
	assert_eq!(second.observations, first.observations);
}

#[tokio::test]
async fn fred_after_a_day_sends_both_requests_again() {
	let (source, fetcher, clock) = fred();
	fetch(&source, "VIXCLS").await.unwrap();
	fetcher.take();
	clock.advance(FRED_META_TTL_MS);
	fetch(&source, "VIXCLS").await.unwrap();
	assert_eq!(fetcher.take(), ["meta:VIXCLS", "observations:VIXCLS"]);
}

#[tokio::test]
async fn fred_invalid_or_failed_metadata_is_not_cached() {
	let (source, fetcher, _) = fred();
	// An empty title fails validation.
	fetcher.set_meta(Ok(&META.replace("CBOE Volatility Index: VIX", " ")));
	let invalid = fetch(&source, "VIXCLS").await.unwrap_err();
	assert_eq!(invalid.code, MarketUnavailableCode::SourceFailed);
	assert_eq!(fetcher.take(), ["meta:VIXCLS"]);
	// FRED's not-found and auth answers.
	fetcher.set_meta(Err(SafeFetchError::http(
		400,
		"HTTP 400",
		Some(
			r#"{"error_code":400,"error_message":"Bad Request.  The series does not exist."}"#
				.to_owned(),
		),
	)));
	let missing = fetch(&source, "VIXCLS").await.unwrap_err();
	assert_eq!(missing.code, MarketUnavailableCode::SeriesNotFound);
	fetcher.set_meta(Ok(r#"{"seriess":[]}"#));
	let empty = fetch(&source, "VIXCLS").await.unwrap_err();
	assert_eq!(empty.code, MarketUnavailableCode::SeriesNotFound);
	fetcher.set_meta(Err(SafeFetchError::http(
		400,
		"HTTP 400",
		Some(r#"{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered."}"#.to_owned()),
	)));
	let auth = fetch(&source, "VIXCLS").await.unwrap_err();
	assert_eq!(auth.code, MarketUnavailableCode::SourceAuthFailed);
	fetcher.set_meta(Err(SafeFetchError::new(
		SafeFetchErrorCode::NetworkError,
		"down",
	)));
	fetch(&source, "VIXCLS").await.unwrap_err();
	assert_eq!(fetcher.take(), ["meta:VIXCLS"; 4]);
	// Valid again: asked for, then cached.
	fetcher.set_meta(Ok(META));
	fetch(&source, "VIXCLS").await.unwrap();
	fetch(&source, "VIXCLS").await.unwrap();
	assert_eq!(
		fetcher.take(),
		["meta:VIXCLS", "observations:VIXCLS", "observations:VIXCLS"]
	);
}

#[tokio::test]
async fn fred_an_observations_failure_keeps_the_cached_metadata() {
	let (source, fetcher, _) = fred();
	fetcher.set_observations(Err(SafeFetchError::http(429, "HTTP 429", None)));
	let limited = fetch(&source, "VIXCLS").await.unwrap_err();
	assert_eq!(limited.code, MarketUnavailableCode::RateLimited);
	assert_eq!(fetcher.take(), ["meta:VIXCLS", "observations:VIXCLS"]);
	fetcher.set_observations(Ok(OBSERVATIONS));
	fetch(&source, "VIXCLS").await.unwrap();
	assert_eq!(fetcher.take(), ["observations:VIXCLS"]);
}

#[tokio::test]
async fn fred_the_cache_holds_at_most_its_entry_limit() {
	let (source, fetcher, _) = fred();
	let ids: Vec<String> = (0..=FRED_META_CACHE_ENTRIES)
		.map(|n| format!("S{n}"))
		.collect();
	for id in &ids {
		fetch(&source, id).await.unwrap();
	}
	fetcher.take();
	// The newest entries are still held; the first one was evicted.
	fetch(&source, &ids[FRED_META_CACHE_ENTRIES]).await.unwrap();
	fetch(&source, &ids[1]).await.unwrap();
	assert_eq!(
		fetcher.take(),
		[
			format!("observations:{}", ids[FRED_META_CACHE_ENTRIES]),
			format!("observations:{}", ids[1]),
		]
	);
	fetch(&source, &ids[0]).await.unwrap();
	assert_eq!(
		fetcher.take(),
		[
			format!("meta:{}", ids[0]),
			format!("observations:{}", ids[0])
		]
	);
}

/* ---------- 13F ---------- */

const CIK: &str = "0009999993";
const SUBMISSIONS_URL: &str = "https://data.sec.gov/submissions/CIK0009999993.json";

fn filing_url(accession: &str) -> String {
	format!(
		"https://www.sec.gov/Archives/edgar/data/9999993/{}/{accession}.txt",
		accession.replace('-', "")
	)
}

type Row = (&'static str, &'static str, &'static str);

/// `(accession, filed, period)` rows, all on form 13F-HR.
fn submissions(rows: &[Row]) -> String {
	let column = |pick: fn(&Row) -> &'static str| {
		serde_json::to_string(&rows.iter().map(pick).collect::<Vec<_>>()).unwrap()
	};
	format!(
		r#"{{"name":"Synthetic Capital Management LP","filings":{{"recent":{{"accessionNumber":{},"filingDate":{},"reportDate":{},"form":{}}}}}}}"#,
		column(|r| r.0),
		column(|r| r.1),
		column(|r| r.2),
		serde_json::to_string(&vec!["13F-HR"; rows.len()]).unwrap()
	)
}

fn filing_text(shares: u32) -> String {
	format!(
		"<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<TEXT>\n<XML>\n<informationTable><infoTable><nameOfIssuer>SYNTHETIC CORP</nameOfIssuer><cusip>999999AA1</cusip><value>{shares}</value><shrsOrPrnAmt><sshPrnamt>{shares}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></informationTable>\n</XML>\n</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>"
	)
}

/// Serves documents by URL and records every URL asked for.
#[derive(Default)]
struct SecPages {
	pages: Mutex<HashMap<String, Result<String, SecError>>>,
	requests: Mutex<Vec<String>>,
}
impl SecPages {
	fn set(&self, url: &str, answer: Result<String, SecError>) {
		self.pages.lock().unwrap().insert(url.to_owned(), answer);
	}
	fn take(&self) -> Vec<String> {
		std::mem::take(&mut *self.requests.lock().unwrap())
	}
}
#[async_trait]
impl SecClient for SecPages {
	async fn fetch_document(&self, url: &str, _: SecRequest<'_>) -> Result<SecDocument, SecError> {
		self.requests.lock().unwrap().push(url.to_owned());
		let answer = self.pages.lock().unwrap().get(url).cloned();
		let text = answer.unwrap_or_else(|| Err(SecError::new(SecErrorCode::NoData, "no page")))?;
		Ok(SecDocument {
			url: url.to_owned(),
			text,
		})
	}
}

const Q1: Row = ("0009999993-26-000001", "2026-05-15", "2026-03-31");
const Q2: Row = ("0009999993-26-000004", "2026-08-14", "2026-06-30");
const Q3: Row = ("0009999993-26-000009", "2026-11-14", "2026-09-30");

fn thirteen_f() -> (Edgar13FSource, Arc<SecPages>) {
	let pages = Arc::new(SecPages::default());
	pages.set(SUBMISSIONS_URL, Ok(submissions(&[Q2, Q1])));
	pages.set(&filing_url(Q1.0), Ok(filing_text(100)));
	pages.set(&filing_url(Q2.0), Ok(filing_text(200)));
	pages.set(&filing_url(Q3.0), Ok(filing_text(300)));
	(Edgar13FSource::new(pages.clone()), pages)
}

#[tokio::test]
async fn thirteen_f_second_call_sends_only_the_submissions_request() {
	let (source, pages) = thirteen_f();
	let first = source.latest_holdings(CIK, None).await.unwrap();
	assert_eq!(
		pages.take(),
		[
			SUBMISSIONS_URL.to_owned(),
			filing_url(Q2.0),
			filing_url(Q1.0)
		]
	);
	// The same manager, written another way: the CIK is normalised first.
	let second = source.latest_holdings("CIK9999993", None).await.unwrap();
	assert_eq!(pages.take(), [SUBMISSIONS_URL]);
	assert_eq!(
		serde_json::to_value(&second).unwrap(),
		serde_json::to_value(&first).unwrap()
	);
}

#[tokio::test]
async fn thirteen_f_a_newer_filing_is_fetched_and_the_old_current_one_is_reused() {
	let (source, pages) = thirteen_f();
	source.latest_holdings(CIK, None).await.unwrap();
	pages.take();
	pages.set(SUBMISSIONS_URL, Ok(submissions(&[Q3, Q2, Q1])));
	let report = source.latest_holdings(CIK, None).await.unwrap();
	assert_eq!(pages.take(), [SUBMISSIONS_URL.to_owned(), filing_url(Q3.0)]);
	assert_eq!(report.current.filing.accession_number, Q3.0);
	let previous = report.previous.unwrap();
	assert_eq!(previous.filing.accession_number, Q2.0);
	assert_eq!(previous.holdings[0].reported_shares, 200.0);
	assert_eq!(report.current.holdings[0].reported_shares, 300.0);
}

#[tokio::test]
async fn thirteen_f_a_failed_load_is_not_cached() {
	let (source, pages) = thirteen_f();
	pages.set(
		&filing_url(Q2.0),
		Err(SecError::new(SecErrorCode::FetchFailed, "HTTP 503")),
	);
	source.latest_holdings(CIK, None).await.unwrap_err();
	assert_eq!(pages.take(), [SUBMISSIONS_URL.to_owned(), filing_url(Q2.0)]);
	// A filing without an information table fails to parse: not cached either.
	pages.set(
		&filing_url(Q2.0),
		Ok("<SEC-DOCUMENT></SEC-DOCUMENT>".to_owned()),
	);
	source.latest_holdings(CIK, None).await.unwrap_err();
	assert_eq!(pages.take(), [SUBMISSIONS_URL.to_owned(), filing_url(Q2.0)]);
	pages.set(&filing_url(Q2.0), Ok(filing_text(200)));
	source.latest_holdings(CIK, None).await.unwrap();
	assert_eq!(
		pages.take(),
		[
			SUBMISSIONS_URL.to_owned(),
			filing_url(Q2.0),
			filing_url(Q1.0)
		]
	);
}

#[tokio::test]
async fn thirteen_f_a_cache_hit_fails_like_a_cancelled_fetch_once_the_job_is_stopped() {
	let (source, pages) = thirteen_f();
	source.latest_holdings(CIK, None).await.unwrap();
	pages.take();
	// The fake client ignores the token, so the submissions index still
	// arrives: the stop lands between it and the cached filing.
	let cancel = CancellationToken::new();
	cancel.cancel();
	let error = source
		.latest_holdings(CIK, Some(&cancel))
		.await
		.unwrap_err();
	assert_eq!(pages.take(), [SUBMISSIONS_URL]);
	// What `PacedSecClient` makes of the fetcher's caller-abort TIMEOUT.
	assert_eq!(error.code, SecErrorCode::FetchFailed);
	assert_eq!(error.detail, "TIMEOUT: aborted by the caller");
	assert!(error.retryable);
	assert_eq!(error.upstream_status, None);
}

/* ---------- SEC ticker directory ---------- */

const DIRECTORY: &str = r#"{"fields":["cik","name","ticker","exchange"],"data":[[9999991,"Synthetic Alpha Devices Inc.","XTESTA","Nasdaq"]]}"#;
const FACTS_URL: &str = "https://data.sec.gov/api/xbrl/companyfacts/CIK0009999991.json";

/// Serves the directory (each request takes the next scripted answer, the
/// last one repeating) and empty company facts; yields once per request so
/// concurrent callers overlap.
struct DirectoryPages {
	directory: Mutex<Vec<Result<String, SecError>>>,
	directory_requests: AtomicI64,
}
#[async_trait]
impl SecClient for DirectoryPages {
	async fn fetch_document(&self, url: &str, _: SecRequest<'_>) -> Result<SecDocument, SecError> {
		tokio::task::yield_now().await;
		let text = if url == research_finance::sec_financials::SEC_TICKER_DIRECTORY_URL {
			self.directory_requests.fetch_add(1, Ordering::SeqCst);
			let mut answers = self.directory.lock().unwrap();
			if answers.len() > 1 {
				answers.remove(0)
			} else {
				answers.first().cloned().unwrap()
			}?
		} else {
			assert_eq!(url, FACTS_URL);
			r#"{"cik":9999991,"entityName":"Synthetic Alpha Devices Inc.","facts":{}}"#.to_owned()
		};
		Ok(SecDocument {
			url: url.to_owned(),
			text,
		})
	}
}

fn directory_source(
	answers: Vec<Result<String, SecError>>,
) -> (
	research_finance::sec_financials::EdgarFinancialsSource,
	Arc<DirectoryPages>,
) {
	let pages = Arc::new(DirectoryPages {
		directory: Mutex::new(answers),
		directory_requests: AtomicI64::new(0),
	});
	let clock = Arc::new(TestClock(AtomicI64::new(1_000)));
	(
		research_finance::sec_financials::EdgarFinancialsSource::new(pages.clone(), clock),
		pages,
	)
}

#[tokio::test]
async fn sec_directory_concurrent_misses_share_one_download() {
	use research_finance::sec_financials::SecFinancialsSource;
	let (source, pages) = directory_source(vec![Ok(DIRECTORY.to_owned())]);
	let (a, b, c) = tokio::join!(
		source.latest_annual_financials("XTESTA", None),
		source.latest_annual_financials("xtesta", None),
		source.latest_annual_financials("XTESTA", None),
	);
	assert!(a.is_ok() && b.is_ok() && c.is_ok());
	assert_eq!(pages.directory_requests.load(Ordering::SeqCst), 1);
}

/// Directory requests wait until the test releases them; each records its
/// cancellation token. Company facts answer at once.
#[derive(Default)]
struct HeldDirectory {
	release: tokio::sync::Notify,
	tokens: Mutex<Vec<CancellationToken>>,
	/// Directory requests still to fail (after their release).
	failures: AtomicI64,
}
#[async_trait]
impl SecClient for HeldDirectory {
	async fn fetch_document(
		&self,
		url: &str,
		request: SecRequest<'_>,
	) -> Result<SecDocument, SecError> {
		let text = if url == research_finance::sec_financials::SEC_TICKER_DIRECTORY_URL {
			self.tokens
				.lock()
				.unwrap()
				.push(request.cancel.cloned().unwrap());
			self.release.notified().await;
			if self.failures.fetch_sub(1, Ordering::SeqCst) > 0 {
				return Err(SecError::new(
					SecErrorCode::FetchFailed,
					"SEC could not be reached",
				));
			}
			DIRECTORY.to_owned()
		} else {
			r#"{"cik":9999991,"entityName":"Synthetic Alpha Devices Inc.","facts":{}}"#.to_owned()
		};
		Ok(SecDocument {
			url: url.to_owned(),
			text,
		})
	}
}

fn held_source() -> (
	Arc<research_finance::sec_financials::EdgarFinancialsSource>,
	Arc<HeldDirectory>,
) {
	let pages = Arc::new(HeldDirectory::default());
	let clock = Arc::new(TestClock(AtomicI64::new(1_000)));
	(
		Arc::new(
			research_finance::sec_financials::EdgarFinancialsSource::new(pages.clone(), clock),
		),
		pages,
	)
}

#[tokio::test]
async fn sec_directory_a_cancelled_waiter_leaves_without_cancelling_the_download_others_need() {
	use research_finance::sec_financials::SecFinancialsSource;
	let (source, pages) = held_source();
	let stop = CancellationToken::new();
	let staying = tokio::spawn({
		let source = source.clone();
		async move { source.latest_annual_financials("XTESTA", None).await }
	});
	let leaving = tokio::spawn({
		let source = source.clone();
		let stop = stop.clone();
		async move { source.latest_annual_financials("XTESTA", Some(&stop)).await }
	});
	while pages.tokens.lock().unwrap().is_empty() {
		tokio::task::yield_now().await;
	}
	stop.cancel();
	// Answered while the download is still pending, like a cancelled SEC fetch.
	let left = leaving.await.unwrap();
	assert_eq!(left.err().map(|e| e.code), Some(SecErrorCode::FetchFailed));
	assert!(!pages.tokens.lock().unwrap()[0].is_cancelled());
	pages.release.notify_waiters();
	assert!(staying.await.unwrap().is_ok());
	assert_eq!(pages.tokens.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn sec_directory_the_last_waiter_leaving_cancels_the_download() {
	use research_finance::sec_financials::SecFinancialsSource;
	let (source, pages) = held_source();
	let stop = CancellationToken::new();
	let only = tokio::spawn({
		let source = source.clone();
		let stop = stop.clone();
		async move { source.latest_annual_financials("XTESTA", Some(&stop)).await }
	});
	while pages.tokens.lock().unwrap().is_empty() {
		tokio::task::yield_now().await;
	}
	stop.cancel();
	assert!(only.await.unwrap().is_err());
	assert!(pages.tokens.lock().unwrap()[0].is_cancelled());
	// A new caller does not join the abandoned download.
	let next = tokio::spawn({
		let source = source.clone();
		async move { source.latest_annual_financials("XTESTA", None).await }
	});
	while pages.tokens.lock().unwrap().len() < 2 {
		tokio::task::yield_now().await;
	}
	pages.release.notify_waiters();
	assert!(next.await.unwrap().is_ok());
}

#[tokio::test]
async fn sec_directory_concurrent_failures_share_one_download_and_a_later_call_retries() {
	use research_finance::sec_financials::SecFinancialsSource;
	let (source, pages) = held_source();
	pages.failures.store(1, Ordering::SeqCst);
	let callers: Vec<_> = (0..3)
		.map(|_| {
			let source = source.clone();
			tokio::spawn(async move { source.latest_annual_financials("XTESTA", None).await })
		})
		.collect();
	while pages.tokens.lock().unwrap().is_empty() {
		tokio::task::yield_now().await;
	}
	for _ in 0..10 {
		tokio::task::yield_now().await;
	}
	pages.release.notify_waiters();
	for caller in callers {
		let result = caller.await.unwrap();
		assert_eq!(
			result.err().map(|e| e.code),
			Some(SecErrorCode::FetchFailed)
		);
	}
	assert_eq!(pages.tokens.lock().unwrap().len(), 1);
	// The failure is not kept: an independent later call asks SEC again.
	let later = tokio::spawn({
		let source = source.clone();
		async move { source.latest_annual_financials("XTESTA", None).await }
	});
	while pages.tokens.lock().unwrap().len() < 2 {
		tokio::task::yield_now().await;
	}
	pages.release.notify_waiters();
	assert!(later.await.unwrap().is_ok());
}

/// A pacing gate that waits for `open` (when held) and then answers `answer`,
/// counting how often it was asked.
struct Gate {
	answer: bool,
	held: bool,
	open: tokio::sync::Notify,
	asked: AtomicI64,
}
impl Gate {
	fn new(answer: bool, held: bool) -> Arc<Self> {
		Arc::new(Self {
			answer,
			held,
			open: tokio::sync::Notify::new(),
			asked: AtomicI64::new(0),
		})
	}
	fn asked(&self) -> i64 {
		self.asked.load(Ordering::SeqCst)
	}
}
#[async_trait]
impl research_finance::ports::BeforeRequest for Gate {
	async fn before_request(&self) -> bool {
		self.asked.fetch_add(1, Ordering::SeqCst);
		if self.held {
			self.open.notified().await;
		}
		self.answer
	}
}

fn ticker_directory() -> (
	Arc<research_finance::sec_financials::SecTickerDirectory>,
	Arc<DirectoryPages>,
) {
	let pages = Arc::new(DirectoryPages {
		directory: Mutex::new(vec![Ok(DIRECTORY.to_owned())]),
		directory_requests: AtomicI64::new(0),
	});
	let clock = Arc::new(TestClock(AtomicI64::new(1_000)));
	(
		Arc::new(research_finance::sec_financials::SecTickerDirectory::new(
			pages.clone(),
			clock,
		)),
		pages,
	)
}

#[tokio::test]
async fn sec_directory_asks_only_the_gate_of_the_caller_that_starts_the_download() {
	let (directory, pages) = ticker_directory();
	let (first, joiner) = (Gate::new(true, false), Gate::new(true, false));
	let (a, b) = tokio::join!(
		directory.lookup("XTESTA", None, Some(first.as_ref())),
		directory.lookup("XTESTA", None, Some(joiner.as_ref())),
	);
	assert!(a.unwrap().issuer.is_some() && b.unwrap().issuer.is_some());
	assert_eq!(pages.directory_requests.load(Ordering::SeqCst), 1);
	assert_eq!(first.asked() + joiner.asked(), 1);
	// A cached answer asks no gate at all.
	let cached = Gate::new(true, false);
	assert!(
		directory
			.lookup("XTESTA", None, Some(cached.as_ref()))
			.await
			.is_ok()
	);
	assert_eq!(cached.asked(), 0);
}

#[tokio::test]
async fn sec_directory_a_starters_refusal_is_its_own_and_a_joiner_downloads_through_its_gate() {
	let (directory, pages) = ticker_directory();
	let (refusing, joiner) = (Gate::new(false, true), Gate::new(true, false));
	let stopped = tokio::spawn({
		let (directory, refusing) = (directory.clone(), refusing.clone());
		async move {
			directory
				.lookup("XTESTA", None, Some(refusing.as_ref()))
				.await
		}
	});
	while refusing.asked() == 0 {
		tokio::task::yield_now().await;
	}
	let staying = tokio::spawn({
		let (directory, joiner) = (directory.clone(), joiner.clone());
		async move {
			directory
				.lookup("XTESTA", None, Some(joiner.as_ref()))
				.await
		}
	});
	for _ in 0..10 {
		tokio::task::yield_now().await;
	}
	assert_eq!(joiner.asked(), 0);
	refusing.open.notify_waiters();
	let refused = stopped.await.unwrap();
	assert_eq!(
		refused.err().map(|e| e.code),
		Some(SecErrorCode::FetchFailed)
	);
	let found = staying.await.unwrap().unwrap();
	assert_eq!(found.issuer.map(|i| i.cik).as_deref(), Some("0009999991"));
	assert_eq!(joiner.asked(), 1);
	assert_eq!(pages.directory_requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn sec_directory_sends_nothing_when_the_only_caller_leaves_while_its_gate_decides() {
	let (directory, pages) = ticker_directory();
	let slow = Gate::new(true, true);
	let stop = CancellationToken::new();
	let leaving = tokio::spawn({
		let (directory, slow, stop) = (directory.clone(), slow.clone(), stop.clone());
		async move {
			directory
				.lookup("XTESTA", Some(&stop), Some(slow.as_ref()))
				.await
		}
	});
	while slow.asked() == 0 {
		tokio::task::yield_now().await;
	}
	stop.cancel();
	assert!(leaving.await.unwrap().is_err());
	slow.open.notify_waiters();
	assert_eq!(pages.directory_requests.load(Ordering::SeqCst), 0);
	// The abandoned slot is gone: the next caller downloads.
	assert!(directory.lookup("XTESTA", None, None).await.is_ok());
	assert_eq!(pages.directory_requests.load(Ordering::SeqCst), 1);
}
