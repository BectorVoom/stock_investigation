//! Runs one claimed job to completion under its lease (port of
//! `apps/runner/src/jobExecution.ts`, shell-wire spec section 4).
//!
//! Recovery model (AGT-011): the runner holds no durable state. If this
//! process dies at any point, nothing is completed; the lease expires and the
//! Worker hands the job to the next claim under a new generation. If the lease
//! is lost while work continues, the runner stops and submits nothing — and
//! anything it did submit would be rejected by generation fencing anyway.

use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::FutureExt;
use research_agent_core::authorize::ToolRegistry;
use research_agent_core::registry::AgentRegistry;
use research_application::ingest::{IngestDeps, IngestOptions, ingest_sources};
use research_application::notebook::{
	NotebookAssistTurnDeps, NotebookAssistTurnInput, NotebookAssistTurnOutcome,
	run_notebook_assist_turn,
};
use research_application::ports::Clock;
use research_application::reporter::{PipelineReporter, ToolCallOutcome};
use research_application::research::prompts::PROMPT_VERSION;
use research_application::research::{
	PipelineOutcome, ResearchPipelineDeps, ResearchPipelineInput, run_research_pipeline,
};
use research_contracts::jobs::{ClaimedJob, EarningsRefreshJob, MarketRefreshJob};
use research_contracts::jobs::{
	CompleteJobRequest, EMPTY_USAGE, LeasedJobState, RunnerEvent, RunnerEventBody,
	RunnerEventsRequest, ToolOutcome, bundle_limits,
};
use research_contracts::{Tri, jobs::ResourceUsage};
use research_domain::jobs::state_machine::JobState;
use research_effects::{EventLogger, LogValue};
use research_finance::jobs::{RefreshDeps, execute_earnings_refresh, execute_market_refresh};
use research_finance::pacing::MarketPacer;
use research_finance::ports::{EarningsCalendarSource, MarketSeriesSource};
use research_google::jobs::GoogleAuthUrlSender;
use research_js::utf16::cut_code_points;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::api_client::RunnerApi;
use crate::exit_codes::fault_names;
use crate::google_sync::GoogleCalendarPort;
use crate::scratch::ScratchDirectories;

/// Lease-lost codes: the Worker no longer recognises this lease.
const LEASE_LOST_CODES: [&str; 3] = ["STALE_LEASE", "NOT_FOUND", "UNAUTHENTICATED"];
/// The Worker refused the result itself.
const REJECTED_SUBMISSION_CODES: [&str; 4] = [
	"INTEGRITY_VIOLATION",
	"VALIDATION_FAILED",
	"ILLEGAL_TRANSITION",
	"PAYLOAD_TOO_LARGE",
];
/// Notes and tool events flush once this many events are queued.
const NOTE_FLUSH_THRESHOLD: usize = 10;
/// Events beyond this many queued are dropped (no sequence number consumed).
const MAX_QUEUED_EVENTS: usize = 400;
/// `MAX_JOB_ATTEMPTS` of `packages/application/src/researchRuns.ts`.
const MAX_JOB_ATTEMPTS: u64 = 3;
/// Events per request (`MAX_RUNNER_EVENTS_PER_REQUEST`).
const MAX_EVENTS_PER_REQUEST: usize = research_contracts::jobs::MAX_RUNNER_EVENTS_PER_REQUEST;
const NOTE_MAX_UNITS: usize = 500;
const TOOL_DETAIL_MAX_UNITS: usize = 300;
const FAILURE_CODE_MAX_UNITS: usize = 80;

/// Everything a job needs, composed once in `main` (ARCH-002: effects injected).
pub struct JobDeps {
	/// The Worker.
	pub api: Arc<dyn RunnerApi>,
	/// Agent backends.
	pub agents: Arc<AgentRegistry>,
	/// Research tools.
	pub tools: ToolRegistry,
	/// Feed fetching for news-ingest jobs.
	pub ingest: IngestDeps,
	/// Wall clock.
	pub clock: Arc<dyn Clock>,
	/// Logger.
	pub logger: Arc<dyn EventLogger>,
	/// Per-job scratch directories.
	pub scratch: Arc<dyn ScratchDirectories>,
	/// A fresh, unguessable fence token for every prompt.
	pub new_fence_token: Arc<dyn Fn() -> String + Send + Sync>,
	/// Owner opt-in to backends whose isolation could not be verified.
	pub allow_unverified_tool_isolation: bool,
	/// Market providers keyed by id; an entry is absent until its key is configured.
	pub market_sources: HashMap<String, Arc<dyn MarketSeriesSource>>,
	/// Earnings sources keyed by id.
	pub earnings_sources: HashMap<String, Arc<dyn EarningsCalendarSource>>,
	/// Per-provider request pacing (API-007), shared across jobs.
	pub pacer: Arc<dyn MarketPacer>,
	/// Google Calendar sync (FR-019).
	pub google: Arc<dyn GoogleCalendarPort>,
}

