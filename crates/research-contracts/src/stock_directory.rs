//! The stock directory (`packages/contracts/src/stockDirectory.ts`, ADR-0034):
//! every exchange-listed US and Japanese stock, downloaded by the runner one
//! market per job. Only the parts the runner reaches are ported: the limits,
//! the listings, the failure codes, the entry schema and the refinement of
//! the `stock-directory-refreshed` completion.

use std::collections::HashSet;

use research_js::json::Value;
use serde::Serialize;

use crate::watchlist::{EARNINGS_COMPANY_NAME_MAX, WatchMarket, format_stock_id, parse_stock_id};
use crate::zod::{Cx, StrCheck, decode_object, js_enum, optional, string};

/// `STOCK_DIRECTORY_LIMITS` (the runner-side part).
pub mod limits {
	/// Most rows one market's completion may carry (measured 2026-10-24: US 7,691, JP 3,707).
	pub const MAX_ENTRIES_PER_MARKET: usize = 10_000;
	/// Fewest rows one market's completion may carry: a changed source layout
	/// that parses to a handful of rows can never replace a good stored list.
	pub const MIN_ENTRIES_PER_MARKET: usize = 1_000;
	/// Longest stored name, in UTF-16 units.
	pub const MAX_NAME_CHARS: usize = super::EARNINGS_COMPANY_NAME_MAX;
}

js_enum! {
	/// `stockListingSchema`: where a listing trades.
	pub enum StockListing {
		Nasdaq = "nasdaq",
		Nyse = "nyse",
		Cboe = "cboe",
		Txse = "txse",
		TsePrime = "tse-prime",
		TseStandard = "tse-standard",
		TseGrowth = "tse-growth",
	}
}

/// `STOCK_LISTINGS_BY_MARKET`.
#[must_use]
pub const fn listings_by_market(market: WatchMarket) -> &'static [StockListing] {
	match market {
		WatchMarket::Us => &[
			StockListing::Nasdaq,
			StockListing::Nyse,
			StockListing::Cboe,
			StockListing::Txse,
		],
		WatchMarket::Jp => &[
			StockListing::TsePrime,
			StockListing::TseStandard,
			StockListing::TseGrowth,
		],
	}
}

js_enum! {
	/// `stockDirectorySourceIdSchema`.
	pub enum StockDirectorySourceId {
		Sec = "sec",
		Jpx = "jpx",
	}
}

/// `STOCK_DIRECTORY_SOURCES[market].sourceId`: the source of each market's
/// list, which is also the runner's pacing key for it.
#[must_use]
pub const fn stock_directory_source_id(market: WatchMarket) -> StockDirectorySourceId {
	match market {
		WatchMarket::Us => StockDirectorySourceId::Sec,
		WatchMarket::Jp => StockDirectorySourceId::Jpx,
	}
}

js_enum! {
	/// `stockDirectoryFailureCodeSchema` (`STOCK_DIRECTORY_FAILURE_CODES`):
	/// the `failureCode` of a failed `stock-directory-refresh` job.
	pub enum StockDirectoryFailureCode {
		/// US only: `SEC_USER_AGENT` is not set.
		NotConfigured = "DIRECTORY_NOT_CONFIGURED",
		/// The source answered HTTP 429.
		RateLimited = "DIRECTORY_RATE_LIMITED",
		/// A network or other HTTP failure.
		SourceFailed = "DIRECTORY_SOURCE_FAILED",
		/// The file arrived but did not parse, or parsed to fewer than the floor.
		ParseFailed = "DIRECTORY_PARSE_FAILED",
	}
}

const SYMBOL: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(16)];
const NAME: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_NAME_CHARS),
];

/// `stockDirectoryEntrySchema`: one listed stock as the runner sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDirectoryEntry {
	/// Symbol (US) or local code (JP).
	pub symbol: String,
	/// The English name (trimmed, 1..200).
	pub name: String,
	/// The Japanese name of a JP listing; absent for US rows.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub local_name: Option<String>,
	/// Where it trades.
	pub listing: StockListing,
}

impl StockDirectoryEntry {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			symbol: "symbol" => string(SYMBOL),
			name: "name" => string(NAME),
			local_name: "localName" => optional(string(NAME)),
			listing: "listing" => StockListing::decode,
		})
	}
}

/// `stockDirectoryEntriesProblem`: the first problem with a market's
/// entries (the completion's refinement message), or `None` when valid.
#[must_use]
pub fn stock_directory_entries_problem(
	market: WatchMarket,
	entries: &[StockDirectoryEntry],
) -> Option<String> {
	let listings = listings_by_market(market);
	let mut seen: HashSet<&str> = HashSet::with_capacity(entries.len());
	for entry in entries {
		if parse_stock_id(&format_stock_id(market, &entry.symbol)).is_err() {
			return Some(format!(
				"symbol {} does not match the {} shape",
				entry.symbol,
				market.as_str()
			));
		}
		if !listings.contains(&entry.listing) {
			return Some(format!(
				"listing {} is not a {} listing",
				entry.listing.as_str(),
				market.as_str()
			));
		}
		if market == WatchMarket::Us && entry.local_name.is_some() {
			return Some("US rows carry no localName".to_owned());
		}
		if !seen.insert(entry.symbol.as_str()) {
			return Some(format!("symbol {} is listed twice", entry.symbol));
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	fn entry(symbol: &str, local: Option<&str>, listing: StockListing) -> StockDirectoryEntry {
		StockDirectoryEntry {
			symbol: symbol.to_owned(),
			name: "Name".to_owned(),
			local_name: local.map(str::to_owned),
			listing,
		}
	}

	#[test]
	fn the_first_problem_is_named_like_the_typescript() {
		let us = |symbol| entry(symbol, None, StockListing::Nyse);
		assert_eq!(
			stock_directory_entries_problem(WatchMarket::Us, &[us("AAPL"), us("MSFT")]),
			None
		);
		assert_eq!(
			stock_directory_entries_problem(WatchMarket::Us, &[us("7203")]).as_deref(),
			Some("symbol 7203 does not match the US shape")
		);
		assert_eq!(
			stock_directory_entries_problem(
				WatchMarket::Jp,
				&[entry("7203", Some("x"), StockListing::Nyse)]
			)
			.as_deref(),
			Some("listing nyse is not a JP listing")
		);
		assert_eq!(
			stock_directory_entries_problem(
				WatchMarket::Us,
				&[entry("AAPL", Some("x"), StockListing::Nasdaq)]
			)
			.as_deref(),
			Some("US rows carry no localName")
		);
		assert_eq!(
			stock_directory_entries_problem(WatchMarket::Us, &[us("AAPL"), us("AAPL")]).as_deref(),
			Some("symbol AAPL is listed twice")
		);
	}

	#[test]
	fn each_market_has_its_source() {
		assert_eq!(stock_directory_source_id(WatchMarket::Us).as_str(), "sec");
		assert_eq!(stock_directory_source_id(WatchMarket::Jp).as_str(), "jpx");
		assert_eq!(listings_by_market(WatchMarket::Jp).len(), 3);
	}
}
