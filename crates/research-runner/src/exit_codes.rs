//! Runner exit codes as a pure mapping from failures (ARCH-010; port of
//! `apps/runner/src/exitCodes.ts`, shell-wire spec section 1.2). The entry
//! point handles every expected failure through [`exit_code_for`] and
//! [`report_failure`], so the mapping is unit-testable without a process.

use research_effects::{EventLogger, LogValue};

/// Class names of escaped faults, a closed set of short ASCII names
/// (`^[A-Za-z][A-Za-z0-9]{0,40}$`). Never an error message (SEC-010).
pub mod fault_names {
	/// A panic escaped the task.
	pub const PANIC: &str = "Panic";
	/// A programming or contract fault with no more specific class.
	pub const ERROR: &str = "Error";
	/// An operating-system I/O failure.
	pub const IO_ERROR: &str = "IoError";
	/// The program fault of the process itself (runtime, task join).
	pub const RUNTIME_ERROR: &str = "RuntimeError";
}

/// Why the runner stops with a non-zero exit code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunnerFailure {
	/// The environment does not describe a usable configuration.
	Configuration {
		/// One short line per problem; never a value.
		problems: Vec<String>,
	},
	/// A retired guard (the Bun check of the TypeScript runner); the exit
	/// code and the event name stay reserved because the launcher greps for
	/// them.
	UnsupportedRuntime {
		/// Runtime name.
		runtime: String,
	},
	/// The API refused `renew`.
	CredentialRenewal {
		/// Stable API code.
		code: String,
	},
	/// A fault escaped the program (`runner_crashed`).
	Unexpected {
		/// Closed class name, see [`fault_names`].
		error_name: String,
	},
}

/// Every runner failure maps to its process exit code here: invalid
/// configuration exits 2 (the owner must fix the environment), an
/// unsupported runtime exits 3 so the launcher can name it, anything else
/// that stops the runner exits 1.
#[must_use]
pub const fn exit_code_for(failure: &RunnerFailure) -> u8 {
	match failure {
		RunnerFailure::Configuration { .. } => 2,
		RunnerFailure::UnsupportedRuntime { .. } => 3,
		RunnerFailure::CredentialRenewal { .. } | RunnerFailure::Unexpected { .. } => 1,
	}
}

/// Logs the failure's lines (the launcher greps `invalid_configuration`,
/// `unsupported_runtime` and `runner_crashed` in `runner.log`) and returns
/// the exit code.
pub fn report_failure(logger: &dyn EventLogger, failure: &RunnerFailure) -> u8 {
	match failure {
		RunnerFailure::Configuration { problems } => {
			for problem in problems {
				logger.error(
					"invalid_configuration",
					&[("problem", LogValue::from(problem.as_str()))],
				);
			}
		}
		RunnerFailure::UnsupportedRuntime { runtime } => {
			logger.error(
				"unsupported_runtime",
				&[("runtime", LogValue::from(runtime.as_str()))],
			);
		}
		RunnerFailure::CredentialRenewal { code } => {
			logger.error("renew_failed", &[("code", LogValue::from(code.as_str()))]);
		}
		RunnerFailure::Unexpected { error_name } => {
			logger.error(
				"runner_crashed",
				&[("error", LogValue::from(error_name.as_str()))],
			);
		}
	}
	exit_code_for(failure)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::test_support::RecordedLogger;

	#[test]
	fn maps_invalid_configuration_to_2() {
		let failure = RunnerFailure::Configuration {
			problems: vec![
				"RESEARCH_API_URL must be https (http is allowed for localhost only)".to_owned(),
			],
		};
		assert_eq!(exit_code_for(&failure), 2);
	}

	#[test]
	fn maps_a_failed_credential_renewal_to_1() {
		let failure = RunnerFailure::CredentialRenewal {
			code: "UNAUTHENTICATED".to_owned(),
		};
		assert_eq!(exit_code_for(&failure), 1);
	}

	#[test]
	fn maps_an_unsupported_runtime_to_3() {
		let failure = RunnerFailure::UnsupportedRuntime {
			runtime: "bun".to_owned(),
		};
		assert_eq!(exit_code_for(&failure), 3);
	}

	#[test]
	fn maps_an_unexpected_failure_to_1() {
		let failure = RunnerFailure::Unexpected {
			error_name: fault_names::ERROR.to_owned(),
		};
		assert_eq!(exit_code_for(&failure), 1);
	}

	#[test]
	fn every_failure_logs_its_launcher_visible_event() {
		let recorded = RecordedLogger::new();
		let logger = recorded.logger();
		let code = report_failure(
			&*logger,
			&RunnerFailure::Configuration {
				problems: vec!["first".to_owned(), "second".to_owned()],
			},
		);
		assert_eq!(code, 2);
		report_failure(
			&*logger,
			&RunnerFailure::CredentialRenewal {
				code: "UNAUTHENTICATED".to_owned(),
			},
		);
		report_failure(
			&*logger,
			&RunnerFailure::Unexpected {
				error_name: "Panic".to_owned(),
			},
		);
		report_failure(
			&*logger,
			&RunnerFailure::UnsupportedRuntime {
				runtime: "bun".to_owned(),
			},
		);
		let lines = recorded.lines();
		assert_eq!(lines.len(), 5);
		assert!(lines[0].contains(r#""event":"invalid_configuration","problem":"first""#));
		assert!(lines[1].contains(r#""problem":"second""#));
		assert!(lines[2].contains(r#""event":"renew_failed","code":"UNAUTHENTICATED""#));
		assert!(lines[3].contains(r#""event":"runner_crashed","error":"Panic""#));
		assert!(lines[4].contains(r#""event":"unsupported_runtime","runtime":"bun""#));
	}
}
