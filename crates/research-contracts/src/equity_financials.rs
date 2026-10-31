//! Annual financial statements synchronised from SEC EDGAR and EDINET
//! (`packages/contracts/src/equityFinancials.ts`, ADR-0048). Only the parts
//! the runner reaches are ported: the limits, the failure codes, the
//! `financial-sync` claim's source request and the `financial-synced`
//! completion's fields with their cross-field rule. The read API's response
//! schemas stay TypeScript (the runner never reads them).

use std::collections::HashSet;

use research_js::json::{Object, Value};
use serde::Serialize;

pub use research_domain::finance::financial_statements::{
	EquityAccountingStandard, EquityExtractedFact, EquityMarket, EquityMetricCode,
	EquityPeriodType, EquityProvider, EquityReportForm, EquityScope, EquityStatement,
	is_canonical_decimal, iso_day_number,
};

use crate::Contract;
use crate::primitives::{HTTPS_URL, ISO_DATE_TIME, id};
use crate::zod::{
	ArrCheck, Cx, Pattern, StrCheck, UnionOption, array, boolean, decode_fields, decode_object,
	js_enum, nullable, object_input, refine, run_discriminated, run_string, run_union, string,
	unrecognized,
};

/// `EQUITY_FINANCIAL_LIMITS` (the runner-side part).
pub mod limits {
	/// Concepts a claim asks the runner to extract.
	pub const MAX_CONCEPTS: usize = 64;
	/// Filings a claim lists as already stored, per company.
	pub const MAX_KNOWN_FILINGS: usize = 400;
	/// Filings whose facts were not available yet, offered again.
	pub const MAX_PENDING_FILINGS: usize = 20;
	/// EDINET dates one job scans (one request each, about one second apart).
	pub const MAX_SCAN_DAYS: usize = 40;
	/// EDINET documents one job downloads.
	pub const MAX_DOCUMENTS_PER_JOB: usize = 8;
	/// Filings one completion carries.
	pub const MAX_FILINGS_PER_COMPLETION: usize = 60;
	/// Facts one completion carries (all filings together).
	pub const MAX_FACTS_PER_COMPLETION: usize = 3_000;
	/// Longest concept name.
	pub const MAX_CONCEPT_CHARS: usize = 160;
	/// Longest company name.
	pub const MAX_NAME_CHARS: usize = 200;
	/// Longest source document id.
	pub const MAX_SOURCE_DOCUMENT_ID_CHARS: usize = 40;
}

js_enum! {
	/// `equitySyncFailureCodeSchema` (`EQUITY_SYNC_FAILURE_CODES`): the
	/// `failureCode` of a failed `financial-sync` job; provider text is never
	/// carried, the provider's HTTP status travels beside it (ADR-0037).
	pub enum EquitySyncFailureCode {
		/// `SEC_USER_AGENT` (US) or `EDINET_API_KEY` (JP) is not set.
		SourceNotConfigured = "FINANCIAL_SOURCE_NOT_CONFIGURED",
		/// The ticker is not in SEC's ticker list.
		CompanyNotFound = "FINANCIAL_COMPANY_NOT_FOUND",
		/// The provider answered HTTP 429.
		RateLimited = "FINANCIAL_RATE_LIMITED",
		/// The provider refused the key or the User-Agent (401/403).
		AccessDenied = "FINANCIAL_ACCESS_DENIED",
		/// A network failure, a timeout or another HTTP failure.
		SourceFailed = "FINANCIAL_SOURCE_FAILED",
		/// A document arrived but did not have the expected shape.
		ParseFailed = "FINANCIAL_PARSE_FAILED",
	}
}

impl EquitySyncFailureCode {
	/// Whether a retry may help (ADR-0048 §6): rate limits and source
	/// failures (network, timeout, 5xx) are transient; the rest are not.
	#[must_use]
	pub const fn is_retryable(self) -> bool {
		matches!(self, Self::RateLimited | Self::SourceFailed)
	}
}

js_enum! {
	/// `equityFilingResultSchema.factsStatus`.
	pub enum EquityFactsStatus {
		/// Its annual facts were read (possibly none of the mapped concepts).
		Extracted = "extracted",
		/// The source has no machine-readable facts for it (yet).
		NotAvailable = "not-available",
		/// Found but not downloaded in this job (download cap).
		Deferred = "deferred",
	}
}

/* ---------- Patterns ---------- */

fn digits(bytes: &[u8]) -> bool {
	bytes.iter().all(u8::is_ascii_digit)
}

