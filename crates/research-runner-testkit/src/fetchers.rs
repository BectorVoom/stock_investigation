//! Fixture transports (port of `tests/e2e/fixtures.ts` `fixtureFetcher` and
//! `tests/e2e/marketFixtures.ts`): nothing here touches the network.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use research_application::ports::{
	FetchedDocument, SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use url::Url;

use crate::fixtures::Fixtures;

fn not_a_fixture(detail: &str) -> SafeFetchError {
	SafeFetchError {
		code: SafeFetchErrorCode::NetworkError,
		detail: detail.to_owned(),
		body: None,
	}
}

/// Serves only the one synthetic feed URL.
pub struct FeedFixtureFetcher {
	url: String,
	xml: String,
}

impl FeedFixtureFetcher {
	/// A fetcher for the feed of `fixtures`.
	#[must_use]
	pub fn new(fixtures: &Fixtures) -> Self {
		Self {
			url: fixtures.feed_url.clone(),
			xml: fixtures.feed_xml(),
		}
	}
}

#[async_trait]
impl SafeFetcher for FeedFixtureFetcher {
	async fn fetch_text(
		&self,
		url: &str,
		_options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		if url != self.url {
			return Err(not_a_fixture("not an E2E fixture URL"));
		}
		Ok(FetchedDocument {
			final_url: self.url.clone(),
			content_type: Some("application/rss+xml".to_owned()),
			text: self.xml.clone(),
		})
	}
}

/// Why a market fixture file could not be loaded.
#[derive(Debug, thiserror::Error)]
#[error("market fixture {0} could not be read")]
pub struct MarketFixtureError(pub PathBuf);

/// Recorded provider responses served to the REAL FRED and Twelve Data
/// adapters. Series without a recorded response fail as the providers' own
/// not-found shapes, so the browser only ever shows numbers from real
/// recorded responses.
pub struct MarketFixtureFetcher {
	fred_meta: HashMap<&'static str, String>,
	fred_observations: HashMap<&'static str, String>,
	fred_not_found: String,
	twelve: HashMap<&'static str, String>,
	twelve_not_found: String,
	failure_file: PathBuf,
}

/// The API key the adapters are configured with; Twelve Data must receive it
/// in the `Authorization` header (never in the URL).
pub const FIXTURE_API_KEY: &str = "e2e-fixture";

/// Repository-relative directory of the recorded provider responses.
const RECORDED_DIR: &str = "packages/adapters/test/finance/fixtures";

impl MarketFixtureFetcher {
	/// Loads the recorded responses below the repository root.
	///
	/// # Errors
	/// A recorded response that cannot be read.
	pub fn load(repo_root: &Path) -> Result<Self, MarketFixtureError> {
		let directory = repo_root.join(RECORDED_DIR);
		let read = |name: &str| {
			let path = directory.join(name);
			std::fs::read_to_string(&path).map_err(|_| MarketFixtureError(path))
		};
		Ok(Self {
			fred_meta: HashMap::from([("VIXCLS", read("fred-series-VIXCLS.json")?)]),
			fred_observations: HashMap::from([("VIXCLS", read("fred-observations-VIXCLS.json")?)]),
			fred_not_found: read("fred-series-notfound.json")?,
			twelve: HashMap::from([
				("XAU/USD", read("twelvedata-key-symbol_XAU_USD.json")?),
				("AAPL", read("twelvedata-timeseries-AAPL.json")?),
				("MSFT", read("twelvedata-key-symbol_MSFT.json")?),
				("USD/JPY", read("twelvedata-key-symbol_USD_JPY.json")?),
				("EUR/USD", read("twelvedata-timeseries-EURUSD.json")?),
			]),
			twelve_not_found: read("twelvedata-key-symbol_7203_exchange_JPX.json")?,
			failure_file: repo_root.join("test-results/e2e-market-fail.json"),
		})
	}

	/// Failure injection for the scripted UI review's stale-data state: the
	/// file `{ "seriesIds": [...] }` lists series that fail as if the provider
	/// had no data. Read per request so the review can toggle failures between
	/// two refreshes; absent, unreadable or malformed means no failures.
	fn failing_series(&self) -> Vec<String> {
		let Ok(text) = std::fs::read_to_string(&self.failure_file) else {
			return Vec::new();
		};
		let Ok(serde_json::Value::Object(root)) = serde_json::from_str::<serde_json::Value>(&text)
		else {
			return Vec::new();
		};
		match root.get("seriesIds") {
			Some(serde_json::Value::Array(ids)) => ids
				.iter()
				.filter_map(|id| id.as_str().map(str::to_owned))
				.collect(),
			_ => Vec::new(),
		}
	}
}

