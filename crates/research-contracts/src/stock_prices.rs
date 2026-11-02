//! Daily prices of every directory stock, one request per market and date
//! (`packages/contracts/src/stockPrices.ts`, ADR-0058 §2): the fields of the
//! `stock-prices-sync` claim and of the `stock-prices-synced` completion,
//! their limits and the completion's cross-field rules.

use research_js::json::{Object, Value};
use serde::Serialize;

use crate::market::MarketBar;
use crate::primitives::{ISO_DATE, ISO_DATE_TIME, upstream_status};
use crate::watchlist::WatchMarket;
use crate::zod::{
	ArrCheck, Cx, Pattern, StrCheck, array, decode_fields, decode_object, js_enum, nullable,
	number, optional, refine, string, tuple_items,
};

/// `STOCK_PRICE_LIMITS`.
pub mod limits {
	/// Days one job asks for: 2 minutes at the free plans' 5 requests a minute.
	pub const MAX_DAYS_PER_JOB: usize = 10;
	/// Per-stock window fetches one job asks for or adds (splits).
	pub const MAX_HISTORIES_PER_JOB: usize = 10;
	/// Massive's grouped daily answered ~11,000 tickers in 2026; room above it.
	pub const MAX_BARS_PER_DAY: usize = 15_000;
	/// Two years of weekdays and room for the provider's extra days.
	pub const MAX_BARS_PER_HISTORY: usize = 600;
	/// How far back the day walk goes (both free plans keep two years).
	pub const HISTORY_DAYS: i64 = 730;
	/// A `not-yet-available` day is asked again after this long.
	pub const RETRY_HOURS: i64 = 6;
	/// An empty answer for a day at most this many days old is
	/// `not-yet-available`, older `no-trading`.
	pub const SETTLE_DAYS: i64 = 3;
	/// Split symbols one completion may list.
	pub const MAX_SPLIT_SYMBOLS: usize = 1000;
}

js_enum! {
	/// `stockPriceProviderSchema`: the providers that write directory stocks' daily bars.
	pub enum StockPriceProvider {
		Massive = "massive",
		Jquants = "jquants",
	}
}

/// `STOCK_PRICE_PROVIDER_OF_MARKET`: the provider of each market's stock prices.
#[must_use]
pub const fn stock_price_provider_of_market(market: WatchMarket) -> StockPriceProvider {
	match market {
		WatchMarket::Us => StockPriceProvider::Massive,
		WatchMarket::Jp => StockPriceProvider::Jquants,
	}
}

js_enum! {
	/// `stockPriceDayOutcomeSchema`: what became of one requested day.
	pub enum StockPriceDayOutcome {
		/// Bars returned (any count ≥ 1).
		Stored = "stored",
		/// No bars for a day old enough to be final (a holiday).
		NoTrading = "no-trading",
		/// No bars yet for a recent day, or a day newer than the plan's delay.
		NotYetAvailable = "not-yet-available",
		/// Before the plan's history.
		TooOld = "too-old",
	}
}

js_enum! {
	/// `stockHistoryResultSchema.reason`.
	pub enum StockHistoryReason {
		/// The claim named the stock.
		Requested = "requested",
		/// A split after `adjustmentsSince` made its stored bars inconsistent.
		Split = "split",
	}
}

js_enum! {
	/// `stockHistoryResultSchema.outcome`.
	pub enum StockHistoryOutcome {
		/// The window's bars.
		Stored = "stored",
		/// The provider does not know the stock (stored as `SERIES_NOT_FOUND`).
		NotFound = "not-found",
		/// The provider refused or failed this stock's window (no bars).
		Unavailable = "unavailable",
	}
}

/// `stockPriceSymbolSchema`: `/^[A-Z0-9][A-Z0-9.-]{0,15}$/`.
pub static STOCK_PRICE_SYMBOL: Pattern = Pattern {
	source: "/^[A-Z0-9][A-Z0-9.-]{0,15}$/",
	matches: is_stock_price_symbol,
};

/// Whether `text` matches `stockPriceSymbolSchema`.
#[must_use]
pub fn is_stock_price_symbol(text: &str) -> bool {
	let upper_digit = |byte: u8| byte.is_ascii_uppercase() || byte.is_ascii_digit();
	let bytes = text.as_bytes();
	(1..=16).contains(&bytes.len())
		&& bytes.split_first().is_some_and(|(head, tail)| {
			upper_digit(*head)
				&& tail
					.iter()
					.all(|byte| upper_digit(*byte) || matches!(byte, b'.' | b'-'))
		})
}

const SYMBOL: &[StrCheck] = &[StrCheck::Regex(&STOCK_PRICE_SYMBOL, None)];

fn symbol(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	string(SYMBOL)(cx, input)
}

/// The tuple refinement's message (`stockDayBarSchema`, `stockHistoryBarSchema`).
const INCONSISTENT_BAR: &str = "a bar needs low ≤ open, close ≤ high";

