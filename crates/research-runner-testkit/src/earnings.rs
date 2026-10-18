//! Canned earnings answers (port of `tests/e2e/earningsFixtures.ts`): known
//! symbols answer dated events, anything else reports the fixed unavailable
//! wording, so the suite only ever shows fixture dates.

use async_trait::async_trait;
use research_contracts::watchlist::{EarningsEvent, EarningsSourceId, EarningsUnavailableCode};
use research_finance::ports::{
	EarningsCalendarSource, EarningsData, EarningsFailure, EarningsQuery, EarningsResult,
};

use crate::fixtures::{EarningsEntry, FixtureError};

const DAY_MS: i64 = 86_400_000;

/// A UTC date `days` from `now_ms`, so fixtures stay upcoming on any day.
fn iso_date_in_days(now_ms: i64, days: i64) -> String {
	let at = now_ms.saturating_add(days.saturating_mul(DAY_MS));
	let iso = research_js::date::epoch_ms_to_iso(at).unwrap_or_default();
	iso.chars().take(10).collect()
}

/// One source's canned answers.
pub struct FixtureEarningsSource {
	source: EarningsSourceId,
	entries: Vec<EarningsEntry>,
	/// What an unknown symbol reports.
	unknown: EarningsUnavailableCode,
}

impl FixtureEarningsSource {
	/// Finnhub: unknown symbols are `SYMBOL_NOT_FOUND`.
	#[must_use]
	pub const fn finnhub(entries: Vec<EarningsEntry>) -> Self {
		Self {
			source: EarningsSourceId::Finnhub,
			entries,
			unknown: EarningsUnavailableCode::SymbolNotFound,
		}
	}

	/// JPX: unknown symbols are `NO_SCHEDULED_DATE` (with no name).
	#[must_use]
	pub const fn jpx(entries: Vec<EarningsEntry>) -> Self {
		Self {
			source: EarningsSourceId::Jpx,
			entries,
			unknown: EarningsUnavailableCode::NoScheduledDate,
		}
	}

	fn answer(&self, symbol: &str, now_ms: i64) -> Result<EarningsResult, FixtureError> {
		let Some(entry) = self.entries.iter().find(|entry| entry.symbol == symbol) else {
			return Ok(Err(
				if self.unknown == EarningsUnavailableCode::NoScheduledDate {
					EarningsFailure::no_date(None)
				} else {
					EarningsFailure::new(self.unknown)
				},
			));
		};
		Ok(Ok(EarningsData {
			name: Some(entry.name.clone()),
			events: vec![EarningsEvent {
				period_key: entry.period_key.clone(),
				announcement_date: Some(iso_date_in_days(now_ms, entry.offset_days)),
				fiscal_period_label: entry.fiscal_period_label.clone(),
				fiscal_period_end: entry.fiscal_period_end.clone(),
				timing: entry.timing()?,
			}],
		}))
	}
}

#[async_trait]
impl EarningsCalendarSource for FixtureEarningsSource {
	fn source_id(&self) -> EarningsSourceId {
		self.source
	}

	async fn fetch_earnings(&self, query: EarningsQuery<'_>) -> Vec<EarningsResult> {
		let now_ms = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(0));
		query
			.stocks
			.iter()
			.map(|stock| {
				// A malformed timing word in the fixture file is a source failure.
				self.answer(&stock.symbol, now_ms).unwrap_or_else(|_| {
					Err(EarningsFailure::new(EarningsUnavailableCode::SourceFailed))
				})
			})
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dates_are_offsets_from_the_request_day() {
		// 2026-10-18T00:00:00Z plus 16 days.
		assert_eq!(iso_date_in_days(1_792_281_600_000, 16), "2026-11-03");
		assert_eq!(iso_date_in_days(1_792_281_600_000, 0), "2026-10-18");
	}
}
