//! Watchlist and earnings dates (`packages/contracts/src/watchlist.ts`).

use research_js::json::Value;
use serde::Serialize;

use crate::patterns;
use crate::primitives::ISO_DATE;
use crate::zod::{Cx, StrCheck, decode_object, js_enum, nullable, run_string, string};

/// `EARNINGS_LIMITS` (the domain's `WATCHLIST_LIMITS`).
pub mod limits {
	/// Stocks on the watchlist.
	pub const MAX_STOCKS: usize = 50;
	/// Events kept per stock.
	pub const MAX_EVENTS_PER_STOCK: usize = 8;
	/// How far ahead a refresh looks, in days.
	pub const HORIZON_DAYS: usize = 185;
}

/// Longest company name the API stores.
pub const EARNINGS_COMPANY_NAME_MAX: usize = 200;

js_enum! {
	/// `watchMarketSchema`.
	pub enum WatchMarket {
		Us = "US",
		Jp = "JP",
	}
}

/// A parsed `"<market>:<symbol>"` stock id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StockIdParts<'a> {
	/// The market.
	pub market: WatchMarket,
	/// The symbol.
	pub symbol: &'a str,
}

/// `parseStockId` (domain `watchlist/stockId.ts`): `us:` + `/^[A-Z][A-Z0-9.-]{0,9}$/`
/// or `jp:` + `/^[0-9][0-9A-Z]{3}$/`.
#[must_use]
pub fn parse_stock_id(value: &str) -> Option<StockIdParts<'_>> {
	let (market, symbol) = value
		.split_once(':')
		.filter(|(market, _)| !market.is_empty())?;
	let bytes = symbol.as_bytes();
	match market {
		"us" => {
			let ok = bytes.split_first().is_some_and(|(first, rest)| {
				first.is_ascii_uppercase()
					&& rest.len() <= 9
					&& rest.iter().all(|byte| {
						byte.is_ascii_uppercase()
							|| byte.is_ascii_digit()
							|| matches!(byte, b'.' | b'-')
					})
			});
			ok.then_some(StockIdParts {
				market: WatchMarket::Us,
				symbol,
			})
		}
		"jp" => {
			let ok = bytes.len() == 4
				&& bytes.split_first().is_some_and(|(first, rest)| {
					first.is_ascii_digit()
						&& rest
							.iter()
							.all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
				});
			ok.then_some(StockIdParts {
				market: WatchMarket::Jp,
				symbol,
			})
		}
		_ => None,
	}
}

/// `formatStockId`: `us:AAPL`, `jp:7203`.
#[must_use]
pub fn format_stock_id(market: WatchMarket, symbol: &str) -> String {
	format!("{}:{symbol}", market.as_str().to_ascii_lowercase())
}

/// `watchlistStockIdSchema`.
pub(crate) const WATCHLIST_STOCK_ID: &[StrCheck] = &[
	StrCheck::Max(64),
	StrCheck::Refine(
		|value| parse_stock_id(value).is_some(),
		"invalid watchlist stock id",
	),
];

/// `watchlistStockIdSchema` decoder.
pub(crate) fn watchlist_stock_id(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, WATCHLIST_STOCK_ID)
}

js_enum! {
	/// `earningsSourceIdSchema`.
	pub enum EarningsSourceId {
		Finnhub = "finnhub",
		Jpx = "jpx",
	}
}

js_enum! {
	/// `earningsTimingSchema`.
	pub enum EarningsTiming {
		BeforeOpen = "before-open",
		AfterClose = "after-close",
		DuringSession = "during-session",
		Unknown = "unknown",
	}
}

js_enum! {
	/// `earningsUnavailableCodeSchema` (`EARNINGS_UNAVAILABLE_CODES`).
	pub enum EarningsUnavailableCode {
		NeverRefreshed = "NEVER_REFRESHED",
		SourceNotConfigured = "SOURCE_NOT_CONFIGURED",
		SourceAuthFailed = "SOURCE_AUTH_FAILED",
		SymbolNotFound = "SYMBOL_NOT_FOUND",
		PlanNotEntitled = "PLAN_NOT_ENTITLED",
		RateLimited = "RATE_LIMITED",
		NoScheduledDate = "NO_SCHEDULED_DATE",
		SourceFailed = "SOURCE_FAILED",
	}
}

impl EarningsUnavailableCode {
	/// `EARNINGS_UNAVAILABLE_REASONS`: the one fixed sentence per code.
	#[must_use]
	pub const fn reason(self) -> &'static str {
		match self {
			Self::NeverRefreshed => "No earnings dates have been refreshed yet; queue a refresh.",
			Self::SourceNotConfigured => {
				"The earnings source is not configured; set the provider key in apps/runner/.env."
			}
			Self::SourceAuthFailed => "The earnings source rejected the configured key.",
			Self::SymbolNotFound => "The earnings source has no listing for this symbol.",
			Self::PlanNotEntitled => {
				"The provider plan does not include earnings dates for this symbol."
			}
			Self::RateLimited => "The provider rate limit was reached; try again later.",
			Self::NoScheduledDate => "The source lists no upcoming announcement for this stock.",
			Self::SourceFailed => "The earnings source request failed.",
		}
	}
}

/// `earningsUnavailableReason(code, sourceId?)`.
#[must_use]
pub const fn earnings_unavailable_reason(
	code: EarningsUnavailableCode,
	source: Option<EarningsSourceId>,
) -> &'static str {
	match (code, source) {
		(EarningsUnavailableCode::SourceNotConfigured, Some(EarningsSourceId::Finnhub)) => {
			"The Finnhub source is not configured; set FINNHUB_API_KEY in apps/runner/.env."
		}
		(EarningsUnavailableCode::SourceNotConfigured, Some(EarningsSourceId::Jpx)) => {
			"The JPX source is not configured."
		}
		_ => code.reason(),
	}
}

/// The period key rule: `/^[a-z0-9-]{1,48}$/`.
pub(crate) const PERIOD_KEY: &[StrCheck] = &[StrCheck::Regex(
	&patterns::PERIOD_KEY,
	Some("period key must match [a-z0-9-]{1,48}"),
)];
const LABEL_80: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(1), StrCheck::Max(80)];

/// `earningsEventSchema`: one scheduled announcement of one stock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningsEvent {
	/// Identifies the fiscal period, never the date.
	pub period_key: String,
	/// Null when the date is undecided.
	pub announcement_date: Option<String>,
	/// Trimmed label (1..80).
	pub fiscal_period_label: String,
	/// Period end, when known.
	pub fiscal_period_end: Option<String>,
	/// Timing.
	pub timing: EarningsTiming,
}

impl EarningsEvent {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			period_key: "periodKey" => string(PERIOD_KEY),
			announcement_date: "announcementDate" => nullable(string(ISO_DATE)),
			fiscal_period_label: "fiscalPeriodLabel" => string(LABEL_80),
			fiscal_period_end: "fiscalPeriodEnd" => nullable(string(ISO_DATE)),
			timing: "timing" => EarningsTiming::decode,
		})
	}
}
