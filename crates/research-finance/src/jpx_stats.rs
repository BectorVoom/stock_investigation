//! JPX market statistics as market series (provider `jpx`): the TSE
//! short-selling ratio (空売り比率, daily, read from JPX's PDF) and the
//! Tokyo & Nagoya margin buying balance value (信用買い残) and margin ratio
//! (信用倍率) (weekly, read from JPX's workbooks).
//!
//! JPX lists only recent files, so the market-refresh job asks once for
//! everything listed and the API merges the answer (it never replaces the
//! stored history). Pages are cached for three hours and every file's parsed
//! result by URL, so a refresh sends only what is new; every request actually
//! sent is admitted by the series query's gate (pacer key `jpx`).
//!
//! Wire format, file layouts, limits and error mapping:
//! docs/external-apis/apis/jpx.md
use crate::{
	jpx::anchor_hrefs,
	jpx_workbook::{WorkbookCell, read_workbook_rows},
	market_fetch::{admit_market_request, fetch_options, finish_points, is_iso_date},
	ports::{MarketSeriesSource, MarketUnavailable, SeriesData, SeriesPoint, SeriesQuery},
	zip_reader::{MAX_ZIP_ARCHIVE_BYTES, read_zip_entries},
};
use async_trait::async_trait;
use flate2::{Decompress, FlushDecompress, Status};
use research_application::ports::{
	Clock, SafeBinaryFetcher, SafeFetchError, SafeFetcher, upstream_status_of,
};
use research_contracts::market::{
	MarketFrequency, MarketProviderId, MarketSeriesMeta, MarketUnavailableCode as Code,
};
use research_domain::calendar::civil_date::excel_serial_to_iso_date;
use research_js::{string_number::string_to_number, whitespace::trim};
use std::{
	collections::{BTreeMap, HashMap},
	sync::Arc,
};

/// The only host the source contacts.
pub const JPX_STATS_HOST: &str = "www.jpx.co.jp";
/// The short-selling index page (links to the daily PDFs).
pub const JPX_SHORT_SELLING_URL: &str =
	"https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html";
/// The weekly margin page (links to the weekly workbooks).
pub const JPX_MARGIN_WEEKLY_URL: &str =
	"https://www.jpx.co.jp/markets/statistics-equities/margin/04.html";
/// The margin history page (links to the history workbook).
pub const JPX_MARGIN_HISTORY_URL: &str =
	"https://www.jpx.co.jp/markets/statistics-equities/margin/05.html";
/// How long a page is reused (`JPX_STATS_PAGE_TTL_MS`, 3 hours).
pub const JPX_STATS_PAGE_TTL_MS: i64 = 3 * 60 * 60 * 1000;
/// Short-selling PDFs read per refresh, newest listed first.
pub const MAX_SHORT_SELLING_FILES: usize = 10;
/// Weekly margin workbooks read per refresh.
pub const MAX_MARGIN_WEEKLY_FILES: usize = 8;
/// Largest short-selling PDF downloaded.
pub const MAX_SHORT_SELLING_PDF_BYTES: usize = 1_048_576;
/// Largest total inflated stream output of one PDF; past it the file does not parse.
pub const MAX_PDF_INFLATED_BYTES: usize = 4_194_304;
/// `jpx:SHORT_SELLING_RATIO`.
pub const SHORT_SELLING_RATIO: &str = "SHORT_SELLING_RATIO";
/// `jpx:MARGIN_BUYING_VALUE`.
pub const MARGIN_BUYING_VALUE: &str = "MARGIN_BUYING_VALUE";
/// `jpx:MARGIN_RATIO`.
pub const MARGIN_RATIO: &str = "MARGIN_RATIO";

const PUBLISHER: &str = "Japan Exchange Group (JPX)";
const PDF_TYPE: &str = "application/pdf";
const XLSX_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILE_TIMEOUT_MS: u64 = 60_000;
const SHEET: &str = "xl/worksheets/sheet1.xml";
const STRINGS: &str = "xl/sharedStrings.xml";
const SHORT_SELLING_PATH: &str =
	r"^/markets/statistics-equities/short-selling/[A-Za-z0-9_-]+/([0-9]{6})-m\.pdf$";
const MARGIN_WEEKLY_PATH: &str =
	r"^/markets/statistics-equities/margin/[A-Za-z0-9_-]+/([0-9]{8})_mtcurrent\.xlsx$";