/// Why work on a job stopped before it finished on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
	Cancelled,
	LeaseLost,
	Shutdown,
}

impl StopReason {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Cancelled => "cancelled",
			Self::LeaseLost => "lease-lost",
			Self::Shutdown => "shutdown",
		}
	}
}

/// The first stop reason wins; every stop cancels the job's token.
struct StopSignal {
	reason: OnceLock<StopReason>,
	token: CancellationToken,
}

impl StopSignal {
	fn new() -> Self {
		Self {
			reason: OnceLock::new(),
			token: CancellationToken::new(),
		}
	}

	fn stop(&self, reason: StopReason) {
		// `??=`: a later reason never replaces the first.
		let _ = self.reason.set(reason);
		self.token.cancel();
	}

	fn reason(&self) -> Option<StopReason> {
		self.reason.get().copied()
	}
}

/// Counts of progress entries reported for one job, by kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProgressCounts {
	/// State changes.
	pub state: u64,
	/// Notes.
	pub note: u64,
	/// Tool events.
	pub tool: u64,
}

#[derive(Default)]
struct Progress {
	state: AtomicU64,
	note: AtomicU64,
	tool: AtomicU64,
}

/// The ordered, sequence-numbered event queue. Held across the HTTP send so
/// two flushes can never send the same prefix.
struct EventQueue {
	seq: u64,
	events: VecDeque<RunnerEvent>,
}

/// State shared by the job body, its reporter and the heartbeat task.
struct JobCore {
	run_id: String,
	lease_generation: u64,
	api: Arc<dyn RunnerApi>,
	logger: Arc<dyn EventLogger>,
	clock: Arc<dyn Clock>,
	stop: StopSignal,
	/// The process's shutdown request: no new request is sent after it, and a
	/// request in flight is cancelled (the launcher gives 8 s).
	shutdown: CancellationToken,
	queue: AsyncMutex<EventQueue>,
	progress: Progress,
	/// The latest usage figure, so a later fault still reports consumption (AGT-008).
	usage: Mutex<ResourceUsage>,
}

/// A fault inside the runner: the Rust counterpart of a TypeScript throw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fault {
	name: &'static str,
}

impl Fault {
	const fn new(name: &'static str) -> Self {
		Self { name }
	}

	/// A task that panicked (or was cancelled) is a fault named by its payload class.
	fn from_join(error: JoinError) -> Self {
		if error.is_panic() && error.into_panic().is::<NonLifecycleState>() {
			return Self::new(fault_names::ERROR);
		}
		Self::new(fault_names::PANIC)
	}
}

/// The panic payload of "the pipeline reported a non-lifecycle state".
struct NonLifecycleState;

/// The pipeline only ever reports lifecycle stages; anything else is a
/// programming error that ends the job through the fault path.
fn leased_state(state: JobState) -> LeasedJobState {
	match state {
		JobState::Claimed => LeasedJobState::Claimed,
		JobState::Planning => LeasedJobState::Planning,
		JobState::Collecting => LeasedJobState::Collecting,
		JobState::Analyzing => LeasedJobState::Analyzing,
		JobState::Verifying => LeasedJobState::Verifying,
		JobState::Publishing => LeasedJobState::Publishing,
		_ => std::panic::resume_unwind(Box::new(NonLifecycleState)),
	}
}

fn count(value: u64) -> LogValue<'static> {
	LogValue::Int(i64::try_from(value).unwrap_or(i64::MAX))
}

impl JobCore {
	fn usage(&self) -> ResourceUsage {
		*self
			.usage
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
	}

	fn set_usage(&self, usage: ResourceUsage) {
		*self
			.usage
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner) = usage;
	}

	/// Queues an event; beyond the cap it is dropped without a sequence number.
	fn enqueue(&self, queue: &mut EventQueue, event: RunnerEventBody) {
		if queue.events.len() >= MAX_QUEUED_EVENTS {
			return;
		}
		queue.events.push_back(RunnerEvent {
			seq: queue.seq,
			at: self.clock.now_iso(),
			event,
		});
		queue.seq += 1;
	}

	/// Sends queued events in batches until the queue is empty or delivery fails.
	/// A failed batch stays queued: sequence numbers make a later resend safe.
	async fn flush_locked(&self, queue: &mut EventQueue) {
		while !queue.events.is_empty()
			&& self.stop.reason() != Some(StopReason::LeaseLost)
			&& !self.shutdown.is_cancelled()
		{
			let take = queue.events.len().min(MAX_EVENTS_PER_REQUEST);
			let request = RunnerEventsRequest {
				lease_generation: self.lease_generation,
				events: queue.events.iter().take(take).cloned().collect(),
			};
			let sent = tokio::select! {
				sent = self.api.events(&self.run_id, &request) => sent,
				// Shutdown cancels the request in flight; the batch stays queued.
				() = self.shutdown.cancelled() => return,
			};
			match sent {
				Err(error) => {
					if LEASE_LOST_CODES.contains(&error.code.as_str()) {
						self.stop.stop(StopReason::LeaseLost);
					} else {
						self.logger.warn(
							"events_not_delivered",
							&[
								("runId", LogValue::from(self.run_id.as_str())),
								("code", LogValue::from(error.code.as_str())),
							],
						);
					}
					return;
				}
				Ok(response) => {
					queue.events.drain(..take);
					if response.cancel_requested {
						self.stop.stop(StopReason::Cancelled);
					}
				}
			}
		}
	}

	async fn flush(&self) {
		let mut queue = self.queue.lock().await;
		self.flush_locked(&mut queue).await;
	}
}

