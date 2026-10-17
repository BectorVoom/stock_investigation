//! Port of `packages/domain/src/watchlist/limits.ts`.

use crate::literal::js_literal_enum;

use super::stock_id::WatchMarket;

/// `WATCHLIST_LIMITS`: the single definition of every watchlist/earnings
/// bound (SPEC section 1). `horizon_days` is the refresh window
/// `[today, today + 185 days]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchlistLimits {
	/// Stocks on one watchlist.
	pub max_stocks: usize,
	/// Earnings events kept per stock.
	pub max_events_per_stock: usize,
	/// Refresh horizon in days.
	pub horizon_days: u32,
}

/// `WATCHLIST_LIMITS`.
pub const WATCHLIST_LIMITS: WatchlistLimits = WatchlistLimits {
	max_stocks: 50,
	max_events_per_stock: 8,
	horizon_days: 185,
};

js_literal_enum! {
	/// `EarningsSourceId`.
	pub enum EarningsSourceId {
		/// `finnhub`.
		Finnhub = "finnhub",
		/// `jpx`.
		Jpx = "jpx",
	}
}

/// `EARNINGS_SOURCE_BY_MARKET`: the ONE market → earnings-source mapping
/// (ARCH-006). US listings come from Finnhub, Japanese ones from JPX.
#[must_use]
pub const fn earnings_source_by_market(market: WatchMarket) -> EarningsSourceId {
	match market {
		WatchMarket::Us => EarningsSourceId::Finnhub,
		WatchMarket::Jp => EarningsSourceId::Jpx,
	}
}

/// Fixed publisher string and source URL of an earnings source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EarningsSourceInfo {
	/// Publisher shown with each event.
	pub publisher: &'static str,
	/// Source URL shown with each event.
	pub source_url: &'static str,
}

/// `EARNINGS_SOURCE_INFO` (SPEC section 6).
#[must_use]
pub const fn earnings_source_info(source: EarningsSourceId) -> EarningsSourceInfo {
	match source {
		EarningsSourceId::Finnhub => EarningsSourceInfo {
			publisher: "Finnhub",
			source_url: "https://finnhub.io/",
		},
		EarningsSourceId::Jpx => EarningsSourceInfo {
			publisher: "Japan Exchange Group (JPX)",
			source_url: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
		},
	}
}
