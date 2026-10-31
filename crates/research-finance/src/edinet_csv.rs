//! EDINET XBRL-to-CSV reports (port of
//! `packages/adapters/src/finance/edinetCsv.ts`, ADR-0048 §4, §6), pure.
//!
//! `GET /api/v2/documents/{docID}?type=5` answers a ZIP whose entries under
//! `XBRL_TO_CSV/` are CSV renderings of the filing's XBRL; the main report is
//! the entry whose file name starts with `jpcrp` (the `jpaud…` audit reports
//! are ignored). Each CSV is UTF-16 LE with a byte-order mark, tab-separated,
//! every field double-quoted (a text block value may span lines and hold
//! tabs and doubled quotes), lines ending CRLF or LF, with the header
//!   "要素ID" "項目名" "コンテキストID" "相対年度" "連結・個別" "期間・時点"
//!   "ユニットID" "単位" "値"
//! A fact is taken only from the contexts CurrentYearDuration,
//! Prior1YearDuration, CurrentYearInstant and Prior1YearInstant —
//! consolidated, or separate with the `_NonConsolidatedMember` suffix — with
//! its dates from the report's DEI elements; every segment or other
//! dimensional context is skipped.

use std::borrow::Cow;
use std::collections::HashSet;

use research_contracts::equity_financials::{
	EquityAccountingStandard, EquityExtractedFact, EquityPeriodType, EquityScope,
};
use research_domain::finance::financial_statements::{is_canonical_decimal, iso_day_number};
use research_js::utf16::utf16_len;
use serde::Serialize;

use crate::equity_sync::annual_facts_in_order;
use crate::zip_reader::{ZipLimits, list_zip_entries, read_zip_entries_within};

/// `EDINET_ZIP_LIMITS`: the download (16 MB) and one CSV entry inflated (64 MB).
pub const EDINET_ZIP_LIMITS: ZipLimits = ZipLimits {
	max_archive_bytes: 16_000_000,
	max_entry_bytes: 64_000_000,
};

/// `EDINET_CSV_HEADER`.
pub const EDINET_CSV_HEADER: [&str; 9] = [
	"要素ID",
	"項目名",
	"コンテキストID",
	"相対年度",
	"連結・個別",
	"期間・時点",
	"ユニットID",
	"単位",
	"値",
];

const CSV_DIRECTORY: &str = "XBRL_TO_CSV/";
const REPORT_PREFIX: &str = "jpcrp";
const MAX_UNIT_CHARS: usize = 40;

/* ---------- Text ---------- */

/// The bytes are not UTF-16 LE text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("ENCODING")]
pub struct EncodingError;

/// `decodeUtf16Le`: a leading byte-order mark (FF FE) is dropped; an odd
/// byte count or an unpaired surrogate fails rather than being replaced.
///
/// # Errors
/// [`EncodingError`] for an odd byte count or an unpaired surrogate.
pub fn decode_utf16_le(bytes: &[u8]) -> Result<String, EncodingError> {
	let body = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
	let units = body.chunks_exact(2);
	if !units.remainder().is_empty() {
		return Err(EncodingError);
	}
	let mut text = String::with_capacity(body.len() + body.len() / 2);
	let code_units = units.map(|pair| match pair {
		[low, high] => u16::from_le_bytes([*low, *high]),
		_ => 0xFFFF,
	});
	for decoded in char::decode_utf16(code_units) {
		text.push(decoded.map_err(|_| EncodingError)?);
	}
	Ok(text)
}

/// Appends `piece` to a field without copying while the field is one slice.
fn append<'a>(field: &mut Cow<'a, str>, piece: &'a str) {
	if piece.is_empty() {
		return;
	}
	if field.is_empty() {
		*field = Cow::Borrowed(piece);
	} else {
		field.to_mut().push_str(piece);
	}
}

