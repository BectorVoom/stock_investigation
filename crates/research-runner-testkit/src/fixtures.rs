//! The shared fixture file `tests/e2e/fixtures/e2e-fixtures.json`: read by the
//! TypeScript specs, the E2E Worker and this crate, so none can disagree about
//! the feed, the headline or the earnings dates.

use std::path::{Path, PathBuf};

use research_contracts::stock_directory::{StockDirectoryEntry, StockListing};
use research_contracts::watchlist::EarningsTiming;
use serde::Deserialize;

/// Why the fixtures could not be loaded.
#[derive(Debug, thiserror::Error)]
pub enum FixtureError {
	/// The file could not be read.
	#[error("fixture file {0} could not be read")]
	Unreadable(PathBuf),
	/// The file is not the expected JSON.
	#[error("fixture file {0} is malformed")]
	Malformed(PathBuf),
	/// An earnings entry names an unknown timing.
	#[error("fixture timing {0:?} is unknown")]
	UnknownTiming(String),
	/// A stock-directory entry names an unknown listing.
	#[error("fixture listing {0:?} is unknown")]
	UnknownListing(String),
}

/// One canned earnings announcement.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningsEntry {
	/// Provider symbol the entry answers for.
	pub symbol: String,
	/// Company name.
	pub name: String,
	/// Days from today (UTC) to the announcement.
	pub offset_days: i64,
	/// Fiscal period key.
	pub period_key: String,
	/// Fiscal period label.
	pub fiscal_period_label: String,
	/// Period end date, when known.
	pub fiscal_period_end: Option<String>,
	timing: String,
}

impl EarningsEntry {
	/// The announcement timing.
	///
	/// # Errors
	/// An unknown timing word in the fixture file.
	pub fn timing(&self) -> Result<EarningsTiming, FixtureError> {
		EarningsTiming::from_str_value(&self.timing)
			.ok_or_else(|| FixtureError::UnknownTiming(self.timing.clone()))
	}
}

/// The canned earnings answers per source.
#[derive(Clone, Debug, Deserialize)]
pub struct EarningsFixtures {
	/// US stocks (Finnhub).
	pub finnhub: Vec<EarningsEntry>,
	/// Japanese stocks (JPX).
	pub jpx: Vec<EarningsEntry>,
}

/// One named row of a canned stock list.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryRow {
	/// Symbol or local code.
	pub symbol: String,
	/// English name.
	pub name: String,
	/// Japanese name (JP rows).
	#[serde(default)]
	pub local_name: Option<String>,
	listing: String,
}

/// How a canned list is padded to the contract's floor.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryPadding {
	/// Symbol prefix (`ZA`, `9`).
	pub symbol_prefix: String,
	/// Zero-padded digits after the prefix.
	pub digits: usize,
	/// Name template; `{n}` is the 1-based row number.
	pub name: String,
	/// Japanese-name template, when the market has one.
	pub local_name: Option<String>,
	listing: String,
}

/// One market's canned list.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryMarket {
	/// The date the canned list states.
	pub as_of: Option<String>,
	/// The named rows the specs search for.
	pub entries: Vec<DirectoryRow>,
	/// Generated rows up to the floor.
	pub padding: DirectoryPadding,
}

fn listing(text: &str) -> Result<StockListing, FixtureError> {
	StockListing::from_str_value(text).ok_or_else(|| FixtureError::UnknownListing(text.to_owned()))
}

impl DirectoryMarket {
	/// The full list (port of `fixtureDirectoryEntries`): the named rows, then
	/// padding rows numbered from 1 up to exactly `floor` rows.
	///
	/// # Errors
	/// An unknown listing word in the fixture file.
	pub fn entries(&self, floor: usize) -> Result<Vec<StockDirectoryEntry>, FixtureError> {
		let mut rows = Vec::with_capacity(floor.max(self.entries.len()));
		for row in &self.entries {
			rows.push(StockDirectoryEntry {
				symbol: row.symbol.clone(),
				name: row.name.clone(),
				local_name: row.local_name.clone(),
				listing: listing(&row.listing)?,
			});
		}
		let padding = &self.padding;
		let padded = listing(&padding.listing)?;
		for n in 1..=floor.saturating_sub(self.entries.len()) {
			let fill = |template: &str| template.replace("{n}", &n.to_string());
			rows.push(StockDirectoryEntry {
				symbol: format!(
					"{}{:0width$}",
					padding.symbol_prefix,
					n - 1,
					width = padding.digits
				),
				name: fill(&padding.name),
				local_name: padding.local_name.as_deref().map(fill),
				listing: padded,
			});
		}
		Ok(rows)
	}
}

