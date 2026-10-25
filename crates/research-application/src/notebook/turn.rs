//! Ordered notebook turn orchestration and reply preflight.

use super::{
	NotebookError,
	commands::check_notebook_commands,
	prompts::{NOTEBOOK_PROMPT_BUDGET_BYTES, NotebookAssistPromptInput, notebook_assist_prompt},
};
use crate::{ports::Clock, reporter::PipelineReporter};
use research_agent_core::{
	model_text::{JsonExtractionError, extract_json_object, validate_agent_event},
	runtime::{AgentRunContext, AgentRuntime, Effort, TurnEnd},
};
use research_contracts::{
	agent::{AgentAvailability, AgentEvent, AgentRequest, ToolIsolation},
	jobs::NotebookAssistJob,
	json::{JsonObject, is_bounded_json},
};
use research_domain::jobs::{
	budget::{CostReport, EMPTY_USAGE, ResourceUsage, UsageDelta, add_usage},
	state_machine::JobState,
};
use research_effects::cpu::run_cpu;
use research_js::{json::Value, utf16, whitespace};
use serde::Serialize;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

/// A decoded notebook-assist claim plus cancellation and the owner's isolation opt-in.
pub struct NotebookAssistTurnInput<'a> {
	/// The immutable claim.
	pub job: &'a NotebookAssistJob,
	/// The run's cancellation token.
	pub cancel: &'a CancellationToken,
	/// Explicit owner opt-in; otherwise fail closed on unverified isolation.
	pub allow_unverified_tool_isolation: bool,
}

/// The effect ports used by the notebook turn. No research tools are reachable.
pub struct NotebookAssistTurnDeps<'a> {
	/// Chosen backend.
	pub agent: &'a dyn AgentRuntime,
	/// Injected wall clock.
	pub clock: &'a dyn Clock,
	/// Ordered progress events.
	pub reporter: &'a dyn PipelineReporter,
	/// Fresh unguessable fence token for each model turn.
	pub new_fence_token: &'a (dyn Fn() -> String + Send + Sync),
	/// This job's empty sandbox directory (AGT-004).
	pub scratch_directory: Option<PathBuf>,
}

/// Terminal notebook-turn result, carrying cumulative usage even on failure.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NotebookAssistTurnOutcome {
	/// Prechecked reply and raw, non-removal commands in model order.
	#[serde(rename_all = "camelCase")]
	Assisted {
		/// Trimmed reply for the chat.
		reply: String,
		/// Raw model commands, before schema transforms.
		commands: Vec<JsonObject>,
		/// Unique existing widgets proposed for owner-confirmed removal.
		proposed_removals: Vec<String>,
		/// Claim's notebook version (the API compares it on completion).
		base_version: u64,
		/// Cumulative usage.
		usage: ResourceUsage,
	},
	/// Provider or reply failure.
	#[serde(rename_all = "camelCase")]
	Failed {
		/// Stable failure code.
		failure_code: String,
		/// The model provider's answer status behind `failure_code`,
		/// unchanged (§4a); `None` otherwise.
		failure_upstream_status: Option<u16>,
		/// Whether the server should retry the job.
		retryable: bool,
		/// Cumulative usage.
		usage: ResourceUsage,
	},
	/// Cancellation takes precedence over a provider failure after the stream.
	Cancelled {
		/// Cumulative usage.
		usage: ResourceUsage,
	},
}

struct CheckedTurn {
	reply: String,
	commands: Vec<JsonObject>,
	proposed_removals: Vec<String>,
}
struct CheckFailure {
	code: String,
	message: String,
}
fn rejected(code: &str, message: impl Into<String>) -> CheckFailure {
	CheckFailure {
		code: code.to_owned(),
		message: message.into(),
	}
}
fn invalid(message: impl Into<String>) -> CheckFailure {
	rejected("NOTEBOOK_REPLY_INVALID", message)
}

