//! Evidence-first research lifecycle. The model proposes; this pipeline
//! authorizes, verifies and publishes under the owner's cumulative ceilings.
mod collect;
mod direct;
pub mod draft;
pub mod presentation;
pub mod prompts;
mod publish;
mod records;
mod tool_status;
mod turn;
mod value;

use self::{
	collect::{CollectedEntry, collected_so_far_text, digest_lines_for},
	draft::parse_draft,
	prompts::{
		AnalysisPromptInput, PLANNING_FINAL_ROUND_NOTE, PLANNING_PROMPT_BUDGET_BYTES,
		PLANNING_REMINDER, PLANNING_REPEAT_NOTE, PLANNING_SEARCH_BEFORE_FINAL_NOTE,
		PlanningPromptInput, analysis_prompt, planning_prompt, verification_prompt,
	},
	turn::{Session, TurnFailure},
	value::*,
};
use crate::{
	ports::Clock,
	reporter::{AnalysisAttempt, PipelineReporter, ToolCallOutcome},
};
use research_agent_core::{
	authorize::{
		ToolDenialCode, ToolPolicy, ToolRegistry, ToolRequest, authorize_tool_call,
		execute_tool_call,
	},
	model_text::{extract_json_object, fence_untrusted_text},
	runtime::AgentRuntime,
	tools::{
		CollectedEvidence, IdAllocator, ToolContext, ToolFailure, ToolNetworkAllowlist, ToolOutput,
	},
};
use research_contracts::{
	agent::{AgentAvailability, ToolIsolation},
	jobs::{
		ApprovalRequest, ConversationContextMessage, ResearchBundle, ResearchRequest,
		SubscribedSourceRef, WorkspaceComponentSummary, sanitize_tool_error_code,
	},
	records::IngestedArticle,
};
use research_domain::{
	evidence::verify_claims::{
		ClaimIssue, ClaimStatus, ClaimType, DraftClaim, DraftEvidenceLink, EvidenceIndex,
		EvidenceRelation, EvidenceText, verify_claims_with,
	},
	jobs::{
		budget::{BudgetLimit, ResourceUsage, UsageDelta, add_usage, check_budget},
		state_machine::JobState,
	},
};
use research_js::{json::Value, utf16};
use serde::Serialize;
use std::{
	collections::{HashMap, HashSet},
	path::PathBuf,
	sync::{Arc, Mutex},
	time::Duration,
};

/// Infrastructure errors, separate from provider/tool failures in PipelineOutcome.
#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
	/// An injected clock produced a deadline outside JavaScript Date's range.
	#[error("pipeline deadline is outside the JavaScript Date range")]
	InvalidDeadline,
	/// A prompt must never use an empty fence.
	#[error("pipeline fence token is empty")]
	EmptyFence,
	/// Serialization failed at a typed boundary.
	#[error(transparent)]
	Serialization(#[from] serde_json::Error),
	/// A typed internal value violated a contract.
	#[error(transparent)]
	Contract(#[from] research_contracts::ContractError),
	/// A CPU worker did not return its result.
	#[error("pipeline CPU worker did not return a result")]
	CpuWorker,
}
impl From<research_agent_core::model_text::EmptyFenceToken> for PipelineError {
	fn from(_: research_agent_core::model_text::EmptyFenceToken) -> Self {
		Self::EmptyFence
	}
}

/// One research attempt; quotas include prior attempts of this run.
#[derive(Clone)]
pub struct ResearchPipelineInput {
	/// Stable run id.
	pub run_id: String,
	/// Validated owner request.
	pub request: ResearchRequest,
	/// Subscribed sources.
	pub sources: Vec<SubscribedSourceRef>,
	/// Earlier canvas components.
	pub workspace_components: Vec<WorkspaceComponentSummary>,
	/// Bounded context, never evidence.
	pub conversation_context: Vec<ConversationContextMessage>,
	/// Usage accumulated by earlier attempts.
	pub prior_usage: ResourceUsage,
	/// Owner/lease cancellation.
	pub cancel: tokio_util::sync::CancellationToken,
	/// Explicit owner opt-in for unverified backend isolation.
	pub allow_unverified_tool_isolation: bool,
}

/// Tools whose results are planning leads, not evidence.
fn is_discovery(tool_id: &str) -> bool {
	matches!(tool_id, "web.search" | "news.search")
}
/// Tools that read one page each; consecutive requests of a round run concurrently (ADR-0078).
fn is_page_read(tool_id: &str) -> bool {
	matches!(tool_id, "web.extract" | "web.fetch_page")
}

// Financial reads use the shared SEC client's request pacing.
const MAX_PARALLEL_STOCK_CALLS: usize = 4;

fn is_parallel_stock_read(tool_id: &str) -> bool {
	matches!(tool_id, "stocks.search" | "finance.sec_company_financials")
}

/// All effects and nondeterminism are injected (ARCH-002).
pub struct ResearchPipelineDeps {
	/// Backend selected by the owner.
	pub agent: Arc<dyn AgentRuntime>,
	/// Registered research tools.
	pub tools: ToolRegistry,
	/// Wall clock.
	pub clock: Arc<dyn Clock>,
	/// Ordered progress sink.
	pub reporter: Arc<dyn PipelineReporter>,
	/// Fresh, nonempty, unguessable fence token per prompt.
	pub new_fence_token: Arc<dyn Fn() -> String + Send + Sync>,
	/// Empty per-job scratch directory passed to the backend.
	pub scratch_directory: Option<PathBuf>,
}

/// Terminal result submitted under the runner's lease.
#[derive(Debug, Clone, Serialize)]
#[serde(
	tag = "kind",
	rename_all = "snake_case",
	rename_all_fields = "camelCase"
)]
pub enum PipelineOutcome {
	/// All stages completed.
	Completed {
		/// Verified and contract-parsed bundle.
		bundle: ResearchBundle,
		/// First-position, last-value articles.
		articles: Vec<IngestedArticle>,
		/// Cumulative usage.
		usage: ResourceUsage,
	},
	/// Usable records with a stage stopped by a limit/provider failure.
	Partial {
		/// Why the result is incomplete.
		failure_code: String,
		/// The external service's status behind `failure_code`, unchanged
		/// (§4a); `None` otherwise (a budget stop is ours).
		failure_upstream_status: Option<u16>,
		/// Contract-parsed bundle.
		bundle: ResearchBundle,
		/// Collected articles.
		articles: Vec<IngestedArticle>,
		/// Cumulative usage.
		usage: ResourceUsage,
	},
	/// No usable result.
	Failed {
		/// Stable error code.
		failure_code: String,
		/// Optional diagnostic code.
		failure_detail: Option<String>,
		/// The status the external service that caused the failure answered
		/// with, unchanged (docs/rule/error_handling.md §4a): the model
		/// provider's for a provider failure; for `ALL_TOOL_CALLS_FAILED` the
		/// most frequent status among the calls that failed with the reported
		/// `failure_detail` code (the latest wins a tie). `None` when no
		/// external answer caused it.
		failure_upstream_status: Option<u16>,
		/// Whether a later attempt may help.
		retryable: bool,
		/// Cumulative usage.
		usage: ResourceUsage,
	},
	/// Owner/lease cancelled.
	Cancelled {
		/// Cumulative usage.
		usage: ResourceUsage,
	},
	/// Continuing requires owner-authorized spend.
	WaitingApproval {
		/// Why approval is needed.
		approval_request: ApprovalRequest,
		/// Cumulative usage.
		usage: ResourceUsage,
	},
}