/// The reporter the pipelines and job bodies talk to.
struct JobReporter {
	core: Arc<JobCore>,
}

#[async_trait]
impl PipelineReporter for JobReporter {
	async fn state(&self, state: JobState) {
		self.core.progress.state.fetch_add(1, Ordering::Relaxed);
		let leased = leased_state(state);
		let mut queue = self.core.queue.lock().await;
		self.core
			.enqueue(&mut queue, RunnerEventBody::State { state: leased });
		self.core.flush_locked(&mut queue).await;
	}

	async fn note(&self, text: &str) {
		// The Worker refuses an empty note (`text` is `min(1)`) and a refused batch
		// stays queued, so one empty note would block every later event.
		if text.is_empty() {
			return;
		}
		self.core.progress.note.fetch_add(1, Ordering::Relaxed);
		let mut queue = self.core.queue.lock().await;
		// `text.slice(0, 500)`: never a lone surrogate, so at most 500 units at a char boundary.
		self.core.enqueue(
			&mut queue,
			RunnerEventBody::Note {
				text: cut_code_points(text, NOTE_MAX_UNITS).to_owned(),
			},
		);
		if queue.events.len() >= NOTE_FLUSH_THRESHOLD {
			self.core.flush_locked(&mut queue).await;
		}
	}

	async fn tool(&self, tool_id: &str, outcome: ToolCallOutcome, detail: &str) {
		self.core.progress.tool.fetch_add(1, Ordering::Relaxed);
		let mut queue = self.core.queue.lock().await;
		self.core.enqueue(
			&mut queue,
			RunnerEventBody::Tool {
				tool_id: tool_id.to_owned(),
				outcome: match outcome {
					ToolCallOutcome::Executed => ToolOutcome::Executed,
					ToolCallOutcome::Denied => ToolOutcome::Denied,
					ToolCallOutcome::Failed => ToolOutcome::Failed,
				},
				detail: cut_code_points(detail, TOOL_DETAIL_MAX_UNITS).to_owned(),
			},
		);
		if queue.events.len() >= NOTE_FLUSH_THRESHOLD {
			self.core.flush_locked(&mut queue).await;
		}
	}

	async fn usage(&self, usage: &ResourceUsage) {
		// Keep the latest figure outside the pipeline too: if the runner faults
		// later, the failure it reports must still carry what was already
		// consumed (AGT-008). Never flushes.
		self.core.set_usage(*usage);
		let mut queue = self.core.queue.lock().await;
		self.core
			.enqueue(&mut queue, RunnerEventBody::Usage { usage: *usage });
	}
}

/// Delivers the Google sign-in link: queued once; a repeat call only re-sends
/// what is undelivered. Delivered means the whole queue went out.
struct AuthUrlSender {
	core: Arc<JobCore>,
	queued: Mutex<bool>,
}

#[async_trait]
impl GoogleAuthUrlSender for AuthUrlSender {
	async fn send_auth_url(&self, url: &str) -> bool {
		let mut queue = self.core.queue.lock().await;
		let first = {
			let mut queued = self
				.queued
				.lock()
				.unwrap_or_else(std::sync::PoisonError::into_inner);
			!std::mem::replace(&mut *queued, true)
		};
		if first {
			self.core.enqueue(
				&mut queue,
				RunnerEventBody::GoogleAuthUrl {
					url: url.to_owned(),
				},
			);
		}
		self.core.flush_locked(&mut queue).await;
		queue.events.is_empty()
	}
}

