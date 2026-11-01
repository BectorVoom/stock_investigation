//! One shared index of EDINET annual securities reports
//! (`packages/contracts/src/edinetIndex.ts`, ADR-0058 §4): the fields of the
//! `edinet-index` claim and of the `edinet-indexed` completion, their limits
//! and the completion's cross-field rule. Each day's document list is read
//! once for every company; a JP company's `financial-sync` then downloads
//! only the reports the index names for its securities code.

use std::collections::HashSet;

use research_js::json::{Object, Value};
use serde::Serialize;

use crate::equity_financials::{CALENDAR_DATE, EDINET_CODE, EDINET_DOC_ID, EDINET_SECURITIES_CODE};
use crate::primitives::ISO_DATE_TIME;
use crate::zod::{
	ArrCheck, Cx, StrCheck, array, decode_fields, decode_object, js_enum, nullable, string,
};

/// `EDINET_INDEX_LIMITS`.
pub mod limits {
	/// Days one job lists: 40 seconds at EDINET's 1 request a second.
	pub const MAX_DAYS_PER_JOB: usize = 40;
	/// The busiest June day lists ~1,500 annual reports; room above it.
	pub const MAX_DOCUMENTS_PER_DAY: usize = 4_000;
	/// Longest filer name (UTF-16 code units, as zod counts).
	pub const MAX_FILER_NAME_CHARS: usize = 200;
}

js_enum! {
	/// `edinetIndexDocTypeSchema`: the document types the index keeps.
	pub enum EdinetIndexDocType {
		/// 120: 有価証券報告書.
		SecuritiesReport = "120",
		/// 130: 訂正有価証券報告書.
		AmendedSecuritiesReport = "130",
	}
}

/// `edinetIndexDocumentSchema`: one annual report row of a day's list, as EDINET states it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetIndexDocument {
	/// Document id.
	pub doc_id: String,
	/// EDINET's five-character securities code (JPX code + "0").
	pub sec_code: String,
	/// Filer code.
	pub edinet_code: String,
	/// Filer name (1..=200).
	pub filer_name: String,
	/// 120 or 130.
	pub doc_type_code: EdinetIndexDocType,
	/// An amendment's (130) row states no period (spec §3-1-2-2 *3).
	pub period_start: Option<String>,
	/// The period end; required of an annual report (120) by the completion rule.
	pub period_end: Option<String>,
	/// `submitDateTime` in JST, as an ISO instant.
	pub submitted_at: String,
	/// The report an amendment amends (parentDocID).
	pub parent_doc_id: Option<String>,
}

const DOC_ID: &[StrCheck] = &[StrCheck::Regex(&EDINET_DOC_ID, None)];
const SEC_CODE: &[StrCheck] = &[StrCheck::Regex(&EDINET_SECURITIES_CODE, None)];
const EDINET_CODE_CHECKS: &[StrCheck] = &[StrCheck::Regex(&EDINET_CODE, None)];
const FILER_NAME: &[StrCheck] = &[
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_FILER_NAME_CHARS),
];
const DAYS: &[ArrCheck] = &[ArrCheck::Min(1), ArrCheck::Max(limits::MAX_DAYS_PER_JOB)];
const COMPLETION_DAYS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_DAYS_PER_JOB)];
const DOCUMENTS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_DOCUMENTS_PER_DAY)];

impl EdinetIndexDocument {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			doc_id: "docId" => string(DOC_ID),
			sec_code: "secCode" => string(SEC_CODE),
			edinet_code: "edinetCode" => string(EDINET_CODE_CHECKS),
			filer_name: "filerName" => string(FILER_NAME),
			doc_type_code: "docTypeCode" => EdinetIndexDocType::decode,
			period_start: "periodStart" => nullable(string(CALENDAR_DATE)),
			period_end: "periodEnd" => nullable(string(CALENDAR_DATE)),
			submitted_at: "submittedAt" => string(ISO_DATE_TIME),
			parent_doc_id: "parentDocId" => nullable(string(DOC_ID)),
		})
	}
}

/// The fields of an `edinet-index` claimed job besides the lease (`edinetIndexClaimShape`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdinetIndexClaim {
	/// Newest first, distinct weekdays, each before today in JST (1..=40).
	pub days: Vec<String>,
}

