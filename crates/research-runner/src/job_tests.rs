//! Ports of `apps/runner/test/{runner,jobExecution}.test.ts` and the shell
//! rules of shell-wire spec sections 3 and 4: a fake `RunnerApi`, a scripted
//! agent, and the real research pipeline, ingest and refresh job bodies.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use research_agent_core::authorize::ToolRegistry;
use research_agent_core::registry::AgentRegistry;
use research_agent_core::runtime::{AgentProbe, AgentRunContext, AgentRuntime, AgentTurn};
use research_agent_core::tools::{
	CollectedEvidence, Tool, ToolContext, ToolCostCategory, ToolFailure, ToolMeta,
	ToolNetworkAllowlist, ToolOutput, ToolSideEffect,
};
use research_application::ingest::IngestDeps;
use research_application::ports::{
	Clock, FeedParser, FetchedDocument, Hasher, NotAFeed, SafeFetchError, SafeFetchErrorCode,
	SafeFetchOptions, SafeFetcher,
};
use research_contracts::agent::{
	AgentAvailability, AgentCapabilities, AgentEvent, AgentRequest, Capability, CostModel,
	ToolIsolation,
};
use research_contracts::jobs::{
	ClaimJobResponse, ClaimedJob, CompleteJobRequest, CompleteJobResponse, EMPTY_USAGE,
	EventsResponse, GoogleCalendarJob, HeartbeatResponse, ReleaseJobRequest, ReleaseJobResponse,
	ReleasedJobState, ResourceUsage, RunnerEventBody, RunnerEventsRequest,
};
use research_contracts::{Tri, parse};
use research_domain::jobs::state_machine::JobState;
use research_domain::news::raw_feed::{FeedKind, RawFeed, RawFeedItem};
use research_effects::{EventLogger, LogValue};
use research_finance::pacing::WindowMarketPacer;
use research_finance::ports::{
	MarketSeriesSource, MarketUnavailable, SeriesData, SeriesQuery, TokioSleeper,
};
use research_google::jobs::{GoogleAuthUrlSender, GoogleExecutionError};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::api_client::{RunnerApi, RunnerApiError, RunnerApiResult};
use crate::google_sync::GoogleCalendarPort;
use crate::job_execution::{
	JobDeps, ProgressCounts, execute_job, run_finished_fields, to_completion,
};
use crate::runner_loop::{LoopDeps, RunnerExit, run_runner_loop};
use crate::scratch::ScratchDirectories;
use crate::test_support::RecordedLogger;

const RUN_ID: &str = "run_test";
/// 2026-10-11T00:00:00.000Z
const START_MS: i64 = 1_791_676_800_000;

/* ---------- fake Worker ---------- */

type Scripted<T> = Result<T, RunnerApiError>;

fn api_failure<T>(code: &str, transient: bool) -> Scripted<T> {
	Err(RunnerApiError {
		code: code.to_owned(),
		detail: String::new(),
		transient,
	})
}

#[derive(Default)]
struct ApiScript {
	claim: Vec<Scripted<ClaimJobResponse>>,
	heartbeat: Vec<Scripted<HeartbeatResponse>>,
	events: Vec<Scripted<EventsResponse>>,
	complete: Vec<Scripted<CompleteJobResponse>>,
	release: Vec<Scripted<ReleaseJobResponse>>,
}

#[derive(Default, Clone)]
struct ApiCalls {
	claim: usize,
	heartbeats: Vec<u64>,
	events: Vec<RunnerEventsRequest>,
	completions: Vec<CompleteJobRequest>,
	releases: Vec<ReleaseJobRequest>,
}

/// In-memory Worker stand-in that records every runner call and plays scripted answers.
struct FakeApi {
	script: Mutex<ApiScript>,
	calls: Mutex<ApiCalls>,
	/// Makes `heartbeat` take this long (virtual or real time).
	heartbeat_delay: Option<Duration>,
	/// Makes `heartbeat` panic.
	heartbeat_panics: bool,
}

fn next<T: Clone>(queue: &mut Vec<Scripted<T>>, fallback: Scripted<T>) -> Scripted<T> {
	if queue.len() > 1 {
		queue.remove(0)
	} else {
		queue.first().cloned().unwrap_or(fallback)
	}
}

impl FakeApi {
	fn new(script: ApiScript) -> Arc<Self> {
		Arc::new(Self {
			script: Mutex::new(script),
			calls: Mutex::new(ApiCalls::default()),
			heartbeat_delay: None,
			heartbeat_panics: false,
		})
	}

	fn calls(&self) -> ApiCalls {
		self.calls.lock().unwrap().clone()
	}
}

fn beat(cancel: bool) -> HeartbeatResponse {
	HeartbeatResponse {
		lease_expires_at: "2026-10-11T00:03:00.000Z".to_owned(),
		cancel_requested: cancel,
	}
}

fn completed() -> CompleteJobResponse {
	CompleteJobResponse {
		state: JobState::Completed,
		replayed: false,
		new_article_count: 0,
	}
}

#[async_trait]
impl RunnerApi for FakeApi {
	async fn claim(
		&self,
		_request: &research_contracts::jobs::ClaimJobRequest,
	) -> RunnerApiResult<ClaimJobResponse> {
		self.calls.lock().unwrap().claim += 1;
		next(
			&mut self.script.lock().unwrap().claim,
			Ok(ClaimJobResponse {
				job: None,
				poll_after_ms: 15_000,
			}),
		)
	}

	async fn heartbeat(
		&self,
		_run_id: &str,
		lease_generation: u64,
	) -> RunnerApiResult<HeartbeatResponse> {
		self.calls.lock().unwrap().heartbeats.push(lease_generation);
		assert!(!self.heartbeat_panics, "heartbeat request exploded");
		if let Some(delay) = self.heartbeat_delay {
			tokio::time::sleep(delay).await;
		}
		next(&mut self.script.lock().unwrap().heartbeat, Ok(beat(false)))
	}

	async fn events(
		&self,
		_run_id: &str,
		request: &RunnerEventsRequest,
	) -> RunnerApiResult<EventsResponse> {
		self.calls.lock().unwrap().events.push(request.clone());
		next(
			&mut self.script.lock().unwrap().events,
			Ok(EventsResponse {
				cancel_requested: false,
			}),
		)
	}

	async fn complete(
		&self,
		_run_id: &str,
		request: &CompleteJobRequest,
	) -> RunnerApiResult<CompleteJobResponse> {
		self.calls.lock().unwrap().completions.push(request.clone());
		next(&mut self.script.lock().unwrap().complete, Ok(completed()))
	}

	async fn release_lease(
		&self,
		_run_id: &str,
		request: &ReleaseJobRequest,
	) -> RunnerApiResult<ReleaseJobResponse> {
		self.calls.lock().unwrap().releases.push(request.clone());
		next(
			&mut self.script.lock().unwrap().release,
			Ok(ReleaseJobResponse {
				state: ReleasedJobState::Pending,
			}),
		)
	}

	async fn renew_credential(
		&self,
		_expires_in_days: u32,
	) -> RunnerApiResult<research_contracts::api::IssuedRunnerCredential> {
		api_failure("NOT_USED", false)
	}
}

/* ---------- scripted agent, tools, fetcher, scratch ---------- */

struct ScriptedAgent {
	replies: Vec<String>,
	turns: AtomicUsize,
	requests: Mutex<Vec<AgentRequest>>,
	scratch_directories: Mutex<Vec<Option<String>>>,
	/// Runs when a turn starts (before its events).
	on_turn: Box<dyn Fn(usize) + Send + Sync>,
	/// Delay before the events of turn 0, in the producer task.
	first_turn_delay: Option<Duration>,
}

#[async_trait]
impl AgentRuntime for ScriptedAgent {
	fn agent_id(&self) -> &str {
		"scripted"
	}
	fn display_name(&self) -> &str {
		"Scripted"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::PlanLimited
	}
	fn tool_isolation(&self) -> ToolIsolation {
		ToolIsolation::Enforced
	}
	async fn probe(&self) -> AgentProbe {
		AgentProbe {
			capabilities: AgentCapabilities {
				supported: vec![Capability::Stream],
				model: None,
				models: None,
			},
			availability: AgentAvailability::Available,
		}
	}
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn {
		let turn = self.turns.fetch_add(1, Ordering::SeqCst);
		self.requests.lock().unwrap().push(request);
		self.scratch_directories.lock().unwrap().push(
			context
				.scratch_directory
				.as_ref()
				.map(|path| path.to_string_lossy().into_owned()),
		);
		(self.on_turn)(turn);
		let reply = self.replies.get(turn).cloned().unwrap_or_default();
		let delay = if turn == 0 {
			self.first_turn_delay
		} else {
			None
		};
		AgentTurn::spawn(&context.cancel, move |sender| async move {
			if let Some(delay) = delay {
				tokio::time::sleep(delay).await;
			}
			if sender.send(AgentEvent::TextDelta { text: reply }).await {
				let _ = sender.send(AgentEvent::Completed).await;
			}
		})
	}
}

const ARTICLE_TEXT: &str = "Orders for grid storage reached 100 GWh in 2026, up from 70 GWh a year earlier. Example Storage Corp supplies battery systems to utilities. Analysts at a rival firm said demand could stall if subsidies lapse.";

