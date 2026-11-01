//! Japanese annual reports from EDINET API v2 (port of
//! `packages/adapters/src/finance/edinetSync.ts`, ADR-0048 §6, ADR-0058 §4):
//! the source a `financial-sync` job of a JP company runs.
//!
//! 1. No `EDINET_API_KEY`: fail `FINANCIAL_SOURCE_NOT_CONFIGURED` before any request.
//! 2. The claim names the reports to download: its `pendingFilings` and the
//!    reports the shared `edinet-index` lists for the company's securities
//!    code that are not stored yet (`indexedFilings`), each with its stored
//!    or indexed metadata, which the completion echoes back unchanged. No
//!    date list is read here: each date is listed once, for every company,
//!    by the `edinet-index` job (`edinet_index.rs`).
//! 3. Plan the downloads (`edinet_download_plan`: pending first, then
//!    indexed, at most `MAX_DOCUMENTS_PER_JOB`, the rest deferred) and fetch
//!    each planned XBRL-to-CSV ZIP (paced by the runner's `edinet` gate at
//!    one per second): 404 → not available yet; an answer that is not a
//!    readable main report (a malformed ZIP, no `jpcrp` CSV, a CSV without
//!    the header, neither a ZIP nor an EDINET error) → that filing is not
//!    available and the document is listed in `unreadable_documents`; the
//!    other documents go on. Failing the job instead would plan the same
//!    document first on every claim and block the company for good; as
//!    `not-available` the API keeps the filing pending (re-offered) within
//!    its grace period, then records it unavailable. Only an HTTP error
//!    status (or a network failure) still fails the job.
//! 4. Completion caps; a cut filing stays in the index and is named again,
//!    and `more` makes the API schedule the next job at once.
//! 5. The business description (ADR-0053 §2): every annual securities report
//!    (120) read gives its 事業の内容; the claim's `describeFiling`, when this
//!    job does not plan it anyway and the download cap leaves room, is
//!    downloaded for that alone (a failure there only means no description,
//!    logged as `description_unread`). The completion carries the newest
//!    report's (`newer_business_description`).
//!
//! The subscription key is a query parameter: URLs here are never logged
//! (and the fetchers' errors carry no URL).

use std::sync::Arc;

use async_trait::async_trait;
use research_application::ports::{SafeBinaryFetcher, SafeFetchErrorCode, SafeFetchOptions};
use research_contracts::equity_financials::{
	EquityBusinessDescription, EquityBusinessForm, EquityBusinessSource, EquityFactsStatus,
	EquityFilingMetadata, EquityFilingResult, EquityProvider, EquityReportForm,
	EquitySyncFailureCode, EquitySyncRequest, limits,
};
use research_domain::finance::business_description::BusinessParagraphs;
use tokio_util::sync::CancellationToken;

use crate::edinet_csv::{EDINET_ZIP_LIMITS, EdinetReportProblem, extract_edinet_report};
use crate::edinet_documents::{
	EDINET_API_HOST, EdinetDocumentAction, EdinetPlanInput, edinet_document_url,
	edinet_download_plan, edinet_error_status, edinet_identity,
};
use crate::equity_sync::{
	COMPLETION_CAPS, DescriptionUnreadCode, EquitySyncData, EquitySyncDescriptionUnread,
	EquitySyncDocumentProblem, EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
	EquitySyncUnreadableDocument, business_description_of, equity_sync_code_of_status,
	equity_sync_failure_of_fetch, fit_completion_caps, newer_business_description,
};
use crate::market_fetch::fetch_options;
use crate::ports::Secret;

/// The XBRL-to-CSV download cap (the ZIP reader's archive ceiling).
pub const EDINET_ZIP_MAX_BYTES: usize = EDINET_ZIP_LIMITS.max_archive_bytes;
const EDINET_ZIP_TIMEOUT_MS: u64 = 60_000;
const DOCUMENT_ACCEPT: &str = "application/octet-stream, application/zip, application/json";

/// ZIP local-header signature "PK\x03\x04": anything else is EDINET's error JSON or garbage.
fn looks_like_zip(bytes: &[u8]) -> bool {
	bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04])
}