/// What the compact run card no longer shows — identifiers, codes and counts
/// only, never prompts, question text, progress text or error messages
/// (SEC-010) — logged once per terminal submission on `job_finished`, so the
/// facts stay observable in `runner.log`. Budget ceilings apply to research
/// jobs only; news-ingest jobs carry no budget and omit those fields.
/// `promptVersion` is the short template version (e.g. `research-v5`), never
/// prompt text; `null` when the job publishes no research result.
#[must_use]
pub fn run_finished_fields(
	job: &ClaimedJob,
	completion: &CompleteJobRequest,
	state: &str,
	progress: ProgressCounts,
) -> Vec<(&'static str, LogValue<'static>)> {
	let lease = job.lease();
	let bundle = match completion {
		CompleteJobRequest::Completed { bundle, .. }
		| CompleteJobRequest::Partial { bundle, .. } => Some(bundle),
		_ => None,
	};
	let (usage, failure_code) = completion_facts(completion);
	let research = match job {
		ClaimedJob::Research(research) => Some(research),
		_ => None,
	};
	let mut fields: Vec<(&'static str, LogValue<'static>)> = vec![
		("runId", LogValue::from(lease.run_id.clone())),
		("state", LogValue::from(state.to_owned())),
		("attempt", count(lease.attempt)),
		("maxAttempts", count(MAX_JOB_ATTEMPTS)),
		(
			"agentId",
			LogValue::from(research.map(|job| job.request.agent_id.clone())),
		),
		(
			"providerModel",
			LogValue::from(bundle.and_then(|bundle| bundle.provenance.provider_model.clone())),
		),
		(
			"promptVersion",
			LogValue::from(research.map(|_| {
				bundle.map_or_else(
					|| PROMPT_VERSION.to_owned(),
					|bundle| bundle.provenance.prompt_version.clone(),
				)
			})),
		),
		("agentSteps", count(usage.agent_steps)),
		("toolCalls", count(usage.tool_calls)),
		("inputBytes", count(usage.input_bytes)),
		("knownCostUsd", LogValue::Num(usage.known_cost_usd)),
		(
			"hasUnmeteredUsage",
			LogValue::Bool(usage.has_unmetered_usage),
		),
		// An unknown cost is never reported as zero (AGT-008): `costKnown` says
		// whether the total is known, `costUsd` is the known portion.
		("costKnown", LogValue::Bool(!usage.has_unmetered_usage)),
		("costUsd", LogValue::Num(usage.known_cost_usd)),
		(
			"failureCode",
			LogValue::from(failure_code.map(str::to_owned)),
		),
		(
			"verificationStatus",
			LogValue::from(bundle.map(|bundle| bundle.verification_status.as_str())),
		),
		(
			"progressCount",
			count(progress.state + progress.note + progress.tool),
		),
		("progressStateCount", count(progress.state)),
		("progressNoteCount", count(progress.note)),
		("progressToolCount", count(progress.tool)),
	];
	if let Some(research) = research {
		let budget = &research.request.budget;
		fields.push(("maxAgentSteps", count(budget.max_agent_steps)));
		fields.push(("maxToolCalls", count(budget.max_tool_calls)));
		fields.push(("maxWallClockMs", count(budget.max_wall_clock_ms)));
		fields.push(("maxInputBytes", count(budget.max_input_bytes)));
		fields.push(("maxSpendUsd", LogValue::from(budget.max_spend_usd)));
	}
	fields
}

/// The usage every completion carries, and its failure code for failed / partial.
fn completion_facts(completion: &CompleteJobRequest) -> (ResourceUsage, Option<&str>) {
	match completion {
		CompleteJobRequest::Completed { usage, .. }
		| CompleteJobRequest::Ingested { usage, .. }
		| CompleteJobRequest::MarketRefreshed { usage, .. }
		| CompleteJobRequest::Cancelled { usage, .. }
		| CompleteJobRequest::NotebookAssisted { usage, .. }
		| CompleteJobRequest::WaitingApproval { usage, .. }
		| CompleteJobRequest::EarningsRefreshed { usage, .. }
		| CompleteJobRequest::GoogleCalendarConnected { usage, .. }
		| CompleteJobRequest::GoogleCalendarSynced { usage, .. }
		| CompleteJobRequest::GoogleCalendarDisconnected { usage, .. } => (*usage, None),
		CompleteJobRequest::Partial {
			usage,
			failure_code,
			..
		}
		| CompleteJobRequest::Failed {
			usage,
			failure_code,
			..
		} => (*usage, Some(failure_code.as_str())),
	}
}

/// `toCompletion`: a pipeline outcome as the completion request.
#[must_use]
pub fn to_completion(lease_generation: u64, outcome: PipelineOutcome) -> CompleteJobRequest {
	match outcome {
		PipelineOutcome::Completed {
			bundle,
			articles,
			usage,
		} => CompleteJobRequest::Completed {
			lease_generation,
			usage,
			bundle,
			articles,
			source_reports: Vec::new(),
		},
		PipelineOutcome::Partial {
			failure_code,
			bundle,
			articles,
			usage,
		} => CompleteJobRequest::Partial {
			lease_generation,
			usage,
			failure_code: cut_code_points(&failure_code, FAILURE_CODE_MAX_UNITS).to_owned(),
			bundle,
			articles,
			source_reports: Vec::new(),
		},
		PipelineOutcome::Failed {
			failure_code,
			failure_detail,
			retryable,
			usage,
		} => CompleteJobRequest::Failed {
			lease_generation,
			usage,
			failure_code: cut_code_points(&failure_code, FAILURE_CODE_MAX_UNITS).to_owned(),
			// The key is omitted when there is no detail.
			failure_detail: failure_detail.map_or(Tri::Absent, |detail| {
				Tri::Value(cut_code_points(&detail, FAILURE_CODE_MAX_UNITS).to_owned())
			}),
			retryable,
		},
		PipelineOutcome::Cancelled { usage } => CompleteJobRequest::Cancelled {
			lease_generation,
			usage,
		},
		PipelineOutcome::WaitingApproval {
			approval_request,
			usage,
		} => CompleteJobRequest::WaitingApproval {
			lease_generation,
			usage,
			approval_request,
		},
	}
}

