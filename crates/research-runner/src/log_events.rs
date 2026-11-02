//! The runner's event catalogue (shell-wire spec section 7.5/7.6): every
//! event name logged by this crate matches the logger's name pattern, so
//! enforcement can never silence a real event, and the set is exactly the
//! documented one. Replaces `apps/runner/test/logEvents.test.ts`, which
//! scanned the TypeScript sources.

use std::collections::BTreeSet;
use std::path::Path;

use research_effects::is_log_event_name;

/// Every event the shell logs. The launcher greps `invalid_configuration`,
/// `unsupported_runtime` and `runner_crashed` in `runner.log`
/// (`scripts/supervision.ts`): they must not be printed in any other context.
const SHELL_EVENTS: [&str; 26] = [
	"agent_probe",
	"claim_failed",
	"completion_rejected",
	"earnings_source_disabled",
	"events_not_delivered",
	"heartbeat_failed",
	"invalid_configuration",
	"job_abandoned",
	"job_claimed",
	"job_crashed",
	"job_finished",
	// The lease hand-back on shutdown (ADR-0036).
	"job_released",
	"market_source_disabled",
	"process_helper_missing",
	"release_failed",
	"renew_failed",
	"runner_credential_rejected",
	"runner_crashed",
	"runner_started",
	"scratch_not_removed",
	"sec_tools_disabled",
	"shutdown_requested",
	// The stock-directory sources' dropped-row count (ADR-0034), logged by
	// the hook the composition root hands them.
	"stock_directory_rows_dropped",
	"unsupported_runtime",
	"web_pages_disabled",
	"web_search_disabled",
];

/// Event literals passed to `.info(` / `.warn(` / `.error(` in non-test code.
fn logged_event_names(directory: &Path, found: &mut BTreeSet<String>) {
	for entry in std::fs::read_dir(directory).unwrap() {
		let path = entry.unwrap().path();
		if path.is_dir() {
			logged_event_names(&path, found);
			continue;
		}
		// This file names the calls it searches for.
		let own = path.file_name().is_some_and(|name| name == "log_events.rs");
		if own || path.extension().is_none_or(|extension| extension != "rs") {
			continue;
		}
		let text = std::fs::read_to_string(&path).unwrap();
		// Test modules are at the end of each file (and `job_tests.rs` is all tests).
		let production = text.split("#[cfg(test)]").next().unwrap_or_default();
		for call in [".info(", ".warn(", ".error("] {
			for part in production.split(call).skip(1) {
				let rest = part.trim_start();
				if let Some(rest) = rest.strip_prefix('"')
					&& let Some(end) = rest.find('"')
				{
					found.insert(rest[..end].to_owned());
				}
			}
		}
	}
}

#[test]
fn every_logged_event_name_matches_the_pattern_and_is_catalogued() {
	let mut found = BTreeSet::new();
	let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
	logged_event_names(&source, &mut found);
	// `shutdown_requested` etc. are all literals; `report_failure` too.
	for name in &found {
		assert!(
			is_log_event_name(name),
			"{name} does not match the log event pattern"
		);
	}
	let catalogued: BTreeSet<String> = SHELL_EVENTS.iter().map(|name| (*name).to_owned()).collect();
	assert_eq!(found, catalogued);
}

#[test]
fn the_launcher_greps_only_three_events_and_each_is_logged_in_one_place() {
	let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
	let mut occurrences = 0;
	for entry in std::fs::read_dir(&source).unwrap() {
		let path = entry.unwrap().path();
		if path.file_name().is_some_and(|name| name == "log_events.rs") {
			continue;
		}
		let text = std::fs::read_to_string(&path).unwrap_or_default();
		let production = text.split("#[cfg(test)]").next().unwrap_or_default();
		for event in [
			"invalid_configuration",
			"unsupported_runtime",
			"runner_crashed",
		] {
			occurrences += production.matches(&format!("\"{event}\"")).count();
		}
	}
	// One literal each, all in `exit_codes::report_failure`.
	assert_eq!(occurrences, 3);
}