/// The canned stock lists (ADR-0034).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryFixtures {
	/// The US list (SEC stand-in).
	#[serde(rename = "US")]
	pub us: DirectoryMarket,
	/// The JP list (JPX stand-in).
	#[serde(rename = "JP")]
	pub jp: DirectoryMarket,
}

/// Everything the E2E seams serve.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixtures {
	/// The one URL the feed fetcher answers.
	pub feed_url: String,
	/// The headline of the first feed item.
	pub headline: String,
	/// Hostile markup the scripted agent injects.
	pub hostile_markup: String,
	feed_xml: String,
	/// The sign-in URL the scripted Google connect delivers.
	pub google_auth_url: String,
	/// Canned earnings dates.
	pub earnings: EarningsFixtures,
	/// Canned stock lists.
	pub stock_directory: DirectoryFixtures,
}

/// Repository-relative location of the fixture file.
pub const FIXTURE_FILE: &str = "tests/e2e/fixtures/e2e-fixtures.json";

impl Fixtures {
	/// Reads the fixture file below the repository root.
	///
	/// # Errors
	/// A missing or malformed file.
	pub fn load(repo_root: &Path) -> Result<Self, FixtureError> {
		let path = repo_root.join(FIXTURE_FILE);
		let text =
			std::fs::read_to_string(&path).map_err(|_| FixtureError::Unreadable(path.clone()))?;
		serde_json::from_str(&text).map_err(|_| FixtureError::Malformed(path))
	}

	/// The feed document with the headline filled in.
	#[must_use]
	pub fn feed_xml(&self) -> String {
		self.feed_xml.replace("{{headline}}", &self.headline)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn repo_root() -> PathBuf {
		Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
	}

	#[test]
	fn the_shared_fixture_file_loads_and_fills_the_headline() {
		let fixtures = Fixtures::load(&repo_root()).unwrap();
		assert_eq!(fixtures.feed_url, "https://news.example.org/feed.xml");
		let xml = fixtures.feed_xml();
		assert!(xml.contains(&format!("<title>{}</title>", fixtures.headline)));
		assert!(!xml.contains("{{"));
		assert_eq!(fixtures.earnings.finnhub[0].symbol, "AAPL");
		assert_eq!(
			fixtures.earnings.jpx[0].timing().unwrap(),
			EarningsTiming::Unknown
		);
	}

	#[test]
	fn the_canned_stock_lists_reach_the_floor_with_the_named_rows_first() {
		use research_contracts::stock_directory::limits::MIN_ENTRIES_PER_MARKET;
		let fixtures = Fixtures::load(&repo_root()).unwrap();
		let us = fixtures
			.stock_directory
			.us
			.entries(MIN_ENTRIES_PER_MARKET)
			.unwrap();
		assert_eq!(us.len(), MIN_ENTRIES_PER_MARKET);
		assert_eq!(us[0].symbol, "AAPL");
		assert_eq!(us[3].symbol, "ZA000");
		assert_eq!(us[3].name, "Fixture Company 1");
		assert!(us.iter().all(|entry| entry.local_name.is_none()));
		let jp = fixtures
			.stock_directory
			.jp
			.entries(MIN_ENTRIES_PER_MARKET)
			.unwrap();
		assert_eq!(jp[0].local_name.as_deref(), Some("トヨタ自動車"));
		assert_eq!(jp[3].symbol, "9000");
		assert_eq!(jp[3].local_name.as_deref(), Some("フィクスチャ 1"));
		assert_eq!(jp.last().unwrap().symbol, "9996");
	}

	#[test]
	fn a_missing_file_is_a_named_error() {
		assert!(matches!(
			Fixtures::load(Path::new("/nonexistent")),
			Err(FixtureError::Unreadable(_))
		));
	}
}