fn failed_completion(
	lease_generation: u64,
	usage: ResourceUsage,
	failure_code: String,
	retryable: bool,
) -> CompleteJobRequest {
	CompleteJobRequest::Failed {
		lease_generation,
		usage,
		failure_code,
		failure_detail: Tri::Absent,
		retryable,
	}
}

fn new_core(job: &ClaimedJob, deps: &JobDeps, shutdown: CancellationToken) -> Arc<JobCore> {
	let lease = job.lease();
	Arc::new(JobCore {
		run_id: lease.run_id.clone(),
		lease_generation: lease.lease_generation,
		api: Arc::clone(&deps.api),
		logger: Arc::clone(&deps.logger),
		clock: Arc::clone(&deps.clock),
		stop: StopSignal::new(),
		shutdown,
		queue: AsyncMutex::new(EventQueue {
			seq: 0,
			events: VecDeque::new(),
		}),
		progress: Progress::default(),
		// Starts from what earlier attempts of this run consumed; ceilings apply to the run.
		usage: Mutex::new(match job {
			ClaimedJob::Research(research) => research.prior_usage,
			_ => EMPTY_USAGE,
		}),
	})
}

/// Runs one claimed job to completion under its lease. Never panics and never
/// returns an error: every outcome is logged and, when the lease still holds,
/// submitted.
pub async fn execute_job(job: ClaimedJob, deps: Arc<JobDeps>, shutdown: CancellationToken) {
	let lease = job.lease().clone();
	let core = new_core(&job, &deps, shutdown.clone());

	// Shutdown already requested at job start stops it immediately.
	if shutdown.is_cancelled() {
		core.stop.stop(StopReason::Shutdown);
	}
	let finished = CancellationToken::new();
	let watcher = {
		let core = Arc::clone(&core);
		let finished = finished.clone();
		tokio::spawn(async move {
			tokio::select! {
				() = shutdown.cancelled() => core.stop.stop(StopReason::Shutdown),
				() = finished.cancelled() => {}
			}
		})
	};
	let heartbeat = spawn_heartbeat(Arc::clone(&core), lease.heartbeat_interval_ms);

	let scratch_cell: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
	// A panic anywhere in the job is a fault, like a TypeScript throw (SEC-010:
	// only a class name is ever logged).
	let attempt = tokio::spawn(attempt_job(
		job.clone(),
		Arc::clone(&deps),
		Arc::clone(&core),
		Arc::clone(&scratch_cell),
	))
	.await;
	let fault = match attempt {
		Ok(Ok(())) => None,
		Ok(Err(fault)) => Some(fault),
		Err(error) => Some(Fault::from_join(error)),
	};
	if let Some(fault) = fault {
		report_fault(&job, &core, fault).await;
	}

	// Always: stop the heartbeat, detach from shutdown, remove the scratch directory.
	heartbeat.abort();
	finished.cancel();
	// Both tasks were just stopped; the job's outcome is already reported above.
	let _ = heartbeat.await;
	let _ = watcher.await;
	let scratch = scratch_cell
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner)
		.take();
	if let Some(path) = scratch
		&& let Err(error) = deps.scratch.remove(&path).await
	{
		deps.logger.warn(
			"scratch_not_removed",
			&[
				("runId", LogValue::from(lease.run_id.as_str())),
				("error", LogValue::from(io_error_name(&error))),
			],
		);
	}
}

/// Class name of an I/O failure for the log (never its message).
const fn io_error_name(_error: &std::io::Error) -> &'static str {
	fault_names::IO_ERROR
}

/// Unexpected fault inside the runner. Report it so the job can be retried;
/// never swallow it. Submitted regardless of the stop reason (TypeScript
/// behaviour); the Google grant is not discarded on this path.
async fn report_fault(job: &ClaimedJob, core: &Arc<JobCore>, fault: Fault) {
	core.logger.error(
		"job_crashed",
		&[
			("runId", LogValue::from(core.run_id.as_str())),
			("error", LogValue::from(fault.name)),
		],
	);
	let completion = failed_completion(
		core.lease_generation,
		core.usage(),
		cut_code_points(
			&format!("RUNNER_ERROR_{}", fault.name),
			FAILURE_CODE_MAX_UNITS,
		)
		.to_owned(),
		true,
	);
	let Some(submitted) =
		within_shutdown_grace(&core.shutdown, core.api.complete(&core.run_id, &completion)).await
	else {
		return;
	};
	log_submission(
		job,
		core,
		&completion,
		submitted.map_err(|error| error.code),
	);
}