const MARGIN_HISTORY_PATH: &str =
	r"^/markets/statistics-equities/margin/[A-Za-z0-9_-]+/[A-Za-z0-9_]+\.xlsx$";
/// Excel serials of 2000-01-01 and 2099-12-31: a history row's date range.
const HISTORY_SERIALS: std::ops::RangeInclusive<f64> = 36_526.0..=73_050.0;

/// The four amounts of one short-selling PDF (実注文, 空売り価格規制あり,
/// 空売り価格規制なし, 合計), in yen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShortSellingFigures {
	/// Orders that are not short sales.
	pub a: f64,
	/// Short sales under the price restriction.
	pub b: f64,
	/// Short sales outside the price restriction.
	pub c: f64,
	/// The total.
	pub d: f64,
}
impl ShortSellingFigures {
	/// The short-selling ratio in percent, one decimal:
	/// `Math.round(((b + c) * 1000) / d) / 10`.
	#[must_use]
	pub fn ratio(&self) -> f64 {
		(((self.b + self.c) * 1000.0) / self.d).round() / 10.0
	}
}

/// The Tokyo & Nagoya margin totals of one week (thousand shares, million yen).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MarginFigures {
	/// Sell balance, shares.
	pub sell_shares: f64,
	/// Sell balance, value.
	pub sell_value: f64,
	/// Buy balance, shares.
	pub buy_shares: f64,
	/// Buy balance, value.
	pub buy_value: f64,
}
impl MarginFigures {
	/// The margin ratio, two decimals (`Math.round((buy * 100) / sell) / 100`),
	/// or `None` when there is no sell balance.
	#[must_use]
	pub fn ratio(&self) -> Option<f64> {
		(self.sell_shares != 0.0)
			.then(|| ((self.buy_shares * 100.0) / self.sell_shares).round() / 100.0)
	}
}

/* ---------------- links ---------------- */

/// The page's links whose path fully matches `pattern`: resolved against
/// `page_url`, `https` on [`JPX_STATS_HOST`] only, reduced to origin + path,
/// de-duplicated, in document order, each with its first capture group (or
/// `""`), dropping those `keep` refuses, at most `max`.
fn page_links(
	html: &str,
	page_url: &str,
	pattern: &str,
	max: usize,
	keep: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
	let Ok(path) = regex::Regex::new(pattern) else {
		return Vec::new();
	};
	let Ok(base) = url::Url::parse(page_url) else {
		return Vec::new();
	};
	let mut links: Vec<(String, String)> = Vec::new();
	for raw in anchor_hrefs(html) {
		if links.len() >= max {
			break;
		}
		let Ok(url) = base.join(raw) else {
			continue;
		};
		if url.scheme() != "https" || url.host_str() != Some(JPX_STATS_HOST) {
			continue;
		}
		let Some(captures) = path.captures(url.path()) else {
			continue;
		};
		let key = format!("{}{}", url.origin().ascii_serialization(), url.path());
		if links.iter().any(|(listed, _)| *listed == key) {
			continue;
		}
		let captured = captures.get(1).map_or("", |m| m.as_str());
		let Some(date) = keep(captured) else {
			continue;
		};
		links.push((key, date));
	}
	links
}

/// `YYMMDD` → `20YY-MM-DD` when it is a real date.
fn short_selling_date(digits: &str) -> Option<String> {
	let (yy, rest) = (digits.get(..2)?, digits.get(2..)?);
	let date = format!("20{yy}-{}-{}", rest.get(..2)?, rest.get(2..)?);
	is_iso_date(&date).then_some(date)
}

/// `YYYYMMDD` → `YYYY-MM-DD` when it is a real date.
fn weekly_date(digits: &str) -> Option<String> {
	let date = format!(
		"{}-{}-{}",
		digits.get(..4)?,
		digits.get(4..6)?,
		digits.get(6..)?
	);
	is_iso_date(&date).then_some(date)
}

/// The short-selling PDFs listed on the index page, with their dates (at
/// most [`MAX_SHORT_SELLING_FILES`]).
#[must_use]
pub fn extract_short_selling_links(html: &str) -> Vec<(String, String)> {
	page_links(
		html,
		JPX_SHORT_SELLING_URL,
		SHORT_SELLING_PATH,
		MAX_SHORT_SELLING_FILES,
		short_selling_date,
	)
}