/// The description of a securities report (120) read by this job.
fn report_description(
	source_document_id: &str,
	filed_on: &str,
	source_url: &str,
	period_end: &str,
	business: BusinessParagraphs,
) -> EquityBusinessDescription {
	business_description_of(
		EquityBusinessSource {
			source_document_id: source_document_id.to_owned(),
			form: EquityBusinessForm::SecuritiesReport,
			filed_on: filed_on.to_owned(),
			period_end: period_end.to_owned(),
			source_url: source_url.to_owned(),
		},
		business,
	)
}

/// The EDINET source (`createEdinetSource`).
pub struct EdinetSource {
	binary: Arc<dyn SafeBinaryFetcher>,
	/// `EDINET_API_KEY`; `None` = not configured, nothing is requested.
	api_key: Option<Secret>,
}

impl EdinetSource {
	/// A source over the shared binary fetcher; `api_key` is `EDINET_API_KEY`.
	pub fn new(binary: Arc<dyn SafeBinaryFetcher>, api_key: Option<Secret>) -> Self {
		Self { binary, api_key }
	}

	fn options(cancel: &CancellationToken) -> SafeFetchOptions {
		let mut options = fetch_options(EDINET_API_HOST, DOCUMENT_ACCEPT, cancel);
		options.max_bytes = EDINET_ZIP_MAX_BYTES;
		options.timeout_ms = EDINET_ZIP_TIMEOUT_MS;
		options
	}
}

/// How one download ended.
enum Download {
	/// The CSV is not there (yet): HTTP 404 or EDINET's 404 body.
	NotAvailable,
	/// Neither a ZIP nor an EDINET error status: this document is unreadable.
	NotAZip,
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