/// `stockDayBarSchema`: `[symbol, close, [open, high, low, volume|null]]`.
#[derive(Debug, Clone, PartialEq)]
pub struct StockDayBar(pub String, pub f64, pub MarketBar);

/// `stockHistoryBarSchema`: `[date, close, [open, high, low, volume|null]]`.
#[derive(Debug, Clone, PartialEq)]
pub struct StockHistoryBar(pub String, pub f64, pub MarketBar);

impl Serialize for StockDayBar {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		(&self.0, self.1, &self.2).serialize(serializer)
	}
}

impl Serialize for StockHistoryBar {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		(&self.0, self.1, &self.2).serialize(serializer)
	}
}

/// A `[text, close, bar]` tuple whose text is checked by `first`, refined
/// like zod's `.refine` (only when nothing in the tuple aborted).
fn decode_bar_tuple(
	cx: &mut Cx,
	input: Option<&Value>,
	first: impl Fn(&mut Cx, Option<&Value>) -> Option<String>,
) -> Option<(String, f64, MarketBar)> {
	let mark = cx.mark();
	let items = tuple_items(cx, input, 3, 3)?;
	let text = cx.at_index(0, |cx| first(cx, items.first()));
	let close = cx.at_index(1, |cx| number(&[])(cx, items.get(1)));
	let bar = cx.at_index(2, |cx| MarketBar::decode(cx, items.get(2)));
	let decoded = match (text, close, bar) {
		(Some(text), Some(close), Some(bar)) => Some((text, close, bar)),
		_ => None,
	};
	refine(cx, mark, decoded.as_ref(), |cx, (_, close, bar)| {
		if !bar.is_consistent_with(*close) {
			cx.refine_failed(None, INCONSISTENT_BAR);
		}
	});
	decoded
}

impl StockDayBar {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_bar_tuple(cx, input, symbol).map(|(symbol, close, bar)| Self(symbol, close, bar))
	}
}

impl StockHistoryBar {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_bar_tuple(cx, input, string(ISO_DATE))
			.map(|(date, close, bar)| Self(date, close, bar))
	}
}

/// `stockHistoryRequestSchema`: one stock whose whole window the runner fetches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StockHistoryRequest {
	/// The directory symbol.
	pub symbol: String,
	/// First day of the window.
	pub from: String,
	/// Last day of the window.
	pub to: String,
}

impl StockHistoryRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			symbol: "symbol" => symbol,
			from: "from" => string(ISO_DATE),
			to: "to" => string(ISO_DATE),
		})
	}
}

/// The fields of a `stock-prices-sync` claimed job besides the lease
/// (`stockPricesClaimShape`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockPricesClaim {
	/// The market.
	pub market: WatchMarket,
	/// Newest first, distinct weekdays (≤ 10).
	pub days: Vec<String>,
	/// Owed split refetches, then directory stocks whose history was never filled (≤ 10).
	pub histories: Vec<StockHistoryRequest>,
	/// The newest day the market's split check covered completely (the last
	/// completion's `split_checked_through`), `None` when never checked.
	pub adjustments_since: Option<String>,
	/// The first day of the window, for split refetches.
	pub window_start: String,
}

/// The claim's keys besides `kind` and the lease.
pub(crate) const CLAIM_KEYS: [&str; 5] = [
	"market",
	"days",
	"histories",
	"adjustmentsSince",
	"windowStart",
];

const DAYS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_DAYS_PER_JOB)];
const HISTORIES: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_HISTORIES_PER_JOB)];

/// Decodes the claim's fields of an object already known to be one.
pub(crate) fn decode_claim_fields(cx: &mut Cx, object: &Object) -> Option<StockPricesClaim> {
	decode_fields!(cx, object, StockPricesClaim {
		market: "market" => <WatchMarket as crate::Contract>::decode,
		days: "days" => array(string(ISO_DATE), DAYS),
		histories: "histories" => array(StockHistoryRequest::decode, HISTORIES),
		adjustments_since: "adjustmentsSince" => nullable(string(ISO_DATE)),
		window_start: "windowStart" => string(ISO_DATE),
	})
}

/// The claim member's refinement: at least one day or history.
pub(crate) fn claim_rules(cx: &mut Cx, claim: &StockPricesClaim) {
	if claim.days.is_empty() && claim.histories.is_empty() {
		cx.refine_failed(
			Some("days"),
			"a stock-prices-sync asks for at least one day or history",
		);
	}
}

/// `stockPriceDayResultSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockPriceDayResult {
	/// The requested day.
	pub date: String,
	/// What became of it.
	pub outcome: StockPriceDayOutcome,
	/// Its bars (only a stored day has any; ≤ 15,000).
	pub bars: Vec<StockDayBar>,
	/// The provider's HTTP status when it answered with an error (ADR-0037).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub upstream_status: Option<u16>,
}

