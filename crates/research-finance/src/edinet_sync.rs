//! Japanese annual reports from EDINET API v2 (port of
//! `packages/adapters/src/finance/edinetSync.ts`, ADR-0045 §6): the source a
//! `financial-sync` job of a JP company runs.
//!
//! 1. No `EDINET_API_KEY`: fail `FINANCIAL_SOURCE_NOT_CONFIGURED` before any request.
//! 2. List each `scanDays` date in claim order (one request each, paced by
//!    the runner's `edinet` gate at one per second); a date listed in the last
//!    24 hours answers from the cache. A failing date fails the job — the
//!    cache makes the retry cheap.
//! 3. Keep the annual rows whose securities code is the company's, plan the
//!    downloads (`edinet_download_plan`) and fetch each planned XBRL-to-CSV
//!    ZIP: 404 → not available yet; an archive without a readable main report
//!    → `FINANCIAL_PARSE_FAILED`.
//! 4. Completion caps; a found filing that is cut takes its scan date out of
//!    `scannedDays`, so the next job lists that date again and finds it.
//!
//! The subscription key is a query parameter: URLs here are never logged
//! (and the fetchers' errors carry no URL).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use research_application::ports::{
	Clock, SafeBinaryFetcher, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use research_contracts::equity_financials::{
	EquityFactsStatus, EquityFilingResult, EquityProvider, EquitySyncFailureCode,
	EquitySyncRequest, limits,
};
use tokio_util::sync::CancellationToken;

use crate::bounded_cache::BoundedCache;
use crate::edinet_csv::{EDINET_ZIP_LIMITS, extract_edinet_report};
use crate::edinet_documents::{
	EDINET_API_HOST, EdinetAnnualRow, EdinetDocumentAction, EdinetListProblem, EdinetListedRow,
	EdinetPlanInput, edinet_document_list_url, edinet_document_url, edinet_download_plan,
	edinet_error_status, edinet_identity, parse_edinet_document_list,
};
use crate::equity_sync::{
	COMPLETION_CAPS, EquitySyncData, EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
	equity_sync_code_of_status, equity_sync_failure_of_fetch, fit_completion_caps,
};
use crate::market_fetch::fetch_options;
use crate::ports::Secret;

/// A date's list is a few hundred kilobytes even at the late-June peak.
pub const EDINET_LIST_MAX_BYTES: usize = 8_000_000;
/// The XBRL-to-CSV download cap (the ZIP reader's archive ceiling).
pub const EDINET_ZIP_MAX_BYTES: usize = EDINET_ZIP_LIMITS.max_archive_bytes;
const EDINET_LIST_TIMEOUT_MS: u64 = 30_000;
const EDINET_ZIP_TIMEOUT_MS: u64 = 60_000;
/// A date's annual rows are reused for a day: companies synced in turn share the listings.
pub const EDINET_DAY_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Ten companies' discovery and backfill windows fit; a date's rows are small.
pub const EDINET_DAY_CACHE_CAPACITY: usize = 1_000;
const LIST_ACCEPT: &str = "application/json";
const DOCUMENT_ACCEPT: &str = "application/octet-stream, application/zip, application/json";

/// ZIP local-header signature "PK\x03\x04": anything else is EDINET's error JSON or garbage.
fn looks_like_zip(bytes: &[u8]) -> bool {
	bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04])
}

/// The annual rows of one date, shared by the cache and the jobs that read it.
type DayRows = Arc<Vec<EdinetAnnualRow>>;

/// The EDINET source (`createEdinetSource`).
pub struct EdinetSource {
	fetcher: Arc<dyn SafeFetcher>,
	binary: Arc<dyn SafeBinaryFetcher>,
	/// `EDINET_API_KEY`; `None` = not configured, nothing is requested.
	api_key: Option<Secret>,
	clock: Arc<dyn Clock>,
	day_cache: BoundedCache<String, DayRows>,
}

