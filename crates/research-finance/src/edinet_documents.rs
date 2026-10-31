//! EDINET API v2 document lists (port of
//! `packages/adapters/src/finance/edinetDocuments.ts`, ADR-0048 §6), pure.
//!
//! EDINET has no per-company search: `GET /api/v2/documents.json?date=…&type=2`
//! lists every document submitted on one date. A sync keeps the annual
//! reports — docTypeCode 120 (有価証券報告書) and 130 (訂正有価証券報告書) — that
//! are not withdrawn, then the rows whose securities code is the company's.
//! The annual rows of a date are what the runner caches for 24 hours, so the
//! companies synced one after another share the listing requests.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use research_contracts::equity_financials::{
	EdinetKnownFiling, EquityFilingMetadata, EquityReportForm, EquitySyncIdentity, is_edinet_code,
	is_edinet_doc_id,
};
use research_domain::finance::financial_statements::iso_day_number;
use research_js::json::{Object, Value};
use research_js::uri::encode_uri_component;
use research_js::utf16::utf16_len;
use research_js::whitespace::trim;
use serde::{Deserialize, Serialize};

/// The EDINET API host.
pub const EDINET_API_HOST: &str = "api.edinet-fsa.go.jp";
/// The EDINET viewer host (a link only; the runner never fetches it).
pub const EDINET_VIEWER_HOST: &str = "disclosure2.edinet-fsa.go.jp";

const MAX_NAME_CHARS: usize = 200;

/// `edinetDocumentListUrl`. The subscription key travels as a query
/// parameter (EDINET API v2 has no header form), so this URL is a secret:
/// never logged, stored or shown.
#[must_use]
pub fn edinet_document_list_url(date: &str, api_key: &str) -> String {
	format!(
		"https://{EDINET_API_HOST}/api/v2/documents.json?date={date}&type=2&Subscription-Key={}",
		encode_uri_component(api_key)
	)
}

/// `edinetDocumentUrl` (a secret like the list URL).
#[must_use]
pub fn edinet_document_url(doc_id: &str, api_key: &str) -> String {
	format!(
		"https://{EDINET_API_HOST}/api/v2/documents/{doc_id}?type=5&Subscription-Key={}",
		encode_uri_component(api_key)
	)
}

/// `edinetViewerUrl`: the filing's public page in the EDINET viewer.
#[must_use]
pub fn edinet_viewer_url(doc_id: &str) -> String {
	format!("https://{EDINET_VIEWER_HOST}/WZEK0040.aspx?{doc_id}")
}

/// The annual-report document types a sync keeps (`docTypeCode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdinetDocType {
	/// 120: 有価証券報告書.
	#[serde(rename = "120")]
	SecuritiesReport,
	/// 130: 訂正有価証券報告書.
	#[serde(rename = "130")]
	AmendedSecuritiesReport,
}

impl EdinetDocType {
	/// `EDINET_ANNUAL_FORMS`: the report form of the document type.
	#[must_use]
	pub const fn form(self) -> EquityReportForm {
		match self {
			Self::SecuritiesReport => EquityReportForm::SecuritiesReport,
			Self::AmendedSecuritiesReport => EquityReportForm::AmendedSecuritiesReport,
		}
	}
}

/// One not-withdrawn annual-report row of a date's list (`EdinetAnnualRow`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetAnnualRow {
	/// Document id.
	pub doc_id: String,
	/// Filer code.
	pub edinet_code: String,
	/// Securities code (JPX code + "0"), when the filer is listed.
	pub sec_code: Option<String>,
	/// Trimmed filer name, `None` when blank.
	pub filer_name: Option<String>,
	/// 120 (original) or 130 (amendment).
	pub doc_type_code: EdinetDocType,
	/// Period start, when a valid date.
	pub period_start: Option<String>,
	/// Period end, when a valid date.
	pub period_end: Option<String>,
	/// "YYYY-MM-DD HH:MM", Japan time.
	pub submit_date_time: String,
	/// The amended document, when a valid document id.
	pub parent_doc_id: Option<String>,
	/// `csvFlag` "1": the XBRL-to-CSV download exists.
	pub csv_available: bool,
}

/// Why a date's list is not usable (`EdinetListProblem`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdinetListProblem {
	/// `metadata.status` other than "200", with its number when it is one.
	Status(Option<u16>),
	/// Not the documented shape.
	Parse,
}