/// The weekly margin workbooks listed on page 04, with their dates (at most
/// [`MAX_MARGIN_WEEKLY_FILES`]).
#[must_use]
pub fn extract_margin_weekly_links(html: &str) -> Vec<(String, String)> {
	page_links(
		html,
		JPX_MARGIN_WEEKLY_URL,
		MARGIN_WEEKLY_PATH,
		MAX_MARGIN_WEEKLY_FILES,
		weekly_date,
	)
}

/// The first history workbook listed on page 05.
#[must_use]
pub fn extract_margin_history_link(html: &str) -> Option<String> {
	page_links(html, JPX_MARGIN_HISTORY_URL, MARGIN_HISTORY_PATH, 1, |_| {
		Some(String::new())
	})
	.into_iter()
	.next()
	.map(|(url, _)| url)
}

/* ---------------- short-selling PDF ---------------- */

/// One stream's inflation.
enum Inflated {
	/// The whole zlib stream.
	Data(Vec<u8>),
	/// Corrupt or truncated: the stream is skipped.
	Skipped,
	/// Past the file's remaining output budget: the file does not parse.
	OverCap,
}

/// Inflates one zlib (RFC 1950) stream, ignoring bytes after its end, with at
/// most `remaining` bytes of output.
fn inflate_stream(data: &[u8], remaining: usize) -> Inflated {
	const STEP: usize = 64 * 1024;
	let limit = remaining.saturating_add(1);
	let mut inflater = Decompress::new(true);
	let mut out: Vec<u8> = Vec::new();
	loop {
		if out.len() >= limit {
			return Inflated::OverCap;
		}
		if out.len() == out.capacity() {
			out.reserve_exact(STEP.min(limit - out.len()));
		}
		let consumed = usize::try_from(inflater.total_in()).unwrap_or(usize::MAX);
		let Some(input) = data.get(consumed..) else {
			return Inflated::Skipped;
		};
		let produced = out.len();
		let status = match inflater.decompress_vec(input, &mut out, FlushDecompress::None) {
			Ok(status) => status,
			Err(_) => return Inflated::Skipped,
		};
		if out.len() > remaining {
			return Inflated::OverCap;
		}
		if status == Status::StreamEnd {
			return Inflated::Data(out);
		}
		let progressed = usize::try_from(inflater.total_in()).unwrap_or(usize::MAX) != consumed
			|| out.len() != produced;
		// With room left and no progress, the input ended before the zlib
		// stream did: a truncated stream.
		if !progressed && out.len() < out.capacity() {
			return Inflated::Skipped;
		}
	}
}

/// Every inflatable stream of a PDF, in file order, or `None` past
/// [`MAX_PDF_INFLATED_BYTES`] of output in total.
fn pdf_streams(data: &[u8]) -> Option<Vec<Vec<u8>>> {
	let mut out = Vec::new();
	let mut total = 0usize;
	let mut at = 0usize;
	while let Some(found) = data
		.get(at..)
		.and_then(|rest| memchr::memmem::find(rest, b"stream"))
	{
		let p = at + found;
		at = p + 6;
		if p >= 3 && data.get(p - 3..p) == Some(b"end".as_slice()) {
			continue;
		}
		let start = if data.get(p + 6..p + 8) == Some(b"\r\n".as_slice()) {
			p + 8
		} else if data.get(p + 6..p + 7) == Some(b"\n".as_slice()) {
			p + 7
		} else {
			continue;
		};
		let Some(end) = data
			.get(start..)
			.and_then(|rest| memchr::memmem::find(rest, b"endstream"))
			.map(|offset| start + offset)
		else {
			break;
		};
		match inflate_stream(data.get(start..end)?, MAX_PDF_INFLATED_BYTES - total) {
			Inflated::OverCap => return None,
			Inflated::Skipped => continue,
			Inflated::Data(inflated) => {
				total += inflated.len();
				out.push(inflated);
				at = end;
			}
		}
	}
	Some(out)
}

const fn is_printable(byte: u8) -> bool {
	matches!(byte, 0x09 | 0x0A | 0x0D | 0x20..=0x7E)
}

const fn is_pdf_whitespace(byte: u8) -> bool {
	matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | 0x0C | 0x00)
}

const fn is_regular(byte: u8) -> bool {
	!is_pdf_whitespace(byte)
		&& !matches!(
			byte,
			b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
		)
}

