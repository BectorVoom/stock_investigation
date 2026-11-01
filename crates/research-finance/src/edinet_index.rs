//! The shared EDINET index of annual securities reports (port of
//! `packages/adapters/src/finance/edinetIndex.ts`, ADR-0058 §4): the source
//! an `edinet-index` job runs. EDINET has no per-company search, so each
//! claimed date's list is read once for every company.
//!
//! 1. No `EDINET_API_KEY`: fail `FINANCIAL_SOURCE_NOT_CONFIGURED` before any request.
//! 2. List each claimed date in claim order (newest first), one
//!    `documents.json?type=2` request each, paced by the runner's `edinet`
//!    gate at one per second. EDINET answers a date's whole list at once (no
//!    paging; `metadata.resultset.count` is the row count).
//! 3. Keep the not-withdrawn 120/130 rows with a listed securities code
//!    (`edinet_index_document`) and report the date with them.
//! 4. A date whose list failed (an HTTP error, a list that is not one, a list
//!    over `MAX_DOCUMENTS_PER_DAY`) is left out — the API plans it again —
//!    and the job goes on, except after a refused key or a rate limit: the
//!    dates after it would fail the same, so the job stops listing. When no
//!    date was listed the job fails with the first date's failure (its code
//!    and EDINET's status, ADR-0037).
//!
//! The subscription key is a query parameter: URLs here are never logged
//! (and the fetchers' errors carry no URL).

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use research_application::ports::SafeFetcher;
use research_contracts::edinet_index::{
	EdinetIndexDayResult, EdinetIndexDocType, EdinetIndexDocument, limits,
};
use research_contracts::equity_financials::{EDINET_SECURITIES_CODE, EquitySyncFailureCode};
use research_js::json::Value;
use research_js::utf16::cut_code_points;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::edinet_documents::{
	EDINET_API_HOST, EdinetAnnualRow, EdinetDocType, EdinetListProblem, edinet_document_list_url,
	parse_edinet_document_list, split_submit,
};
use crate::equity_sync::{
	EquitySyncFailure, equity_sync_code_of_status, equity_sync_failure_of_fetch,
};
use crate::market_fetch::fetch_options;
use crate::ports::{BeforeRequest, Secret};

/// A date's list is a few hundred kilobytes even at the late-June peak.
pub const EDINET_LIST_MAX_BYTES: usize = 8_000_000;
const EDINET_LIST_TIMEOUT_MS: u64 = 30_000;
const LIST_ACCEPT: &str = "application/json";

/// `edinetIndexDocument`: one annual row as an index document, or `None`
/// when the index cannot keep it — no securities code of EDINET's
/// five-character form (the filer is not listed), no filer name, or an
/// annual securities report (120) without a period end (the contract refuses
/// one; an amendment's row states no period, spec §3-1-2-2 *3, and takes its
/// original's on the API side). A name over `MAX_FILER_NAME_CHARS` is cut at
/// a character boundary rather than losing the report. `submitDateTime`
/// (Japan time) becomes an instant with `+09:00`.
#[must_use]
pub fn edinet_index_document(row: &EdinetAnnualRow) -> Option<EdinetIndexDocument> {
	let sec_code = row
		.sec_code
		.as_deref()
		.filter(|code| (EDINET_SECURITIES_CODE.matches)(code))?;
	let filer_name = row.filer_name.as_deref()?;
	if row.doc_type_code == EdinetDocType::SecuritiesReport && row.period_end.is_none() {
		return None;
	}
	let (date, hour, minute) = split_submit(&row.submit_date_time)?;
	Some(EdinetIndexDocument {
		doc_id: row.doc_id.clone(),
		sec_code: sec_code.to_owned(),
		edinet_code: row.edinet_code.clone(),
		filer_name: cut_code_points(filer_name, limits::MAX_FILER_NAME_CHARS).to_owned(),
		doc_type_code: match row.doc_type_code {
			EdinetDocType::SecuritiesReport => EdinetIndexDocType::SecuritiesReport,
			EdinetDocType::AmendedSecuritiesReport => EdinetIndexDocType::AmendedSecuritiesReport,
		},
		period_start: row.period_start.clone(),
		period_end: row.period_end.clone(),
		submitted_at: format!("{date}T{hour}:{minute}:00+09:00"),
		parent_doc_id: row.parent_doc_id.clone(),
	})
}

