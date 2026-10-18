//! Sequential Finnhub profile and announcement requests (FR-018, API-007).
use std::sync::Arc;
use async_trait::async_trait;
use research_application::ports::SafeFetcher;
use research_contracts::watchlist::{EarningsSourceId,EarningsUnavailableCode as Code,EarningsEvent,EarningsTiming};
use research_js::{json::Value,whitespace::trim,utf16::utf16_len,number::to_js_string};
use crate::{ports::*,market_fetch::*};
/// The one API host.
pub const FINNHUB_HOST: &str = "finnhub.io";
/// Keyed earnings adapter.
pub struct FinnhubEarningsSource { api_key: Secret, fetcher: Arc<dyn SafeFetcher> }
impl FinnhubEarningsSource {
	/// Constructs the source.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>) -> Self { Self { api_key,fetcher } }
	async fn fetch_one(&self, stock: &EarningsStock, q: &EarningsQuery<'_>) -> EarningsResult {
		let mut options = fetch_options(FINNHUB_HOST,"application/json",q.cancel);
		options.finnhub_token = Some(self.api_key.expose().to_owned());
		let mut name = None;
		if stock.need_name {
			if !q.before_request.before_request().await { return Err(EarningsFailure::new(Code::SourceFailed)); }
			let url = endpoint("stock/profile2",&[("symbol",&stock.symbol)]);
			let profile = fetch_json_document(self.fetcher.as_ref(),&url,&options).await.map_err(|e| failure(http_status_of(&e)))?;
			if profile.as_object().is_none() || ["name","ticker"].iter().any(|k| field(&profile,k).is_some_and(|v| v.as_str().is_none())) { return Err(failure(None)); }
			if text(&profile,"ticker").is_none() { return Err(EarningsFailure::new(Code::SymbolNotFound)); }
			let raw = trim(text(&profile,"name").unwrap_or(""));
			if !raw.is_empty() && utf16_len(raw) <= 200 { name = Some(raw.to_owned()); }
		}
		if !q.before_request.before_request().await { return Err(failure(None)); }
		let url = endpoint("calendar/earnings",&[("from",q.from_date),("to",q.to_date),("symbol",&stock.symbol)]);
		let json = fetch_json_document(self.fetcher.as_ref(),&url,&options).await.map_err(|e| failure(http_status_of(&e)))?;
		let rows = array(&json,"earningsCalendar").ok_or_else(|| failure(None))?;
		if !rows.iter().all(valid_row) { return Err(failure(None)); }
		let mut events: Vec<_> = rows.iter().filter_map(|row| {
			let date = text(row,"date")?;
			if !is_iso_date(date) || date < q.from_date || date > q.to_date || text(row,"symbol").is_some_and(|s| s != stock.symbol) { return None; }
			let year = field(row,"year")?.as_f64()?;
			let quarter = field(row,"quarter")?.as_f64()?;
			if year.fract() != 0.0 || quarter.fract() != 0.0 || !(1.0..=4.0).contains(&quarter) { return None; }
			let year = to_js_string(year); let quarter = to_js_string(quarter);
			valid_event(&EarningsEvent { period_key: format!("{year}-q{quarter}"), announcement_date: Some(date.to_owned()), fiscal_period_label: format!("Q{quarter} {year}"), fiscal_period_end: None,
				timing: match text(row,"hour") { Some("bmo") => EarningsTiming::BeforeOpen, Some("amc") => EarningsTiming::AfterClose, Some("dmh") => EarningsTiming::DuringSession, _ => EarningsTiming::Unknown } })
		}).collect();
		events.sort_by(|a,b| a.announcement_date.cmp(&b.announcement_date));
		if events.is_empty() { return Err(EarningsFailure::no_date(name)); }
		events.truncate(8);
		Ok(EarningsData { name,events })
	}
}
fn valid_row(v: &Value) -> bool {
	text(v,"date").is_some()
		&& ["hour","symbol"].iter().all(|k| field(v,k).is_none_or(|v| v.is_null() || v.as_str().is_some()))
		&& ["year","quarter"].iter().all(|k| field(v,k).is_none_or(|v| v.is_null() || v.as_f64().is_some_and(f64::is_finite)))
}
fn endpoint(path: &str,pairs: &[(&str,&str)]) -> String { format!("https://{FINNHUB_HOST}/api/v1/{path}?{}",url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs.iter().copied()).finish()) }
fn failure(status: Option<u16>) -> EarningsFailure { EarningsFailure::new(match status { Some(401) => Code::SourceAuthFailed, Some(403) => Code::PlanNotEntitled, Some(429) => Code::RateLimited,_ => Code::SourceFailed }) }
#[async_trait]
impl EarningsCalendarSource for FinnhubEarningsSource {
	fn source_id(&self) -> EarningsSourceId { EarningsSourceId::Finnhub }
	async fn fetch_earnings(&self,q: EarningsQuery<'_>) -> Vec<EarningsResult> {
		let mut results = Vec::with_capacity(q.stocks.len());
		for stock in q.stocks { results.push(self.fetch_one(stock,&q).await); }
		results
	}
}
