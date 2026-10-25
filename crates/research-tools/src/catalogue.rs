//! The research tool catalogue (port of `packages/adapters/src/tools/index.ts`,
//! ADR-0030). Tools are plain [`Tool`]s: the orchestrator authorizes calls
//! against its own allowlist and budget before any of this code runs
//! (AGT-006), and each tool additionally pins the hosts it may reach when it
//! calls the fetcher.

use std::sync::Arc;

use research_agent_core::tools::Tool;
use research_application::ports::{Clock, FeedParser, Hasher, PageArchive, SafeFetcher};
use research_finance::market_data::{
	UnconfiguredJpMarginBalanceSource, UnconfiguredSharePriceSource,
	UnconfiguredUsShortInterestSource,
};
use research_finance::ports::Sleeper;
use research_finance::sec_13f::Edgar13FSource;
use research_finance::sec_client::{PacedSecClient, SecClient};
use research_finance::sec_financials::EdgarFinancialsSource;

use crate::news::{NewsToolDeps, create_news_tools};
use crate::positions::{PositionToolDeps, create_position_tools};
use crate::search::{SearchToolDeps, Sleep, create_search_tools};
use crate::sec::{SecToolDeps, create_sec_tools};
use crate::web::{WebToolDeps, create_web_tools};

/// What the catalogue is built from.
pub struct ResearchToolDeps {
	/// The SSRF-safe fetcher every network tool uses.
	pub fetcher: Arc<dyn SafeFetcher>,
	/// RSS/Atom parser.
	pub feed_parser: Arc<dyn FeedParser>,
	/// Hashes retrieved evidence text.
	pub hasher: Arc<dyn Hasher>,
	/// Wall clock.
	pub clock: Arc<dyn Clock>,
	/// SEC requires a descriptive User-Agent with contact info; `None` makes
	/// the SEC tools report NOT_CONFIGURED.
	pub sec_user_agent: Option<String>,
	/// The owner's Tavily key; `None` → `web.search` is not registered (`news.search` still is).
	pub tavily_api_key: Option<String>,
	/// Where retrieved public pages are archived. `None` → the web tool is not
	/// registered at all: without an archive there is nowhere to keep the page
	/// (DATA-010), so the tool must not run.
	pub page_archive: Option<Arc<dyn PageArchive>>,
	/// Wait that ends early when the run is aborted (politeness between page requests).
	pub sleep: Arc<dyn Sleep>,
	/// The same wait for the SEC fair-access queue.
	pub sec_sleep: Arc<dyn Sleeper>,
}

/// The tools in catalogue order; the conditional web tool is last.
#[must_use]
pub fn create_research_tools(deps: ResearchToolDeps) -> Vec<Arc<dyn Tool>> {
	// One client for both SEC tools, so they share a single request-rate budget.
	let sec_client: Arc<dyn SecClient> = Arc::new(PacedSecClient::new(
		Arc::clone(&deps.fetcher),
		Arc::clone(&deps.clock),
		Arc::clone(&deps.sec_sleep),
		deps.sec_user_agent.clone(),
	));
	let mut tools = create_news_tools(NewsToolDeps {
		fetcher: Arc::clone(&deps.fetcher),
		feed_parser: Arc::clone(&deps.feed_parser),
		hasher: Arc::clone(&deps.hasher),
		clock: Arc::clone(&deps.clock),
	});
	// The search tools write nothing to disk: unlike the page tool they do
	// not need the archive; web.search needs a Tavily key (ADR-0025).
	tools.extend(create_search_tools(SearchToolDeps {
		fetcher: Arc::clone(&deps.fetcher),
		hasher: Arc::clone(&deps.hasher),
		clock: Arc::clone(&deps.clock),
		sleep: Arc::clone(&deps.sleep),
		tavily_api_key: deps.tavily_api_key.clone(),
	}));
	tools.extend(create_sec_tools(SecToolDeps {
		financials: Arc::new(EdgarFinancialsSource::new(
			Arc::clone(&sec_client),
			Arc::clone(&deps.clock),
		)),
		filings: Arc::new(Edgar13FSource { client: sec_client }),
		// No licensed market-data source exists in V1; these report "unavailable" with a reason.
		share_price: Arc::new(UnconfiguredSharePriceSource),
		hasher: Arc::clone(&deps.hasher),
	}));
	tools.extend(create_position_tools(PositionToolDeps {
		us_short_interest: Arc::new(UnconfiguredUsShortInterestSource),
		jp_margin_balance: Arc::new(UnconfiguredJpMarginBalanceSource),
		hasher: Arc::clone(&deps.hasher),
	}));
	if let Some(page_archive) = deps.page_archive {
		tools.extend(create_web_tools(WebToolDeps {
			fetcher: deps.fetcher,
			hasher: deps.hasher,
			clock: deps.clock,
			page_archive,
			sleep: deps.sleep,
		}));
	}
	tools
}