impl EdinetSource {
	/// A source over the shared fetchers; `api_key` is `EDINET_API_KEY`.
	pub fn new(
		fetcher: Arc<dyn SafeFetcher>,
		binary: Arc<dyn SafeBinaryFetcher>,
		api_key: Option<Secret>,
		clock: Arc<dyn Clock>,
	) -> Self {
		Self {
			fetcher,
			binary,
			api_key,
			clock,
			day_cache: BoundedCache::new(EDINET_DAY_CACHE_CAPACITY, Some(EDINET_DAY_CACHE_TTL_MS)),
		}
	}

	fn options(
		accept: &str,
		max_bytes: usize,
		timeout_ms: u64,
		cancel: &CancellationToken,
	) -> SafeFetchOptions {
		let mut options = fetch_options(EDINET_API_HOST, accept, cancel);
		options.max_bytes = max_bytes;
		options.timeout_ms = timeout_ms;
		options
	}

	/// One date's annual rows: from the cache, or one paced request.
	async fn day_rows(
		&self,
		day: &str,
		key: &Secret,
		query: &EquitySyncQuery<'_>,
		requests: &mut usize,
	) -> Result<DayRows, EquitySyncFailure> {
		if let Some(rows) = self.day_cache.get(day, self.clock.now_ms()) {
			return Ok(rows);
		}
		if !query.before_request.before_request().await {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceFailed,
				*requests,
			));
		}
		*requests += 1;
		let listed = self
			.fetcher
			.fetch_text(
				&edinet_document_list_url(day, key.expose()),
				&Self::options(
					LIST_ACCEPT,
					EDINET_LIST_MAX_BYTES,
					EDINET_LIST_TIMEOUT_MS,
					query.cancel,
				),
			)
			.await
			.map_err(|error| equity_sync_failure_of_fetch(&error, *requests))?;
		let count = *requests;
		let parsed = crate::cpu::offload(move || {
			research_js::json::parse(&listed.text)
				.map_err(|_| EdinetListProblem::Parse)
				.and_then(|value| parse_edinet_document_list(&value))
		})
		.await;
		let rows = match parsed {
			Ok(rows) => Arc::new(rows),
			Err(EdinetListProblem::Parse) => {
				return Err(EquitySyncFailure::own(
					EquitySyncFailureCode::ParseFailed,
					count,
				));
			}
			Err(EdinetListProblem::Status(status)) => {
				return Err(EquitySyncFailure {
					code: status.map_or(
						EquitySyncFailureCode::SourceFailed,
						equity_sync_code_of_status,
					),
					upstream_status: status,
					requests: count,
				});
			}
		};
		self.day_cache
			.insert(day.to_owned(), Arc::clone(&rows), self.clock.now_ms());
		Ok(rows)
	}
}

/// How one download ended.
enum Download {
	/// The CSV is not there (yet): HTTP 404 or EDINET's 404 body.
	NotAvailable,
	/// The archive's bytes.
	Archive(Vec<u8>),
}

#[async_trait]
impl EquitySyncSource for EdinetSource {
	fn provider(&self) -> EquityProvider {
		EquityProvider::Edinet
	}

