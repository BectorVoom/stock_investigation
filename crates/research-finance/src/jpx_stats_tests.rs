//! Readers against synthetic files (JPX's own files are never committed),
//! the source's caching, pacing and error mapping, and the market job's
//! `jpx` branch.
use super::*;
use crate::jobs::{RefreshDeps, execute_market_refresh};
use crate::pacing::MarketPacer;
use crate::ports::{AdmitRequest, MarketRequestAdmission};
use flate2::{Compression, write::ZlibEncoder};
use research_application::ports::{
	BinaryDocument, FetchedDocument, SafeFetchErrorCode, SafeFetchOptions,
};
use research_application::reporter::{PipelineReporter, ToolCallOutcome};
use research_contracts::jobs::{CompleteJobRequest, Lease, MarketRefreshJob, MarketRefreshSeries};
use research_contracts::market::MarketHistoryAnchor;
use research_domain::jobs::budget::ResourceUsage;
use research_domain::jobs::state_machine::JobState;
use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use tokio_util::sync::CancellationToken;

/* ---------- synthetic files ---------- */

fn zlib(bytes: &[u8]) -> Vec<u8> {
	let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
	encoder.write_all(bytes).unwrap();
	encoder.finish().unwrap()
}

/// A minimal PDF whose streams hold exactly these (already encoded) bytes.
fn pdf_of(streams: &[Vec<u8>]) -> Vec<u8> {
	let mut out = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
	for (index, data) in streams.iter().enumerate() {
		out.extend_from_slice(
			format!(
				"{} 0 obj\n<< /Length {} /Filter /FlateDecode >>\nstream\r\n",
				index + 1,
				data.len()
			)
			.as_bytes(),
		);
		out.extend_from_slice(data);
		out.extend_from_slice(b"\r\nendstream\nendobj\n");
	}
	out.extend_from_slice(b"trailer\n<< /Root 1 0 R >>\n%%EOF\n");
	out
}

/// The 2026-11-18 sample's figures as a content stream: a TJ split across
/// literals, a hex string, a dictionary, a literal outside BT…ET and
/// escapes around the tokens.
const CONTENT: &str = "q 1 0 0 1 0 0 cm\n\
	(9,999,999) Tj\n\
	BT /F1 9 Tf 10 700 Td (\\345\\256\\237) Tj ET\n\
	BT /F1 9 Tf <</MCID 0>> BDC 10 680 Td (4,925,148) Tj EMC ET\n\
	BT [(3,012,) -20 (856)] TJ ET\n\
	BT <3132> Tj (809,020) Tj ET\n\
	BT (8,747,\\\n024) Tj ET\n\
	BT (56.3%) Tj ET\n\
	BT (34\\0564%) Tj ET\n\
	BT (9.2%) Tj ET\n\
	BT (Total \\(all\\)) Tj ET\n\
	Q\n";

fn sample_pdf() -> Vec<u8> {
	// A font program: binary, holding a token that must not count.
	let mut font = b"BT (1,000,000) Tj ET ".to_vec();
	font.extend((0u8..=255).cycle().take(2048));
	pdf_of(&[zlib(&font), zlib(CONTENT.as_bytes())])
}

#[test]
fn reads_the_short_selling_figures() {
	let figures = read_short_selling_pdf(&sample_pdf()).unwrap();
	assert_eq!(
		figures,
		ShortSellingFigures {
			a: 4_925_148.0,
			b: 3_012_856.0,
			c: 809_020.0,
			d: 8_747_024.0,
		}
	);
	assert_eq!(figures.ratio(), 43.7);
}

#[test]
fn short_selling_ratios_round_like_math_round() {
	let ratio = |b: f64, c: f64, d: f64| ShortSellingFigures { a: 0.0, b, c, d }.ratio();
	// 352.5‰ rounds up (half away from zero = Math.round for positives).
	assert_eq!(ratio(3525.0, 0.0, 10_000.0), 35.3);
	assert_eq!(ratio(4210.0, 0.0, 10_000.0), 42.1);
}

#[test]
fn skips_corrupt_and_truncated_streams() {
	let mut extra = zlib(b"BT (1,111) Tj ET");
	extra.truncate(extra.len() - 4);
	let corrupt = b"x\x9c this is not deflate".to_vec();
	let pdf = pdf_of(&[extra, corrupt, zlib(CONTENT.as_bytes())]);
	assert_eq!(read_short_selling_pdf(&pdf).unwrap().ratio(), 43.7);
}

#[test]
fn ignores_bytes_after_the_zlib_stream_end() {
	let mut data = zlib(CONTENT.as_bytes());
	data.extend_from_slice(b"\n\n  trailing");
	assert_eq!(
		read_short_selling_pdf(&pdf_of(&[data])).unwrap().ratio(),
		43.7
	);
}