/// How long a completion already being sent may finish once shutdown starts.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Runs `call`; when shutdown is requested meanwhile it gets [`SHUTDOWN_GRACE`]
/// to finish, then it is cancelled (`None`) so the process exits within the
/// launcher's grace period.
async fn within_shutdown_grace<T>(
	shutdown: &CancellationToken,
	call: impl std::future::Future<Output = T>,
) -> Option<T> {
	tokio::pin!(call);
	tokio::select! {
		result = &mut call => Some(result),
		() = shutdown.cancelled() => {
			tokio::select! {
				result = &mut call => Some(result),
				() = tokio::time::sleep(SHUTDOWN_GRACE) => None,
			}
		}
	}
}

fn progress_counts(core: &JobCore) -> ProgressCounts {
	ProgressCounts {
		state: core.progress.state.load(Ordering::Relaxed),
		note: core.progress.note.load(Ordering::Relaxed),
		tool: core.progress.tool.load(Ordering::Relaxed),
	}
}

/// `job_finished` on success, `completion_rejected` on an API error.
fn log_submission(
	job: &ClaimedJob,
	core: &JobCore,
	completion: &CompleteJobRequest,
	submitted: Result<research_contracts::jobs::CompleteJobResponse, String>,
) {
	match submitted {
		Ok(response) => core.logger.info(
			"job_finished",
			&run_finished_fields(
				job,
				completion,
				response.state.as_str(),
				progress_counts(core),
			),
		),
		Err(code) => core.logger.warn(
			"completion_rejected",
			&[
				("runId", LogValue::from(core.run_id.as_str())),
				("code", LogValue::from(code)),
			],
		),
	}
}

/// The heartbeat keeps the lease and carries cancellation back. Ticks fall on
/// multiples of the interval, the first after one full interval. A beat is
/// awaited inline, so two never overlap; a tick that falls while a beat is in
/// flight is skipped (not run late), like the TypeScript timer that skips a
/// tick while one is in flight. No beat is sent once a stop reason is set.
fn spawn_heartbeat(core: Arc<JobCore>, interval_ms: u64) -> JoinHandle<()> {
	let period_ms = interval_ms.max(1);
	tokio::spawn(async move {
		let start = tokio::time::Instant::now();
		let mut tick: u64 = 1;
		loop {
			tokio::time::sleep_until(start + Duration::from_millis(period_ms.saturating_mul(tick)))
				.await;
			if core.stop.reason().is_none() {
				let beat =
					AssertUnwindSafe(core.api.heartbeat(&core.run_id, core.lease_generation))
						.catch_unwind()
						.await;
				match beat {
					Ok(Ok(response)) => {
						if response.cancel_requested {
							core.stop.stop(StopReason::Cancelled);
						}
					}
					Ok(Err(error)) if LEASE_LOST_CODES.contains(&error.code.as_str()) => {
						core.stop.stop(StopReason::LeaseLost);
					}
					Ok(Err(error)) => record_heartbeat_failure(&core, &error.code),
					Err(_) => record_heartbeat_failure(&core, "HEARTBEAT_REQUEST_FAILED"),
				}
			}
			// The next multiple of the interval strictly after now.
			let elapsed_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
			tick = (elapsed_ms / period_ms)
				.saturating_add(1)
				.max(tick.saturating_add(1));
		}
	})
}

/// Records through the logger without ever failing: this task is detached, so
/// a panic here would otherwise end the heartbeat silently.
fn record_heartbeat_failure(core: &JobCore, code: &str) {
	let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
		core.logger.warn(
			"heartbeat_failed",
			&[
				("runId", LogValue::from(core.run_id.as_str())),
				("code", LogValue::from(code)),
			],
		);
	}));
}

