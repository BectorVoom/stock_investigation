//! US annual filings and their facts from SEC EDGAR (port of
//! `packages/adapters/src/finance/secAnnualFilings.ts`, ADR-0048 §6).
//!
//! One `financial-sync` job reads:
//!  1. SEC's ticker list, only while the company's CIK is unknown (cached 12 h);
//!  2. the submissions JSON: identity and the recent filings as parallel arrays;
//!  3. the company facts JSON, only when a 10-K / 10-K/A filed since
//!     `filedSince` is new or pending, or the claim asks for a full check.
//!     Company facts list every fact once per filing that reported it
//!     (`accn`), so one document gives every filing's as-filed facts — and
//!     the older annual filings the submissions page no longer lists.
//!
//! Extraction is pure (`parse_sec_submissions`, `index_sec_company_facts`,
//! `sec_sync_result`) and replays the TypeScript's vectors. Correctness beats
//! coverage: an entry that does not parse, a value that is not exact decimal
//! text, a period that is not annual — each is left out, never repaired.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use indexmap::IndexMap;
use research_application::ports::Clock;
use research_contracts::equity_financials::{
	EquityAccountingStandard, EquityExtractedFact, EquityFactsStatus, EquityFilingMetadata,
	EquityFilingResult, EquityPeriodType, EquityProvider, EquityReportForm, EquityScope,
	EquitySyncFailureCode, EquitySyncIdentity, EquitySyncRequest, SecSyncRequest,
	is_fiscal_year_end, is_sec_accession,
};
use research_contracts::patterns::is_iso_date_time;
use research_domain::finance::financial_statements::{iso_day_number, sec_value_decimal};
use research_js::json::{Object, Value};
use research_js::utf16::utf16_len;
use research_js::whitespace::trim;
use serde::Serialize;

use crate::equity_sync::{
	COMPLETION_CAPS, CompletionCaps, EquitySyncData, EquitySyncFailure, EquitySyncQuery,
	EquitySyncSource, annual_facts_in_order, equity_sync_code_of_status, fit_completion_caps,
};
use crate::ports::BeforeRequest;
use crate::sec_13f::sec_submissions_url;
use crate::sec_client::{
	SecClient, SecError, SecErrorCode, SecRequest, is_usable_sec_user_agent, parse_sec_json,
};
use crate::sec_financials::{COMPANY_FACTS_MAX_BYTES, SecTickerDirectory, sec_company_facts_url};

/// Submissions of a filer with a long history run to a few megabytes.
pub const SEC_SUBMISSIONS_MAX_BYTES: usize = 8_000_000;
/// Company facts of large filers run to tens of megabytes.
pub const SEC_COMPANY_FACTS_MAX_BYTES: usize = COMPANY_FACTS_MAX_BYTES;

const US_GAAP_PREFIX: &str = "us-gaap:";
const MAX_NAME_CHARS: usize = 200;
const MAX_UNIT_CHARS: usize = 40;

/// The document did not have the shape SEC documents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("PARSE_FAILED")]
pub struct SecParseFailed;

fn annual_form(form: &str) -> Option<EquityReportForm> {
	match form {
		"10-K" => Some(EquityReportForm::TenK),
		"10-K/A" => Some(EquityReportForm::TenKA),
		_ => None,
	}
}

fn valid_date(text: &str) -> bool {
	iso_day_number(text).is_some()
}

/// `/^[A-Za-z0-9._-]{1,200}$/`: SEC primary documents are plain file names.
fn is_primary_document(text: &str) -> bool {
	(1..=200).contains(&text.len())
		&& text
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/* ---------- Submissions ---------- */

/// One 10-K / 10-K/A row of the submissions page, as SEC states it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecSubmissionRow {
	/// Accession number.
	pub accession: String,
	/// 10-K or 10-K/A.
	pub form: EquityReportForm,
	/// Filing date as SEC states it.
	pub filing_date: String,
	/// Report (period end) date as SEC states it.
	pub report_date: String,
	/// Acceptance instant as SEC states it.
	pub acceptance_date_time: String,
	/// Primary document file name as SEC states it.
	pub primary_document: String,
}

