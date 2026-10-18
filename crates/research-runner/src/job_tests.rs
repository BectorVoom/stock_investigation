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
	EventsResponse, GoogleCalendarJob, HeartbeatResponse, ResourceUsage, RunnerEventBody,
	RunnerEventsRequest,
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
}

#[derive(Default, Clone)]
struct ApiCalls {
	claim: usize,
	heartbeats: Vec<u64>,
	events: Vec<RunnerEventsRequest>,
	completions: Vec<CompleteJobRequest>,
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
				Err(SafeFetchError {
					code: SafeFetchErrorCode::Timeout,
					detail: "test".to_owned(),
					body: None,
				})
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
			let delivered = sender
				.send_auth_url("https://accounts.google.com/o/oauth2/v2/auth?x=1")
				.await;
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
		earnings_sources: HashMap::new(),
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
		claim: vec![idle(15_000)],
		..ApiScript::default()
	});
	let (exit, sleeps, harness) = run_loop(&api, 3).await;
	assert_eq!(exit, RunnerExit::Shutdown);
	assert_eq!(sleeps, [15_000, 15_000, 15_000]);
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
	assert!(api.calls().completions.is_empty());
	assert_eq!(harness.scratch.removed.lock().unwrap().len(), 1);
	assert!(harness.log.lines().iter().any(|line| {
		line.contains(r#""event":"job_abandoned","runId":"run_test","reason":"shutdown""#)
	}));
}

#[tokio::test]
async fn shutdown_requested_before_the_job_starts_stops_it_immediately() {
	let shutdown = CancellationToken::new();
	shutdown.cancel();
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	execute_job(market_job(&[], 20_000), Arc::clone(&harness.deps), shutdown).await;
	assert!(api.calls().completions.is_empty());
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
			failure_detail: Some("TIMEOUT".to_owned()),
			retryable: false,
			usage: EMPTY_USAGE,
		},
	);
	match completion {
		CompleteJobRequest::Failed {
			failure_code,
			failure_detail,
			..
		} => {
			assert_eq!(failure_code, "ALL_TOOL_CALLS_FAILED");
			assert_eq!(failure_detail, Tri::Value("TIMEOUT".to_owned()));
		}
		other => panic!("{other:?}"),
	}
	// No detail: the key is omitted on the wire.
	let bare = to_completion(
		3,
		PipelineOutcome::Failed {
			failure_code: "X".repeat(100),
			failure_detail: None,
			retryable: true,
			usage: EMPTY_USAGE,
		},
	);
	let text = research_contracts::json::to_js_json(&bare).unwrap();
	assert!(!text.contains("failureDetail"));
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