/// Ends the row being built; false when `visit` asked to stop. A blank line
/// (one empty field, no tab, no quote) is not a row.
fn end_row<'a>(
	fields: &mut Vec<Cow<'a, str>>,
	field: &mut Cow<'a, str>,
	row_has_content: &mut bool,
	visit: &mut impl FnMut(&[Cow<'a, str>]) -> bool,
) -> bool {
	fields.push(std::mem::take(field));
	let keep =
		*row_has_content || fields.len() > 1 || fields.first().is_some_and(|f| !f.is_empty());
	*row_has_content = false;
	let go_on = !keep || visit(fields);
	fields.clear();
	go_on
}

/// `forEachTsvRow`: tab-separated rows in one linear scan. A field that
/// starts with `"` is quoted: `""` inside it is one quote, and tabs and line
/// breaks are part of it; the next lone `"` ends the quoting, and anything
/// after it up to the separator is kept as written. Rows end at LF, CRLF or
/// a lone CR. A blank line yields no row. `visit` returns false to stop.
///
/// The delimiters are ASCII, so scanning UTF-8 bytes splits exactly where
/// the TypeScript's UTF-16 scan does; `memchr` jumps over field contents.
pub fn for_each_tsv_row<'a>(text: &'a str, mut visit: impl FnMut(&[Cow<'a, str>]) -> bool) {
	let bytes = text.as_bytes();
	let length = bytes.len();
	let slice = |from: usize, to: usize| text.get(from..to).unwrap_or("");
	let mut fields: Vec<Cow<'a, str>> = Vec::with_capacity(9);
	let mut field: Cow<'a, str> = Cow::Borrowed("");
	let mut quoted = false;
	let mut field_start = true;
	let mut row_has_content = false;
	let mut index = 0usize;
	let mut run_start = 0usize;
	while index < length {
		if quoted {
			let Some(offset) = bytes
				.get(index..)
				.and_then(|rest| memchr::memchr(b'"', rest))
			else {
				break;
			};
			index += offset;
			append(&mut field, slice(run_start, index));
			if bytes.get(index + 1) == Some(&b'"') {
				field.to_mut().push('"');
				index += 2;
			} else {
				quoted = false;
				index += 1;
			}
			run_start = index;
			continue;
		}
		if field_start && bytes.get(index) == Some(&b'"') {
			quoted = true;
			field_start = false;
			row_has_content = true;
			index += 1;
			run_start = index;
			continue;
		}
		// Unquoted text runs to the next separator; a quote inside it is text.
		let Some(offset) = bytes
			.get(index..)
			.and_then(|rest| memchr::memchr3(b'\t', b'\n', b'\r', rest))
		else {
			break;
		};
		index += offset;
		append(&mut field, slice(run_start, index));
		field_start = true;
		if bytes.get(index) == Some(&b'\t') {
			fields.push(std::mem::take(&mut field));
			row_has_content = true;
			index += 1;
		} else {
			let crlf = bytes.get(index) == Some(&b'\r') && bytes.get(index + 1) == Some(&b'\n');
			index += if crlf { 2 } else { 1 };
			if !end_row(&mut fields, &mut field, &mut row_has_content, &mut visit) {
				return;
			}
		}
		run_start = index;
	}
	append(&mut field, slice(run_start, length));
	if row_has_content || !field.is_empty() || !fields.is_empty() {
		end_row(&mut fields, &mut field, &mut row_has_content, &mut visit);
	}
}

/* ---------- Report ---------- */

/// The report's fiscal years as its DEI elements state them (`EdinetFiscalYears`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetFiscalYears {
	/// `CurrentFiscalYearStartDateDEI`, when a valid date.
	pub current_start: Option<String>,
	/// `CurrentFiscalYearEndDateDEI`, when a valid date.
	pub current_end: Option<String>,
	/// `PreviousFiscalYearStartDateDEI`, when a valid date.
	pub previous_start: Option<String>,
	/// `PreviousFiscalYearEndDateDEI`, when a valid date.
	pub previous_end: Option<String>,
}

/// `EdinetReport`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetReport {
	/// `AccountingStandardsDEI`: "Japan GAAP", "IFRS", "US GAAP"; `None` otherwise.
	pub accounting_standard: Option<EquityAccountingStandard>,
	/// The DEI fiscal years.
	pub fiscal_years: EdinetFiscalYears,
	/// Facts of the claimed concepts in the four year contexts, in row order
	/// (before the annual filter).
	pub facts: Vec<EquityExtractedFact>,
}

const DEI_STANDARD: &str = "jpdei_cor:AccountingStandardsDEI";
const DEI_CURRENT_START: &str = "jpdei_cor:CurrentFiscalYearStartDateDEI";
const DEI_CURRENT_END: &str = "jpdei_cor:CurrentFiscalYearEndDateDEI";
const DEI_PREVIOUS_START: &str = "jpdei_cor:PreviousFiscalYearStartDateDEI";
const DEI_PREVIOUS_END: &str = "jpdei_cor:PreviousFiscalYearEndDateDEI";
const SEPARATE_SUFFIX: &str = "_NonConsolidatedMember";