/// `SecSubmissions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecSubmissions {
	/// Trimmed entity name; `None` when missing, blank or over 200 characters.
	pub name: Option<String>,
	/// "MM-DD" from SEC's "MMDD"; `None` when missing or not a month and day.
	pub fiscal_year_end: Option<String>,
	/// The annual rows in SEC's order (newest first); other forms are dropped.
	pub annual_rows: Vec<SecSubmissionRow>,
}

/// `z.string().nullable().optional()` of an object member: `Ok(None)` for
/// absent or null, `Err` for any other non-string.
fn optional_text<'a>(object: &'a Object, key: &str) -> Result<Option<&'a str>, SecParseFailed> {
	match object.get(key) {
		None | Some(Value::Null) => Ok(None),
		Some(Value::String(text)) => Ok(Some(text)),
		Some(_) => Err(SecParseFailed),
	}
}

/// `z.array(z.string())` of an object member.
fn string_array<'a>(object: &'a Object, key: &str) -> Result<Vec<&'a str>, SecParseFailed> {
	object
		.get(key)
		.and_then(Value::as_array)
		.ok_or(SecParseFailed)?
		.iter()
		.map(|item| item.as_str().ok_or(SecParseFailed))
		.collect()
}

/// `parseSecSubmissions`.
///
/// # Errors
/// [`SecParseFailed`] for a document without the documented shape, or
/// parallel arrays of different lengths.
pub fn parse_sec_submissions(value: &Value) -> Result<SecSubmissions, SecParseFailed> {
	let document = value.as_object().ok_or(SecParseFailed)?;
	let name = optional_text(document, "name")?;
	let fiscal_year_end = optional_text(document, "fiscalYearEnd")?;
	let recent = document
		.get("filings")
		.and_then(Value::as_object)
		.and_then(|filings| filings.get("recent"))
		.and_then(Value::as_object)
		.ok_or(SecParseFailed)?;
	let accessions = string_array(recent, "accessionNumber")?;
	let filing_dates = string_array(recent, "filingDate")?;
	let report_dates = string_array(recent, "reportDate")?;
	let acceptances = string_array(recent, "acceptanceDateTime")?;
	let forms = string_array(recent, "form")?;
	let documents = string_array(recent, "primaryDocument")?;
	let count = accessions.len();
	// Parallel arrays of different lengths cannot be paired row by row.
	if [
		filing_dates.len(),
		report_dates.len(),
		acceptances.len(),
		forms.len(),
		documents.len(),
	]
	.iter()
	.any(|length| *length != count)
	{
		return Err(SecParseFailed);
	}
	let mut annual_rows = Vec::new();
	for (index, accession) in accessions.iter().enumerate() {
		let Some(form) = forms.get(index).and_then(|form| annual_form(form)) else {
			continue;
		};
		if !is_sec_accession(accession) {
			continue;
		}
		let at = |column: &[&str]| column.get(index).copied().unwrap_or("").to_owned();
		annual_rows.push(SecSubmissionRow {
			accession: (*accession).to_owned(),
			form,
			filing_date: at(&filing_dates),
			report_date: at(&report_dates),
			acceptance_date_time: at(&acceptances),
			primary_document: at(&documents),
		});
	}
	let name = trim(name.unwrap_or(""));
	let fiscal_year_end = fiscal_year_end.and_then(|text| {
		let month = text.get(..2)?;
		let day = text.get(2..)?;
		let dashed = format!("{month}-{day}");
		(text.len() == 4 && is_fiscal_year_end(&dashed)).then_some(dashed)
	});
	Ok(SecSubmissions {
		name: (1..=MAX_NAME_CHARS)
			.contains(&utf16_len(name))
			.then(|| name.to_owned()),
		fiscal_year_end,
		annual_rows,
	})
}