fn upper_digit(byte: u8) -> bool {
	byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

/// `secCikSchema`.
pub static SEC_CIK: Pattern = Pattern {
	source: r"/^\d{10}$/",
	matches: |text| text.len() == 10 && digits(text.as_bytes()),
};

/// `edinetCodeSchema`.
pub static EDINET_CODE: Pattern = Pattern {
	source: r"/^E\d{5}$/",
	matches: |text| matches!(text.as_bytes(), [b'E', rest @ ..] if rest.len() == 5 && digits(rest)),
};

/// `edinetSecuritiesCodeSchema`.
pub static EDINET_SECURITIES_CODE: Pattern = Pattern {
	source: "/^[0-9A-Z]{4}0$/",
	matches: |text| matches!(text.as_bytes(), [a, b, c, d, b'0'] if [*a, *b, *c, *d].into_iter().all(upper_digit)),
};

/// `secAccessionSchema`.
pub static SEC_ACCESSION: Pattern = Pattern {
	source: r"/^\d{10}-\d{2}-\d{6}$/",
	matches: is_sec_accession,
};

/// `edinetDocIdSchema`.
pub static EDINET_DOC_ID: Pattern = Pattern {
	source: "/^S[0-9A-Z]{7}$/",
	matches: is_edinet_doc_id,
};

/// `fiscalYearEndSchema` ("MM-DD").
pub static FISCAL_YEAR_END: Pattern = Pattern {
	source: r"/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/",
	matches: is_fiscal_year_end,
};

/// `equityConceptSchema`'s pattern.
pub static CONCEPT: Pattern = Pattern {
	source: "/^[a-z][a-z0-9_-]*:[A-Za-z][A-Za-z0-9_]*$/",
	matches: is_concept,
};

/// `secAccessionSchema` as a predicate.
#[must_use]
pub fn is_sec_accession(text: &str) -> bool {
	let bytes = text.as_bytes();
	bytes.len() == 20
		&& bytes.get(10) == Some(&b'-')
		&& bytes.get(13) == Some(&b'-')
		&& bytes
			.iter()
			.enumerate()
			.all(|(at, byte)| at == 10 || at == 13 || byte.is_ascii_digit())
}

/// `edinetDocIdSchema` as a predicate.
#[must_use]
pub fn is_edinet_doc_id(text: &str) -> bool {
	matches!(text.as_bytes(), [b'S', rest @ ..] if rest.len() == 7 && rest.iter().copied().all(upper_digit))
}

/// `secCikSchema` as a predicate.
#[must_use]
pub fn is_sec_cik(text: &str) -> bool {
	(SEC_CIK.matches)(text)
}

/// `edinetCodeSchema` as a predicate.
#[must_use]
pub fn is_edinet_code(text: &str) -> bool {
	(EDINET_CODE.matches)(text)
}

/// `fiscalYearEndSchema` as a predicate.
#[must_use]
pub fn is_fiscal_year_end(text: &str) -> bool {
	let [m0, m1, b'-', d0, d1] = text.as_bytes() else {
		return false;
	};
	let month_ok = matches!((m0, m1), (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2'));
	let day_ok = matches!(
		(d0, d1),
		(b'0', b'1'..=b'9') | (b'1' | b'2', b'0'..=b'9') | (b'3', b'0' | b'1')
	);
	month_ok && day_ok
}

/// `equityConceptSchema`'s pattern as a predicate.
#[must_use]
pub fn is_concept(text: &str) -> bool {
	let Some((prefix, name)) = text.split_once(':') else {
		return false;
	};
	let prefix_ok = prefix.as_bytes().split_first().is_some_and(|(head, tail)| {
		head.is_ascii_lowercase()
			&& tail.iter().all(|byte| {
				byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
			})
	});
	let name_ok = name.as_bytes().split_first().is_some_and(|(head, tail)| {
		head.is_ascii_alphabetic()
			&& tail
				.iter()
				.all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
	});
	prefix_ok && name_ok
}

fn is_calendar_date(text: &str) -> bool {
	iso_day_number(text).is_some()
}

/* ---------- String schemas ---------- */

/// `equityCalendarDateSchema`: `z.iso.date()` refined to a real calendar date.
pub(crate) const CALENDAR_DATE: &[StrCheck] = &[
	StrCheck::IsoDate,
	StrCheck::Refine(is_calendar_date, "calendar date expected"),
];
const SOURCE_DOCUMENT_ID: &[StrCheck] = &[
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_SOURCE_DOCUMENT_ID_CHARS),
];
const CONCEPT_CHECKS: &[StrCheck] = &[
	StrCheck::Max(limits::MAX_CONCEPT_CHARS),
	StrCheck::Regex(&CONCEPT, None),
];
const UNIT: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(40)];
const VALUE_DECIMAL: &[StrCheck] = &[
	StrCheck::Max(64),
	StrCheck::Refine(is_canonical_decimal, "canonical decimal text expected"),
];
const SYMBOL: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(16)];
const COMPANY_NAME: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_NAME_CHARS),
];
const SEC_CIK_CHECKS: &[StrCheck] = &[StrCheck::Regex(&SEC_CIK, None)];
const EDINET_CODE_CHECKS: &[StrCheck] = &[StrCheck::Regex(&EDINET_CODE, None)];
const EDINET_SECURITIES_CODE_CHECKS: &[StrCheck] =
	&[StrCheck::Regex(&EDINET_SECURITIES_CODE, None)];
