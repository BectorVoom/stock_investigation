//! One CLI turn driver; terminal events are emitted only after bounded reaping.
use crate::{
	process::{MAX_TERMINATION_MS, ProcessExit, ProcessRunner, ProcessSpec},
	turn::*,
};
use futures_util::StreamExt;
use research_agent_core::runtime::{AgentTurn, TurnSender};
use research_contracts::{agent::AgentEvent, json::JsonValue};
use research_js::{utf16::utf16_len, whitespace::trim};
use std::{sync::Arc, time::Duration};

/// The process runner gets a further second to settle after escalation.
pub const PROCESS_REAP_WAIT_MS: u64 = MAX_TERMINATION_MS + 1000;
/// Pure line interpretation; only these events cross the provider boundary.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LineVerdict {
	/// Bookkeeping.
	Ignored,
	/// Invalid JSON or provider schema.
	Malformed,
	/// Model text.
	Text {
		/// Delta text.
		text: String,
	},
	/// Rejected native research call (ADR-0028).
	#[serde(rename = "tool.request", rename_all = "camelCase")]
	ToolRequest {
		/// Research tool id.
		tool_id: String,
		/// Bounded object arguments.
		args: JsonValue,
		/// Native or generated call id.
		call_id: String,
	},
	/// End a native tool step before the process exits.
	Finished,
	/// Fail closed.
	Fatal {
		/// Stable failure.
		failure: ProviderFailure,
	},
}
/// Final interpretation after normal process exit.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnConclusion {
	/// Failure takes priority over trailing text.
	pub failure: Option<ProviderFailure>,
	/// Result fallback used only if the provider streamed no text.
	pub trailing_text: String,
	/// Metered cost, never fabricated as zero.
	pub known_cost_usd: Option<f64>,
}
impl TurnConclusion {
	/// Unknown cost and no trailing text.
	pub fn new(failure: Option<ProviderFailure>) -> Self {
		Self {
			failure,
			trailing_text: String::new(),
			known_cost_usd: None,
		}
	}
}
/// A sequential, pure provider line state machine.
pub trait CliStreamInterpreter: Send {
	/// Parses and classifies one non-blank line.
	fn interpret_line(&mut self, line: &str) -> LineVerdict;
	/// Concludes a normally exited process.
	fn conclude(&mut self, exit: &ProcessExit, emitted_text_chars: usize) -> TurnConclusion;
	/// External-process protocol can carry usage before an early terminal event.
	fn terminal_cost(&self) -> Option<f64> {
		None
	}
}
/// Whole message joining preserves exactly one boundary newline when needed.
#[derive(Default)]
pub struct SegmentJoiner {
	needs_newline: bool,
}
impl SegmentJoiner {
	/// Joins a nonempty segment; empty segments leave state unchanged.
	pub fn join(&mut self, segment: &str) -> String {
		if segment.is_empty() {
			return String::new();
		}
		let result = if self.needs_newline {
			format!("\n{segment}")
		} else {
			segment.to_owned()
		};
		self.needs_newline = !segment.ends_with('\n');
		result
	}
}
/// Owns the child until reaping even when the caller drops the turn.
pub fn run_cli_turn(
	runner: Arc<dyn ProcessRunner>,
	mut spec: ProcessSpec,
	interpreter: Box<dyn CliStreamInterpreter>,
	deadline: f64,
) -> AgentTurn {
	let external = spec.cancel.clone();
	AgentTurn::spawn(&external, move |sender| async move {
		spec.cancel = sender.cancel_token().clone();
		drive_cli_turn(runner, spec, interpreter, deadline, sender).await;
	})
}
async fn finish(sender: &TurnSender, cost: Option<f64>, failure: Option<ProviderFailure>) {
	let _ = sender
		.send(AgentEvent::Usage {
			known_cost_usd: cost,
		})
		.await;
	let _ = sender
		.send(failure.map_or(AgentEvent::Completed, ProviderFailure::event))
		.await;
}
async fn drive_cli_turn(
	runner: Arc<dyn ProcessRunner>,
	mut spec: ProcessSpec,
	mut interpreter: Box<dyn CliStreamInterpreter>,
	deadline: f64,
	sender: TurnSender,
) {
	let guard = TurnGuard::new(spec.cancel.clone(), deadline, now_ms());
	if let Some(reason) = guard.reason() {
		let _ = sender.send(failure_for_stop(reason).event()).await;
		return;
	}
	spec.cancel = guard.cancel.clone();
	let handle = match runner.run(spec) {
		Ok(handle) => handle,
		Err(error) => {
			guard.stop(StopReason::Finished);
			let _ = sender
				.send(
					ProviderFailure::new(if error.kind() == std::io::ErrorKind::NotFound {
						"PROVIDER_NOT_INSTALLED"
					} else {
						"PROVIDER_SPAWN_FAILED"
					})
					.event(),
				)
				.await;
			return;
		}
	};
	let mut lines = handle.stdout_lines;
	let mut exit = handle.exit;
	let mut accepted = 0usize;
	let mut emitted = 0usize;
	let mut malformed = 0usize;
	let mut fatal = None;
	let mut finished = false;
	let mut consumer_gone = false;
	loop {
		let line = tokio::select! { biased; _ = guard.cancel.cancelled() => break, line = lines.next() => line };
		let Some(line) = line else {
			break;
		};
		accepted += utf16_len(&line) + 1;
		if accepted > MAX_RAW_STREAM_CHARS {
			fatal = Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"));
			break;
		}
		if trim(&line).is_empty() {
			continue;
		}
		match interpreter.interpret_line(&line) {
			LineVerdict::Ignored => {}
			LineVerdict::Malformed => {
				malformed += 1;
				if malformed > MAX_MALFORMED_LINES {
					fatal = Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID"));
					break;
				}
			}
			LineVerdict::Text { text } => {
				if text.is_empty() {
					continue;
				}
				emitted += utf16_len(&text);
				if emitted > MAX_OUTPUT_TEXT_CHARS {
					fatal = Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"));
					break;
				}
				if !sender.send(AgentEvent::TextDelta { text }).await {
					consumer_gone = true;
					break;
				}
			}
			LineVerdict::ToolRequest {
				tool_id,
				args,
				call_id,
			} => {
				if !sender
					.send(AgentEvent::ToolRequest {
						tool_id,
						args,
						call_id,
					})
					.await
				{
					consumer_gone = true;
					break;
				}
			}
			LineVerdict::Finished => {
				finished = true;
				break;
			}
			LineVerdict::Fatal { failure } => {
				fatal = Some(failure);
				break;
			}
		}
	}
	// Abandoning stdout is necessary before awaiting Node's close-equivalent.
	drop(lines);
	if fatal.is_some() || finished || guard.reason().is_some() || consumer_gone {
		let stop = guard.reason();
		guard.stop(StopReason::Finished);
		let _ = tokio::time::timeout(Duration::from_millis(PROCESS_REAP_WAIT_MS), &mut exit).await;
		if !consumer_gone {
			finish(
				&sender,
				if finished || fatal.is_some() {
					interpreter.terminal_cost()
				} else {
					None
				},
				fatal.or_else(|| {
					if finished && stop.is_none() {
						None
					} else {
						Some(failure_for_stop(stop.unwrap_or(StopReason::Aborted)))
					}
				}),
			)
			.await;
		}
		return;
	}
	let outcome = tokio::select! { biased;
		_ = guard.cancel.cancelled() => None,
		value = &mut exit => Some(value),
	};
	match outcome {
		None => {
			let reason = guard.reason().unwrap_or(StopReason::Aborted);
			guard.stop(StopReason::Finished);
			let _ =
				tokio::time::timeout(Duration::from_millis(PROCESS_REAP_WAIT_MS), &mut exit).await;
			finish(&sender, None, Some(failure_for_stop(reason))).await;
		}
		Some(Err(error)) => {
			let _ = sender
				.send(
					ProviderFailure::new(if error.kind() == std::io::ErrorKind::NotFound {
						"PROVIDER_NOT_INSTALLED"
					} else {
						"PROVIDER_SPAWN_FAILED"
					})
					.event(),
				)
				.await;
		}
		Some(Ok(exit)) => {
			let mut conclusion = interpreter.conclude(&exit, emitted);
			if conclusion.failure.is_none()
				&& utf16_len(&conclusion.trailing_text) > MAX_OUTPUT_TEXT_CHARS
			{
				conclusion.failure = Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"));
			}
			if conclusion.failure.is_none() && !conclusion.trailing_text.is_empty() {
				let _ = sender
					.send(AgentEvent::TextDelta {
						text: conclusion.trailing_text,
					})
					.await;
			}
			finish(&sender, conclusion.known_cost_usd, conclusion.failure).await;
		}
	}
	guard.stop(StopReason::Finished);
}
