//! The company-summary turn (ADR-0060, port of
//! `packages/application/src/companySummaryTurn.ts`): one model turn (plus
//! at most one repair turn) writes a short description of the company and
//! its investment themes, in English and Japanese, from the stored facts the
//! claim carries. No tools, no network.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use research_agent_core::model_text::{
	JsonExtractionError, extract_json_object, fence_untrusted_text, validate_agent_event,
};
use research_agent_core::runtime::{AgentRunContext, AgentRuntime, Effort, TurnEnd};
use research_contracts::agent::{AgentAvailability, AgentEvent, AgentRequest, ToolIsolation};
use research_contracts::company_summary::{CompanySummary, CompanySummaryFacts, limits};
use research_contracts::jobs::CompanySummaryJob;
use research_contracts::json::is_bounded_json;
use research_contracts::{ContractError, validate};
use research_domain::jobs::budget::{
	CostReport, EMPTY_USAGE, ResourceUsage, UsageDelta, add_usage,
};
use research_domain::jobs::state_machine::JobState;
use research_js::utf16;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::ports::Clock;
use crate::reporter::PipelineReporter;

/// First line of every company-summary prompt; the scripted agent keys on it.
pub const COMPANY_SUMMARY_TURN_MARKER: &str = "COMPANY SUMMARY TURN v1";

/// Absolute ceiling for a company-summary prompt in UTF-8 bytes: over it the turn fails closed.
pub const COMPANY_SUMMARY_PROMPT_BUDGET_BYTES: usize = 32_000;

/// Longest model reply, in UTF-16 units (`text.length`).
const MAX_MODEL_OUTPUT_UNITS: usize = 100_000;

/// How long one model turn may take.
const TURN_DEADLINE_MS: i64 = 600_000;

/// Issues the repair note quotes at most.
const MAX_QUOTED_ISSUES: usize = 6;

/// An infrastructure/programming failure outside the model's normal rejection path.
#[derive(Debug, thiserror::Error)]
pub enum CompanySummaryError {
	/// An unguessable, nonempty fence is required (AGT-007).
	#[error("the company-summary fence token is empty")]
	EmptyFence,
	/// A prompt's byte length does not fit the usage counter.
	#[error("the company-summary prompt length does not fit the usage counter")]
	PromptLength,
}

/// The prompt of one turn (`companySummaryPrompt`).
pub struct CompanySummaryPromptInput<'a> {
	/// The Watchlist stock.
	pub stock_id: &'a str,
	/// The stored facts (each fenced: they came from outside).
	pub facts: &'a CompanySummaryFacts,
	/// Fresh unguessable nonempty token.
	pub fence_token: &'a str,
	/// Why the previous reply was rejected.
	pub repair_note: Option<&'a str>,
}