struct NewsTool {
	meta: ToolMeta,
	executed: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl Tool for NewsTool {
	fn meta(&self) -> &ToolMeta {
		&self.meta
	}
	fn parse_args(&self, args: &research_js::json::Value) -> Option<research_js::json::Value> {
		Some(args.clone())
	}
	async fn execute(
		&self,
		_args: research_js::json::Value,
		context: ToolContext,
	) -> Result<ToolOutput, ToolFailure> {
		self.executed
			.lock()
			.unwrap()
			.push("news.fetch_feed".to_owned());
		let id = context.ids.next_id("ev");
		let evidence = parse::<research_contracts::records::Evidence>(&format!(
			r#"{{"evidenceId":"{id}","sourceUrl":"https://news.example.org/articles/{id}","title":"Grid storage orders rise","publisher":"Example News","publishedAt":"2026-10-01T00:00:00.000Z","retrievedAt":"2026-10-11T00:00:00.000Z","effectiveAt":null,"excerpt":"{}","checksum":"{}","sourceClass":"news"}}"#,
			&ARTICLE_TEXT[..200],
			"b".repeat(64)
		))
		.unwrap();
		Ok(ToolOutput {
			model_text: format!("[{id}] Grid storage orders rise\n{ARTICLE_TEXT}"),
			evidence: vec![CollectedEvidence {
				evidence,
				retrieved_text: ARTICLE_TEXT.to_owned(),
				retain_quotes: true,
			}],
			..ToolOutput::default()
		})
	}
}

fn news_tools() -> (ToolRegistry, Arc<Mutex<Vec<String>>>) {
	let executed = Arc::new(Mutex::new(Vec::new()));
	let tool = NewsTool {
		meta: ToolMeta {
			tool_id: "news.fetch_feed",
			version: "1",
			description: "Fetch a subscribed feed.",
			args_hint: r#"{"sourceId": string}"#,
			timeout_ms: 5_000,
			permission: "research-read",
			cost_category: ToolCostCategory::Free,
			side_effect: ToolSideEffect::ExternalRead,
			network_allowlist: ToolNetworkAllowlist::SubscribedSources,
		},
		executed: Arc::clone(&executed),
	};
	(ToolRegistry::new(vec![Arc::new(tool)]).unwrap(), executed)
}

struct FakeScratch {
	created: Mutex<Vec<String>>,
	removed: Mutex<Vec<String>>,
}

#[async_trait]
impl ScratchDirectories for FakeScratch {
	async fn create(&self, run_id: &str) -> std::io::Result<std::path::PathBuf> {
		let path = format!("/scratch/{run_id}");
		self.created.lock().unwrap().push(path.clone());
		Ok(path.into())
	}
	async fn remove(&self, path: &std::path::Path) -> std::io::Result<()> {
		self.removed
			.lock()
			.unwrap()
			.push(path.to_string_lossy().into_owned());
		Ok(())
	}
}

struct FakeFetcher {
	documents: HashMap<String, String>,
}

#[async_trait]
impl SafeFetcher for FakeFetcher {
	async fn fetch_text(
		&self,
		url: &str,
		_options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		self.documents.get(url).map_or_else(
			|| {
				Err(SafeFetchError::new(
					SafeFetchErrorCode::Timeout,
					"test".to_owned(),
				))
			},
			|text| {
				Ok(FetchedDocument {
					final_url: url.to_owned(),
					content_type: Some("application/xml".to_owned()),
					text: text.clone(),
				})
			},
		)
	}
}

/// `FEED:<title>@<link>|<title>@<link>`
struct TestFeedParser;

impl FeedParser for TestFeedParser {
	fn parse(&self, text: &str) -> Result<RawFeed, NotAFeed> {
		let entries = text.strip_prefix("FEED:").ok_or(NotAFeed)?;
		Ok(RawFeed {
			kind: FeedKind::Rss,
			title: Some("Example News".to_owned()),
			site_link: None,
			items: entries
				.split('|')
				.map(|entry| {
					let (title, link) = entry.split_once('@').unwrap_or((entry, ""));
					RawFeedItem {
						title: Some(title.to_owned()),
						link: Some(link.to_owned()),
						published_text: Some("2026-10-01T00:00:00Z".to_owned()),
						summary_text: Some("summary text".to_owned()),
					}
				})
				.collect(),
		})
	}
}

struct Sha;

impl Hasher for Sha {
	fn sha256_hex(&self, text: &str) -> String {
		hex::encode(Sha256::digest(text.as_bytes()))
	}
}

struct FixedClock;

impl Clock for FixedClock {
	fn now_ms(&self) -> i64 {
		START_MS
	}
	fn now_iso(&self) -> String {
		research_js::date::epoch_ms_to_iso(START_MS).unwrap()
	}
}

/// Records what the shell asks of Google; scripts the completion.
#[derive(Default)]
struct FakeGoogle {
	discarded: Mutex<Vec<String>>,
	/// What `execute` returns.
	outcome: Mutex<Option<CompleteJobRequest>>,
	/// Sends the sign-in URL this many times before returning.
	auth_url_sends: usize,
	delivered: Mutex<Vec<bool>>,
}

#[async_trait]
impl GoogleCalendarPort for FakeGoogle {
	async fn execute(
		&self,
		_job: &GoogleCalendarJob,
		_cancel: &CancellationToken,
		_reporter: &dyn research_application::reporter::PipelineReporter,
		sender: &dyn GoogleAuthUrlSender,
	) -> Result<CompleteJobRequest, GoogleExecutionError> {
		for _ in 0..self.auth_url_sends {
			let url = research_google::oauth::build_authorization_url(
				"client-id.apps.googleusercontent.com",
				"http://127.0.0.1:51234/",
				"state-0123456789",
				&research_google::oauth::code_challenge_s256("verifier-0123456789"),
			);
			let delivered = sender.send_auth_url(&url).await;
			self.delivered.lock().unwrap().push(delivered);
		}
		Ok(self.outcome.lock().unwrap().take().unwrap())
	}
	async fn discard_grant(&self, run_id: &str) -> Result<(), GoogleExecutionError> {
		self.discarded.lock().unwrap().push(run_id.to_owned());
		Ok(())
	}
}

/// A market source that takes `delay` to fail.
struct SlowSource {
	delay: Duration,
}

#[async_trait]
impl MarketSeriesSource for SlowSource {
	fn provider_id(&self) -> research_contracts::market::MarketProviderId {
		research_contracts::market::MarketProviderId::Fred
	}
	async fn fetch_series(&self, _query: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		tokio::time::sleep(self.delay).await;
		Err(MarketUnavailable::new(
			research_contracts::market::MarketUnavailableCode::SourceFailed,
			research_contracts::market::MarketProviderId::Fred,
			None,
		))
	}
}

/* ---------- harness ---------- */

struct Options {
	replies: Vec<String>,
	on_turn: Box<dyn Fn(usize) + Send + Sync>,
	first_turn_delay: Option<Duration>,
	feeds: HashMap<String, String>,
	logger: Option<Arc<dyn EventLogger>>,
	google: Arc<FakeGoogle>,
	market_delay: Option<Duration>,
	/// Replaces the Fred source (a delayed failure when `market_delay` is set).
	market_source: Option<Arc<dyn MarketSeriesSource>>,
	/// The Finnhub source.
	earnings_source: Option<Arc<dyn research_finance::ports::EarningsCalendarSource>>,
	/// Stock-directory sources by market (none: every market is unconfigured).
	directory_sources: Vec<(
		research_contracts::watchlist::WatchMarket,
		Arc<dyn research_finance::ports::StockDirectorySource>,
	)>,
	/// The fence-token factory panics on this call (1-based).
	fence_panics_on_call: Option<usize>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			replies: vec![PLAN.to_owned(), analysis(), VERDICT_SUPPORTED.to_owned()],
			on_turn: Box::new(|_| {}),
			first_turn_delay: None,
			feeds: HashMap::new(),
			logger: None,
			google: Arc::new(FakeGoogle::default()),
			market_delay: None,
			market_source: None,
			earnings_source: None,
			directory_sources: Vec::new(),
			fence_panics_on_call: None,
		}
	}
}

struct Harness {
	deps: Arc<JobDeps>,
	agent: Arc<ScriptedAgent>,
	executed: Arc<Mutex<Vec<String>>>,
	scratch: Arc<FakeScratch>,
	log: RecordedLogger,
	google: Arc<FakeGoogle>,
}

fn harness(api: Arc<FakeApi>, options: Options) -> Harness {
	let agent = Arc::new(ScriptedAgent {
		replies: options.replies,
		turns: AtomicUsize::new(0),
		requests: Mutex::new(Vec::new()),
		scratch_directories: Mutex::new(Vec::new()),
		on_turn: options.on_turn,
		first_turn_delay: options.first_turn_delay,
	});
	let (tools, executed) = news_tools();
	let scratch = Arc::new(FakeScratch {
		created: Mutex::new(Vec::new()),
		removed: Mutex::new(Vec::new()),
	});
	let log = RecordedLogger::new();
	let clock: Arc<dyn Clock> = Arc::new(FixedClock);
	let mut market_sources: HashMap<String, Arc<dyn MarketSeriesSource>> = HashMap::new();
	if let Some(delay) = options.market_delay {
		market_sources.insert("fred".to_owned(), Arc::new(SlowSource { delay }));
	}
	if let Some(source) = options.market_source {
		market_sources.insert("fred".to_owned(), source);
	}
	let mut earnings_sources = HashMap::new();
	if let Some(source) = options.earnings_source {
		earnings_sources.insert("finnhub".to_owned(), source);
	}
	let deps = Arc::new(JobDeps {
		api,
		agents: Arc::new(
			AgentRegistry::new(vec![Arc::clone(&agent) as Arc<dyn AgentRuntime>]).unwrap(),
		),
		tools,
		ingest: IngestDeps {
			fetcher: Arc::new(FakeFetcher {
				documents: options.feeds,
			}),
			feed_parser: Arc::new(TestFeedParser),
			hasher: Arc::new(Sha),
			clock: Arc::clone(&clock),
		},
		clock: Arc::clone(&clock),
		logger: options.logger.unwrap_or_else(|| log.logger()),
		scratch: Arc::clone(&scratch) as Arc<dyn ScratchDirectories>,
		new_fence_token: {
			let calls = AtomicUsize::new(0);
			let panic_on = options.fence_panics_on_call;
			Arc::new(move || {
				let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
				assert!(panic_on != Some(call), "the fence source exploded");
				"fence".to_owned()
			})
		},
		allow_unverified_tool_isolation: false,
		market_sources,
		earnings_sources,
		stock_directory_sources: options.directory_sources.into_iter().collect(),
		// No limits: tests never wait for the quota gate.
		pacer: Arc::new(WindowMarketPacer::new(
			clock,
			Arc::new(TokioSleeper),
			HashMap::new(),
			HashMap::new(),
		)),
		google: Arc::clone(&options.google) as Arc<dyn GoogleCalendarPort>,
	});
	Harness {
		deps,
		agent,
		executed,
		scratch,
		log,
		google: options.google,
	}
}

const PLAN: &str =
	r#"{"toolCalls":[{"toolId":"news.fetch_feed","args":{"sourceId":"src_news"}}],"done":true}"#;
const VERDICT_SUPPORTED: &str = r#"{"verdicts":[{"claimIndex":0,"verdict":"supported"}]}"#;

fn analysis() -> String {
	let ev = format!("{RUN_ID}_ev1");
	serde_json::json!({
		"claims": [{
			"text": "Grid storage orders reached 100 GWh in 2026.",
			"claimType": "observation",
			"evidence": [{"evidenceId": ev, "relation": "supports", "quote": "Orders for grid storage reached 100 GWh in 2026"}]
		}],
		"scenarios": [{
			"productOrService": "Grid-scale battery storage",
			"quantityKind": "unit-demand",
			"unit": "GWh per year",
			"baseYear": 2026,
			"targetYear": 2030,
			"baselineValue": 100,
			"baselineEvidenceId": ev,
			"baselineQuote": "Orders for grid storage reached 100 GWh in 2026",
			"bear": {"targetValue": 146.41, "assumptions": ["Permitting delays persist"]},
			"base": {"targetValue": 207.36, "assumptions": ["Order trend continues"]},
			"bull": {"targetValue": 285.61, "assumptions": ["Subsidies are extended"]},
			"drivers": ["Renewable build-out"],
			"barriers": ["Interconnection queues"],
			"falsifiers": ["Orders fall for two consecutive years"],
			"methodology": "Order-book extrapolation from the cited baseline.",
			"supportingEvidenceIds": [ev],
			"contraryEvidenceIds": [ev]
		}],
		"suppliers": [{
			"issuerName": "Example Storage Corp",
			"ticker": "EXMP",
			"exchange": "NASDAQ",
			"country": "US",
			"productsOrServices": ["Battery systems"],
			"businessExposure": "Supplies battery systems to utilities.",
			"scenarioIndex": 0,
			"evidence": [{"evidenceId": ev, "quote": "Example Storage Corp supplies battery systems to utilities"}]
		}],
		"pricingPower": [],
		"uiOperations": []
	})
	.to_string()
}

const SOURCE: &str = r#"{"sourceId":"src_news","canonicalUrl":"https://news.example.org/feed.xml","publisher":"Example News","title":"Example News","licensePolicy":"short-excerpt-permitted"}"#;
const ZERO_USAGE: &str =
	r#"{"agentSteps":0,"toolCalls":0,"inputBytes":0,"knownCostUsd":0,"hasUnmeteredUsage":false}"#;

fn lease(kind: &str, run_id: &str, generation: u64, heartbeat_ms: u64) -> String {
	format!(
		r#""kind":"{kind}","runId":"{run_id}","leaseGeneration":{generation},"leaseExpiresAt":"2026-10-11T00:01:30.000Z","attempt":1,"heartbeatIntervalMs":{heartbeat_ms},"sources":[{SOURCE}]"#
	)
}