fn check_turn(job: &NotebookAssistJob, text: &str) -> Result<CheckedTurn, CheckFailure> {
	let json = extract_json_object(text).map_err(|error| {
		invalid(match error {
			JsonExtractionError::NoJsonObject => "the reply contained no parseable JSON object.",
			JsonExtractionError::InvalidJson => "the reply contained malformed JSON.",
		})
	})?;
	let object = json
		.as_object()
		.ok_or_else(|| invalid("the reply is not a reply object."))?;
	// This local reply envelope is not a published contract: only its zod
	// issue paths are observable. Preserve shape order and the final strict-key issue.
	let mut paths = Vec::new();
	if !matches!(object.get("reply"), Some(Value::String(_))) {
		paths.push("reply");
	}
	if !matches!(object.get("commands"), Some(Value::Array(items)) if items.len() <= 12) {
		paths.push("commands");
	}
	if object.keys().any(|key| key != "reply" && key != "commands") {
		paths.push("");
	}
	if !paths.is_empty() {
		let fields = paths.join(", ");
		return Err(invalid(if fields.is_empty() {
			"the reply is not a reply object.".to_owned()
		} else {
			format!("invalid reply fields: {fields}.")
		}));
	}
	let reply = whitespace::trim(
		object
			.get("reply")
			.and_then(Value::as_str)
			.unwrap_or_default(),
	);
	if reply.is_empty() {
		return Err(invalid("the reply text is empty."));
	}
	if utf16::utf16_len(reply) > 2000 {
		return Err(invalid("the reply exceeds 2000 characters."));
	}
	let mut rest = Vec::new();
	let mut removals = Vec::new();
	for command in object
		.get("commands")
		.and_then(Value::as_array)
		.unwrap_or_default()
	{
		if let Some(object) = command.as_object().filter(|_| is_bounded_json(command)) {
			if object.get("kind").and_then(Value::as_str) == Some("remove") {
				let id = object
					.get("widgetId")
					.and_then(Value::as_str)
					.filter(|id| !id.is_empty())
					.ok_or_else(|| {
						invalid("invalid command: \"widgetId\" must be a non-empty string.")
					})?;
				if job.notebook.widgets.iter().any(|w| w.widget_id == id)
					&& !removals.iter().any(|w| w == id)
				{
					removals.push(id.to_owned());
				}
				continue;
			}
		}
		rest.push(command.clone());
	}
	let mut counter = 0;
	check_notebook_commands(&job.notebook, &rest, &mut || {
		counter += 1;
		Some(format!("assist-preview-{counter}"))
	})
	.map_err(|e| rejected(&e.code, format!("command {}: {}", e.index + 1, e.message)))?;
	let commands = rest
		.into_iter()
		.enumerate()
		.map(|(index, mut command)| {
			if !is_bounded_json(&command) {
				return Err(rejected(
					"INVALID_COMMAND",
					format!("command {} is not an object.", index + 1),
				));
			}
			command.take_object().map(JsonObject).ok_or_else(|| {
				rejected(
					"INVALID_COMMAND",
					format!("command {} is not an object.", index + 1),
				)
			})
		})
		.collect::<Result<_, _>>()?;
	Ok(CheckedTurn {
		reply: reply.to_owned(),
		commands,
		proposed_removals: removals,
	})
}

fn failed(
	code: impl Into<String>,
	retryable: bool,
	usage: ResourceUsage,
) -> NotebookAssistTurnOutcome {
	failed_upstream(code, retryable, None, usage)
}

/// A failed outcome carrying the model provider's answer status, unchanged (§4a).
fn failed_upstream(
	code: impl Into<String>,
	retryable: bool,
	upstream_status: Option<u16>,
	usage: ResourceUsage,
) -> NotebookAssistTurnOutcome {
	NotebookAssistTurnOutcome::Failed {
		failure_code: code.into(),
		failure_upstream_status: upstream_status,
		retryable,
		usage,
	}
}

