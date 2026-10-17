//! The agent backend port (`packages/agent-core/src/agentRuntime.ts`).
//!
//! A backend turns one [`AgentRequest`] into a stream of [`AgentEvent`]s
//! that ends with exactly one `completed` or `failed`; it never fails by
//! returning an error for a provider failure. The consumer may stop reading
//! early (after the terminal event, or on cancellation): in TypeScript that
//! ran the adapter's `finally` and waited for the CLI process tree to die.
//! Rust has no async drop, so every consumer must end a turn with
//! [`AgentTurn::close`], which cancels the producer and waits until it has
//! cleaned up (killed and reaped its processes).

use std::path::PathBuf;

use async_trait::async_trait;
use research_contracts::agent::{
	AgentAvailability, AgentCapabilities, AgentEvent, AgentRequest, CostModel, ToolIsolation,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Reasoning effort of a run (`"low" | "medium" | "high"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effort {
	/// `"low"`.
	Low,
	/// `"medium"`.
	Medium,
	/// `"high"`.
	High,
}

impl Effort {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Low => "low",
			Self::Medium => "medium",
			Self::High => "high",
		}
	}
}

/// Per-turn context (`AgentRunContext`).
#[derive(Clone, Debug)]
pub struct AgentRunContext {
	/// The run's cancellation (the TypeScript `signal`).
	pub cancel: CancellationToken,
	/// The job's empty scratch directory (AGT-004); `None` outside jobs.
	pub scratch_directory: Option<PathBuf>,
	/// Model chosen in Settings, if any.
	pub model: Option<String>,
	/// Reasoning effort.
	pub effort: Effort,
}

/// What a quota-free probe found (`AgentProbe`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProbe {
	/// Capabilities, default model and listed models.
	pub capabilities: AgentCapabilities,
	/// Available, or why not.
	pub availability: AgentAvailability,
}

/// How a turn's producer task ended, as seen by [`AgentTurn::close`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnEnd {
	/// The producer returned normally (or was cancelled and cleaned up).
	Finished,
	/// The producer panicked — the counterpart of a TypeScript adapter
	/// throwing (`AGENT_THREW_<name>` in the consumer).
	Panicked,
}

/// Capacity of a turn's event channel: back-pressure like Node's pull-based
/// async iterator, without a lock-step hand-off per event.
pub const TURN_CHANNEL_CAPACITY: usize = 64;

/// One running turn: the events of a backend's `run`, plus the task that
/// produces them.
#[derive(Debug)]
pub struct AgentTurn {
	events: mpsc::Receiver<AgentEvent>,
	task: Option<JoinHandle<()>>,
	cancel: CancellationToken,
}

/// The producer side of an [`AgentTurn`].
#[derive(Clone, Debug)]
pub struct TurnSender {
	events: mpsc::Sender<AgentEvent>,
	cancel: CancellationToken,
}

impl TurnSender {
	/// Sends one event. `false` when the consumer is gone (it stopped
	/// reading or closed the turn): the producer should then clean up and
	/// return.
	pub async fn send(&self, event: AgentEvent) -> bool {
		self.events.send(event).await.is_ok()
	}

	/// Cancelled by the run's token or by [`AgentTurn::close`] / drop.
	#[must_use]
	pub fn cancel_token(&self) -> &CancellationToken {
		&self.cancel
	}
}

impl AgentTurn {
	/// Starts `produce` on the tokio runtime. Its token is a child of
	/// `run_cancel`, so cancelling the run also cancels the turn, while
	/// closing the turn leaves the run alone.
	pub fn spawn<F, Fut>(run_cancel: &CancellationToken, produce: F) -> Self
	where
		F: FnOnce(TurnSender) -> Fut,
		Fut: Future<Output = ()> + Send + 'static,
	{
		let cancel = run_cancel.child_token();
		let (sender, events) = mpsc::channel(TURN_CHANNEL_CAPACITY);
		let task = tokio::spawn(produce(TurnSender {
			events: sender,
			cancel: cancel.clone(),
		}));
		Self {
			events,
			task: Some(task),
			cancel,
		}
	}

	/// A turn that yields `events` and ends (for tests and fixed answers).
	#[must_use]
	pub fn from_events(events: Vec<AgentEvent>) -> Self {
		let (sender, receiver) = mpsc::channel(events.len().max(1));
		for event in events {
			// Capacity covers every event, so this never fails.
			let _ = sender.try_send(event);
		}
		Self {
			events: receiver,
			task: None,
			cancel: CancellationToken::new(),
		}
	}

	/// The next event; `None` when the producer has finished (with or
	/// without a terminal event — the consumer decides what that means).
	pub async fn next(&mut self) -> Option<AgentEvent> {
		self.events.recv().await
	}

	/// Ends the turn: cancels the producer and waits until it has returned
	/// (processes killed and reaped). Always call this, also after the
	/// terminal event.
	pub async fn close(mut self) -> TurnEnd {
		self.cancel.cancel();
		// Unblock a producer waiting on a full channel.
		self.events.close();
		match self.task.take() {
			None => TurnEnd::Finished,
			Some(task) => match task.await {
				Ok(()) => TurnEnd::Finished,
				Err(error) if error.is_panic() => TurnEnd::Panicked,
				Err(_) => TurnEnd::Finished,
			},
		}
	}
}

impl Drop for AgentTurn {
	fn drop(&mut self) {
		// A dropped turn still stops its producer; the task keeps running
		// only long enough to clean up. Prefer `close`, which waits for it.
		self.cancel.cancel();
	}
}

/// An agent backend (`AgentRuntime`). Implementations are registered in the
/// composition root (FR-013, ARCH-006).
#[async_trait]
pub trait AgentRuntime: Send + Sync {
	/// Stable backend id (`^[a-z][a-z0-9-]{1,31}$`).
	fn agent_id(&self) -> &str;
	/// Name shown in Settings.
	fn display_name(&self) -> &str;
	/// Billing model.
	fn cost_model(&self) -> CostModel;
	/// Whether the backend's own tools are verifiably disabled.
	fn tool_isolation(&self) -> ToolIsolation;
	/// Availability and capabilities without spending quota. Never panics;
	/// a failure is an `unavailable` answer.
	async fn probe(&self) -> AgentProbe;
	/// Starts one turn (see the module docs for the stream contract).
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn;
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;
	use std::sync::atomic::{AtomicBool, Ordering};

	use super::*;

	fn text(value: &str) -> AgentEvent {
		AgentEvent::TextDelta {
			text: value.to_owned(),
		}
	}

	#[tokio::test]
	async fn close_cancels_the_producer_and_waits_for_its_cleanup() {
		let cleaned = Arc::new(AtomicBool::new(false));
		let flag = Arc::clone(&cleaned);
		let run = CancellationToken::new();
		let mut turn = AgentTurn::spawn(&run, move |sender| async move {
			let _ = sender.send(text("a")).await;
			sender.cancel_token().cancelled().await;
			tokio::time::sleep(std::time::Duration::from_millis(20)).await;
			flag.store(true, Ordering::SeqCst);
		});
		assert_eq!(turn.next().await, Some(text("a")));
		assert_eq!(turn.close().await, TurnEnd::Finished);
		assert!(cleaned.load(Ordering::SeqCst));
		assert!(
			!run.is_cancelled(),
			"closing a turn must not cancel the run"
		);
	}

	#[tokio::test]
	async fn a_panicking_producer_is_reported() {
		let run = CancellationToken::new();
		let mut turn = AgentTurn::spawn(&run, |_sender| async move {
			panic!("adapter bug");
		});
		assert_eq!(turn.next().await, None);
		assert_eq!(turn.close().await, TurnEnd::Panicked);
	}

	#[tokio::test]
	async fn dropping_a_turn_cancels_it_and_run_cancel_propagates() {
		let run = CancellationToken::new();
		let seen = Arc::new(AtomicBool::new(false));
		let flag = Arc::clone(&seen);
		let turn = AgentTurn::spawn(&run, move |sender| async move {
			sender.cancel_token().cancelled().await;
			flag.store(true, Ordering::SeqCst);
		});
		drop(turn);
		tokio::time::sleep(std::time::Duration::from_millis(20)).await;
		assert!(seen.load(Ordering::SeqCst));

		let mut second = AgentTurn::spawn(&run, |sender| async move {
			sender.cancel_token().cancelled().await;
		});
		run.cancel();
		assert_eq!(second.next().await, None);
	}

	#[tokio::test]
	async fn fixed_events_are_replayed_in_order() {
		let mut turn = AgentTurn::from_events(vec![text("x"), AgentEvent::Completed]);
		assert_eq!(turn.next().await, Some(text("x")));
		assert_eq!(turn.next().await, Some(AgentEvent::Completed));
		assert_eq!(turn.next().await, None);
		assert_eq!(turn.close().await, TurnEnd::Finished);
	}
}
