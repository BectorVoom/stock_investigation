//! The shared fixture file `tests/e2e/fixtures/e2e-fixtures.json`: read by the
//! TypeScript specs, the E2E Worker and this crate, so none can disagree about
//! the feed, the headline or the earnings dates.

use std::path::{Path, PathBuf};

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
	fn a_missing_file_is_a_named_error() {
		assert!(matches!(
			Fixtures::load(Path::new("/nonexistent")),
			Err(FixtureError::Unreadable(_))
		));
	}
}