async fn model_turn(
	input: &NotebookAssistTurnInput<'_>,
	deps: &NotebookAssistTurnDeps<'_>,
	prompt: String,
	usage: &mut ResourceUsage,
) -> Result<Result<String, NotebookAssistTurnOutcome>, NotebookError> {
	if input.cancel.is_cancelled() {
		return Ok(Err(NotebookAssistTurnOutcome::Cancelled { usage: *usage }));
	}
	*usage = add_usage(
		usage,
		&UsageDelta {
			agent_steps: 1,
			input_bytes: u64::try_from(prompt.len()).map_err(|_| NotebookError::PromptLength)?,
			..UsageDelta::default()
		},
	);
	// `new Date(nowMs + 600_000).toISOString()` throws a RangeError for a clock beyond
	// the JavaScript date range; the TypeScript catches it with the adapter's throws
	// and reports a retryable `AGENT_THREW_RangeError`, so this does too.
	let deadline = deps
		.clock
		.now_ms()
		.checked_add(600_000)
		.and_then(research_js::date::epoch_ms_to_iso);
	let effort = match input.job.agent.effort {
		research_contracts::jobs::Effort::Low => Effort::Low,
		research_contracts::jobs::Effort::Medium => Effort::Medium,
		research_contracts::jobs::Effort::High => Effort::High,
	};
	let context = AgentRunContext {
		cancel: input.cancel.clone(),
		scratch_directory: deps.scratch_directory.clone(),
		model: input.job.agent.model.clone(),
		effort,
	};
	let mut reported = CostReport::Unknown;
	let mut failure = None;
	let mut finished = false;
	let mut text = String::new();
	let mut units = 0;
	let started = deadline.map(|deadline| {
		let request = AgentRequest {
			run_id: input.job.lease.run_id.clone(),
			conversation_id: input.job.workspace_id.clone(),
			prompt,
			permitted_tool_ids: Vec::new(),
			max_tool_calls: 0,
			deadline,
		};
		catch_unwind(AssertUnwindSafe(|| deps.agent.run(request, context)))
	});
	match started {
		None => failure = Some(("AGENT_THREW_RangeError".to_owned(), true, None)),
		Some(Err(_)) => {
			failure = Some(("AGENT_THREW_Panic".to_owned(), true, None));
		}
		Some(Ok(mut turn)) => {
			while let Some(event) = turn.next().await {
				// The shared event helper serializes typed events before decoding;
				// JSON.stringify turns nonfinite numbers into null. Validate those
				// original values first so malformed adapter events still fail closed.
				let raw_valid = match &event {
					AgentEvent::Usage {
						known_cost_usd: Some(cost),
					} => cost.is_finite(),
					AgentEvent::ToolRequest { args, .. } => is_bounded_json(&args.0),
					AgentEvent::UiCommand { command } => is_bounded_json(&command.0),
					_ => true,
				};
				if !raw_valid {
					failure = Some(("AGENT_EVENT_INVALID".to_owned(), false, None));
					break;
				}

				let Ok(event) = validate_agent_event(&event) else {
					failure = Some(("AGENT_EVENT_INVALID".to_owned(), false, None));
					break;
				};
				match event {
					AgentEvent::TextDelta { text: delta } => {
						units += utf16::utf16_len(&delta);
						text.push_str(&delta);
						if units > 400_000 {
							failure = Some(("AGENT_OUTPUT_TOO_LARGE".to_owned(), false, None));
							break;
						}
					}
					AgentEvent::Usage { known_cost_usd } => {
						reported = known_cost_usd.map_or(CostReport::Unknown, CostReport::Usd);
					}
					AgentEvent::Failed {
						code,
						retryable,
						upstream_status,
					} => {
						failure = Some((code, retryable, upstream_status));
						break;
					}
					AgentEvent::Completed => {
						finished = true;
						break;
					}
					// Tool and UI events are ignored: the notebook has no tools.
					_ => {}
				}
			}
			if turn.close().await == TurnEnd::Panicked {
				failure = Some(("AGENT_THREW_Panic".to_owned(), true, None));
			}
		}
	}
	*usage = add_usage(
		usage,
		&UsageDelta {
			cost_usd: reported,
			..UsageDelta::default()
		},
	);
	deps.reporter.usage(usage).await;
	if input.cancel.is_cancelled() {
		return Ok(Err(NotebookAssistTurnOutcome::Cancelled { usage: *usage }));
	}
	if let Some((code, retryable, upstream_status)) = failure {
		return Ok(Err(failed_upstream(
			code,
			retryable,
			upstream_status,
			*usage,
		)));
	}
	if !finished {
		return Ok(Err(failed("AGENT_STREAM_ENDED_EARLY", true, *usage)));
	}
	Ok(Ok(text))
}

