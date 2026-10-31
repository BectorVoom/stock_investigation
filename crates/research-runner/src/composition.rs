//! The composition root (port of the adapter wiring in `apps/runner/src/main.ts`):
//! the only place where adapters are chosen. Everything below is plain
//! construction; behaviour lives in the crates it composes.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use research_agent_core::authorize::{DuplicateToolId, ToolRegistry};
use research_agent_core::registry::{AgentRegistry, DuplicateAgentId};
use research_application::ingest::IngestDeps;
use research_application::ports::{Clock, Hasher, PageArchive, SafeBinaryFetcher, SafeFetcher};
use research_contracts::market::{
	MarketProviderId, MarketUnavailableCode, market_unavailable_reason,
};
use research_contracts::watchlist::{EarningsSourceId, WatchMarket};
use research_effects::{EventLogger, LogValue};
use research_feed::FastXmlFeedParser;
use research_finance::finnhub::FinnhubEarningsSource;
use research_finance::fred::FredSeriesSource;
use research_finance::jpx::JpxEarningsSource;
use research_finance::jpx_directory::JpxDirectorySource;
use research_finance::pacing::{MarketPacer, WindowMarketPacer};
use research_finance::ports::{
	DroppedRowsHook, EarningsCalendarSource, MarketSeriesSource, Secret, Sleeper,
	StockDirectorySource, TokioSleeper, UnconfiguredEarningsCalendarSource,
	UnconfiguredMarketSeriesSource, UnconfiguredStockDirectorySource,
};
use research_finance::sec_client::{PacedSecClient, is_usable_sec_user_agent};
use research_finance::sec_directory::SecDirectorySource;
use research_finance::twelve_data::TwelveDataSeriesSource;
use research_google::http::PinnedGoogleHttp;
use research_google::oauth::OAuthClient;
use research_net::{FilePageArchive, create_node_safe_fetcher};
use research_providers::create_agent_runtimes;
use research_providers::environment::ProviderEnvironment;
use research_providers::external::ExternalConfigError;
use research_providers::http::PinnedProviderHttpClient;
use research_providers::process::{
	HELPER_NAME, HelperMissing, ProcessHandle, ProcessRunner, ProcessSpec, UnixProcessRunner,
};
use research_tools::catalogue::{ResearchToolDeps, create_research_tools};
use research_tools::search::TokioSleep;

use crate::api_client::{HttpRunnerApi, RunnerApi};
use crate::config::{Env, RunnerConfig};
use crate::google_sync::{GoogleCalendarPort, GoogleSync};
use crate::job_execution::JobDeps;
use crate::runner_loop::LoopDeps;
use crate::runtime::{Sha256Hasher, SystemClock, new_fence_token};
use crate::scratch::{ScratchDirectories, TempScratch};