fn research_job_with(
	agent_id: &str,
	prior_usage: &str,
	context: &str,
	heartbeat_ms: u64,
) -> ClaimedJob {
	parse(&format!(
		r#"{{{},"request":{{"workspaceId":"ws_test","question":"Which storage products will see demand growth?","agentId":"{agent_id}","model":null,"effort":"medium","horizonYears":4,"markets":["JP","US"],"budget":{{"maxAgentSteps":6,"maxToolCalls":10,"maxWallClockMs":600000,"maxInputBytes":400000,"maxSpendUsd":null}},"webAccess":"off"}},"priorUsage":{prior_usage},"workspaceComponents":[],"conversationContext":{context}}}"#,
		lease("research", RUN_ID, 3, heartbeat_ms)
	))
	.unwrap()
}

fn research_job() -> ClaimedJob {
	research_job_with("scripted", ZERO_USAGE, "[]", 20_000)
}

fn ingest_job() -> ClaimedJob {
	parse(&format!(
		"{{{}}}",
		lease("news-ingest", "run_ingest", 1, 20_000)
	))
	.unwrap()
}

fn market_job(series: &[&str], heartbeat_ms: u64) -> ClaimedJob {
	let entries: Vec<String> = series
		.iter()
		.map(|id| format!(r#"{{"seriesId":"{id}","latestObservedOn":null}}"#))
		.collect();
	parse(&format!(
		r#"{{{},"series":[{}]}}"#,
		lease("market-refresh", "run_market", 5, heartbeat_ms),
		entries.join(",")
	))
	.unwrap()
}

fn google_job(action: &str) -> ClaimedJob {
	parse(&format!(
		r#"{{{},"action":"{action}"}}"#,
		lease("google-calendar", "run_google", 2, 20_000)
	))
	.unwrap()
}

fn state_sequence(calls: &ApiCalls) -> Vec<&'static str> {
	calls
		.events
		.iter()
		.flat_map(|request| request.events.iter())
		.filter_map(|entry| match &entry.event {
			RunnerEventBody::State { state } => Some(state.as_str()),
			_ => None,
		})
		.collect()
}

fn outcome_names(calls: &ApiCalls) -> Vec<&'static str> {
	calls
		.completions
		.iter()
		.map(|completion| match completion {
			CompleteJobRequest::Completed { .. } => "completed",
			CompleteJobRequest::Failed { .. } => "failed",
			CompleteJobRequest::Cancelled { .. } => "cancelled",
			CompleteJobRequest::Ingested { .. } => "ingested",
			CompleteJobRequest::MarketRefreshed { .. } => "market-refreshed",
			CompleteJobRequest::GoogleCalendarConnected { .. } => "google-calendar-connected",
			_ => "other",
		})
		.collect()
}

const FULL_LIFECYCLE: [&str; 5] = [
	"planning",
	"collecting",
	"analyzing",
	"verifying",
	"publishing",
];

async fn run(job: ClaimedJob, harness: &Harness) {
	execute_job(job, Arc::clone(&harness.deps), CancellationToken::new()).await;
}

/* ---------- the poll loop (runner.test.ts) ---------- */

/// Records the requested waits and ends the loop after `stop_after` of them.
struct StoppingSleeper {
	sleeps: Mutex<Vec<u64>>,
	stop_after: usize,
	shutdown: CancellationToken,
}

#[async_trait]
impl research_finance::ports::Sleeper for StoppingSleeper {
	async fn sleep(&self, ms: u64, _cancel: Option<&CancellationToken>) {
		let mut sleeps = self.sleeps.lock().unwrap();
		sleeps.push(ms);
		if sleeps.len() >= self.stop_after {
			self.shutdown.cancel();
		}
	}
}

async fn run_loop(api: &Arc<FakeApi>, stop_after: usize) -> (RunnerExit, Vec<u64>, Harness) {
	let shutdown = CancellationToken::new();
	let harness = harness(Arc::clone(api), Options::default());
	let sleeper = Arc::new(StoppingSleeper {
		sleeps: Mutex::new(Vec::new()),
		stop_after,
		shutdown: shutdown.clone(),
	});
	let exit = run_runner_loop(
		&LoopDeps {
			jobs: Arc::clone(&harness.deps),
			sleeper: Arc::clone(&sleeper) as Arc<dyn research_finance::ports::Sleeper>,
		},
		&shutdown,
	)
	.await;
	let sleeps = sleeper.sleeps.lock().unwrap().clone();
	(exit, sleeps, harness)
}

fn idle(poll_after_ms: u64) -> Scripted<ClaimJobResponse> {
	Ok(ClaimJobResponse {
		job: None,
		poll_after_ms,
	})
}

#[tokio::test]
async fn the_loop_follows_the_servers_poll_hint_when_idle_and_never_polls_faster() {
	let api = FakeApi::new(ApiScript {
		claim: vec![idle(1_000), idle(5_000), idle(15_000)],
		..ApiScript::default()
	});
	let (exit, sleeps, harness) = run_loop(&api, 3).await;
	assert_eq!(exit, RunnerExit::Shutdown);
	assert_eq!(sleeps, [1_000, 5_000, 15_000]);
	assert_eq!(api.calls().claim, 3);
	// The probe is logged once, before the first claim.
	assert_eq!(
		harness
			.log
			.events()
			.iter()
			.filter(|event| *event == "agent_probe")
			.count(),
		1
	);
}

#[tokio::test]
async fn the_loop_caps_an_excessive_poll_hint() {
	let api = FakeApi::new(ApiScript {
		claim: vec![idle(86_400_000)],
		..ApiScript::default()
	});
	let (_, sleeps, _) = run_loop(&api, 1).await;
	assert_eq!(sleeps, [60_000]);
}