/// Reads one literal string starting after its `(`; returns the bytes and
/// the index after the closing `)` (or the end).
fn literal_string(s: &[u8], mut i: usize) -> (Vec<u8>, usize) {
	let mut depth = 1u32;
	let mut buf = Vec::new();
	while let Some(&c) = s.get(i) {
		if c == b'\\' {
			i += 1;
			let Some(&e) = s.get(i) else {
				break;
			};
			if (b'0'..=b'7').contains(&e) {
				let mut value = 0u32;
				let mut digits = 0;
				while digits < 3 {
					match s.get(i) {
						Some(&d) if (b'0'..=b'7').contains(&d) => {
							value = value * 8 + u32::from(d - b'0');
							i += 1;
							digits += 1;
						}
						_ => break,
					}
				}
				buf.push(value.to_le_bytes()[0]);
				continue;
			}
			if e == b'\r' {
				i += 1;
				if s.get(i) == Some(&b'\n') {
					i += 1;
				}
				continue;
			}
			if e == b'\n' {
				i += 1;
				continue;
			}
			buf.push(match e {
				b'n' => b'\n',
				b'r' => b'\r',
				b't' => b'\t',
				b'b' => 0x08,
				b'f' => 0x0C,
				other => other,
			});
			i += 1;
			continue;
		}
		if c == b'(' {
			depth += 1;
		} else if c == b')' {
			depth -= 1;
			if depth == 0 {
				i += 1;
				break;
			}
		}
		buf.push(c);
		i += 1;
	}
	(buf, i)
}

/// The text tokens of one content stream: the literal strings of each
/// `BT … ET` object concatenated, one non-empty token per object.
fn text_tokens(s: &[u8]) -> Vec<Vec<u8>> {
	let mut tokens = Vec::new();
	let mut in_text = false;
	let mut current: Vec<u8> = Vec::new();
	let mut i = 0usize;
	while let Some(&ch) = s.get(i) {
		if ch == b'(' {
			let (literal, next) = literal_string(s, i + 1);
			if in_text {
				current.extend_from_slice(&literal);
			}
			i = next;
			continue;
		}
		if ch == b'<' {
			if s.get(i + 1) == Some(&b'<') {
				i += 2;
			} else {
				i = memchr::memchr(b'>', s.get(i + 1..).unwrap_or_default())
					.map_or(s.len(), |offset| i + 1 + offset + 1);
			}
			continue;
		}
		let before_ok = i == 0 || s.get(i - 1).is_some_and(|byte| !is_regular(*byte));
		let after_ok = s.get(i + 2).is_none_or(|byte| is_pdf_whitespace(*byte));
		if before_ok && after_ok {
			match s.get(i..i + 2) {
				Some(b"BT") => {
					in_text = true;
					current.clear();
					i += 2;
					continue;
				}
				Some(b"ET") => {
					if in_text && !current.is_empty() {
						tokens.push(std::mem::take(&mut current));
					}
					in_text = false;
					current.clear();
					i += 2;
					continue;
				}
				_ => {}
			}
		}
		i += 1;
	}
	tokens
}

/// `^[0-9]{1,3}(,[0-9]{3})+$`.
fn is_amount(token: &[u8]) -> bool {
	let mut groups = token.split(|byte| *byte == b',');
	let Some(first) = groups.next() else {
		return false;
	};
	let mut rest = 0;
	for group in groups {
		if group.len() != 3 || !group.iter().all(u8::is_ascii_digit) {
			return false;
		}
		rest += 1;
	}
	(1..=3).contains(&first.len()) && first.iter().all(u8::is_ascii_digit) && rest > 0
}

/// `^[0-9]{1,3}\.[0-9]%$`.
fn is_percent(token: &[u8]) -> bool {
	let Some(body) = token.strip_suffix(b"%") else {
		return false;
	};
	let Some((whole, fraction)) = body.split_last_chunk::<2>().map(|(w, f)| (w, *f)) else {
		return false;
	};
	(1..=3).contains(&whole.len())
		&& whole.iter().all(u8::is_ascii_digit)
		&& fraction[0] == b'.'
		&& fraction[1].is_ascii_digit()
}

/// The ASCII token as a JS `Number`, without the bytes `skip` names.
fn token_number(token: &[u8], skip: u8) -> f64 {
	let digits: String = token
		.iter()
		.filter(|byte| **byte != skip)
		.map(|byte| char::from(*byte))
		.collect();
	string_to_number(&digits)
}