/// Builds the prompt byte for byte like the TypeScript `companySummaryPrompt`.
///
/// # Errors
/// [`CompanySummaryError::EmptyFence`] for an empty fence token with a fact to fence.
pub fn company_summary_prompt(
	input: &CompanySummaryPromptInput<'_>,
) -> Result<String, CompanySummaryError> {
	let mut lines: Vec<String> = [
		COMPANY_SUMMARY_TURN_MARKER,
		"",
		"You write a short, neutral company summary for an investor's stock page.",
		"Describe what the company does: its main businesses, products or services, and where it earns its revenue.",
	]
	.into_iter()
	.map(str::to_owned)
	.collect();
	lines.push(format!(
		"Then list {} to {} investment themes the company belongs to",
		limits::MIN_THEMES,
		limits::MAX_THEMES
	));
	lines.extend(
		[
			"(short tags investors use to group stocks, such as AI, Semiconductors, EV, Cloud, Defense, Inbound tourism).",
			"Rely on the facts below; use your own knowledge only for what they leave out, and do not invent figures.",
			"No investment advice, no price targets, no forecasts.",
			"",
			"Write everything twice: in English (en) and in natural Japanese (ja).",
		]
		.into_iter()
		.map(str::to_owned),
	);
	lines.push(format!(
		"Each description: 2 to 4 sentences, at most {} characters.",
		limits::MAX_DESCRIPTION_CHARS
	));
	lines.push(format!(
		"Each theme: at most {} characters, a noun phrase, no trailing punctuation.",
		limits::MAX_THEME_CHARS
	));
	lines.extend(
		[
			"",
			"Answer with ONE JSON object and nothing else, exactly this shape:",
			r#"{"description": {"en": "...", "ja": "..."}, "themes": [{"en": "...", "ja": "..."}]}"#,
			"",
			"Facts:",
		]
		.into_iter()
		.map(str::to_owned),
	);
	lines.push(format!("Stock: {}", input.stock_id));
	let facts = input.facts;
	for (label, value) in [
		("Company name", &facts.name),
		("Local (Japanese) name", &facts.local_name),
		("Listing", &facts.listing),
		("Sector (TSE 33-sector, 17-sector)", &facts.sector),
		(
			"Start of the business section of the latest annual report",
			&facts.business_excerpt,
		),
	] {
		if let Some(value) = value {
			lines.push(
				fence_untrusted_text(label, value, input.fence_token)
					.map_err(|_| CompanySummaryError::EmptyFence)?,
			);
		}
	}
	if let Some(note) = input.repair_note {
		lines.push(String::new());
		lines.push(format!(
			"Your previous answer was rejected: {note} Answer again with valid JSON."
		));
	}
	Ok(lines.join("\n"))
}

/// The model's reply as a summary, or why it is not one
/// (`checkCompanySummaryReply`; the message quotes zod's first six issues).
///
/// # Errors
/// The rejection message for the repair prompt.
pub fn check_company_summary_reply(text: &str) -> Result<CompanySummary, String> {
	let value = extract_json_object(text).map_err(|error| {
		match error {
			JsonExtractionError::NoJsonObject => "the reply contained no parseable JSON object.",
			JsonExtractionError::InvalidJson => "the reply contained malformed JSON.",
		}
		.to_owned()
	})?;
	validate::<CompanySummary>(&value).map_err(|error| {
		let fields = match error {
			ContractError::Invalid(issues) => issues
				.iter()
				.take(MAX_QUOTED_ISSUES)
				.map(|issue| format!("{} ({})", issue.path_string("."), issue.message))
				.collect::<Vec<_>>()
				.join(", "),
			// `validate` never parses text, so it never reports a JSON error.
			ContractError::Json(error) => error.to_string(),
		};
		format!("invalid fields: {fields}.")
	})
}

/// A decoded company-summary claim plus cancellation and the owner's isolation opt-in.
pub struct CompanySummaryTurnInput<'a> {
	/// The immutable claim.
	pub job: &'a CompanySummaryJob,
	/// The run's cancellation token.
	pub cancel: &'a CancellationToken,
	/// Explicit owner opt-in; otherwise fail closed on unverified isolation.
	pub allow_unverified_tool_isolation: bool,
}

/// The effect ports used by the turn. No research tools are reachable.
pub struct CompanySummaryTurnDeps<'a> {
	/// Chosen backend.
	pub agent: &'a dyn AgentRuntime,
	/// Injected wall clock.
	pub clock: &'a dyn Clock,
	/// Ordered progress events.
	pub reporter: &'a dyn PipelineReporter,
	/// Fresh unguessable fence token for each prompt.
	pub new_fence_token: &'a (dyn Fn() -> String + Send + Sync),
	/// This job's empty sandbox directory (AGT-004).
	pub scratch_directory: Option<PathBuf>,
}