const DAY_BARS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_BARS_PER_DAY)];
const HISTORY_BARS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_BARS_PER_HISTORY)];

impl StockPriceDayResult {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			date: "date" => string(ISO_DATE),
			outcome: "outcome" => StockPriceDayOutcome::decode,
			bars: "bars" => array(StockDayBar::decode, DAY_BARS),
			upstream_status: "upstreamStatus" => optional(upstream_status),
		})
	}
}

/// `stockHistoryResultSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StockHistoryResult {
	/// The directory symbol.
	pub symbol: String,
	/// Why it was fetched.
	pub reason: StockHistoryReason,
	/// Stored, or unknown to the provider.
	pub outcome: StockHistoryOutcome,
	/// First day of the window.
	pub from: String,
	/// Last day of the window.
	pub to: String,
	/// Ascending bars (≤ 600; none when not found).
	pub bars: Vec<StockHistoryBar>,
}

impl StockHistoryResult {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			symbol: "symbol" => symbol,
			reason: "reason" => StockHistoryReason::decode,
			outcome: "outcome" => StockHistoryOutcome::decode,
			from: "from" => string(ISO_DATE),
			to: "to" => string(ISO_DATE),
			bars: "bars" => array(StockHistoryBar::decode, HISTORY_BARS),
		})
	}
}

/// `stockPricesCompletionShape.days`.
pub(crate) fn completion_days(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Vec<StockPriceDayResult>> {
	array(StockPriceDayResult::decode, DAYS)(cx, input)
}

const COMPLETION_HISTORIES: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_HISTORIES_PER_JOB * 2)];

/// `stockPricesCompletionShape.histories`.
pub(crate) fn completion_histories(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Vec<StockHistoryResult>> {
	array(StockHistoryResult::decode, COMPLETION_HISTORIES)(cx, input)
}

const SPLIT_SYMBOLS: &[ArrCheck] = &[ArrCheck::Max(limits::MAX_SPLIT_SYMBOLS)];

/// `stockPricesCompletionShape.splitSymbols`.
pub(crate) fn completion_split_symbols(cx: &mut Cx, input: Option<&Value>) -> Option<Vec<String>> {
	array(symbol, SPLIT_SYMBOLS)(cx, input)
}

/// `stockPricesCompletionShape.splitCheckedThrough`.
pub(crate) fn completion_split_checked_through(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Option<String>> {
	nullable(string(ISO_DATE))(cx, input)
}

/// `stockPricesCompletionShape.fetchedAt`.
pub(crate) fn fetched_at(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	string(ISO_DATE_TIME)(cx, input)
}

/// `stockPricesCompletionProblem`: the first problem of a completion's
/// cross-field rules, or `None`.
#[must_use]
pub fn stock_prices_completion_problem(
	market: WatchMarket,
	provider: StockPriceProvider,
	days: &[StockPriceDayResult],
	histories: &[StockHistoryResult],
	split_symbols: &[String],
) -> Option<String> {
	let expected = stock_price_provider_of_market(market);
	if expected != provider {
		return Some(format!(
			"{} prices come from {}",
			market.as_str(),
			expected.as_str()
		));
	}
	let mut dates = std::collections::HashSet::new();
	for day in days {
		if !dates.insert(day.date.as_str()) {
			return Some(format!("day {} is reported twice", day.date));
		}
		if (day.outcome == StockPriceDayOutcome::Stored) != !day.bars.is_empty() {
			return Some(format!("day {}: only a stored day carries bars", day.date));
		}
	}
	for history in histories {
		if history.outcome != StockHistoryOutcome::Stored && !history.bars.is_empty() {
			return Some(format!(
				"history {}: only a stored history carries bars",
				history.symbol
			));
		}
		if history.from > history.to {
			return Some(format!("history {}: from is after to", history.symbol));
		}
		if history.reason == StockHistoryReason::Split && !split_symbols.contains(&history.symbol) {
			return Some(format!(
				"history {}: a split refetch names a symbol not in splitSymbols",
				history.symbol
			));
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_symbol_pattern_matches_like_the_regex() {
		for good in ["A", "BRK-B", "1380", "130A", "BF.B", "ABCDEFGHIJKLMNOP"] {
			assert!(is_stock_price_symbol(good), "{good}");
		}
		for bad in ["", "-A", ".A", "abc", "BRK B", "ABCDEFGHIJKLMNOPQ", "Ä"] {
			assert!(!is_stock_price_symbol(bad), "{bad}");
		}
	}

	#[test]
	fn the_provider_follows_the_market() {
		assert_eq!(
			stock_price_provider_of_market(WatchMarket::Us),
			StockPriceProvider::Massive
		);
		assert!(
			stock_prices_completion_problem(
				WatchMarket::Jp,
				StockPriceProvider::Massive,
				&[],
				&[],
				&[]
			)
			.is_some()
		);
	}
}