/// Reads the TSE short-selling summary PDF (`readShortSellingPdf`): the four
/// amounts in token order, checked against their total and the three
/// printed percentages; `None` when the file does not parse.
#[must_use]
pub fn read_short_selling_pdf(bytes: &[u8]) -> Option<ShortSellingFigures> {
	let streams = pdf_streams(bytes)?;
	let tokens: Vec<Vec<u8>> = streams
		.iter()
		.filter(|stream| stream.iter().all(|byte| is_printable(*byte)))
		.flat_map(|stream| text_tokens(stream))
		.collect();
	let amounts: Vec<f64> = tokens
		.iter()
		.filter(|token| is_amount(token))
		.map(|token| token_number(token, b','))
		.collect();
	let percents: Vec<f64> = tokens
		.iter()
		.filter(|token| is_percent(token))
		.map(|token| token_number(token, b'%'))
		.collect();
	let [a, b, c, d] = <[f64; 4]>::try_from(amounts).ok()?;
	let [p1, p2, p3] = <[f64; 3]>::try_from(percents).ok()?;
	if d <= 0.0 || (a + b + c - d).abs() > 3.0 {
		return None;
	}
	for (p, x) in [(p1, a), (p2, b), (p3, c)] {
		if (p - 100.0 * x / d).abs() > 0.1 {
			return None;
		}
	}
	Some(ShortSellingFigures { a, b, c, d })
}

/* ---------------- margin workbooks ---------------- */

/// Column letters → 1-based index (A = 1, Z = 26, AA = 27).
fn column_index(letters: &str) -> Option<usize> {
	if letters.is_empty() {
		return None;
	}
	letters.bytes().try_fold(0usize, |index, byte| {
		byte.is_ascii_uppercase()
			.then(|| {
				index
					.checked_mul(26)?
					.checked_add(usize::from(byte - b'A') + 1)
			})
			.flatten()
	})
}

/// A number cell: its trimmed text is not empty and reads (JS `Number`) as a
/// finite integer ≥ 0.
fn number_cell(text: &str) -> Option<f64> {
	let text = trim(text);
	if text.is_empty() {
		return None;
	}
	let value = string_to_number(text);
	(value.is_finite() && value >= 0.0 && value.trunc() == value).then_some(value)
}

fn cell_at(row: &[WorkbookCell], column: usize) -> Option<&WorkbookCell> {
	row.iter()
		.find(|cell| column_index(&cell.column) == Some(column))
}

fn number_at(row: &[WorkbookCell], column: usize) -> Option<f64> {
	number_cell(&cell_at(row, column)?.text)
}

fn starts_with_at(row: &[WorkbookCell], column: usize, prefix: &str) -> bool {
	cell_at(row, column).is_some_and(|cell| cell.text.starts_with(prefix))
}

/// Reads one weekly margin workbook's sheet rows (`readMarginWeeklyWorkbook`):
/// the 二市場 (Tokyo & Nagoya) totals, when the sheet is dated `date`
/// (`YYYY-MM-DD`); `None` when it does not parse.
#[must_use]
pub fn read_margin_weekly_workbook(
	rows: &[Vec<WorkbookCell>],
	date: &str,
) -> Option<MarginFigures> {
	let (header_at, h) = rows.iter().enumerate().find_map(|(at, row)| {
		row.iter()
			.find(|cell| cell.text.contains("二市場"))
			.map(|cell| (at, column_index(&cell.column)))
	})?;
	let h = h?;
	let dated = rows.get(..header_at)?.iter().flatten().any(|cell| {
		number_cell(&cell.text)
			.and_then(|serial| excel_serial_to_iso_date(serial).ok())
			.is_some_and(|serial_date| serial_date == date)
	});
	if !dated {
		return None;
	}
	let after = rows.get(header_at + 1..)?;
	let column_of = |prefix: &str| {
		after.iter().flatten().find_map(|cell| {
			column_index(&cell.column)
				.filter(|column| *column >= h && cell.text.starts_with(prefix))
		})
	};
	let sell = column_of("売残高")?;
	let buy = column_of("買残高")?;
	let shares_at = rows.iter().position(|row| {
		row.iter()
			.any(|cell| cell.text.starts_with("信用取引残高合計"))
	})?;
	let shares_row = rows.get(shares_at)?;
	let value_row = rows.get(shares_at + 1)?;
	if !shares_row.iter().any(|cell| cell.text.starts_with("株数"))
		|| !value_row.iter().any(|cell| cell.text.starts_with("金額"))
	{
		return None;
	}
	Some(MarginFigures {
		sell_shares: number_at(shares_row, sell)?,
		sell_value: number_at(value_row, sell)?,
		buy_shares: number_at(shares_row, buy)?,
		buy_value: number_at(value_row, buy)?,
	})
}