/// `SUBMIT_DATE_TIME`: `^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$`
/// with a valid date: (date, hour, minute).
fn split_submit(text: &str) -> Option<(&str, &str, &str)> {
	let bytes = text.as_bytes();
	if bytes.len() != 16 || bytes.get(10) != Some(&b' ') || bytes.get(13) != Some(&b':') {
		return None;
	}
	let date = text.get(..10)?;
	let hour = text.get(11..13)?;
	let minute = text.get(14..16)?;
	let date_shape = date.bytes().enumerate().all(|(at, byte)| {
		if at == 4 || at == 7 {
			byte == b'-'
		} else {
			byte.is_ascii_digit()
		}
	});
	let hour_ok = matches!(
		hour.as_bytes(),
		[b'0' | b'1', b'0'..=b'9'] | [b'2', b'0'..=b'3']
	);
	let minute_ok = matches!(minute.as_bytes(), [b'0'..=b'5', b'0'..=b'9']);
	(date_shape && hour_ok && minute_ok).then_some((date, hour, minute))
}

/// `statusOfText`: `^[1-5]\d{2}$` as a number.
fn status_of_text(text: &str) -> Option<u16> {
	match text.as_bytes() {
		[b'1'..=b'5', b'0'..=b'9', b'0'..=b'9'] => text.parse().ok(),
		_ => None,
	}
}

/// `z.string().nullable().optional()`: `Ok(None)` for absent or null.
fn nullable_text<'a>(object: &'a Object, key: &str) -> Result<Option<&'a str>, ()> {
	match object.get(key) {
		None | Some(Value::Null) => Ok(None),
		Some(Value::String(text)) => Ok(Some(text)),
		Some(_) => Err(()),
	}
}

/// `z.number().int().optional()` of an error body: `Err` for a non-integer.
fn optional_int(object: &Object, key: &str) -> Result<Option<f64>, ()> {
	match object.get(key) {
		None => Ok(None),
		Some(Value::Number(number))
			if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 =>
		{
			Ok(Some(*number))
		}
		Some(_) => Err(()),
	}
}

/// `edinetErrorStatus`: the status an EDINET error body states —
/// `metadata.status` (API v2 error JSON) or `StatusCode` / `statusCode`
/// (the gateway's 401 answer); `None` when the body states none.
#[must_use]
pub fn edinet_error_status(value: &Value) -> Option<u16> {
	let object = value.as_object()?;
	let metadata = match object.get("metadata") {
		None => None,
		Some(metadata) => Some(metadata.as_object()?.get("status")?.as_str()?),
	};
	let upper = optional_int(object, "StatusCode").ok()?;
	let lower = optional_int(object, "statusCode").ok()?;
	if let Some(status) = metadata.and_then(status_of_text) {
		return Some(status);
	}
	let code = upper.or(lower)?;
	(100.0..=599.0)
		.contains(&code)
		.then(|| format!("{code:.0}").parse().ok())
		.flatten()
}

fn valid_date_or_none(text: Option<&str>) -> Option<String> {
	text.filter(|text| iso_day_number(text).is_some())
		.map(str::to_owned)
}

/// One row of `results`, or `None` when it is not an annual, not-withdrawn,
/// well-formed row.
fn annual_row(raw: &Value) -> Option<EdinetAnnualRow> {
	let object = raw.as_object()?;
	let mut fields = [None; 11];
	for (slot, key) in fields.iter_mut().zip([
		"docID",
		"edinetCode",
		"secCode",
		"filerName",
		"docTypeCode",
		"periodStart",
		"periodEnd",
		"submitDateTime",
		"parentDocID",
		"withdrawalStatus",
		"csvFlag",
	]) {
		*slot = nullable_text(object, key).ok()?;
	}
	let [
		doc_id,
		edinet_code,
		sec_code,
		filer_name,
		doc_type,
		period_start,
		period_end,
		submit,
		parent,
		withdrawal,
		csv_flag,
	] = fields;
	let doc_type_code = match doc_type {
		Some("120") => EdinetDocType::SecuritiesReport,
		Some("130") => EdinetDocType::AmendedSecuritiesReport,
		_ => return None,
	};
	if withdrawal != Some("0") {
		return None;
	}
	let doc_id = doc_id.unwrap_or("");
	let edinet_code = edinet_code.unwrap_or("");
	let submit_text = submit.unwrap_or("");
	let (date, _, _) = split_submit(submit_text)?;
	if !is_edinet_doc_id(doc_id) || !is_edinet_code(edinet_code) || iso_day_number(date).is_none() {
		return None;
	}
	let filer_name = trim(filer_name.unwrap_or(""));
	Some(EdinetAnnualRow {
		doc_id: doc_id.to_owned(),
		edinet_code: edinet_code.to_owned(),
		sec_code: sec_code.map(str::to_owned),
		filer_name: (!filer_name.is_empty()).then(|| filer_name.to_owned()),
		doc_type_code,
		period_start: valid_date_or_none(period_start),
		period_end: valid_date_or_none(period_end),
		submit_date_time: submit_text.to_owned(),
		parent_doc_id: parent
			.filter(|parent| is_edinet_doc_id(parent))
			.map(str::to_owned),
		csv_available: csv_flag == Some("1"),
	})
}

