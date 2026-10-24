//! The Japanese stock directory (port of `jpxDirectory.ts`, ADR-0034): JPX's
//! monthly "List of TSE-listed Issues", `data_j.xlsx` and `data_e.xlsx`, each
//! linked from its own page (the `…-att` folder is read from the page, never
//! hard-coded). The Japanese list decides which issues are kept (Prime,
//! Standard and Growth, domestic and foreign); `localName` is 銘柄名 and
//! `name` the English name joined on the code (the Japanese name when the
//! English list lacks the code). A name that cannot be stored is replaced by
//! the other language's name when that fits, otherwise the row is dropped
//! (counted, never named). `asOf` is the list's date when every kept row
//! states the same valid one.
//!
//! Politeness (ADR-0016): four requests per refresh (page, workbook, page,
//! workbook), one after another, each admitted by the shared JPX window; the
//! Japanese workbook is parsed before the English page is asked for.
use crate::{
	jpx_workbook::{WorkbookCell, read_workbook_rows},
	market_fetch::fetch_options,
	ports::{DroppedRowsHook, StockDirectoryData, StockDirectoryQuery, StockDirectorySource},
	stock_directory::{
		ParsedStockDirectory, directory_fetch_failure, finish_directory, fits_directory_name,
	},
	zip_reader::{MAX_ZIP_ARCHIVE_BYTES, read_zip_entries},
};
use async_trait::async_trait;
use research_application::ports::{SafeBinaryFetcher, SafeFetcher};
use research_contracts::stock_directory::{
	StockDirectoryEntry, StockDirectoryFailureCode, StockListing,
};
use research_contracts::watchlist::{WatchMarket, parse_stock_id};
use research_domain::calendar::civil_date::is_valid_iso_date;
use research_js::whitespace::trim;
use serde::Serialize;
use std::{
	collections::{HashMap, HashSet},
	sync::{Arc, LazyLock},
};

const JPX_HOST: &str = "www.jpx.co.jp";
const SHEET: &str = "xl/worksheets/sheet1.xml";
const STRINGS: &str = "xl/sharedStrings.xml";
const XLSX_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORKBOOK_TIMEOUT_MS: u64 = 60_000;

/// Which of the two lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JpxListingLanguage {
	/// `data_j.xlsx`.
	Ja,
	/// `data_e.xlsx`.
	En,
}

impl JpxListingLanguage {
	/// The TypeScript literal (`"ja"`, `"en"`).
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Ja => "ja",
			Self::En => "en",
		}
	}

	/// The language named `value`, if any.
	#[must_use]
	pub fn from_str_value(value: &str) -> Option<Self> {
		match value {
			"ja" => Some(Self::Ja),
			"en" => Some(Self::En),
			_ => None,
		}
	}

	/// The page that links this list (`JPX_LISTING_PAGE_URLS`).
	#[must_use]
	pub const fn page_url(self) -> &'static str {
		match self {
			Self::Ja => "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html",
			Self::En => "https://www.jpx.co.jp/english/markets/statistics-equities/misc/01.html",
		}
	}

	/// Header texts (exact, after trimming): date, code, name, section.
	const fn headers(self) -> [&'static str; 4] {
		match self {
			Self::Ja => ["日付", "コード", "銘柄名", "市場・商品区分"],
			Self::En => [
				"Effective Date",
				"Local Code",
				"Name (English)",
				"Section/Products",
			],
		}
	}
}

static JA_PATH: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
	regex::Regex::new(r"^/markets/statistics-equities/misc/[A-Za-z0-9_-]+/data_j\.xlsx$").ok()
});
static EN_PATH: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
	regex::Regex::new(r"^/english/markets/statistics-equities/misc/[A-Za-z0-9_-]+/data_e\.xlsx$")
		.ok()
});

/// 市場・商品区分 (exact) as the listing kept; every other section is dropped.
#[must_use]
pub fn jpx_directory_listing(section: &str) -> Option<StockListing> {
	match section {
		"プライム（内国株式）" | "プライム（外国株式）" => {
			Some(StockListing::TsePrime)
		}
		"スタンダード（内国株式）" | "スタンダード（外国株式）" => {
			Some(StockListing::TseStandard)
		}
		"グロース（内国株式）" | "グロース（外国株式）" => {
			Some(StockListing::TseGrowth)
		}
		_ => None,
	}
}

/// The list's workbook link on its page: the first `<a href>` that resolves
/// to `https://www.jpx.co.jp` with the language's path shape, without query
/// or fragment.
#[must_use]
pub fn extract_jpx_listing_url(html: &str, language: JpxListingLanguage) -> Option<String> {
	let path = match language {
		JpxListingLanguage::Ja => JA_PATH.as_ref(),
		JpxListingLanguage::En => EN_PATH.as_ref(),
	}?;
	let base = url::Url::parse(language.page_url()).ok()?;
	crate::jpx::anchor_hrefs(html).into_iter().find_map(|raw| {
		let url = base.join(raw).ok()?;
		(url.scheme() == "https" && url.host_str() == Some(JPX_HOST) && path.is_match(url.path()))
			.then(|| format!("{}{}", url.origin().ascii_serialization(), url.path()))
	})
}

