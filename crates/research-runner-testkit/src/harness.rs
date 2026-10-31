//! The composition root of `research-runner-e2e`: the same job shell, poll
//! loop, tools and adapters as `research_runner::composition::compose`, with
//! the seams of `tests/e2e/runnerHarness.ts` swapped in.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use research_agent_core::authorize::{DuplicateToolId, ToolRegistry};
use research_agent_core::registry::{AgentRegistry, DuplicateAgentId};
use research_application::ingest::IngestDeps;
use research_application::ports::{Clock, Hasher, SafeFetcher};
use research_contracts::market::MarketProviderId;
use research_contracts::watchlist::{EarningsSourceId, WatchMarket};
use research_effects::{EventLogger, JsonEventLogger, LogValue, StderrSink};
use research_feed::FastXmlFeedParser;
use research_finance::fred::FredSeriesSource;
use research_finance::pacing::{MarketPacer, WindowMarketPacer};
use research_finance::ports::{
	EarningsCalendarSource, MarketSeriesSource, Secret, Sleeper, StockDirectorySource, TokioSleeper,
};
use research_finance::twelve_data::TwelveDataSeriesSource;
use research_providers::environment::ProviderEnvironment;
use research_providers::external::ExternalConfigError;
use research_providers::http::PinnedProviderHttpClient;
use research_providers::process::{ProcessRunner, UnixProcessRunner};
use research_providers::{create_agent_runtimes, create_baseline_agent_runtimes};
use research_runner::api_client::{HttpRunnerApi, HttpRunnerApiOptions};
use research_runner::google_sync::GoogleCalendarPort;
use research_runner::job_execution::JobDeps;
use research_runner::runner_loop::{LoopDeps, RunnerExit, run_runner_loop};
use research_runner::runtime::{Sha256Hasher, SystemClock, new_fence_token};
use research_runner::scratch::{ScratchDirectories, TempScratch};
use research_tools::catalogue::{ResearchToolDeps, create_research_tools};
use tokio_util::sync::CancellationToken;

use crate::agents::{NoScratch, write_registration};
use crate::directory::FixtureStockDirectorySource;
use crate::earnings::FixtureEarningsSource;
use crate::equity_sync::fixture_equity_sync_sources;
use crate::fetchers::{FIXTURE_API_KEY, FeedFixtureFetcher, MarketFixtureFetcher};
use crate::fixtures::Fixtures;
use crate::google::ScriptedGoogle;
use crate::owner_proxy;
use crate::sleep::CappedSleep;

