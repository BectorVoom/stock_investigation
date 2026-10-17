//! Port of `packages/domain/src/jobs/stateMachine.ts`: the research job
//! lifecycle (ARCH-015), proved in `formal/` and replayed from its vectors.
//!
//! The happy path is
//! pending -> claimed -> planning -> collecting -> analyzing -> verifying -> publishing -> completed.

use crate::literal::js_literal_enum;

js_literal_enum! {
	/// A job state (`jobStateSchema`).
	pub enum JobState {
		/// Waiting for a runner.
		Pending = "pending",
		/// Leased by a runner.
		Claimed = "claimed",
		/// The agent is planning.
		Planning = "planning",
		/// Tools are collecting evidence.
		Collecting = "collecting",
		/// The agent is analysing the evidence.
		Analyzing = "analyzing",
		/// Claims are being verified.
		Verifying = "verifying",
		/// The result is being published.
		Publishing = "publishing",
		/// Finished successfully.
		Completed = "completed",
		/// Finished with a failure.
		Failed = "failed",
		/// Cancelled by the owner.
		Cancelled = "cancelled",
		/// Finished with a partial result.
		Partial = "partial",
		/// Paused until the owner approves (spend).
		WaitingApproval = "waiting_approval",
	}
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
	/// `isJobState` + parse: the state named by `value`, if any.
	#[must_use]
	pub fn parse(value: &str) -> Option<Self> {
		Self::from_str_value(value)
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
	fn job_states_list_every_literal_in_order() {
		assert_eq!(JOB_STATES.as_slice(), JobState::ALL);
		assert_eq!(JobState::WaitingApproval.to_string(), "waiting_approval");
	}

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