/// One of the four year contexts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum YearContext {
	/// `CurrentYearDuration`.
	CurrentYearDuration,
	/// `Prior1YearDuration`.
	Prior1YearDuration,
	/// `CurrentYearInstant`.
	CurrentYearInstant,
	/// `Prior1YearInstant`.
	Prior1YearInstant,
}

fn year_context(text: &str) -> Option<YearContext> {
	match text {
		"CurrentYearDuration" => Some(YearContext::CurrentYearDuration),
		"Prior1YearDuration" => Some(YearContext::Prior1YearDuration),
		"CurrentYearInstant" => Some(YearContext::CurrentYearInstant),
		"Prior1YearInstant" => Some(YearContext::Prior1YearInstant),
		_ => None,
	}
}

/// `edinetContext`: the context's year and scope, or `None` for any other
/// (segment, interim, dimensional) context.
#[must_use]
pub fn edinet_context(context_id: &str) -> Option<(YearContext, EquityScope)> {
	if let Some(context) = year_context(context_id) {
		return Some((context, EquityScope::Consolidated));
	}
	context_id
		.strip_suffix(SEPARATE_SUFFIX)
		.and_then(year_context)
		.map(|context| (context, EquityScope::Separate))
}

fn accounting_standard(text: &str) -> Option<EquityAccountingStandard> {
	match text {
		"Japan GAAP" => Some(EquityAccountingStandard::Jgaap),
		"IFRS" => Some(EquityAccountingStandard::Ifrs),
		"US GAAP" => Some(EquityAccountingStandard::UsGaap),
		_ => None,
	}
}

fn date_or_none(text: &str) -> Option<String> {
	iso_day_number(text).map(|_| text.to_owned())
}

struct ConceptRow {
	concept: String,
	context: YearContext,
	scope: EquityScope,
	unit: String,
	value_decimal: String,
}

/// The CSV's first row is not the documented header.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("MISSING_HEADER")]
pub struct MissingHeader;

/// `parseEdinetCsv`: the DEI and the claimed concepts' year facts of one
/// report CSV. A concept row is skipped when its value is not canonical
/// decimal text ("－" is EDINET's nil), its unit id is empty or over 40
/// characters, or the DEI dates its context needs are missing.
///
/// # Errors
/// [`MissingHeader`] when the first row is not the documented header.
pub fn parse_edinet_csv(text: &str, concepts: &[String]) -> Result<EdinetReport, MissingHeader> {
	let wanted: HashSet<&str> = concepts.iter().map(String::as_str).collect();
	let mut header: Option<bool> = None;
	let mut standard = None;
	let mut years = EdinetFiscalYears::default();
	let mut rows: Vec<ConceptRow> = Vec::new();
	for_each_tsv_row(text, |fields| {
		if header.is_none() {
			let matches = fields.len() == EDINET_CSV_HEADER.len()
				&& fields
					.iter()
					.zip(EDINET_CSV_HEADER)
					.all(|(field, expected)| field == expected);
			header = Some(matches);
			return matches;
		}
		let [element, _, context_id, _, _, _, unit, _, value] = fields else {
			return true;
		};
		match element.as_ref() {
			DEI_STANDARD => standard = accounting_standard(value),
			DEI_CURRENT_START => years.current_start = date_or_none(value),
			DEI_CURRENT_END => years.current_end = date_or_none(value),
			DEI_PREVIOUS_START => years.previous_start = date_or_none(value),
			DEI_PREVIOUS_END => years.previous_end = date_or_none(value),
			concept if wanted.contains(concept) => {
				let Some((context, scope)) = edinet_context(context_id) else {
					return true;
				};
				if !(1..=MAX_UNIT_CHARS).contains(&utf16_len(unit)) || !is_canonical_decimal(value)
				{
					return true;
				}
				rows.push(ConceptRow {
					concept: concept.to_owned(),
					context,
					scope,
					unit: unit.as_ref().to_owned(),
					value_decimal: value.as_ref().to_owned(),
				});
			}
			_ => {}
		}
		true
	});
	if header != Some(true) {
		return Err(MissingHeader);
	}
	let facts = rows
		.into_iter()
		.filter_map(|row| {
			let (period_type, period_start, period_end) = period_of(row.context, &years)?;
			Some(EquityExtractedFact {
				concept: row.concept,
				unit: row.unit,
				value_decimal: row.value_decimal,
				period_type,
				period_start,
				period_end,
				scope: row.scope,
			})
		})
		.collect();
	Ok(EdinetReport {
		accounting_standard: standard,
		fiscal_years: years,
		facts,
	})
}