/// Why the harness could not start. Every variant is a start-up fault.
#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
	/// A required environment variable is missing or empty.
	#[error("{0} is not set")]
	MissingSetting(&'static str),
	/// The repository root is not an absolute path.
	#[error("E2E_REPO_ROOT must be an absolute path")]
	RepoRoot,
	/// The shared fixtures could not be loaded.
	#[error(transparent)]
	Fixtures(#[from] crate::fixtures::FixtureError),
	/// The recorded market responses could not be loaded.
	#[error(transparent)]
	Market(#[from] crate::fetchers::MarketFixtureError),
	/// The owner proxy could not start.
	#[error(transparent)]
	Proxy(#[from] owner_proxy::ProxyError),
	/// The agent registration could not be written or loaded.
	#[error("the scripted agent could not be registered")]
	Registration(#[from] ExternalConfigError),
	/// A scratch or registration file operation failed.
	#[error("a harness file operation failed")]
	Io(#[from] std::io::Error),
	/// The `research-provider-spawn` companion is missing beside this executable.
	#[error("the research-provider-spawn companion is missing beside the executable")]
	SpawnHelper,
	/// rustls could not be configured.
	#[error("TLS configuration failed")]
	Tls,
	/// Two agent backends share an id.
	#[error(transparent)]
	DuplicateAgent(#[from] DuplicateAgentId),
	/// Two tools share an id.
	#[error(transparent)]
	DuplicateTool(#[from] DuplicateToolId),
	/// The API client could not be built.
	#[error("the Worker API client could not be built")]
	Api,
}

/// The harness settings, read from the environment the TypeScript wrapper
/// (`tests/e2e/rustRunnerHarness.ts`) spawns this binary with.
#[derive(Clone, Debug)]
pub struct HarnessSettings {
	/// `RESEARCH_API_URL`: the E2E Worker origin.
	pub api_url: String,
	/// `RUNNER_TOKEN`: the credential the wrapper issued.
	pub runner_token: String,
	/// `E2E_REPO_ROOT`: where fixtures and flag files resolve from.
	pub repo_root: PathBuf,
	/// `E2E_RUNNER_OWNER`: a second owner's runner, when set.
	pub owner: Option<String>,
	/// `RUN_LIVE_OPENCODE=1`: real baseline runtimes instead of the scripted agent.
	pub live: bool,
	/// The whole environment, for the live backends (`OPENCODE_MODEL`, `PATH`, ...).
	pub env: BTreeMap<String, String>,
}

impl HarnessSettings {
	/// Reads and validates the settings.
	///
	/// # Errors
	/// A missing token, API URL or repository root.
	pub fn from_env(env: BTreeMap<String, String>) -> Result<Self, HarnessError> {
		let required = |name: &'static str| {
			env.get(name)
				.filter(|value| !value.is_empty())
				.cloned()
				.ok_or(HarnessError::MissingSetting(name))
		};
		let repo_root = PathBuf::from(required("E2E_REPO_ROOT")?);
		if !repo_root.is_absolute() {
			return Err(HarnessError::RepoRoot);
		}
		Ok(Self {
			api_url: required("RESEARCH_API_URL")?,
			runner_token: required("RUNNER_TOKEN")?,
			repo_root,
			owner: env
				.get("E2E_RUNNER_OWNER")
				.filter(|value| !value.is_empty())
				.cloned(),
			live: env.get("RUN_LIVE_OPENCODE").map(String::as_str) == Some("1"),
			env,
		})
	}
}

/// Builds the loop dependencies with the E2E seams.
///
/// # Errors
/// A start-up fault: fixtures, proxy, registration, TLS or registration clashes.
pub async fn compose(
	settings: &HarnessSettings,
	logger: &Arc<dyn EventLogger>,
) -> Result<LoopDeps, HarnessError> {
	let fixtures = Fixtures::load(&settings.repo_root)?;
	let clock: Arc<dyn Clock> = Arc::new(SystemClock);
	let hasher: Arc<dyn Hasher> = Arc::new(Sha256Hasher);
	let capped = Arc::new(CappedSleep);
	let sleeper: Arc<dyn Sleeper> = capped.clone();

	let feed_fetcher: Arc<dyn SafeFetcher> = Arc::new(FeedFixtureFetcher::new(&fixtures));
	let feed_parser = Arc::new(FastXmlFeedParser);
	let tools = ToolRegistry::new(create_research_tools(ResearchToolDeps {
		fetcher: Arc::clone(&feed_fetcher),
		feed_parser: feed_parser.clone(),
		hasher: Arc::clone(&hasher),
		clock: Arc::clone(&clock),
		sec_user_agent: None,
		tavily_api_key: None,
		page_archive: None,
		sleep: capped,
		sec_sleep: Arc::clone(&sleeper),
	}))?;

	let (agents, scratch) = agents(settings)?;

	// Market data: the real FRED and Twelve Data adapters served from real
	// recorded provider responses (no keys, no network). Series without a
	// recorded response fail as the providers' not-found shapes.
	let market_fetcher: Arc<dyn SafeFetcher> =
		Arc::new(MarketFixtureFetcher::load(&settings.repo_root)?);
	let market_sources: HashMap<String, Arc<dyn MarketSeriesSource>> = HashMap::from([
		(
			MarketProviderId::Fred.as_str().to_owned(),
			Arc::new(FredSeriesSource::new(
				Secret::new(FIXTURE_API_KEY),
				Arc::clone(&market_fetcher),
				Arc::clone(&clock),
			)) as Arc<dyn MarketSeriesSource>,
		),
		(
			MarketProviderId::TwelveData.as_str().to_owned(),
			Arc::new(TwelveDataSeriesSource::new(
				Secret::new(FIXTURE_API_KEY),
				market_fetcher,
			)),
		),
	]);
	let earnings_sources: HashMap<String, Arc<dyn EarningsCalendarSource>> = HashMap::from([
		(
			EarningsSourceId::Finnhub.as_str().to_owned(),
			Arc::new(FixtureEarningsSource::finnhub(
				fixtures.earnings.finnhub.clone(),
			)) as Arc<dyn EarningsCalendarSource>,
		),
		(
			EarningsSourceId::Jpx.as_str().to_owned(),
			Arc::new(FixtureEarningsSource::jpx(fixtures.earnings.jpx.clone())),
		),
	]);
	// Stock lists (ADR-0034): the canned US and JP lists of the shared
	// fixture file, padded to the contract's floor: no SEC, no JPX.
	let stock_directory_sources: HashMap<WatchMarket, Arc<dyn StockDirectorySource>> =
		HashMap::from([
			(
				WatchMarket::Us,
				Arc::new(FixtureStockDirectorySource::new(
					WatchMarket::Us,
					&fixtures.stock_directory.us,
				)?) as Arc<dyn StockDirectorySource>,
			),
			(
				WatchMarket::Jp,
				Arc::new(FixtureStockDirectorySource::new(
					WatchMarket::Jp,
					&fixtures.stock_directory.jp,
				)?),
			),
		]);
	// Financial statements (ADR-0045): the canned SEC and EDINET completions,
	// the same files the TypeScript E2E runner serves: no keys, no network.
	let equity_sync_sources = fixture_equity_sync_sources(&settings.repo_root)?;
	// No limits in E2E: the fixture loop never paces.
	let pacer: Arc<dyn MarketPacer> = Arc::new(WindowMarketPacer::new(
		Arc::clone(&clock),
		Arc::clone(&sleeper),
		HashMap::new(),
		HashMap::new(),
	));
	let google: Arc<dyn GoogleCalendarPort> = Arc::new(ScriptedGoogle {
		unconfigured_flag: settings
			.repo_root
			.join("test-results/e2e-google-unconfigured"),
		auth_url: fixtures.google_auth_url.clone(),
		logger: Arc::clone(logger),
		sleeper: Arc::clone(&sleeper),
	});

	// A second owner's runner reaches the Worker through the header-adding proxy.
	let api_url = match &settings.owner {
		Some(owner) => owner_proxy::start(&settings.api_url, owner).await?,
		None => settings.api_url.clone(),
	};
	let api = Arc::new(
		HttpRunnerApi::new(
			HttpRunnerApiOptions::new(api_url, settings.runner_token.clone(), None, None),
			Arc::new(TokioSleeper),
		)
		.map_err(|_| HarnessError::Api)?,
	);
	Ok(LoopDeps {
		jobs: Arc::new(JobDeps {
			api,
			agents,
			tools,
			ingest: IngestDeps {
				fetcher: feed_fetcher,
				feed_parser,
				hasher,
				clock: Arc::clone(&clock),
			},
			clock,
			logger: Arc::clone(logger),
			scratch,
			new_fence_token: Arc::new(new_fence_token),
			allow_unverified_tool_isolation: false,
			market_sources,
			earnings_sources,
			stock_directory_sources,
			equity_sync_sources,
			pacer,
			google,
		}),
		// Poll quickly so the browser test does not wait on the production idle interval.
		sleeper,
	})
}

/// The agent registry and scratch directories: the scripted agent through the
/// FR-013 protocol, or (live switch) the real baseline runtimes with real
/// scratch directories, because the OpenCode adapter writes its deny-all
/// config there (AGT-004). The registry is chosen here; the core is not forked.
fn agents(
	settings: &HarnessSettings,
) -> Result<(Arc<AgentRegistry>, Arc<dyn ScratchDirectories>), HarnessError> {
	let process_runner: Arc<dyn ProcessRunner> =
		Arc::new(UnixProcessRunner::new().map_err(|_| HarnessError::SpawnHelper)?);
	let http = Arc::new(PinnedProviderHttpClient::new().map_err(|_| HarnessError::Tls)?);
	if settings.live {
		let runtimes = create_baseline_agent_runtimes(ProviderEnvironment {
			process_runner,
			http,
			env: settings.env.clone(),
		});
		let root = tempfile::Builder::new()
			.prefix("research-e2e-live-")
			.tempdir()?
			.keep();
		return Ok((
			Arc::new(AgentRegistry::new(runtimes)?),
			Arc::new(TempScratch::new(root)),
		));
	}
	// The registration file outlives the process only as long as the temp
	// directory: leaked deliberately, it is tiny and the OS temp dir reaps it.
	let directory = tempfile::Builder::new()
		.prefix("research-e2e-agents-")
		.tempdir()?
		.keep();
	let registration = write_registration(&settings.repo_root, &directory)?;
	let mut env = settings.env.clone();
	env.insert("RESEARCH_AGENT_SET".to_owned(), "external-only".to_owned());
	env.insert(
		"RESEARCH_EXTERNAL_AGENTS".to_owned(),
		registration.to_string_lossy().into_owned(),
	);
	let runtimes = create_agent_runtimes(ProviderEnvironment {
		process_runner,
		http,
		env,
	})?;
	Ok((Arc::new(AgentRegistry::new(runtimes)?), Arc::new(NoScratch)))
}

/// SIGINT / SIGTERM cancel `shutdown` (the TypeScript harness aborts its
/// controller on either).
fn watch_signals(shutdown: CancellationToken) -> std::io::Result<()> {
	use tokio::signal::unix::{SignalKind, signal};
	let mut interrupt = signal(SignalKind::interrupt())?;
	let mut terminate = signal(SignalKind::terminate())?;
	tokio::spawn(async move {
		tokio::select! {
			_ = interrupt.recv() => {},
			_ = terminate.recv() => {},
		}
		shutdown.cancel();
	});
	Ok(())
}

/// Runs the E2E runner until shutdown or a rejected credential; returns the
/// process exit code (0 on shutdown, 1 otherwise).
///
/// # Errors
/// A start-up fault (see [`HarnessError`]).
pub async fn run(env: BTreeMap<String, String>) -> Result<u8, HarnessError> {
	let logger: Arc<dyn EventLogger> = Arc::new(JsonEventLogger::new(
		StderrSink,
		research_effects::SystemClock,
	));
	let settings = HarnessSettings::from_env(env)?;
	let shutdown = CancellationToken::new();
	watch_signals(shutdown.clone())?;
	let deps = compose(&settings, &logger).await?;
	logger.info(
		"e2e_runner_started",
		&[
			("live", LogValue::Bool(settings.live)),
			("owner", LogValue::Bool(settings.owner.is_some())),
		],
	);
	let exit = run_runner_loop(&deps, &shutdown).await;
	Ok(match exit {
		RunnerExit::Shutdown => 0,
		RunnerExit::Unauthenticated => 1,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
		pairs
			.iter()
			.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
			.collect()
	}

	#[test]
	fn settings_need_the_token_url_and_an_absolute_root() {
		let base = [
			("RESEARCH_API_URL", "http://localhost:8799"),
			("RUNNER_TOKEN", "t"),
			("E2E_REPO_ROOT", "/repo"),
		];
		let settings = HarnessSettings::from_env(env(&base)).unwrap();
		assert!(settings.owner.is_none() && !settings.live);
		assert!(matches!(
			HarnessSettings::from_env(env(&base[..2])),
			Err(HarnessError::MissingSetting("E2E_REPO_ROOT"))
		));
		assert!(matches!(
			HarnessSettings::from_env(env(&[
				("RESEARCH_API_URL", "u"),
				("RUNNER_TOKEN", "t"),
				("E2E_REPO_ROOT", "relative")
			])),
			Err(HarnessError::RepoRoot)
		));
	}

	#[test]
	fn the_owner_and_live_switches_are_read() {
		let settings = HarnessSettings::from_env(env(&[
			("RESEARCH_API_URL", "u"),
			("RUNNER_TOKEN", "t"),
			("E2E_REPO_ROOT", "/repo"),
			("E2E_RUNNER_OWNER", "second@example.test"),
			("RUN_LIVE_OPENCODE", "1"),
		]))
		.unwrap();
		assert_eq!(settings.owner.as_deref(), Some("second@example.test"));
		assert!(settings.live);
	}
}