/// Why the adapters could not be composed. Every variant is a start-up fault
/// (`runner_crashed`), never a job failure.
#[derive(Debug, thiserror::Error)]
pub enum CompositionError {
	/// rustls could not be configured.
	#[error("TLS configuration failed")]
	Tls,
	/// The agent backends could not be registered (a bad `RESEARCH_AGENT_SET`
	/// or external-agent registration file).
	#[error("agent backends could not be composed")]
	Agents(#[from] ExternalConfigError),
	/// Two backends share an id.
	#[error("duplicate agent id")]
	DuplicateAgent(#[from] DuplicateAgentId),
	/// Two tools share an id.
	#[error("duplicate tool id")]
	DuplicateTool(#[from] DuplicateToolId),
}

/// Runs nothing: every spawn reports the companion executable as missing, so
/// a packaging mistake shows up as `PROBE_FAILED` for the CLI backends (and
/// never as "CLI not installed") while the runner still serves HTTP backends,
/// news ingest and market refreshes.
struct MissingHelperRunner {
	helper: PathBuf,
}

impl ProcessRunner for MissingHelperRunner {
	fn run(&self, _spec: ProcessSpec) -> io::Result<ProcessHandle> {
		Err(io::Error::other(HelperMissing(self.helper.clone())))
	}
}

/// The process runner of the agent CLIs: the `research-provider-spawn`
/// companion beside this executable.
fn process_runner(logger: &dyn EventLogger) -> Arc<dyn ProcessRunner> {
	match UnixProcessRunner::new() {
		Ok(runner) => Arc::new(runner),
		Err(error) => {
			logger.warn(
				"process_helper_missing",
				&[("reason", research_effects::LogValue::from(HELPER_NAME))],
			);
			let helper = error
				.get_ref()
				.and_then(|inner| inner.downcast_ref::<HelperMissing>())
				.map_or_else(|| PathBuf::from(HELPER_NAME), |missing| missing.0.clone());
			Arc::new(MissingHelperRunner { helper })
		}
	}
}

/// Keyed market-data adapters (FR-017): a provider without a key keeps its
/// "unconfigured" source, so its series honestly report SOURCE_NOT_CONFIGURED
/// while the other provider works.
fn market_sources(
	config: &RunnerConfig,
	fetcher: &Arc<dyn SafeFetcher>,
	clock: &Arc<dyn Clock>,
) -> HashMap<String, Arc<dyn MarketSeriesSource>> {
	let unconfigured = |provider: MarketProviderId| -> Arc<dyn MarketSeriesSource> {
		Arc::new(UnconfiguredMarketSeriesSource {
			provider,
			reason: market_unavailable_reason(
				MarketUnavailableCode::SourceNotConfigured,
				Some(provider),
			)
			.to_owned(),
		})
	};
	let fred: Arc<dyn MarketSeriesSource> = match &config.fred_api_key {
		Some(key) => Arc::new(FredSeriesSource::new(
			Secret::new(key.as_str()),
			Arc::clone(fetcher),
			Arc::clone(clock),
		)),
		None => unconfigured(MarketProviderId::Fred),
	};
	let twelve: Arc<dyn MarketSeriesSource> = match &config.twelve_data_api_key {
		Some(key) => Arc::new(TwelveDataSeriesSource::new(
			Secret::new(key.as_str()),
			Arc::clone(fetcher),
		)),
		None => unconfigured(MarketProviderId::TwelveData),
	};
	HashMap::from([
		(MarketProviderId::Fred.as_str().to_owned(), fred),
		(MarketProviderId::TwelveData.as_str().to_owned(), twelve),
	])
}

/// Keyed earnings-date adapters (FR-018): Finnhub without a key keeps its
/// "unconfigured" source, so US stocks honestly report SOURCE_NOT_CONFIGURED;
/// JPX needs no key.
fn earnings_sources(
	config: &RunnerConfig,
	fetcher: &Arc<dyn SafeFetcher>,
	binary_fetcher: &Arc<dyn SafeBinaryFetcher>,
	clock: &Arc<dyn Clock>,
) -> HashMap<String, Arc<dyn EarningsCalendarSource>> {
	let finnhub: Arc<dyn EarningsCalendarSource> = match &config.finnhub_api_key {
		Some(key) => Arc::new(FinnhubEarningsSource::new(
			Secret::new(key.as_str()),
			Arc::clone(fetcher),
		)),
		None => Arc::new(UnconfiguredEarningsCalendarSource(
			EarningsSourceId::Finnhub,
		)),
	};
	let jpx: Arc<dyn EarningsCalendarSource> = Arc::new(JpxEarningsSource::new(
		Arc::clone(fetcher),
		Arc::clone(binary_fetcher),
		Arc::clone(clock),
	));
	HashMap::from([
		(EarningsSourceId::Finnhub.as_str().to_owned(), finnhub),
		(EarningsSourceId::Jpx.as_str().to_owned(), jpx),
	])
}

/// The stock-directory sources by market (ADR-0034). The US list comes from
/// SEC, which requires a declared User-Agent: without a usable
/// `SEC_USER_AGENT` the US source is "unconfigured" and its jobs fail with
/// `DIRECTORY_NOT_CONFIGURED` instead of sending an undeclared agent. The JP
/// list (JPX) needs no key. Rows dropped for an over-long name are logged as
/// a count only (SEC-010: never provider text).
fn stock_directory_sources(
	config: &RunnerConfig,
	fetcher: &Arc<dyn SafeFetcher>,
	binary_fetcher: &Arc<dyn SafeBinaryFetcher>,
	clock: &Arc<dyn Clock>,
	sleeper: &Arc<dyn Sleeper>,
	logger: &Arc<dyn EventLogger>,
) -> HashMap<WatchMarket, Arc<dyn StockDirectorySource>> {
	let dropped = |market: WatchMarket| -> DroppedRowsHook {
		let logger = Arc::clone(logger);
		Arc::new(move |count: usize| {
			logger.info(
				"stock_directory_rows_dropped",
				&[
					("market", LogValue::from(market.as_str())),
					(
						"count",
						LogValue::from(i64::try_from(count).unwrap_or(i64::MAX)),
					),
				],
			);
		})
	};
	let us: Arc<dyn StockDirectorySource> =
		if is_usable_sec_user_agent(config.sec_user_agent.as_deref()) {
			Arc::new(SecDirectorySource::new(
				Arc::new(PacedSecClient::new(
					Arc::clone(fetcher),
					Arc::clone(clock),
					Arc::clone(sleeper),
					config.sec_user_agent.clone(),
				)),
				Some(dropped(WatchMarket::Us)),
			))
		} else {
			Arc::new(UnconfiguredStockDirectorySource(WatchMarket::Us))
		};
	let jp: Arc<dyn StockDirectorySource> = Arc::new(JpxDirectorySource::new(
		Arc::clone(fetcher),
		Arc::clone(binary_fetcher),
		Some(dropped(WatchMarket::Jp)),
	));
	HashMap::from([(WatchMarket::Us, us), (WatchMarket::Jp, jp)])
}

/// Both halves of the OAuth client, or none: without both, every
/// google-calendar job fails honestly with GOOGLE_NOT_CONFIGURED.
fn oauth_client(config: &RunnerConfig) -> Option<OAuthClient> {
	match (
		&config.google_oauth_client_id,
		&config.google_oauth_client_secret,
	) {
		(Some(id), Some(secret)) => Some(OAuthClient {
			client_id: id.clone(),
			client_secret: Secret::new(secret.as_str()),
		}),
		_ => None,
	}
}

/// Composes every adapter into the poll loop's dependencies.
///
/// # Errors
/// A start-up fault: TLS setup, backend or tool registration.
pub fn compose(
	config: &RunnerConfig,
	env: &Env,
	logger: &Arc<dyn EventLogger>,
) -> Result<LoopDeps, CompositionError> {
	let clock: Arc<dyn Clock> = Arc::new(SystemClock);
	let hasher: Arc<dyn Hasher> = Arc::new(Sha256Hasher);
	// One process-wide fetcher: text and binary share the transport and its
	// connection pool.
	let node_fetcher = Arc::new(create_node_safe_fetcher().map_err(|_| CompositionError::Tls)?);
	let fetcher: Arc<dyn SafeFetcher> = node_fetcher.clone();
	let binary_fetcher: Arc<dyn SafeBinaryFetcher> = node_fetcher;
	let feed_parser = Arc::new(FastXmlFeedParser);
	let sleeper: Arc<dyn Sleeper> = Arc::new(TokioSleeper);

	let page_archive = config.pages_directory.as_ref().map(|directory| {
		Arc::new(FilePageArchive::new(directory, Arc::clone(&hasher))) as Arc<dyn PageArchive>
	});
	let tools = ToolRegistry::new(create_research_tools(ResearchToolDeps {
		fetcher: Arc::clone(&fetcher),
		feed_parser: feed_parser.clone(),
		hasher: Arc::clone(&hasher),
		clock: Arc::clone(&clock),
		sec_user_agent: config.sec_user_agent.clone(),
		tavily_api_key: config.tavily_api_key.clone(),
		page_archive,
		sleep: Arc::new(TokioSleep),
		sec_sleep: Arc::clone(&sleeper),
	}))?;

	let runtimes = create_agent_runtimes(ProviderEnvironment {
		process_runner: process_runner(&**logger),
		http: Arc::new(PinnedProviderHttpClient::new().map_err(|_| CompositionError::Tls)?),
		env: env.clone(),
	})?;
	let agents = Arc::new(AgentRegistry::new(runtimes)?);

	let pacer: Arc<dyn MarketPacer> = Arc::new(WindowMarketPacer::standard(
		Arc::clone(&clock),
		Arc::clone(&sleeper),
		usize::try_from(config.twelve_data_requests_per_minute).unwrap_or(usize::MAX),
		usize::try_from(config.twelve_data_daily_limit).unwrap_or(usize::MAX),
	));
	let google: Arc<dyn GoogleCalendarPort> = Arc::new(GoogleSync {
		client: oauth_client(config),
		token_file: PathBuf::from(&config.google_token_file),
		http: Arc::new(PinnedGoogleHttp::new().map_err(|_| CompositionError::Tls)?),
		clock: Arc::clone(&clock),
		logger: Arc::clone(logger),
		pacer: Arc::clone(&pacer),
		sleeper: Arc::clone(&sleeper),
	});
	let scratch_root = config
		.scratch_root
		.as_ref()
		.map_or_else(|| TempScratch::default_root_from_env(env), PathBuf::from);
	let scratch: Arc<dyn ScratchDirectories> = Arc::new(TempScratch::new(scratch_root));

	let api = Arc::new(
		HttpRunnerApi::new(api_options(config), Arc::clone(&sleeper))
			.map_err(|_| CompositionError::Tls)?,
	);
	Ok(LoopDeps {
		jobs: Arc::new(JobDeps {
			api,
			agents,
			tools,
			ingest: IngestDeps {
				fetcher: Arc::clone(&fetcher),
				feed_parser,
				hasher,
				clock: Arc::clone(&clock),
			},
			market_sources: market_sources(config, &fetcher, &clock),
			earnings_sources: earnings_sources(config, &fetcher, &binary_fetcher, &clock),
			stock_directory_sources: stock_directory_sources(
				config,
				&fetcher,
				&binary_fetcher,
				&clock,
				&sleeper,
				logger,
			),
			clock,
			logger: Arc::clone(logger),
			scratch,
			new_fence_token: Arc::new(new_fence_token),
			allow_unverified_tool_isolation: config.allow_unverified_tool_isolation,
			pacer,
			google,
		}),
		sleeper,
	})
}

/// The API client alone, for `renew`: no agent backends, no tools.
///
/// # Errors
/// An unparsable URL or header value, or a TLS setup failure.
pub fn renewal_api(
	config: &RunnerConfig,
) -> Result<Arc<dyn RunnerApi>, crate::api_client::ApiClientSetupError> {
	Ok(Arc::new(crate::api_client::HttpRunnerApi::new(
		api_options(config),
		Arc::new(TokioSleeper),
	)?))
}

fn api_options(config: &RunnerConfig) -> crate::api_client::HttpRunnerApiOptions {
	crate::api_client::HttpRunnerApiOptions::new(
		config.api_url.clone(),
		config.runner_token.clone(),
		config.access_client_id.clone(),
		config.access_client_secret.clone(),
	)
}
