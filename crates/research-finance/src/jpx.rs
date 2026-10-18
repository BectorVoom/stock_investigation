//! JPX index and workbook source. Downloads stay sequential and cache reads consume no quota.
use crate::{
	jpx_workbook::{JpxWorkbookRow, parse_jpx_workbook},
	market_fetch::fetch_options,
	ports::*,
	zip_reader::read_zip_entries,
};
use async_trait::async_trait;
use research_application::ports::{Clock, SafeBinaryFetcher, SafeFetcher};
use research_contracts::watchlist::{
	EarningsEvent, EarningsSourceId, EarningsTiming, EarningsUnavailableCode,
};
use std::{collections::BTreeMap, sync::Arc};
/// JPX schedule index.
pub const JPX_INDEX_URL: &str =
	"https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html";
const SHEET: &str = "xl/worksheets/sheet1.xml";
const STRINGS: &str = "xl/sharedStrings.xml";
/// Extracts at most six distinct permitted workbook URLs in document order.
pub fn extract_jpx_workbook_urls(html: &str) -> Vec<String> {
	let whitespace = r"[\t\n\x0b\x0c\r \u{a0}\u{feff}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]";
	let pattern = format!(
		r#"(?i-u:<a\b)[^>]*?(?-u:\bhref){whitespace}*={whitespace}*(?:"([^"]*)"|'([^']*)'|([^\t\n\x0b\x0c\r \u{{a0}}\u{{feff}}\u{{1680}}\u{{2000}}-\u{{200a}}\u{{2028}}\u{{2029}}\u{{202f}}\u{{205f}}\u{{3000}}>]+))"#
	);
	let Ok(anchor) = regex::RegexBuilder::new(&pattern)
		.case_insensitive(true)
		.build()
	else {
		return Vec::new();
	};
	let Ok(path) = regex::Regex::new(
		r"^/listing/event-schedules/financial-announcement/[A-Za-z0-9_-]+/kessan[0-9]{2}_[0-9]{4}\.xlsx$",
	) else {
		return Vec::new();
	};
	let Ok(base) = url::Url::parse(JPX_INDEX_URL) else {
		return Vec::new();
	};
	let mut urls = Vec::new();
	for captures in anchor.captures_iter(html) {
		let Some(raw) = captures
			.get(1)
			.or_else(|| captures.get(2))
			.or_else(|| captures.get(3))
			.map(|m| m.as_str())
			.filter(|s| !s.is_empty())
		else {
			continue;
		};
		let Ok(url) = base.join(raw) else {
			continue;
		};
		if url.scheme() != "https"
			|| url.host_str() != Some("www.jpx.co.jp")
			|| !path.is_match(url.path())
		{
			continue;
		}
		let key = format!("{}{}", url.origin().ascii_serialization(), url.path());
		if !urls.contains(&key) {
			urls.push(key);
		}
		if urls.len() == 6 {
			break;
		}
	}
	urls
}
struct Cache {
	index: Option<(String, i64)>,
	workbooks: BTreeMap<String, Vec<JpxWorkbookRow>>,
}
/// Stateful JPX source with a thirty-minute index cache and URL-based workbook cache.
pub struct JpxEarningsSource {
	fetcher: Arc<dyn SafeFetcher>,
	binary: Arc<dyn SafeBinaryFetcher>,
	clock: Arc<dyn Clock>,
	cache: tokio::sync::Mutex<Cache>,
}
impl JpxEarningsSource {
	/// Constructs one process-lifetime cache.
	pub fn new(
		fetcher: Arc<dyn SafeFetcher>,
		binary: Arc<dyn SafeBinaryFetcher>,
		clock: Arc<dyn Clock>,
	) -> Self {
		Self {
			fetcher,
			binary,
			clock,
			cache: tokio::sync::Mutex::new(Cache {
				index: None,
				workbooks: BTreeMap::new(),
			}),
		}
	}
	async fn rows(&self, q: &EarningsQuery<'_>) -> Option<Vec<JpxWorkbookRow>> {
		let mut cache = self.cache.lock().await;
		let now = self.clock.now_ms();
		let html = if let Some((html, _)) = cache
			.index
			.as_ref()
			.filter(|(_, at)| now.saturating_sub(*at) < 1_800_000)
		{
			html.clone()
		} else {
			if !q.before_request.before_request().await {
				return None;
			}
			let options = fetch_options("www.jpx.co.jp", "text/html", q.cancel);
			let html = self
				.fetcher
				.fetch_text(JPX_INDEX_URL, &options)
				.await
				.ok()?
				.text;
			cache.index = Some((html.clone(), now));
			html
		};
		let urls = extract_jpx_workbook_urls(&html);
		cache.workbooks.retain(|key, _| urls.contains(key));
		let mut all = Vec::new();
		for url in urls {
			if let Some(rows) = cache.workbooks.get(&url) {
				all.extend(rows.iter().cloned());
				continue;
			}
			if !q.before_request.before_request().await {
				return None;
			}
			let mut options = fetch_options(
				"www.jpx.co.jp",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				q.cancel,
			);
			options.max_bytes = crate::zip_reader::MAX_ZIP_ARCHIVE_BYTES;
			options.timeout_ms = 60_000;
			let bytes = self.binary.fetch_bytes(&url, &options).await.ok()?.bytes;
			let entries = read_zip_entries(&bytes, &[SHEET, STRINGS]).ok()?;
			let decode = |key| {
				entries.get(key).map(|s| {
					let text = String::from_utf8_lossy(s);
					text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
				})
			};
			let rows = parse_jpx_workbook(&decode(SHEET)?, &decode(STRINGS)?).ok()?;
			all.extend(rows.iter().cloned());
			cache.workbooks.insert(url, rows);
		}
		Some(all)
	}
}
fn to_result(
	stock: &EarningsStock,
	rows: &[JpxWorkbookRow],
	from: &str,
	to: &str,
) -> EarningsResult {
	let matched: Vec<_> = rows.iter().filter(|r| r.code == stock.symbol).collect();
	let name = matched
		.iter()
		.find_map(|r| r.name.as_ref())
		.filter(|n| research_js::utf16::utf16_len(n) <= 200)
		.cloned();
	let mut events: Vec<_> = matched
		.iter()
		.filter(|r| {
			r.announcement_date
				.as_deref()
				.is_none_or(|s| s >= from && s <= to)
		})
		.filter_map(|r| {
			crate::market_fetch::valid_event(&EarningsEvent {
				period_key: r.period_key.clone(),
				announcement_date: r.announcement_date.clone(),
				fiscal_period_label: r.fiscal_period_label.clone(),
				fiscal_period_end: Some(r.fiscal_period_end.clone()),
				timing: EarningsTiming::Unknown,
			})
		})
		.collect();
	if events.is_empty() {
		return Err(EarningsFailure::no_date(name));
	}
	events.sort_by(|a, b| match (&a.announcement_date, &b.announcement_date) {
		(None, None) => std::cmp::Ordering::Equal,
		(None, _) => std::cmp::Ordering::Greater,
		(_, None) => std::cmp::Ordering::Less,
		(Some(a), Some(b)) => a.cmp(b),
	});
	events.truncate(8);
	Ok(EarningsData {
		name: if stock.need_name { name } else { None },
		events,
	})
}
#[async_trait]
impl EarningsCalendarSource for JpxEarningsSource {
	fn source_id(&self) -> EarningsSourceId {
		EarningsSourceId::Jpx
	}
	async fn fetch_earnings(&self, q: EarningsQuery<'_>) -> Vec<EarningsResult> {
		if q.stocks.is_empty() {
			return Vec::new();
		}
		match self.rows(&q).await {
			None => q
				.stocks
				.iter()
				.map(|_| Err(EarningsFailure::new(EarningsUnavailableCode::SourceFailed)))
				.collect(),
			Some(rows) => q
				.stocks
				.iter()
				.map(|s| to_result(s, &rows, q.from_date, q.to_date))
				.collect(),
		}
	}
}