#[test]
fn a_file_past_the_inflate_cap_does_not_parse() {
	let big = vec![b' '; MAX_PDF_INFLATED_BYTES - CONTENT.len() + 1];
	let pdf = pdf_of(&[zlib(CONTENT.as_bytes()), zlib(&big)]);
	assert_eq!(read_short_selling_pdf(&pdf), None);
	let exactly = vec![b' '; MAX_PDF_INFLATED_BYTES - CONTENT.len()];
	let pdf = pdf_of(&[zlib(CONTENT.as_bytes()), zlib(&exactly)]);
	assert!(read_short_selling_pdf(&pdf).is_some());
}

#[test]
fn refuses_inconsistent_figures() {
	let without = |needle: &str, replacement: &str| {
		read_short_selling_pdf(&pdf_of(&[zlib(
			CONTENT.replace(needle, replacement).as_bytes(),
		)]))
	};
	// Three amounts.
	assert_eq!(without("(809,020) Tj", ""), None);
	// A total that is not the sum.
	assert_eq!(without("(8,747,\\\n024)", "(8,747,030)"), None);
	// A percentage off by more than 0.1.
	assert_eq!(without("(9.2%)", "(9.4%)"), None);
	// Two percentages.
	assert_eq!(without("(9.2%) Tj", ""), None);
	assert_eq!(read_short_selling_pdf(b"not a pdf"), None);
}

#[test]
fn literal_strings_follow_the_pdf_escapes() {
	let (bytes, next) = literal_string(b"a(b)c\\)\\n\\101\\7x\\q\\\r\nz) tail", 0);
	assert_eq!(bytes, b"a(b)c)\nA\x07xqz");
	assert_eq!(next, 23);
	assert_eq!(
		text_tokens(b"(out) BT (a) (b) ET BT ET xBT (c) ET BT\n(d)ET"),
		[b"ab".to_vec(), b"d".to_vec()]
	);
	assert!(is_amount(b"1,234") && is_amount(b"12,345,678") && !is_amount(b"1234"));
	assert!(!is_amount(b",123") && !is_amount(b"1,23") && !is_amount(b"1234,567"));
	assert!(is_percent(b"0.1%") && is_percent(b"100.0%"));
	assert!(!is_percent(b"1.23%") && !is_percent(b"1000.0%") && !is_percent(b".1%"));
}

/* ---------- workbooks ---------- */

fn cell(column: &str, text: &str) -> WorkbookCell {
	WorkbookCell {
		column: column.to_owned(),
		text: text.to_owned(),
	}
}

fn row(cells: &[(&str, &str)]) -> Vec<WorkbookCell> {
	cells
		.iter()
		.map(|(column, text)| cell(column, text))
		.collect()
}

/// The 20261113_mtcurrent.xlsx layout (two markets left, Tokyo right).
fn weekly_rows() -> Vec<Vec<WorkbookCell>> {
	vec![
		row(&[("B", "46339")]),
		row(&[("L", "(単位：千株、百万円）")]),
		row(&[("E", "二市場 Tokyo&Nagoya"), ("I", "東京 Tokyo")]),
		row(&[
			("E", "売残高・\n貸株残高\nSales"),
			("F", "前週比"),
			("G", "買残高・\n融資残高\nPurchases"),
			("I", "売残高・\n貸株残高\nSales"),
			("K", "買残高・\n融資残高\nPurchases"),
		]),
		row(&[
			("B", "制度信用取引残高"),
			("D", "株数Shs."),
			("E", "79690"),
			("G", "1595"),
		]),
		row(&[
			("B", "信用取引残高合計\nTotal"),
			("D", "株数Shs."),
			("E", "356858"),
			("G", "3396354"),
			("I", "356856"),
			("K", "3393654"),
		]),
		row(&[
			("D", "金額Val."),
			("E", "660000.0"),
			("G", " 5768159 "),
			("I", "659998"),
			("K", "5764651"),
		]),
	]
}

#[test]
fn reads_the_weekly_margin_totals() {
	assert_eq!(excel_serial_to_iso_date(46_339.0).unwrap(), "2026-11-13");
	let figures = read_margin_weekly_workbook(&weekly_rows(), "2026-11-13").unwrap();
	assert_eq!(
		figures,
		MarginFigures {
			sell_shares: 356_858.0,
			sell_value: 660_000.0,
			buy_shares: 3_396_354.0,
			buy_value: 5_768_159.0,
		}
	);
	assert_eq!(figures.ratio(), Some(9.52));
}

#[test]
fn refuses_a_weekly_workbook_that_does_not_fit() {
	let rows = weekly_rows();
	// Dated another week.
	assert_eq!(read_margin_weekly_workbook(&rows, "2026-11-06"), None);
	// A value that is not a number cell.
	let mut broken = rows.clone();
	broken[6][2].text = "-5".to_owned();
	assert_eq!(read_margin_weekly_workbook(&broken, "2026-11-13"), None);
	broken[6][2].text = String::new();
	assert_eq!(read_margin_weekly_workbook(&broken, "2026-11-13"), None);
	// No 金額 row under the totals.
	let mut short = rows.clone();
	short.pop();
	assert_eq!(read_margin_weekly_workbook(&short, "2026-11-13"), None);
	// No 二市場 header.
	let mut headless = rows;
	headless.remove(2);
	assert_eq!(read_margin_weekly_workbook(&headless, "2026-11-13"), None);
	assert_eq!(
		MarginFigures {
			sell_shares: 0.0,
			..figures_zero()
		}
		.ratio(),
		None
	);
}