/// Terminal turn result, carrying cumulative usage even on failure.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompanySummaryTurnOutcome {
	/// The checked summary.
	Summarized {
		/// The summary, trimmed as the schema parses it.
		summary: CompanySummary,
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

fn failed(
	code: impl Into<String>,
	retryable: bool,
	upstream_status: Option<u16>,
	usage: ResourceUsage,
) -> CompanySummaryTurnOutcome {
	CompanySummaryTurnOutcome::Failed {
		failure_code: code.into(),
		failure_upstream_status: upstream_status,
		retryable,
		usage,
	}
}

/// One model turn with no tools: the reply text, or the outcome that ends the job.
async fn model_turn(
	input: &CompanySummaryTurnInput<'_>,
	deps: &CompanySummaryTurnDeps<'_>,
	prompt: String,
	usage: &mut ResourceUsage,
) -> Result<Result<String, CompanySummaryTurnOutcome>, CompanySummaryError> {
	if input.cancel.is_cancelled() {
		return Ok(Err(CompanySummaryTurnOutcome::Cancelled { usage: *usage }));
	}
	*usage = add_usage(
		usage,
		&UsageDelta {
			agent_steps: 1,
			input_bytes: u64::try_from(prompt.len())
				.map_err(|_| CompanySummaryError::PromptLength)?,
			..UsageDelta::default()
		},
	);
	// `new Date(nowMs + 600_000).toISOString()` throws a RangeError beyond the
	// JavaScript date range; the TypeScript catches it as a retryable
	// `AGENT_THREW_RangeError`, so this does too.
	let deadline = deps
		.clock
		.now_ms()
		.checked_add(TURN_DEADLINE_MS)
		.and_then(research_js::date::epoch_ms_to_iso);
	let job = input.job;
	let effort = match job.agent.effort {
		research_contracts::jobs::Effort::Low => Effort::Low,
		research_contracts::jobs::Effort::Medium => Effort::Medium,
		research_contracts::jobs::Effort::High => Effort::High,
	};
	let context = AgentRunContext {
		cancel: input.cancel.clone(),
		scratch_directory: deps.scratch_directory.clone(),
		model: job.agent.model.clone(),
		effort,
	};
	let mut reported = CostReport::Unknown;
	let mut failure: Option<(String, bool, Option<u16>)> = None;
	let mut finished = false;
	let mut text = String::new();
	let mut units = 0;
	let started = deadline.map(|deadline| {
		let request = AgentRequest {
			run_id: job.lease.run_id.clone(),
			conversation_id: job.lease.run_id.clone(),
			prompt,
			permitted_tool_ids: Vec::new(),
			max_tool_calls: 0,
			deadline,
		};
		catch_unwind(AssertUnwindSafe(|| deps.agent.run(request, context)))
	});
	match started {
		None => failure = Some(("AGENT_THREW_RangeError".to_owned(), true, None)),
		Some(Err(_)) => failure = Some(("AGENT_THREW_Panic".to_owned(), true, None)),
		Some(Ok(mut turn)) => {
			while let Some(event) = turn.next().await {
				// Nonfinite numbers and unbounded JSON fail closed before the
				// shared decoder sees them (as `parseAgentEvent` would).
				let raw_valid = match &event {
					AgentEvent::Usage {
						known_cost_usd: Some(cost),
					} => cost.is_finite(),
					AgentEvent::ToolRequest { args, .. } => is_bounded_json(&args.0),
					AgentEvent::UiCommand { command } => is_bounded_json(&command.0),
					_ => true,
				};
				let Some(event) = raw_valid
					.then(|| validate_agent_event(&event).ok())
					.flatten()
				else {
					failure = Some(("AGENT_EVENT_INVALID".to_owned(), false, None));
					break;
				};
				match event {
					AgentEvent::TextDelta { text: delta } => {
						units += utf16::utf16_len(&delta);
						text.push_str(&delta);
						if units > MAX_MODEL_OUTPUT_UNITS {
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
					// Tool and UI events are ignored: the turn has no tools.
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
		return Ok(Err(CompanySummaryTurnOutcome::Cancelled { usage: *usage }));
	}
	if let Some((code, retryable, upstream_status)) = failure {
		return Ok(Err(failed(code, retryable, upstream_status, *usage)));
	}
	if !finished {
		return Ok(Err(failed("AGENT_STREAM_ENDED_EARLY", true, None, *usage)));
	}
	Ok(Ok(text))
}

fn prompt(
	job: &CompanySummaryJob,
	fence_token: &str,
	repair_note: Option<&str>,
) -> Result<String, CompanySummaryError> {
	company_summary_prompt(&CompanySummaryPromptInput {
		stock_id: &job.stock_id,
		facts: &job.facts,
		fence_token,
		repair_note,
	})
}

/// Runs one company-summary job (`runCompanySummaryTurn`), including at most
/// one repair. Progress states are reported in the job state machine's order.
///
/// # Errors
/// Infrastructure/programming failures (normal model failures are outcomes).
pub async fn run_company_summary_turn(
	input: &CompanySummaryTurnInput<'_>,
	deps: &CompanySummaryTurnDeps<'_>,
) -> Result<CompanySummaryTurnOutcome, CompanySummaryError> {
	let mut usage = EMPTY_USAGE;
	if input.cancel.is_cancelled() {
		return Ok(CompanySummaryTurnOutcome::Cancelled { usage });
	}
	if let AgentAvailability::Unavailable { reason_code, .. } =
		deps.agent.probe().await.availability
	{
		return Ok(failed(
			format!("AGENT_UNAVAILABLE_{}", reason_code.as_str()),
			false,
			None,
			usage,
		));
	}
	if deps.agent.tool_isolation() != ToolIsolation::Enforced
		&& !input.allow_unverified_tool_isolation
	{
		return Ok(failed("TOOL_ISOLATION_UNVERIFIED", false, None, usage));
	}
	// collecting = the facts into a prompt, analyzing = the model turn,
	// verifying = checking its JSON (and the one repair turn), publishing =
	// handing the summary to the API.
	deps.reporter.state(JobState::Planning).await;
	deps.reporter.state(JobState::Collecting).await;
	let first = prompt(input.job, &(deps.new_fence_token)(), None)?;
	if first.len() > COMPANY_SUMMARY_PROMPT_BUDGET_BYTES {
		return Ok(failed(
			"COMPANY_SUMMARY_PROMPT_TOO_LARGE",
			false,
			None,
			usage,
		));
	}
	deps.reporter.state(JobState::Analyzing).await;
	let text = match model_turn(input, deps, first, &mut usage).await? {
		Ok(text) => text,
		Err(outcome) => return Ok(outcome),
	};
	deps.reporter.state(JobState::Verifying).await;
	let rejection = match check_company_summary_reply(&text) {
		Ok(summary) => {
			deps.reporter.state(JobState::Publishing).await;
			return Ok(CompanySummaryTurnOutcome::Summarized { summary, usage });
		}
		Err(message) => message,
	};
	deps.reporter
		.note("The first reply was rejected; asking for corrected JSON.")
		.await;
	let repair = prompt(input.job, &(deps.new_fence_token)(), Some(&rejection))?;
	if repair.len() > COMPANY_SUMMARY_PROMPT_BUDGET_BYTES {
		return Ok(failed(
			"COMPANY_SUMMARY_PROMPT_TOO_LARGE",
			false,
			None,
			usage,
		));
	}
	let text = match model_turn(input, deps, repair, &mut usage).await? {
		Ok(text) => text,
		Err(outcome) => return Ok(outcome),
	};
	match check_company_summary_reply(&text) {
		Ok(summary) => {
			deps.reporter.state(JobState::Publishing).await;
			Ok(CompanySummaryTurnOutcome::Summarized { summary, usage })
		}
		Err(_) => Ok(failed("COMPANY_SUMMARY_REPLY_INVALID", false, None, usage)),
	}
}

#[cfg(test)]
mod tests;
