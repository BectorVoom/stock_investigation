//! Model turn boundary, cumulative usage and owner spend approval (AGT-008).
use super::{PipelineOutcome, ResearchPipelineDeps, ResearchPipelineInput};
use futures_util::FutureExt;
use research_agent_core::{
	authorize::ToolRequest,
	model_text::validate_agent_event,
	runtime::{AgentRunContext, Effort, TurnEnd},
};
use research_contracts::{
	agent::{AgentEvent, AgentRequest, CostModel},
	jobs::ApprovalRequest,
};
use research_domain::jobs::budget::{
	BudgetLimit, CostReport, ResourceUsage, UsageDelta, add_usage, check_budget,
};
use research_js::{
	json::Value,
	number::{to_fixed, to_js_string},
	utf16,
};
use std::panic::AssertUnwindSafe;

/// How long a cancelled adapter stream may keep delivering events.
const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

pub(super) enum TurnFailure {
	Aborted,
	UnknownSpend,
	Budget(BudgetLimit),
	Provider {
		code: String,
		retryable: bool,
		/// The provider API's answer status, unchanged; `None` when no answer
		/// caused the failure (docs/rule/error_handling.md §4a).
		upstream_status: Option<u16>,
	},
}
impl TurnFailure {
	pub(super) fn code(&self) -> String {
		match self {
			Self::Aborted => "TOOL_ABORTED".to_owned(),
			Self::UnknownSpend => "METERED_COST_UNKNOWN".to_owned(),
			Self::Budget(limit) => limit.as_str().to_owned(),
			Self::Provider { code, .. } => code.clone(),
		}
	}
	/// The provider's answer status behind a turn failure, unchanged (§4a);
	/// a budget stop, an unknown spend or an abort is ours and carries none.
	pub(super) const fn upstream_status(&self) -> Option<u16> {
		match self {
			Self::Provider {
				upstream_status, ..
			} => *upstream_status,
			_ => None,
		}
	}
}
pub(super) struct Turn {
	pub text: String,
	pub tool_requests: Vec<ToolRequest>,
	pub ui_proposals: Vec<Value>,
}
pub(super) struct Session<'a> {
	pub input: &'a ResearchPipelineInput,
	pub deps: &'a ResearchPipelineDeps,
	pub usage: ResourceUsage,
	pub started: i64,
	pub deadline: String,
	pub largest_cost: f64,
	pub permitted_ids: Vec<String>,
}
impl Session<'_> {
	pub(super) fn elapsed(&self) -> i64 {
		self.deps.clock.now_ms().saturating_sub(self.started)
	}
	pub(super) fn terminal(&self, failure: &TurnFailure) -> Option<PipelineOutcome> {
		let approval = match failure {
			TurnFailure::Aborted => {
				return Some(PipelineOutcome::Cancelled { usage: self.usage });
			}
			TurnFailure::UnknownSpend => ApprovalRequest {
				reason_code: "METERED_COST_UNKNOWN".to_owned(),
				detail: "A metered request did not report its cost, so total spend is unknown. Approve to continue.".to_owned(),
			},
			TurnFailure::Budget(BudgetLimit::MaxSpend) => ApprovalRequest {
				reason_code: "SPEND_LIMIT_REACHED".to_owned(),
				detail: format!(
					"Metered spend is {} USD of the authorized {} USD; the next request could exceed it.",
					to_fixed(self.usage.known_cost_usd, 4),
					to_js_string(self.input.request.budget.max_spend_usd.unwrap_or(0.0))
				),
			},
			_ => return None,
		};
		Some(PipelineOutcome::WaitingApproval {
			approval_request: approval,
			usage: self.usage,
		})
	}
	pub(super) async fn turn(&mut self, prompt: String) -> Result<Turn, TurnFailure> {
		if self.input.cancel.is_cancelled() {
			return Err(TurnFailure::Aborted);
		}
		let budget = &self.input.request.budget;
		let metered = self.deps.agent.cost_model() == CostModel::Metered;
		if metered
			&& self.input.request.budget.max_spend_usd.is_some()
			&& self.usage.has_unmetered_usage
		{
			return Err(TurnFailure::UnknownSpend);
		}
		let delta = UsageDelta {
			agent_steps: 1,
			input_bytes: u64::try_from(prompt.len()).unwrap_or(u64::MAX),
			cost_usd: CostReport::Usd(if metered { self.largest_cost } else { 0.0 }),
			..UsageDelta::default()
		};
		check_budget(budget, &self.usage, self.elapsed(), &delta).map_err(TurnFailure::Budget)?;
		self.usage = add_usage(
			&self.usage,
			&UsageDelta {
				cost_usd: CostReport::NotGiven,
				..delta
			},
		);
		let mut result = Turn {
			text: String::new(),
			tool_requests: vec![],
			ui_proposals: vec![],
		};
		let mut units = 0;
		let mut reported = None;
		let mut failure = None;
		let mut finished = false;
		let stream = std::panic::catch_unwind(AssertUnwindSafe(|| {
			self.deps.agent.run(
				AgentRequest {
					run_id: self.input.run_id.clone(),
					conversation_id: self.input.request.workspace_id.clone(),
					prompt,
					permitted_tool_ids: self.permitted_ids.clone(),
					max_tool_calls: budget.max_tool_calls.saturating_sub(self.usage.tool_calls),
					deadline: self.deadline.clone(),
				},
				AgentRunContext {
					cancel: self.input.cancel.clone(),
					scratch_directory: self.deps.scratch_directory.clone(),
					model: self.input.request.model.clone(),
					effort: match self.input.request.effort.as_str() {
						"low" => Effort::Low,
						"high" => Effort::High,
						_ => Effort::Medium,
					},
				},
			)
		}));
		match stream {
			Err(_) => {
				failure = Some(TurnFailure::Provider {
					code: "AGENT_THREW_Panic".to_owned(),
					retryable: true,
					upstream_status: None,
				})
			}
			Ok(mut stream) => {
				// The TypeScript keeps iterating a cancelled stream until the adapter ends
				// it (a late `usage` event still counts); a stuck adapter is cut off after a
				// grace period instead of hanging the run.
				let grace = async {
					self.input.cancel.cancelled().await;
					tokio::time::sleep(CANCEL_GRACE).await;
				};
				tokio::pin!(grace);
				loop {
					let next = tokio::select! {
						biased;
						() = &mut grace => break,
						event = AssertUnwindSafe(stream.next()).catch_unwind() => event,
					};
					let raw = match next {
						Ok(Some(event)) => event,
						Ok(None) => break,
						Err(_) => {
							failure = Some(TurnFailure::Provider {
								code: "AGENT_THREW_Panic".to_owned(),
								retryable: true,
								upstream_status: None,
							});
							break;
						}
					};
					let Ok(event) = validate_agent_event(&raw) else {
						failure = Some(TurnFailure::Provider {
							code: "AGENT_EVENT_INVALID".to_owned(),
							retryable: false,
							upstream_status: None,
						});
						break;
					};
					match event {
						AgentEvent::TextDelta { text } => {
							units += utf16::utf16_len(&text);
							result.text.push_str(&text);
							if units > 400000 {
								failure = Some(TurnFailure::Provider {
									code: "AGENT_OUTPUT_TOO_LARGE".to_owned(),
									retryable: false,
									upstream_status: None,
								});
								break;
							}
						}
						AgentEvent::ToolRequest { tool_id, args, .. } => {
							result.tool_requests.push(ToolRequest {
								tool_id,
								args: args.0,
							})
						}
						AgentEvent::UiCommand { command } => result.ui_proposals.push(command.0),
						AgentEvent::Usage { known_cost_usd } => reported = known_cost_usd,
						AgentEvent::Failed {
							code,
							retryable,
							upstream_status,
						} => {
							failure = Some(TurnFailure::Provider {
								code,
								retryable,
								upstream_status,
							});
							break;
						}
						AgentEvent::Completed => {
							finished = true;
							break;
						}
						AgentEvent::ToolResult { .. } => {}
					}
				}
				// Close even after a terminal event: adapters must kill and reap processes.
				if stream.close().await == TurnEnd::Panicked {
					failure = Some(TurnFailure::Provider {
						code: "AGENT_THREW_Panic".to_owned(),
						retryable: true,
						upstream_status: None,
					});
				}
			}
		}
		self.usage = add_usage(
			&self.usage,
			&UsageDelta {
				cost_usd: reported.map(CostReport::Usd).unwrap_or(CostReport::Unknown),
				..UsageDelta::default()
			},
		);
		if let Some(cost) = reported.filter(|n| n.is_finite()) {
			self.largest_cost = self.largest_cost.max(cost);
		}
		self.deps.reporter.usage(&self.usage).await;
		if self.input.cancel.is_cancelled() {
			return Err(TurnFailure::Aborted);
		}
		if let Some(failure) = failure {
			return Err(failure);
		}
		if !finished {
			return Err(TurnFailure::Provider {
				code: "AGENT_STREAM_ENDED_EARLY".to_owned(),
				retryable: true,
				upstream_status: None,
			});
		}
		if check_budget(budget, &self.usage, 0, &UsageDelta::default())
			== Err(BudgetLimit::MaxSpend)
		{
			return Err(TurnFailure::Budget(BudgetLimit::MaxSpend));
		}
		Ok(result)
	}
}
