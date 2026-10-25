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
use research_finance::ports::{MarketSeriesSource, Secret, SeriesQuery};
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

async fn fetch(
	source: &FredSeriesSource,
	symbol: &str,
) -> Result<research_finance::ports::SeriesData, research_finance::ports::MarketUnavailable> {
	let cancel = CancellationToken::new();
	source
		.fetch_series(SeriesQuery {
			symbol,
			since: None,
			max_observations: 10,
			cancel: &cancel,
		})
		.await
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