const SEC_ACCESSION_CHECKS: &[StrCheck] = &[StrCheck::Regex(&SEC_ACCESSION, None)];
const EDINET_DOC_ID_CHECKS: &[StrCheck] = &[StrCheck::Regex(&EDINET_DOC_ID, None)];
const FISCAL_YEAR_END_CHECKS: &[StrCheck] = &[StrCheck::Regex(&FISCAL_YEAR_END, None)];

const PENDING_FILINGS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_PENDING_FILINGS)];
const KNOWN_FILINGS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_KNOWN_FILINGS)];
const SCAN_DAYS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_SCAN_DAYS)];
const CONCEPTS: &[ArrCheck] = &[ArrCheck::Min(1), ArrCheck::Max(limits::MAX_CONCEPTS)];
const FACTS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_FACTS_PER_COMPLETION)];
const FILINGS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_FILINGS_PER_COMPLETION)];

fn decode_enum<T: Contract>(cx: &mut Cx, input: Option<&Value>) -> Option<T> {
	T::decode(cx, input)
}

/* ---------- Claim ---------- */

/// `equityFilingMetadataShape` / `equityPendingFilingSchema`: a filing's
/// metadata as the source states it; a pending filing is offered again
/// with its stored metadata, which the runner echoes back unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityFilingMetadata {
	/// Accession number (SEC) or document id (EDINET).
	pub source_document_id: String,
	/// The report form.
	pub form: EquityReportForm,
	/// Filing date.
	pub filed_on: String,
	/// SEC acceptance / EDINET submission instant, when stated.
	pub submitted_at: Option<String>,
	/// The report's own fiscal period start, when known.
	pub period_start: Option<String>,
	/// The report's own fiscal period end.
	pub period_end: String,
	/// The filing it amends (EDINET parentDocID).
	pub amends_source_document_id: Option<String>,
	/// The filing's public page.
	pub source_url: String,
}

const METADATA_KEYS: [&str; 8] = [
	"sourceDocumentId",
	"form",
	"filedOn",
	"submittedAt",
	"periodStart",
	"periodEnd",
	"amendsSourceDocumentId",
	"sourceUrl",
];

fn decode_metadata_fields(cx: &mut Cx, object: &Object) -> Option<EquityFilingMetadata> {
	decode_fields!(cx, object, EquityFilingMetadata {
		source_document_id: "sourceDocumentId" => string(SOURCE_DOCUMENT_ID),
		form: "form" => decode_enum::<EquityReportForm>,
		filed_on: "filedOn" => string(CALENDAR_DATE),
		submitted_at: "submittedAt" => nullable(string(ISO_DATE_TIME)),
		period_start: "periodStart" => nullable(string(CALENDAR_DATE)),
		period_end: "periodEnd" => string(CALENDAR_DATE),
		amends_source_document_id: "amendsSourceDocumentId" => nullable(string(SOURCE_DOCUMENT_ID)),
		source_url: "sourceUrl" => string(HTTPS_URL),
	})
}

impl EquityFilingMetadata {
	/// `equityPendingFilingSchema` decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let object = object_input(cx, input)?;
		let metadata = decode_metadata_fields(cx, object);
		unrecognized(cx, object, &METADATA_KEYS);
		metadata
	}
}

/// `secSyncRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecSyncRequest {
	/// Ten-digit CIK; `None` until resolved from SEC's ticker list.
	pub cik: Option<String>,
	/// Accessions already stored.
	pub known_accessions: Vec<String>,
	/// Stored filings whose facts were not available yet.
	pub pending_filings: Vec<EquityFilingMetadata>,
	/// Annual filings filed on or after this date are read.
	pub filed_since: String,
	/// Read the company facts even when nothing is new.
	pub full_check: bool,
}

