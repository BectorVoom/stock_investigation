//! Port of `packages/domain/src/jobs/stateMachine.ts`: the research job
//! lifecycle (ARCH-015), proved in `formal/` and replayed from its vectors.
//!
//! The happy path is
//! pending -> claimed -> planning -> collecting -> analyzing -> verifying -> publishing -> completed.

use serde::{Deserialize, Serialize};

/// A job state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
	/// Waiting for a runner.
	Pending,
	/// Leased by a runner.
	Claimed,
	/// The agent is planning.
	Planning,
	/// Tools are collecting evidence.
	Collecting,
	/// The agent is analysing the evidence.
	Analyzing,
	/// Claims are being verified.
	Verifying,
	/// The result is being published.
	Publishing,
	/// Finished successfully.
	Completed,
	/// Finished with a failure.
	Failed,
	/// Cancelled by the owner.
	Cancelled,
	/// Finished with a partial result.
	Partial,
	/// Paused until the owner approves (spend).
	WaitingApproval,
}

/// `JOB_STATES`, in the TypeScript (and Lean) order.
pub const JOB_STATES: [JobState; 12] = [
	JobState::Pending,
	JobState::Claimed,
	JobState::Planning,
	JobState::Collecting,
	JobState::Analyzing,
	JobState::Verifying,
	JobState::Publishing,
	JobState::Completed,
	JobState::Failed,
	JobState::Cancelled,
	JobState::Partial,
	JobState::WaitingApproval,
];

/// States in which a runner holds (or held) a lease and is expected to heartbeat.
pub const LEASED_JOB_STATES: [JobState; 6] = [
	JobState::Claimed,
	JobState::Planning,
	JobState::Collecting,
	JobState::Analyzing,
	JobState::Verifying,
	JobState::Publishing,
];

/// States a job never leaves.
pub const TERMINAL_JOB_STATES: [JobState; 4] = [
	JobState::Completed,
	JobState::Failed,
	JobState::Cancelled,
	JobState::Partial,
];

impl JobState {
	/// The TypeScript literal, e.g. `"waiting_approval"`.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Pending => "pending",
			Self::Claimed => "claimed",
			Self::Planning => "planning",
			Self::Collecting => "collecting",
			Self::Analyzing => "analyzing",
			Self::Verifying => "verifying",
			Self::Publishing => "publishing",
			Self::Completed => "completed",
			Self::Failed => "failed",
			Self::Cancelled => "cancelled",
			Self::Partial => "partial",
			Self::WaitingApproval => "waiting_approval",
		}
	}

	/// `isJobState` + parse: the state named by `value`, if any.
	#[must_use]
	pub fn parse(value: &str) -> Option<Self> {
		JOB_STATES.into_iter().find(|state| state.as_str() == value)
	}

	/// `JOB_TRANSITIONS[self]`: the legal next states, in the TypeScript order.
	///
	/// `pending` is reachable from every leased state so a job whose runner
	/// disappeared becomes eligible again; `partial` is only reachable once
	/// collection has produced something worth keeping.
	#[must_use]
	pub const fn transitions(self) -> &'static [Self] {
		use JobState::{
			Analyzing, Cancelled, Claimed, Collecting, Completed, Failed, Partial, Pending,
			Planning, Publishing, Verifying, WaitingApproval,
		};
		match self {
			Pending => &[Claimed, Cancelled, Failed],
			Claimed => &[Planning, Pending, WaitingApproval, Failed, Cancelled],
			Planning => &[Collecting, Pending, WaitingApproval, Failed, Cancelled],
			Collecting => &[
				Analyzing,
				Pending,
				WaitingApproval,
				Partial,
				Failed,
				Cancelled,
			],
			Analyzing => &[
				Verifying,
				Pending,
				WaitingApproval,
				Partial,
				Failed,
				Cancelled,
			],
			Verifying => &[
				Publishing,
				Pending,
				WaitingApproval,
				Partial,
				Failed,
				Cancelled,
			],
			Publishing => &[Completed, Pending, Partial, Failed, Cancelled],
			WaitingApproval => &[Pending, Cancelled, Failed],
			Completed | Failed | Cancelled | Partial => &[],
		}
	}

	/// `isLeasedJobState`.
	#[must_use]
	pub fn is_leased(self) -> bool {
		LEASED_JOB_STATES.contains(&self)
	}

	/// `isTerminalJobState`.
	#[must_use]
	pub fn is_terminal(self) -> bool {
		TERMINAL_JOB_STATES.contains(&self)
	}
}

/// `IllegalTransition`: code `ILLEGAL_TRANSITION` with both ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IllegalTransition {
	/// The state the job was in.
	pub from: JobState,
	/// The state that was requested.
	pub to: JobState,
}

impl IllegalTransition {
	/// The TypeScript error code.
	pub const CODE: &'static str = "ILLEGAL_TRANSITION";
}

/// `transitionJob`.
///
/// # Errors
///
/// [`IllegalTransition`] when `to` is not a legal successor of `from`.
pub fn transition_job(from: JobState, to: JobState) -> Result<JobState, IllegalTransition> {
	if from.transitions().contains(&to) {
		Ok(to)
	} else {
		Err(IllegalTransition { from, to })
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn walks_the_happy_path_and_rejects_skips() {
		let path = [
			JobState::Pending,
			JobState::Claimed,
			JobState::Planning,
			JobState::Collecting,
			JobState::Analyzing,
			JobState::Verifying,
			JobState::Publishing,
			JobState::Completed,
		];
		for pair in path.windows(2) {
			assert_eq!(transition_job(pair[0], pair[1]), Ok(pair[1]));
		}
		assert_eq!(
			transition_job(JobState::Pending, JobState::Completed),
			Err(IllegalTransition {
				from: JobState::Pending,
				to: JobState::Completed
			})
		);
		for state in TERMINAL_JOB_STATES {
			assert!(state.transitions().is_empty());
		}
		assert_eq!(
			JobState::parse("waiting_approval"),
			Some(JobState::WaitingApproval)
		);
		assert_eq!(JobState::parse("done"), None);
	}
}
