//! Quota-free CLI capture, version checks and fixed availability details.
use crate::process::{ProcessRunner, ProcessSpec};
use futures_util::StreamExt;
use research_contracts::agent::{AgentAvailability, UnavailableReason};
use research_js::{
	number::to_js_string,
	utf16::{truncate, utf16_len},
};
use std::{sync::Arc, time::Duration};

/// Capture timeout includes the stdout drain.
pub const PROBE_TIMEOUT_MS: u64 = 15000;
/// Keep complete lines only up to this UTF-16 budget.
pub const PROBE_MAX_OUTPUT_CHARS: usize = 262144;
/// Capture result; output is used for classification, never logged.
#[derive(Debug)]
pub enum Capture {
	/// Successful capture, irrespective of exit code.
	Exited {
		/// Code, null for signals.
		code: Option<i32>,
		/// Newline-joined lines.
		stdout: String,
		/// Stderr tail.
		stderr_tail: String,
	},
	/// ENOENT.
	NotInstalled,
	/// The `research-provider-spawn` companion is missing (a packaging error).
	HelperMissing,
	/// Other spawn/read failure.
	Failed,
	/// Fifteen-second timeout.
	TimedOut,
}
/// Runs a status command with empty stdin and an independent abort token.
pub async fn capture_command(runner: &Arc<dyn ProcessRunner>, mut spec: ProcessSpec) -> Capture {
	spec.stdin.clear();
	spec.cancel = tokio_util::sync::CancellationToken::new();
	let cancel = spec.cancel.clone();
	let work = async {
		let handle = match runner.run(spec) {
			Ok(v) => v,
			Err(e) => {
				return if crate::process::is_helper_missing(&e) {
					Capture::HelperMissing
				} else if e.kind() == std::io::ErrorKind::NotFound {
					Capture::NotInstalled
				} else {
					Capture::Failed
				};
			}
		};
		let drain = async move {
			let mut stream = handle.stdout_lines;
			let mut chars = 0;
			let mut lines = Vec::new();
			while let Some(line) = stream.next().await {
				chars += utf16_len(&line) + 1;
				if chars > PROBE_MAX_OUTPUT_CHARS {
					break;
				}
				lines.push(line);
			}
			lines.join("\n")
		};
		let (exit, stdout) = tokio::join!(handle.exit, drain);
		match exit {
			Ok(exit) => Capture::Exited {
				code: exit.code,
				stdout,
				stderr_tail: exit.stderr_tail,
			},
			Err(e) if e.kind() == std::io::ErrorKind::NotFound => Capture::NotInstalled,
			Err(_) => Capture::Failed,
		}
	};
	let result = tokio::time::timeout(Duration::from_millis(PROBE_TIMEOUT_MS), work)
		.await
		.unwrap_or(Capture::TimedOut);
	cancel.cancel();
	result
}
/// Numeric version components use JS Number semantics, including overflow.
pub type Version = [f64; 3];
/// First ASCII numeric x.y.z sequence.
pub fn parse_version(text: &str) -> Option<Version> {
	static RE: std::sync::LazyLock<Option<regex::Regex>> =
		std::sync::LazyLock::new(|| regex::Regex::new(r"([0-9]+)\.([0-9]+)\.([0-9]+)").ok());
	let captures = RE.as_ref()?.captures(text)?;
	Some([
		captures.get(1)?.as_str().parse().ok()?,
		captures.get(2)?.as_str().parse().ok()?,
		captures.get(3)?.as_str().parse().ok()?,
	])
}
/// Dot-joined JavaScript Number strings.
pub fn format_version(version: Version) -> String {
	version
		.into_iter()
		.map(to_js_string)
		.collect::<Vec<_>>()
		.join(".")
}
/// Fixed details are truncated as in TS, including UTF-16 slicing.
pub fn unavailable(reason_code: UnavailableReason, detail: &str) -> AgentAvailability {
	AgentAvailability::Unavailable {
		reason_code,
		detail: truncate(detail, 300).into_owned(),
	}
}
/// Availability for a missing process helper: the CLI itself may be installed.
pub fn helper_missing() -> AgentAvailability {
	unavailable(
		UnavailableReason::ProbeFailed,
		"Runner process helper research-provider-spawn is missing; reinstall the runner",
	)
}
/// Version probe plus minimum compatibility check.
pub async fn probe_cli_version(
	runner: &Arc<dyn ProcessRunner>,
	spec: ProcessSpec,
	name: &str,
	minimum: Version,
) -> Result<Version, AgentAvailability> {
	let command = spec.command.clone();
	let capture = capture_command(runner, spec).await;
	match capture {
		Capture::NotInstalled => Err(unavailable(
			UnavailableReason::NotInstalled,
			&format!("{name} CLI \"{command}\" was not found on PATH"),
		)),
		Capture::HelperMissing => Err(helper_missing()),
		Capture::Exited {
			code: Some(0),
			stdout,
			stderr_tail,
		} => {
			let version = parse_version(&stdout)
				.or_else(|| parse_version(&stderr_tail))
				.ok_or_else(|| {
					unavailable(
						UnavailableReason::ProbeFailed,
						&format!("{name} CLI printed no recognizable version"),
					)
				})?;
			if version < minimum {
				Err(unavailable(
					UnavailableReason::UnsupportedVersion,
					&format!(
						"{name} CLI {} is older than {}, the version this adapter was verified against",
						format_version(version),
						format_version(minimum)
					),
				))
			} else {
				Ok(version)
			}
		}
		_ => Err(unavailable(
			UnavailableReason::ProbeFailed,
			&format!("{name} CLI did not report its version"),
		)),
	}
}
