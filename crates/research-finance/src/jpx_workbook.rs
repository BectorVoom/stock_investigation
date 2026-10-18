//! Parser for the JPX earnings-announcement workbooks (FR-018), a port of
//! `jpxWorkbook.ts`. The workbook is untrusted input (SEC-001): element
//! scanning is a linear `memmem` walk (every delimiter is ASCII, so byte
//! offsets slice exactly where the UTF-16 offsets of the TypeScript do), entity
//! decoding is one non-recursive pass, and row / shared-string / cell counts
//! are bounded: past a bound the workbook is rejected, never partially
//! trusted. Phonetic `<rPh>` runs are included in shared strings, exactly as
//! the TypeScript does (finding F3).
use memchr::memmem;
use research_contracts::watchlist::{EarningsEvent, EarningsTiming};
use research_domain::calendar::civil_date::{excel_serial_to_iso_date, is_valid_iso_date};
use research_js::{string_number::string_to_number, utf16::utf16_len, whitespace::trim};
use serde::Serialize;

/// Workbook structural failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum JpxWorkbookError {
	/// An element is truncated or all data rows are unreadable.
	#[error("MALFORMED_WORKBOOK")]
	MalformedWorkbook,
	/// A scanner, cell or row bound is exceeded.
	#[error("LIMIT_EXCEEDED")]
	LimitExceeded,
	/// The five English headers are missing.
	#[error("MISSING_HEADERS")]
	MissingHeaders,
}

impl JpxWorkbookError {
	/// The TypeScript error literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::MalformedWorkbook => "MALFORMED_WORKBOOK",
			Self::LimitExceeded => "LIMIT_EXCEEDED",
			Self::MissingHeaders => "MISSING_HEADERS",
		}
	}
}

use JpxWorkbookError::{LimitExceeded, MalformedWorkbook, MissingHeaders};

/// The real file holds ~2,900 data rows; this is headroom, not a target.
pub const MAX_JPX_DATA_ROWS: usize = 20_000;
/// Bound on shared strings.
pub const MAX_JPX_SHARED_STRINGS: usize = 100_000;
/// Bound on cells in one workbook.
pub const MAX_JPX_CELLS: usize = 1_000_000;

const UNDECIDED_TEXT: &str = "未定_Undecided";
const MAX_LABEL_UTF16: usize = 80;

/// One normalized workbook row, before the requested date filter.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JpxWorkbookRow {
	/// JP stock code.
	pub code: String,
	/// Provider company name.
	pub name: Option<String>,
	/// Announcement date, or `None` when the source lists it as undecided.
	pub announcement_date: Option<String>,
	/// End of fiscal year.
	pub fiscal_period_end: String,
	/// Provider label.
	pub fiscal_period_label: String,
	/// Stable fiscal key.
	pub period_key: String,
}

/// A scanned `<tag …>…</tag>` or `<tag …/>` element.
struct Element<'a> {
	attrs: &'a str,
	inner: &'a str,
}

/// Bounded linear scan for elements named `tag` (SEC-001). An opener without
/// its closer fails the workbook at once (`MALFORMED_WORKBOOK`); `limit`
/// bounds the element count.
fn scan_elements<'a>(
	xml: &'a str,
	tag: &str,
	limit: usize,
) -> Result<Vec<Element<'a>>, JpxWorkbookError> {
	let open = format!("<{tag}");
	let close = format!("</{tag}>");
	let open_finder = memmem::Finder::new(open.as_bytes());
	let close_finder = memmem::Finder::new(close.as_bytes());
	let bytes = xml.as_bytes();
	let mut position = 0;
	let mut out = Vec::new();
	loop {
		let Some(found) = bytes
			.get(position..)
			.and_then(|rest| open_finder.find(rest))
		else {
			return Ok(out);
		};
		let start = position + found;
		let after_name = start + open.len();
		if !bytes
			.get(after_name)
			.is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | b'/' | b'>'))
		{
			// `<rows>`, `<rowspan>` …: not this element; skip past the name.
			position = after_name;
			continue;
		}
		let attrs_end = bytes
			.get(after_name..)
			.and_then(|rest| memchr::memchr(b'>', rest))
			.map(|at| after_name + at)
			.ok_or(MalformedWorkbook)?;
		let attrs = xml.get(after_name..attrs_end).ok_or(MalformedWorkbook)?;
		if let Some(attrs) = attrs.strip_suffix('/') {
			out.push(Element { attrs, inner: "" });
			position = attrs_end + 1;
		} else {
			let body = attrs_end + 1;
			let end = bytes
				.get(body..)
				.and_then(|rest| close_finder.find(rest))
				.map(|at| body + at)
				.ok_or(MalformedWorkbook)?;
			out.push(Element {
				attrs,
				inner: xml.get(body..end).ok_or(MalformedWorkbook)?,
			});
			position = end + close.len();
		}
		if out.len() > limit {
			return Err(LimitExceeded);
		}
	}
}

