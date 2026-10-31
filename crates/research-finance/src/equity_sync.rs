//! What both financial-statement sources share (port of
//! `packages/adapters/src/finance/equitySync.ts`, ADR-0048 §6): the port the
//! runner calls for a `financial-sync` job, the failure mapping of a
//! provider's answer to `EQUITY_SYNC_FAILURE_CODES`, the canonical order of a
//! filing's facts, and the completion caps. Every function here is pure and
//! replays `vectors/finance/equity_sync_*.json`.

use std::cmp::Ordering;

use async_trait::async_trait;
use research_application::ports::{SafeFetchError, SafeFetchErrorCode, upstream_status_of};
use research_contracts::equity_financials::{
	EquityExtractedFact, EquityFactsStatus, EquityFilingResult, EquityProvider, EquitySyncClaim,
	EquitySyncFailureCode, EquitySyncIdentity, limits,
};
use research_domain::finance::financial_statements::annual_facts_of_filing;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::edinet_csv::EdinetReportProblem;
use crate::ports::BeforeRequest;

/// One sync of one company (`EquitySyncQuery`).
pub struct EquitySyncQuery<'a> {
	/// The claim's company, concepts and provider request.
	pub target: &'a EquitySyncClaim,
	/// Run cancellation.
	pub cancel: &'a CancellationToken,
	/// Called immediately before each request is sent (the runner's pacing
	/// gate: `sec`, `edinet`). False means the job stopped while waiting: the
	/// source sends nothing more and fails.
	pub before_request: &'a dyn BeforeRequest,
}

/// A downloaded document the source could not read
/// (`EquitySyncUnreadableDocument`; EDINET: an archive the reader refuses,
/// no `jpcrp` report entry, text that is not UTF-16 LE, no CSV header). Its
/// filing is reported `not-available`; the job logs it
/// (`financial_sync_document_unreadable`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquitySyncUnreadableDocument {
	/// The provider's document id.
	pub source_document_id: String,
	/// Why it could not be read.
	pub problem: EdinetReportProblem,
}

/// The `financial-synced` completion fields a source produces, plus its
/// request count (`EquitySyncData`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquitySyncData {
	/// What the source says about the company.
	pub identity: Option<EquitySyncIdentity>,
	/// EDINET dates fully listed (always empty for SEC).
	pub scanned_days: Vec<String>,
	/// Annual filings, newest first, within the completion caps.
	pub filings: Vec<EquityFilingResult>,
	/// Filings were cut by the caps.
	pub more: bool,
	/// HTTP requests this job sent (cache hits are not requests).
	pub requests: usize,
	/// Downloaded documents that could not be read, in download order
	/// (always empty for SEC).
	pub unreadable_documents: Vec<EquitySyncUnreadableDocument>,
}

/// A failed sync (`EquitySyncFailure`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}")]
pub struct EquitySyncFailure {
	/// Stable code.
	pub code: EquitySyncFailureCode,
	/// The provider's HTTP (or EDINET metadata) status, unchanged (ADR-0037);
	/// `None` when none answered.
	pub upstream_status: Option<u16>,
	/// HTTP requests sent before the failure.
	pub requests: usize,
}

impl EquitySyncFailure {
	/// A failure no provider answer caused.
	#[must_use]
	pub const fn own(code: EquitySyncFailureCode, requests: usize) -> Self {
		Self {
			code,
			upstream_status: None,
			requests,
		}
	}
}