/* ---------- Company facts ---------- */

/// What company facts say about one annual accession, for the claimed concepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecFactsOfAccession {
	/// "10-K/A" when any of its entries says so, else "10-K".
	pub form: EquityReportForm,
	/// The earliest `filed` date its entries state.
	pub filed: String,
	/// Entries for claimed concepts, including those whose value is not exact text.
	pub entry_count: usize,
	/// Those entries as facts (value exact), before the annual filter.
	pub facts: Vec<EquityExtractedFact>,
}

/// Facts by accession, in first-seen order.
pub type SecFactsIndex = IndexMap<String, SecFactsOfAccession>;

/// A `factEntrySchema` entry, borrowed.
struct FactEntry<'a> {
	start: Option<&'a str>,
	end: &'a str,
	val: f64,
	accn: &'a str,
	form: &'a str,
	filed: &'a str,
}

fn fact_entry(value: &Value) -> Option<FactEntry<'_>> {
	let object = value.as_object()?;
	let text = |key: &str| object.get(key).and_then(Value::as_str);
	let start = match object.get("start") {
		None => None,
		Some(Value::String(start)) => Some(start.as_str()),
		Some(_) => return None,
	};
	Some(FactEntry {
		start,
		end: text("end")?,
		val: object.get("val").and_then(Value::as_f64)?,
		accn: text("accn")?,
		form: text("form")?,
		filed: text("filed")?,
	})
}

/// `z.record(z.string(), z.array(z.unknown()))`: every member (`__proto__`
/// is skipped, as zod skips it) must be an array.
fn units_of(concept: &Value) -> Option<Vec<(&str, &[Value])>> {
	let units = concept.as_object()?.get("units")?.as_object()?;
	units
		.iter()
		.filter(|(key, _)| *key != "__proto__")
		.map(|(key, entries)| entries.as_array().map(|entries| (key, entries)))
		.collect()
}

/// `indexSecCompanyFacts`: indexes the company-facts document by accession
/// in one pass over the claimed concepts only (`us-gaap:Revenues` is looked
/// up as `Revenues` under `facts["us-gaap"]`), keeping entries of 10-K /
/// 10-K/A filings. A malformed entry is skipped; a document without the
/// expected shape fails. Every fact is consolidated: company facts carry no
/// dimensional contexts.
///
/// # Errors
/// [`SecParseFailed`] when the document has no `facts` object.
pub fn index_sec_company_facts(
	value: &Value,
	concepts: &[String],
) -> Result<SecFactsIndex, SecParseFailed> {
	let facts = value
		.as_object()
		.and_then(|document| document.get("facts"))
		.and_then(Value::as_object)
		.ok_or(SecParseFailed)?;
	let mut index = SecFactsIndex::new();
	// A filer without us-gaap facts (an IFRS filer) has no entries for the claimed concepts.
	let Some(taxonomy) = facts.get("us-gaap").and_then(Value::as_object) else {
		return Ok(index);
	};
	let mut seen: HashSet<&str> = HashSet::with_capacity(concepts.len());
	for concept in concepts {
		if !seen.insert(concept.as_str()) {
			continue;
		}
		let Some(name) = concept.strip_prefix(US_GAAP_PREFIX) else {
			continue;
		};
		if name == "__proto__" {
			continue;
		}
		let Some(units) = taxonomy.get(name).and_then(units_of) else {
			continue;
		};
		for (unit, entries) in units {
			if !(1..=MAX_UNIT_CHARS).contains(&utf16_len(unit)) {
				continue;
			}
			for entry in entries.iter().filter_map(fact_entry) {
				let Some(form) = annual_form(entry.form) else {
					continue;
				};
				if !is_sec_accession(entry.accn)
					|| !valid_date(entry.end)
					|| !valid_date(entry.filed)
					|| entry.start.is_some_and(|start| !valid_date(start))
				{
					continue;
				}
				let record =
					index
						.entry(entry.accn.to_owned())
						.or_insert_with(|| SecFactsOfAccession {
							form,
							filed: entry.filed.to_owned(),
							entry_count: 0,
							facts: Vec::new(),
						});
				if form == EquityReportForm::TenKA {
					record.form = EquityReportForm::TenKA;
				}
				if entry.filed < record.filed.as_str() {
					entry.filed.clone_into(&mut record.filed);
				}
				record.entry_count += 1;
				let Some(value_decimal) = sec_value_decimal(entry.val) else {
					continue;
				};
				record.facts.push(EquityExtractedFact {
					concept: concept.clone(),
					unit: unit.to_owned(),
					value_decimal,
					period_type: if entry.start.is_some() {
						EquityPeriodType::Duration
					} else {
						EquityPeriodType::Instant
					},
					period_start: entry.start.map(str::to_owned),
					period_end: entry.end.to_owned(),
					scope: EquityScope::Consolidated,
				});
			}
		}
	}
	Ok(index)
}