/// Why a date's list gives no index day (`EdinetIndexDayProblem`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdinetIndexDayProblem {
	/// EDINET's status, or not the documented list.
	List(EdinetListProblem),
	/// More documents than one completion day carries.
	TooMany,
}

/// A date's documents and the rows dropped (`EdinetIndexDay`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EdinetIndexDay {
	/// Each document id once, in list order.
	pub documents: Vec<EdinetIndexDocument>,
	/// Annual rows the index could not keep (no securities code, name or period end).
	pub dropped: usize,
}

/// `edinetIndexDay`: a date's list (parsed JSON) as its index documents.
///
/// # Errors
/// The list's problem, or [`EdinetIndexDayProblem::TooMany`] past the per-day limit.
pub fn edinet_index_day(value: &Value) -> Result<EdinetIndexDay, EdinetIndexDayProblem> {
	let rows = parse_edinet_document_list(value).map_err(EdinetIndexDayProblem::List)?;
	let mut documents = Vec::with_capacity(rows.len());
	let mut seen: HashSet<String> = HashSet::with_capacity(rows.len());
	let mut dropped = 0usize;
	for row in &rows {
		match edinet_index_document(row) {
			None => dropped += 1,
			Some(document) => {
				if seen.insert(document.doc_id.clone()) {
					documents.push(document);
				}
			}
		}
	}
	// The completion could not carry the whole date: it stays unlisted rather than cut.
	if documents.len() > limits::MAX_DOCUMENTS_PER_DAY {
		return Err(EdinetIndexDayProblem::TooMany);
	}
	Ok(EdinetIndexDay { documents, dropped })
}

/// A date the job could not list (`EdinetIndexDayFailure`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdinetIndexDayFailure {
	/// The claimed date.
	pub date: String,
	/// Stable code.
	pub code: EquitySyncFailureCode,
	/// EDINET's status, unchanged (ADR-0037).
	pub upstream_status: Option<u16>,
}

/// What an `edinet-index` source run found (`EdinetIndexData`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdinetIndexData {
	/// The dates listed in full, in claim order.
	pub days: Vec<EdinetIndexDayResult>,
	/// The dates that failed, in claim order (left out of the completion).
	pub failed_days: Vec<EdinetIndexDayFailure>,
	/// Claimed dates not tried after a refused key or a rate limit.
	pub skipped_days: usize,
	/// Annual rows of the listed dates the index could not keep.
	pub dropped_rows: usize,
	/// HTTP requests this job sent.
	pub requests: usize,
}

/// One `edinet-index` run (`EdinetIndexQuery`).
pub struct EdinetIndexQuery<'a> {
	/// The claim's dates, newest first.
	pub days: &'a [String],
	/// Run cancellation.
	pub cancel: &'a CancellationToken,
	/// Takes one `edinet` pacing grant; false = the job was stopped.
	pub before_request: &'a dyn BeforeRequest,
}