/// Fetches and extracts one company's annual filings (`EquitySyncSource`).
#[async_trait]
pub trait EquitySyncSource: Send + Sync {
	/// The provider this source reads.
	fn provider(&self) -> EquityProvider;
	/// The completion fields, or a stable failure with the provider's status.
	async fn sync(&self, query: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure>;
}

/// A provider whose credential is not configured (no `SEC_USER_AGENT` /
/// `EDINET_API_KEY`): every sync fails with `FINANCIAL_SOURCE_NOT_CONFIGURED`
/// before any request.
pub struct UnconfiguredEquitySyncSource(pub EquityProvider);

#[async_trait]
impl EquitySyncSource for UnconfiguredEquitySyncSource {
	fn provider(&self) -> EquityProvider {
		self.0
	}
	async fn sync(&self, _: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure> {
		Err(EquitySyncFailure::own(
			EquitySyncFailureCode::SourceNotConfigured,
			0,
		))
	}
}

/// `equitySyncCodeOfStatus`: the provider-independent failure of a status
/// (404 is decided by the caller first).
#[must_use]
pub const fn equity_sync_code_of_status(status: u16) -> EquitySyncFailureCode {
	match status {
		401 | 403 => EquitySyncFailureCode::AccessDenied,
		429 => EquitySyncFailureCode::RateLimited,
		_ => EquitySyncFailureCode::SourceFailed,
	}
}

/// `equitySyncFailureOfFetch`: an HTTP status by the table above, an
/// oversized answer as a parse failure (a retry would not shrink it), and
/// everything else (timeout, network, refused redirect) as a source failure.
#[must_use]
pub fn equity_sync_failure_of_fetch(error: &SafeFetchError, requests: usize) -> EquitySyncFailure {
	let upstream_status = upstream_status_of(error);
	let code = match (error.code, error.http_error_status()) {
		(SafeFetchErrorCode::HttpError, Some(status)) => equity_sync_code_of_status(status),
		(SafeFetchErrorCode::ResponseTooLarge, _) => EquitySyncFailureCode::ParseFailed,
		_ => EquitySyncFailureCode::SourceFailed,
	};
	EquitySyncFailure {
		code,
		upstream_status,
		requests,
	}
}

/// `compareFacts`: concept, unit, period type, period start (an instant's
/// null first), period end, value, scope — byte order (the facts are ASCII,
/// so this is the TypeScript's code-unit order).
#[must_use]
pub fn compare_facts(a: &EquityExtractedFact, b: &EquityExtractedFact) -> Ordering {
	a.concept
		.cmp(&b.concept)
		.then_with(|| a.unit.cmp(&b.unit))
		.then_with(|| a.period_type.as_str().cmp(b.period_type.as_str()))
		.then_with(|| {
			a.period_start
				.as_deref()
				.unwrap_or("")
				.cmp(b.period_start.as_deref().unwrap_or(""))
		})
		.then_with(|| a.period_end.cmp(&b.period_end))
		.then_with(|| a.value_decimal.cmp(&b.value_decimal))
		.then_with(|| a.scope.as_str().cmp(b.scope.as_str()))
}

/// `annualFactsInOrder`: canonical order with exact repeats removed
/// (company facts can list one fact twice for one accession), then only the
/// annual ones (`annualFactsOfFiling`).
#[must_use]
pub fn annual_facts_in_order(mut facts: Vec<EquityExtractedFact>) -> Vec<EquityExtractedFact> {
	facts.sort_by(compare_facts);
	facts.dedup_by(|later, earlier| compare_facts(earlier, later) == Ordering::Equal);
	annual_facts_of_filing(facts).kept
}

/// `compareFilingsNewestFirst`: filing date, then source document id, both descending.
#[must_use]
pub fn compare_filings_newest_first(a: &EquityFilingResult, b: &EquityFilingResult) -> Ordering {
	b.metadata.filed_on.cmp(&a.metadata.filed_on).then_with(|| {
		b.metadata
			.source_document_id
			.cmp(&a.metadata.source_document_id)
	})
}

/// `CompletionCaps`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompletionCaps {
	/// Filings per completion.
	pub max_filings: usize,
	/// Facts per completion (all filings together).
	pub max_facts: usize,
}

/// `COMPLETION_CAPS`.
pub const COMPLETION_CAPS: CompletionCaps = CompletionCaps {
	max_filings: limits::MAX_FILINGS_PER_COMPLETION,
	max_facts: limits::MAX_FACTS_PER_COMPLETION,
};

/// `fitCompletionCaps`'s result.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FittedFilings {
	/// The filings the completion carries, newest first.
	pub filings: Vec<EquityFilingResult>,
	/// The first filing that did not fit and every older one, newest first.
	pub cut: Vec<EquityFilingResult>,
}