/// Decodes the five predefined XML entities and numeric character references
/// in one non-recursive pass (`&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);`).
/// Anything else (custom entities, DTD tricks) stays inert literal text.
#[must_use]
pub fn decode_workbook_text(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(at) = memchr::memchr(b'&', rest.as_bytes()) {
		out.push_str(rest.get(..at).unwrap_or_default());
		let after = rest.get(at + 1..).unwrap_or_default();
		if let Some((replacement, consumed)) = decode_entity(after) {
			out.push_str(&replacement);
			rest = after.get(consumed..).unwrap_or_default();
		} else {
			out.push('&');
			rest = after;
		}
	}
	out.push_str(rest);
	out
}

/// The replacement and the byte length of one entity body plus its `;`, when
/// `after` (the text following `&`) starts with a recognised entity.
fn decode_entity(after: &str) -> Option<(String, usize)> {
	// The longest body is `#x` plus six hex digits or `#` plus seven digits.
	let window = after.as_bytes().get(..9.min(after.len()))?;
	let end = memchr::memchr(b';', window)?;
	let entity = after.get(..end)?;
	let consumed = end + 1;
	let named = match entity {
		"lt" => Some("<"),
		"gt" => Some(">"),
		"amp" => Some("&"),
		"quot" => Some("\""),
		"apos" => Some("'"),
		_ => None,
	};
	if let Some(replacement) = named {
		return Some((replacement.to_owned(), consumed));
	}
	let (digits, radix) = if let Some(hex) = entity.strip_prefix("#x") {
		(hex, 16)
	} else {
		(entity.strip_prefix('#')?, 10)
	};
	let max_digits = if radix == 16 { 6 } else { 7 };
	if digits.is_empty()
		|| digits.len() > max_digits
		|| !digits
			.bytes()
			.all(|byte| byte.is_ascii_hexdigit() && (radix == 16 || byte.is_ascii_digit()))
	{
		return None;
	}
	// Zero, beyond U+10FFFF and the surrogate range decode to nothing.
	let replacement = u32::from_str_radix(digits, radix)
		.ok()
		.filter(|code| *code > 0)
		.and_then(char::from_u32)
		.map(String::from)
		.unwrap_or_default();
	Some((replacement, consumed))
}

/// `Second quarter` becomes `second-quarter` for the period-key suffix.
#[must_use]
pub fn slug_fiscal_kind(label: &str) -> String {
	let lower = trim(label).to_lowercase();
	let mut slug = String::with_capacity(lower.len());
	for part in lower.split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit()) {
		if part.is_empty() {
			continue;
		}
		if !slug.is_empty() {
			slug.push('-');
		}
		slug.push_str(part);
	}
	slug
}

/// Text of the first `<tag …>…</tag>` run in a small cell body, or `""`.
fn extract_single_tag_text<'a>(body: &'a str, tag: &str) -> &'a str {
	let bytes = body.as_bytes();
	let Some(start) = memmem::find(bytes, format!("<{tag}").as_bytes()) else {
		return "";
	};
	let Some(text_start) = bytes
		.get(start..)
		.and_then(|rest| memchr::memchr(b'>', rest))
		.map(|at| start + at + 1)
	else {
		return "";
	};
	let Some(end) = bytes
		.get(text_start..)
		.and_then(|rest| memmem::find(rest, format!("</{tag}>").as_bytes()))
		.map(|at| text_start + at)
	else {
		return "";
	};
	body.get(text_start..end).unwrap_or_default()
}

