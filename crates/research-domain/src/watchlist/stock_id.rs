//! Port of `packages/domain/src/watchlist/stockId.ts`.

use serde::{Deserialize, Serialize};

/// The market of a watched stock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WatchMarket {
	/// `US`.
	#[serde(rename = "US")]
	Us,
	/// `JP`.
	#[serde(rename = "JP")]
	Jp,
}

impl WatchMarket {
	/// The TypeScript literal (`"US"` / `"JP"`).
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Us => "US",
			Self::Jp => "JP",
		}
	}
}

/// `INVALID_STOCK_ID`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("INVALID_STOCK_ID")]
pub struct StockIdError;

/// A parsed stock id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StockId<'a> {
	/// The market.
	pub market: WatchMarket,
	/// The symbol or code.
	pub symbol: &'a str,
}

/// `STOCK_SYMBOL_PATTERNS.US`: `/^[A-Z][A-Z0-9.-]{0,9}$/`.
#[must_use]
pub fn is_us_symbol(symbol: &str) -> bool {
	let bytes = symbol.as_bytes();
	matches!(bytes.first(), Some(first) if first.is_ascii_uppercase())
		&& bytes.len() <= 10
		&& bytes.iter().all(|byte| {
			byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
		})
}

/// `STOCK_SYMBOL_PATTERNS.JP`: `/^[0-9][0-9A-Z]{3}$/`.
#[must_use]
pub fn is_jp_code(symbol: &str) -> bool {
	matches!(
		symbol.as_bytes(),
		[first, rest @ ..] if first.is_ascii_digit()
			&& rest.len() == 3
			&& rest.iter().all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
	)
}

/// `parseStockId`: splits `"<market lowercased>:<symbol>"` (`us:AAPL`,
/// `jp:7203`) and checks the market-specific symbol shape.
///
/// # Errors
///
/// [`StockIdError`] for an unknown market or a malformed symbol.
pub fn parse_stock_id(value: &str) -> Result<StockId<'_>, StockIdError> {
	let Some((market, symbol)) = value
		.split_once(':')
		.filter(|(market, _)| !market.is_empty())
	else {
		return Err(StockIdError);
	};
	match market {
		"us" if is_us_symbol(symbol) => Ok(StockId {
			market: WatchMarket::Us,
			symbol,
		}),
		"jp" if is_jp_code(symbol) => Ok(StockId {
			market: WatchMarket::Jp,
			symbol,
		}),
		_ => Err(StockIdError),
	}
}

/// `formatStockId`.
#[must_use]
pub fn format_stock_id(market: WatchMarket, symbol: &str) -> String {
	let prefix = match market {
		WatchMarket::Us => "us",
		WatchMarket::Jp => "jp",
	};
	format!("{prefix}:{symbol}")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_both_markets() {
		assert_eq!(
			parse_stock_id("us:AAPL"),
			Ok(StockId {
				market: WatchMarket::Us,
				symbol: "AAPL"
			})
		);
		assert!(parse_stock_id("jp:130A").is_ok());
		assert!(parse_stock_id("jp:A130").is_err());
		assert!(parse_stock_id("US:AAPL").is_err());
		assert!(parse_stock_id("us:BRK.B:X").is_err());
		assert_eq!(format_stock_id(WatchMarket::Jp, "7203"), "jp:7203");
	}
}