/* ---------- The sync result ---------- */

/// `secFilingUrl`: the archive folder of an accession, or its primary
/// document when SEC names a plain file.
#[must_use]
pub fn sec_filing_url(cik: &str, accession: &str, primary_document: Option<&str>) -> String {
	let folder = format!(
		"https://www.sec.gov/Archives/edgar/data/{}/{}/",
		cik.trim_start_matches('0'),
		accession.replace('-', "")
	);
	match primary_document {
		Some(document) if is_primary_document(document) => format!("{folder}{document}"),
		_ => folder,
	}
}

/// Accessions the claim already stores (and does not offer again as pending).
fn settled_accessions(request: &SecSyncRequest) -> HashSet<&str> {
	let pending: HashSet<&str> = request
		.pending_filings
		.iter()
		.map(|filing| filing.source_document_id.as_str())
		.collect();
	request
		.known_accessions
		.iter()
		.map(String::as_str)
		.filter(|accession| !pending.contains(accession))
		.collect()
}

/// `secNeedsCompanyFacts`: a full check, a pending filing, or a 10-K /
/// 10-K/A row filed since `filedSince` whose accession the claim does not
/// store yet.
#[must_use]
pub fn sec_needs_company_facts(request: &SecSyncRequest, submissions: &SecSubmissions) -> bool {
	if request.full_check || !request.pending_filings.is_empty() {
		return true;
	}
	let known: HashSet<&str> = request
		.known_accessions
		.iter()
		.map(String::as_str)
		.collect();
	submissions.annual_rows.iter().any(|row| {
		valid_date(&row.filing_date)
			&& row.filing_date >= request.filed_since
			&& !known.contains(row.accession.as_str())
	})
}

/// The latest end of an annual duration among a filing's facts, else the latest end at all.
fn latest_period_end(record: &SecFactsOfAccession) -> Option<String> {
	let annual_end = annual_facts_in_order(record.facts.clone())
		.into_iter()
		.filter(|fact| fact.period_type == EquityPeriodType::Duration)
		.map(|fact| fact.period_end)
		.max();
	annual_end.or_else(|| {
		record
			.facts
			.iter()
			.map(|fact| fact.period_end.clone())
			.max()
	})
}

/// `SecSyncInput`.
pub struct SecSyncInput<'a> {
	/// The claim's request.
	pub request: &'a SecSyncRequest,
	/// Ten digits: the claim's, or the one resolved from SEC's ticker list.
	pub cik: &'a str,
	/// The parsed submissions.
	pub submissions: &'a SecSubmissions,
	/// `None` when the company facts were not read (nothing new).
	pub facts: Option<&'a SecFactsIndex>,
}

/// `secSyncResult`'s answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecSyncResult {
	/// CIK, entity name, fiscal year end.
	pub identity: EquitySyncIdentity,
	/// Filings within the caps, newest first.
	pub filings: Vec<EquityFilingResult>,
	/// Filings were cut by the caps.
	pub more: bool,
}

