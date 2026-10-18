//! Twelve Data daily closes; the untrimmed currency is intentionally preserved (F4).
use std::sync::Arc;
use async_trait::async_trait;
use research_application::ports::SafeFetcher;
use research_contracts::market::{MarketProviderId, MarketUnavailableCode as Code, MarketSeriesMeta, MarketFrequency};
use research_js::{whitespace::trim,string_number::string_to_number};
use crate::{ports::*,market_fetch::*};
/// The pinned API host.
pub const TWELVE_DATA_HOST: &str = "api.twelvedata.com";
/// Splits at the last colon, retaining an empty exchange when present.
pub fn split_twelve_symbol(symbol: &str) -> (&str, Option<&str>) { symbol.rsplit_once(':').map_or((symbol,None), |(base,exchange)| (base,Some(exchange))) }
/// Keyed Twelve Data adapter.
pub struct TwelveDataSeriesSource { api_key: Secret, fetcher: Arc<dyn SafeFetcher> }
impl TwelveDataSeriesSource {
	/// Constructs the source.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>) -> Self { Self { api_key, fetcher } }
}
fn unavailable(code: Code) -> MarketUnavailable { MarketUnavailable::new(code,MarketProviderId::TwelveData) }
fn map_code(code: f64) -> MarketUnavailable { unavailable(match code { 401.0 => Code::SourceAuthFailed, 400.0|404.0 => Code::SeriesNotFound, 403.0 => Code::PlanNotEntitled, 429.0 => Code::RateLimited, _ => Code::SourceFailed }) }
#[async_trait]
impl MarketSeriesSource for TwelveDataSeriesSource {
	fn provider_id(&self) -> MarketProviderId { MarketProviderId::TwelveData }
	async fn fetch_series(&self, q: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		let (base,exchange) = split_twelve_symbol(q.symbol);
		let url = {
		let mut params = url::form_urlencoded::Serializer::new(String::new());
		params.append_pair("symbol",base);
		if let Some(exchange) = exchange.filter(|s| !s.is_empty()) { params.append_pair("exchange",exchange); }
		params.append_pair("interval","1day").append_pair("outputsize",&q.max_observations.to_string());
		if let Some(start) = q.since.and_then(|s| subtract_days_iso(s,45)) { params.append_pair("start_date",&start); }
		format!("https://{TWELVE_DATA_HOST}/time_series?{}",params.finish())
		};
		let mut options = fetch_options(TWELVE_DATA_HOST,"application/json",q.cancel);
		options.authorization = Some(format!("apikey {}",self.api_key.expose()));
		let json = fetch_json_document(self.fetcher.as_ref(),&url,&options).await.map_err(|e| map_code(http_status_of(&e).map_or(0.0,f64::from)))?;
		if let Some(code) = field(&json,"code").and_then(|v| v.as_f64()).filter(|n| n.is_finite()) {
			if text(&json,"message").is_some() && text(&json,"status") == Some("error") { return Err(map_code(code)); }
		}
		let meta = field(&json,"meta").ok_or_else(|| unavailable(Code::SourceFailed))?;
		let symbol = text(meta,"symbol").filter(|s| !s.is_empty()).ok_or_else(|| unavailable(Code::SourceFailed))?;
		if ["currency","exchange"].iter().any(|k| field(meta,k).is_some_and(|v| v.as_str().is_none())) { return Err(unavailable(Code::SourceFailed)); }
		let rows = array(&json,"values").ok_or_else(|| unavailable(Code::SourceFailed))?;
		if !rows.iter().all(|v| text(v,"datetime").is_some() && text(v,"close").is_some()) { return Err(unavailable(Code::SourceFailed)); }
		if rows.is_empty() { return Err(unavailable(Code::NoData)); }
		let (title,unit) = if let Some(currency) = text(meta,"currency").filter(|s| !trim(s).is_empty()) {
			let exchange = trim(text(meta,"exchange").unwrap_or(""));
			(if exchange.is_empty() { symbol.to_owned() } else { format!("{symbol} ({exchange})") }, currency.to_owned())
		} else if let Some((base,quote)) = symbol.split_once('/').filter(|(a,b)| !a.is_empty() && !b.is_empty()) {
			let base = match base { "XAU" => "XAU (troy ounce of gold)", "XAG" => "XAG (troy ounce of silver)", _ => base };
			(symbol.to_owned(),format!("{quote} per {base}"))
		} else { return Err(unavailable(Code::SourceFailed)); };
		let candidate = MarketSeriesMeta { title,unit,frequency: MarketFrequency::Daily,publisher: "Twelve Data".to_owned(),source_url: "https://twelvedata.com/".to_owned() };
		if !valid_meta(&candidate) { return Err(unavailable(Code::SourceFailed)); }
		let points: Vec<_> = rows.iter().filter_map(|row| {
			let close = text(row,"close")?;
			if trim(close).is_empty() { return None; }
			let observed_on = date_prefix_of(text(row,"datetime")?)?;
			let value = string_to_number(close);
			value.is_finite().then_some(SeriesPoint { observed_on,value })
		}).collect();
		if points.is_empty() { return Err(unavailable(Code::NoData)); }
		Ok(SeriesData { meta: candidate, observations: finish_points(points,q.max_observations) })
	}
}