fn figures_zero() -> MarginFigures {
	MarginFigures {
		sell_shares: 0.0,
		sell_value: 0.0,
		buy_shares: 1.0,
		buy_value: 0.0,
	}
}

fn history_rows() -> Vec<Vec<WorkbookCell>> {
	let data = |serial: &str, a: &str| {
		row(&[
			("A", serial),
			("B", "1"),
			("N", a),
			("O", "643859"),
			("P", "3654854"),
			("Q", "6505887"),
		])
	};
	vec![
		row(&[("A", "信用取引現在高"), ("Z", "46330")]),
		row(&[("N", "売残高"), ("P", "買残高")]),
		row(&[
			("B", "株数"),
			("C", "金額"),
			("N", "株数(A)"),
			("O", "金額"),
			("P", "株数(B)"),
			("Q", "金額"),
		]),
		data("46318", "1"),
		row(&[("A", "[東京・名古屋 Tokyo & Nagoya]")]),
		data("46318", "375064"),
		row(&[("A", "note")]),
		data("46325", "349230"),
		data("46326", "x"),
		data("36525", "1"),
		row(&[("A", "[東京 Tokyo]")]),
		data("46332", "1"),
	]
}

#[test]
fn reads_the_margin_history_section() {
	let rows = read_margin_history_workbook(&history_rows());
	assert_eq!(
		rows.iter()
			.map(|(date, _)| date.as_str())
			.collect::<Vec<_>>(),
		["2026-10-23", "2026-10-30"]
	);
	assert_eq!(
		rows[1].1,
		MarginFigures {
			sell_shares: 349_230.0,
			sell_value: 643_859.0,
			buy_shares: 3_654_854.0,
			buy_value: 6_505_887.0,
		}
	);
	let mut no_value_header = history_rows();
	no_value_header[2][3].text = "Value".to_owned();
	assert!(read_margin_history_workbook(&no_value_header).is_empty());
	assert!(read_margin_history_workbook(&weekly_rows()).is_empty());
}

#[test]
fn column_letters_are_one_based() {
	assert_eq!(column_index("A"), Some(1));
	assert_eq!(column_index("Z"), Some(26));
	assert_eq!(column_index("AA"), Some(27));
	assert_eq!(column_index(""), None);
	assert_eq!(column_index("a1"), None);
}

/// A stored (method 0) zip of these entries.
fn stored_zip(entries: &[(&str, &str)]) -> Vec<u8> {
	let mut out = Vec::new();
	let mut central = Vec::new();
	for (name, body) in entries {
		let offset = u32::try_from(out.len()).unwrap();
		let size = u32::try_from(body.len()).unwrap();
		let name_len = u16::try_from(name.len()).unwrap();
		out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
		out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		out.extend_from_slice(&size.to_le_bytes());
		out.extend_from_slice(&size.to_le_bytes());
		out.extend_from_slice(&name_len.to_le_bytes());
		out.extend_from_slice(&0u16.to_le_bytes());
		out.extend_from_slice(name.as_bytes());
		out.extend_from_slice(body.as_bytes());
		central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
		central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		central.extend_from_slice(&size.to_le_bytes());
		central.extend_from_slice(&size.to_le_bytes());
		central.extend_from_slice(&name_len.to_le_bytes());
		central.extend_from_slice(&[0; 12]);
		central.extend_from_slice(&offset.to_le_bytes());
		central.extend_from_slice(name.as_bytes());
	}
	let directory_at = u32::try_from(out.len()).unwrap();
	let count = u16::try_from(entries.len()).unwrap();
	let directory_len = u32::try_from(central.len()).unwrap();
	out.extend_from_slice(&central);
	out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
	out.extend_from_slice(&[0, 0, 0, 0]);
	out.extend_from_slice(&count.to_le_bytes());
	out.extend_from_slice(&count.to_le_bytes());
	out.extend_from_slice(&directory_len.to_le_bytes());
	out.extend_from_slice(&directory_at.to_le_bytes());
	out.extend_from_slice(&0u16.to_le_bytes());
	out
}

/// An `.xlsx` whose sheet holds `rows`, every cell a shared string.
fn workbook_of(rows: &[Vec<WorkbookCell>]) -> Vec<u8> {
	let mut strings = String::from("<?xml version=\"1.0\"?><sst>");
	let mut sheet = String::from("<?xml version=\"1.0\"?><worksheet><sheetData>");
	let mut index = 0;
	for (at, row) in rows.iter().enumerate() {
		sheet.push_str(&format!("<row r=\"{}\">", at + 1));
		for cell in row {
			let text = cell.text.replace('&', "&amp;").replace('<', "&lt;");
			strings.push_str(&format!("<si><t xml:space=\"preserve\">{text}</t></si>"));
			sheet.push_str(&format!(
				"<c r=\"{}{}\" t=\"s\"><v>{index}</v></c>",
				cell.column,
				at + 1
			));
			index += 1;
		}
		sheet.push_str("</row>");
	}
	strings.push_str("</sst>");
	sheet.push_str("</sheetData></worksheet>");
	stored_zip(&[(SHEET, &sheet), (STRINGS, &strings)])
}

