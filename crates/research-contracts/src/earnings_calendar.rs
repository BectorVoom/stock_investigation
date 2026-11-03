//! Every listed stock's upcoming earnings announcements, one job per market
//! (`packages/contracts/src/earningsCalendar.ts`, ADR-0068): the limits, the
//! calendar event and the completion's cross-field rules. The claim and the
//! completion variant live in [`crate::jobs`]; the per-stock view the
//! Stocks page reads stays TypeScript.

use std::cmp::Ordering;
use std::collections::HashSet;

use research_js::json::Value;
use research_js::utf16::compare;
use serde::Serialize;

use crate::primitives::ISO_DATE;
use crate::stock_prices::STOCK_PRICE_SYMBOL;
use crate::watchlist::{EarningsEvent, EarningsTiming, LABEL_80, PERIOD_KEY};
use crate::zod::{ArrCheck, Cx, StrCheck, array, decode_object, nullable, string};

/// `EARNINGS_CALENDAR_LIMITS`.
pub mod limits {
	use crate::watchlist::limits as earnings;

	/// The window, as the Watchlist's: `[today, today + 185 days]` (UTC dates).
	pub const HORIZON_DAYS: u32 = earnings::HORIZON_DAYS;
	/// Days in one Finnhub request; a capped answer is asked again day by day.
	pub const WINDOW_DAYS: u32 = 7;
	/// Finnhub's all-companies answer stops at this many rows.
	pub const FINNHUB_ROW_CAP: usize = 1_500;
	/// Rows one completion may carry.
	pub const MAX_EVENTS: usize = 60_000;
	/// Events the Stocks page gets for one stock.
	pub const MAX_EVENTS_PER_STOCK: usize = earnings::MAX_EVENTS_PER_STOCK;
	/// A market's calendar is synced again once its last sync is this old.
	pub const INTERVAL_HOURS: u32 = 24;
	/// Truncated dates one completion may carry (`horizonDays + 1`).
	pub const MAX_TRUNCATED_DATES: usize = HORIZON_DAYS as usize + 1;
}

const SYMBOL: &[StrCheck] = &[StrCheck::Regex(&STOCK_PRICE_SYMBOL, None)];

/// `earningsCalendarEventSchema`: an earnings event with the stock list's
/// symbol (`BH-A`, `130A`); keys in the schema's order (`symbol` last).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningsCalendarEvent {
	/// Identifies the fiscal period, never the date.
	pub period_key: String,
	/// Null when the date is undecided (JPX 未定).
	pub announcement_date: Option<String>,
	/// Trimmed label (1..80).
	pub fiscal_period_label: String,
	/// Period end, when known.
	pub fiscal_period_end: Option<String>,
	/// Timing.
	pub timing: EarningsTiming,
	/// The stock list's symbol.
	pub symbol: String,
}

impl EarningsCalendarEvent {
	/// `{ symbol, ...event }`.
	#[must_use]
	pub fn of(symbol: String, event: EarningsEvent) -> Self {
		Self {
			period_key: event.period_key,
			announcement_date: event.announcement_date,
			fiscal_period_label: event.fiscal_period_label,
			fiscal_period_end: event.fiscal_period_end,
			timing: event.timing,
			symbol,
		}
	}

	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			period_key: "periodKey" => string(PERIOD_KEY),
			announcement_date: "announcementDate" => nullable(string(ISO_DATE)),
			fiscal_period_label: "fiscalPeriodLabel" => string(LABEL_80),
			fiscal_period_end: "fiscalPeriodEnd" => nullable(string(ISO_DATE)),
			timing: "timing" => EarningsTiming::decode,
			symbol: "symbol" => string(SYMBOL),
		})
	}
}

impl crate::Contract for EarningsCalendarEvent {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		Self::decode(cx, input)
	}
}