#[cfg(test)]
mod tests {
	use super::*;
	use async_trait::async_trait;
	use research_agent_core::tools::{ToolCostCategory, ToolNetworkAllowlist, ToolSideEffect};
	use research_application::ports::{
		ArchiveWriteFailed, ArchivedPage, FetchedDocument, NotAFeed, SafeFetchError,
		SafeFetchOptions,
	};
	use research_domain::news::raw_feed::RawFeed;
	use tokio_util::sync::CancellationToken;

	struct Never;
	#[async_trait]
	impl SafeFetcher for Never {
		async fn fetch_text(
			&self,
			_: &str,
			_: &SafeFetchOptions,
		) -> Result<FetchedDocument, SafeFetchError> {
			panic!("the catalogue itself never fetches");
		}
	}
	impl FeedParser for Never {
		fn parse(&self, _: &str) -> Result<RawFeed, NotAFeed> {
			Err(NotAFeed)
		}
	}
	impl Hasher for Never {
		fn sha256_hex(&self, _: &str) -> String {
			"0".repeat(64)
		}
	}
	impl Clock for Never {
		fn now_ms(&self) -> i64 {
			0
		}
		fn now_iso(&self) -> String {
			"1970-01-01T00:00:00.000Z".to_owned()
		}
	}
	#[async_trait]
	impl Sleep for Never {
		async fn sleep(&self, _: u64, _: &CancellationToken) {}
	}
	#[async_trait]
	impl Sleeper for Never {
		async fn sleep(&self, _: u64, _: Option<&CancellationToken>) {}
	}
	#[async_trait]
	impl PageArchive for Never {
		async fn save(&self, _: &ArchivedPage) -> Result<String, ArchiveWriteFailed> {
			Ok("archived.md".to_owned())
		}
	}

	fn tools(with_archive: bool) -> Vec<Arc<dyn Tool>> {
		tools_with_key(with_archive, None)
	}

	fn tools_with_key(with_archive: bool, tavily_api_key: Option<&str>) -> Vec<Arc<dyn Tool>> {
		let never = Arc::new(Never);
		create_research_tools(ResearchToolDeps {
			fetcher: never.clone(),
			feed_parser: never.clone(),
			hasher: never.clone(),
			clock: never.clone(),
			sec_user_agent: None,
			tavily_api_key: tavily_api_key.map(str::to_owned),
			page_archive: with_archive.then(|| never.clone() as Arc<dyn PageArchive>),
			sleep: never.clone(),
			sec_sleep: never,
		})
	}