/// `parseEdinetDocumentList`: a date's list as its annual rows (120/130, not
/// withdrawn, with a valid document id, filer code and submission time), in
/// EDINET's order. Other rows are dropped.
///
/// # Errors
/// [`EdinetListProblem::Status`] for an error status, [`EdinetListProblem::Parse`]
/// for anything that is not the documented shape.
pub fn parse_edinet_document_list(
	value: &Value,
) -> Result<Vec<EdinetAnnualRow>, EdinetListProblem> {
	list_rows(value).map_err(|problem| match problem {
		// A body without the list's shape that states an error status is that
		// status: the gateway answers an invalid key or too many requests with
		// HTTP 200 and `{"StatusCode":401|429,…}` without `metadata` (spec
		// §3-3), which must read as access denied / rate limited with EDINET's
		// status, not as a malformed list.
		EdinetListProblem::Parse => match edinet_error_status(value) {
			Some(status) if status >= 400 => EdinetListProblem::Status(Some(status)),
			_ => EdinetListProblem::Parse,
		},
		status @ EdinetListProblem::Status(_) => status,
	})
}

/// The list's documented shape (`listSchema`) and its annual rows.
fn list_rows(value: &Value) -> Result<Vec<EdinetAnnualRow>, EdinetListProblem> {
	let object = value.as_object().ok_or(EdinetListProblem::Parse)?;
	let status = object
		.get("metadata")
		.and_then(Value::as_object)
		.and_then(|metadata| metadata.get("status"))
		.and_then(Value::as_str)
		.ok_or(EdinetListProblem::Parse)?;
	// `results` is `z.array(z.unknown()).optional()`: present but not an array fails the shape.
	let results = match object.get("results") {
		None => None,
		Some(results) => Some(results.as_array().ok_or(EdinetListProblem::Parse)?),
	};
	if status != "200" {
		return Err(EdinetListProblem::Status(status_of_text(status)));
	}
	let results = results.ok_or(EdinetListProblem::Parse)?;
	Ok(results.iter().filter_map(annual_row).collect())
}

/// `edinetFilingMetadata`: the filing metadata of a row (ADR-0048 §6), or
/// `None` without a period end.
#[must_use]
pub fn edinet_filing_metadata(row: &EdinetAnnualRow) -> Option<EquityFilingMetadata> {
	document_metadata(row)?.complete()
}

/// `EdinetDocumentMetadata`: a document's filing metadata while its period
/// end may still be unknown. An amendment (130) row carries no period (spec
/// §3-1-2-2 *3: the period is output only for 有価証券報告書 and 半期報告書),
/// so its period comes from the amended original or the downloaded report's
/// DEI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetDocumentMetadata {
	/// Document id.
	pub source_document_id: String,
	/// The report form.
	pub form: EquityReportForm,
	/// Submission date (Japan).
	pub filed_on: String,
	/// Submission instant (+09:00).
	pub submitted_at: Option<String>,
	/// The fiscal period start, when known.
	pub period_start: Option<String>,
	/// The fiscal period end, when known.
	pub period_end: Option<String>,
	/// The filing it amends (parentDocID).
	pub amends_source_document_id: Option<String>,
	/// The filing's viewer page.
	pub source_url: String,
}

impl EdinetDocumentMetadata {
	/// The complete metadata with this period.
	#[must_use]
	pub fn with_period(
		self,
		period_start: Option<String>,
		period_end: String,
	) -> EquityFilingMetadata {
		EquityFilingMetadata {
			source_document_id: self.source_document_id,
			form: self.form,
			filed_on: self.filed_on,
			submitted_at: self.submitted_at,
			period_start,
			period_end,
			amends_source_document_id: self.amends_source_document_id,
			source_url: self.source_url,
		}
	}

	/// The complete metadata, when the period end is known.
	#[must_use]
	pub fn complete(self) -> Option<EquityFilingMetadata> {
		let period_end = self.period_end.clone()?;
		let period_start = self.period_start.clone();
		Some(self.with_period(period_start, period_end))
	}
}