/// `secSyncResult` (ADR-0048 §6), pure:
///
/// - pending filings come back with the claim's stored metadata;
/// - new 10-K / 10-K/A rows of the submissions page filed since
///   `filedSince` take their metadata from it;
/// - new annual accessions that only company facts list (older filings),
///   filed since `filedSince`, take theirs from the facts: `filed`, the
///   latest annual period end, the archive folder;
/// - a filing is `extracted` with its annual facts when company facts hold
///   an entry of it for any claimed concept, else `not-available`;
/// - then the completion caps.
#[must_use]
pub fn sec_sync_result(input: &SecSyncInput<'_>, caps: CompletionCaps) -> SecSyncResult {
	let SecSyncInput {
		request,
		cik,
		submissions,
		facts,
	} = *input;
	let settled = settled_accessions(request);
	let mut seen: HashSet<String> = HashSet::new();
	let mut filings: Vec<EquityFilingResult> = Vec::new();
	let with_facts = |metadata: EquityFilingMetadata| -> EquityFilingResult {
		match facts
			.and_then(|index| index.get(&metadata.source_document_id))
			.filter(|record| record.entry_count > 0)
		{
			None => EquityFilingResult {
				metadata,
				accounting_standard: None,
				facts_status: EquityFactsStatus::NotAvailable,
				facts: Vec::new(),
			},
			Some(record) => EquityFilingResult {
				metadata,
				accounting_standard: Some(EquityAccountingStandard::UsGaap),
				facts_status: EquityFactsStatus::Extracted,
				facts: annual_facts_in_order(record.facts.clone()),
			},
		}
	};

	for pending in &request.pending_filings {
		if !seen.insert(pending.source_document_id.clone()) {
			continue;
		}
		filings.push(with_facts(pending.clone()));
	}

	for row in &submissions.annual_rows {
		if seen.contains(&row.accession) || settled.contains(row.accession.as_str()) {
			continue;
		}
		if !valid_date(&row.filing_date) || row.filing_date < request.filed_since {
			continue;
		}
		let record = facts.and_then(|index| index.get(&row.accession));
		let period_end = if valid_date(&row.report_date) {
			Some(row.report_date.clone())
		} else {
			record.and_then(latest_period_end)
		};
		let Some(period_end) = period_end else {
			continue;
		};
		seen.insert(row.accession.clone());
		filings.push(with_facts(EquityFilingMetadata {
			source_document_id: row.accession.clone(),
			form: row.form,
			filed_on: row.filing_date.clone(),
			submitted_at: is_iso_date_time(&row.acceptance_date_time)
				.then(|| row.acceptance_date_time.clone()),
			period_start: None,
			period_end,
			amends_source_document_id: None,
			source_url: sec_filing_url(cik, &row.accession, Some(&row.primary_document)),
		}));
	}

	if let Some(index) = facts {
		for (accession, record) in index {
			if seen.contains(accession) || settled.contains(accession.as_str()) {
				continue;
			}
			if record.filed < request.filed_since {
				continue;
			}
			let Some(period_end) = latest_period_end(record) else {
				continue;
			};
			seen.insert(accession.clone());
			filings.push(with_facts(EquityFilingMetadata {
				source_document_id: accession.clone(),
				form: record.form,
				filed_on: record.filed.clone(),
				submitted_at: None,
				period_start: None,
				period_end,
				amends_source_document_id: None,
				source_url: sec_filing_url(cik, accession, None),
			}));
		}
	}

	let fitted = fit_completion_caps(filings, caps);
	SecSyncResult {
		identity: EquitySyncIdentity {
			source_company_id: cik.to_owned(),
			name: submissions.name.clone(),
			fiscal_year_end: submissions.fiscal_year_end.clone(),
		},
		more: !fitted.cut.is_empty(),
		filings: fitted.filings,
	}
}