/// `fitCompletionCaps` (ADR-0048 §6): newest first, whole filings only,
/// while within `max_filings` and `max_facts`; the first filing that does not
/// fit and every older one are cut. A single filing whose facts alone exceed
/// `max_facts` could never be carried: it is reported `not-available` with no
/// facts instead (correct but incomplete beats an endless `more`).
#[must_use]
pub fn fit_completion_caps(
	filings: Vec<EquityFilingResult>,
	caps: CompletionCaps,
) -> FittedFilings {
	let mut ordered: Vec<EquityFilingResult> = filings
		.into_iter()
		.map(|mut filing| {
			if filing.facts.len() > caps.max_facts {
				filing.facts_status = EquityFactsStatus::NotAvailable;
				filing.accounting_standard = None;
				filing.facts = Vec::new();
			}
			filing
		})
		.collect();
	// Stable, like `Array#sort`.
	ordered.sort_by(compare_filings_newest_first);
	let mut facts = 0usize;
	let mut keep = ordered.len();
	for (index, filing) in ordered.iter().enumerate() {
		if index >= caps.max_filings || facts + filing.facts.len() > caps.max_facts {
			keep = index;
			break;
		}
		facts += filing.facts.len();
	}
	let cut = ordered.split_off(keep);
	FittedFilings {
		filings: ordered,
		cut,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use research_contracts::equity_financials::{
		EquityFilingMetadata, EquityPeriodType, EquityReportForm, EquityScope,
	};

	fn filing(id: &str, filed_on: &str, facts: usize) -> EquityFilingResult {
		let fact = EquityExtractedFact {
			concept: "us-gaap:Revenues".to_owned(),
			unit: "USD".to_owned(),
			value_decimal: "1".to_owned(),
			period_type: EquityPeriodType::Instant,
			period_start: None,
			period_end: "2024-09-28".to_owned(),
			scope: EquityScope::Consolidated,
		};
		EquityFilingResult {
			metadata: EquityFilingMetadata {
				source_document_id: id.to_owned(),
				form: EquityReportForm::TenK,
				filed_on: filed_on.to_owned(),
				submitted_at: None,
				period_start: None,
				period_end: "2024-09-28".to_owned(),
				amends_source_document_id: None,
				source_url: "https://www.sec.gov/".to_owned(),
			},
			accounting_standard: None,
			facts_status: EquityFactsStatus::Extracted,
			facts: vec![fact; facts],
		}
	}

	#[test]
	fn caps_keep_whole_filings_newest_first() {
		let caps = CompletionCaps {
			max_filings: 2,
			max_facts: 5,
		};
		let fitted = fit_completion_caps(
			vec![
				filing("a", "2022-01-01", 1),
				filing("c", "2024-01-01", 3),
				filing("b", "2023-01-01", 3),
			],
			caps,
		);
		let ids = |list: &[EquityFilingResult]| {
			list.iter()
				.map(|f| f.metadata.source_document_id.clone())
				.collect::<Vec<_>>()
		};
		assert_eq!(ids(&fitted.filings), ["c"]);
		assert_eq!(ids(&fitted.cut), ["b", "a"]);
		let oversized = fit_completion_caps(vec![filing("x", "2024-01-01", 6)], caps);
		assert_eq!(
			oversized.filings[0].facts_status,
			EquityFactsStatus::NotAvailable
		);
		assert!(oversized.filings[0].facts.is_empty() && oversized.cut.is_empty());
	}

	#[test]
	fn statuses_map_to_codes() {
		assert_eq!(
			equity_sync_code_of_status(401),
			EquitySyncFailureCode::AccessDenied
		);
		assert_eq!(
			equity_sync_code_of_status(403),
			EquitySyncFailureCode::AccessDenied
		);
		assert_eq!(
			equity_sync_code_of_status(429),
			EquitySyncFailureCode::RateLimited
		);
		assert_eq!(
			equity_sync_code_of_status(503),
			EquitySyncFailureCode::SourceFailed
		);
	}
}