/// `edinetKnownFilingSchema`: a stored EDINET filing the claim names so the
/// runner neither downloads it again nor loses an amendment of it — an
/// amendment's (130) list row states no period (EDINET API spec §3-1-2-2
/// *3), so it takes its original's stored period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetKnownFiling {
	/// Document id.
	pub doc_id: String,
	/// The stored fiscal period start, when known.
	pub period_start: Option<String>,
	/// The stored fiscal period end.
	pub period_end: String,
}

impl EdinetKnownFiling {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			doc_id: "docId" => string(EDINET_DOC_ID_CHECKS),
			period_start: "periodStart" => nullable(string(CALENDAR_DATE)),
			period_end: "periodEnd" => string(CALENDAR_DATE),
		})
	}
}

/// `edinetSyncRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetSyncRequest {
	/// EDINET's five-character securities code (JPX code + "0").
	pub sec_code: String,
	/// The filer's EDINET code, once known.
	pub edinet_code: Option<String>,
	/// Stored filings (not pending), with their periods.
	pub known_filings: Vec<EdinetKnownFiling>,
	/// Stored filings whose facts were not available yet.
	pub pending_filings: Vec<EquityFilingMetadata>,
	/// The dates to list, in scan order.
	pub scan_days: Vec<String>,
}

/// `equitySyncRequestSchema`: the provider-specific part of the claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "provider")]
pub enum EquitySyncRequest {
	/// SEC EDGAR.
	#[serde(rename = "sec")]
	Sec(SecSyncRequest),
	/// EDINET.
	#[serde(rename = "edinet")]
	Edinet(EdinetSyncRequest),
}

impl EquitySyncRequest {
	/// The provider this request is for.
	#[must_use]
	pub const fn provider(&self) -> EquityProvider {
		match self {
			Self::Sec(_) => EquityProvider::Sec,
			Self::Edinet(_) => EquityProvider::Edinet,
		}
	}

	/// The stored filings offered again.
	#[must_use]
	pub fn pending_filings(&self) -> &[EquityFilingMetadata] {
		match self {
			Self::Sec(request) => &request.pending_filings,
			Self::Edinet(request) => &request.pending_filings,
		}
	}

	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(
			cx,
			input,
			"provider",
			EquityProvider::VALUES,
			|cx, tag| match tag {
				0 => decode_object!(cx, input, strict, ["provider"], SecSyncRequest {
					cik: "cik" => nullable(string(SEC_CIK_CHECKS)),
					known_accessions: "knownAccessions" => array(string(SEC_ACCESSION_CHECKS), KNOWN_FILINGS),
					pending_filings: "pendingFilings" => array(EquityFilingMetadata::decode, PENDING_FILINGS),
					filed_since: "filedSince" => string(CALENDAR_DATE),
					full_check: "fullCheck" => boolean,
				})
				.map(Self::Sec),
				_ => decode_object!(cx, input, strict, ["provider"], EdinetSyncRequest {
					sec_code: "secCode" => string(EDINET_SECURITIES_CODE_CHECKS),
					edinet_code: "edinetCode" => nullable(string(EDINET_CODE_CHECKS)),
					known_filings: "knownFilings" => array(EdinetKnownFiling::decode, KNOWN_FILINGS),
					pending_filings: "pendingFilings" => array(EquityFilingMetadata::decode, PENDING_FILINGS),
					scan_days: "scanDays" => array(string(CALENDAR_DATE), SCAN_DAYS),
				})
				.map(Self::Edinet),
			},
		)
	}
}

/// The fields of a `financial-sync` claim besides the lease (`equitySyncClaimShape`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquitySyncClaim {
	/// Opaque company id.
	pub company_id: String,
	/// The listing's market.
	pub market: EquityMarket,
	/// Ticker (US) or JPX local code (JP).
	pub symbol: String,
	/// The concepts to extract (`equityConceptsOfProvider`).
	pub concepts: Vec<String>,
	/// The provider request.
	pub source: EquitySyncRequest,
}

/// The claim keys of a `financial-sync` job besides `kind` and the lease.
pub(crate) const CLAIM_KEYS: [&str; 5] = ["companyId", "market", "symbol", "concepts", "source"];