	fn ids(tools: &[Arc<dyn Tool>]) -> Vec<&'static str> {
		tools.iter().map(|tool| tool.meta().tool_id).collect()
	}

	#[test]
	fn registers_the_expected_tools_in_order_with_complete_policy_metadata() {
		let tools = tools(false);
		assert_eq!(
			ids(&tools),
			[
				"news.fetch_feed",
				"news.fetch_article",
				"news.search",
				"finance.sec_company_financials",
				"filings.sec_13f_holdings",
				"positions.us_short_interest",
				"positions.jp_margin_balance",
			]
		);
		for tool in &tools {
			let meta = tool.meta();
			assert!(meta.permission == "research-read");
			assert!(
				meta.timeout_ms > 0 && meta.timeout_ms <= 120_000,
				"{}",
				meta.tool_id
			);
			assert!(meta.description.chars().count() > 20);
			assert!(meta.args_hint.starts_with('{'));
			let parts: Vec<&str> = meta.version.split('.').collect();
			assert!(parts.len() == 3 && parts.iter().all(|p| p.parse::<u64>().is_ok()));
		}
	}

	#[test]
	fn declares_a_network_allowlist_that_matches_what_each_tool_may_reach() {
		let tools = tools(false);
		let meta = |id: &str| {
			tools
				.iter()
				.find(|t| t.meta().tool_id == id)
				.unwrap()
				.meta()
		};
		assert_eq!(
			meta("news.fetch_feed").network_allowlist,
			ToolNetworkAllowlist::SubscribedSources
		);
		for id in ["finance.sec_company_financials", "filings.sec_13f_holdings"] {
			assert_eq!(
				meta(id).network_allowlist,
				ToolNetworkAllowlist::Hosts(
					["www.sec.gov", "data.sec.gov"]
						.map(str::to_owned)
						.into_iter()
						.collect()
				)
			);
			assert_eq!(meta(id).side_effect, ToolSideEffect::ExternalRead);
			assert_eq!(meta(id).cost_category, ToolCostCategory::RateLimited);
		}
		for id in ["positions.us_short_interest", "positions.jp_margin_balance"] {
			assert_eq!(meta(id).network_allowlist, ToolNetworkAllowlist::None);
			assert_eq!(meta(id).side_effect, ToolSideEffect::None);
		}
		// The news search writes nothing to disk, so it is registered either way (ADR-0025).
		assert_eq!(
			meta("news.search").network_allowlist,
			ToolNetworkAllowlist::PublicWeb
		);
		// Without a Tavily key there is no web search.
		assert!(!ids(&tools).contains(&"web.search"));
		// Without an archive there is nowhere to keep a retrieved page (DATA-010).
		assert!(!ids(&tools).contains(&"web.fetch_page"));
	}

	#[test]
	fn registers_web_search_before_news_search_only_with_a_tavily_key() {
		let tools = tools_with_key(false, Some("tvly-test-key"));
		let ids = ids(&tools);
		assert_eq!(ids.get(2..4), Some(&["web.search", "news.search"][..]));
		let meta = tools
			.iter()
			.find(|t| t.meta().tool_id == "web.search")
			.unwrap()
			.meta();
		assert_eq!(meta.version, "2.0.0");
		assert_eq!(meta.network_allowlist, ToolNetworkAllowlist::PublicWeb);
		assert_eq!(meta.cost_category, ToolCostCategory::Metered);
		assert_eq!(meta.side_effect, ToolSideEffect::ExternalRead);
	}

	#[test]
	fn registers_web_fetch_page_only_when_a_page_archive_is_configured() {
		let tools = tools(true);
		assert_eq!(tools.len(), 8);
		assert_eq!(tools.last().unwrap().meta().tool_id, "web.fetch_page");
		let meta = tools.last().unwrap().meta();
		assert_eq!(meta.version, "1.0.0");
		assert_eq!(meta.timeout_ms, 40_000);
		assert_eq!(meta.cost_category, ToolCostCategory::RateLimited);
		assert_eq!(meta.side_effect, ToolSideEffect::ExternalReadArchiveWrite);
		assert_eq!(meta.network_allowlist, ToolNetworkAllowlist::PublicWeb);
		assert!(meta.description.contains("cannot search"));
	}
}