fn period_of(
	context: YearContext,
	years: &EdinetFiscalYears,
) -> Option<(EquityPeriodType, Option<String>, String)> {
	match context {
		YearContext::CurrentYearDuration => Some((
			EquityPeriodType::Duration,
			Some(years.current_start.clone()?),
			years.current_end.clone()?,
		)),
		YearContext::Prior1YearDuration => Some((
			EquityPeriodType::Duration,
			Some(years.previous_start.clone()?),
			years.previous_end.clone()?,
		)),
		YearContext::CurrentYearInstant => {
			Some((EquityPeriodType::Instant, None, years.current_end.clone()?))
		}
		YearContext::Prior1YearInstant => {
			Some((EquityPeriodType::Instant, None, years.previous_end.clone()?))
		}
	}
}

/// `selectEdinetReportEntry`: under `XBRL_TO_CSV/` (no deeper folder), a
/// file name starting `jpcrp` and ending `.csv`; when several do, the first
/// in code-unit order (the names are ASCII, so byte order is the same).
#[must_use]
pub fn select_edinet_report_entry(names: &[String]) -> Option<&str> {
	names
		.iter()
		.filter(|name| {
			name.strip_prefix(CSV_DIRECTORY).is_some_and(|file| {
				file.starts_with(REPORT_PREFIX) && file.ends_with(".csv") && !file.contains('/')
			})
		})
		.map(String::as_str)
		.min()
}

/// `EdinetReportProblem` (serialised as the TypeScript literal).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
pub enum EdinetReportProblem {
	/// The archive reader refused it.
	#[error("NOT_A_ZIP")]
	#[serde(rename = "NOT_A_ZIP")]
	NotAZip,
	/// No `XBRL_TO_CSV/jpcrp…csv` entry.
	#[error("NO_REPORT_ENTRY")]
	#[serde(rename = "NO_REPORT_ENTRY")]
	NoReportEntry,
	/// The entry is not UTF-16 LE text.
	#[error("ENCODING")]
	#[serde(rename = "ENCODING")]
	Encoding,
	/// The CSV does not start with the documented header.
	#[error("MISSING_HEADER")]
	#[serde(rename = "MISSING_HEADER")]
	MissingHeader,
}

impl EdinetReportProblem {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NotAZip => "NOT_A_ZIP",
			Self::NoReportEntry => "NO_REPORT_ENTRY",
			Self::Encoding => "ENCODING",
			Self::MissingHeader => "MISSING_HEADER",
		}
	}
}

/// One extracted report: its standard and annual facts (canonical order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdinetExtractedReport {
	/// The DEI standard, when recognised.
	pub accounting_standard: Option<EquityAccountingStandard>,
	/// The DEI fiscal years: an amendment's period when the list states none.
	pub fiscal_years: EdinetFiscalYears,
	/// Annual facts, canonical order.
	pub facts: Vec<EquityExtractedFact>,
}