async fn prompt(
	job: &NotebookAssistJob,
	token: String,
	repair: Option<String>,
) -> Result<String, NotebookError> {
	let build = move |job: &NotebookAssistJob| {
		notebook_assist_prompt(&NotebookAssistPromptInput {
			notebook: &job.notebook,
			selected_widget_ids: &job.selected_widget_ids,
			instruction: &job.instruction,
			conversation_context: &job.conversation_context,
			fence_token: &token,
			repair_note: repair.as_deref(),
		})
	};
	if job.notebook.widgets.is_empty() {
		return build(job);
	}
	let job = job.clone();
	// Widget count says nothing about size (twelve charts reach the 850 KB cap), and the
	// prompt build and command check fan out on rayon: any non-empty notebook runs on the
	// rayon pool (`run_cpu`, which also turns a panic into an error) so neither CPU work nor a rayon join ever occupies a tokio worker.
	run_cpu(move || build(&job)).await?
}

/// Runs one notebook-assist job, including at most one repair. All progress
/// events are awaited inline in the Lean-proved state-machine order.
///
/// # Errors
/// Infrastructure/programming failures (normal model failures are outcomes).
pub async fn run_notebook_assist_turn(
	input: &NotebookAssistTurnInput<'_>,
	deps: &NotebookAssistTurnDeps<'_>,
) -> Result<NotebookAssistTurnOutcome, NotebookError> {
	let mut usage = EMPTY_USAGE;
	if input.cancel.is_cancelled() {
		return Ok(NotebookAssistTurnOutcome::Cancelled { usage });
	}
	if let AgentAvailability::Unavailable { reason_code, .. } =
		deps.agent.probe().await.availability
	{
		return Ok(failed(
			format!("AGENT_UNAVAILABLE_{}", reason_code.as_str()),
			false,
			usage,
		));
	}
	if deps.agent.tool_isolation() != ToolIsolation::Enforced
		&& !input.allow_unverified_tool_isolation
	{
		return Ok(failed("TOOL_ISOLATION_UNVERIFIED", false, usage));
	}
	deps.reporter.state(JobState::Planning).await;
	// Every stage is reported even with no tools; skipping a stage makes the API reject completion.
	deps.reporter.state(JobState::Collecting).await;
	let first = prompt(input.job, (deps.new_fence_token)(), None).await?;
	if first.len() > NOTEBOOK_PROMPT_BUDGET_BYTES {
		return Ok(failed("NOTEBOOK_PROMPT_TOO_LARGE", false, usage));
	}
	deps.reporter.state(JobState::Analyzing).await;
	let text = match model_turn(input, deps, first, &mut usage).await? {
		Ok(text) => text,
		Err(outcome) => return Ok(outcome),
	};
	deps.reporter.state(JobState::Verifying).await;
	let mut checked = check_async(input.job, text).await?;
	if let Err(rejection) = checked {
		deps.reporter
			.note(&format!(
				"The first reply was rejected ({}); asking for corrected JSON.",
				rejection.code
			))
			.await;
		if input.cancel.is_cancelled() {
			return Ok(NotebookAssistTurnOutcome::Cancelled { usage });
		}
		let repair = prompt(
			input.job,
			(deps.new_fence_token)(),
			Some(format!("{}: {}", rejection.code, rejection.message)),
		)
		.await?;
		if repair.len() > NOTEBOOK_PROMPT_BUDGET_BYTES {
			return Ok(failed("NOTEBOOK_PROMPT_TOO_LARGE", false, usage));
		}
		let text = match model_turn(input, deps, repair, &mut usage).await? {
			Ok(text) => text,
			Err(outcome) => return Ok(outcome),
		};
		checked = check_async(input.job, text).await?;
	}
	match checked {
		Err(_) => Ok(failed("NOTEBOOK_REPLY_INVALID", false, usage)),
		Ok(checked) => {
			deps.reporter.state(JobState::Publishing).await;
			Ok(NotebookAssistTurnOutcome::Assisted {
				reply: checked.reply,
				commands: checked.commands,
				proposed_removals: checked.proposed_removals,
				base_version: input.job.notebook_version,
				usage,
			})
		}
	}
}

async fn check_async(
	job: &NotebookAssistJob,
	text: String,
) -> Result<Result<CheckedTurn, CheckFailure>, NotebookError> {
	if job.notebook.widgets.is_empty() {
		return Ok(check_turn(job, &text));
	}
	let job = job.clone();
	Ok(run_cpu(move || check_turn(&job, &text)).await?)
}
