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
	// `args_os`: a non-UTF-8 argument must not panic before `runner_started`.
	// It becomes a replacement-character string that matches no option and
	// no command.
	let arguments: Vec<String> = std::env::args_os()
		.skip(1)
		.map(|argument| {
			argument
				.into_string()
				.unwrap_or_else(|_| "\u{fffd}".to_owned())
		})
		.collect();
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