/// Reads the margin history workbook's sheet rows (`readMarginHistoryWorkbook`):
/// the Tokyo & Nagoya section's weekly totals in row order (empty when it
/// does not parse).
#[must_use]
pub fn read_margin_history_workbook(rows: &[Vec<WorkbookCell>]) -> Vec<(String, MarginFigures)> {
	let header = rows.iter().enumerate().find_map(|(at, row)| {
		let column = |prefix: &str| {
			row.iter()
				.find(|cell| cell.text.starts_with(prefix))
				.and_then(|cell| column_index(&cell.column))
		};
		Some((at, column("株数(A)")?, column("株数(B)")?))
	});
	let Some((header_at, shares_a, shares_b)) = header else {
		return Vec::new();
	};
	let Some(header_row) = rows.get(header_at) else {
		return Vec::new();
	};
	if !starts_with_at(header_row, shares_a + 1, "金額")
		|| !starts_with_at(header_row, shares_b + 1, "金額")
	{
		return Vec::new();
	}
	let after = rows.get(header_at + 1..).unwrap_or_default();
	let Some(section_at) = after
		.iter()
		.position(|row| starts_with_at(row, 1, "[東京・名古屋"))
	else {
		return Vec::new();
	};
	let mut out = Vec::new();
	for row in after.get(section_at + 1..).unwrap_or_default() {
		if starts_with_at(row, 1, "[") {
			break;
		}
		let Some(date) = number_at(row, 1)
			.filter(|serial| HISTORY_SERIALS.contains(serial))
			.and_then(|serial| excel_serial_to_iso_date(serial).ok())
		else {
			continue;
		};
		let figures = (|| {
			Some(MarginFigures {
				sell_shares: number_at(row, shares_a)?,
				sell_value: number_at(row, shares_a + 1)?,
				buy_shares: number_at(row, shares_b)?,
				buy_value: number_at(row, shares_b + 1)?,
			})
		})();
		if let Some(figures) = figures {
			out.push((date, figures));
		}
	}
	out
}

/// A workbook's first sheet as rows, or `None` when it is not a readable workbook.
fn workbook_rows(bytes: &[u8]) -> Option<Vec<Vec<WorkbookCell>>> {
	let entries = read_zip_entries(bytes, &[SHEET, STRINGS]).ok()?;
	// `TextDecoder("utf-8")`: replacement characters, and a leading BOM dropped.
	let decode = |key: &str| {
		entries.get(key).map(|bytes| {
			let text = String::from_utf8_lossy(bytes);
			text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
		})
	};
	read_workbook_rows(&decode(SHEET)?, &decode(STRINGS)?).ok()
}

/* ---------------- source ---------------- */

/// The process-lifetime caches. The lock is held across downloads, so
/// requests stay sequential (JPX asks for that) and two series never fetch
/// the same file twice.
#[derive(Default)]
struct StatsCache {
	/// Page HTML and when it was fetched, by page URL.
	pages: HashMap<&'static str, (String, i64)>,
	/// Parsed short-selling PDFs by URL (`None`: did not parse).
	short_selling: HashMap<String, Option<ShortSellingFigures>>,
	/// Parsed weekly margin workbooks by URL (`None`: did not parse).
	margin_weekly: HashMap<String, Option<MarginFigures>>,
	/// Parsed history workbooks by URL (empty: did not parse).
	margin_history: HashMap<String, Vec<(String, MarginFigures)>>,
}

/// The `jpx` market series source: one object per runner process, its
/// caches shared by the three series.
pub struct JpxStatsSeriesSource {
	fetcher: Arc<dyn SafeFetcher>,
	binary: Arc<dyn SafeBinaryFetcher>,
	clock: Arc<dyn Clock>,
	cache: tokio::sync::Mutex<StatsCache>,
}