/// One issue as a list states it (texts trimmed; the code upper-cased).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct JpxListingRow {
	/// Local code.
	pub code: String,
	/// 銘柄名 or Name (English).
	pub name: String,
	/// 市場・商品区分 or Section/Products.
	pub section: String,
	/// The raw 日付 / Effective Date text.
	pub date: String,
}

fn text_at<'a>(cells: &'a [WorkbookCell], column: &str) -> &'a str {
	cells
		.iter()
		.find(|cell| cell.column == column)
		.map_or("", |cell| trim(&cell.text))
}

/// The issues of one list's sheet rows (`jpxListingRows`): the header row is
/// the first row naming all four columns; later rows whose code is not a JP
/// code are skipped.
///
/// # Errors
/// `DIRECTORY_PARSE_FAILED` when no row names the four headers.
pub fn jpx_listing_rows(
	rows: &[Vec<WorkbookCell>],
	language: JpxListingLanguage,
) -> Result<Vec<JpxListingRow>, StockDirectoryFailureCode> {
	let wanted = language.headers();
	let mut columns: Option<[String; 4]> = None;
	let mut out = Vec::new();
	for cells in rows {
		let Some([date, code, name, section]) = &columns else {
			let column_of = |header: &str| {
				cells
					.iter()
					.find(|cell| trim(&cell.text) == header)
					.map(|cell| cell.column.clone())
			};
			if let [Some(date), Some(code), Some(name), Some(section)] = wanted.map(column_of) {
				columns = Some([date, code, name, section]);
			}
			continue;
		};
		let symbol = text_at(cells, code).to_uppercase();
		if parse_stock_id(&format!("jp:{symbol}")).is_err() {
			continue;
		}
		out.push(JpxListingRow {
			code: symbol,
			name: text_at(cells, name).to_owned(),
			section: text_at(cells, section).to_owned(),
			date: text_at(cells, date).to_owned(),
		});
	}
	if columns.is_none() {
		return Err(StockDirectoryFailureCode::ParseFailed);
	}
	Ok(out)
}

/// `20260930` becomes `2026-09-30`; `None` for anything that is not a real YYYYMMDD date.
#[must_use]
pub fn listing_date(text: &str) -> Option<String> {
	if text.len() != 8 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	let iso = format!("{}-{}-{}", text.get(..4)?, text.get(4..6)?, text.get(6..8)?);
	is_valid_iso_date(&iso).then_some(iso)
}

/// The joined list before the row-count floor (`jpxDirectoryEntries`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JpxDirectoryJoin {
	/// The list's date, when every kept row states the same valid one.
	pub as_of: Option<String>,
	/// Kept rows.
	pub entries: Vec<StockDirectoryEntry>,
	/// Rows dropped for names that cannot be stored.
	pub dropped_rows: usize,
}

/// Joins the two lists into the JP directory (before the row-count floor).
#[must_use]
pub fn jpx_directory_entries(
	japanese: &[JpxListingRow],
	english: &[JpxListingRow],
) -> JpxDirectoryJoin {
	let mut english_names: HashMap<&str, &str> = HashMap::with_capacity(english.len());
	for row in english {
		english_names
			.entry(row.code.as_str())
			.or_insert(row.name.as_str());
	}
	let mut entries = Vec::new();
	let mut seen: HashSet<&str> = HashSet::new();
	let mut dates: HashSet<&str> = HashSet::new();
	let mut dropped_rows = 0;
	for row in japanese {
		let Some(listing) = jpx_directory_listing(&row.section) else {
			continue;
		};
		if seen.contains(row.code.as_str()) {
			continue;
		}
		let local = row.name.as_str();
		let english_name = english_names.get(row.code.as_str()).copied().unwrap_or("");
		let pick = |first: &str, second: &str| -> Option<String> {
			if fits_directory_name(first) {
				Some(first.to_owned())
			} else if fits_directory_name(second) {
				Some(second.to_owned())
			} else {
				None
			}
		};
		let (Some(name), Some(local_name)) = (pick(english_name, local), pick(local, english_name))
		else {
			dropped_rows += 1;
			continue;
		};
		seen.insert(row.code.as_str());
		dates.insert(row.date.as_str());
		entries.push(StockDirectoryEntry {
			symbol: row.code.clone(),
			name,
			local_name: Some(local_name),
			listing,
		});
	}
	let as_of = match dates.iter().next() {
		Some(only) if dates.len() == 1 => listing_date(only),
		_ => None,
	};
	JpxDirectoryJoin {
		as_of,
		entries,
		dropped_rows,
	}
}

