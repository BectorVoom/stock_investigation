//! FRED series source (FR-017). Keys and response messages never enter logs.
use std::sync::Arc;
use async_trait::async_trait;
use research_application::ports::{SafeFetcher, SafeFetchError};
use research_contracts::market::{MarketProviderId, MarketUnavailableCode as Code, MarketSeriesMeta, MarketFrequency};
use research_js::{json::Value, whitespace::trim, string_number::string_to_number};
use crate::{ports::*, market_fetch::*};

/// FRED's only allowed API host.
pub const FRED_HOST: &str = "api.stlouisfed.org";
/// Provider publisher.
pub const FRED_PUBLISHER: &str = "Federal Reserve Bank of St. Louis (FRED)";
/// Keyed FRED adapter.
pub struct FredSeriesSource { api_key: Secret, fetcher: Arc<dyn SafeFetcher> }
impl FredSeriesSource {
	/// Constructs an isolated provider source.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>) -> Self { Self { api_key, fetcher } }
}
fn unavailable(code: Code) -> MarketUnavailable { MarketUnavailable::new(code, MarketProviderId::Fred) }
fn error_body(json: &Value) -> Option<MarketUnavailable> {
	field(json, "error_code")?.as_f64().filter(|v| v.is_finite())?;
	let message = text(json,"error_message")?.to_ascii_lowercase();
	Some(unavailable(if message.contains("api_key") { Code::SourceAuthFailed }
		else if message.contains("series_id") || message.contains("does not exist") { Code::SeriesNotFound } else { Code::SourceFailed }))
}
fn failure(error: SafeFetchError) -> MarketUnavailable {
	if http_status_of(&error) == Some(429) { return unavailable(Code::RateLimited); }
	error.body.as_deref().and_then(|s| research_js::json::parse(s).ok()).as_ref().and_then(error_body).unwrap_or_else(|| unavailable(Code::SourceFailed))
}
fn url(path: &str, pairs: &[(&str, &str)]) -> String {
	format!("https://{FRED_HOST}{path}?{}", url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs.iter().copied()).finish())
}
#[async_trait]
impl MarketSeriesSource for FredSeriesSource {
	fn provider_id(&self) -> MarketProviderId { MarketProviderId::Fred }
	async fn fetch_series(&self, q: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		let mut options = fetch_options(FRED_HOST, "application/json", q.cancel);
		options.include_error_body = true;
		let meta = fetch_json_document(self.fetcher.as_ref(), &url("/fred/series", &[("series_id", q.symbol), ("file_type", "json"), ("api_key", self.api_key.expose())]), &options).await.map_err(failure)?;
		if let Some(error) = error_body(&meta) { return Err(error); }
		let all = array(&meta,"seriess").ok_or_else(|| unavailable(Code::SourceFailed))?;
		if !all.iter().all(|v| ["id","title","units","frequency_short","seasonal_adjustment_short"].iter().all(|k| text(v,k).is_some())) { return Err(unavailable(Code::SourceFailed)); }
		let first = all.first().ok_or_else(|| unavailable(Code::SeriesNotFound))?;
		let get = |key| text(first,key).unwrap_or("");
		let mut unit = trim(get("units")).to_owned();
		if matches!(get("seasonal_adjustment_short"), "SA" | "SAAR") { unit.push_str(", seasonally adjusted"); }
		let candidate = MarketSeriesMeta { title: trim(get("title")).to_owned(), unit,
			frequency: match get("frequency_short") { "D" => MarketFrequency::Daily, "W"|"BW" => MarketFrequency::Weekly, "M" => MarketFrequency::Monthly, "Q" => MarketFrequency::Quarterly, "A" => MarketFrequency::Annual, _ => MarketFrequency::Unknown },
			publisher: FRED_PUBLISHER.to_owned(), source_url: format!("https://fred.stlouisfed.org/series/{}",get("id")) };
		if !valid_meta(&candidate) { return Err(unavailable(Code::SourceFailed)); }
		let limit = q.max_observations.to_string();
		let mut pairs = vec![("series_id",q.symbol),("file_type","json"),("sort_order","desc"),("limit",limit.as_str())];
		let start = q.since.and_then(|s| subtract_days_iso(s,45));
		if let Some(start) = &start { pairs.push(("observation_start",start)); }
		pairs.push(("api_key",self.api_key.expose()));
		let observations = fetch_json_document(self.fetcher.as_ref(), &url("/fred/series/observations",&pairs), &options).await.map_err(failure)?;
		if let Some(error) = error_body(&observations) { return Err(error); }
		let rows = array(&observations,"observations").ok_or_else(|| unavailable(Code::SourceFailed))?;
		if !rows.iter().all(|v| text(v,"date").is_some() && text(v,"value").is_some()) { return Err(unavailable(Code::SourceFailed)); }
		let points = rows.iter().filter_map(|row| {
			let date = text(row,"date")?; let raw = trim(text(row,"value")?);
			if raw.is_empty() || raw == "." || !is_iso_date(date) { return None; }
			let value = string_to_number(raw);
			value.is_finite().then(|| SeriesPoint { observed_on: date.to_owned(), value })
		}).collect();
		Ok(SeriesData { meta: candidate, observations: finish_points(points,q.max_observations) })
	}
}