/// Decodes `equitySyncClaimShape`'s fields of a claimed job object.
pub(crate) fn decode_claim_fields(cx: &mut Cx, object: &Object) -> Option<EquitySyncClaim> {
	decode_fields!(cx, object, EquitySyncClaim {
		company_id: "companyId" => id,
		market: "market" => decode_enum::<EquityMarket>,
		symbol: "symbol" => string(SYMBOL),
		concepts: "concepts" => array(string(CONCEPT_CHECKS), CONCEPTS),
		source: "source" => EquitySyncRequest::decode,
	})
}

/// The claim's refinement: US companies sync from SEC, JP ones from EDINET.
pub(crate) fn claim_rules(cx: &mut Cx, claim: &EquitySyncClaim) {
	if claim.market.provider() != claim.source.provider() {
		cx.refine_failed(
			Some("source"),
			"US companies sync from SEC, JP companies from EDINET",
		);
	}
}

/* ---------- Completion ---------- */

/// `equityExtractedFactSchema` decoder (the type is the domain's).
pub fn decode_extracted_fact(cx: &mut Cx, input: Option<&Value>) -> Option<EquityExtractedFact> {
	let mark = cx.mark();
	let decoded = decode_object!(cx, input, strict, [], EquityExtractedFact {
		concept: "concept" => string(CONCEPT_CHECKS),
		unit: "unit" => string(UNIT),
		value_decimal: "valueDecimal" => string(VALUE_DECIMAL),
		period_type: "periodType" => decode_enum::<EquityPeriodType>,
		period_start: "periodStart" => nullable(string(CALENDAR_DATE)),
		period_end: "periodEnd" => string(CALENDAR_DATE),
		scope: "scope" => decode_enum::<EquityScope>,
	});
	refine(cx, mark, decoded.as_ref(), |cx, fact| {
		let consistent = match fact.period_type {
			EquityPeriodType::Instant => fact.period_start.is_none(),
			EquityPeriodType::Duration => fact
				.period_start
				.as_deref()
				.is_some_and(|start| start <= fact.period_end.as_str()),
		};
		if !consistent {
			cx.refine_failed(
				Some("periodStart"),
				"period dates must match the period type",
			);
		}
	});
	decoded
}

/// `equityFilingResultSchema`: one annual filing and its facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityFilingResult {
	/// Metadata, as the source states it (or the claim's, for a pending filing).
	#[serde(flatten)]
	pub metadata: EquityFilingMetadata,
	/// The standard its facts use, when they were read.
	pub accounting_standard: Option<EquityAccountingStandard>,
	/// Whether its facts were read.
	pub facts_status: EquityFactsStatus,
	/// Its annual facts (none unless extracted).
	pub facts: Vec<EquityExtractedFact>,
}

struct FilingRest {
	accounting_standard: Option<EquityAccountingStandard>,
	facts_status: EquityFactsStatus,
	facts: Vec<EquityExtractedFact>,
}

impl EquityFilingResult {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let object = object_input(cx, input)?;
		let metadata = decode_metadata_fields(cx, object);
		let rest = decode_fields!(cx, object, FilingRest {
			accounting_standard: "accountingStandard" => nullable(decode_enum::<EquityAccountingStandard>),
			facts_status: "factsStatus" => EquityFactsStatus::decode,
			facts: "facts" => array(decode_extracted_fact, FACTS),
		});
		let mut keys: Vec<&str> = METADATA_KEYS.to_vec();
		keys.extend(["accountingStandard", "factsStatus", "facts"]);
		unrecognized(cx, object, &keys);
		let (metadata, rest) = (metadata?, rest?);
		let decoded = Self {
			metadata,
			accounting_standard: rest.accounting_standard,
			facts_status: rest.facts_status,
			facts: rest.facts,
		};
		refine(cx, mark, Some(&decoded), |cx, filing| {
			if filing.facts_status != EquityFactsStatus::Extracted && !filing.facts.is_empty() {
				cx.refine_failed(
					Some("facts"),
					"a filing without extracted facts carries none",
				);
			}
		});
		Some(decoded)
	}
}

/// What the source says about the company (`identity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquitySyncIdentity {
	/// CIK (SEC) or EDINET code.
	pub source_company_id: String,
	/// SEC entity name / EDINET filer name.
	pub name: Option<String>,
	/// Fiscal year end, "MM-DD".
	pub fiscal_year_end: Option<String>,
}