/// A download that failed: `RATE_LIMITED` when JPX answered 429, otherwise
/// `SOURCE_FAILED`, JPX's status kept unchanged (§4a).
fn fetch_failure(error: &SafeFetchError) -> MarketUnavailable {
	let status = upstream_status_of(error);
	let code = if status == Some(429) {
		Code::RateLimited
	} else {
		Code::SourceFailed
	};
	MarketUnavailable::new(code, MarketProviderId::Jpx, status)
}

fn unavailable(code: Code) -> MarketUnavailable {
	MarketUnavailable::new(code, MarketProviderId::Jpx, None)
}

fn meta(title: &str, unit: &str, frequency: MarketFrequency, source_url: &str) -> MarketSeriesMeta {
	MarketSeriesMeta {
		title: title.to_owned(),
		unit: unit.to_owned(),
		frequency,
		publisher: PUBLISHER.to_owned(),
		source_url: source_url.to_owned(),
	}
}

/// The finished answer, or `SOURCE_FAILED` without a point.
fn answer(
	meta: MarketSeriesMeta,
	points: Vec<SeriesPoint>,
	max_observations: usize,
) -> Result<SeriesData, MarketUnavailable> {
	if points.is_empty() {
		return Err(unavailable(Code::SourceFailed));
	}
	Ok(SeriesData {
		meta,
		observations: finish_points(points, max_observations),
	})
}

fn point(observed_on: String, value: f64) -> SeriesPoint {
	SeriesPoint {
		observed_on,
		value,
		bar: None,
	}
}

impl JpxStatsSeriesSource {
	/// Constructs the source with empty caches.
	pub fn new(
		fetcher: Arc<dyn SafeFetcher>,
		binary: Arc<dyn SafeBinaryFetcher>,
		clock: Arc<dyn Clock>,
	) -> Self {
		Self {
			fetcher,
			binary,
			clock,
			cache: tokio::sync::Mutex::new(StatsCache::default()),
		}
	}

	/// The page's HTML: cached for [`JPX_STATS_PAGE_TTL_MS`], else fetched
	/// (admitted first).
	async fn page(
		&self,
		cache: &mut StatsCache,
		url: &'static str,
		q: &SeriesQuery<'_>,
	) -> Result<String, MarketUnavailable> {
		let now = self.clock.now_ms();
		if let Some((html, _)) = cache
			.pages
			.get(url)
			.filter(|(_, at)| now.saturating_sub(*at) < JPX_STATS_PAGE_TTL_MS)
		{
			return Ok(html.clone());
		}
		admit_market_request(q.before_request, MarketProviderId::Jpx).await?;
		let options = fetch_options(JPX_STATS_HOST, "text/html", q.cancel);
		let html = self
			.fetcher
			.fetch_text(url, &options)
			.await
			.map_err(|error| fetch_failure(&error))?
			.text;
		cache.pages.insert(url, (html.clone(), now));
		Ok(html)
	}

	/// One file's bytes (admitted first).
	async fn download(
		&self,
		url: &str,
		accept: &str,
		max_bytes: usize,
		q: &SeriesQuery<'_>,
	) -> Result<Vec<u8>, MarketUnavailable> {
		admit_market_request(q.before_request, MarketProviderId::Jpx).await?;
		let mut options = fetch_options(JPX_STATS_HOST, accept, q.cancel);
		options.max_bytes = max_bytes;
		options.timeout_ms = FILE_TIMEOUT_MS;
		Ok(self
			.binary
			.fetch_bytes(url, &options)
			.await
			.map_err(|error| fetch_failure(&error))?
			.bytes)
	}

	async fn short_selling(&self, q: &SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		let mut cache = self.cache.lock().await;
		let html = self.page(&mut cache, JPX_SHORT_SELLING_URL, q).await?;
		let links = extract_short_selling_links(&html);
		if links.is_empty() {
			return Err(unavailable(Code::SourceFailed));
		}
		cache
			.short_selling
			.retain(|url, _| links.iter().any(|(listed, _)| listed == url));
		let mut points = Vec::new();
		for (url, date) in links {
			let figures = if let Some(figures) = cache.short_selling.get(&url) {
				*figures
			} else {
				let bytes = self
					.download(&url, PDF_TYPE, MAX_SHORT_SELLING_PDF_BYTES, q)
					.await?;
				// Inflating and scanning are CPU work.
				let figures = crate::cpu::offload(move || read_short_selling_pdf(&bytes)).await;
				cache.short_selling.insert(url, figures);
				figures
			};
			if let Some(figures) = figures {
				points.push(point(date, figures.ratio()));
			}
		}
		answer(
			meta(
				"Short-selling ratio (空売り比率), TSE",
				"Percent",
				MarketFrequency::Daily,
				JPX_SHORT_SELLING_URL,
			),
			points,
			q.max_observations,
		)
	}

