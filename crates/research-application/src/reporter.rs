//! Progress reporting from a running job (`PipelineReporter` in
//! `packages/application/src/research/pipeline.ts`), shared by the research
//! pipeline, the notebook-assist turn and the runner's other job kinds.
//! Every call is awaited in program order; the runner queues the events and
//! sends them sequence-numbered to the Worker.

use async_trait::async_trait;
use research_domain::jobs::budget::ResourceUsage;
use research_domain::jobs::state_machine::JobState;

/// How one tool call ended, as reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCallOutcome {
	/// `"executed"`.
	Executed,
	/// `"denied"` (authorization refused it before it ran).
	Denied,
	/// `"failed"`.
	Failed,
}

impl ToolCallOutcome {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Executed => "executed",
			Self::Denied => "denied",
			Self::Failed => "failed",
		}
	}
}

/// Receives a job's progress.
#[async_trait]
pub trait PipelineReporter: Send + Sync {
	/// A lifecycle state was entered (only leased states are legal here).
	async fn state(&self, state: JobState);
	/// A progress note for the owner (the runner cuts it to 500 UTF-16 units).
	async fn note(&self, text: &str);
	/// A tool call ended (the runner cuts `detail` to 300 UTF-16 units).
	async fn tool(&self, tool_id: &str, outcome: ToolCallOutcome, detail: &str);
	/// The latest cumulative resource usage.
	async fn usage(&self, usage: &ResourceUsage);
}
