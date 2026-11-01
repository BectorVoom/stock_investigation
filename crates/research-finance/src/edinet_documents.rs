//! EDINET API v2 document lists and the download plan (port of
//! `packages/adapters/src/finance/edinetDocuments.ts`, ADR-0048 §6,
//! ADR-0058 §4), pure.
//!
//! EDINET has no per-company search: `GET /api/v2/documents.json?date=…&type=2`
//! lists every document submitted on one date. The shared `edinet-index` job
//! (`edinet_index.rs`) lists each date once for every company and keeps the
//! annual reports — docTypeCode 120 (有価証券報告書) and 130 (訂正有価証券報告書)
//! — that are not withdrawn; a company's `financial-sync` then downloads the
//! reports the index names for its securities code (`edinet_download_plan`).

use std::collections::HashSet;

use research_contracts::equity_financials::{
	EdinetKnownFiling, EquityFilingMetadata, EquityReportForm, EquitySyncIdentity, is_edinet_code,
	is_edinet_doc_id,
};
use research_domain::finance::financial_statements::iso_day_number;
use research_js::json::{Object, Value};
use research_js::uri::encode_uri_component;
use research_js::whitespace::trim;
use serde::{Deserialize, Serialize};

/// The EDINET API host.
pub const EDINET_API_HOST: &str = "api.edinet-fsa.go.jp";
/// The EDINET viewer host (a link only; the runner never fetches it).
pub const EDINET_VIEWER_HOST: &str = "disclosure2.edinet-fsa.go.jp";

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

/// The annual-report document types the index keeps (`docTypeCode`).
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

/// One not-withdrawn annual-report row of a date's list, with the fields the
/// index uses (`EdinetAnnualRow`).
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
	/// `csvFlag` "1": the XBRL-to-CSV download exists (the index keeps only those).
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
pub(crate) fn split_submit(text: &str) -> Option<(&str, &str, &str)> {
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

/// `edinetIdentity` (ADR-0058 §4): the claim's filer code (the API takes
/// it from the index), no name (the index stores the filer's name; `None`
/// keeps the stored one), and the month-day of the period end of the first
/// original report (120) among `filings` as the fiscal year end; `None`
/// without a filer code.
#[must_use]
pub fn edinet_identity<'a>(
	claim_edinet_code: Option<&str>,
	filings: impl IntoIterator<Item = &'a EquityFilingMetadata>,
) -> Option<EquitySyncIdentity> {
	let code = claim_edinet_code?;
	let fiscal_year_end = filings
		.into_iter()
		.find(|filing| filing.form == EquityReportForm::SecuritiesReport)
		.and_then(|filing| filing.period_end.get(5..))
		.map(str::to_owned);
	Some(EquitySyncIdentity {
		source_company_id: code.to_owned(),
		name: None,
		fiscal_year_end,
	})
}

/// What the job does with one document (`EdinetDocumentAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EdinetDocumentAction {
	/// Download its XBRL-to-CSV.
	Download,
	/// Over the download cap: left for the next job.
	Deferred,
}

impl EdinetDocumentAction {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Download => "download",
			Self::Deferred => "deferred",
		}
	}
}

/// `EdinetPlannedDocument`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetPlannedDocument {
	/// The claim's metadata, echoed back unchanged.
	pub metadata: EquityFilingMetadata,
	/// What the job does with it.
	pub action: EdinetDocumentAction,
}

/// `edinetDownloadPlan`'s input.
pub struct EdinetPlanInput<'a> {
	/// The claim's pending filings, in claim order.
	pub pending: &'a [EquityFilingMetadata],
	/// The reports the index names (`indexedFilings`), in claim order.
	pub indexed: &'a [EquityFilingMetadata],
	/// The filings the claim stores (not pending), with their periods.
	pub known_filings: &'a [EdinetKnownFiling],
	/// Downloads allowed in this job.
	pub max_downloads: usize,
}

/// `edinetDownloadPlan` (ADR-0058 §4): the pending filings first in claim
/// order, then the reports the index names (oldest first as the API sends
/// them), each document once; a document the claim already stores
/// (`known_filings`) is left out. The first `max_downloads` are downloaded,
/// the rest deferred to the next job. Every document has its period: an
/// amendment's (130) was taken from its original by the API.
#[must_use]
pub fn edinet_download_plan(input: &EdinetPlanInput<'_>) -> Vec<EdinetPlannedDocument> {
	let known: HashSet<&str> = input
		.known_filings
		.iter()
		.map(|filing| filing.doc_id.as_str())
		.collect();
	let mut seen: HashSet<&str> = HashSet::new();
	let mut planned = Vec::with_capacity(input.pending.len() + input.indexed.len());
	let pending = input.pending.iter().map(|filing| (filing, false));
	let indexed = input.indexed.iter().map(|filing| (filing, true));
	for (metadata, skip_known) in pending.chain(indexed) {
		let doc_id = metadata.source_document_id.as_str();
		if seen.contains(doc_id) || (skip_known && known.contains(doc_id)) {
			continue;
		}
		seen.insert(doc_id);
		let action = if planned.len() < input.max_downloads {
			EdinetDocumentAction::Download
		} else {
			EdinetDocumentAction::Deferred
		};
		planned.push(EdinetPlannedDocument {
			metadata: metadata.clone(),
			action,
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
