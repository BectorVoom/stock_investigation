//! Composition root of the Rust runner (ADR-0030): the process entry point.
//! `research_runner::startup` holds the start-up sequence; this file only
//! installs the process-wide hooks.

use std::io::stdout;
use std::process::ExitCode;
use std::sync::Arc;

use research_effects::{EventLogger, JsonEventLogger, StderrSink, SystemClock};
use research_runner::config::Env;
use research_runner::startup::{ProcessEffects, run_process};

fn main() -> ExitCode {
	// SEC-010: the default hook prints the panic message and location, which
	// may carry prompts, URLs or credentials. Panics are reported through the
	// logger by class name only (`runner_crashed` / `job_crashed`).
	std::panic::set_hook(Box::new(|_| {}));
	// One `write` per line to stderr, which the launcher captures in runner.log.
	let logger: Arc<dyn EventLogger> = Arc::new(JsonEventLogger::new(StderrSink, SystemClock));
	let arguments: Vec<String> = std::env::args().skip(1).collect();
	let env: Env = std::env::vars_os()
		.map(|(key, value)| {
			(
				key.to_string_lossy().into_owned(),
				value.to_string_lossy().into_owned(),
			)
		})
		.collect();
	let mut out = stdout();
	let code = run_process(
		&arguments,
		env,
		&logger,
		ProcessEffects {
			stdout: &mut out,
			handle_signals: true,
		},
	);
	ExitCode::from(code)
}