#[test]
fn reads_rows_through_the_workbook_reader() {
	let rows = workbook_rows(&workbook_of(&weekly_rows())).unwrap();
	assert_eq!(
		read_margin_weekly_workbook(&rows, "2026-11-13")
			.unwrap()
			.ratio(),
		Some(9.52)
	);
	assert_eq!(workbook_rows(b"PK not a zip"), None);
}

/* ---------- links ---------- */

#[test]
fn extracts_the_listed_files() {
	let mut html = String::from(
		"<a href=\"/markets/statistics-equities/short-selling/x-att/261118-m.pdf\">a</a>\
		 <a href=\"/markets/statistics-equities/short-selling/x-att/261118-g.pdf\">g</a>\
		 <a href=\"https://www.jpx.co.jp/markets/statistics-equities/short-selling/x-att/261118-m.pdf?v=2#p\">dup</a>\
		 <a href=\"https://example.com/markets/statistics-equities/short-selling/x-att/261117-m.pdf\">host</a>\
		 <a href=\"http://www.jpx.co.jp/markets/statistics-equities/short-selling/x-att/261117-m.pdf\">http</a>\
		 <a href=\"/markets/statistics-equities/short-selling/x-att/261332-m.pdf\">bad date</a>\
		 <a href='x-att/261117-m.pdf'>relative</a>",
	);
	for day in 1..=12 {
		html.push_str(&format!(
			"<a href=\"/markets/statistics-equities/short-selling/y/2610{day:02}-m.pdf\">d</a>"
		));
	}
	let links = extract_short_selling_links(&html);
	assert_eq!(links.len(), MAX_SHORT_SELLING_FILES);
	assert_eq!(
		links[0],
		(
			"https://www.jpx.co.jp/markets/statistics-equities/short-selling/x-att/261118-m.pdf"
				.to_owned(),
			"2026-11-18".to_owned()
		)
	);
	assert_eq!(links[1].1, "2026-11-17");
	assert_eq!(links[2].1, "2026-10-01");
	assert_eq!(links[9].1, "2026-10-08");

	let weekly = extract_margin_weekly_links(
		"<a href=\"/markets/statistics-equities/margin/t-att/20261113_mtcurrent.xlsx\">x</a>\
		 <a href=\"/markets/statistics-equities/margin/t-att/20261113_mtcurrent.pdf\">p</a>\
		 <a href=\"/markets/statistics-equities/margin/t-att/20260230_mtcurrent.xlsx\">bad</a>",
	);
	assert_eq!(weekly.len(), 1);
	assert_eq!(weekly[0].1, "2026-11-13");
	assert_eq!(
		extract_margin_history_link(
			"<a href=\"/markets/statistics-equities/margin/t-att/hist0001.pdf\">p</a>\
			 <a href=\"/markets/statistics-equities/margin/t-att/hist0001.xlsx\">x</a>\
			 <a href=\"/markets/statistics-equities/margin/t-att/20260925_mtgk.xls\">xls</a>"
		)
		.as_deref(),
		Some("https://www.jpx.co.jp/markets/statistics-equities/margin/t-att/hist0001.xlsx")
	);
}

/* ---------- source ---------- */

struct TestClock(AtomicI64);
impl Clock for TestClock {
	fn now_ms(&self) -> i64 {
		self.0.load(Ordering::SeqCst)
	}
	fn now_iso(&self) -> String {
		"2026-11-19T00:00:00.000Z".to_owned()
	}
}

