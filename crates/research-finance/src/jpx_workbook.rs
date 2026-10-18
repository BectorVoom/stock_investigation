//! Linear, bounded JPX sheet/shared-string scanners. Phonetic runs remain included (F3).
use research_contracts::watchlist::{EarningsEvent,EarningsTiming};
use research_domain::calendar::civil_date::{excel_serial_to_iso_date,is_valid_iso_date};
use research_js::{whitespace::trim,utf16::utf16_len,string_number::string_to_number};
use serde::Serialize;
/// Workbook structural failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum JpxWorkbookError {
	/// An element is truncated or all data rows are unreadable.
	#[error("MALFORMED_WORKBOOK")] MalformedWorkbook,
	/// A scanner, cell or row bound is exceeded.
	#[error("LIMIT_EXCEEDED")] LimitExceeded,
	/// The five English headers are missing.
	#[error("MISSING_HEADERS")] MissingHeaders,
}
use JpxWorkbookError::*;
/// One normalized workbook row, before the requested date filter.
#[derive(Clone,Debug,Serialize,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub struct JpxWorkbookRow {
	/// JP stock code.
	pub code: String,
	/// Provider company name.
	pub name: Option<String>,
	/// Announcement date or undecided.
	pub announcement_date: Option<String>,
	/// End of fiscal year.
	pub fiscal_period_end: String,
	/// Provider label.
	pub fiscal_period_label: String,
	/// Stable fiscal key.
	pub period_key: String,
}
struct Element<'a> { attrs: &'a str, inner: &'a str }
fn scan_elements<'a>(xml: &'a str,tag: &str,limit: usize) -> Result<Vec<Element<'a>>,JpxWorkbookError> {
	let open = format!("<{tag}"); let close = format!("</{tag}>");
	let mut at = 0; let mut out = Vec::new();
	while let Some(relative) = xml.get(at..).and_then(|s| s.find(&open)) {
		let start = at+relative+open.len();
		if !xml.as_bytes().get(start).is_some_and(|b| matches!(b,b' '|b'\t'|b'\n'|b'\r'|b'/'|b'>')) { at = start; continue; }
		let end = start+xml.get(start..).and_then(|s| s.find('>')).ok_or(MalformedWorkbook)?;
		let attrs = xml.get(start..end).ok_or(MalformedWorkbook)?;
		let element = if let Some(attrs) = attrs.strip_suffix('/') {
			at = end+1; Element { attrs,inner: "" }
		} else {
			let body = end+1;
			let closing = body+xml.get(body..).and_then(|s| s.find(&close)).ok_or(MalformedWorkbook)?;
			at = closing+close.len();
			Element { attrs,inner: xml.get(body..closing).ok_or(MalformedWorkbook)? }
		};
		out.push(element);
		if out.len() > limit { return Err(LimitExceeded); }
	}
	Ok(out)
}
/// Decodes one XML entity pass, discarding invalid numeric code points.
pub fn decode_workbook_text(text: &str) -> String {
	let mut out = String::with_capacity(text.len()); let mut rest = text;
	while let Some(at) = rest.find('&') {
		out.push_str(rest.get(..at).unwrap_or(""));
		let after = rest.get(at+1..).unwrap_or("");
		if let Some(end) = after.find(';').filter(|n| *n<=9) {
			let entity = after.get(..end).unwrap_or("");
			let named = match entity { "lt" => Some('<'), "gt" => Some('>'), "amp" => Some('&'), "quot" => Some('"'), "apos" => Some('\''),_ => None };
			if let Some(ch) = named { out.push(ch); rest = after.get(end+1..).unwrap_or(""); continue; }
			let numeric = entity.strip_prefix("#x").filter(|s| (1..=6).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())).map(|s| (s,16))
				.or_else(|| entity.strip_prefix('#').filter(|s| (1..=7).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())).map(|s| (s,10)));
			if let Some((s,radix)) = numeric {
				if let Some(ch) = u32::from_str_radix(s,radix).ok().filter(|n| *n>0).and_then(char::from_u32) { out.push(ch); }
				rest = after.get(end+1..).unwrap_or(""); continue;
			}
		}
		out.push('&'); rest = after;
	}
	out.push_str(rest); out
}
fn single<'a>(xml: &'a str,tag: &str) -> &'a str {
	let Some(start) = xml.find(&format!("<{tag}")) else { return ""; };
	let Some(end) = xml.get(start..).and_then(|s| s.find('>')).map(|n| start+n+1) else { return ""; };
	let Some(close) = xml.get(end..).and_then(|s| s.find(&format!("</{tag}>"))).map(|n| end+n) else { return ""; };
	xml.get(end..close).unwrap_or("")
}
fn letters(mut position: usize) -> String {
	let mut reversed = Vec::new();
	loop { reversed.push(char::from(b'A'+u8::try_from(position%26).unwrap_or(0))); if position<26 { break; } position = position/26-1; }
	reversed.into_iter().rev().collect()
}
fn attr<'a>(attrs: &'a str,key: &str) -> Option<&'a str> {
	let start = attrs.find(&format!("{key}=\""))?+key.len()+2;
	let rest = attrs.get(start..)?; rest.get(..rest.find('"')?)
}
struct Cell<'a> { column: String,kind: &'a str,value: String }
fn row_cells(xml: &str, seen: usize) -> Result<Vec<Cell<'_>>,JpxWorkbookError> {
	if seen>=1_000_000 { return Err(LimitExceeded); }
	scan_elements(xml,"c",1_000_000-seen)?.into_iter().enumerate().map(|(pos,e)| {
		let column = attr(e.attrs,"r").and_then(|s| { let n = s.bytes().take_while(u8::is_ascii_uppercase).count(); let (letters,number)=s.split_at(n); (!letters.is_empty() && !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())).then(|| letters.to_owned()) }).unwrap_or_else(|| letters(pos));
		let kind = attr(e.attrs,"t").filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphabetic())).unwrap_or("");
		let (kind,value) = if e.inner.is_empty() { ("empty",String::new()) }
		else if kind=="inlineStr" { ("inline",decode_workbook_text(single(e.inner,"t"))) }
		else if kind=="s" { ("shared",trim(single(e.inner,"v")).to_owned()) }
		else { ("literal",decode_workbook_text(single(e.inner,"v"))) };
		Ok(Cell { column,kind,value })
	}).collect()
}
fn cell_text<'a>(cell: &'a Cell<'_>,shared: &'a [String]) -> &'a str {
	if cell.kind!="shared" { return &cell.value; }
	let index = string_to_number(&cell.value);
	if !index.is_finite() || index<0.0 || index.fract()!=0.0 { return ""; }
	let index = format!("{index:.0}").parse::<usize>().ok();
	index.and_then(|n| shared.get(n)).map_or("",String::as_str)
}
const HEADERS: [&str;5] = ["Scheduled Dates for Earnings Announcements","Code","Issue Name","Fiscal Year-end","Fiscal Year/Quarter"];
fn locate(cells: &[Cell<'_>],shared: &[String]) -> Option<Vec<String>> {
	let mut found: Vec<Option<String>> = vec![None;5];
	for cell in cells {
		let text = cell_text(cell,shared);
		for (index,header) in HEADERS.iter().enumerate() {
			if text.split(['\n','\r']).map(trim).any(|line| line==*header || line.ends_with(&format!("/ {header}"))) {
				if let Some(slot) = found.get_mut(index) { *slot = Some(cell.column.clone()); } break;
			}
		}
	}
	found.into_iter().collect()
}
fn data_row(cells: &[Cell<'_>],shared: &[String],headers: &[String]) -> Option<JpxWorkbookRow> {
	let cell = |index| { let column = headers.get(index)?; cells.iter().find(|cell| cell.column==*column) };
	let read = |index| Some(trim(cell_text(cell(index)?,shared)));
	let code_cell = cell(1)?;
	// F6: the numeric branch is reachable only for empty cells and always skips them.
	if code_cell.kind=="empty" { return None; }
	let code = read(1)?.to_uppercase();
	if code.len()!=4 || !code.as_bytes().first().is_some_and(u8::is_ascii_digit) || !code.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase()) { return None; }
	let raw = read(0)?;
	let announcement_date = if raw=="未定_Undecided" { None } else {
		if raw.is_empty() { return None; } Some(excel_serial_to_iso_date(string_to_number(raw)).ok()?)
	};
	let raw_end = read(3)?;
	if raw_end.is_empty() { return None; }
	let fiscal_period_end = excel_serial_to_iso_date(string_to_number(raw_end)).ok()?;
	let label = read(4)?;
	if label.is_empty() || utf16_len(label)>80 { return None; }
	let lower = label.to_lowercase();
	let slug = lower.split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
	let period_key = format!("fy{fiscal_period_end}-{slug}");
	let event = EarningsEvent { period_key: period_key.clone(), announcement_date: announcement_date.clone(),fiscal_period_label: label.to_owned(),fiscal_period_end: Some(fiscal_period_end.clone()),timing: EarningsTiming::Unknown };
	crate::market_fetch::valid_event(&event)?;
	if announcement_date.as_deref().is_some_and(|s| !is_valid_iso_date(s)) { return None; }
	let raw_name = read(2).unwrap_or("");
	Some(JpxWorkbookRow { code,name: (!raw_name.is_empty()).then(|| raw_name.to_owned()),announcement_date,fiscal_period_end,fiscal_period_label: label.to_owned(),period_key })
}
/// Parses a sheet and shared strings, failing closed on structural corruption.
pub fn parse_jpx_workbook(sheet: &str, shared: &str) -> Result<Vec<JpxWorkbookRow>,JpxWorkbookError> {
	let strings: Vec<String> = scan_elements(shared,"si",100_000)?.into_iter().map(|e| {
		Ok(scan_elements(e.inner,"t",1_000_000)?.into_iter().map(|e| decode_workbook_text(e.inner)).collect::<String>())
	}).collect::<Result<_,JpxWorkbookError>>()?;
	let mut rows = Vec::new(); let mut header = None; let mut seen = 0; let mut data_rows = 0;
	for row in scan_elements(sheet,"row",21_000)? {
		if row.inner.is_empty() { continue; }
		let cells = row_cells(row.inner,seen)?; seen += cells.len();
		let Some(headers) = &header else { header = locate(&cells,&strings); continue; };
		if !cells.is_empty() { data_rows += 1; }
		if rows.len()>=20_000 { return Err(LimitExceeded); }
		if let Some(row) = data_row(&cells,&strings,headers) { rows.push(row); }
	}
	if header.is_none() { return Err(MissingHeaders); }
	if data_rows>0 && rows.is_empty() { return Err(MalformedWorkbook); }
	Ok(rows)
}
