//! FRED series source (FR-017). Keys and response messages never enter logs.
use crate::{bounded_cache::BoundedCache, market_fetch::*, ports::*};
use async_trait::async_trait;
use research_application::ports::{
	Clock, SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher, upstream_status_of,
};
use research_contracts::market::{
	MarketFrequency, MarketProviderId, MarketSeriesMeta, MarketUnavailableCode as Code,
};
use research_domain::upstream::upstream_status_from_number;
use research_js::{json::Value, string_number::string_to_number, whitespace::trim};
use std::sync::Arc;

/// FRED's only allowed API host.
pub const FRED_HOST: &str = "api.stlouisfed.org";
/// Provider publisher.
pub const FRED_PUBLISHER: &str = "Federal Reserve Bank of St. Louis (FRED)";
/// How long a series' validated metadata is reused (ADR-0039): FRED titles,
/// units and frequencies practically never change, so a refresh within a day
/// sends only the observations request.
pub const FRED_META_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Series whose metadata is kept; the dashboard tracks at most 60 series.
pub const FRED_META_CACHE_ENTRIES: usize = 256;
/// Keyed FRED adapter.
pub struct FredSeriesSource {
	api_key: Secret,
	fetcher: Arc<dyn SafeFetcher>,
	clock: Arc<dyn Clock>,
	/// Validated metadata by requested series id. Only metadata that passed
	/// validation enters, so a not-found or auth failure is asked again.
	meta_cache: BoundedCache<String, MarketSeriesMeta>,
}
impl FredSeriesSource {
	/// Constructs an isolated provider source.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>, clock: Arc<dyn Clock>) -> Self {
		Self {
			api_key,
			fetcher,
			clock,
			meta_cache: BoundedCache::new(FRED_META_CACHE_ENTRIES, Some(FRED_META_TTL_MS)),
		}
	}
	/// `/fred/series`: the series' title, unit and frequency, validated.
	async fn fetch_meta(
		&self,
		symbol: &str,
		options: &SafeFetchOptions,
	) -> Result<MarketSeriesMeta, MarketUnavailable> {
		let meta = fetch_json_document(
			self.fetcher.as_ref(),
			&url(
				"/fred/series",
				&[
					("series_id", symbol),
					("file_type", "json"),
					("api_key", self.api_key.expose()),
				],
			),
			options,
		)
		.await
		.map_err(failure)?;
		if let Some(error) = error_payload(&meta) {
			return Err(error);
		}
		let all = array(&meta, "seriess").ok_or_else(|| unavailable(Code::SourceFailed))?;
		if !all.iter().all(|v| {
			[
				"id",
				"title",
				"units",
				"frequency_short",
				"seasonal_adjustment_short",
			]
			.iter()
			.all(|k| text(v, k).is_some())
		}) {
			return Err(unavailable(Code::SourceFailed));
		}
		let first = all
			.first()
			.ok_or_else(|| unavailable(Code::SeriesNotFound))?;
		let get = |key| text(first, key).unwrap_or("");
		let mut unit = trim(get("units")).to_owned();
		if matches!(get("seasonal_adjustment_short"), "SA" | "SAAR") {
			unit.push_str(", seasonally adjusted");
		}
		let candidate = MarketSeriesMeta {
			title: trim(get("title")).to_owned(),
			unit,
			frequency: match get("frequency_short") {
				"D" => MarketFrequency::Daily,
				"W" | "BW" => MarketFrequency::Weekly,
				"M" => MarketFrequency::Monthly,
				"Q" => MarketFrequency::Quarterly,
				"A" => MarketFrequency::Annual,
				_ => MarketFrequency::Unknown,
			},
			publisher: FRED_PUBLISHER.to_owned(),
			source_url: format!("https://fred.stlouisfed.org/series/{}", get("id")),
		};
		if !valid_meta(&candidate) {
			return Err(unavailable(Code::SourceFailed));
		}
		Ok(candidate)
	}
}
fn unavailable(code: Code) -> MarketUnavailable {
	MarketUnavailable::new(code, MarketProviderId::Fred, None)
}
/// FRED's JSON error: its `error_code` (finite) and our code for its message.
fn error_body(json: &Value) -> Option<(f64, Code)> {
	let error_code = field(json, "error_code")?
		.as_f64()
		.filter(|v| v.is_finite())?;
	let message = text(json, "error_message")?.to_ascii_lowercase();
	let code = if message.contains("api_key") {
		Code::SourceAuthFailed
	} else if message.contains("series_id") || message.contains("does not exist") {
		Code::SeriesNotFound
	} else {
		Code::SourceFailed
	};
	Some((error_code, code))
}
/// A 200 answer carrying FRED's error body: its `error_code` is FRED's status
/// (kept when it is an HTTP status, §4a).
fn error_payload(json: &Value) -> Option<MarketUnavailable> {
	let (error_code, code) = error_body(json)?;
	Some(MarketUnavailable::new(
		code,
		MarketProviderId::Fred,
		upstream_status_from_number(error_code),
	))
}
/// A failed metadata/observations request. FRED's answer status travels
/// unchanged beside whichever code its error body (or a 429) selects (§4a).
fn failure(error: SafeFetchError) -> MarketUnavailable {
	let upstream_status = upstream_status_of(&error);
	let with_status = |code| MarketUnavailable::new(code, MarketProviderId::Fred, upstream_status);
	if error.http_error_status() == Some(429) {
		return with_status(Code::RateLimited);
	}
	let from_body = if error.code == SafeFetchErrorCode::HttpError {
		error
			.body
			.as_deref()
			.and_then(|s| research_js::json::parse(s).ok())
			.as_ref()
			.and_then(error_body)
			.map(|(_, code)| code)
	} else {
		None
	};
	with_status(from_body.unwrap_or(Code::SourceFailed))
}
fn url(path: &str, pairs: &[(&str, &str)]) -> String {
	format!(
		"https://{FRED_HOST}{path}?{}",
		url::form_urlencoded::Serializer::new(String::new())
			.extend_pairs(pairs.iter().copied())
			.finish()
	)
}
#[async_trait]
impl MarketSeriesSource for FredSeriesSource {
	fn provider_id(&self) -> MarketProviderId {
		MarketProviderId::Fred
	}
	async fn fetch_series(&self, q: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		let mut options = fetch_options(FRED_HOST, "application/json", q.cancel);
		options.include_error_body = true;
		// A cached series costs one request; the entry stays even when the
		// observations below fail, since the metadata itself was valid.
		let candidate = match self.meta_cache.get(q.symbol, self.clock.now_ms()) {
			Some(cached) => cached,
			None => {
				let fetched = self.fetch_meta(q.symbol, &options).await?;
				self.meta_cache
					.insert(q.symbol.to_owned(), fetched.clone(), self.clock.now_ms());
				fetched
			}
		};
		let limit = q.max_observations.to_string();
		let mut pairs = vec![
			("series_id", q.symbol),
			("file_type", "json"),
			("sort_order", "desc"),
			("limit", limit.as_str()),
		];
		let start = q.since.and_then(|s| subtract_days_iso(s, 45));
		if let Some(start) = &start {
			pairs.push(("observation_start", start));
		}
		pairs.push(("api_key", self.api_key.expose()));
		let observations = fetch_json_document(
			self.fetcher.as_ref(),
			&url("/fred/series/observations", &pairs),
			&options,
		)
		.await
		.map_err(failure)?;
		if let Some(error) = error_payload(&observations) {
			return Err(error);
		}
		let rows =
			array(&observations, "observations").ok_or_else(|| unavailable(Code::SourceFailed))?;
		if !rows
			.iter()
			.all(|v| text(v, "date").is_some() && text(v, "value").is_some())
		{
			return Err(unavailable(Code::SourceFailed));
		}
		let points = rows
			.iter()
			.filter_map(|row| {
				let date = text(row, "date")?;
				let raw = trim(text(row, "value")?);
				if raw.is_empty() || raw == "." || !is_iso_date(date) {
					return None;
				}
				let value = string_to_number(raw);
				value.is_finite().then(|| SeriesPoint {
					observed_on: date.to_owned(),
					value,
				})
			})
			.collect();
		Ok(SeriesData {
			meta: candidate,
			observations: finish_points(points, q.max_observations),
		})
	}
}