/// Spreadsheet column letters of a zero-based cell position.
fn column_letters(index: usize) -> String {
	let mut letters = Vec::new();
	let mut remainder = index;
	loop {
		let digit = u8::try_from(remainder % 26).unwrap_or(0);
		letters.push(char::from(b'A' + digit));
		if remainder < 26 {
			break;
		}
		remainder = remainder / 26 - 1;
	}
	letters.iter().rev().collect()
}

/// The capture of `/<attr>="(<class>+)<suffix>"/` over `attrs`, trying every
/// occurrence of `<attr>="` from the left like the regex does.
fn attribute_capture<'a>(attrs: &'a str, name: &str, with_digits: bool) -> Option<&'a str> {
	let needle = format!("{name}=\"");
	let finder = memmem::Finder::new(needle.as_bytes());
	let bytes = attrs.as_bytes();
	let mut from = 0;
	while let Some(found) = bytes.get(from..).and_then(|rest| finder.find(rest)) {
		let start = from + found + needle.len();
		let rest = bytes.get(start..)?;
		let letters = rest
			.iter()
			.take_while(|byte| {
				if with_digits {
					byte.is_ascii_uppercase()
				} else {
					byte.is_ascii_alphabetic()
				}
			})
			.count();
		let mut end = letters;
		if with_digits {
			let digits = rest.get(letters..).map_or(0, |tail| {
				tail.iter().take_while(|byte| byte.is_ascii_digit()).count()
			});
			if digits == 0 {
				from += found + 1;
				continue;
			}
			end += digits;
		}
		if letters > 0 && rest.get(end) == Some(&b'"') {
			return attrs.get(start..start + letters);
		}
		from += found + 1;
	}
	None
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CellKind {
	Empty,
	Shared,
	Literal,
	Inline,
}

struct Cell {
	column: String,
	kind: CellKind,
	value: String,
}

fn parse_row_cells(inner: &str, seen_cells: usize) -> Result<Vec<Cell>, JpxWorkbookError> {
	if seen_cells >= MAX_JPX_CELLS {
		return Err(LimitExceeded);
	}
	let scanned = scan_elements(inner, "c", MAX_JPX_CELLS - seen_cells)?;
	let mut cells = Vec::with_capacity(scanned.len());
	for (position, element) in scanned.iter().enumerate() {
		let column = attribute_capture(element.attrs, "r", true)
			.map_or_else(|| column_letters(position), str::to_owned);
		let kind_attr = attribute_capture(element.attrs, "t", false).unwrap_or("");
		let body = element.inner;
		if body.is_empty() {
			cells.push(Cell {
				column,
				kind: CellKind::Empty,
				value: String::new(),
			});
			continue;
		}
		if kind_attr == "inlineStr" {
			cells.push(Cell {
				column,
				kind: CellKind::Inline,
				value: decode_workbook_text(extract_single_tag_text(body, "t")),
			});
			continue;
		}
		let value = extract_single_tag_text(body, "v");
		if kind_attr == "s" {
			cells.push(Cell {
				column,
				kind: CellKind::Shared,
				value: trim(value).to_owned(),
			});
		} else {
			cells.push(Cell {
				column,
				kind: CellKind::Literal,
				value: decode_workbook_text(value),
			});
		}
	}
	Ok(cells)
}

fn parse_shared_strings(xml: &str) -> Result<Vec<String>, JpxWorkbookError> {
	let items = scan_elements(xml, "si", MAX_JPX_SHARED_STRINGS)?;
	let mut strings = Vec::with_capacity(items.len());
	for item in items {
		let mut combined = String::new();
		for run in scan_elements(item.inner, "t", MAX_JPX_CELLS)? {
			combined.push_str(&decode_workbook_text(run.inner));
		}
		strings.push(combined);
	}
	Ok(strings)
}