/// `extractEdinetReport`: one XBRL-to-CSV download as the report's standard
/// and annual facts. Any problem — an archive the reader refuses, no `jpcrp`
/// entry, undecodable text, no header — fails.
///
/// # Errors
/// The first [`EdinetReportProblem`].
pub fn extract_edinet_report(
	archive: &[u8],
	concepts: &[String],
) -> Result<EdinetExtractedReport, EdinetReportProblem> {
	let names =
		list_zip_entries(archive, EDINET_ZIP_LIMITS).map_err(|_| EdinetReportProblem::NotAZip)?;
	let entry = select_edinet_report_entry(&names).ok_or(EdinetReportProblem::NoReportEntry)?;
	let mut entries = read_zip_entries_within(archive, &[entry], EDINET_ZIP_LIMITS)
		.map_err(|_| EdinetReportProblem::NotAZip)?;
	let bytes = entries
		.remove(entry)
		.ok_or(EdinetReportProblem::NoReportEntry)?;
	let text = decode_utf16_le(&bytes).map_err(|_| EdinetReportProblem::Encoding)?;
	drop(bytes);
	let report =
		parse_edinet_csv(&text, concepts).map_err(|_| EdinetReportProblem::MissingHeader)?;
	Ok(EdinetExtractedReport {
		accounting_standard: report.accounting_standard,
		fiscal_years: report.fiscal_years,
		facts: annual_facts_in_order(report.facts),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn rows(text: &str) -> Vec<Vec<String>> {
		let mut out = Vec::new();
		for_each_tsv_row(text, |fields| {
			out.push(fields.iter().map(|field| field.to_string()).collect());
			true
		});
		out
	}

	#[test]
	fn quoted_fields_hold_tabs_line_breaks_and_doubled_quotes() {
		assert_eq!(
			rows("\"a\"\t\"b\tc\"\r\n\"d\"\"e\"\t\"f\ng\"x\n\n\"h\""),
			vec![
				vec!["a".to_owned(), "b\tc".to_owned()],
				vec!["d\"e".to_owned(), "f\ngx".to_owned()],
				vec!["h".to_owned()],
			]
		);
		assert_eq!(
			rows("a\rb\r\n\t\n"),
			vec![vec!["a"], vec!["b"], vec!["", ""]]
		);
		assert_eq!(rows("x\"y\t\"z"), vec![vec!["x\"y", "z"]]);
	}

	#[test]
	fn utf16_needs_pairs_and_drops_one_bom() {
		assert_eq!(decode_utf16_le(&[0xFF, 0xFE, b'a', 0]).as_deref(), Ok("a"));
		assert_eq!(decode_utf16_le(&[b'a', 0, b'b']), Err(EncodingError));
		assert_eq!(decode_utf16_le(&[0x00, 0xD8]), Err(EncodingError));
		assert_eq!(
			decode_utf16_le(&[0xFF, 0xFE, 0xFF, 0xFE]).as_deref(),
			Ok("\u{feff}")
		);
	}

	#[test]
	fn contexts_and_entries() {
		assert_eq!(
			edinet_context("Prior1YearInstant_NonConsolidatedMember"),
			Some((YearContext::Prior1YearInstant, EquityScope::Separate))
		);
		assert_eq!(
			edinet_context("CurrentYearDuration_ReportableSegmentsMember"),
			None
		);
		let names = [
			"XBRL_TO_CSV/jpaud-x.csv",
			"XBRL_TO_CSV/jpcrp030000-asr-002.csv",
			"XBRL_TO_CSV/jpcrp030000-asr-001.csv",
			"XBRL_TO_CSV/sub/jpcrp-x.csv",
		]
		.map(str::to_owned);
		assert_eq!(
			select_edinet_report_entry(&names),
			Some("XBRL_TO_CSV/jpcrp030000-asr-001.csv")
		);
	}

	#[test]
	fn a_report_keeps_year_contexts_with_dei_dates() {
		let header = EDINET_CSV_HEADER.map(|h| format!("\"{h}\"")).join("\t");
		let row = |element: &str, context: &str, unit: &str, value: &str| {
			format!(
				"\"{element}\"\t\"x\"\t\"{context}\"\t\"\"\t\"\"\t\"\"\t\"{unit}\"\t\"\"\t\"{value}\""
			)
		};
		let text = [
			header,
			row(DEI_STANDARD, "FilingDateInstant", "", "Japan GAAP"),
			row(DEI_CURRENT_START, "FilingDateInstant", "", "2024-04-01"),
			row(DEI_CURRENT_END, "FilingDateInstant", "", "2025-03-31"),
			row(
				"jppfs_cor:NetSales",
				"CurrentYearDuration",
				"JPY",
				"1164922000000",
			),
			row(
				"jppfs_cor:NetSales",
				"Prior1YearDuration",
				"JPY",
				"1671865000000",
			),
			row(
				"jppfs_cor:NetSales",
				"CurrentYearDuration_NonConsolidatedMember",
				"JPY",
				"－",
			),
			row("jppfs_cor:Assets", "CurrentYearInstant", "JPY", "3000"),
		]
		.join("\r\n");
		let concepts = ["jppfs_cor:NetSales", "jppfs_cor:Assets"].map(str::to_owned);
		let report = parse_edinet_csv(&text, &concepts).unwrap_or_else(|_| unreachable!());
		assert_eq!(
			report.accounting_standard,
			Some(EquityAccountingStandard::Jgaap)
		);
		// The prior-year duration has no DEI dates; the nil value is skipped.
		assert_eq!(report.facts.len(), 2);
		assert_eq!(parse_edinet_csv("\"x\"", &concepts), Err(MissingHeader));
	}
}