	/// Margin figures by date: the history workbook's, overridden by the
	/// weekly workbooks' for the same date.
	async fn margin_figures(
		&self,
		q: &SeriesQuery<'_>,
	) -> Result<BTreeMap<String, MarginFigures>, MarketUnavailable> {
		let mut cache = self.cache.lock().await;
		let weekly_html = self.page(&mut cache, JPX_MARGIN_WEEKLY_URL, q).await?;
		let weekly_links = extract_margin_weekly_links(&weekly_html);
		if weekly_links.is_empty() {
			return Err(unavailable(Code::SourceFailed));
		}
		let history_html = self.page(&mut cache, JPX_MARGIN_HISTORY_URL, q).await?;
		let Some(history_url) = extract_margin_history_link(&history_html) else {
			return Err(unavailable(Code::SourceFailed));
		};
		cache
			.margin_weekly
			.retain(|url, _| weekly_links.iter().any(|(listed, _)| listed == url));
		cache.margin_history.retain(|url, _| *url == history_url);
		let history = if let Some(rows) = cache.margin_history.get(&history_url) {
			rows.clone()
		} else {
			let bytes = self
				.download(&history_url, XLSX_TYPE, MAX_ZIP_ARCHIVE_BYTES, q)
				.await?;
			let rows = crate::cpu::offload(move || {
				workbook_rows(&bytes)
					.map(|rows| read_margin_history_workbook(&rows))
					.unwrap_or_default()
			})
			.await;
			cache.margin_history.insert(history_url, rows.clone());
			rows
		};
		let mut weekly = Vec::new();
		for (url, date) in weekly_links {
			let figures = if let Some(figures) = cache.margin_weekly.get(&url) {
				*figures
			} else {
				let bytes = self
					.download(&url, XLSX_TYPE, MAX_ZIP_ARCHIVE_BYTES, q)
					.await?;
				let file_date = date.clone();
				let figures = crate::cpu::offload(move || {
					read_margin_weekly_workbook(&workbook_rows(&bytes)?, &file_date)
				})
				.await;
				cache.margin_weekly.insert(url, figures);
				figures
			};
			if let Some(figures) = figures {
				weekly.push((date, figures));
			}
		}
		let mut by_date: BTreeMap<String, MarginFigures> = history.into_iter().collect();
		by_date.extend(weekly);
		Ok(by_date)
	}
}

#[async_trait]
impl MarketSeriesSource for JpxStatsSeriesSource {
	fn provider_id(&self) -> MarketProviderId {
		MarketProviderId::Jpx
	}

	/// Everything JPX lists (`from` is ignored: JPX has no window).
	async fn fetch_series(&self, q: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		match q.symbol {
			SHORT_SELLING_RATIO => self.short_selling(&q).await,
			MARGIN_BUYING_VALUE => {
				let figures = self.margin_figures(&q).await?;
				answer(
					meta(
						"Margin buying balance (信用買い残), value, Tokyo & Nagoya",
						"Millions of Yen",
						MarketFrequency::Weekly,
						JPX_MARGIN_WEEKLY_URL,
					),
					figures
						.into_iter()
						.map(|(date, figures)| point(date, figures.buy_value))
						.collect(),
					q.max_observations,
				)
			}
			MARGIN_RATIO => {
				let figures = self.margin_figures(&q).await?;
				answer(
					meta(
						"Margin ratio (信用倍率), shares, Tokyo & Nagoya",
						"Times",
						MarketFrequency::Weekly,
						JPX_MARGIN_WEEKLY_URL,
					),
					figures
						.into_iter()
						.filter_map(|(date, figures)| Some(point(date, figures.ratio()?)))
						.collect(),
					q.max_observations,
				)
			}
			_ => Err(unavailable(Code::SeriesNotFound)),
		}
	}
}

#[cfg(test)]
#[path = "jpx_stats_tests.rs"]
mod tests;