#[tokio::test]
async fn the_loop_backs_off_exponentially_on_errors_and_recovers() {
	let api = FakeApi::new(ApiScript {
		claim: vec![
			api_failure("TRANSPORT_ERROR", true),
			api_failure("TRANSPORT_ERROR", true),
			api_failure("HTTP_503", true),
			idle(15_000),
		],
		..ApiScript::default()
	});
	let (_, sleeps, harness) = run_loop(&api, 5).await;
	assert_eq!(sleeps, [2_000, 4_000, 8_000, 15_000, 15_000]);
	let lines = harness.log.lines();
	assert!(lines.iter().any(|line| {
		line.contains(r#""event":"claim_failed","code":"TRANSPORT_ERROR","retryInMs":2000"#)
	}));
	assert!(
		lines
			.iter()
			.any(|line| line.contains(r#""code":"HTTP_503","retryInMs":8000"#))
	);
}

#[tokio::test]
async fn the_backoff_is_capped_at_a_minute() {
	let api = FakeApi::new(ApiScript {
		claim: vec![api_failure("TRANSPORT_ERROR", true)],
		..ApiScript::default()
	});
	let (_, sleeps, _) = run_loop(&api, 8).await;
	assert_eq!(
		sleeps,
		[2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]
	);
}

#[tokio::test]
async fn the_loop_stops_instead_of_retrying_when_its_credential_is_rejected() {
	for code in ["UNAUTHENTICATED", "FORBIDDEN"] {
		let api = FakeApi::new(ApiScript {
			claim: vec![api_failure(code, false)],
			..ApiScript::default()
		});
		let (exit, sleeps, harness) = run_loop(&api, 99).await;
		assert_eq!(exit, RunnerExit::Unauthenticated);
		assert_eq!(api.calls().claim, 1);
		assert!(sleeps.is_empty());
		assert!(
			harness
				.log
				.lines()
				.iter()
				.any(|line| line.contains(&format!(
					r#""level":"error","event":"runner_credential_rejected","code":"{code}""#
				)))
		);
	}
}

#[tokio::test]
async fn the_loop_executes_a_claimed_job_and_immediately_polls_again() {
	let api = FakeApi::new(ApiScript {
		claim: vec![
			Ok(ClaimJobResponse {
				job: Some(market_job(&[], 20_000)),
				poll_after_ms: 2_000,
			}),
			idle(15_000),
		],
		..ApiScript::default()
	});
	let (_, sleeps, harness) = run_loop(&api, 1).await;
	assert_eq!(api.calls().completions.len(), 1);
	assert_eq!(sleeps, [15_000]);
	assert!(harness.log.lines().iter().any(|line| line.contains(
		r#""event":"job_claimed","runId":"run_market","kind":"market-refresh","attempt":1,"leaseGeneration":5"#
	)));
}

#[tokio::test]
async fn the_loop_re_probes_agents_after_five_minutes_only() {
	struct Ticking(AtomicUsize);
	impl Clock for Ticking {
		fn now_ms(&self) -> i64 {
			// First read: probe decision; second: stamp; then 2 minutes per loop turn.
			i64::try_from(self.0.fetch_add(1, Ordering::SeqCst)).unwrap() * 120_000
		}
		fn now_iso(&self) -> String {
			String::new()
		}
	}
	let api = FakeApi::new(ApiScript {
		claim: vec![idle(1)],
		..ApiScript::default()
	});
	let shutdown = CancellationToken::new();
	let base = harness(Arc::clone(&api), Options::default());
	let mut deps = Arc::try_unwrap(base.deps).ok().unwrap();
	deps.clock = Arc::new(Ticking(AtomicUsize::new(0)));
	let sleeper = Arc::new(StoppingSleeper {
		sleeps: Mutex::new(Vec::new()),
		stop_after: 6,
		shutdown: shutdown.clone(),
	});
	run_runner_loop(
		&LoopDeps {
			jobs: Arc::new(deps),
			sleeper,
		},
		&shutdown,
	)
	.await;
	let probes = base
		.log
		.events()
		.iter()
		.filter(|event| *event == "agent_probe")
		.count();
	// Reads advance 2 minutes each: probes at turns 1 and 4 (6 minutes later), none between.
	assert_eq!(probes, 2);
}

/* ---------- one job under a lease (jobExecution.test.ts) ---------- */

#[tokio::test]
async fn reports_ordered_progress_completes_exactly_once_and_discards_scratch() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(research_job(), &harness).await;
	let calls = api.calls();

	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	// Sequence numbers are strictly increasing across requests, so resends are idempotent.
	let seqs: Vec<u64> = calls
		.events
		.iter()
		.flat_map(|request| request.events.iter().map(|entry| entry.seq))
		.collect();
	assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "{seqs:?}");
	assert!(
		calls
			.events
			.iter()
			.all(|request| request.lease_generation == 3)
	);
	assert_eq!(outcome_names(&calls), ["completed"]);
	assert!(matches!(
		calls.completions[0],
		CompleteJobRequest::Completed {
			lease_generation: 3,
			..
		}
	));
	assert_eq!(
		*harness.scratch.created.lock().unwrap(),
		[format!("/scratch/{RUN_ID}")]
	);
	assert_eq!(
		*harness.scratch.removed.lock().unwrap(),
		[format!("/scratch/{RUN_ID}")]
	);
	// The agent ran inside the per-job scratch directory.
	assert!(
		harness
			.agent
			.scratch_directories
			.lock()
			.unwrap()
			.iter()
			.all(|directory| directory.as_deref() == Some(&*format!("/scratch/{RUN_ID}")))
	);
	assert_eq!(*harness.executed.lock().unwrap(), ["news.fetch_feed"]);
}

#[tokio::test]
async fn stops_and_reports_cancelled_when_the_heartbeat_carries_a_cancellation() {
	let api = FakeApi::new(ApiScript {
		heartbeat: vec![Ok(beat(true))],
		..ApiScript::default()
	});
	// The planning turn outlasts the first heartbeat (30 ms interval).
	let harness = harness(
		Arc::clone(&api),
		Options {
			first_turn_delay: Some(Duration::from_millis(250)),
			..Options::default()
		},
	);
	run(
		research_job_with("scripted", ZERO_USAGE, "[]", 30),
		&harness,
	)
	.await;
	let calls = api.calls();
	assert_eq!(calls.heartbeats, [3]);
	assert_eq!(outcome_names(&calls), ["cancelled"]);
	assert!(matches!(
		calls.completions[0],
		CompleteJobRequest::Cancelled {
			lease_generation: 3,
			..
		}
	));
	// Cancelled during planning: the tool call the plan asked for never ran.
	assert!(harness.executed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn submits_nothing_once_the_lease_is_lost() {
	for lost_via in ["events", "heartbeat"] {
		let (script, options) = if lost_via == "events" {
			(
				ApiScript {
					events: vec![
						Ok(EventsResponse {
							cancel_requested: false,
						}),
						api_failure("STALE_LEASE", false),
					],
					..ApiScript::default()
				},
				Options::default(),
			)
		} else {
			(
				ApiScript {
					heartbeat: vec![api_failure("STALE_LEASE", false)],
					..ApiScript::default()
				},
				Options {
					first_turn_delay: Some(Duration::from_millis(250)),
					..Options::default()
				},
			)
		};
		let api = FakeApi::new(script);
		let harness = harness(Arc::clone(&api), options);
		run(
			research_job_with("scripted", ZERO_USAGE, "[]", 30),
			&harness,
		)
		.await;
		assert!(api.calls().completions.is_empty(), "{lost_via}");
		// A lost lease is not ours to hand back (ADR-0036).
		assert!(api.calls().releases.is_empty(), "{lost_via}");
		assert_eq!(
			harness.scratch.removed.lock().unwrap().len(),
			1,
			"{lost_via}"
		);
		assert!(
			harness.log.lines().iter().any(|line| line
				.contains(r#""event":"job_abandoned","runId":"run_test","reason":"lease-lost""#)),
			"{lost_via}"
		);
	}
}

#[tokio::test]
async fn abandons_the_job_on_shutdown_without_completing_it() {
	let shutdown = CancellationToken::new();
	let api = FakeApi::new(ApiScript::default());
	let trigger = shutdown.clone();
	let harness = harness(
		Arc::clone(&api),
		Options {
			on_turn: Box::new(move |turn| {
				if turn == 1 {
					trigger.cancel();
				}
			}),
			..Options::default()
		},
	);
	execute_job(research_job(), Arc::clone(&harness.deps), shutdown).await;
	let calls = api.calls();
	assert!(calls.completions.is_empty());
	// ADR-0036: the lease is handed back with the usage so far, which the
	// unflushed event queue would otherwise lose.
	assert_eq!(calls.releases.len(), 1);
	assert_eq!(calls.releases[0].lease_generation, 3);
	assert!(
		calls.releases[0].usage.agent_steps >= 1,
		"{:?}",
		calls.releases[0]
	);
	assert_eq!(harness.scratch.removed.lock().unwrap().len(), 1);
	let lines = harness.log.lines();
	let released = lines
		.iter()
		.position(|line| {
			line.contains(r#""event":"job_released","runId":"run_test","state":"pending""#)
		})
		.expect("job_released");
	let abandoned = lines
		.iter()
		.position(|line| {
			line.contains(r#""event":"job_abandoned","runId":"run_test","reason":"shutdown""#)
		})
		.expect("job_abandoned");
	assert!(released < abandoned);
}

#[tokio::test]
async fn a_refused_release_is_logged_and_the_job_is_still_abandoned() {
	for (reply, expected) in [
		(
			api_failure("STALE_LEASE", false),
			r#""event":"release_failed","runId":"run_market","code":"STALE_LEASE""#,
		),
		(
			Ok(ReleaseJobResponse {
				state: ReleasedJobState::Cancelled,
			}),
			r#""event":"job_released","runId":"run_market","state":"cancelled""#,
		),
	] {
		let shutdown = CancellationToken::new();
		shutdown.cancel();
		let api = FakeApi::new(ApiScript {
			release: vec![reply],
			..ApiScript::default()
		});
		let harness = harness(Arc::clone(&api), Options::default());
		execute_job(market_job(&[], 20_000), Arc::clone(&harness.deps), shutdown).await;
		let calls = api.calls();
		assert!(calls.completions.is_empty(), "{expected}");
		assert_eq!(calls.releases.len(), 1, "{expected}");
		let lines = harness.log.lines();
		assert!(
			lines.iter().any(|line| line.contains(expected)),
			"{lines:?}"
		);
		assert!(
			lines.iter().any(|line| line
				.contains(r#""event":"job_abandoned","runId":"run_market","reason":"shutdown""#)),
			"{lines:?}"
		);
	}
}

#[tokio::test]
async fn shutdown_requested_before_the_job_starts_stops_it_immediately() {
	let shutdown = CancellationToken::new();
	shutdown.cancel();
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	execute_job(market_job(&[], 20_000), Arc::clone(&harness.deps), shutdown).await;
	let calls = api.calls();
	assert!(calls.completions.is_empty());
	assert_eq!(calls.releases.len(), 1);
	assert_eq!(calls.releases[0].lease_generation, 5);
	assert_eq!(harness.scratch.removed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn records_an_honest_failure_when_the_worker_rejects_the_submitted_result() {
	let api = FakeApi::new(ApiScript {
		complete: vec![api_failure("INTEGRITY_VIOLATION", false), Ok(completed())],
		..ApiScript::default()
	});
	let harness = harness(Arc::clone(&api), Options::default());
	run(research_job(), &harness).await;
	let calls = api.calls();
	assert_eq!(outcome_names(&calls), ["completed", "failed"]);
	match &calls.completions[1] {
		CompleteJobRequest::Failed {
			failure_code,
			retryable,
			..
		} => {
			assert_eq!(failure_code, "SUBMISSION_REJECTED_INTEGRITY_VIOLATION");
			assert!(!retryable);
		}
		other => panic!("{other:?}"),
	}
	assert!(harness.log.lines().iter().any(|line| line.contains(
		r#""event":"completion_rejected","runId":"run_test","code":"INTEGRITY_VIOLATION""#
	)));
}

#[tokio::test]
async fn does_not_resubmit_after_a_stale_lease_completion() {
	let api = FakeApi::new(ApiScript {
		complete: vec![api_failure("STALE_LEASE", false)],
		..ApiScript::default()
	});
	let harness = harness(Arc::clone(&api), Options::default());
	run(research_job(), &harness).await;
	assert_eq!(api.calls().completions.len(), 1);
}

#[tokio::test]
async fn reports_a_retryable_failure_if_the_runner_itself_faults_and_still_cleans_up() {
	let api = FakeApi::new(ApiScript::default());
	// The planning turn has already been paid for when the second prompt's fence source blows up.
	let harness = harness(
		Arc::clone(&api),
		Options {
			fence_panics_on_call: Some(2),
			..Options::default()
		},
	);
	run(research_job(), &harness).await;
	let calls = api.calls();
	assert_eq!(calls.completions.len(), 1);
	match &calls.completions[0] {
		CompleteJobRequest::Failed {
			failure_code,
			retryable,
			usage,
			..
		} => {
			assert!(failure_code.starts_with("RUNNER_ERROR_"), "{failure_code}");
			assert!(retryable);
			// Not zero: one model turn ran, and its cost on a plan-limited backend is unknown.
			assert_eq!(usage.agent_steps, 1);
			assert!(usage.has_unmetered_usage);
			assert!(usage.input_bytes > 0);
		}
		other => panic!("{other:?}"),
	}
	assert_eq!(harness.scratch.removed.lock().unwrap().len(), 1);
	let lines = harness.log.lines();
	assert!(lines.iter().any(|line| {
		line.contains(r#""level":"error","event":"job_crashed","runId":"run_test","error":"Panic""#)
	}));
	// The panic payload is never printed (SEC-010).
	assert!(lines.iter().all(|line| !line.contains("exploded")));
}

#[tokio::test]
async fn fails_without_retry_when_the_requested_backend_is_not_registered() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(
		research_job_with("codex", ZERO_USAGE, "[]", 20_000),
		&harness,
	)
	.await;
	match &api.calls().completions[..] {
		[
			CompleteJobRequest::Failed {
				failure_code,
				retryable,
				..
			},
		] => {
			assert_eq!(failure_code, "AGENT_NOT_REGISTERED");
			assert!(!retryable);
		}
		other => panic!("{other:?}"),
	}
	assert!(harness.agent.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unregistered_notebook_backend_fails_without_retry_too() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	let job: ClaimedJob = parse(&format!(
		r#"{{{},"workspaceId":"ws_test","agent":{{"agentId":"codex","model":null,"effort":"medium"}},"instruction":"Make it larger.","selectedWidgetIds":[],"notebook":{{"widgets":[]}},"notebookVersion":4,"conversationContext":[]}}"#,
		lease("notebook-assist", "run_notebook", 3, 20_000)
	))
	.unwrap();
	run(job, &harness).await;
	match &api.calls().completions[..] {
		[
			CompleteJobRequest::Failed {
				failure_code,
				retryable,
				..
			},
		] => {
			assert_eq!(failure_code, "AGENT_NOT_REGISTERED");
			assert!(!retryable);
		}
		other => panic!("{other:?}"),
	}
}

#[test]
fn forwards_the_tool_error_alongside_all_tool_calls_failed() {
	use research_application::research::PipelineOutcome;
	let completion = to_completion(
		3,
		PipelineOutcome::Failed {
			failure_code: "ALL_TOOL_CALLS_FAILED".to_owned(),
			failure_detail: Some("HTTP_ERROR".to_owned()),
			failure_upstream_status: Some(529),
			retryable: false,
			usage: EMPTY_USAGE,
		},
	);
	match completion {
		CompleteJobRequest::Failed {
			failure_code,
			failure_detail,
			failure_upstream_status,
			..
		} => {
			assert_eq!(failure_code, "ALL_TOOL_CALLS_FAILED");
			assert_eq!(failure_detail, Tri::Value("HTTP_ERROR".to_owned()));
			// The external service's status, unchanged (§4a).
			assert_eq!(failure_upstream_status, Tri::Value(529));
		}
		other => panic!("{other:?}"),
	}
	// No detail: the key is omitted on the wire.
	let bare = to_completion(
		3,
		PipelineOutcome::Failed {
			failure_code: "X".repeat(100),
			failure_detail: None,
			failure_upstream_status: None,
			retryable: true,
			usage: EMPTY_USAGE,
		},
	);
	let text = research_contracts::json::to_js_json(&bare).unwrap();
	assert!(!text.contains("failureDetail"));
	// No external answer: the key is omitted too, as the TypeScript spreads it.
	assert!(!text.contains("failureUpstreamStatus"));
	assert!(text.contains(&format!(r#""failureCode":"{}""#, "X".repeat(80))));
}

#[tokio::test]
async fn forwards_the_claimed_conversation_context_into_the_research_prompts() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(
		research_job_with(
			"scripted",
			ZERO_USAGE,
			r#"[{"role":"owner","text":"Focus on Japan."}]"#,
			20_000,
		),
		&harness,
	)
	.await;
	let requests = harness.agent.requests.lock().unwrap();
	assert!(requests[0].prompt.contains("Owner: Focus on Japan."));
	assert!(requests[1].prompt.contains("Owner: Focus on Japan."));
	assert!(!requests[2].prompt.contains("Owner: Focus on Japan."));
}

#[tokio::test]
async fn keeps_undelivered_events_queued_and_resends_them_with_the_same_sequence_numbers() {
	let api = FakeApi::new(ApiScript {
		events: vec![
			api_failure("TRANSPORT_ERROR", true),
			Ok(EventsResponse {
				cancel_requested: false,
			}),
		],
		..ApiScript::default()
	});
	let harness = harness(Arc::clone(&api), Options::default());
	run(research_job(), &harness).await;
	let calls = api.calls();
	let first = &calls.events[0].events;
	let second = &calls.events[1].events;
	assert_eq!(&second[..first.len()], &first[..]);
	let later = ApiCalls {
		events: calls.events[1..].to_vec(),
		..ApiCalls::default()
	};
	assert_eq!(state_sequence(&later), FULL_LIFECYCLE);
	assert_eq!(calls.completions.len(), 1);
	assert!(harness.log.lines().iter().any(|line| line.contains(
		r#""level":"warn","event":"events_not_delivered","runId":"run_test","code":"TRANSPORT_ERROR""#
	)));
}

/* ---------- news ingestion (FR-003) ---------- */

#[tokio::test]
async fn news_ingestion_walks_the_lifecycle_deduplicates_and_reports_per_source_results() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(
		Arc::clone(&api),
		Options {
			feeds: HashMap::from([(
				"https://news.example.org/feed.xml".to_owned(),
				"FEED:Battery orders rise@https://news.example.org/a/1?utm_source=rss|Battery orders rise@https://news.example.org/a/1|Chip fab opens@https://news.example.org/a/2|Internal@http://10.0.0.1/x".to_owned(),
			)]),
			..Options::default()
		},
	);
	run(ingest_job(), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	match &calls.completions[..] {
		[
			CompleteJobRequest::Ingested {
				articles,
				source_reports,
				..
			},
		] => {
			let urls: Vec<&str> = articles.iter().map(|a| a.canonical_url.as_str()).collect();
			assert_eq!(
				urls,
				[
					"https://news.example.org/a/1",
					"https://news.example.org/a/2"
				]
			);
			assert_eq!(articles[0].source_id, "src_news");
			assert_eq!(articles[0].publisher, "Example News");
			assert_eq!(articles[0].excerpt.as_deref(), Some("summary text"));
			assert_eq!(source_reports.len(), 1);
			assert_eq!(source_reports[0].source_id, "src_news");
			assert_eq!(source_reports[0].fetched_at, "2026-10-11T00:00:00.000Z");
			assert_eq!(source_reports[0].error_code, None);
		}
		other => panic!("{other:?}"),
	}
	assert!(harness.agent.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn news_ingestion_reports_a_failing_source_and_still_completes() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(ingest_job(), &harness).await;
	match &api.calls().completions[..] {
		[
			CompleteJobRequest::Ingested {
				articles,
				source_reports,
				..
			},
		] => {
			assert!(articles.is_empty());
			assert_eq!(source_reports[0].error_code.as_deref(), Some("TIMEOUT"));
		}
		other => panic!("{other:?}"),
	}
}

/* ---------- usage accounting (AGT-008) ---------- */

#[tokio::test]
async fn continues_from_the_usage_of_earlier_attempts_instead_of_starting_at_zero() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	let prior = r#"{"agentSteps":2,"toolCalls":3,"inputBytes":5000,"knownCostUsd":0,"hasUnmeteredUsage":true}"#;
	run(research_job_with("scripted", prior, "[]", 20_000), &harness).await;
	match &api.calls().completions[..] {
		[CompleteJobRequest::Completed { usage, .. }] => {
			// This attempt added three turns and one tool call on top of the earlier attempt.
			assert_eq!((usage.agent_steps, usage.tool_calls), (5, 4));
			assert!(usage.input_bytes > 5_000);
		}
		other => panic!("{other:?}"),
	}
}

/* ---------- job_finished ---------- */

fn field<'a>(fields: &'a [(&'static str, LogValue<'static>)], key: &str) -> &'a LogValue<'static> {
	&fields.iter().find(|(name, _)| *name == key).unwrap().1
}

fn text(value: &LogValue<'_>) -> Option<String> {
	match value {
		LogValue::Str(text) => Some(text.to_string()),
		_ => None,
	}
}

#[tokio::test]
async fn job_finished_carries_attempt_budget_usage_cost_verification_and_progress_counts() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(research_job(), &harness).await;
	let finished = harness
		.log
		.lines()
		.into_iter()
		.find(|line| line.contains(r#""event":"job_finished""#))
		.unwrap();
	for expected in [
		r#""runId":"run_test","state":"completed","attempt":1,"maxAttempts":3,"agentId":"scripted","providerModel":null,"promptVersion":"research-v5""#,
		r#""costKnown":false"#,
		r#""failureCode":null,"verificationStatus":"verified""#,
		r#""maxAgentSteps":6,"maxToolCalls":10,"maxWallClockMs":600000,"maxInputBytes":400000,"maxSpendUsd":null"#,
	] {
		assert!(finished.contains(expected), "{expected} in {finished}");
	}
	// The prompts, the question and the progress text never reach the log.
	assert!(!finished.contains("Which storage products"));
	assert!(!finished.contains("planning"));
}

#[test]
fn job_finished_logs_the_failure_code_with_no_verification_for_a_failed_run() {
	let completion = CompleteJobRequest::Failed {
		lease_generation: 3,
		usage: EMPTY_USAGE,
		failure_code: "NO_EVIDENCE_COLLECTED".to_owned(),
		failure_detail: Tri::Absent,
		failure_upstream_status: Tri::Absent,
		retryable: false,
	};
	let fields = run_finished_fields(
		&research_job(),
		&completion,
		"failed",
		ProgressCounts {
			state: 2,
			note: 1,
			tool: 0,
		},
	);
	assert_eq!(text(field(&fields, "state")).as_deref(), Some("failed"));
	assert_eq!(
		text(field(&fields, "failureCode")).as_deref(),
		Some("NO_EVIDENCE_COLLECTED")
	);
	assert_eq!(*field(&fields, "verificationStatus"), LogValue::Null);
	assert_eq!(*field(&fields, "providerModel"), LogValue::Null);
	assert_eq!(
		text(field(&fields, "promptVersion")).as_deref(),
		Some("research-v5")
	);
	assert_eq!(*field(&fields, "progressCount"), LogValue::Int(3));
	assert_eq!(*field(&fields, "progressStateCount"), LogValue::Int(2));
	assert_eq!(*field(&fields, "progressNoteCount"), LogValue::Int(1));
	assert_eq!(*field(&fields, "progressToolCount"), LogValue::Int(0));
	// The exact key order of the TypeScript.
	let keys: Vec<&str> = fields.iter().map(|(key, _)| *key).collect();
	assert_eq!(
		keys,
		[
			"runId",
			"state",
			"attempt",
			"maxAttempts",
			"agentId",
			"providerModel",
			"promptVersion",
			"agentSteps",
			"toolCalls",
			"inputBytes",
			"knownCostUsd",
			"hasUnmeteredUsage",
			"costKnown",
			"costUsd",
			"failureCode",
			"verificationStatus",
			"progressCount",
			"progressStateCount",
			"progressNoteCount",
			"progressToolCount",
			"maxAgentSteps",
			"maxToolCalls",
			"maxWallClockMs",
			"maxInputBytes",
			"maxSpendUsd"
		]
	);
}

#[test]
fn job_finished_omits_budget_fields_and_nulls_research_only_facts_for_a_news_ingest_job() {
	let completion = CompleteJobRequest::Ingested {
		lease_generation: 1,
		usage: EMPTY_USAGE,
		articles: vec![],
		source_reports: vec![],
	};
	let fields = run_finished_fields(
		&ingest_job(),
		&completion,
		"completed",
		ProgressCounts {
			state: 5,
			note: 0,
			tool: 0,
		},
	);
	assert_eq!(*field(&fields, "agentId"), LogValue::Null);
	assert_eq!(*field(&fields, "promptVersion"), LogValue::Null);
	assert_eq!(*field(&fields, "progressCount"), LogValue::Int(5));
	assert!(
		fields
			.iter()
			.all(|(key, _)| *key != "maxAgentSteps" && *key != "maxSpendUsd")
	);
}

/* ---------- heartbeat ---------- */

#[tokio::test]
async fn a_panicking_heartbeat_log_never_stops_the_job_or_the_heartbeat() {
	/// The writer behind the logger is down for heartbeat lines only.
	struct HeartbeatDown(RecordedLogger);
	impl EventLogger for HeartbeatDown {
		fn info(&self, event: &str, fields: &[(&str, LogValue<'_>)]) {
			self.0.logger().info(event, fields);
		}
		fn warn(&self, event: &str, fields: &[(&str, LogValue<'_>)]) {
			assert!(event != "heartbeat_failed", "log writer down");
			self.0.logger().warn(event, fields);
		}
		fn error(&self, event: &str, fields: &[(&str, LogValue<'_>)]) {
			self.0.logger().error(event, fields);
		}
		fn log_failures(&self) -> u64 {
			1
		}
	}
	let api = FakeApi::new(ApiScript {
		heartbeat: vec![api_failure("SERVER_BUSY", true)],
		..ApiScript::default()
	});
	let logger: Arc<dyn EventLogger> = Arc::new(HeartbeatDown(RecordedLogger::new()));
	let harness = harness(
		Arc::clone(&api),
		Options {
			first_turn_delay: Some(Duration::from_millis(250)),
			logger: Some(logger),
			..Options::default()
		},
	);
	run(
		research_job_with("scripted", ZERO_USAGE, "[]", 30),
		&harness,
	)
	.await;
	let calls = api.calls();
	assert!(!calls.heartbeats.is_empty());
	assert_eq!(outcome_names(&calls), ["completed"]);
}

#[tokio::test]
async fn a_panicking_heartbeat_request_is_logged_and_the_job_completes() {
	let api = Arc::new(FakeApi {
		script: Mutex::new(ApiScript::default()),
		calls: Mutex::new(ApiCalls::default()),
		heartbeat_delay: None,
		heartbeat_panics: true,
	});
	let harness = harness(
		Arc::clone(&api),
		Options {
			first_turn_delay: Some(Duration::from_millis(250)),
			..Options::default()
		},
	);
	run(
		research_job_with("scripted", ZERO_USAGE, "[]", 30),
		&harness,
	)
	.await;
	assert!(harness.log.lines().iter().any(|line| line.contains(
		r#""level":"warn","event":"heartbeat_failed","runId":"run_test","code":"HEARTBEAT_REQUEST_FAILED""#
	)));
	assert_eq!(outcome_names(&api.calls()), ["completed"]);
}

/// A slow source keeps a market-refresh job running 25 s of virtual time.
fn slow_market_harness(api: &Arc<FakeApi>) -> Harness {
	harness(
		Arc::clone(api),
		Options {
			market_delay: Some(Duration::from_secs(25)),
			..Options::default()
		},
	)
}

#[tokio::test(start_paused = true)]
async fn the_first_heartbeat_comes_after_one_interval_not_immediately() {
	let api = FakeApi::new(ApiScript::default());
	let harness = slow_market_harness(&api);
	let start = tokio::time::Instant::now();
	run(market_job(&["fred:DGS10"], 20_000), &harness).await;
	// One beat at 20 s of a 25 s job; none at time zero.
	assert_eq!(api.calls().heartbeats, [5]);
	assert_eq!(start.elapsed(), Duration::from_secs(25));
}

#[tokio::test(start_paused = true)]
async fn a_heartbeat_never_overlaps_the_previous_one() {
	let api = Arc::new(FakeApi {
		script: Mutex::new(ApiScript::default()),
		calls: Mutex::new(ApiCalls::default()),
		// Each beat takes 70 s, the job lasts 25 s past the first beat at 20 s... use a long job.
		heartbeat_delay: Some(Duration::from_secs(70)),
		heartbeat_panics: false,
	});
	let harness = harness(
		Arc::clone(&api),
		Options {
			market_delay: Some(Duration::from_secs(95)),
			..Options::default()
		},
	);
	run(market_job(&["fred:DGS10"], 20_000), &harness).await;
	// Beats start at 20 s and (the tick at 40, 60 and 80 s being skipped while one is in
	// flight) the next at 100 s, when the job ends: never two at once.
	assert_eq!(api.calls().heartbeats.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn no_heartbeat_is_sent_once_a_stop_reason_is_set() {
	let api = FakeApi::new(ApiScript {
		heartbeat: vec![Ok(beat(true))],
		..ApiScript::default()
	});
	let harness = slow_market_harness(&api);
	run(market_job(&["fred:DGS10"], 5_000), &harness).await;
	let calls = api.calls();
	// The first beat (5 s) asks to cancel; the later ticks do nothing.
	assert_eq!(calls.heartbeats.len(), 1);
	assert_eq!(outcome_names(&calls), ["cancelled"]);
}

/* ---------- shutdown cancels requests in flight (spec section 12.2) ---------- */

/// A harness whose API client talks to a server that never answers.
async fn hung_harness() -> (Harness, crate::test_support::FakeWorker) {
	let worker = crate::test_support::serve(vec![crate::test_support::Reply::Hang]).await;
	let base = harness(FakeApi::new(ApiScript::default()), Options::default());
	let mut deps = Arc::try_unwrap(base.deps).ok().unwrap();
	deps.api = Arc::new(
		crate::api_client::HttpRunnerApi::new(
			crate::api_client::HttpRunnerApiOptions::new(
				worker.url.clone(),
				format!("rk_{}", "a".repeat(64)),
				None,
				None,
			),
			Arc::new(TokioSleeper),
		)
		.unwrap(),
	);
	(
		Harness {
			deps: Arc::new(deps),
			..base
		},
		worker,
	)
}

#[tokio::test]
async fn shutdown_cancels_a_claim_in_flight() {
	let (harness, worker) = hung_harness().await;
	let shutdown = CancellationToken::new();
	let trigger = shutdown.clone();
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(150)).await;
		trigger.cancel();
	});
	let started = std::time::Instant::now();
	let exit = run_runner_loop(
		&LoopDeps {
			jobs: Arc::clone(&harness.deps),
			sleeper: Arc::new(TokioSleeper),
		},
		&shutdown,
	)
	.await;
	assert_eq!(exit, RunnerExit::Shutdown);
	assert!(
		started.elapsed() < Duration::from_secs(2),
		"{:?}",
		started.elapsed()
	);
	// One claim reached the hung server; none were sent after shutdown.
	assert_eq!(worker.requests().len(), 1);
}

#[tokio::test]
async fn shutdown_cancels_an_events_request_in_flight_and_completes_nothing() {
	let (harness, worker) = hung_harness().await;
	let shutdown = CancellationToken::new();
	let trigger = shutdown.clone();
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(150)).await;
		trigger.cancel();
	});
	let started = std::time::Instant::now();
	execute_job(market_job(&[], 20_000), Arc::clone(&harness.deps), shutdown).await;
	// The events request is cancelled at once; the only request sent after
	// shutdown is the lease hand-back (ADR-0036), which an unanswering
	// Worker gets 2 s for — still well inside the launcher's 8 s grace.
	let elapsed = started.elapsed();
	assert!(
		elapsed >= Duration::from_secs(2) && elapsed < Duration::from_secs(4),
		"{elapsed:?}"
	);
	let seen = worker.requests();
	assert_eq!(seen.len(), 2);
	assert!(seen[0].path.ends_with("/events"));
	assert!(seen[1].path.ends_with("/jobs/run_market/release"));
	assert!(harness.log.lines().iter().any(|line| {
		line.contains(r#""event":"release_failed","runId":"run_market","code":"TIMEOUT""#)
	}));
	assert_eq!(harness.scratch.removed.lock().unwrap().len(), 1);
}

/* ---------- event queue ---------- */

#[tokio::test]
async fn the_queue_drops_events_beyond_400_without_consuming_sequence_numbers() {
	use research_application::reporter::PipelineReporter;
	// Reach the reporter through a job whose events cannot be delivered.
	let api = FakeApi::new(ApiScript {
		events: vec![api_failure("TRANSPORT_ERROR", true)],
		..ApiScript::default()
	});
	let harness = harness(Arc::clone(&api), Options::default());
	// 450 notes: the first flush at 10 events fails, the queue keeps growing to its cap.
	let job = market_job(&[], 20_000);
	let core = crate::job_execution::test_core(&harness.deps, &job);
	for index in 0..450 {
		core.note(&format!("note {index}")).await;
	}
	let (queued, next_seq) = core.queue_snapshot().await;
	assert_eq!(queued, 400);
	assert_eq!(next_seq, 400);
}

#[tokio::test]
async fn notes_and_tool_events_are_truncated_in_utf16_units_at_a_char_boundary() {
	use research_application::reporter::{PipelineReporter, ToolCallOutcome};
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	let job = market_job(&[], 20_000);
	let core = crate::job_execution::test_core(&harness.deps, &job);
	// 499 ASCII units + one astral character = 501 units: the character does not fit.
	core.note(&format!("{}😀", "a".repeat(499))).await;
	core.tool("t", ToolCallOutcome::Failed, &"é".repeat(400))
		.await;
	core.state(JobState::Planning).await;
	let sent = api.calls().events;
	let events: Vec<_> = sent
		.iter()
		.flat_map(|request| request.events.iter())
		.collect();
	match &events[0].event {
		RunnerEventBody::Note { text } => assert_eq!(text.encode_utf16().count(), 499),
		other => panic!("{other:?}"),
	}
	match &events[1].event {
		RunnerEventBody::Tool { detail, .. } => assert_eq!(detail.encode_utf16().count(), 300),
		other => panic!("{other:?}"),
	}
}

#[tokio::test]
async fn an_empty_note_is_not_queued_because_the_worker_would_refuse_it_forever() {
	use research_application::reporter::PipelineReporter;
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	let job = market_job(&[], 20_000);
	let core = crate::job_execution::test_core(&harness.deps, &job);
	core.note("").await;
	assert_eq!(core.queue_snapshot().await, (0, 0));
	core.note("kept").await;
	core.state(JobState::Planning).await;
	let sent = api.calls().events;
	let notes: Vec<_> = sent
		.iter()
		.flat_map(|request| request.events.iter())
		.filter_map(|event| match &event.event {
			RunnerEventBody::Note { text } => Some(text.clone()),
			_ => None,
		})
		.collect();
	assert_eq!(notes, ["kept"]);
}

#[tokio::test]
async fn a_non_lifecycle_state_is_a_fault_not_an_event() {
	use research_application::reporter::PipelineReporter;
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	let job = market_job(&[], 20_000);
	let core = crate::job_execution::test_core(&harness.deps, &job);
	let outcome = tokio::spawn(async move { core.state(JobState::Completed).await }).await;
	assert!(outcome.unwrap_err().is_panic());
	assert!(api.calls().events.is_empty());
}

/* ---------- Google grant rule (FR-019) ---------- */

fn connected(usage: ResourceUsage) -> CompleteJobRequest {
	CompleteJobRequest::GoogleCalendarConnected {
		lease_generation: 2,
		usage,
		calendar_id: "cal_1".to_owned(),
	}
}

fn google_harness(api: &Arc<FakeApi>, auth_url_sends: usize) -> Harness {
	let google = Arc::new(FakeGoogle {
		outcome: Mutex::new(Some(connected(EMPTY_USAGE))),
		auth_url_sends,
		..FakeGoogle::default()
	});
	harness(
		Arc::clone(api),
		Options {
			google,
			..Options::default()
		},
	)
}

#[tokio::test]
async fn a_connected_grant_is_kept_when_the_api_completes_the_run() {
	let api = FakeApi::new(ApiScript::default());
	let harness = google_harness(&api, 0);
	run(google_job("connect"), &harness).await;
	assert_eq!(outcome_names(&api.calls()), ["google-calendar-connected"]);
	assert!(harness.google.discarded.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_connected_grant_is_given_back_when_the_completion_is_rejected_or_not_completed() {
	for script in [
		vec![api_failure("STALE_LEASE", false)],
		vec![Ok(CompleteJobResponse {
			state: JobState::Failed,
			replayed: false,
			new_article_count: 0,
		})],
	] {
		let api = FakeApi::new(ApiScript {
			complete: script,
			..ApiScript::default()
		});
		let harness = google_harness(&api, 0);
		run(google_job("connect"), &harness).await;
		assert_eq!(*harness.google.discarded.lock().unwrap(), ["run_google"]);
	}
}

#[tokio::test]
async fn a_connected_grant_is_given_back_when_the_lease_is_lost_or_the_run_is_cancelled() {
	// Lease lost while the sign-in URL is delivered.
	let api = FakeApi::new(ApiScript {
		events: vec![api_failure("STALE_LEASE", false)],
		..ApiScript::default()
	});
	let harness = google_harness(&api, 1);
	run(google_job("connect"), &harness).await;
	assert_eq!(*harness.google.discarded.lock().unwrap(), ["run_google"]);
	assert!(api.calls().completions.is_empty());

	// Cancelled by the owner: the completion becomes `cancelled` and the grant goes back.
	let api = FakeApi::new(ApiScript {
		events: vec![Ok(EventsResponse {
			cancel_requested: true,
		})],
		..ApiScript::default()
	});
	let harness = google_harness(&api, 1);
	run(google_job("connect"), &harness).await;
	assert_eq!(*harness.google.discarded.lock().unwrap(), ["run_google"]);
	assert_eq!(outcome_names(&api.calls()), ["cancelled"]);
}

#[tokio::test]
async fn the_sign_in_url_is_queued_once_and_reports_whether_the_queue_went_out() {
	let api = FakeApi::new(ApiScript {
		events: vec![
			api_failure("TRANSPORT_ERROR", true),
			Ok(EventsResponse {
				cancel_requested: false,
			}),
		],
		..ApiScript::default()
	});
	let harness = google_harness(&api, 2);
	run(google_job("connect"), &harness).await;
	// The first send fails (undelivered), the second re-sends the same queue.
	assert_eq!(*harness.google.delivered.lock().unwrap(), [false, true]);
	let urls = api
		.calls()
		.events
		.iter()
		.flat_map(|request| request.events.iter())
		.filter(|entry| matches!(entry.event, RunnerEventBody::GoogleAuthUrl { .. }))
		.count();
	assert_eq!(urls, 2, "one event sent twice, never queued twice");
	let sent = api.calls().events;
	assert_eq!(sent[0].events[0].seq, sent[1].events[0].seq);
}

/* ---------- market refresh through the shell ---------- */

#[tokio::test]
async fn a_market_refresh_with_an_unconfigured_provider_reports_source_not_configured() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(market_job(&["fred:DGS10"], 20_000), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	let text = research_contracts::json::to_js_json(&calls.completions[0]).unwrap();
	assert!(
		text.contains(r#""errorCode":"SOURCE_NOT_CONFIGURED""#),
		"{text}"
	);
}

/* ---------- golden outgoing payloads (shell-wire spec section 6, point 4) ---------- */

/// A source that always has data.
struct GoodSource;

#[async_trait]
impl MarketSeriesSource for GoodSource {
	fn provider_id(&self) -> research_contracts::market::MarketProviderId {
		research_contracts::market::MarketProviderId::Fred
	}
	async fn fetch_series(&self, _query: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		Ok(SeriesData {
			meta: parse(
				r#"{"title":"10-Year Treasury","unit":"percent","frequency":"daily","publisher":"FRED","sourceUrl":"https://fred.stlouisfed.org/series/DGS10"}"#,
			)
			.unwrap(),
			observations: vec![
				research_finance::ports::SeriesPoint {
					observed_on: "2026-10-08".to_owned(),
					value: 4.12,
				},
				research_finance::ports::SeriesPoint {
					observed_on: "2026-10-09".to_owned(),
					value: 4.1,
				},
			],
		})
	}
}

/// US stocks: the first has a date, the second only a name.
struct FakeEarnings;

#[async_trait]
impl research_finance::ports::EarningsCalendarSource for FakeEarnings {
	fn source_id(&self) -> research_contracts::watchlist::EarningsSourceId {
		research_contracts::watchlist::EarningsSourceId::Finnhub
	}
	async fn fetch_earnings(
		&self,
		query: research_finance::ports::EarningsQuery<'_>,
	) -> Vec<research_finance::ports::EarningsResult> {
		query
			.stocks
			.iter()
			.enumerate()
			.map(|(index, _)| {
				if index == 0 {
					Ok(research_finance::ports::EarningsData {
						name: Some("Example Corp".to_owned()),
						events: vec![
							parse(
								r#"{"periodKey":"2026-q4","announcementDate":"2026-10-28","fiscalPeriodLabel":"Q4 2026","fiscalPeriodEnd":"2026-09-30","timing":"after-close"}"#,
							)
							.unwrap(),
						],
					})
				} else {
					Err(research_finance::ports::EarningsFailure::no_date(Some(
						"Other Corp".to_owned(),
					)))
				}
			})
			.collect()
	}
}

/// One golden file: the schema that must accept it and the exact wire text.
struct Golden {
	name: String,
	schema: &'static str,
	body: String,
}

fn wire<T: serde::Serialize>(value: &T) -> String {
	research_contracts::json::to_js_json(value).unwrap()
}

fn golden_dir() -> std::path::PathBuf {
	std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vectors/runner/out")
}

/// Tab-indented JSON, like the files the TypeScript exporters write.
fn golden_file_text(golden: &Golden) -> String {
	use serde::Serialize;
	let value = serde_json::json!({ "schema": golden.schema, "body": golden.body });
	let mut buffer = Vec::new();
	let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
	let mut serializer = serde_json::Serializer::with_formatter(&mut buffer, formatter);
	value.serialize(&mut serializer).unwrap();
	let mut text = String::from_utf8(buffer).unwrap();
	text.push('\n');
	text
}

fn first_completion(api: &FakeApi) -> CompleteJobRequest {
	api.calls().completions.remove(0)
}

fn outcome_of(completion: &CompleteJobRequest) -> &'static str {
	// The serde tag is the wire name of the outcome.
	let value: serde_json::Value = serde_json::from_str(&wire(completion)).unwrap();
	let name = value["outcome"].as_str().unwrap().to_owned();
	Box::leak(name.into_boxed_str())
}

fn collect_events(api: &FakeApi, prefix: &str, into: &mut Vec<Golden>) {
	for (index, request) in api.calls().events.iter().enumerate() {
		into.push(Golden {
			name: format!("events-{prefix}-{index}"),
			schema: "runnerEventsRequest",
			body: wire(request),
		});
	}
}

fn notebook_job() -> ClaimedJob {
	let widget = r#"{"widgetId":"w-text","title":"Title w-text","size":"medium","createdAt":"2026-10-11T00:00:00.000Z","updatedAt":"2026-10-11T00:00:00.000Z","revision":1,"origin":{"kind":"owner","messageId":null,"runId":null,"componentId":null},"type":"text","text":"Body of w-text."}"#;
	parse(&format!(
		r#"{{{},"workspaceId":"ws_test","agent":{{"agentId":"scripted","model":null,"effort":"medium"}},"instruction":"Make it larger.","selectedWidgetIds":["w-text"],"notebook":{{"widgets":[{widget}]}},"notebookVersion":4,"conversationContext":[]}}"#,
		lease("notebook-assist", "run_notebook", 3, 20_000)
	))
	.unwrap()
}

fn earnings_job() -> ClaimedJob {
	parse(&format!(
		r#"{{{},"fromDate":"2026-10-11","toDate":"2027-04-14","stocks":[{{"stockId":"us:AAPL","name":null}},{{"stockId":"us:MSFT","name":"Microsoft"}}]}}"#,
		lease("earnings-refresh", "run_earnings", 4, 20_000)
	))
	.unwrap()
}

/// Every payload the runner sends is produced by the real producers, written to
/// `vectors/runner/out/` and parsed by `tests/contracts/runnerOut.test.ts`
/// with the zod schemas. The files are compared on every run; set
/// `UPDATE_VECTORS=1` to rewrite them.
#[tokio::test]
async fn golden_outgoing_payloads_are_current() {
	let mut out: Vec<Golden> = Vec::new();

	/* claim requests */
	let descriptors: Vec<research_contracts::agent::AgentDescriptor> =
		parse::<research_contracts::agent::AgentCapabilities>(r#"{"supported":["stream"]}"#)
			.map(|capabilities| {
				let descriptor = |id: &str, availability: AgentAvailability| {
					research_contracts::agent::AgentDescriptor {
						agent_id: id.to_owned(),
						display_name: format!("Backend {id}"),
						capabilities: capabilities.clone(),
						cost_model: CostModel::Metered,
						tool_isolation: ToolIsolation::Unverified,
						availability,
					}
				};
				let mut listed = descriptor("opencode", AgentAvailability::Available);
				listed.capabilities.model = Some("provider/model-a".to_owned());
				listed.capabilities.models = Some(vec![
					"provider/model-a".to_owned(),
					"other/model-b".to_owned(),
				]);
				listed.cost_model = CostModel::PlanLimited;
				listed.tool_isolation = ToolIsolation::Enforced;
				let mut backends = vec![listed];
				use research_contracts::agent::UnavailableReason as Reason;
				for (id, reason) in [
					("codex", Reason::NotInstalled),
					("claude-code", Reason::NotAuthenticated),
					("openrouter", Reason::NotConfigured),
					("custom-one", Reason::UnsupportedVersion),
					("custom-two", Reason::ToolIsolationUnverified),
					("custom-three", Reason::ProbeFailed),
				] {
					backends.push(descriptor(
						id,
						AgentAvailability::Unavailable {
							reason_code: reason,
							detail: "The CLI could not be started.".to_owned(),
						},
					));
				}
				backends
			})
			.unwrap();
	out.push(Golden {
		name: "claim-request-no-agents".to_owned(),
		schema: "claimJobRequest",
		body: wire(&research_contracts::jobs::ClaimJobRequest {
			runner_version: "0.1.0".to_owned(),
			agents: vec![],
		}),
	});
	out.push(Golden {
		name: "claim-request-agents".to_owned(),
		schema: "claimJobRequest",
		body: wire(&research_contracts::jobs::ClaimJobRequest {
			runner_version: "0.1.0".to_owned(),
			agents: descriptors,
		}),
	});
	out.push(Golden {
		name: "heartbeat-request".to_owned(),
		schema: "heartbeatRequest",
		body: wire(&crate::api_client::heartbeat_request(3)),
	});
	out.push(Golden {
		name: "release-request".to_owned(),
		schema: "releaseJobRequest",
		body: wire(&ReleaseJobRequest {
			lease_generation: 3,
			usage: ResourceUsage {
				agent_steps: 2,
				tool_calls: 1,
				input_bytes: 4_096,
				known_cost_usd: 0.25,
				has_unmetered_usage: true,
			},
		}),
	});

	/* a completed research run: events and the completion */
	let api = FakeApi::new(ApiScript::default());
	let research = harness(Arc::clone(&api), Options::default());
	run(research_job(), &research).await;
	collect_events(&api, "research", &mut out);
	let completed = first_completion(&api);
	let CompleteJobRequest::Completed { bundle, usage, .. } = &completed else {
		panic!("expected a completed run: {completed:?}");
	};
	let (bundle, usage) = (bundle.clone(), *usage);
	out.push(Golden {
		name: "complete-completed".to_owned(),
		schema: "completeJobRequest",
		body: wire(&completed),
	});
	out.push(Golden {
		name: "complete-partial".to_owned(),
		schema: "completeJobRequest",
		body: wire(&CompleteJobRequest::Partial {
			lease_generation: 3,
			usage,
			failure_code: "BUDGET_EXCEEDED".to_owned(),
			failure_upstream_status: Tri::Absent,
			bundle,
			articles: vec![],
			source_reports: vec![],
		}),
	});

	/* failures */
	let api = FakeApi::new(ApiScript::default());
	let unregistered = harness(Arc::clone(&api), Options::default());
	run(
		research_job_with("codex", ZERO_USAGE, "[]", 20_000),
		&unregistered,
	)
	.await;
	out.push(Golden {
		name: "complete-failed".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});
	out.push(Golden {
		name: "complete-failed-with-detail".to_owned(),
		schema: "completeJobRequest",
		body: wire(&to_completion(
			3,
			research_application::research::PipelineOutcome::Failed {
				failure_code: "ALL_TOOL_CALLS_FAILED".to_owned(),
				failure_detail: Some("TIMEOUT".to_owned()),
				failure_upstream_status: None,
				retryable: false,
				usage,
			},
		)),
	});
	out.push(Golden {
		name: "complete-waiting-approval".to_owned(),
		schema: "completeJobRequest",
		body: wire(&to_completion(
			3,
			research_application::research::PipelineOutcome::WaitingApproval {
				approval_request: research_contracts::jobs::ApprovalRequest {
					reason_code: "SPEND_CONSENT_REQUIRED".to_owned(),
					detail: "The next step needs your approval.".to_owned(),
				},
				usage,
			},
		)),
	});

	/* a run cancelled by the owner (through the events answer) */
	let api = FakeApi::new(ApiScript {
		events: vec![Ok(EventsResponse {
			cancel_requested: true,
		})],
		..ApiScript::default()
	});
	let cancelled = harness(Arc::clone(&api), Options::default());
	run(research_job(), &cancelled).await;
	out.push(Golden {
		name: "complete-cancelled".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});

	/* news ingest */
	let api = FakeApi::new(ApiScript::default());
	let ingest = harness(
		Arc::clone(&api),
		Options {
			feeds: HashMap::from([(
				"https://news.example.org/feed.xml".to_owned(),
				"FEED:Battery orders rise@https://news.example.org/a/1|Chip fab opens@https://news.example.org/a/2".to_owned(),
			)]),
			..Options::default()
		},
	);
	run(ingest_job(), &ingest).await;
	collect_events(&api, "ingest", &mut out);
	out.push(Golden {
		name: "complete-ingested".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});

	/* market refresh: a failed series and a successful one */
	let api = FakeApi::new(ApiScript::default());
	let market = harness(
		Arc::clone(&api),
		Options {
			market_source: Some(Arc::new(GoodSource)),
			..Options::default()
		},
	);
	run(
		market_job(&["fred:DGS10", "twelve-data:XAU/USD"], 20_000),
		&market,
	)
	.await;
	out.push(Golden {
		name: "complete-market-refreshed".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});

	/* earnings refresh */
	let api = FakeApi::new(ApiScript::default());
	let earnings = harness(
		Arc::clone(&api),
		Options {
			earnings_source: Some(Arc::new(FakeEarnings)),
			..Options::default()
		},
	);
	run(earnings_job(), &earnings).await;
	out.push(Golden {
		name: "complete-earnings-refreshed".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});

	/* stock-directory refresh (ADR-0034): a JP list at the floor */
	let api = FakeApi::new(ApiScript::default());
	let directory = harness(
		Arc::clone(&api),
		Options {
			directory_sources: vec![(
				research_contracts::watchlist::WatchMarket::Jp,
				Arc::new(FakeDirectory::answering(Ok(jp_directory(1_000)))),
			)],
			..Options::default()
		},
	);
	run(directory_job("JP"), &directory).await;
	out.push(Golden {
		name: "complete-stock-directory-refreshed".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});

	/* notebook assistant */
	let api = FakeApi::new(ApiScript::default());
	let notebook = harness(
		Arc::clone(&api),
		Options {
			replies: vec![
				r#"{"reply":"Made it larger.","commands":[{"kind":"resize","widgetId":"w-text","size":"large"}]}"#
					.to_owned(),
			],
			..Options::default()
		},
	);
	run(notebook_job(), &notebook).await;
	out.push(Golden {
		name: "complete-notebook-assisted".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});

	/* Google Calendar: the sign-in URL event and the three completions */
	let api = FakeApi::new(ApiScript::default());
	let google = google_harness(&api, 1);
	run(google_job("connect"), &google).await;
	collect_events(&api, "google-connect", &mut out);
	out.push(Golden {
		name: "complete-google-calendar-connected".to_owned(),
		schema: "completeJobRequest",
		body: wire(&first_completion(&api)),
	});
	out.push(Golden {
		name: "complete-google-calendar-synced".to_owned(),
		schema: "completeJobRequest",
		body: wire(&CompleteJobRequest::GoogleCalendarSynced {
			lease_generation: 2,
			usage: EMPTY_USAGE,
			calendar_id: "cal_1".to_owned(),
			desired_digest: "a".repeat(64),
			inserted: 3,
			updated: 1,
			deleted: 0,
			unchanged: 7,
		}),
	});
	out.push(Golden {
		name: "complete-google-calendar-disconnected".to_owned(),
		schema: "completeJobRequest",
		body: wire(&CompleteJobRequest::GoogleCalendarDisconnected {
			lease_generation: 2,
			usage: EMPTY_USAGE,
			revoked: true,
		}),
	});

	/* long text is cut at the limit before it is sent */
	let api = FakeApi::new(ApiScript::default());
	let chatty = harness(Arc::clone(&api), Options::default());
	let job = market_job(&[], 20_000);
	let reporter = crate::job_execution::test_core(&chatty.deps, &job);
	{
		use research_application::reporter::{PipelineReporter, ToolCallOutcome};
		reporter.state(JobState::Planning).await;
		reporter.note(&"n".repeat(900)).await;
		reporter
			.tool("web.search", ToolCallOutcome::Denied, &"d".repeat(900))
			.await;
		reporter
			.tool("news.fetch_feed", ToolCallOutcome::Executed, "3 articles")
			.await;
		reporter
			.tool("web.fetch_page", ToolCallOutcome::Failed, "TIMEOUT")
			.await;
		reporter.usage(&usage).await;
		reporter.state(JobState::Publishing).await;
	}
	collect_events(&api, "reporter", &mut out);

	/* what was produced covers every outcome and every event type */
	let outcomes: std::collections::BTreeSet<&str> = out
		.iter()
		.filter(|golden| golden.schema == "completeJobRequest")
		.map(|golden| {
			let value: serde_json::Value = serde_json::from_str(&golden.body).unwrap();
			&*Box::leak(
				value["outcome"]
					.as_str()
					.unwrap()
					.to_owned()
					.into_boxed_str(),
			)
		})
		.collect();
	assert_eq!(outcomes.len(), 13, "{outcomes:?}");
	let event_types: std::collections::BTreeSet<String> = out
		.iter()
		.filter(|golden| golden.schema == "runnerEventsRequest")
		.flat_map(|golden| {
			let value: serde_json::Value = serde_json::from_str(&golden.body).unwrap();
			value["events"]
				.as_array()
				.unwrap()
				.iter()
				.map(|event| event["event"]["type"].as_str().unwrap().to_owned())
				.collect::<Vec<_>>()
		})
		.collect();
	assert_eq!(
		event_types.iter().map(String::as_str).collect::<Vec<_>>(),
		["google-auth-url", "note", "state", "tool", "usage"]
	);
	let _ = outcome_of;

	/* compare with (or rewrite) the committed files */
	let names: std::collections::BTreeSet<&str> =
		out.iter().map(|golden| golden.name.as_str()).collect();
	assert_eq!(names.len(), out.len(), "duplicate golden names");
	let directory = golden_dir();
	if std::env::var_os("UPDATE_VECTORS").is_some() {
		std::fs::create_dir_all(&directory).unwrap();
		for entry in std::fs::read_dir(&directory).unwrap() {
			std::fs::remove_file(entry.unwrap().path()).unwrap();
		}
		for golden in &out {
			std::fs::write(
				directory.join(format!("{}.json", golden.name)),
				golden_file_text(golden),
			)
			.unwrap();
		}
		return;
	}
	let mut on_disk: Vec<String> = std::fs::read_dir(&directory)
		.expect("vectors/runner/out is missing: run with UPDATE_VECTORS=1")
		.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
		.collect();
	on_disk.sort();
	let mut expected: Vec<String> = out
		.iter()
		.map(|golden| format!("{}.json", golden.name))
		.collect();
	expected.sort();
	assert_eq!(
		on_disk, expected,
		"stale golden files: run with UPDATE_VECTORS=1"
	);
	for golden in &out {
		let path = directory.join(format!("{}.json", golden.name));
		assert_eq!(
			std::fs::read_to_string(&path).unwrap(),
			golden_file_text(golden),
			"{} is stale: run the runner tests with UPDATE_VECTORS=1",
			golden.name
		);
	}
}

/* ---------- stock-directory refresh (stockDirectoryRefresh.test.ts) ---------- */

use research_contracts::stock_directory::{
	StockDirectoryEntry, StockDirectoryFailureCode, StockListing,
};
use research_finance::ports::{
	StockDirectoryData, StockDirectoryFailure, StockDirectoryQuery, StockDirectorySource,
};

/// A source that answers once (or panics) and records its pacing grants.
struct FakeDirectory {
	answer: Option<Result<StockDirectoryData, StockDirectoryFailure>>,
	grants: Mutex<Vec<bool>>,
}

impl FakeDirectory {
	fn answering(answer: Result<StockDirectoryData, StockDirectoryFailure>) -> Self {
		Self {
			answer: Some(answer),
			grants: Mutex::new(Vec::new()),
		}
	}
	fn panicking() -> Self {
		Self {
			answer: None,
			grants: Mutex::new(Vec::new()),
		}
	}
}

#[async_trait]
impl StockDirectorySource for FakeDirectory {
	fn market(&self) -> research_contracts::watchlist::WatchMarket {
		research_contracts::watchlist::WatchMarket::Jp
	}
	async fn fetch_directory(
		&self,
		query: StockDirectoryQuery<'_>,
	) -> Result<StockDirectoryData, StockDirectoryFailure> {
		let granted = query.before_request.before_request().await;
		self.grants.lock().unwrap().push(granted);
		let Some(answer) = &self.answer else {
			panic!("the directory source exploded");
		};
		answer.clone()
	}
}

fn jp_directory(count: usize) -> StockDirectoryData {
	StockDirectoryData {
		as_of: Some("2026-09-30".to_owned()),
		entries: (0..count)
			.map(|index| StockDirectoryEntry {
				symbol: (1000 + index).to_string(),
				name: format!("Issue {index}"),
				local_name: Some(format!("銘柄{index}")),
				listing: StockListing::TsePrime,
			})
			.collect(),
	}
}

fn directory_job(market: &str) -> ClaimedJob {
	parse(&format!(
		r#"{{{},"market":"{market}"}}"#,
		lease("stock-directory-refresh", "run_directory", 6, 20_000)
	))
	.unwrap()
}

fn directory_harness(api: &Arc<FakeApi>, source: FakeDirectory) -> (Harness, Arc<FakeDirectory>) {
	let source = Arc::new(source);
	let harness = harness(
		Arc::clone(api),
		Options {
			directory_sources: vec![(
				research_contracts::watchlist::WatchMarket::Jp,
				Arc::clone(&source) as Arc<dyn StockDirectorySource>,
			)],
			..Options::default()
		},
	);
	(harness, source)
}

fn failure_of(calls: &ApiCalls) -> (String, bool) {
	match calls.completions.first() {
		Some(CompleteJobRequest::Failed {
			failure_code,
			retryable,
			failure_detail: Tri::Absent,
			..
		}) => (failure_code.clone(), *retryable),
		other => panic!("expected a failed completion, got {other:?}"),
	}
}

#[tokio::test]
async fn a_directory_refresh_completes_with_the_markets_list() {
	let api = FakeApi::new(ApiScript::default());
	let (harness, source) =
		directory_harness(&api, FakeDirectory::answering(Ok(jp_directory(1_000))));
	run(directory_job("JP"), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	let Some(CompleteJobRequest::StockDirectoryRefreshed {
		lease_generation,
		market,
		as_of,
		entries,
		..
	}) = calls.completions.first()
	else {
		panic!("expected a stock-directory completion");
	};
	assert_eq!(*lease_generation, 6);
	assert_eq!(*market, research_contracts::watchlist::WatchMarket::Jp);
	assert_eq!(as_of.as_deref(), Some("2026-09-30"));
	assert_eq!(entries.len(), 1_000);
	assert_eq!(*source.grants.lock().unwrap(), [true]);
	assert!(
		harness
			.log
			.events()
			.contains(&"stock_directory_fetched".to_owned())
	);
}

#[tokio::test]
async fn a_market_without_a_source_fails_as_not_configured() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(directory_job("US"), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	assert_eq!(
		failure_of(&calls),
		("DIRECTORY_NOT_CONFIGURED".to_owned(), false)
	);
}

#[tokio::test]
async fn a_directory_failure_keeps_its_code_and_only_a_source_failure_is_retried() {
	for (code, upstream_status, retryable) in [
		(StockDirectoryFailureCode::SourceFailed, Some(503), true),
		(StockDirectoryFailureCode::RateLimited, Some(429), false),
		(StockDirectoryFailureCode::ParseFailed, None, false),
		(StockDirectoryFailureCode::NotConfigured, None, false),
	] {
		let api = FakeApi::new(ApiScript::default());
		let failure = StockDirectoryFailure {
			code,
			upstream_status,
		};
		let (harness, _) = directory_harness(&api, FakeDirectory::answering(Err(failure)));
		run(directory_job("JP"), &harness).await;
		let calls = api.calls();
		assert_eq!(failure_of(&calls), (code.as_str().to_owned(), retryable));
		// SEC's or JPX's own status, unchanged; no key without one (§4a).
		let Some(CompleteJobRequest::Failed {
			failure_upstream_status,
			..
		}) = calls.completions.first()
		else {
			panic!("expected a failed completion");
		};
		assert_eq!(
			*failure_upstream_status,
			upstream_status.map_or(Tri::Absent, Tri::Value)
		);
	}
}

#[tokio::test]
async fn a_list_the_contract_would_refuse_fails_as_parse_failed() {
	let mut duplicate = jp_directory(1_000);
	duplicate.entries.push(duplicate.entries[0].clone());
	let mut us_on_jp = jp_directory(1_000);
	us_on_jp.entries[0].listing = StockListing::Nyse;
	let mut blank = jp_directory(1_000);
	blank.entries[0].name = "   ".to_owned();
	let mut bad_date = jp_directory(1_000);
	bad_date.as_of = Some("2026-02-30".to_owned());
	for data in [jp_directory(999), duplicate, us_on_jp, blank, bad_date] {
		let api = FakeApi::new(ApiScript::default());
		let (harness, _) = directory_harness(&api, FakeDirectory::answering(Ok(data)));
		run(directory_job("JP"), &harness).await;
		assert_eq!(
			failure_of(&api.calls()),
			("DIRECTORY_PARSE_FAILED".to_owned(), false)
		);
		assert!(
			harness
				.log
				.events()
				.contains(&"stock_directory_rejected".to_owned())
		);
	}
}

#[tokio::test]
async fn a_panicking_directory_source_fails_retryably_and_is_logged_by_class() {
	let api = FakeApi::new(ApiScript::default());
	let (harness, _) = directory_harness(&api, FakeDirectory::panicking());
	run(directory_job("JP"), &harness).await;
	assert_eq!(
		failure_of(&api.calls()),
		("DIRECTORY_SOURCE_FAILED".to_owned(), true)
	);
	let lines = harness.log.lines();
	let failed: Vec<_> = lines
		.iter()
		.filter(|line| line.contains("stock_directory_source_failed"))
		.collect();
	assert_eq!(failed.len(), 1);
	assert!(failed[0].contains(r#""market":"JP""#) && failed[0].contains(r#""error":"Error""#));
	assert!(lines.iter().all(|line| !line.contains("exploded")));
}