		let plan = edinet_download_plan(&EdinetPlanInput {
			pending: &request.pending_filings,
			indexed: &request.indexed_filings,
			known_filings: &request.known_filings,
			max_downloads: limits::MAX_DOCUMENTS_PER_JOB,
		});
		// For the describeFiling download after the loop (ADR-0053 §2).
		let planned_downloads = plan
			.iter()
			.filter(|document| document.action == EdinetDocumentAction::Download)
			.count();
		let describe = request.describe_filing.as_ref().filter(|describe| {
			describe.form == EquityReportForm::SecuritiesReport
				&& planned_downloads < limits::MAX_DOCUMENTS_PER_JOB
				&& !plan.iter().any(|document| {
					document.metadata.source_document_id == describe.source_document_id
				})
		});
		let mut description: Option<EquityBusinessDescription> = None;
		let mut description_unread: Option<EquitySyncDescriptionUnread> = None;
		let mut filings: Vec<EquityFilingResult> = Vec::with_capacity(plan.len());
		let mut unreadable_documents: Vec<EquitySyncUnreadableDocument> = Vec::new();
		let not_downloaded = |metadata: EquityFilingMetadata, facts_status| EquityFilingResult {
			metadata,
			accounting_standard: None,
			facts_status,
			facts: Vec::new(),
		};
		for document in plan {
			let metadata = document.metadata;
			if document.action == EdinetDocumentAction::Deferred {
				filings.push(not_downloaded(metadata, EquityFactsStatus::Deferred));
				continue;
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
					&Self::options(query.cancel),
				)
				.await;
			let status = match &fetched {
				Err(error) if error.code == SafeFetchErrorCode::HttpError => Ok(error.status),
				Err(error) => return Err(equity_sync_failure_of_fetch(error, requests)),
				Ok(document) if looks_like_zip(&document.bytes) => Ok(None),
				Ok(document) => {
					// EDINET answers some errors as JSON with HTTP 200: its own status decides.
					let status = research_js::json::parse_bytes(&document.bytes)
						.ok()
						.and_then(|value| edinet_error_status(&value));
					match status {
						Some(status) if status >= 400 => Ok(Some(status)),
						// Neither a ZIP nor an error status: this document is unreadable, not the source.
						_ => Err(Download::NotAZip),
					}
				}
			};
			let download = match (status, fetched) {
				(Err(unreadable), _) => unreadable,
				// The CSV can lag the filing: not available yet, offered again later.
				(Ok(Some(404)), _) => Download::NotAvailable,
				(Ok(Some(status)), _) => {
					return Err(EquitySyncFailure {
						code: equity_sync_code_of_status(status),
						upstream_status: Some(status),
						requests,
					});
				}
				(Ok(None), Ok(document)) => Download::Archive(document.bytes),
				(Ok(None), Err(_)) => {
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
				Download::NotAZip => {
					unreadable_documents.push(EquitySyncUnreadableDocument {
						source_document_id: metadata.source_document_id.clone(),
						problem: EquitySyncDocumentProblem::Report(EdinetReportProblem::NotAZip),
					});
					filings.push(not_downloaded(metadata, EquityFactsStatus::NotAvailable));
					continue;
				}
				Download::Archive(bytes) => bytes,
			};
			let concepts = query.target.concepts.clone();
			// Inflating, decoding and scanning tens of megabytes is CPU work.
			let report =
				match crate::cpu::offload(move || extract_edinet_report(&bytes, &concepts)).await {
					Ok(report) => report,
					Err(problem) => {
						unreadable_documents.push(EquitySyncUnreadableDocument {
							source_document_id: metadata.source_document_id.clone(),
							problem: EquitySyncDocumentProblem::Report(problem),
						});
						filings.push(not_downloaded(metadata, EquityFactsStatus::NotAvailable));
						continue;
					}
				};
			// Amendments rarely repeat 事業の内容: only an original report describes.
			if metadata.form == EquityReportForm::SecuritiesReport {
				description = newer_business_description(
					description,
					Some(report_description(
						&metadata.source_document_id,
						&metadata.filed_on,
						&metadata.source_url,
						&metadata.period_end,
						report.business,
					)),
				);
			}
			filings.push(EquityFilingResult {
				metadata,
				accounting_standard: report.accounting_standard,
				facts_status: EquityFactsStatus::Extracted,
				facts: report.facts,
			});
		}

		// A stored report newer than the stored description, read for that alone.
		if let Some(describe) = describe {
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
					&edinet_document_url(&describe.source_document_id, key.expose()),
					&Self::options(query.cancel),
				)
				.await;
			// A stopped job fails as on any other request; any other failure only
			// means no description from it (the next sync asks again), logged.
			match fetched {
				Err(error) => {
					let failure = equity_sync_failure_of_fetch(&error, requests);
					if query.cancel.is_cancelled() {
						return Err(failure);
					}
					description_unread = Some(EquitySyncDescriptionUnread::of_failure(failure));
				}
				Ok(document) if !looks_like_zip(&document.bytes) => {
					// EDINET answers some errors as JSON with HTTP 200: its own status, else unreadable.
					let status = research_js::json::parse_bytes(&document.bytes)
						.ok()
						.and_then(|value| edinet_error_status(&value));
					description_unread = Some(match status {
						Some(status) if status >= 400 => EquitySyncDescriptionUnread {
							code: DescriptionUnreadCode::Failure(equity_sync_code_of_status(
								status,
							)),
							upstream_status: Some(status),
						},
						_ => EquitySyncDescriptionUnread {
							code: DescriptionUnreadCode::Report(EdinetReportProblem::NotAZip),
							upstream_status: None,
						},
					});
				}
				Ok(document) => {
					let concepts = query.target.concepts.clone();
					let bytes = document.bytes;
					let report =
						crate::cpu::offload(move || extract_edinet_report(&bytes, &concepts)).await;
					match report {
						Ok(report) => {
							description = newer_business_description(
								description,
								Some(report_description(
									&describe.source_document_id,
									&describe.filed_on,
									&describe.source_url,
									&describe.period_end,
									report.business,
								)),
							);
						}
						Err(problem) => {
							description_unread = Some(EquitySyncDescriptionUnread {
								code: DescriptionUnreadCode::Report(problem),
								upstream_status: None,
							});
						}
					}
				}
			}
		}

		let fitted = fit_completion_caps(filings, COMPLETION_CAPS);
		Ok(EquitySyncData {
			identity: edinet_identity(
				request.edinet_code.as_deref(),
				request
					.indexed_filings
					.iter()
					.chain(&request.pending_filings),
			),
			more: !fitted.cut.is_empty(),
			filings: fitted.filings,
			requests,
			unreadable_documents,
			description,
			description_unread,
		})
	}
}