/// The claim's keys besides `kind` and the lease.
pub(crate) const CLAIM_KEYS: [&str; 1] = ["days"];

/// Decodes the claim's fields of an object already known to be one.
pub(crate) fn decode_claim_fields(cx: &mut Cx, object: &Object) -> Option<EdinetIndexClaim> {
	decode_fields!(cx, object, EdinetIndexClaim {
		days: "days" => array(string(CALENDAR_DATE), DAYS),
	})
}

/// `edinetIndexDayResultSchema`: one day listed in full.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdinetIndexDayResult {
	/// The listed day.
	pub date: String,
	/// Its annual reports (≤ 4,000).
	pub documents: Vec<EdinetIndexDocument>,
}

impl EdinetIndexDayResult {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			date: "date" => string(CALENDAR_DATE),
			documents: "documents" => array(EdinetIndexDocument::decode, DOCUMENTS),
		})
	}
}

/// `edinetIndexCompletionShape.days`.
pub(crate) fn completion_days(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Vec<EdinetIndexDayResult>> {
	array(EdinetIndexDayResult::decode, COMPLETION_DAYS)(cx, input)
}

/// `edinetIndexCompletionShape.fetchedAt`.
pub(crate) fn fetched_at(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	string(ISO_DATE_TIME)(cx, input)
}

/// `edinetIndexCompletionProblem`: the first problem of a completion's
/// cross-field rules, or `None`.
#[must_use]
pub fn edinet_index_completion_problem(days: &[EdinetIndexDayResult]) -> Option<String> {
	let mut dates: HashSet<&str> = HashSet::with_capacity(days.len());
	for day in days {
		if !dates.insert(day.date.as_str()) {
			return Some(format!("day {} is reported twice", day.date));
		}
		let mut doc_ids: HashSet<&str> = HashSet::with_capacity(day.documents.len());
		for document in &day.documents {
			if !doc_ids.insert(document.doc_id.as_str()) {
				return Some(format!("document {} is listed twice", document.doc_id));
			}
			if document.doc_type_code == EdinetIndexDocType::SecuritiesReport
				&& document.period_end.is_none()
			{
				return Some(format!(
					"annual report {} states no period end",
					document.doc_id
				));
			}
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	fn document(
		doc_id: &str,
		doc_type_code: EdinetIndexDocType,
		period_end: Option<&str>,
	) -> EdinetIndexDocument {
		EdinetIndexDocument {
			doc_id: doc_id.to_owned(),
			sec_code: "99990".to_owned(),
			edinet_code: "E99991".to_owned(),
			filer_name: "名".to_owned(),
			doc_type_code,
			period_start: None,
			period_end: period_end.map(str::to_owned),
			submitted_at: "2025-06-20T15:00:00+09:00".to_owned(),
			parent_doc_id: None,
		}
	}

	#[test]
	fn the_completion_rule_matches_the_typescript_messages() {
		let day = |date: &str, documents| EdinetIndexDayResult {
			date: date.to_owned(),
			documents,
		};
		let report = document(
			"S100AAAA",
			EdinetIndexDocType::SecuritiesReport,
			Some("2025-03-31"),
		);
		let amendment = document(
			"S100AAAB",
			EdinetIndexDocType::AmendedSecuritiesReport,
			None,
		);
		assert_eq!(
			edinet_index_completion_problem(&[day("2025-06-20", vec![report.clone(), amendment])]),
			None
		);
		assert_eq!(
			edinet_index_completion_problem(&[
				day("2025-06-20", vec![]),
				day("2025-06-20", vec![])
			]),
			Some("day 2025-06-20 is reported twice".to_owned())
		);
		assert_eq!(
			edinet_index_completion_problem(&[day("2025-06-20", vec![report.clone(), report])]),
			Some("document S100AAAA is listed twice".to_owned())
		);
		assert_eq!(
			edinet_index_completion_problem(&[day(
				"2025-06-20",
				vec![document(
					"S100AAAC",
					EdinetIndexDocType::SecuritiesReport,
					None
				)]
			)]),
			Some("annual report S100AAAC states no period end".to_owned())
		);
	}
}
