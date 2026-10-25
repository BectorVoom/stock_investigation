//! Canned stock lists (port of `tests/e2e/directoryFixtures.ts`, ADR-0034):
//! the stock-directory sources answer the lists of the shared fixture file
//! instead of SEC and JPX, padded to the contract's floor, so both E2E
//! runners store the same rows.

use async_trait::async_trait;
use research_contracts::stock_directory::limits;
use research_contracts::watchlist::WatchMarket;
use research_finance::ports::{
	StockDirectoryData, StockDirectoryFailure, StockDirectoryQuery, StockDirectorySource,
};

use crate::fixtures::{DirectoryMarket, FixtureError};

/// One market's canned list.
pub struct FixtureStockDirectorySource {
	market: WatchMarket,
	data: StockDirectoryData,
}

impl FixtureStockDirectorySource {
	/// The canned source of `market`.
	///
	/// # Errors
	/// An unknown listing word in the fixture file.
	pub fn new(market: WatchMarket, fixture: &DirectoryMarket) -> Result<Self, FixtureError> {
		Ok(Self {
			market,
			data: StockDirectoryData {
				as_of: fixture.as_of.clone(),
				entries: fixture.entries(limits::MIN_ENTRIES_PER_MARKET)?,
			},
		})
	}
}

#[async_trait]
impl StockDirectorySource for FixtureStockDirectorySource {
	fn market(&self) -> WatchMarket {
		self.market
	}

	async fn fetch_directory(
		&self,
		_: StockDirectoryQuery<'_>,
	) -> Result<StockDirectoryData, StockDirectoryFailure> {
		Ok(self.data.clone())
	}
}