/// The text of a cell: shared-string cells resolve through the table, an
/// index outside it is `""`.
fn cell_text<'a>(cell: &'a Cell, shared: &'a [String]) -> &'a str {
	if cell.kind != CellKind::Shared {
		return &cell.value;
	}
	let index = string_to_number(&cell.value);
	if !index.is_finite() || index.fract() != 0.0 || index < 0.0 {
		return "";
	}
	// `-0` is an integer and indexes the first string, as in JavaScript.
	let position = if index == 0.0 {
		Some(0)
	} else {
		format!("{index:.0}").parse::<usize>().ok()
	};
	position
		.and_then(|at| shared.get(at))
		.map_or("", String::as_str)
}

/// Whether a header cell names the wanted English column. The observed file
/// separates the languages with a newline; a `日本語 / English` slash form is
/// accepted too. The match is on whole lines, so `Quarter` never matches
/// `Fiscal Year/Quarter` and `Code` never matches `Market Segment`.
#[must_use]
pub fn header_matches(text: &str, english: &str) -> bool {
	let slash_form = format!("/ {english}");
	JsLines::new(text).any(|line| {
		let line = trim(line);
		line == english || line.ends_with(&slash_form)
	})
}

/// `text.split(/\r\n|\r|\n/)`.
struct JsLines<'a> {
	rest: Option<&'a str>,
}

impl<'a> JsLines<'a> {
	const fn new(text: &'a str) -> Self {
		Self { rest: Some(text) }
	}
}

impl<'a> Iterator for JsLines<'a> {
	type Item = &'a str;

	fn next(&mut self) -> Option<&'a str> {
		let rest = self.rest?;
		match memchr::memchr2(b'\r', b'\n', rest.as_bytes()) {
			None => {
				self.rest = None;
				Some(rest)
			}
			Some(at) => {
				let line = rest.get(..at);
				let skip = if rest.as_bytes().get(at) == Some(&b'\r')
					&& rest.as_bytes().get(at + 1) == Some(&b'\n')
				{
					2
				} else {
					1
				};
				self.rest = rest.get(at + skip..);
				line
			}
		}
	}
}

const HEADER_DATE: &str = "Scheduled Dates for Earnings Announcements";
const HEADER_CODE: &str = "Code";
const HEADER_NAME: &str = "Issue Name";
const HEADER_END: &str = "Fiscal Year-end";
const HEADER_LABEL: &str = "Fiscal Year/Quarter";

/// Column letters of the five required columns.
struct HeaderColumns {
	date: String,
	code: String,
	name: String,
	end: String,
	label: String,
}

fn locate_headers(cells: &[Cell], shared: &[String]) -> Option<HeaderColumns> {
	let mut date = None;
	let mut code = None;
	let mut name = None;
	let mut end = None;
	let mut label = None;
	for cell in cells {
		let text = cell_text(cell, shared);
		// First matching header wins per cell; later cells overwrite.
		let slot = if header_matches(text, HEADER_DATE) {
			&mut date
		} else if header_matches(text, HEADER_CODE) {
			&mut code
		} else if header_matches(text, HEADER_NAME) {
			&mut name
		} else if header_matches(text, HEADER_END) {
			&mut end
		} else if header_matches(text, HEADER_LABEL) {
			&mut label
		} else {
			continue;
		};
		*slot = Some(cell.column.clone());
	}
	Some(HeaderColumns {
		date: date?,
		code: code?,
		name: name?,
		end: end?,
		label: label?,
	})
}

fn by_column<'a>(cells: &'a [Cell], column: &str) -> Option<&'a Cell> {
	cells.iter().find(|cell| cell.column == column)
}

/// An Excel serial as an ISO date, when the cell text is a valid serial.
fn serial_date(raw: &str) -> Option<String> {
	if raw.is_empty() {
		return None;
	}
	let serial = string_to_number(raw);
	if !serial.is_finite() {
		return None;
	}
	excel_serial_to_iso_date(serial).ok()
}

