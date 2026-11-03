//! Sequential Finnhub profile and announcement requests (FR-018, API-007).
//!
//! The market calendar (ADR-0068, [`FinnhubEarningsSource`]'s
//! [`EarningsMarketCalendarSource`]) asks the same endpoint WITHOUT a
//! symbol: every company announcing in a window. An answer stops at
//! `FINNHUB_ROW_CAP` rows, so the window is walked `WINDOW_DAYS` at a time
//! and a capped week is asked again one day at a time; a day still capped is
//! kept and reported in `truncated_dates`. Any failed request fails the
//! whole calendar (nothing partial is stored).
//!
//! Wire format, limits and error mapping: docs/external-apis/apis/finnhub.md
use crate::{market_fetch::*, ports::*};
use async_trait::async_trait;
use research_application::ports::{SafeFetcher, upstream_status_of};
use research_contracts::earnings_calendar::{EarningsCalendarEvent, limits as calendar_limits};
use research_contracts::stock_prices::is_stock_price_symbol;
use research_contracts::watchlist::{
	EarningsEvent, EarningsSourceId, EarningsTiming, EarningsUnavailableCode as Code,
};
use research_domain::calendar::civil_date::add_days_iso;
use research_js::{json::Value, number::to_js_string, utf16::utf16_len, whitespace::trim};
use serde::Serialize;
use std::{collections::HashSet, sync::Arc};
/// The one API host.
pub const FINNHUB_HOST: &str = "finnhub.io";
/// Keyed earnings adapter.
pub struct FinnhubEarningsSource {
	api_key: Secret,
	fetcher: Arc<dyn SafeFetcher>,
}
impl FinnhubEarningsSource {
	/// Constructs the source.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>) -> Self {
		Self { api_key, fetcher }
	}
	async fn fetch_one(&self, stock: &EarningsStock, q: &EarningsQuery<'_>) -> EarningsResult {
		let mut options = fetch_options(FINNHUB_HOST, "application/json", q.cancel);
		options.finnhub_token = Some(self.api_key.expose().to_owned());
		let mut name = None;
		if stock.need_name {
			if !q.before_request.before_request().await {
				return Err(failure(None));
			}
			let url = endpoint("stock/profile2", &[("symbol", &stock.symbol)]);
			let profile = fetch_json_document(self.fetcher.as_ref(), &url, &options)
				.await
				.map_err(|e| failure(upstream_status_of(&e)))?;
			if profile.as_object().is_none()
				|| ["name", "ticker"]
					.iter()
					.any(|k| field(&profile, k).is_some_and(|v| v.as_str().is_none()))
			{
				return Err(failure(None));
			}
			if text(&profile, "ticker").is_none() {
				return Err(EarningsFailure::new(Code::SymbolNotFound, None));
			}
			let raw = trim(text(&profile, "name").unwrap_or(""));
			if !raw.is_empty() && utf16_len(raw) <= 200 {
				name = Some(raw.to_owned());
			}
		}
		if !q.before_request.before_request().await {
			return Err(failure(None));
		}
		let url = endpoint(
			"calendar/earnings",
			&[
				("from", q.from_date),
				("to", q.to_date),
				("symbol", &stock.symbol),
			],
		);
		let json = fetch_json_document(self.fetcher.as_ref(), &url, &options)
			.await
			.map_err(|e| failure(upstream_status_of(&e)))?;
		let rows = array(&json, "earningsCalendar").ok_or_else(|| failure(None))?;
		if !rows.iter().all(valid_row) {
			return Err(failure(None));
		}
		let mut events: Vec<_> = rows
			.iter()
			.filter_map(|row| {
				let date = text(row, "date")?;
				if !is_iso_date(date)
					|| date < q.from_date
					|| date > q.to_date
					|| text(row, "symbol").is_some_and(|s| s != stock.symbol)
				{
					return None;
				}
				row_event(row, date)
			})
			.collect();
		events.sort_by(|a, b| a.announcement_date.cmp(&b.announcement_date));
		if events.is_empty() {
			return Err(EarningsFailure::no_date(name));
		}
		events.truncate(8);
		Ok(EarningsData { name, events })
	}
}
/// A calendar row's event (`rowEvent`): its fiscal quarter names the period
/// (`2026-q3`, `Q3 2026`); a row without a whole year and a quarter 1–4 is
/// skipped (`None`), never the response. Finnhub states no period end.
fn row_event(row: &Value, date: &str) -> Option<EarningsEvent> {
	let year = field(row, "year")?.as_f64()?;
	let quarter = field(row, "quarter")?.as_f64()?;
	if year.fract() != 0.0 || quarter.fract() != 0.0 || !(1.0..=4.0).contains(&quarter) {
		return None;
	}
	let year = to_js_string(year);
	let quarter = to_js_string(quarter);
	valid_event(&EarningsEvent {
		period_key: format!("{year}-q{quarter}"),
		announcement_date: Some(date.to_owned()),
		fiscal_period_label: format!("Q{quarter} {year}"),
		fiscal_period_end: None,
		timing: match text(row, "hour") {
			Some("bmo") => EarningsTiming::BeforeOpen,
			Some("amc") => EarningsTiming::AfterClose,
			Some("dmh") => EarningsTiming::DuringSession,
			_ => EarningsTiming::Unknown,
		},
	})
}
fn valid_row(v: &Value) -> bool {
	text(v, "date").is_some()
		&& ["hour", "symbol"]
			.iter()
			.all(|k| field(v, k).is_none_or(|v| v.is_null() || v.as_str().is_some()))
		&& ["year", "quarter"].iter().all(|k| {
			field(v, k).is_none_or(|v| v.is_null() || v.as_f64().is_some_and(f64::is_finite))
		})
}
fn endpoint(path: &str, pairs: &[(&str, &str)]) -> String {
	format!(
		"https://{FINNHUB_HOST}/api/v1/{path}?{}",
		url::form_urlencoded::Serializer::new(String::new())
			.extend_pairs(pairs.iter().copied())
			.finish()
	)
}
/// Finnhub's answer status as our code, the status itself travelling
/// unchanged beside it (§4a); `None` for a failure Finnhub's answer did not
/// cause (a stopped job, an unexpected shape).
fn failure(status: Option<u16>) -> EarningsFailure {
	let code = match status {
		Some(401) => Code::SourceAuthFailed,
		Some(403) => Code::PlanNotEntitled,
		Some(429) => Code::RateLimited,
		_ => Code::SourceFailed,
	};
	EarningsFailure::new(code, status)
}
#[async_trait]
impl EarningsCalendarSource for FinnhubEarningsSource {
	fn source_id(&self) -> EarningsSourceId {
		EarningsSourceId::Finnhub
	}
	async fn fetch_earnings(&self, q: EarningsQuery<'_>) -> Vec<EarningsResult> {
		let mut results = Vec::with_capacity(q.stocks.len());
		for stock in q.stocks {
			results.push(self.fetch_one(stock, &q).await);
		}
		results
	}
}