/// The body of the TypeScript `try`: scratch directory, dispatch by kind,
/// final flush, abandon / cancel / submit.
async fn attempt_job(
	job: ClaimedJob,
	deps: Arc<JobDeps>,
	core: Arc<JobCore>,
	scratch_cell: Arc<Mutex<Option<PathBuf>>>,
) -> Result<(), Fault> {
	let scratch = deps
		.scratch
		.create(&core.run_id)
		.await
		.map_err(|_| Fault::new(fault_names::IO_ERROR))?;
	*scratch_cell
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner) = Some(scratch.clone());
	let reporter = Arc::new(JobReporter {
		core: Arc::clone(&core),
	});
	let mut completion = dispatch(&job, &deps, &core, &reporter, scratch).await?;
	core.flush().await;

	// FR-019: a connect that stored its grant must end `completed`, or the
	// stored refresh token is given back — the API will report "not connected",
	// and the app could never disconnect a grant it denies.
	let stored_grant = matches!(
		completion,
		CompleteJobRequest::GoogleCalendarConnected { .. }
	);
	let reason = core.stop.reason();
	if matches!(reason, Some(StopReason::LeaseLost | StopReason::Shutdown)) {
		if stored_grant {
			discard_grant(&deps, &core).await?;
		}
		core.logger.info(
			"job_abandoned",
			&[
				("runId", LogValue::from(core.run_id.as_str())),
				(
					"reason",
					LogValue::from(reason.map_or("", StopReason::as_str)),
				),
			],
		);
		return Ok(());
	}
	if reason == Some(StopReason::Cancelled) {
		completion = CompleteJobRequest::Cancelled {
			lease_generation: core.lease_generation,
			usage: core.usage(),
		};
	}
	let Some(submitted) =
		within_shutdown_grace(&core.shutdown, deps.api.complete(&core.run_id, &completion)).await
	else {
		core.logger.info(
			"job_abandoned",
			&[
				("runId", LogValue::from(core.run_id.as_str())),
				("reason", LogValue::from("shutdown")),
			],
		);
		return Ok(());
	};
	let kept = reason != Some(StopReason::Cancelled)
		&& matches!(&submitted, Ok(response) if response.state == JobState::Completed);
	if stored_grant && !kept {
		discard_grant(&deps, &core).await?;
	}
	let code = submitted.as_ref().err().map(|error| error.code.clone());
	log_submission(
		&job,
		&core,
		&completion,
		submitted.map_err(|error| error.code),
	);
	if let Some(code) = code
		&& REJECTED_SUBMISSION_CODES.contains(&code.as_str())
	{
		// The Worker refused the result itself; record that honestly rather than retrying it.
		let _ = within_shutdown_grace(
			&core.shutdown,
			deps.api.complete(
				&core.run_id,
				&failed_completion(
					core.lease_generation,
					core.usage(),
					cut_code_points(
						&format!("SUBMISSION_REJECTED_{code}"),
						FAILURE_CODE_MAX_UNITS,
					)
					.to_owned(),
					false,
				),
			),
		)
		.await;
	}
	Ok(())
}

async fn discard_grant(deps: &JobDeps, core: &JobCore) -> Result<(), Fault> {
	deps.google
		.discard_grant(&core.run_id)
		.await
		.map_err(|_| Fault::new(fault_names::ERROR))
}