impl From<EquityFilingMetadata> for EdinetDocumentMetadata {
	fn from(metadata: EquityFilingMetadata) -> Self {
		Self {
			source_document_id: metadata.source_document_id,
			form: metadata.form,
			filed_on: metadata.filed_on,
			submitted_at: metadata.submitted_at,
			period_start: metadata.period_start,
			period_end: Some(metadata.period_end),
			amends_source_document_id: metadata.amends_source_document_id,
			source_url: metadata.source_url,
		}
	}
}

/// The metadata of a row with the list's period (`None` when it states none).
fn document_metadata(row: &EdinetAnnualRow) -> Option<EdinetDocumentMetadata> {
	let (date, hour, minute) = split_submit(&row.submit_date_time)?;
	Some(EdinetDocumentMetadata {
		source_document_id: row.doc_id.clone(),
		form: row.doc_type_code.form(),
		filed_on: date.to_owned(),
		submitted_at: Some(format!("{date}T{hour}:{minute}:00+09:00")),
		period_start: row.period_start.clone(),
		period_end: row.period_end.clone(),
		amends_source_document_id: row.parent_doc_id.clone(),
		source_url: edinet_viewer_url(&row.doc_id),
	})
}

/// `edinetIdentity`: the first matching row's filer code and name, and the
/// month-day of the first original report's period end; else the claim's
/// filer code with nothing else known; else `None` (no report found yet).
#[must_use]
pub fn edinet_identity<'a>(
	matched: impl IntoIterator<Item = &'a EdinetAnnualRow> + Clone,
	claim_edinet_code: Option<&str>,
) -> Option<EquitySyncIdentity> {
	let Some(first) = matched.clone().into_iter().next() else {
		return claim_edinet_code.map(|code| EquitySyncIdentity {
			source_company_id: code.to_owned(),
			name: None,
			fiscal_year_end: None,
		});
	};
	let fiscal_year_end = matched
		.into_iter()
		.find(|row| {
			row.doc_type_code == EdinetDocType::SecuritiesReport && row.period_end.is_some()
		})
		.and_then(|row| row.period_end.as_deref())
		.and_then(|end| end.get(5..))
		.map(str::to_owned);
	Some(EquitySyncIdentity {
		source_company_id: first.edinet_code.clone(),
		name: first
			.filer_name
			.clone()
			.filter(|name| utf16_len(name) <= MAX_NAME_CHARS),
		fiscal_year_end,
	})
}

/// What the job does with one document (`EdinetDocumentAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EdinetDocumentAction {
	/// Download its XBRL-to-CSV.
	Download,
	/// No CSV: not available without a request.
	NotAvailable,
	/// Over the download cap: left for the next job.
	Deferred,
}

impl EdinetDocumentAction {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Download => "download",
			Self::NotAvailable => "not-available",
			Self::Deferred => "deferred",
		}
	}
}

/// `EdinetPlannedDocument`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetPlannedDocument {
	/// The claim's metadata for a pending filing, else the row's; the period
	/// end is `None` only for an amendment whose period neither the list nor
	/// its original states (then the downloaded report's DEI decides).
	pub metadata: EdinetDocumentMetadata,
	/// What the job does with it.
	pub action: EdinetDocumentAction,
	/// The scan date that listed it; `None` for a pending filing this scan did not list.
	pub listed_on: Option<String>,
}

/// A matching row with the date whose list carried it (`EdinetListedRow`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetListedRow {
	/// The row.
	pub row: EdinetAnnualRow,
	/// The scan date.
	pub listed_on: String,
}

/// `edinetDownloadPlan`'s input.
pub struct EdinetPlanInput<'a> {
	/// The claim's pending filings, in claim order.
	pub pending: &'a [EquityFilingMetadata],
	/// Matching rows found by the scan, in scan order.
	pub found: &'a [EdinetListedRow],
	/// The filings the claim stores (not pending), with their periods.
	pub known_filings: &'a [EdinetKnownFiling],
	/// Downloads allowed in this job.
	pub max_downloads: usize,
}