/// Lists claimed EDINET dates once for every company (`EdinetIndexSource`).
#[async_trait]
pub trait EdinetIndexSource: Send + Sync {
	/// The dates listed in full and those that failed, or a stable failure.
	async fn list(&self, query: EdinetIndexQuery<'_>)
	-> Result<EdinetIndexData, EquitySyncFailure>;
}

/// The failure of a date's list that is not a fetch failure.
fn day_problem_failure(problem: EdinetIndexDayProblem) -> (EquitySyncFailureCode, Option<u16>) {
	match problem {
		EdinetIndexDayProblem::List(EdinetListProblem::Status(status)) => (
			status.map_or(
				EquitySyncFailureCode::SourceFailed,
				equity_sync_code_of_status,
			),
			status,
		),
		EdinetIndexDayProblem::List(EdinetListProblem::Parse) | EdinetIndexDayProblem::TooMany => {
			(EquitySyncFailureCode::ParseFailed, None)
		}
	}
}

/// After these, every later date would fail the same way: the job stops listing.
const fn stops_listing(code: EquitySyncFailureCode) -> bool {
	matches!(
		code,
		EquitySyncFailureCode::AccessDenied | EquitySyncFailureCode::RateLimited
	)
}

/// The EDINET index source (`createEdinetIndexSource`).
pub struct EdinetIndex {
	fetcher: Arc<dyn SafeFetcher>,
	/// `EDINET_API_KEY`; `None` = not configured, nothing is requested.
	api_key: Option<Secret>,
}

impl EdinetIndex {
	/// A source over the shared text fetcher; `api_key` is `EDINET_API_KEY`.
	pub fn new(fetcher: Arc<dyn SafeFetcher>, api_key: Option<Secret>) -> Self {
		Self { fetcher, api_key }
	}
}

#[async_trait]
impl EdinetIndexSource for EdinetIndex {
	async fn list(
		&self,
		query: EdinetIndexQuery<'_>,
	) -> Result<EdinetIndexData, EquitySyncFailure> {
		let mut requests = 0usize;
		let Some(key) = &self.api_key else {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceNotConfigured,
				requests,
			));
		};
		let mut unique: HashSet<&str> = HashSet::with_capacity(query.days.len());
		let dates: Vec<&str> = query
			.days
			.iter()
			.map(String::as_str)
			.filter(|date| unique.insert(date))
			.collect();
		let mut days = Vec::with_capacity(dates.len());
		let mut failed_days = Vec::new();
		let mut dropped_rows = 0usize;
		let mut tried = 0usize;
		for date in &dates {
			if !query.before_request.before_request().await {
				return Err(EquitySyncFailure::own(
					EquitySyncFailureCode::SourceFailed,
					requests,
				));
			}
			tried += 1;
			requests += 1;
			let mut options = fetch_options(EDINET_API_HOST, LIST_ACCEPT, query.cancel);
			options.max_bytes = EDINET_LIST_MAX_BYTES;
			options.timeout_ms = EDINET_LIST_TIMEOUT_MS;
			let listed = self
				.fetcher
				.fetch_text(&edinet_document_list_url(date, key.expose()), &options)
				.await;
			let failure = match listed {
				Err(error) => {
					let failure = equity_sync_failure_of_fetch(&error, requests);
					Some((failure.code, failure.upstream_status))
				}
				Ok(document) => {
					// Parsing a late-June list of every filer is CPU work.
					let day = crate::cpu::offload(move || {
						research_js::json::parse(&document.text)
							.map_err(|_| EdinetIndexDayProblem::List(EdinetListProblem::Parse))
							.and_then(|value| edinet_index_day(&value))
					})
					.await;
					match day {
						Ok(day) => {
							dropped_rows += day.dropped;
							days.push(EdinetIndexDayResult {
								date: (*date).to_owned(),
								documents: day.documents,
							});
							None
						}
						Err(problem) => Some(day_problem_failure(problem)),
					}
				}
			};
			if let Some((code, upstream_status)) = failure {
				failed_days.push(EdinetIndexDayFailure {
					date: (*date).to_owned(),
					code,
					upstream_status,
				});
				if stops_listing(code) {
					break;
				}
			}
		}
		if days.is_empty() {
			if let Some(first) = failed_days.first() {
				return Err(EquitySyncFailure {
					code: first.code,
					upstream_status: first.upstream_status,
					requests,
				});
			}
		}
		Ok(EdinetIndexData {
			days,
			failed_days,
			skipped_days: dates.len() - tried,
			dropped_rows,
			requests,
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn row() -> EdinetAnnualRow {
		EdinetAnnualRow {
			doc_id: "S100AAAA".to_owned(),
			edinet_code: "E99991".to_owned(),
			sec_code: Some("99990".to_owned()),
			filer_name: Some("名".to_owned()),
			doc_type_code: EdinetDocType::SecuritiesReport,
			period_start: Some("2024-04-01".to_owned()),
			period_end: Some("2025-03-31".to_owned()),
			submit_date_time: "2025-06-20 15:00".to_owned(),
			parent_doc_id: None,
		}
	}

	#[test]
	fn a_row_becomes_a_document_in_japan_time() {
		let document = edinet_index_document(&row());
		assert_eq!(
			document.map(|document| document.submitted_at),
			Some("2025-06-20T15:00:00+09:00".to_owned())
		);
		let unlisted = EdinetAnnualRow {
			sec_code: None,
			..row()
		};
		assert_eq!(edinet_index_document(&unlisted), None);
		let undated = EdinetAnnualRow {
			period_end: None,
			..row()
		};
		assert_eq!(edinet_index_document(&undated), None);
		let amendment = EdinetAnnualRow {
			doc_type_code: EdinetDocType::AmendedSecuritiesReport,
			period_start: None,
			period_end: None,
			..row()
		};
		assert!(edinet_index_document(&amendment).is_some());
	}
}