/// Dispatch by kind. The claim response enum is closed, so there is no
/// "unknown kind" branch: an unknown kind fails claim parsing instead.
async fn dispatch(
	job: &ClaimedJob,
	deps: &Arc<JobDeps>,
	core: &Arc<JobCore>,
	reporter: &Arc<JobReporter>,
	scratch: PathBuf,
) -> Result<CompleteJobRequest, Fault> {
	let cancel = core.stop.token.clone();
	match job {
		ClaimedJob::MarketRefresh(job) => Ok(market_refresh(job, deps, &cancel, &**reporter).await),
		ClaimedJob::EarningsRefresh(job) => {
			Ok(earnings_refresh(job, deps, &cancel, &**reporter).await)
		}
		ClaimedJob::NewsIngest(lease) => {
			for state in [JobState::Planning, JobState::Collecting] {
				reporter.state(state).await;
			}
			let ingested = ingest_sources(
				&lease.sources,
				&deps.ingest,
				IngestOptions {
					cancel,
					max_articles: bundle_limits::ARTICLES,
				},
			)
			.await
			.map_err(|error| Fault::new(error.js_error_name()))?;
			for state in [
				JobState::Analyzing,
				JobState::Verifying,
				JobState::Publishing,
			] {
				reporter.state(state).await;
			}
			Ok(CompleteJobRequest::Ingested {
				lease_generation: core.lease_generation,
				usage: core.usage(),
				articles: ingested.articles,
				source_reports: ingested.source_reports,
			})
		}
		ClaimedJob::Research(research) => {
			let Some(agent) = deps.agents.get(&research.request.agent_id) else {
				return Ok(to_completion(
					core.lease_generation,
					PipelineOutcome::Failed {
						failure_code: "AGENT_NOT_REGISTERED".to_owned(),
						failure_detail: None,
						retryable: false,
						usage: core.usage(),
					},
				));
			};
			let outcome = run_research_pipeline(
				ResearchPipelineInput {
					run_id: research.lease.run_id.clone(),
					request: research.request.clone(),
					sources: research.lease.sources.clone(),
					workspace_components: research.workspace_components.clone(),
					conversation_context: research.conversation_context.clone(),
					prior_usage: research.prior_usage,
					cancel,
					allow_unverified_tool_isolation: deps.allow_unverified_tool_isolation,
				},
				ResearchPipelineDeps {
					agent: Arc::clone(agent),
					tools: deps.tools.clone(),
					clock: Arc::clone(&deps.clock),
					reporter: Arc::clone(reporter) as Arc<dyn PipelineReporter>,
					new_fence_token: Arc::clone(&deps.new_fence_token),
					scratch_directory: Some(scratch),
				},
			)
			.await
			.map_err(|_| Fault::new(fault_names::ERROR))?;
			core.set_usage(pipeline_usage(&outcome));
			Ok(to_completion(core.lease_generation, outcome))
		}
		ClaimedJob::NotebookAssist(assist) => {
			let Some(agent) = deps.agents.get(&assist.agent.agent_id) else {
				return Ok(failed_completion(
					core.lease_generation,
					core.usage(),
					"AGENT_NOT_REGISTERED".to_owned(),
					false,
				));
			};
			let outcome = run_notebook_assist_turn(
				&NotebookAssistTurnInput {
					job: assist,
					cancel: &cancel,
					allow_unverified_tool_isolation: deps.allow_unverified_tool_isolation,
				},
				&NotebookAssistTurnDeps {
					agent: &**agent,
					clock: &*deps.clock,
					reporter: &**reporter,
					new_fence_token: &*deps.new_fence_token,
					scratch_directory: Some(scratch),
				},
			)
			.await
			.map_err(|_| Fault::new(fault_names::ERROR))?;
			Ok(match outcome {
				NotebookAssistTurnOutcome::Assisted {
					reply,
					commands,
					proposed_removals,
					base_version,
					usage,
				} => {
					core.set_usage(usage);
					CompleteJobRequest::NotebookAssisted {
						lease_generation: core.lease_generation,
						usage,
						base_version,
						reply,
						commands,
						proposed_removals,
					}
				}
				NotebookAssistTurnOutcome::Failed {
					failure_code,
					retryable,
					usage,
				} => {
					core.set_usage(usage);
					failed_completion(
						core.lease_generation,
						usage,
						cut_code_points(&failure_code, FAILURE_CODE_MAX_UNITS).to_owned(),
						retryable,
					)
				}
				NotebookAssistTurnOutcome::Cancelled { usage } => {
					core.set_usage(usage);
					CompleteJobRequest::Cancelled {
						lease_generation: core.lease_generation,
						usage,
					}
				}
			})
		}
		ClaimedJob::GoogleCalendar(google) => {
			let sender = AuthUrlSender {
				core: Arc::clone(core),
				queued: Mutex::new(false),
			};
			deps.google
				.execute(google, &cancel, &**reporter, &sender)
				.await
				.map_err(|_| Fault::new(fault_names::ERROR))
		}
	}
}

const fn pipeline_usage(outcome: &PipelineOutcome) -> ResourceUsage {
	match outcome {
		PipelineOutcome::Completed { usage, .. }
		| PipelineOutcome::Partial { usage, .. }
		| PipelineOutcome::Failed { usage, .. }
		| PipelineOutcome::Cancelled { usage }
		| PipelineOutcome::WaitingApproval { usage, .. } => *usage,
	}
}

fn refresh_deps(deps: &JobDeps) -> RefreshDeps<'_> {
	RefreshDeps {
		clock: &*deps.clock,
		logger: &*deps.logger,
		pacer: &*deps.pacer,
		market_sources: &deps.market_sources,
		earnings_sources: &deps.earnings_sources,
	}
}

async fn market_refresh(
	job: &MarketRefreshJob,
	deps: &JobDeps,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	execute_market_refresh(job, &refresh_deps(deps), cancel, reporter).await
}

async fn earnings_refresh(
	job: &EarningsRefreshJob,
	deps: &JobDeps,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	execute_earnings_refresh(job, &refresh_deps(deps), cancel, reporter).await
}

/// A reporter on a fresh job core, for tests of the event queue.
#[cfg(test)]
pub(crate) struct TestReporter(JobReporter);

#[cfg(test)]
pub(crate) fn test_core(deps: &Arc<JobDeps>, job: &ClaimedJob) -> TestReporter {
	TestReporter(JobReporter {
		core: new_core(job, deps, CancellationToken::new()),
	})
}

#[cfg(test)]
impl TestReporter {
	/// Queued events and the next sequence number.
	pub(crate) async fn queue_snapshot(&self) -> (usize, u64) {
		let queue = self.0.core.queue.lock().await;
		(queue.events.len(), queue.seq)
	}
}

#[cfg(test)]
#[async_trait]
impl PipelineReporter for TestReporter {
	async fn state(&self, state: JobState) {
		self.0.state(state).await;
	}
	async fn note(&self, text: &str) {
		self.0.note(text).await;
	}
	async fn tool(&self, tool_id: &str, outcome: ToolCallOutcome, detail: &str) {
		self.0.tool(tool_id, outcome, detail).await;
	}
	async fn usage(&self, usage: &ResourceUsage) {
		self.0.usage(usage).await;
	}
}
