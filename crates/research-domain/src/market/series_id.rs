//! Port of `packages/domain/src/market/seriesId.ts`.

use crate::literal::js_literal_enum;

js_literal_enum! {
	/// A market data provider.
	pub enum MarketProviderId {
		/// `fred`.
		Fred = "fred",
		/// `twelve-data`.
		TwelveData = "twelve-data",
	}
}

/// `INVALID_SERIES_ID`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("INVALID_SERIES_ID")]
pub struct SeriesIdError;

/// A parsed series id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketSeriesId<'a> {
	/// The provider.
	pub provider: MarketProviderId,
	/// The provider's symbol.
	pub symbol: &'a str,
}

const fn is_upper_alnum(byte: u8) -> bool {
	byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

/// `/^[A-Z0-9]{1,25}$/`.
fn is_fred_symbol(symbol: &str) -> bool {
	(1..=25).contains(&symbol.len()) && symbol.bytes().all(is_upper_alnum)
}

/// `/^[A-Z0-9][A-Z0-9./-]{0,19}(:[A-Z0-9]{2,10})?$/`. The middle class has no
/// `:`, so the first `:` after the first character splits symbol and exchange
/// without backtracking.
fn is_twelve_data_symbol(symbol: &str) -> bool {
	let bytes = symbol.as_bytes();
	let Some((first, rest)) = bytes.split_first() else {
		return false;
	};
	if !is_upper_alnum(*first) {
		return false;
	}
	let (body, exchange) = match rest.iter().position(|byte| *byte == b':') {
		Some(colon) => (rest.get(..colon).unwrap_or_default(), rest.get(colon + 1..)),
		None => (rest, None),
	};
	body.len() <= 19
		&& body
			.iter()
			.all(|byte| is_upper_alnum(*byte) || matches!(byte, b'.' | b'/' | b'-'))
		&& exchange.is_none_or(|exchange| {
			(2..=10).contains(&exchange.len()) && exchange.iter().all(|byte| is_upper_alnum(*byte))
		})
}

/// `parseMarketSeriesId`: splits `"<provider>:<symbol>"` at the first `:`
/// and checks the provider-specific symbol shape.
///
/// # Errors
///
/// [`SeriesIdError`] for an unknown provider or a malformed symbol.
pub fn parse_market_series_id(value: &str) -> Result<MarketSeriesId<'_>, SeriesIdError> {
	let Some((provider, symbol)) = value
		.split_once(':')
		.filter(|(provider, _)| !provider.is_empty())
	else {
		return Err(SeriesIdError);
	};
	match provider {
		"fred" if is_fred_symbol(symbol) => Ok(MarketSeriesId {
			provider: MarketProviderId::Fred,
			symbol,
		}),
		"twelve-data" if is_twelve_data_symbol(symbol) => Ok(MarketSeriesId {
			provider: MarketProviderId::TwelveData,
			symbol,
		}),
		_ => Err(SeriesIdError),
	}
}

/// `formatMarketSeriesId`.
#[must_use]
pub fn format_market_series_id(provider: MarketProviderId, symbol: &str) -> String {
	format!("{}:{symbol}", provider.as_str())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_provider_symbols() {
		assert!(parse_market_series_id("fred:VIXCLS").is_ok());
		assert!(parse_market_series_id("fred:vix").is_err());
		assert!(parse_market_series_id(":VIX").is_err());
		assert!(parse_market_series_id("twelve-data:7203:XTKS").is_ok());
		assert!(parse_market_series_id("twelve-data:BRK.B").is_ok());
		assert!(parse_market_series_id("twelve-data:A:B").is_err());
		assert!(parse_market_series_id("twelve-data:.A").is_err());
		assert!(parse_market_series_id("twelve-data:A:BB:CC").is_err());
	}
}
