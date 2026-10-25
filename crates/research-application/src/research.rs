//! Evidence-first research lifecycle. The model proposes; this pipeline
//! authorizes, verifies and publishes under the owner's cumulative ceilings.
mod collect;
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
		AnalysisPromptInput, PLANNING_PROMPT_BUDGET_BYTES, PLANNING_REMINDER, PlanningPromptInput,
		analysis_prompt, planning_prompt, verification_prompt,
	},
	turn::{Session, TurnFailure},
	value::*,
};
use crate::{
	ports::Clock,
	reporter::{PipelineReporter, ToolCallOutcome},
};
use research_agent_core::{
	authorize::{
		ToolDenialCode, ToolPolicy, ToolRegistry, ToolRequest, authorize_tool_call,
		execute_tool_call,
	},
	model_text::extract_json_object,
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
	let mut reminder = None;
	let mut reached_collecting = false;
	let mut tool_errors = HashMap::<String, u64>::new();
	// Per tool error code: each upstream status seen, how often and the index
	// of its latest call — for `ALL_TOOL_CALLS_FAILED` (§4a rule 6).
	let mut tool_error_statuses = tool_status::ToolErrorStatuses::default();
	let mut completed_requests = HashSet::new();
	let mut unavailable_tools = HashSet::new();
	let mut collection_limit_reached = false;
	'collection: for step in 0..collection_steps {
		if step >= 3 {
			collection_limit_reached = true;
			deps.reporter
				.note("Collection stopped after three planning rounds.")
				.await;
			break;
		}
		let remaining_calls = budget
			.max_tool_calls
			.saturating_sub(session.usage.tool_calls);
		if remaining_calls == 0 {
			break;
		}
		let prompt = planning_prompt(PlanningPromptInput {
			request: &input.request,
			now_iso: &deps.clock.now_iso(),
			tools: &permitted,
			sources: &input.sources,
			collected_so_far: &collected_so_far_text(&entries, step),
			remaining_tool_calls: remaining_calls,
			conversation_context: &input.conversation_context,
			fence_token: &(deps.new_fence_token)(),
			prompt_budget_bytes: PLANNING_PROMPT_BUDGET_BYTES,
			reminder: reminder.take(),
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
		for call in &calls {
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
						break 'collection;
					}
					continue;
				}
			};
			let request_key = format!(
				"{}\n{}",
				call.tool_id,
				research_js::json::stringify(&authorized.args)
			);
			if completed_requests.contains(&request_key)
				|| unavailable_tools.contains(&call.tool_id)
			{
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
			let delta = UsageDelta {
				tool_calls: 1,
				..UsageDelta::default()
			};
			if let Err(limit) = check_budget(budget, &session.usage, session.elapsed(), &delta) {
				stopped = Some(limit);
				break 'collection;
			}
			session.usage = add_usage(&session.usage, &delta);
			let remaining_ms = i128::from(budget.max_wall_clock_ms) - i128::from(session.elapsed());
			let remaining_ms = u64::try_from(remaining_ms.max(1)).unwrap_or(u64::MAX);
			let call_cancel = input.cancel.child_token();
			let _guard = call_cancel.clone().drop_guard();
			let mut context = tool_context.clone();
			context.cancel = call_cancel;
			// Biased: when the run's deadline and the tool finish together, the deadline wins.
			// Losing the race drops the tool's future (ADR-0030 C3).
			let raced = tokio::select! {
				biased;
				() = tokio::time::sleep(Duration::from_millis(remaining_ms)) => None,
				result = execute_tool_call(authorized, context) => Some(result),
			};
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
					if matches!(error.code.as_str(), "NOT_CONFIGURED" | "SEARCH_COOLDOWN") {
						unavailable_tools.insert(call.tool_id.clone());
					}
					let code =
						sanitize_tool_error_code(&utf16::truncate(&error.code, 80)).to_owned();
					tool_error_statuses.record(&code, error.upstream_status, executed);
					*tool_errors.entry(code).or_default() += 1;
					deps.reporter
						.tool(
							&label,
							ToolCallOutcome::Failed,
							&utf16::truncate(&error.code, 300),
						)
						.await;
					let note = format!("Tool {label} failed: {}.", error.code);
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
					collected.evidence.extend(output.evidence);
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
							&format!("{count} evidence item(s)"),
						)
						.await;
				}
			}
		}
		deps.reporter.usage(&session.usage).await;
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
		let (code, detail) = if executed > 0 && succeeded == 0 {
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
			"[{}] {} — {}; published {}; retrieved {}\n{}\n\n",
			e.evidence_id,
			e.title,
			e.publisher,
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
	let now = deps.clock.now_iso();
	let mut repair = None;
	let mut analysis = None;
	let mut analysis_failure = None;
	// The provider's status behind `analysis_failure`, unchanged (§4a); `None` when none.
	let mut analysis_failure_status = None;
	for _ in 0..2 {
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
		let turn = match session.turn(prompt).await {
			Ok(turn) => turn,
			Err(error) => {
				if let Some(outcome) = session.terminal(&error) {
					return Ok(outcome);
				}
				analysis_failure = Some(error.code());
				analysis_failure_status = error.upstream_status();
				break;
			}
		};
		ui_proposals.extend(turn.ui_proposals);
		let Ok(value) = extract_json_object(&turn.text) else {
			repair = Some("the reply contained no parseable JSON object".to_owned());
			analysis_failure = Some("ANALYSIS_OUTPUT_INVALID".to_owned());
			analysis_failure_status = None;
			continue;
		};
		match parse_draft("analysis", &value) {
			Ok(value) => {
				analysis = Some(value);
				analysis_failure = None;
				analysis_failure_status = None;
				break;
			}
			Err(issues) => {
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
		notes.push(if duplicates>0{format!("{omitted} retrieved item(s) were not analysed: {duplicates} exact duplicate(s) skipped and the rest did not fit the input-size budget.")}else{format!("{omitted} retrieved item(s) did not fit the input-size budget and were not analysed.")});
	}
	if analysis.is_none()
		&& collected.financial_observations.is_empty()
		&& collected.position_observations.is_empty()
		&& collected.investor_filings.is_empty()
	{
		return Ok(failed(
			analysis_failure.as_deref().unwrap_or("ANALYSIS_FAILED"),
			analysis_failure.as_deref() != Some("ANALYSIS_OUTPUT_INVALID"),
			None,
			analysis_failure_status,
			session.usage,
		));
	}
	deps.reporter.state(JobState::Verifying).await;
	let analysis = analysis.unwrap_or(Value::Null);
	let mut drafts = Vec::new();
	for v in items(&analysis, "claims") {
		let mut links = Vec::new();
		for link in items(v, "evidence") {
			links.push(DraftEvidenceLink {
				evidence_id: field(link, "evidenceId").to_owned(),
				relation: research_contracts::validate::<EvidenceRelation>(get(link, "relation"))?,
				quote: get(link, "quote")
					.as_str()
					.filter(|s| !s.is_empty())
					.map(str::to_owned),
			});
		}
		drafts.push(DraftClaim {
			claim_id: ids_.next_id("cl"),
			text: field(v, "text").to_owned(),
			claim_type: research_contracts::validate::<ClaimType>(get(v, "claimType"))?,
			links,
		});
	}
	let texts = shown
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
	// CPU work leaves the tokio worker; a panic is an error, not a process abort.
	let (index, mut claims) = on_cpu(move || {
		let index = EvidenceIndex::new(&texts);
		let claims = verify_claims_with(&drafts, &index);
		(index, claims)
	})
	.await?;
	for claim in &mut claims {
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
		let prompt = verification_prompt(&candidates, &(deps.new_fence_token)())?;
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