/// `earningsCalendarCompletionShape.events`.
pub(crate) fn completion_events(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Vec<EarningsCalendarEvent>> {
	array(
		EarningsCalendarEvent::decode,
		&[ArrCheck::Max(limits::MAX_EVENTS)],
	)(cx, input)
}

/// `earningsCalendarCompletionShape.truncatedDates`.
pub(crate) fn completion_truncated_dates(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Vec<String>> {
	array(
		string(ISO_DATE),
		&[ArrCheck::Max(limits::MAX_TRUNCATED_DATES)],
	)(cx, input)
}

/// JavaScript's `a < b` on strings (UTF-16 code units).
fn before(a: &str, b: &str) -> bool {
	compare(a, b) == Ordering::Less
}

/// `earningsCalendarCompletionProblem`: what a completion's fields must
/// agree on, the first rule broken in the TypeScript's order; `None` when
/// they do.
#[must_use]
pub fn earnings_calendar_completion_problem(
	from_date: &str,
	to_date: &str,
	events: &[EarningsCalendarEvent],
	truncated_dates: &[String],
) -> Option<&'static str> {
	if before(to_date, from_date) {
		return Some("fromDate must not be after toDate");
	}
	let mut keys = HashSet::with_capacity(events.len());
	for event in events {
		if let Some(date) = &event.announcement_date
			&& (before(date, from_date) || before(to_date, date))
		{
			return Some("every dated event must lie in [fromDate, toDate]");
		}
		// The TypeScript's key: symbol and period joined by a NUL.
		if !keys.insert(format!("{}\u{0}{}", event.symbol, event.period_key)) {
			return Some("a stock's period keys must be distinct");
		}
	}
	let distinct: HashSet<&str> = truncated_dates.iter().map(String::as_str).collect();
	if distinct.len() != truncated_dates.len() {
		return Some("truncated dates must be distinct");
	}
	if truncated_dates
		.iter()
		.any(|date| before(date, from_date) || before(to_date, date))
	{
		return Some("truncated dates must lie in the window");
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	fn event(symbol: &str, period_key: &str, date: Option<&str>) -> EarningsCalendarEvent {
		EarningsCalendarEvent {
			period_key: period_key.to_owned(),
			announcement_date: date.map(str::to_owned),
			fiscal_period_label: "Q3 2026".to_owned(),
			fiscal_period_end: None,
			timing: EarningsTiming::Unknown,
			symbol: symbol.to_owned(),
		}
	}

	#[test]
	fn the_rules_report_the_first_problem() {
		let from = "2026-11-03";
		let to = "2027-05-07";
		assert_eq!(
			earnings_calendar_completion_problem(from, to, &[], &[]),
			None
		);
		assert_eq!(
			earnings_calendar_completion_problem(to, from, &[], &[]),
			Some("fromDate must not be after toDate")
		);
		let dup = [
			event("AAPL", "2026-q3", Some(from)),
			event("AAPL", "2026-q3", None),
		];
		assert_eq!(
			earnings_calendar_completion_problem(from, to, &dup, &[]),
			Some("a stock's period keys must be distinct")
		);
		let other = [
			event("AAPL", "2026-q3", Some(to)),
			event("MSFT", "2026-q3", None),
		];
		assert_eq!(
			earnings_calendar_completion_problem(from, to, &other, &[from.to_owned()]),
			None
		);
		assert_eq!(
			earnings_calendar_completion_problem(
				from,
				to,
				&[event("AAPL", "2026-q3", Some("2026-11-02"))],
				&[]
			),
			Some("every dated event must lie in [fromDate, toDate]")
		);
		assert_eq!(
			earnings_calendar_completion_problem(from, to, &[], &[to.to_owned(), to.to_owned()]),
			Some("truncated dates must be distinct")
		);
		assert_eq!(
			earnings_calendar_completion_problem(from, to, &[], &["2027-05-08".to_owned()]),
			Some("truncated dates must lie in the window")
		);
	}
}