fn parse_data_row(
	cells: &[Cell],
	shared: &[String],
	headers: &HeaderColumns,
) -> Option<JpxWorkbookRow> {
	let code_cell = by_column(cells, &headers.code)?;
	// F6: the numeric branch of the TypeScript is reachable only for empty
	// cells and always skips them.
	if code_cell.kind == CellKind::Empty {
		return None;
	}
	let code = trim(cell_text(code_cell, shared)).to_uppercase();
	let code_bytes = code.as_bytes();
	if code_bytes.len() != 4
		|| !code_bytes.first().is_some_and(u8::is_ascii_digit)
		|| !code_bytes
			.iter()
			.all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
	{
		return None;
	}

	let date_cell = by_column(cells, &headers.date)?;
	let date_raw = trim(cell_text(date_cell, shared));
	let announcement_date = if date_raw == UNDECIDED_TEXT {
		None
	} else {
		Some(serial_date(date_raw)?)
	};

	let end_cell = by_column(cells, &headers.end)?;
	let fiscal_period_end = serial_date(trim(cell_text(end_cell, shared)))?;

	let label_cell = by_column(cells, &headers.label)?;
	let label = trim(cell_text(label_cell, shared));
	if label.is_empty() || utf16_len(label) > MAX_LABEL_UTF16 {
		return None;
	}
	let period_key = format!("fy{fiscal_period_end}-{}", slug_fiscal_kind(label));
	let name_raw = by_column(cells, &headers.name).map_or("", |cell| trim(cell_text(cell, shared)));
	// The contract schema is the last word: a row that cannot be stored is
	// skipped, never half-kept.
	crate::market_fetch::valid_event(&EarningsEvent {
		period_key: period_key.clone(),
		announcement_date: announcement_date.clone(),
		fiscal_period_label: label.to_owned(),
		fiscal_period_end: Some(fiscal_period_end.clone()),
		timing: EarningsTiming::Unknown,
	})?;
	if announcement_date
		.as_deref()
		.is_some_and(|date| !is_valid_iso_date(date))
	{
		return None;
	}
	Some(JpxWorkbookRow {
		code,
		name: (!name_raw.is_empty()).then(|| name_raw.to_owned()),
		announcement_date,
		fiscal_period_end,
		fiscal_period_label: label.to_owned(),
		period_key,
	})
}

/// Parses one workbook's sheet and shared strings into data rows. Rows that
/// fail per-row validation are skipped; structural failures (no headers,
/// malformed XML shape, bound overruns) fail the whole workbook.
///
/// # Errors
/// [`JpxWorkbookError`] for the structural failures above.
pub fn parse_jpx_workbook(
	sheet: &str,
	shared: &str,
) -> Result<Vec<JpxWorkbookRow>, JpxWorkbookError> {
	let strings = parse_shared_strings(shared)?;
	let scanned = scan_elements(sheet, "row", MAX_JPX_DATA_ROWS + 1_000)?;
	let mut rows = Vec::new();
	let mut header: Option<HeaderColumns> = None;
	let mut seen_cells = 0;
	let mut data_rows = 0;
	for element in scanned {
		if element.inner.is_empty() {
			continue;
		}
		let cells = parse_row_cells(element.inner, seen_cells)?;
		seen_cells += cells.len();
		let Some(columns) = &header else {
			header = locate_headers(&cells, &strings);
			continue;
		};
		if !cells.is_empty() {
			data_rows += 1;
		}
		if rows.len() >= MAX_JPX_DATA_ROWS {
			return Err(LimitExceeded);
		}
		if let Some(row) = parse_data_row(&cells, &strings, columns) {
			rows.push(row);
		}
	}
	if header.is_none() {
		return Err(MissingHeaders);
	}
	// The header parsed but not one data row did: a schedule workbook always
	// lists announcements, so this is a shape change or corruption: fail
	// closed rather than reading it as "no date for any stock".
	if data_rows > 0 && rows.is_empty() {
		return Err(MalformedWorkbook);
	}
	Ok(rows)
}