/* ---------- Failures ---------- */

/// `equitySyncFailureOfSec`: SEC's status decides when it answered with one
/// (401/403 denied, 429 rate limited, anything else a source failure — 404
/// included: a CIK whose submissions are missing is SEC's problem, not proof
/// the company does not exist); without a status, an oversized or malformed
/// answer is a parse failure and a timeout or network error a source failure.
#[must_use]
pub fn equity_sync_failure_of_sec(error: &SecError, requests: usize) -> EquitySyncFailure {
	if error.code == SecErrorCode::NotConfigured {
		return EquitySyncFailure::own(EquitySyncFailureCode::SourceNotConfigured, requests);
	}
	if let Some(status) = error.upstream_status {
		return EquitySyncFailure {
			code: equity_sync_code_of_status(status),
			upstream_status: Some(status),
			requests,
		};
	}
	let code = match error.code {
		SecErrorCode::ResponseTooLarge | SecErrorCode::UnexpectedResponse => {
			EquitySyncFailureCode::ParseFailed
		}
		SecErrorCode::AccessDenied => EquitySyncFailureCode::AccessDenied,
		SecErrorCode::RateLimited => EquitySyncFailureCode::RateLimited,
		_ => EquitySyncFailureCode::SourceFailed,
	};
	EquitySyncFailure::own(code, requests)
}

/* ---------- Source ---------- */

/// Counts the requests the pacing gate admits: every admitted request is sent.
pub(crate) struct CountingGate<'a> {
	inner: &'a dyn BeforeRequest,
	count: AtomicUsize,
}

impl<'a> CountingGate<'a> {
	pub(crate) const fn new(inner: &'a dyn BeforeRequest) -> Self {
		Self {
			inner,
			count: AtomicUsize::new(0),
		}
	}

	pub(crate) fn count(&self) -> usize {
		self.count.load(Ordering::Relaxed)
	}
}

#[async_trait]
impl BeforeRequest for CountingGate<'_> {
	async fn before_request(&self) -> bool {
		if !self.inner.before_request().await {
			return false;
		}
		self.count.fetch_add(1, Ordering::Relaxed);
		true
	}
}

/// The US source (`createSecAnnualFilingsSource`) over the shared paced SEC
/// client, with its own ticker-list cache.
pub struct SecAnnualFilingsSource {
	client: Arc<dyn SecClient>,
	directory: SecTickerDirectory,
	configured: bool,
}

impl SecAnnualFilingsSource {
	/// A source over `client`; `user_agent` is `SEC_USER_AGENT` (without a
	/// usable one nothing is ever requested).
	pub fn new(
		client: Arc<dyn SecClient>,
		clock: Arc<dyn Clock>,
		user_agent: Option<&str>,
	) -> Self {
		Self {
			directory: SecTickerDirectory::new(Arc::clone(&client), clock),
			client,
			configured: is_usable_sec_user_agent(user_agent),
		}
	}

	/// One paced SEC request; `None` when the job stopped while waiting.
	async fn fetch(
		&self,
		gate: &CountingGate<'_>,
		query: &EquitySyncQuery<'_>,
		url: &str,
		max_bytes: usize,
	) -> Option<Result<crate::sec_client::SecDocument, SecError>> {
		if !gate.before_request().await {
			return None;
		}
		Some(
			self.client
				.fetch_document(
					url,
					SecRequest {
						max_bytes,
						accept: "application/json",
						cancel: Some(query.cancel),
					},
				)
				.await,
		)
	}
}

#[async_trait]
impl EquitySyncSource for SecAnnualFilingsSource {
	fn provider(&self) -> EquityProvider {
		EquityProvider::Sec
	}