fn source_company_id(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	let cik = |cx: &mut Cx, input: Option<&Value>| run_string(cx, input, SEC_CIK_CHECKS);
	let edinet = |cx: &mut Cx, input: Option<&Value>| run_string(cx, input, EDINET_CODE_CHECKS);
	let options: [UnionOption<'_, String>; 2] = [&cik, &edinet];
	run_union(cx, input, &options)
}

impl EquitySyncIdentity {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			source_company_id: "sourceCompanyId" => source_company_id,
			name: "name" => nullable(string(COMPANY_NAME)),
			fiscal_year_end: "fiscalYearEnd" => nullable(string(FISCAL_YEAR_END_CHECKS)),
		})
	}
}

/// `equitySyncCompletionProblem`: the first problem of a completion's
/// cross-field rules, or `None`.
#[must_use]
pub fn equity_sync_completion_problem(
	provider: EquityProvider,
	identity: Option<&EquitySyncIdentity>,
	scanned_days: &[String],
	filings: &[EquityFilingResult],
) -> Option<&'static str> {
	let sec = provider == EquityProvider::Sec;
	if sec && !scanned_days.is_empty() {
		return Some("an SEC sync scans no EDINET dates");
	}
	if let Some(identity) = identity {
		let ok = if sec {
			is_sec_cik(&identity.source_company_id)
		} else {
			is_edinet_code(&identity.source_company_id)
		};
		if !ok {
			return Some("identity does not match the provider");
		}
	}
	let mut ids: HashSet<&str> = HashSet::with_capacity(filings.len());
	let mut facts = 0usize;
	for filing in filings {
		let id = filing.metadata.source_document_id.as_str();
		if !ids.insert(id) {
			return Some("a filing appears twice");
		}
		let id_ok = if sec {
			is_sec_accession(id)
		} else {
			is_edinet_doc_id(id)
		};
		if !id_ok {
			return Some("a filing id does not match the provider");
		}
		let sec_form = matches!(
			filing.metadata.form,
			EquityReportForm::TenK | EquityReportForm::TenKA
		);
		if sec_form != sec {
			return Some("a filing form does not match the provider");
		}
		facts += filing.facts.len();
	}
	if facts > limits::MAX_FACTS_PER_COMPLETION {
		return Some("too many facts");
	}
	None
}

/// `scannedDays` decoder.
pub(crate) fn scanned_days(cx: &mut Cx, input: Option<&Value>) -> Option<Vec<String>> {
	array(string(CALENDAR_DATE), SCAN_DAYS)(cx, input)
}

/// `filings` decoder.
pub(crate) fn filings(cx: &mut Cx, input: Option<&Value>) -> Option<Vec<EquityFilingResult>> {
	array(EquityFilingResult::decode, FILINGS)(cx, input)
}

/// `provider` decoder.
pub(crate) fn provider(cx: &mut Cx, input: Option<&Value>) -> Option<EquityProvider> {
	decode_enum::<EquityProvider>(cx, input)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn patterns_match_like_the_regexes() {
		assert!(is_sec_accession("0000320193-24-000123"));
		assert!(!is_sec_accession("000032019-324-000123"));
		assert!(is_edinet_doc_id("S100TR7I"));
		assert!(!is_edinet_doc_id("S100tr7I"));
		assert!(is_sec_cik("0000320193"));
		assert!(is_edinet_code("E02367"));
		assert!(!is_edinet_code("E0236"));
		assert!((EDINET_SECURITIES_CODE.matches)("79740"));
		assert!(!(EDINET_SECURITIES_CODE.matches)("79741"));
		for good in ["01-01", "09-28", "12-31", "02-30"] {
			assert!(is_fiscal_year_end(good), "{good}");
		}
		for bad in ["00-01", "13-01", "01-32", "1-01", "01-00"] {
			assert!(!is_fiscal_year_end(bad), "{bad}");
		}
		for good in ["us-gaap:Revenues", "jppfs_cor:NetSales", "a:B", "x-1_y:Z_9"] {
			assert!(is_concept(good), "{good}");
		}
		for bad in [
			"Us-gaap:Revenues",
			"us-gaap:",
			":Revenues",
			"us-gaap:1Revenues",
			"a:b:c",
			"us gaap:X",
		] {
			assert!(!is_concept(bad), "{bad}");
		}
	}

	#[test]
	fn only_rate_limits_and_source_failures_are_retried() {
		let retryable: Vec<&str> = EquitySyncFailureCode::ALL
			.iter()
			.filter(|code| code.is_retryable())
			.map(|code| code.as_str())
			.collect();
		assert_eq!(
			retryable,
			["FINANCIAL_RATE_LIMITED", "FINANCIAL_SOURCE_FAILED"]
		);
	}
}