/* ---------- The market calendar (ADR-0068) ---------- */

/// Finnhub's US ticker in the stock list's form (`finnhubCalendarSymbol`):
/// share classes are written with a dot by Finnhub (`BH.A`) and with a
/// hyphen by SEC (`BH-A`). `None` when the result is no stock-list symbol.
#[must_use]
pub fn finnhub_calendar_symbol(symbol: &str) -> Option<String> {
	let mapped = trim(symbol).replace('.', "-");
	is_stock_price_symbol(&mapped).then_some(mapped)
}

/// One request's dates, inclusive (`CalendarWindow`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CalendarWindow {
	/// First day.
	pub from: String,
	/// Last day.
	pub to: String,
}

/// `[from_date, to_date]` cut into consecutive windows of `days` days (the
/// last may be shorter), in date order: together they hold every day once
/// (`calendarWindows`). Empty when the dates are not valid, `from_date` is
/// after `to_date`, `days` is not a whole number ≥ 1, or a step leaves the
/// date range (as the TypeScript, the whole list is then empty).
#[must_use]
pub fn calendar_windows(from_date: &str, to_date: &str, days: f64) -> Vec<CalendarWindow> {
	if !is_iso_date(from_date) || !is_iso_date(to_date) || from_date > to_date {
		return Vec::new();
	}
	if !days.is_finite() || days.fract() != 0.0 || days < 1.0 {
		return Vec::new();
	}
	let mut windows = Vec::new();
	let mut start = from_date.to_owned();
	while start.as_str() <= to_date {
		let Ok(end) = add_days_iso(&start, days - 1.0) else {
			return Vec::new();
		};
		let to = if end.as_str() < to_date {
			end
		} else {
			to_date.to_owned()
		};
		let Ok(next) = add_days_iso(&to, 1.0) else {
			return Vec::new();
		};
		windows.push(CalendarWindow { from: start, to });
		start = next;
	}
	windows
}

