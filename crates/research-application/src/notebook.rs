//! Notebook assistance (ADR-0020): a tool-free turn and one optional repair,
//! checked against the claimed notebook before returning raw commands to the API.

mod commands;
mod edits;
mod prompts;
mod turn;

pub use commands::{NotebookCommandFailure, apply_notebook_commands};
pub use prompts::{
	NOTEBOOK_PROMPT_BUDGET_BYTES, NotebookAssistPromptInput, notebook_assist_prompt,
};
pub use turn::{
	NotebookAssistTurnDeps, NotebookAssistTurnInput, NotebookAssistTurnOutcome,
	run_notebook_assist_turn,
};

/// An infrastructure/programming failure outside the model's normal rejection path.
#[derive(Debug, thiserror::Error)]
pub enum NotebookError {
	/// The checked-in TypeScript prompt export is corrupt.
	#[error("invalid notebook prompt export")]
	StaticData,
	/// A contract value could not be serialized.
	#[error("notebook serialization failed: {0}")]
	Serialization(#[from] serde_json::Error),
	/// An unguessable, nonempty fence is required (AGT-007).
	#[error("the notebook fence token is empty")]
	EmptyFence,
	/// The injected clock cannot produce a JavaScript date.
	#[error("the notebook deadline is outside the JavaScript date range")]
	InvalidDeadline,
	/// A blocking worker failed.
	#[error("notebook CPU worker failed: {0}")]
	Worker(#[from] tokio::task::JoinError),
}

#[cfg(test)]
mod tests;