/// [`jpx_directory_entries`] plus the contract's floor and ceiling.
///
/// # Errors
/// `DIRECTORY_PARSE_FAILED` for a list outside the bounds.
pub fn parse_jpx_directory(
	japanese: &[JpxListingRow],
	english: &[JpxListingRow],
) -> Result<ParsedStockDirectory, StockDirectoryFailureCode> {
	let joined = jpx_directory_entries(japanese, english);
	finish_directory(joined.as_of, joined.entries, joined.dropped_rows)
}

/// One list's sheet and shared strings (decoded XML) as its issues.
///
/// # Errors
/// `DIRECTORY_PARSE_FAILED` for an unreadable sheet or missing headers.
pub fn parse_jpx_listing_sheet(
	sheet: &str,
	shared: &str,
	language: JpxListingLanguage,
) -> Result<Vec<JpxListingRow>, StockDirectoryFailureCode> {
	let rows =
		read_workbook_rows(sheet, shared).map_err(|_| StockDirectoryFailureCode::ParseFailed)?;
	jpx_listing_rows(&rows, language)
}

/// One downloaded list workbook (`.xlsx` bytes) as its issues.
///
/// # Errors
/// `DIRECTORY_PARSE_FAILED` for anything that is not a readable list workbook.
pub fn parse_jpx_listing_workbook(
	bytes: &[u8],
	language: JpxListingLanguage,
) -> Result<Vec<JpxListingRow>, StockDirectoryFailureCode> {
	let entries = read_zip_entries(bytes, &[SHEET, STRINGS])
		.map_err(|_| StockDirectoryFailureCode::ParseFailed)?;
	// `TextDecoder("utf-8")`: replacement characters, and a leading BOM dropped.
	let decode = |key: &str| {
		entries.get(key).map(|bytes| {
			let text = String::from_utf8_lossy(bytes);
			text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
		})
	};
	let (Some(sheet), Some(shared)) = (decode(SHEET), decode(STRINGS)) else {
		return Err(StockDirectoryFailureCode::ParseFailed);
	};
	parse_jpx_listing_sheet(&sheet, &shared, language)
}

/// The JP source over the pinned fetchers.
pub struct JpxDirectorySource {
	fetcher: Arc<dyn SafeFetcher>,
	binary: Arc<dyn SafeBinaryFetcher>,
	on_dropped: Option<DroppedRowsHook>,
}

impl JpxDirectorySource {
	/// A source over the shared fetchers.
	pub fn new(
		fetcher: Arc<dyn SafeFetcher>,
		binary: Arc<dyn SafeBinaryFetcher>,
		on_dropped: Option<DroppedRowsHook>,
	) -> Self {
		Self {
			fetcher,
			binary,
			on_dropped,
		}
	}

	async fn listing(
		&self,
		language: JpxListingLanguage,
		query: &StockDirectoryQuery<'_>,
	) -> Result<Vec<JpxListingRow>, StockDirectoryFailureCode> {
		// One grant per request start, taken immediately before it is sent;
		// a false hook (the job stopped while waiting) sends nothing more.
		if !query.before_request.before_request().await {
			return Err(StockDirectoryFailureCode::SourceFailed);
		}
		let options = fetch_options(JPX_HOST, "text/html", query.cancel);
		let page = self
			.fetcher
			.fetch_text(language.page_url(), &options)
			.await
			.map_err(|error| directory_fetch_failure(&error))?;
		let url = extract_jpx_listing_url(&page.text, language)
			.ok_or(StockDirectoryFailureCode::ParseFailed)?;
		if !query.before_request.before_request().await {
			return Err(StockDirectoryFailureCode::SourceFailed);
		}
		let mut options = fetch_options(JPX_HOST, XLSX_TYPE, query.cancel);
		options.max_bytes = MAX_ZIP_ARCHIVE_BYTES;
		options.timeout_ms = WORKBOOK_TIMEOUT_MS;
		let bytes = self
			.binary
			.fetch_bytes(&url, &options)
			.await
			.map_err(|error| directory_fetch_failure(&error))?
			.bytes;
		// Inflate, decode and parse are CPU work (a 1.6 MB sheet).
		crate::cpu::offload(move || parse_jpx_listing_workbook(&bytes, language)).await
	}
}

#[async_trait]
impl StockDirectorySource for JpxDirectorySource {
	fn market(&self) -> WatchMarket {
		WatchMarket::Jp
	}

	async fn fetch_directory(
		&self,
		query: StockDirectoryQuery<'_>,
	) -> Result<StockDirectoryData, StockDirectoryFailureCode> {
		let japanese = self.listing(JpxListingLanguage::Ja, &query).await?;
		let english = self.listing(JpxListingLanguage::En, &query).await?;
		let parsed = parse_jpx_directory(&japanese, &english)?;
		if parsed.dropped_rows > 0
			&& let Some(hook) = &self.on_dropped
		{
			hook(parsed.dropped_rows);
		}
		Ok(parsed.data)
	}
}
