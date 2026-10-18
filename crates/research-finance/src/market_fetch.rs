//! Bounded JSON fetching and date helpers shared by market sources.
use research_application::ports::{
	SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use research_js::json::{self, Value};
use tokio_util::sync::CancellationToken;

/// The first ASCII three-digit word of an HTTP_ERROR detail.
pub fn http_status_of(error: &SafeFetchError) -> Option<u16> {
	if error.code != SafeFetchErrorCode::HttpError {
		return None;
	}
	let bytes = error.detail.as_bytes();
	for (at, window) in bytes.windows(3).enumerate() {
		let word = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_';
		if window.iter().all(u8::is_ascii_digit)
			&& (at == 0 || !bytes.get(at - 1).is_some_and(word))
			&& !bytes.get(at + 3).is_some_and(word)
		{
			return std::str::from_utf8(window).ok()?.parse().ok();
		}
	}
	None
}
/// Shared single-host fetch options.
pub fn fetch_options(host: &str, accept: &str, cancel: &CancellationToken) -> SafeFetchOptions {
	SafeFetchOptions {
		max_bytes: 1_000_000,
		timeout_ms: 30_000,
		accept: accept.to_owned(),
		cancel: Some(cancel.clone()),
		allowed_hosts: Some([host.to_owned()].into()),
		authorize_redirect: None,
		user_agent: None,
		authorization: None,
		finnhub_token: None,
		include_error_body: false,
	}
}
/// Fetches and parses JSON with JS duplicate-key and number semantics.
pub async fn fetch_json_document(
	fetcher: &dyn SafeFetcher,
	url: &str,
	options: &SafeFetchOptions,
) -> Result<Value, SafeFetchError> {
	let document = fetcher.fetch_text(url, options).await?;
	json::parse(&document.text).map_err(|_| SafeFetchError {
		code: SafeFetchErrorCode::NetworkError,
		detail: "response is not valid JSON".to_owned(),
		body: None,
	})
}
/// True for a real date, retaining Date.UTC's two-digit-year quirk.
pub use research_domain::calendar::civil_date::is_valid_iso_date as is_iso_date;
/// Leading UTC date of a provider timestamp.
pub fn date_prefix_of(text: &str) -> Option<String> {
	let prefix = research_js::utf16::slice(text, 0, 10);
	is_iso_date(&prefix).then(|| prefix.into_owned())
}
/// Revision-overlap start date. Date arithmetic here can cross into year 0099.
pub fn subtract_days_iso(iso: &str, days: i64) -> Option<String> {
	if !is_iso_date(iso) {
		return None;
	}
	let date = chrono::NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()?;
	Some(
		date.checked_sub_signed(chrono::Duration::try_days(days)?)?
			.format("%Y-%m-%d")
			.to_string(),
	)
}
pub(crate) fn field<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
	v.as_object()?.get(key)
}
pub(crate) fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
	field(v, key)?.as_str()
}
pub(crate) fn array<'a>(v: &'a Value, key: &str) -> Option<&'a [Value]> {
	field(v, key)?.as_array()
}
pub(crate) fn valid_meta(meta: &research_contracts::market::MarketSeriesMeta) -> bool {
	research_contracts::json::to_js_value(meta).is_ok_and(|v| {
		research_contracts::validate::<research_contracts::market::MarketSeriesMeta>(&v).is_ok()
	})
}
pub(crate) fn valid_event(
	event: &research_contracts::watchlist::EarningsEvent,
) -> Option<research_contracts::watchlist::EarningsEvent> {
	let value = research_contracts::json::to_js_value(event).ok()?;
	research_contracts::validate(&value).ok()
}
pub(crate) fn finish_points(
	mut points: Vec<crate::ports::SeriesPoint>,
	max: usize,
) -> Vec<crate::ports::SeriesPoint> {
	points.sort_by(|a, b| a.observed_on.cmp(&b.observed_on));
	points.dedup_by(|a, b| a.observed_on == b.observed_on);
	// JS slice(-0) returns the entire array.
	if max != 0 && points.len() > max {
		points.drain(..points.len() - max);
	}
	points
}