fn http_error(status: u16, body: &str) -> SafeFetchError {
	SafeFetchError {
		code: SafeFetchErrorCode::HttpError,
		detail: format!("HTTP {status} from the fixture provider"),
		body: Some(body.to_owned()),
	}
}

fn document(url: &str, text: &str) -> FetchedDocument {
	FetchedDocument {
		final_url: url.to_owned(),
		content_type: Some("application/json".to_owned()),
		text: text.to_owned(),
	}
}

fn query_value(url: &Url, name: &str) -> String {
	url.query_pairs()
		.find(|(key, _)| key == name)
		.map(|(_, value)| value.into_owned())
		.unwrap_or_default()
}

#[async_trait]
impl SafeFetcher for MarketFixtureFetcher {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		let unknown = || not_a_fixture("not a fixture market URL");
		let parsed = Url::parse(url).map_err(|_| unknown())?;
		match parsed.host_str() {
			Some("api.stlouisfed.org") => {
				let symbol = query_value(&parsed, "series_id");
				let recorded = match parsed.path() {
					"/fred/series" => &self.fred_meta,
					"/fred/series/observations" => &self.fred_observations,
					_ => return Err(unknown()),
				};
				if self.failing_series().contains(&format!("fred:{symbol}")) {
					return Err(http_error(400, &self.fred_not_found));
				}
				match recorded.get(symbol.as_str()) {
					Some(text) => Ok(document(url, text)),
					None => Err(http_error(400, &self.fred_not_found)),
				}
			}
			Some("api.twelvedata.com") => {
				if options.authorization.as_deref() != Some("apikey e2e-fixture") {
					return Err(not_a_fixture("missing fixture API key header"));
				}
				if parsed.path() != "/time_series" {
					return Err(unknown());
				}
				let symbol = query_value(&parsed, "symbol");
				let exchange = query_value(&parsed, "exchange");
				let series_id = if exchange.is_empty() {
					symbol
				} else {
					format!("{symbol}:{exchange}")
				};
				if self
					.failing_series()
					.contains(&format!("twelve-data:{series_id}"))
				{
					return Err(http_error(404, &self.twelve_not_found));
				}
				match self.twelve.get(series_id.as_str()) {
					Some(text) => Ok(document(url, text)),
					None => Err(http_error(404, &self.twelve_not_found)),
				}
			}
			_ => Err(unknown()),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn options(authorization: Option<&str>) -> SafeFetchOptions {
		SafeFetchOptions {
			max_bytes: 1 << 20,
			timeout_ms: 1000,
			accept: "application/json".to_owned(),
			cancel: None,
			allowed_hosts: None,
			authorize_redirect: None,
			user_agent: None,
			authorization: authorization.map(str::to_owned),
			finnhub_token: None,
			include_error_body: true,
		}
	}

	fn fetcher() -> MarketFixtureFetcher {
		MarketFixtureFetcher::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap()
	}

	#[tokio::test]
	async fn recorded_series_are_served_and_unknown_ones_fail_like_the_provider() {
		let fetcher = fetcher();
		let known = "https://api.stlouisfed.org/fred/series?series_id=VIXCLS&api_key=k";
		let document = fetcher.fetch_text(known, &options(None)).await.unwrap();
		assert_eq!(document.final_url, known);
		let unknown = "https://api.stlouisfed.org/fred/series?series_id=NOPE";
		let error = fetcher
			.fetch_text(unknown, &options(None))
			.await
			.unwrap_err();
		assert_eq!(error.code, SafeFetchErrorCode::HttpError);
		assert!(error.body.is_some());
	}

	#[tokio::test]
	async fn twelve_data_requires_the_key_in_the_authorization_header() {
		let fetcher = fetcher();
		let url = "https://api.twelvedata.com/time_series?symbol=AAPL&interval=1day";
		let refused = fetcher.fetch_text(url, &options(None)).await.unwrap_err();
		assert_eq!(refused.code, SafeFetchErrorCode::NetworkError);
		let served = fetcher
			.fetch_text(url, &options(Some("apikey e2e-fixture")))
			.await;
		assert!(served.is_ok());
	}

	#[tokio::test]
	async fn the_feed_fetcher_serves_only_its_url() {
		let fixtures =
			Fixtures::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
		let feed = FeedFixtureFetcher::new(&fixtures);
		let served = feed
			.fetch_text(&fixtures.feed_url, &options(None))
			.await
			.unwrap();
		assert!(served.text.contains(&fixtures.headline));
		assert!(
			feed.fetch_text("https://other.test/", &options(None))
				.await
				.is_err()
		);
	}
}