	async fn sync(&self, query: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure> {
		let EquitySyncRequest::Sec(request) = &query.target.source else {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceFailed,
				0,
			));
		};
		// Without a usable User-Agent nothing is requested at all.
		if !self.configured {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceNotConfigured,
				0,
			));
		}
		let gate = CountingGate::new(query.before_request);
		let stopped = |gate: &CountingGate<'_>| {
			EquitySyncFailure::own(EquitySyncFailureCode::SourceFailed, gate.count())
		};
		let parse_failed = |gate: &CountingGate<'_>| {
			EquitySyncFailure::own(EquitySyncFailureCode::ParseFailed, gate.count())
		};

		let cik = match &request.cik {
			Some(cik) => cik.clone(),
			None => {
				let found = self
					.directory
					.lookup(&query.target.symbol, Some(query.cancel), Some(&gate))
					.await;
				match found {
					// The ticker list itself missing (404) means SEC cannot name the company.
					Err(error) if error.code == SecErrorCode::NotFound => {
						return Err(EquitySyncFailure {
							code: EquitySyncFailureCode::CompanyNotFound,
							upstream_status: error.upstream_status,
							requests: gate.count(),
						});
					}
					Err(error) => return Err(equity_sync_failure_of_sec(&error, gate.count())),
					Ok(found) => match found.issuer {
						None => {
							return Err(EquitySyncFailure::own(
								EquitySyncFailureCode::CompanyNotFound,
								gate.count(),
							));
						}
						Some(issuer) => issuer.cik,
					},
				}
			}
		};

		let submissions = match self
			.fetch(
				&gate,
				&query,
				&sec_submissions_url(&cik),
				SEC_SUBMISSIONS_MAX_BYTES,
			)
			.await
		{
			None => return Err(stopped(&gate)),
			Some(Err(error)) => return Err(equity_sync_failure_of_sec(&error, gate.count())),
			Some(Ok(document)) => {
				// Megabytes of JSON: parse off the tokio worker.
				crate::cpu::offload(move || {
					let value = parse_sec_json(&document)?;
					Ok::<_, SecError>(parse_sec_submissions(&value))
				})
				.await
			}
		};
		let submissions = match submissions {
			Err(error) => return Err(equity_sync_failure_of_sec(&error, gate.count())),
			Ok(Err(SecParseFailed)) => return Err(parse_failed(&gate)),
			Ok(Ok(submissions)) => submissions,
		};

		let mut facts: Option<SecFactsIndex> = None;
		if sec_needs_company_facts(request, &submissions) {
			match self
				.fetch(
					&gate,
					&query,
					&sec_company_facts_url(&cik),
					SEC_COMPANY_FACTS_MAX_BYTES,
				)
				.await
			{
				None => return Err(stopped(&gate)),
				// SEC has no company facts for a filer without XBRL data: every
				// filing is then not available (yet), which is not a failure.
				Some(Err(error)) if error.code == SecErrorCode::NotFound => {
					facts = Some(SecFactsIndex::new());
				}
				Some(Err(error)) => return Err(equity_sync_failure_of_sec(&error, gate.count())),
				Some(Ok(document)) => {
					let concepts = query.target.concepts.clone();
					// Up to 48 MB of JSON: parse and index off the tokio worker.
					let indexed = crate::cpu::offload(move || {
						let value = parse_sec_json(&document)?;
						Ok::<_, SecError>(index_sec_company_facts(&value, &concepts))
					})
					.await;
					match indexed {
						Err(error) => {
							return Err(equity_sync_failure_of_sec(&error, gate.count()));
						}
						Ok(Err(SecParseFailed)) => return Err(parse_failed(&gate)),
						Ok(Ok(index)) => facts = Some(index),
					}
				}
			}
		}

		let result = sec_sync_result(
			&SecSyncInput {
				request,
				cik: &cik,
				submissions: &submissions,
				facts: facts.as_ref(),
			},
			COMPLETION_CAPS,
		);
		Ok(EquitySyncData {
			identity: Some(result.identity),
			scanned_days: Vec::new(),
			filings: result.filings,
			more: result.more,
			requests: gate.count(),
		})
	}
}