/// A calendar failure from Finnhub's answer status (`calendarFailure`).
fn calendar_failure(status: Option<u16>) -> EarningsMarketCalendarFailure {
	EarningsMarketCalendarFailure {
		code: failure(status).code,
		upstream_status: status,
	}
}

/// A failure Finnhub's answer did not cause (a refused grant, an unexpected shape).
const OWN_FAILURE: EarningsMarketCalendarFailure = EarningsMarketCalendarFailure {
	code: Code::SourceFailed,
	upstream_status: None,
};

/// The rows of the walk so far: one per stock and period, the first wins.
#[derive(Default)]
struct CalendarRows {
	events: Vec<EarningsCalendarEvent>,
	seen: HashSet<String>,
	truncated_dates: Vec<String>,
}

impl CalendarRows {
	/// Keeps an answer's rows dated inside the window it asked.
	fn keep(&mut self, rows: &[Value], window: &CalendarWindow) {
		for row in rows {
			let Some(date) = text(row, "date") else {
				continue;
			};
			if !is_iso_date(date) || date < window.from.as_str() || date > window.to.as_str() {
				continue;
			}
			let Some(symbol) = text(row, "symbol").and_then(finnhub_calendar_symbol) else {
				continue;
			};
			let Some(event) = row_event(row, date) else {
				continue;
			};
			let key = format!("{symbol}\u{0}{}", event.period_key);
			if self.seen.contains(&key) || self.events.len() >= calendar_limits::MAX_EVENTS {
				continue;
			}
			self.seen.insert(key);
			self.events.push(EarningsCalendarEvent::of(symbol, event));
		}
	}
}

impl FinnhubEarningsSource {
	/// One paced request for every company in `window`: its rows, or the failure.
	async fn ask_calendar(
		&self,
		window: &CalendarWindow,
		q: &EarningsMarketCalendarQuery<'_>,
	) -> Result<Vec<Value>, EarningsMarketCalendarFailure> {
		// One grant per request start (API-007); a refused one stops the walk.
		if !q.before_request.before_request().await {
			return Err(OWN_FAILURE);
		}
		let mut options = fetch_options(FINNHUB_HOST, "application/json", q.cancel);
		options.finnhub_token = Some(self.api_key.expose().to_owned());
		let url = endpoint(
			"calendar/earnings",
			&[("from", &window.from), ("to", &window.to)],
		);
		let json = fetch_json_document(self.fetcher.as_ref(), &url, &options)
			.await
			.map_err(|e| calendar_failure(upstream_status_of(&e)))?;
		let rows = array(&json, "earningsCalendar").ok_or(OWN_FAILURE)?;
		if !rows.iter().all(valid_row) {
			return Err(OWN_FAILURE);
		}
		Ok(rows.to_vec())
	}
}

#[async_trait]
impl EarningsMarketCalendarSource for FinnhubEarningsSource {
	fn source_id(&self) -> EarningsSourceId {
		EarningsSourceId::Finnhub
	}
	async fn fetch_calendar(
		&self,
		q: EarningsMarketCalendarQuery<'_>,
	) -> Result<EarningsMarketCalendar, EarningsMarketCalendarFailure> {
		let cap = calendar_limits::FINNHUB_ROW_CAP;
		let mut kept = CalendarRows::default();
		for window in calendar_windows(
			q.from_date,
			q.to_date,
			f64::from(calendar_limits::WINDOW_DAYS),
		) {
			let rows = self.ask_calendar(&window, &q).await?;
			if rows.len() < cap || window.from == window.to {
				if rows.len() >= cap {
					kept.truncated_dates.push(window.from.clone());
				}
				kept.keep(&rows, &window);
				continue;
			}
			// The week hit the cap: ask each of its days instead.
			for day in calendar_windows(&window.from, &window.to, 1.0) {
				let day_rows = self.ask_calendar(&day, &q).await?;
				if day_rows.len() >= cap {
					kept.truncated_dates.push(day.from.clone());
				}
				kept.keep(&day_rows, &day);
			}
		}
		Ok(EarningsMarketCalendar {
			events: kept.events,
			truncated_dates: kept.truncated_dates,
		})
	}
}