struct RunIds {
	run_id: String,
	counters: Mutex<HashMap<String, u64>>,
}
impl IdAllocator for RunIds {
	fn next_id(&self, prefix: &str) -> String {
		// Poison recovery preserves the already allocated counters; no id is reused.
		let mut counters = self
			.counters
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		let counter = counters.entry(prefix.to_owned()).or_default();
		*counter = counter.saturating_add(1);
		format!("{}_{prefix}{counter}", self.run_id)
	}
}
/// Runs pure CPU work on the rayon pool; a panic in it becomes
/// [`PipelineError::CpuWorker`] instead of aborting the process.
async fn on_cpu<T, F>(job: F) -> Result<T, PipelineError>
where
	F: FnOnce() -> T + Send + 'static,
	T: Send + 'static,
{
	research_effects::cpu::run_cpu(job)
		.await
		.map_err(|_| PipelineError::CpuWorker)
}

/// A failed outcome. `upstream_status` is the status the external service
/// that caused the failure answered with, unchanged (§4a); `None` when no
/// external answer caused it.
fn failed(
	code: impl Into<String>,
	retryable: bool,
	detail: Option<String>,
	upstream_status: Option<u16>,
	usage: ResourceUsage,
) -> PipelineOutcome {
	PipelineOutcome::Failed {
		failure_code: code.into(),
		failure_detail: detail,
		failure_upstream_status: upstream_status,
		retryable,
		usage,
	}
}

fn claim_drafts(
	analysis: &Value,
	claim_evidence_id: impl Fn(&str) -> String,
) -> Result<Vec<DraftClaim>, PipelineError> {
	let mut drafts = Vec::new();
	for (index, v) in items(analysis, "claims").iter().enumerate() {
		let mut links = Vec::new();
		for link in items(v, "evidence") {
			links.push(DraftEvidenceLink {
				evidence_id: claim_evidence_id(field(link, "evidenceId")),
				relation: research_contracts::validate::<EvidenceRelation>(get(link, "relation"))?,
				quote: get(link, "quote")
					.as_str()
					.filter(|s| !s.is_empty())
					.map(str::to_owned),
			});
		}
		drafts.push(DraftClaim {
			claim_id: format!("draft_{index}"),
			text: field(v, "text").to_owned(),
			claim_type: research_contracts::validate::<ClaimType>(get(v, "claimType"))?,
			links,
		});
	}
	Ok(drafts)
}