/// Answers by URL (text pages and binary files alike) and records each request.
#[derive(Default)]
struct Jpx {
	answers: Mutex<HashMap<String, Result<Vec<u8>, u16>>>,
	requests: Mutex<Vec<String>>,
}
impl Jpx {
	fn set(&self, url: &str, answer: Result<Vec<u8>, u16>) {
		self.answers.lock().unwrap().insert(url.to_owned(), answer);
	}
	fn take(&self) -> Vec<String> {
		std::mem::take(&mut *self.requests.lock().unwrap())
	}
	fn answer(&self, url: &str, options: &SafeFetchOptions) -> Result<Vec<u8>, SafeFetchError> {
		assert_eq!(
			options.allowed_hosts,
			Some([JPX_STATS_HOST.to_owned()].into())
		);
		self.requests.lock().unwrap().push(url.to_owned());
		match self.answers.lock().unwrap().get(url).cloned() {
			Some(Ok(bytes)) => Ok(bytes),
			Some(Err(status)) => {
				let mut error = SafeFetchError::new(SafeFetchErrorCode::HttpError, "status");
				error.status = Some(status);
				Err(error)
			}
			None => Err(SafeFetchError::new(
				SafeFetchErrorCode::NetworkError,
				"offline",
			)),
		}
	}
}
#[async_trait]
impl SafeFetcher for Jpx {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		assert_eq!(options.accept, "text/html");
		let bytes = self.answer(url, options)?;
		Ok(FetchedDocument {
			final_url: url.to_owned(),
			content_type: Some("text/html".to_owned()),
			text: String::from_utf8(bytes).unwrap(),
		})
	}
}
#[async_trait]
impl SafeBinaryFetcher for Jpx {
	async fn fetch_bytes(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<BinaryDocument, SafeFetchError> {
		assert_eq!(options.timeout_ms, FILE_TIMEOUT_MS);
		if url.ends_with(".pdf") {
			assert_eq!(options.accept, PDF_TYPE);
			assert_eq!(options.max_bytes, MAX_SHORT_SELLING_PDF_BYTES);
		} else {
			assert_eq!(options.accept, XLSX_TYPE);
			assert_eq!(options.max_bytes, MAX_ZIP_ARCHIVE_BYTES);
		}
		Ok(BinaryDocument {
			final_url: url.to_owned(),
			content_type: None,
			bytes: self.answer(url, options)?,
		})
	}
}

#[derive(Default)]
struct Admissions {
	answers: Vec<MarketRequestAdmission>,
	asked: Mutex<usize>,
}
impl Admissions {
	fn asked(&self) -> usize {
		*self.asked.lock().unwrap()
	}
}
#[async_trait]
impl AdmitRequest for Admissions {
	async fn admit(&self) -> MarketRequestAdmission {
		let mut asked = self.asked.lock().unwrap();
		let answer = self
			.answers
			.get(*asked)
			.copied()
			.unwrap_or(MarketRequestAdmission::Granted);
		*asked += 1;
		answer
	}
}

const PDF_A: &str =
	"https://www.jpx.co.jp/markets/statistics-equities/short-selling/a-att/261118-m.pdf";
const PDF_B: &str =
	"https://www.jpx.co.jp/markets/statistics-equities/short-selling/b-att/261117-m.pdf";
const WEEK_A: &str =
	"https://www.jpx.co.jp/markets/statistics-equities/margin/w-att/20261113_mtcurrent.xlsx";
const WEEK_B: &str =
	"https://www.jpx.co.jp/markets/statistics-equities/margin/w-att/20261106_mtcurrent.xlsx";
const HISTORY: &str = "https://www.jpx.co.jp/markets/statistics-equities/margin/h-att/hist01.xlsx";

fn index_html(urls: &[&str]) -> Vec<u8> {
	urls.iter()
		.map(|url| format!("<a href=\"{url}\">file</a>"))
		.collect::<String>()
		.into_bytes()
}

fn source() -> (JpxStatsSeriesSource, Arc<Jpx>, Arc<TestClock>) {
	let jpx = Arc::new(Jpx::default());
	let clock = Arc::new(TestClock(AtomicI64::new(1_800_000_000_000)));
	let source = JpxStatsSeriesSource::new(jpx.clone(), jpx.clone(), clock.clone());
	(source, jpx, clock)
}

async fn fetch(
	source: &JpxStatsSeriesSource,
	symbol: &str,
	gate: &Admissions,
) -> Result<SeriesData, MarketUnavailable> {
	let cancel = CancellationToken::new();
	source
		.fetch_series(SeriesQuery {
			symbol,
			from: Some("2026-11-01"),
			max_observations: 800,
			cancel: &cancel,
			before_request: gate,
		})
		.await
}

#[tokio::test]
async fn short_selling_reads_each_file_once_and_skips_one_that_does_not_parse() {
	let (source, jpx, clock) = source();
	jpx.set(JPX_SHORT_SELLING_URL, Ok(index_html(&[PDF_A, PDF_B])));
	jpx.set(PDF_A, Ok(sample_pdf()));
	jpx.set(PDF_B, Ok(b"%PDF-1.4 broken".to_vec()));
	let gate = Admissions::default();
	let data = fetch(&source, SHORT_SELLING_RATIO, &gate).await.unwrap();
	assert_eq!(jpx.take(), [JPX_SHORT_SELLING_URL, PDF_A, PDF_B]);
	assert_eq!(gate.asked(), 3);
	assert_eq!(data.observations, [point("2026-11-18".to_owned(), 43.7)]);
	assert_eq!(data.meta.title, "Short-selling ratio (空売り比率), TSE");
	assert_eq!(data.meta.unit, "Percent");
	assert_eq!(data.meta.frequency, MarketFrequency::Daily);
	assert_eq!(data.meta.publisher, "Japan Exchange Group (JPX)");
	assert_eq!(data.meta.source_url, JPX_SHORT_SELLING_URL);
	assert!(crate::market_fetch::valid_meta(&data.meta));

	// Every part cached: nothing sent, no grant taken.
	let cached = Admissions::default();
	assert_eq!(
		fetch(&source, SHORT_SELLING_RATIO, &cached).await.unwrap(),
		data
	);
	assert!(jpx.take().is_empty());
	assert_eq!(cached.asked(), 0);

	// The page expires after three hours; the files stay cached.
	clock.0.fetch_add(JPX_STATS_PAGE_TTL_MS, Ordering::SeqCst);
	let later = Admissions::default();
	assert!(fetch(&source, SHORT_SELLING_RATIO, &later).await.is_ok());
	assert_eq!(jpx.take(), [JPX_SHORT_SELLING_URL]);
	assert_eq!(later.asked(), 1);
}

#[tokio::test]
async fn a_file_no_longer_listed_leaves_the_cache() {
	let (source, jpx, clock) = source();
	jpx.set(JPX_SHORT_SELLING_URL, Ok(index_html(&[PDF_A])));
	jpx.set(PDF_A, Ok(sample_pdf()));
	assert!(
		fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
			.await
			.is_ok()
	);
	jpx.set(JPX_SHORT_SELLING_URL, Ok(index_html(&[PDF_B])));
	jpx.set(PDF_B, Ok(sample_pdf()));
	clock.0.fetch_add(JPX_STATS_PAGE_TTL_MS, Ordering::SeqCst);
	assert!(
		fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
			.await
			.is_ok()
	);
	jpx.set(JPX_SHORT_SELLING_URL, Ok(index_html(&[PDF_A, PDF_B])));
	clock.0.fetch_add(JPX_STATS_PAGE_TTL_MS, Ordering::SeqCst);
	jpx.take();
	let data = fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
		.await
		.unwrap();
	assert_eq!(jpx.take(), [JPX_SHORT_SELLING_URL, PDF_A]);
	assert_eq!(data.observations.len(), 2);
}

#[tokio::test]
async fn jpx_429_is_rate_limited_with_its_status_and_nothing_is_cached() {
	let (source, jpx, _) = source();
	jpx.set(JPX_SHORT_SELLING_URL, Ok(index_html(&[PDF_A])));
	jpx.set(PDF_A, Err(429));
	let error = fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(error.code, Code::RateLimited);
	assert_eq!(error.upstream_status, Some(429));
	jpx.take();
	jpx.set(PDF_A, Err(503));
	let error = fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(jpx.take(), [PDF_A]);
	assert_eq!(error.code, Code::SourceFailed);
	assert_eq!(error.upstream_status, Some(503));
	jpx.set(PDF_A, Ok(sample_pdf()));
	assert!(
		fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
			.await
			.is_ok()
	);
}

#[tokio::test]
async fn page_failures_and_empty_pages_fail_the_series() {
	let (source, jpx, _) = source();
	let error = fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(
		(error.code, error.upstream_status),
		(Code::SourceFailed, None)
	);
	jpx.set(JPX_SHORT_SELLING_URL, Err(500));
	let error = fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(
		(error.code, error.upstream_status),
		(Code::SourceFailed, Some(500))
	);
	jpx.set(JPX_SHORT_SELLING_URL, Ok(b"<p>no links</p>".to_vec()));
	let error = fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(
		(error.code, error.upstream_status),
		(Code::SourceFailed, None)
	);
	// A listed file that does not parse, and nothing else: no point.
	let (source, jpx, _) = source_with_index(&[PDF_B]);
	jpx.set(PDF_B, Ok(Vec::new()));
	let error = fetch(&source, SHORT_SELLING_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(
		(error.code, error.upstream_status),
		(Code::SourceFailed, None)
	);
}

fn source_with_index(urls: &[&str]) -> (JpxStatsSeriesSource, Arc<Jpx>, Arc<TestClock>) {
	let (source, jpx, clock) = source();
	jpx.set(JPX_SHORT_SELLING_URL, Ok(index_html(urls)));
	(source, jpx, clock)
}

#[tokio::test]
async fn a_refused_admission_sends_nothing() {
	let (source, jpx, _) = source_with_index(&[PDF_A]);
	let spent = Admissions {
		answers: vec![MarketRequestAdmission::BudgetSpent],
		..Admissions::default()
	};
	let error = fetch(&source, SHORT_SELLING_RATIO, &spent)
		.await
		.unwrap_err();
	assert_eq!(
		(error.code, error.upstream_status),
		(Code::RateLimited, None)
	);
	assert!(jpx.take().is_empty());
	let stopped = Admissions {
		answers: vec![
			MarketRequestAdmission::Granted,
			MarketRequestAdmission::Stopped,
		],
		..Admissions::default()
	};
	assert!(fetch(&source, SHORT_SELLING_RATIO, &stopped).await.is_err());
	assert_eq!(jpx.take(), [JPX_SHORT_SELLING_URL]);
}

#[tokio::test]
async fn margin_series_share_the_downloads_and_weekly_files_override_the_history() {
	let (source, jpx, _) = source();
	jpx.set(JPX_MARGIN_WEEKLY_URL, Ok(index_html(&[WEEK_A, WEEK_B])));
	jpx.set(WEEK_A, Ok(workbook_of(&weekly_rows())));
	jpx.set(WEEK_B, Ok(b"PK broken".to_vec()));
	jpx.set(JPX_MARGIN_HISTORY_URL, Ok(index_html(&[HISTORY])));
	let mut history = history_rows();
	// The history's 2026-11-13 differs from the weekly file's.
	history.insert(
		8,
		row(&[
			("A", "46339"),
			("N", "1"),
			("O", "2"),
			("P", "3"),
			("Q", "4"),
		]),
	);
	jpx.set(HISTORY, Ok(workbook_of(&history)));
	let gate = Admissions::default();
	let value = fetch(&source, MARGIN_BUYING_VALUE, &gate).await.unwrap();
	assert_eq!(
		jpx.take(),
		[
			JPX_MARGIN_WEEKLY_URL,
			JPX_MARGIN_HISTORY_URL,
			HISTORY,
			WEEK_A,
			WEEK_B
		]
	);
	assert_eq!(gate.asked(), 5);
	assert_eq!(
		value.observations,
		[
			point("2026-10-23".to_owned(), 6_505_887.0),
			point("2026-10-30".to_owned(), 6_505_887.0),
			point("2026-11-13".to_owned(), 5_768_159.0),
		]
	);
	assert_eq!(
		value.meta.title,
		"Margin buying balance (信用買い残), value, Tokyo & Nagoya"
	);
	assert_eq!(value.meta.unit, "Millions of Yen");
	assert_eq!(value.meta.frequency, MarketFrequency::Weekly);
	assert_eq!(value.meta.source_url, JPX_MARGIN_WEEKLY_URL);
	assert!(crate::market_fetch::valid_meta(&value.meta));

	let cached = Admissions::default();
	let ratio = fetch(&source, MARGIN_RATIO, &cached).await.unwrap();
	assert!(jpx.take().is_empty());
	assert_eq!(cached.asked(), 0);
	assert_eq!(
		ratio.observations.last(),
		Some(&point("2026-11-13".to_owned(), 9.52))
	);
	assert_eq!(
		ratio.meta.title,
		"Margin ratio (信用倍率), shares, Tokyo & Nagoya"
	);
	assert_eq!(ratio.meta.unit, "Times");
	assert!(crate::market_fetch::valid_meta(&ratio.meta));
}

#[tokio::test]
async fn margin_needs_both_pages() {
	let (source, jpx, _) = source();
	jpx.set(JPX_MARGIN_WEEKLY_URL, Ok(index_html(&[WEEK_A])));
	jpx.set(WEEK_A, Ok(workbook_of(&weekly_rows())));
	jpx.set(JPX_MARGIN_HISTORY_URL, Ok(b"none".to_vec()));
	let error = fetch(&source, MARGIN_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(
		(error.code, error.upstream_status),
		(Code::SourceFailed, None)
	);
	let (source, jpx2, _) = source_margin_empty();
	let error = fetch(&source, MARGIN_RATIO, &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(error.code, Code::SourceFailed);
	assert_eq!(jpx2.take(), [JPX_MARGIN_WEEKLY_URL]);
	let error = fetch(&source, "OTHER", &Admissions::default())
		.await
		.unwrap_err();
	assert_eq!(error.code, Code::SeriesNotFound);
}

fn source_margin_empty() -> (JpxStatsSeriesSource, Arc<Jpx>, Arc<TestClock>) {
	let (source, jpx, clock) = source();
	jpx.set(
		JPX_MARGIN_WEEKLY_URL,
		Ok(b"<a href=\"/x.xlsx\">x</a>".to_vec()),
	);
	(source, jpx, clock)
}

/* ---------- the market job's jpx branch ---------- */

/// Records every query's `from` and answers one point.
#[derive(Default)]
struct RecordingSource {
	froms: Mutex<Vec<Option<String>>>,
}
#[async_trait]
impl MarketSeriesSource for RecordingSource {
	fn provider_id(&self) -> MarketProviderId {
		MarketProviderId::Jpx
	}
	async fn fetch_series(&self, q: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		self.froms.lock().unwrap().push(q.from.map(str::to_owned));
		assert_eq!(
			q.before_request.admit().await,
			MarketRequestAdmission::Granted
		);
		// Not the anchor's value: a windowed refresh would refetch in full.
		Ok(SeriesData {
			meta: meta(
				"t",
				"Percent",
				MarketFrequency::Daily,
				JPX_SHORT_SELLING_URL,
			),
			observations: vec![
				point("2026-11-17".to_owned(), 40.0),
				point("2026-11-18".to_owned(), 43.7),
			],
		})
	}
}

struct OpenPacer;
#[async_trait]
impl MarketPacer for OpenPacer {
	async fn pace(&self, provider: &str, _: &CancellationToken, _: Option<usize>) -> bool {
		assert_eq!(provider, "jpx");
		true
	}
}

struct QuietReporter;
#[async_trait]
impl PipelineReporter for QuietReporter {
	async fn state(&self, _: JobState) {}
	async fn note(&self, _: &str) {}
	async fn tool(&self, _: &str, _: ToolCallOutcome, _: &str) {}
	async fn usage(&self, _: &ResourceUsage) {}
}

#[tokio::test]
async fn the_market_job_fetches_a_jpx_series_once_and_merges_it() {
	let recording = Arc::new(RecordingSource::default());
	let sources: HashMap<String, Arc<dyn MarketSeriesSource>> = HashMap::from([(
		"jpx".to_owned(),
		recording.clone() as Arc<dyn MarketSeriesSource>,
	)]);
	let earnings = HashMap::new();
	let clock = TestClock(AtomicI64::new(0));
	let logger = research_effects::SilentEventLogger;
	let deps = RefreshDeps {
		clock: &clock,
		logger: &logger,
		pacer: &OpenPacer,
		market_sources: &sources,
		earnings_sources: &earnings,
	};
	let job = MarketRefreshJob {
		lease: Lease {
			run_id: "run".to_owned(),
			lease_generation: 1,
			lease_expires_at: "2026-11-19T00:10:00.000Z".to_owned(),
			attempt: 1,
			heartbeat_interval_ms: 1000,
			sources: Vec::new(),
		},
		series: vec![MarketRefreshSeries {
			series_id: "jpx:SHORT_SELLING_RATIO".to_owned(),
			latest_observed_on: Some("2026-11-17".to_owned()),
			anchor: Some(MarketHistoryAnchor {
				observed_on: "2026-11-17".to_owned(),
				value: 41.0,
			}),
			full_check: false,
		}],
	};
	let cancel = CancellationToken::new();
	let completion = execute_market_refresh(&job, &deps, &cancel, &QuietReporter).await;
	assert_eq!(*recording.froms.lock().unwrap(), [None]);
	let CompleteJobRequest::MarketRefreshed { series, .. } = completion else {
		panic!("not a market completion");
	};
	assert_eq!(series.len(), 1);
	assert_eq!(series[0].history, None);
	assert_eq!(series[0].error_code, None);
	assert_eq!(series[0].observations.len(), 2);
	assert!(series[0].meta.is_some());
}

/* ---------- JPX's own samples (local only) ---------- */

/// Reads the owner's local copies of JPX's files when
/// `JPX_STATS_SAMPLES_DIR` names their directory; skipped otherwise.
#[test]
fn reads_local_jpx_samples_when_present() {
	let Some(dir) = std::env::var_os("JPX_STATS_SAMPLES_DIR") else {
		return;
	};
	let dir = std::path::PathBuf::from(dir);
	let read = |name: &str| std::fs::read(dir.join(name)).unwrap();
	for (name, expected) in [
		("ss-m.pdf", 43.7),
		("261106-m.pdf", 35.3),
		("261110-m.pdf", 42.7),
		("261116-m.pdf", 42.1),
	] {
		let figures = read_short_selling_pdf(&read(name)).unwrap();
		println!("{name}: {figures:?} -> {}", figures.ratio());
		assert_eq!(figures.ratio(), expected, "{name}");
	}
	let ss = read_short_selling_pdf(&read("ss-m.pdf")).unwrap();
	assert_eq!(
		ss,
		ShortSellingFigures {
			a: 4_925_148.0,
			b: 3_012_856.0,
			c: 809_020.0,
			d: 8_747_024.0
		}
	);
	let current = read_margin_weekly_workbook(
		&workbook_rows(&read("mtcurrent.xlsx")).unwrap(),
		"2026-11-13",
	)
	.unwrap();
	println!("mtcurrent: {current:?} -> {:?}", current.ratio());
	assert_eq!(
		current,
		MarginFigures {
			sell_shares: 356_858.0,
			sell_value: 660_000.0,
			buy_shares: 3_396_354.0,
			buy_value: 5_768_159.0
		}
	);
	assert_eq!(current.ratio(), Some(9.52));
	let previous =
		read_margin_weekly_workbook(&workbook_rows(&read("mt1106.xlsx")).unwrap(), "2026-11-06")
			.unwrap();
	println!("mt1106: {previous:?}");
	assert_eq!(
		previous,
		MarginFigures {
			sell_shares: 332_419.0,
			sell_value: 613_486.0,
			buy_shares: 3_460_691.0,
			buy_value: 5_880_994.0
		}
	);
	let history = read_margin_history_workbook(&workbook_rows(&read("mthist.xlsx")).unwrap());
	println!("mthist: {history:?}");
	assert_eq!(history.len(), 6);
	assert_eq!(history[0].0, "2026-09-25");
	assert_eq!(
		history[5],
		(
			"2026-10-30".to_owned(),
			MarginFigures {
				sell_shares: 349_230.0,
				sell_value: 643_859.0,
				buy_shares: 3_654_854.0,
				buy_value: 6_505_887.0
			}
		)
	);
	for (page, count) in [("ss.html", 10), ("m04.html", 5)] {
		let html = String::from_utf8(read(page)).unwrap();
		let links = if page == "ss.html" {
			extract_short_selling_links(&html)
		} else {
			extract_margin_weekly_links(&html)
		};
		println!("{page}: {links:?}");
		assert_eq!(links.len(), count);
	}
	let m05 = String::from_utf8(read("m05.html")).unwrap();
	println!("m05.html: {:?}", extract_margin_history_link(&m05));
	assert!(extract_margin_history_link(&m05).is_some());
}
