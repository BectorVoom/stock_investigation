//! Watchlist and earnings dates (`packages/contracts/src/watchlist.ts`).

use research_js::json::Value;
use serde::Serialize;

use crate::patterns;
use crate::primitives::ISO_DATE;
use crate::zod::{Cx, StrCheck, decode_object, js_enum, nullable, run_string, string};

/// `EARNINGS_LIMITS`: the domain's [`WATCHLIST_LIMITS`].
pub mod limits {
	use research_domain::watchlist::limits::WATCHLIST_LIMITS;

	/// Stocks on the watchlist.
	pub const MAX_STOCKS: usize = WATCHLIST_LIMITS.max_stocks;
	/// Events kept per stock.
	pub const MAX_EVENTS_PER_STOCK: usize = WATCHLIST_LIMITS.max_events_per_stock;
	/// How far ahead a refresh looks, in days.
	pub const HORIZON_DAYS: u32 = WATCHLIST_LIMITS.horizon_days;
}

/// Longest company name the API stores.
pub const EARNINGS_COMPANY_NAME_MAX: usize = 200;

/// `watchMarketSchema`, `earningsSourceIdSchema`, the market → source
/// mapping and `parseStockId` / `formatStockId` are the domain's
/// (`watchlist/stockId.ts`, `watchlist/limits.ts`).
pub use research_domain::watchlist::limits::{
	EarningsSourceId, EarningsSourceInfo, WATCHLIST_LIMITS, earnings_source_by_market,
	earnings_source_info,
};
pub use research_domain::watchlist::stock_id::{
	StockId, StockIdError, WatchMarket, format_stock_id, parse_stock_id,
};

/// A parsed `"<market>:<symbol>"` stock id (the domain's [`StockId`], under
/// its former contracts name).
pub type StockIdParts<'a> = StockId<'a>;

/// `watchlistStockIdSchema`.
pub(crate) const WATCHLIST_STOCK_ID: &[StrCheck] = &[
	StrCheck::Max(64),
	StrCheck::Refine(
		|value| parse_stock_id(value).is_ok(),
		"invalid watchlist stock id",
	),
];

/// `watchlistStockIdSchema` decoder.
pub(crate) fn watchlist_stock_id(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, WATCHLIST_STOCK_ID)
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