/// Runs the entire research lifecycle without persistence. Provider and tool
/// failures are outcomes; invalid injected infrastructure returns a typed error.
pub async fn run_research_pipeline(
	input: ResearchPipelineInput,
	deps: ResearchPipelineDeps,
) -> Result<PipelineOutcome, PipelineError> {
	let started = deps.clock.now_ms();
	let deadline = started
		.checked_add(
			i64::try_from(input.request.budget.max_wall_clock_ms)
				.map_err(|_| PipelineError::InvalidDeadline)?,
		)
		.and_then(research_js::date::epoch_ms_to_iso)
		.ok_or(PipelineError::InvalidDeadline)?;
	let budget = &input.request.budget;
	let ids_: Arc<dyn IdAllocator> = Arc::new(RunIds {
		run_id: input.run_id.clone(),
		counters: Mutex::new(HashMap::new()),
	});
	let permitted = deps
		.tools
		.list()
		.iter()
		.filter(|t| {
			t.meta().network_allowlist != ToolNetworkAllowlist::PublicWeb
				|| input.request.web_access == research_contracts::jobs::WebAccess::PublicWeb
		})
		.map(|t| t.meta())
		.collect::<Vec<_>>();
	let permitted_ids = permitted
		.iter()
		.map(|t| t.tool_id.to_owned())
		.collect::<HashSet<_>>();
	let clock = Arc::clone(&deps.clock);
	let tool_context = ToolContext {
		run_id: input.run_id.clone(),
		cancel: input.cancel.clone(),
		now_iso: Arc::new(move || clock.now_iso()),
		ids: Arc::clone(&ids_),
		subscribed_sources: input.sources.clone().into(),
	};
	let mut session = Session {
		input: &input,
		deps: &deps,
		usage: input.prior_usage,
		started,
		deadline,
		largest_cost: 0.0,
		permitted_ids: permitted.iter().map(|t| t.tool_id.to_owned()).collect(),
	};
	let probe = deps.agent.probe().await;
	if let AgentAvailability::Unavailable { reason_code, .. } = probe.availability {
		return Ok(failed(
			format!("AGENT_UNAVAILABLE_{}", reason_code.as_str()),
			false,
			None,
			None,
			session.usage,
		));
	}
	if deps.agent.tool_isolation() != ToolIsolation::Enforced
		&& !input.allow_unverified_tool_isolation
	{
		return Ok(failed(
			"TOOL_ISOLATION_UNVERIFIED",
			false,
			None,
			None,
			session.usage,
		));
	}

	deps.reporter.state(JobState::Planning).await;
	let remaining = budget
		.max_agent_steps
		.saturating_sub(session.usage.agent_steps);
	let reserve = if remaining >= 5 {
		3
	} else if remaining >= 3 {
		2
	} else {
		1
	};
	let collection_steps = remaining.saturating_sub(reserve);
	let mut collected = ToolOutput::default();
	let mut entries = Vec::new();
	let mut ui_proposals = Vec::new();
	let mut stopped = None;
	let (
		mut executed,
		mut succeeded,
		mut denied,
		mut valid_plans,
		mut requested,
		mut invalid_plans,
	) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
	let mut reminder_sent = false;
	let mut reminder: Option<&str> = None;
	let mut reached_collecting = false;
	let mut tool_errors = HashMap::<String, u64>::new();
	// Per tool error code: each upstream status seen, how often and the index
	// of its latest call — for `ALL_TOOL_CALLS_FAILED` (§4a rule 6).
	let mut tool_error_statuses = tool_status::ToolErrorStatuses::default();
	let mut completed_requests = HashSet::new();
	let mut unavailable_tools = HashSet::new();
	let mut collection_limit_reached = false;
	let mut search_cooldown_encountered = false;
	let mut found_search_leads = false;
	let mut web_search_requested = false;
	'collection: for step in 0..collection_steps {
		if step >= 3 {
			collection_limit_reached = true;
			deps.reporter
				.note(if collected.evidence.is_empty() {
					"Collection ended after three planning rounds without citeable evidence."
				} else {
					"Collection stopped after three planning rounds."
				})
				.await;
			break;
		}
		let remaining_calls = budget
			.max_tool_calls
			.saturating_sub(session.usage.tool_calls);
		if remaining_calls == 0 {
			break;
		}
		let available: Vec<_> = permitted
			.iter()
			.filter(|tool| !unavailable_tools.contains(tool.tool_id))
			.cloned()
			.collect();
		let pending_reminder = reminder.take();
		// No round follows the last one to open search results (ADR-0078).
		let final_round = step + 1 >= collection_steps.min(3);
		let search_before_final = !final_round
			&& step + 2 == collection_steps.min(3)
			&& collected.evidence.is_empty()
			&& permitted_ids.contains("web.search")
			&& !unavailable_tools.contains("web.search")
			&& !web_search_requested;
		// ADR-0079: only the first round, before anything was collected, may
		// decide that the question needs no research. A news task always researches.
		let routing_round = step == 0
			&& entries.is_empty()
			&& input.request.output_type
				!= Some(research_contracts::jobs::ResearchOutputType::News);
		let mut reminder_parts: Vec<&str> = Vec::new();
		if !permitted_ids.contains("web.fetch_page") && permitted_ids.contains("stocks.search") {
			reminder_parts.push(if permitted_ids.contains("web.extract") {
				"Use web.search for discovery and web.extract to read relevant original pages. For news.search, use keywords of at least three characters, e.g. artificial intelligence. Use the exact company name alone when searching stored records before adding topic terms. A general feed is a recent snapshot. Use only sources relevant to the requested company and state when evidence is missing."
			} else {
				"Use web.search for discovery when listed. Direct page fetching is unavailable. Use listed stored-record, subscribed-feed, or official-data tools to collect citeable evidence, and disclose remaining gaps."
			});
		}
		if let Some(note) = pending_reminder.filter(|note| !note.is_empty()) {
			reminder_parts.push(note);
		}
		if final_round {
			reminder_parts.push(PLANNING_FINAL_ROUND_NOTE);
		} else if search_before_final {
			reminder_parts.push(PLANNING_SEARCH_BEFORE_FINAL_NOTE);
		}
		let combined_reminder = (!reminder_parts.is_empty()).then(|| reminder_parts.join(" "));
		let prompt = planning_prompt(PlanningPromptInput {
			request: &input.request,
			now_iso: &deps.clock.now_iso(),
			tools: &available,
			sources: &input.sources,
			collected_so_far: &collected_so_far_text(&entries, step),
			remaining_tool_calls: remaining_calls,
			conversation_context: &input.conversation_context,
			fence_token: &(deps.new_fence_token)(),
			prompt_budget_bytes: PLANNING_PROMPT_BUDGET_BYTES,
			reminder: combined_reminder.as_deref(),
			routing: routing_round,
		})?;
		if prompt.len() > PLANNING_PROMPT_BUDGET_BYTES {
			deps.reporter
				.note("Planning stopped early: the prompt would exceed its byte budget.")
				.await;
			stopped = Some(BudgetLimit::MaxInputBytes);
			break;
		}
		let planned = match session.turn(prompt).await {
			Ok(turn) => turn,
			Err(error) => {
				if let Some(outcome) = session.terminal(&error) {
					return Ok(outcome);
				}
				match error {
					TurnFailure::Budget(limit) => {
						stopped = Some(limit);
						break;
					}
					TurnFailure::Provider {
						ref code,
						retryable,
						upstream_status,
					} if collected.evidence.is_empty() => {
						return Ok(failed(
							code.clone(),
							retryable,
							None,
							upstream_status,
							session.usage,
						));
					}
					_ => {
						deps.reporter
							.note(&format!("Planning stopped early: {}.", error.code()))
							.await;
						break;
					}
				}
			}
		};
		ui_proposals.extend(planned.ui_proposals);
		let plan = extract_json_object(&planned.text)
			.ok()
			.and_then(|v| parse_draft("plan", &v).ok());
		if plan.is_none() && planned.tool_requests.is_empty() {
			invalid_plans += 1;
			deps.reporter
				.note("The planning reply was not valid JSON; no tools were run for it.")
				.await;
			continue;
		}
		if !reached_collecting {
			deps.reporter.state(JobState::Collecting).await;
			reached_collecting = true;
		}
		let done = plan
			.as_ref()
			.is_some_and(|p| get(p, "done").as_bool() == Some(true));
		let mut calls = plan
			.as_ref()
			.map(|p| {
				items(p, "toolCalls")
					.iter()
					.map(|call| ToolRequest {
						tool_id: field(call, "toolId").to_owned(),
						args: get(call, "args").clone(),
					})
					.collect::<Vec<_>>()
			})
			.unwrap_or_default();
		calls.extend(planned.tool_requests);
		calls.truncate(8);
		valid_plans += 1;
		requested += u64::try_from(calls.len()).unwrap_or(u64::MAX);
		if calls.iter().any(|call| call.tool_id == "web.search") {
			web_search_requested = true;
		}
		if routing_round
			&& calls.is_empty()
			&& plan
				.as_ref()
				.is_some_and(|p| get(p, "needsResearch").as_bool() == Some(false))
		{
			return direct::answer_directly(&mut session, &input, &deps, &probe).await;
		}
		if calls.is_empty()
			&& !reminder_sent
			&& collected.evidence.is_empty()
			&& entries.is_empty()
			&& executed == 0
			&& denied == 0
			&& step + 1 < collection_steps
		{
			reminder_sent = true;
			reminder = Some(PLANNING_REMINDER);
			deps.reporter
				.note("The plan requested no tools; asking the model again.")
				.await;
			deps.reporter.usage(&session.usage).await;
			continue;
		}
		// Batch consecutive page reads or stock and SEC financial reads.
		// Authorization, de-duplication, final-round rules, and budgets are
		// checked in plan order, and results are recorded in that order.
		let mut repeated_in_round = 0usize;
		let mut call_index = 0;
		while call_index < calls.len() {
			let mut batch_end = call_index + 1;
			if calls
				.get(call_index)
				.is_some_and(|call| is_page_read(&call.tool_id))
			{
				while calls
					.get(batch_end)
					.is_some_and(|call| is_page_read(&call.tool_id))
				{
					batch_end += 1;
				}
			}
			if calls
				.get(call_index)
				.is_some_and(|call| is_parallel_stock_read(&call.tool_id))
			{
				while batch_end - call_index < MAX_PARALLEL_STOCK_CALLS
					&& calls
						.get(batch_end)
						.is_some_and(|call| is_parallel_stock_read(&call.tool_id))
				{
					batch_end += 1;
				}
			}
			let mut prepared = Vec::new();
			let mut runs = Vec::new();
			let mut batch_keys = HashSet::new();
			// A limit reached while preparing stops collection once the calls
			// already started have been recorded, as when they ran one by one.
			let mut stop_after_batch = false;
			while call_index < batch_end {
				let Some(call) = calls.get(call_index) else {
					break;
				};
				call_index += 1;
				if input.cancel.is_cancelled() {
					return Ok(PipelineOutcome::Cancelled {
						usage: session.usage,
					});
				}
				let label = utf16::truncate(&call.tool_id, 80);
				let authorized = match authorize_tool_call(
					&deps.tools,
					ToolPolicy {
						permitted_tool_ids: &permitted_ids,
						remaining_tool_calls: i128::from(budget.max_tool_calls)
							- i128::from(session.usage.tool_calls),
					},
					call,
				) {
					Ok(call) => call,
					Err(code) => {
						denied += 1;
						deps.reporter
							.tool(&label, ToolCallOutcome::Denied, &code.to_string())
							.await;
						let note = format!("Tool request {label} was denied: {code}.");
						entries.push(CollectedEntry {
							step,
							full_text: note.clone(),
							digest_lines: vec![note],
						});
						if code == ToolDenialCode::ToolCallBudgetExhausted {
							stopped = Some(BudgetLimit::MaxToolCalls);
							stop_after_batch = true;
							break;
						}
						continue;
					}
				};
				let request_key = format!(
					"{}\n{}",
					call.tool_id,
					research_js::json::stringify(&authorized.args)
				);
				if completed_requests.contains(&request_key) || batch_keys.contains(&request_key) {
					repeated_in_round += 1;
					deps.reporter
						.tool(&label, ToolCallOutcome::Denied, "REPEATED_REQUEST")
						.await;
					let note = format!(
						"Tool {label} was not repeated; use its earlier result or another tool."
					);
					entries.push(CollectedEntry {
						step,
						full_text: note.clone(),
						digest_lines: vec![note],
					});
					continue;
				}
				if unavailable_tools.contains(&call.tool_id) {
					let note = format!(
						"Tool {label} was not repeated; use its earlier result or another tool."
					);
					entries.push(CollectedEntry {
						step,
						full_text: note.clone(),
						digest_lines: vec![note],
					});
					continue;
				}
				if final_round && is_discovery(&call.tool_id) {
					// Leads are only evidence once a page is read, and no round follows to read them.
					deps.reporter
						.tool(&label, ToolCallOutcome::Denied, "FINAL_ROUND_NO_SEARCH")
						.await;
					let note = format!(
						"Tool {label} was not run: search results cannot be opened after the final collection round."
					);
					entries.push(CollectedEntry {
						step,
						full_text: note.clone(),
						digest_lines: vec![note],
					});
					continue;
				}
				let delta = UsageDelta {
					tool_calls: 1,
					..UsageDelta::default()
				};
				if let Err(limit) = check_budget(budget, &session.usage, session.elapsed(), &delta)
				{
					stopped = Some(limit);
					stop_after_batch = true;
					break;
				}
				session.usage = add_usage(&session.usage, &delta);
				let remaining_ms =
					i128::from(budget.max_wall_clock_ms) - i128::from(session.elapsed());
				let remaining_ms = u64::try_from(remaining_ms.max(1)).unwrap_or(u64::MAX);
				let call_cancel = input.cancel.child_token();
				let mut context = tool_context.clone();
				context.cancel = call_cancel.clone();
				batch_keys.insert(request_key.clone());
				prepared.push((call, label, request_key));
				// Started together once the batch is prepared, in plan order.
				runs.push(async move {
					let _guard = call_cancel.drop_guard();
					// Biased: when the run's deadline and the tool finish together, the deadline wins.
					// Losing the race drops the tool's future (ADR-0030 C3).
					tokio::select! {
						biased;
						() = tokio::time::sleep(Duration::from_millis(remaining_ms)) => None,
						result = execute_tool_call(authorized, context) => Some(result),
					}
				});
			}
			let results = futures_util::future::join_all(runs).await;
			for ((call, label, request_key), raced) in prepared.into_iter().zip(results) {
				executed += 1;
				let result = match raced {
					Some(result) => result,
					// The TypeScript combines the owner's signal with the run deadline, so a
					// deadline that coincides with a cancellation reaches the tool as the
					// owner's abort: TOOL_ABORTED, an ordinary tool failure. The pipeline
					// notices the cancellation at the next call or turn.
					None if input.cancel.is_cancelled() => Err(ToolFailure {
						code: "TOOL_ABORTED".to_owned(),
						detail: "run was cancelled".to_owned(),
						retryable: false,
						upstream_status: None,
					}),
					None => {
						*tool_errors.entry("MAX_WALL_CLOCK".to_owned()).or_default() += 1;
						deps.reporter
							.tool(&label, ToolCallOutcome::Failed, "MAX_WALL_CLOCK")
							.await;
						stopped = Some(BudgetLimit::MaxWallClock);
						break 'collection;
					}
				};
				match result {
					Err(error) => {
						if call.tool_id == "web.search"
							&& (error.upstream_status == Some(432)
								|| error.code == "SEARCH_PLAN_LIMIT")
						{
							unavailable_tools.insert(call.tool_id.clone());
							search_cooldown_encountered = true;
							let note = "General web search is unavailable for this run.".to_owned();
							entries.push(CollectedEntry {
								step,
								full_text: note.clone(),
								digest_lines: vec![note],
							});
							continue;
						}
						if matches!(error.code.as_str(), "NOT_CONFIGURED" | "SEARCH_COOLDOWN") {
							unavailable_tools.insert(call.tool_id.clone());
						}
						if error.code == "SEARCH_COOLDOWN" {
							search_cooldown_encountered = true;
						}
						let code =
							sanitize_tool_error_code(&utf16::truncate(&error.code, 80)).to_owned();
						tool_error_statuses.record(&code, error.upstream_status, executed);
						*tool_errors.entry(code).or_default() += 1;
						let detail = utf16::truncate(&error.code, 300);
						deps.reporter
							.tool(&label, ToolCallOutcome::Failed, &detail)
							.await;
						let note = format!("Tool {label} failed: {detail}.");
						entries.push(CollectedEntry {
							step,
							full_text: note.clone(),
							digest_lines: vec![note],
						});
					}
					Ok(output) => {
						succeeded += 1;
						completed_requests.insert(request_key);
						entries.push(CollectedEntry {
							step,
							full_text: format!("Result of {label}:\n{}", output.model_text),
							digest_lines: digest_lines_for(&call.tool_id, &output),
						});
						let count = output.evidence.len();
						// Search snippets are planning leads. Only the fetched original can support a claim.
						let discovery = is_discovery(&call.tool_id);
						if discovery {
							found_search_leads |= count > 0;
						} else {
							collected.evidence.extend(output.evidence);
						}
						let item_kind = if discovery {
							"search lead(s)"
						} else {
							"evidence item(s)"
						};
						collected.securities.extend(output.securities);
						collected
							.financial_observations
							.extend(output.financial_observations);
						collected
							.position_observations
							.extend(output.position_observations);
						collected.investor_filings.extend(output.investor_filings);
						collected.articles.extend(output.articles);
						deps.reporter
							.tool(
								&label,
								ToolCallOutcome::Executed,
								&format!("{count} {item_kind}"),
							)
							.await;
					}
				}
			}
			if stop_after_batch {
				break 'collection;
			}
		}
		deps.reporter.usage(&session.usage).await;
		if !calls.is_empty() && repeated_in_round == calls.len() {
			reminder = Some(PLANNING_REPEAT_NOTE);
			if collected.evidence.is_empty() {
				continue;
			}
		}
		// The done flag was chosen before the planner saw the cooldown.
		if search_cooldown_encountered && collected.evidence.is_empty() {
			reminder = Some(
				"Search is temporarily unavailable. Continue collecting evidence with another listed tool, subscribed feeds, stored records or known source URLs. Do not repeat a paused search or invent URLs.",
			);
			if step + 1 < collection_steps.min(3) {
				deps.reporter
					.note("Search is temporarily unavailable; continuing with other sources.")
					.await;
			}
			continue;
		}
		if (tool_errors.contains_key("ROBOTS_DISALLOWED")
			|| tool_errors.contains_key("EXTRACT_NO_CONTENT"))
			&& collected.evidence.is_empty()
		{
			reminder = Some(
				"A page blocked automated access. Use an accessible original page from a different publisher, an official API, or stored records. In the final collection round, fetch an available source before requesting more search leads.",
			);
			continue;
		}
		if found_search_leads
			&& collected.evidence.is_empty()
			&& (permitted_ids.contains("web.extract") || permitted_ids.contains("web.fetch_page"))
		{
			reminder = Some(
				"Open relevant original pages from the search leads and assess the sources before ending collection.",
			);
			continue;
		}
		if done || calls.is_empty() {
			break;
		}
	}
	if !reached_collecting {
		deps.reporter.state(JobState::Collecting).await;
	}
	let mut articles = Vec::<IngestedArticle>::new();
	let mut positions = HashMap::new();
	for article in &collected.articles {
		if let Some(position) = positions.get(&article.canonical_url) {
			if let Some(existing) = articles.get_mut(*position) {
				*existing = article.clone();
			}
		} else {
			positions.insert(article.canonical_url.clone(), articles.len());
			articles.push(article.clone());
		}
	}
	articles.truncate(400);
	if collected.evidence.is_empty() {
		let (code, detail) = if !tool_errors.is_empty() && succeeded == 0 {
			let best = tool_errors
				.iter()
				.min_by(|(a, na), (b, nb)| nb.cmp(na).then_with(|| a.cmp(b)))
				.map(|(code, _)| sanitize_tool_error_code(code).to_owned());
			("ALL_TOOL_CALLS_FAILED", best)
		} else if succeeded > 0 {
			(
				"NO_EVIDENCE_COLLECTED",
				Some("TOOLS_RETURNED_NOTHING".to_owned()),
			)
		} else if valid_plans == 0 && invalid_plans > 0 {
			("NO_EVIDENCE_COLLECTED", Some("PLAN_NOT_JSON".to_owned()))
		} else if requested == 0 {
			(
				"NO_EVIDENCE_COLLECTED",
				Some("NO_TOOL_REQUESTED".to_owned()),
			)
		} else {
			("NO_EVIDENCE_COLLECTED", None)
		};
		let upstream_status = if code == "ALL_TOOL_CALLS_FAILED" {
			tool_error_statuses.most_frequent(detail.as_deref())
		} else {
			None
		};
		return Ok(failed(code, false, detail, upstream_status, session.usage));
	}
	deps.reporter.state(JobState::Analyzing).await;
	let pack_budget = usize::try_from(
		budget
			.max_input_bytes
			.saturating_sub(session.usage.input_bytes)
			.saturating_sub(12000),
	)
	.unwrap_or(usize::MAX)
	.min(150000);
	let mut pack = String::new();
	let mut shown = Vec::<CollectedEvidence>::new();
	let mut checksums = HashSet::new();
	let mut duplicates = 0;
	for item in &collected.evidence {
		let e = &item.evidence;
		if checksums.contains(&e.checksum) {
			duplicates += 1;
			continue;
		}
		let entry = format!(
			"[{}] {} — {}; {}; published {}; retrieved {}\n{}\n\n",
			e.evidence_id,
			e.title,
			e.publisher,
			e.source_url,
			e.published_at.as_deref().unwrap_or("undated"),
			e.retrieved_at,
			utf16::truncate(&item.retrieved_text, 4000)
		);
		if pack.len() + entry.len() > pack_budget {
			break;
		}
		pack.push_str(&entry);
		checksums.insert(e.checksum.clone());
		shown.push(item.clone());
	}
	if shown.is_empty() {
		return Ok(failed("MAX_INPUT_BYTES", false, None, None, session.usage));
	}
	let mut summary = collected
		.securities
		.iter()
		.map(|v| {
			format!(
				"security {} {}:{} ({})",
				v.issuer_name,
				v.exchange,
				v.ticker,
				v.country.as_str()
			)
		})
		.collect::<Vec<_>>();
	summary.extend(collected.financial_observations.iter().map(|v| {
		format!(
			"{} = {}",
			v.metric_code.as_str(),
			v.value
				.map(research_js::number::to_js_string)
				.unwrap_or_else(|| format!(
					"unavailable ({})",
					v.unavailable_reason.as_deref().unwrap_or("null")
				))
		)
	}));
	summary.extend(collected.investor_filings.iter().map(|v| {
		format!(
			"{} of {}, period ending {}, filed {}",
			v.form, v.investor_name, v.report_period_end, v.filed_at
		)
	}));
	let summary = summary.join("\n");
	let summary = utf16::truncate(&summary, 8000);
	let summary = if summary.is_empty() {
		"(none)"
	} else {
		&summary
	};
	// Expand only a current-run alias whose full id is actually in the shown pack.
	let shown_ids: HashSet<&str> = shown
		.iter()
		.map(|item| item.evidence.evidence_id.as_str())
		.collect();
	let claim_evidence_id = |id: &str| {
		if shown_ids.contains(id) {
			return id.to_owned();
		}
		let alias = id.strip_prefix("ev").is_some_and(|digits| {
			!digits.is_empty()
				&& !digits.starts_with('0')
				&& digits.bytes().all(|byte| byte.is_ascii_digit())
		});
		let canonical = format!("{}_{id}", input.run_id);
		if alias && shown_ids.contains(canonical.as_str()) {
			canonical
		} else {
			id.to_owned()
		}
	};
	let quote_texts = shown
		.iter()
		.map(|item| EvidenceText {
			evidence_id: item.evidence.evidence_id.clone(),
			retrieved_text: format!(
				"{}\n{}",
				item.evidence.title,
				utf16::truncate(&item.retrieved_text, 4000)
			),
		})
		.collect::<Vec<_>>();
	let quote_index = on_cpu(move || Arc::new(EvidenceIndex::new(&quote_texts))).await?;
	let now = deps.clock.now_iso();
	let mut repair = None;
	let mut analysis = None;
	let mut checked_claims = None;
	let mut analysis_failure = None;
	// The provider's status behind `analysis_failure`, unchanged (§4a); `None` when none.
	let mut analysis_failure_status = None;
	for attempt in 0..2 {
		let attempt_started = std::time::Instant::now();
		let prompt = analysis_prompt(AnalysisPromptInput {
			request: &input.request,
			now_iso: &now,
			evidence_pack: &pack,
			record_summary: summary,
			dataset_guide: &presentation::dataset_guide(&input.run_id),
			existing_components: &input.workspace_components,
			conversation_context: &input.conversation_context,
			fence_token: &(deps.new_fence_token)(),
			repair_note: repair.as_deref(),
		})?;
		let input_bytes = prompt.len();
		let model_turn_started = std::time::Instant::now();
		let reply = session.turn(prompt).await;
		let model_turn_seconds = model_turn_started.elapsed().as_secs_f64();
		let output_bytes = reply.as_ref().ok().map(|turn| turn.text.len());
		let log_attempt = |reason, retryable| {
			deps.reporter.analysis_attempt(AnalysisAttempt {
				attempt: attempt + 1,
				duration_seconds: attempt_started.elapsed().as_secs_f64(),
				model_turn_seconds,
				input_bytes,
				output_bytes,
				reason,
				will_retry: retryable && attempt == 0,
			});
		};
		let turn = match reply {
			Ok(turn) => turn,
			Err(error) => {
				let code = error.code();
				let truncated = code == "PROVIDER_OUTPUT_TRUNCATED";
				let reason = match &error {
					_ if truncated => "output_truncated",
					TurnFailure::Aborted => "aborted",
					TurnFailure::Budget(_) => "budget",
					TurnFailure::UnknownSpend => "unknown-spend",
					TurnFailure::Provider { .. } => "provider",
				};
				log_attempt(reason, truncated);
				if let Some(outcome) = session.terminal(&error) {
					return Ok(outcome);
				}
				analysis_failure = Some(code);
				analysis_failure_status = error.upstream_status();
				// The repair uses the same cumulative budgets as every other turn.
				if truncated && attempt == 0 {
					repair = Some("the provider truncated the previous reply at its output limit. Return a smaller complete JSON object: at most 6 short atomic claims with only the shortest sufficient verbatim supporting quotes; omit optional uiOperations and leave unrelated scenarios, suppliers and pricingPower empty. Prioritize the direct answer and state coverage limitations; do not repeat structured records.".to_owned());
					continue;
				}
				break;
			}
		};
		ui_proposals.extend(turn.ui_proposals);
		let Ok(value) = extract_json_object(&turn.text) else {
			log_attempt("invalid_json", true);
			repair = Some("the reply contained no parseable JSON object".to_owned());
			analysis_failure = Some("ANALYSIS_OUTPUT_INVALID".to_owned());
			analysis_failure_status = None;
			continue;
		};
		match parse_draft("analysis", &value) {
			Ok(value)
				if items(&value, "claims").is_empty()
					&& collected.financial_observations.is_empty()
					&& collected.position_observations.is_empty()
					&& collected.investor_filings.is_empty() =>
			{
				log_attempt("no_claims_without_tool_records", true);
				repair = Some("claims is empty despite retrieved evidence. Answer the question with cited findings or cited exclusions/data limitations for the inspected candidates; use inference for calculations and quote the source inputs. Do not fabricate a match or claim exhaustive coverage.".to_owned());
				analysis_failure = Some("ANALYSIS_OUTPUT_INVALID".to_owned());
				analysis_failure_status = None;
			}
			Ok(value) => {
				if attempt == 0 && !items(&value, "claims").is_empty() {
					let drafts = claim_drafts(&value, claim_evidence_id)?;
					let index = Arc::clone(&quote_index);
					let checked = on_cpu(move || verify_claims_with(&drafts, &index)).await?;
					if checked
						.iter()
						.all(|claim| claim.status == ClaimStatus::Unsupported)
					{
						log_attempt("all_claims_unsupported", true);
						repair = Some(format!(
							"none of the claims has usable quoted support from a shown evidence id. Return at most 6 short atomic claims. Use only the exact ids printed in square brackets in the Evidence section; never invent ids or use an article id. Copy each supporting quote word-for-word from that evidence, including original dates and numbers, and use a passage at least 12 characters long. Never paraphrase a quote, change a year, or join nonadjacent passages. Omit claims you cannot quote. Observation numbers must retain the source digits and units (for example $108.5 billion, not 1085億ドル). A unit conversion is a calculation: use inference and quote the original inputs. Never change source years. Leave unrelated scenarios, suppliers and pricingPower empty. Valid evidence ids: {}",
							research_js::json::stringify(&a(shown
								.iter()
								.take(12)
								.map(|item| s(&item.evidence.evidence_id))
								.collect::<Vec<_>>()))
						));
						analysis_failure = Some("ANALYSIS_OUTPUT_INVALID".to_owned());
						analysis_failure_status = None;
						continue;
					}
					checked_claims = Some(checked);
				}
				log_attempt("accepted", false);
				analysis = Some(value);
				analysis_failure = None;
				analysis_failure_status = None;
				break;
			}
			Err(issues) => {
				log_attempt("invalid_schema", true);
				repair = Some(format!(
					"invalid fields: {}",
					issues
						.iter()
						.take(6)
						.map(|i| i.path.as_str())
						.collect::<Vec<_>>()
						.join(", ")
				));
				analysis_failure = Some("ANALYSIS_OUTPUT_INVALID".to_owned());
				analysis_failure_status = None;
			}
		}
	}
	let mut notes = Vec::new();
	if collection_limit_reached {
		notes.push("Collection was limited to three planning rounds; additional sources may not have been retrieved.".to_owned());
	}
	let omitted = collected.evidence.len() - shown.len();
	if omitted > 0 {
		notes.push(if duplicates>0{format!("{omitted} retrieved item(s) were not analysed: {duplicates} exact duplicate(s) skipped; {} item(s) did not fit the input-size budget.", omitted - duplicates)}else{format!("{omitted} retrieved item(s) did not fit the input-size budget and were not analysed.")});
	}
	if analysis.is_none()
		&& collected.financial_observations.is_empty()
		&& collected.position_observations.is_empty()
		&& collected.investor_filings.is_empty()
	{
		return Ok(failed(
			analysis_failure.as_deref().unwrap_or("ANALYSIS_FAILED"),
			!matches!(
				analysis_failure.as_deref(),
				Some("ANALYSIS_OUTPUT_INVALID" | "PROVIDER_OUTPUT_TRUNCATED")
			),
			None,
			analysis_failure_status,
			session.usage,
		));
	}
	deps.reporter.state(JobState::Verifying).await;
	let analysis = analysis.unwrap_or(Value::Null);

	let mut claims = match checked_claims {
		Some(checked) => checked,
		None if items(&analysis, "claims").is_empty() => Vec::new(),
		None => {
			let drafts = claim_drafts(&analysis, claim_evidence_id)?;
			let index = Arc::clone(&quote_index);
			on_cpu(move || verify_claims_with(&drafts, &index)).await?
		}
	};
	let index = quote_index;
	for claim in &mut claims {
		// Claim IDs label the results, so allocate them only for the accepted draft.
		claim.claim_id = ids_.next_id("cl");
		claim.issues.truncate(24);
	}
	let candidates = claims
		.iter()
		.enumerate()
		.filter(|(_, c)| c.status == ClaimStatus::Supported)
		.map(|(i, c)| {
			(
				i,
				c.text.clone(),
				c.links
					.iter()
					.filter(|l| l.relation == EvidenceRelation::Supports)
					.filter_map(|l| l.quote.as_ref().map(|q| format!("\"{q}\"")))
					.collect::<Vec<_>>()
					.join("\n"),
			)
		})
		.collect::<Vec<_>>();
	let mut verdicts = None;
	if !candidates.is_empty() {
		let token = (deps.new_fence_token)();
		let mut prompt = verification_prompt(&candidates, &token)?;
		if permitted_ids.contains("web.extract") {
			let question =
				fence_untrusted_text("research question", &input.request.question, &token)?;
			prompt.push_str(&format!("

Mark claims unrelated to this question or the requested company as unsupported, even when a passage supports the claim.
{question}"));
		}
		match session.turn(prompt).await {
			Err(error) => {
				if let Some(outcome) = session.terminal(&error) {
					return Ok(outcome);
				}
				notes.push(format!(
					"Independent verification did not run ({}); no claim is reported as supported.",
					error.code()
				));
			}
			Ok(turn) => {
				let parsed = extract_json_object(&turn.text)
					.ok()
					.and_then(|v| parse_draft("verdicts", &v).ok());
				if let Some(v) = parsed {
					verdicts = Some(
						items(&v, "verdicts")
							.iter()
							.map(|v| {
								(
									research_js::number::to_js_string(
										num(get(v, "claimIndex")).unwrap_or_default(),
									),
									field(v, "verdict").to_owned(),
								)
							})
							.collect::<HashMap<_, _>>(),
					);
				} else {
					notes.push("Independent verification returned no usable verdicts; no claim is reported as supported.".to_owned());
				}
			}
		}
	}
	let mut retain = HashSet::new();
	for item in &shown {
		let id = &item.evidence.evidence_id;
		if item.retain_quotes {
			retain.insert(id.clone());
		} else {
			retain.remove(id);
		}
	}
	for (i, claim) in claims.iter_mut().enumerate() {
		if claim.status == ClaimStatus::Supported
			&& verdicts
				.as_ref()
				.and_then(|v| v.get(&i.to_string()))
				.map(String::as_str)
				!= Some("supported")
		{
			claim.status = ClaimStatus::Unsupported;
			claim.issues.push(ClaimIssue::NotIndependentlyVerified);
			claim.issues.truncate(24);
		}
		for link in &mut claim.links {
			if !retain.contains(&link.evidence_id) {
				link.quote = None;
			}
		}
	}
	let claim_values = claims
		.into_iter()
		.map(|c| {
			Ok(o([
				("claimId", s(c.claim_id)),
				("text", s(c.text)),
				("claimType", s(c.claim_type.as_str())),
				("status", s(c.status.as_str())),
				("links", json(&c.links)?),
				("issues", json(&c.issues)?),
			]))
		})
		.collect::<Result<Vec<_>, PipelineError>>()?;
	let records = records::build_records(
		&analysis,
		list(&json(&collected.securities)?).to_vec(),
		&index,
		&retain,
		&input.request.markets,
		ids_.as_ref(),
		&mut notes,
	)?;
	publish::publish(publish::PublishInput {
		input: &input,
		deps: &deps,
		probe: &probe,
		usage: session.usage,
		collected,
		articles,
		claims: claim_values,
		records,
		analysis,
		analysis_failure,
		analysis_failure_status,
		stopped,
		verifier_ran: verdicts.is_some(),
		ui_proposals,
		notes,
		now: &now,
	})
	.await
}

#[cfg(test)]
#[path = "research/tests.rs"]
mod tests;