	async fn sync(&self, query: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure> {
		let mut requests = 0usize;
		let EquitySyncRequest::Edinet(request) = &query.target.source else {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceFailed,
				0,
			));
		};
		let Some(key) = &self.api_key else {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceNotConfigured,
				0,
			));
		};

		let mut unique: HashSet<&str> = HashSet::with_capacity(request.scan_days.len());
		let days: Vec<&str> = request
			.scan_days
			.iter()
			.map(String::as_str)
			.filter(|day| unique.insert(day))
			.collect();
		let mut found: Vec<EdinetListedRow> = Vec::new();
		for day in &days {
			let rows = self.day_rows(day, key, &query, &mut requests).await?;
			found.extend(
				rows.iter()
					.filter(|row| row.sec_code.as_deref() == Some(request.sec_code.as_str()))
					.map(|row| EdinetListedRow {
						row: row.clone(),
						listed_on: (*day).to_owned(),
					}),
			);
		}

		let plan = edinet_download_plan(&EdinetPlanInput {
			pending: &request.pending_filings,
			found: &found,
			known_doc_ids: &request.known_doc_ids,
			max_downloads: limits::MAX_DOCUMENTS_PER_JOB,
		});
		let mut filings: Vec<EquityFilingResult> = Vec::with_capacity(plan.len());
		let mut listed_on: HashMap<String, String> = HashMap::new();
		for document in plan {
			let metadata = document.metadata;
			if let Some(day) = document.listed_on {
				listed_on.insert(metadata.source_document_id.clone(), day);
			}
			let not_downloaded = |metadata, status| EquityFilingResult {
				metadata,
				accounting_standard: None,
				facts_status: status,
				facts: Vec::new(),
			};
			match document.action {
				EdinetDocumentAction::NotAvailable => {
					filings.push(not_downloaded(metadata, EquityFactsStatus::NotAvailable));
					continue;
				}
				EdinetDocumentAction::Deferred => {
					filings.push(not_downloaded(metadata, EquityFactsStatus::Deferred));
					continue;
				}
				EdinetDocumentAction::Download => {}
			}
			if !query.before_request.before_request().await {
				return Err(EquitySyncFailure::own(
					EquitySyncFailureCode::SourceFailed,
					requests,
				));
			}
			requests += 1;
			let fetched = self
				.binary
				.fetch_bytes(
					&edinet_document_url(&metadata.source_document_id, key.expose()),
					&Self::options(
						DOCUMENT_ACCEPT,
						EDINET_ZIP_MAX_BYTES,
						EDINET_ZIP_TIMEOUT_MS,
						query.cancel,
					),
				)
				.await;
			let status = match &fetched {
				Err(error) if error.code == SafeFetchErrorCode::HttpError => error.status,
				Err(error) => return Err(equity_sync_failure_of_fetch(error, requests)),
				Ok(document) if looks_like_zip(&document.bytes) => None,
				Ok(document) => {
					// EDINET answers some errors as JSON with HTTP 200: its own status decides.
					let status = research_js::json::parse_bytes(&document.bytes)
						.ok()
						.and_then(|value| edinet_error_status(&value));
					// Neither a ZIP nor an error status: not the document EDINET documents.
					match status {
						Some(status) if status >= 400 => Some(status),
						_ => {
							return Err(EquitySyncFailure::own(
								EquitySyncFailureCode::ParseFailed,
								requests,
							));
						}
					}
				}
			};
			let download = match (status, fetched) {
				// The CSV can lag the filing: not available yet, offered again later.
				(Some(404), _) => Download::NotAvailable,
				(Some(status), _) => {
					return Err(EquitySyncFailure {
						code: equity_sync_code_of_status(status),
						upstream_status: Some(status),
						requests,
					});
				}
				(None, Ok(document)) => Download::Archive(document.bytes),
				(None, Err(_)) => {
					return Err(EquitySyncFailure::own(
						EquitySyncFailureCode::SourceFailed,
						requests,
					));
				}
			};
			let bytes = match download {
				Download::NotAvailable => {
					filings.push(not_downloaded(metadata, EquityFactsStatus::NotAvailable));
					continue;
				}
				Download::Archive(bytes) => bytes,
			};
			let concepts = query.target.concepts.clone();
			// Inflating, decoding and scanning tens of megabytes is CPU work.
			let report = crate::cpu::offload(move || extract_edinet_report(&bytes, &concepts))
				.await
				.map_err(|_| {
					EquitySyncFailure::own(EquitySyncFailureCode::ParseFailed, requests)
				})?;
			filings.push(EquityFilingResult {
				metadata,
				accounting_standard: report.accounting_standard,
				facts_status: EquityFactsStatus::Extracted,
				facts: report.facts,
			});
		}

		let fitted = fit_completion_caps(filings, COMPLETION_CAPS);
		// A cut filing found by this scan must be found again: its date is not reported scanned.
		let unfinished: HashSet<&str> = fitted
			.cut
			.iter()
			.filter_map(|filing| listed_on.get(&filing.metadata.source_document_id))
			.map(String::as_str)
			.collect();
		Ok(EquitySyncData {
			identity: edinet_identity(
				found.iter().map(|listed| &listed.row),
				request.edinet_code.as_deref(),
			),
			scanned_days: days
				.iter()
				.filter(|day| !unfinished.contains(**day))
				.map(|day| (*day).to_owned())
				.collect(),
			more: !fitted.cut.is_empty(),
			filings: fitted.filings,
			requests,
		})
	}
}