/// `edinetDownloadPlan` (ADR-0048 §6): pending filings first in claim order
/// (with their stored metadata), then the new documents found by the scan,
/// oldest submission first. A document without CSV is not available without
/// a request; the others are downloaded up to `max_downloads` and the rest
/// deferred. Documents the claim already stores are left out.
///
/// A new row without a period end: an amendment (130) takes its original's
/// period — an amendment restates the same fiscal year — from the original
/// (`parentDocID`) as a row of this scan with a period, else as a pending or
/// known filing of the claim (their stored periods). Otherwise it is still
/// downloaded (its report's DEI states the period) when it has a CSV, and
/// left out when it has none (no period could be stated without guessing).
/// A 120 row without a period end is left out.
#[must_use]
pub fn edinet_download_plan(input: &EdinetPlanInput<'_>) -> Vec<EdinetPlannedDocument> {
	let mut by_doc_id: IndexMap<&str, &EdinetListedRow> = IndexMap::new();
	for listed in input.found {
		by_doc_id
			.entry(listed.row.doc_id.as_str())
			.or_insert(listed);
	}
	let known: HashSet<&str> = input
		.known_filings
		.iter()
		.map(|filing| filing.doc_id.as_str())
		.collect();
	// An original's period: the scan's rows first, then the claim's stored filings (first wins).
	let mut periods: HashMap<&str, (Option<&str>, &str)> = HashMap::new();
	for listed in by_doc_id.values() {
		let row = &listed.row;
		if let Some(end) = row.period_end.as_deref() {
			periods
				.entry(row.doc_id.as_str())
				.or_insert((row.period_start.as_deref(), end));
		}
	}
	for pending in input.pending {
		periods
			.entry(pending.source_document_id.as_str())
			.or_insert((pending.period_start.as_deref(), pending.period_end.as_str()));
	}
	for filing in input.known_filings {
		periods
			.entry(filing.doc_id.as_str())
			.or_insert((filing.period_start.as_deref(), filing.period_end.as_str()));
	}
	let mut planned = Vec::new();
	let mut seen: HashSet<&str> = HashSet::new();
	let mut downloads = 0usize;
	let mut decide = |csv_available: bool| {
		if !csv_available {
			EdinetDocumentAction::NotAvailable
		} else if downloads >= input.max_downloads {
			EdinetDocumentAction::Deferred
		} else {
			downloads += 1;
			EdinetDocumentAction::Download
		}
	};
	for pending in input.pending {
		if !seen.insert(pending.source_document_id.as_str()) {
			continue;
		}
		let listed = by_doc_id.get(pending.source_document_id.as_str());
		planned.push(EdinetPlannedDocument {
			metadata: EdinetDocumentMetadata::from(pending.clone()),
			// Unknown CSV status (not listed in this scan): try the download.
			action: decide(listed.is_none_or(|listed| listed.row.csv_available)),
			listed_on: listed.map(|listed| listed.listed_on.clone()),
		});
	}
	let mut fresh: Vec<&EdinetListedRow> = by_doc_id
		.values()
		.copied()
		.filter(|listed| {
			!seen.contains(listed.row.doc_id.as_str())
				&& !known.contains(listed.row.doc_id.as_str())
		})
		.collect();
	fresh.sort_by(|a, b| {
		a.row
			.submit_date_time
			.cmp(&b.row.submit_date_time)
			.then_with(|| a.row.doc_id.cmp(&b.row.doc_id))
	});
	for listed in fresh {
		let row = &listed.row;
		let Some(mut metadata) = document_metadata(row) else {
			continue;
		};
		if metadata.period_end.is_none() {
			if row.doc_type_code != EdinetDocType::AmendedSecuritiesReport {
				continue;
			}
			match row
				.parent_doc_id
				.as_deref()
				.and_then(|parent| periods.get(parent))
			{
				Some((start, end)) => {
					metadata.period_start = start.map(str::to_owned);
					metadata.period_end = Some((*end).to_owned());
				}
				None if !row.csv_available => continue,
				None => {}
			}
		}
		planned.push(EdinetPlannedDocument {
			metadata,
			action: decide(row.csv_available),
			listed_on: Some(listed.listed_on.clone()),
		});
	}
	planned
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_key_is_encoded_and_the_viewer_url_carries_none() {
		assert_eq!(
			edinet_document_list_url("2025-06-27", "a b&c"),
			"https://api.edinet-fsa.go.jp/api/v2/documents.json?date=2025-06-27&type=2&Subscription-Key=a%20b%26c"
		);
		assert_eq!(
			edinet_viewer_url("S100TR7I"),
			"https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100TR7I"
		);
	}

	#[test]
	fn submit_times_and_statuses() {
		assert_eq!(
			split_submit("2025-06-27 15:00"),
			Some(("2025-06-27", "15", "00"))
		);
		assert_eq!(split_submit("2025-06-27 24:00"), None);
		assert_eq!(split_submit("2025-06-27T15:00"), None);
		assert_eq!(status_of_text("404"), Some(404));
		assert_eq!(status_of_text("200 "), None);
		let body =
			research_js::json::parse(r#"{"StatusCode":401,"message":"x"}"#).unwrap_or_default();
		assert_eq!(edinet_error_status(&body), Some(401));
		let body = research_js::json::parse(r#"{"metadata":{"status":"404"}}"#).unwrap_or_default();
		assert_eq!(edinet_error_status(&body), Some(404));
	}
}
