//! The process entry (port of `apps/runner/src/main.ts`, shell-wire spec
//! section 1.1): the start-up sequence from `runner_started` to the exit
//! code, with the process-level effects (stdout, signals) passed in so the
//! whole sequence is testable.

use std::io::Write;
use std::sync::Arc;

use research_effects::{EventLogger, LogValue};
use tokio_util::sync::CancellationToken;

use crate::composition::{compose, renewal_api};
use crate::config::{self, Env, RunnerConfig};
use crate::env_file::{ENV_FILE_FLAG, apply_env_file, env_file_argument};
use crate::exit_codes::{RunnerFailure, fault_names, report_failure};
use crate::runner_loop::{RunnerExit, run_runner_loop};

/// `renew`'s lifetime for the new credential.
const RENEW_EXPIRES_IN_DAYS: u32 = 30;
/// How long a lingering blocking task may delay the exit.
const RUNTIME_SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);
/// Node's exit code for an env file that cannot be read.
const ENV_FILE_EXIT: u8 = 9;
/// Exit status of a process killed by SIGINT / SIGTERM (128 + signal).
const SIGINT_EXIT: i32 = 130;
const SIGTERM_EXIT: i32 = 143;

/// The process-level effects of one run.
pub struct ProcessEffects<'a> {
	/// Where `renew` prints the new token (stdout; never the log).
	pub stdout: &'a mut dyn Write,
	/// Whether to handle SIGINT / SIGTERM (not in `renew` mode, not in tests).
	pub handle_signals: bool,
}

/// `runner_started` carries `runtime: "rust"` (ADR-0030 C4) and the version.
fn log_started(logger: &dyn EventLogger) {
	logger.info(
		"runner_started",
		&[
			("runtime", LogValue::from("rust")),
			(
				"version",
				LogValue::from(crate::runner_loop::RUNNER_VERSION),
			),
		],
	);
}

/// The warnings for disabled features, in this order, each with a reason.
fn log_disabled_features(logger: &dyn EventLogger, config: &RunnerConfig) {
	let reason = |text: &'static str| [("reason", LogValue::from(text))];
	if config.sec_user_agent.is_none() {
		logger.warn("sec_tools_disabled", &reason("SEC_USER_AGENT not set"));
	}
	if config.pages_directory.is_none() {
		logger.warn("web_pages_disabled", &reason("RUNNER_PAGES_DIR not set"));
	}
	if config.fred_api_key.is_none() {
		logger.warn("market_source_disabled", &reason("FRED_API_KEY not set"));
	}
	if config.twelve_data_api_key.is_none() {
		logger.warn(
			"market_source_disabled",
			&reason("TWELVE_DATA_API_KEY not set"),
		);
	}
	if config.finnhub_api_key.is_none() {
		logger.warn(
			"earnings_source_disabled",
			&reason("FINNHUB_API_KEY not set"),
		);
	}
}

/// The first SIGINT / SIGTERM logs `shutdown_requested` and cancels the
/// shutdown token. Node used `process.once`, so a second signal got Node's
/// default action (immediate termination by signal); here the second one
/// exits at once with the matching status.
fn watch_signals(
	logger: Arc<dyn EventLogger>,
	shutdown: CancellationToken,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
	use tokio::signal::unix::{SignalKind, signal};
	let mut interrupt = signal(SignalKind::interrupt())?;
	let mut terminate = signal(SignalKind::terminate())?;
	Ok(tokio::spawn(async move {
		let first = tokio::select! {
			_ = interrupt.recv() => ("SIGINT", SIGINT_EXIT),
			_ = terminate.recv() => ("SIGTERM", SIGTERM_EXIT),
		};
		logger.info("shutdown_requested", &[("signal", LogValue::from(first.0))]);
		shutdown.cancel();
		let second = tokio::select! {
			_ = interrupt.recv() => (signal_hook::consts::SIGINT, SIGINT_EXIT),
			_ = terminate.recv() => (signal_hook::consts::SIGTERM, SIGTERM_EXIT),
		};
		// Die by the signal like Node's default action; the exit status is only
		// reached if the emulation itself fails.
		let _ = signal_hook::low_level::emulate_default_handler(second.0);
		std::process::exit(second.1);
	}))
}

/// Runs the runner: returns the process exit code. A panic anywhere is
/// reported as `runner_crashed {error:"Panic"}` (exit 1), never printed.
pub fn run_process(
	arguments: &[String],
	mut process_env: Env,
	logger: &Arc<dyn EventLogger>,
	effects: ProcessEffects<'_>,
) -> u8 {
	// Node reads the env file before the program starts, so it comes first and
	// prints nothing of its own; an unreadable file ends the process like Node.
	if let Some(path) = env_file_argument(arguments)
		&& let Err(error) = apply_env_file(&mut process_env, std::path::Path::new(&path))
	{
		// stderr is the last place to report to; the exit code still says it failed.
		let _ = std::io::stderr().write_all(format!("{path}: {error}\n").as_bytes());
		return ENV_FILE_EXIT;
	}
	log_started(&**logger);
	// A panic inside the program is a defect that escaped: log its class only.
	let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
		run_checked(arguments, process_env, logger, effects)
	}));
	match outcome {
		Ok(Ok(code)) => code,
		Ok(Err(failure)) => report_failure(&**logger, &failure),
		Err(_) => report_failure(
			&**logger,
			&RunnerFailure::Unexpected {
				error_name: fault_names::PANIC.to_owned(),
			},
		),
	}
}

fn run_checked(
	arguments: &[String],
	env: Env,
	logger: &Arc<dyn EventLogger>,
	effects: ProcessEffects<'_>,
) -> Result<u8, RunnerFailure> {
	let config =
		config::load(&env).map_err(|problems| RunnerFailure::Configuration { problems })?;
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()
		.map_err(|_| unexpected(fault_names::RUNTIME_ERROR))?;
	let result = drive(&runtime, arguments, &config, &env, logger, effects);
	// A lingering blocking task (a DNS lookup) must not delay the exit past
	// the launcher's grace period.
	runtime.shutdown_timeout(RUNTIME_SHUTDOWN_GRACE);
	result
}

/// The command: the first argument that is not a `--env-file-if-exists=` option
/// (Node strips its own options, so `--env-file-if-exists=X renew` renews).
fn command(arguments: &[String]) -> Option<&str> {
	arguments
		.iter()
		.map(String::as_str)
		.find(|argument| !argument.starts_with(ENV_FILE_FLAG))
}

fn unexpected(name: &str) -> RunnerFailure {
	RunnerFailure::Unexpected {
		error_name: name.to_owned(),
	}
}

fn drive(
	runtime: &tokio::runtime::Runtime,
	arguments: &[String],
	config: &RunnerConfig,
	env: &Env,
	logger: &Arc<dyn EventLogger>,
	effects: ProcessEffects<'_>,
) -> Result<u8, RunnerFailure> {
	// `renew`: print a fresh token once to stdout for the owner to store; it
	// is never logged. Any other argument is ignored. No signal handlers.
	if command(arguments) == Some("renew") {
		let api = renewal_api(config).map_err(|_| unexpected(fault_names::ERROR))?;
		let renewed = runtime
			.block_on(async move {
				tokio::spawn(async move { api.renew_credential(RENEW_EXPIRES_IN_DAYS).await }).await
			})
			.map_err(|_| unexpected(fault_names::PANIC))?;
		return match renewed {
			Ok(issued) => {
				effects
					.stdout
					.write_all(format!("{}\n", issued.token).as_bytes())
					.and_then(|()| effects.stdout.flush())
					.map_err(|_| unexpected(fault_names::IO_ERROR))?;
				Ok(0)
			}
			Err(error) => Err(RunnerFailure::CredentialRenewal { code: error.code }),
		};
	}

	let shutdown = CancellationToken::new();
	let signals = if effects.handle_signals {
		let _guard = runtime.enter();
		Some(
			watch_signals(Arc::clone(logger), shutdown.clone())
				.map_err(|_| unexpected(fault_names::IO_ERROR))?,
		)
	} else {
		None
	};
	log_disabled_features(&**logger, config);
	let deps = compose(config, env, logger).map_err(|_| unexpected(fault_names::ERROR))?;
	let exit = runtime
		.block_on(async move {
			// The loop runs as its own task, so a panic reaching this level is a
			// join error, not an unwind through the signal handler.
			tokio::spawn(async move { run_runner_loop(&deps, &shutdown).await }).await
		})
		.map_err(|_| unexpected(fault_names::PANIC))?;
	if let Some(signals) = signals {
		signals.abort();
	}
	Ok(match exit {
		RunnerExit::Shutdown => 0,
		RunnerExit::Unauthenticated => 1,
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::test_support::{RecordedLogger, Reply, json, serve};

	const TOKEN: &str = "token_with_enough_characters_01";

	fn env(pairs: &[(&str, &str)]) -> Env {
		pairs
			.iter()
			.map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
			.collect()
	}

	/// Runs the process sequence on this (non-async) test thread.
	fn run(arguments: &[&str], process_env: Env) -> (u8, Vec<String>, String) {
		let recorded = RecordedLogger::new();
		let logger = recorded.logger();
		let arguments: Vec<String> = arguments
			.iter()
			.map(|argument| (*argument).to_owned())
			.collect();
		let mut stdout = Vec::new();
		let code = run_process(
			&arguments,
			process_env,
			&logger,
			ProcessEffects {
				stdout: &mut stdout,
				handle_signals: false,
			},
		);
		(code, recorded.lines(), String::from_utf8(stdout).unwrap())
	}

	fn serve_blocking(
		replies: Vec<Reply>,
	) -> (crate::test_support::FakeWorker, tokio::runtime::Runtime) {
		let runtime = tokio::runtime::Runtime::new().unwrap();
		let worker = runtime.block_on(serve(replies));
		(worker, runtime)
	}

	#[test]
	fn runner_started_is_the_first_line_and_names_the_rust_runtime() {
		let (code, lines, _) = run(&[], Env::new());
		assert_eq!(code, 2);
		assert!(lines[0].starts_with(r#"{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"runner_started","runtime":"rust","version":"0.1.0"}"#));
	}

	#[test]
	fn invalid_configuration_logs_one_line_per_problem_and_exits_2() {
		let (code, lines, stdout) = run(&[], env(&[("RESEARCH_API_URL", "http://example.test")]));
		assert_eq!(code, 2);
		assert_eq!(lines.len(), 3);
		assert!(lines[1].contains(r#""level":"error","event":"invalid_configuration","problem":"RESEARCH_API_URL must be https (http is allowed for localhost only)""#));
		assert!(lines[2].contains(r#""problem":"RUNNER_TOKEN is missing or malformed""#));
		assert!(stdout.is_empty());
	}

	#[test]
	fn an_env_file_fills_what_the_environment_lacks_and_never_overrides_it() {
		let directory = tempfile::tempdir().unwrap();
		let file = directory.path().join(".env");
		std::fs::write(
			&file,
			"RUNNER_TOKEN=from_the_file_0123456789\nRESEARCH_API_URL=https://evil.example\nSEC_USER_AGENT=short\n",
		)
		.unwrap();
		let flag = format!("--env-file-if-exists={}", file.display());
		// The launcher's variables win; the file contributes the (invalid) agent.
		let (code, lines, _) = run(
			&[&flag],
			env(&[
				("RESEARCH_API_URL", "https://research.example.test"),
				("RUNNER_TOKEN", TOKEN),
			]),
		);
		assert_eq!(code, 2);
		assert_eq!(lines.len(), 2, "{lines:?}");
		assert!(lines[1].contains("Too small: expected string to have >=8 characters"));
		// A missing file is fine.
		let (code, lines, _) = run(&["--env-file-if-exists=/nonexistent/.env"], Env::new());
		assert_eq!(code, 2);
		assert!(lines[1].contains("RESEARCH_API_URL must be https"));
	}

	#[test]
	fn an_env_file_that_cannot_be_read_ends_the_process_like_node_with_code_9() {
		let directory = tempfile::tempdir().unwrap();
		let flag = format!("--env-file-if-exists={}", directory.path().display());
		let (code, lines, _) = run(&[&flag], Env::new());
		assert_eq!(code, 9);
		// Nothing is logged: Node fails before the program starts.
		assert!(lines.is_empty(), "{lines:?}");
	}

	fn credential(token: &str) -> String {
		format!(
			r#"{{"credential":{{"credentialId":"c1","label":"runner","createdAt":"2026-10-11T00:00:00.000Z","expiresAt":"2026-11-10T00:00:00.000Z","revokedAt":null,"lastUsedAt":null}},"token":"{token}"}}"#
		)
	}

	#[test]
	fn renew_prints_the_new_token_to_stdout_and_never_logs_it() {
		let new_token = "n".repeat(48);
		let (worker, _runtime) = serve_blocking(vec![json(200, &credential(&new_token))]);
		let (code, lines, stdout) = run(
			&["renew", "ignored"],
			env(&[("RESEARCH_API_URL", &worker.url), ("RUNNER_TOKEN", TOKEN)]),
		);
		assert_eq!(code, 0);
		assert_eq!(stdout, format!("{new_token}\n"));
		assert_eq!(lines.len(), 1, "{lines:?}");
		assert!(lines.iter().all(|line| !line.contains(&new_token)));
		let request = &worker.requests()[0];
		assert_eq!(request.path, "/api/v1/runner/credentials/renew");
		assert_eq!(request.body, r#"{"expiresInDays":30}"#);
	}

	#[test]
	fn renew_is_found_before_or_after_the_env_file_option() {
		for order in [
			["--env-file-if-exists=/nonexistent/.env", "renew"],
			["renew", "--env-file-if-exists=/nonexistent/.env"],
		] {
			let new_token = "m".repeat(48);
			let (worker, _runtime) = serve_blocking(vec![json(200, &credential(&new_token))]);
			let (code, _, stdout) = run(
				&order,
				env(&[("RESEARCH_API_URL", &worker.url), ("RUNNER_TOKEN", TOKEN)]),
			);
			assert_eq!((code, stdout), (0, format!("{new_token}\n")), "{order:?}");
			assert_eq!(worker.requests().len(), 1);
		}
	}

	#[test]
	fn a_refused_renewal_logs_renew_failed_and_exits_1() {
		let (worker, _runtime) = serve_blocking(vec![json(
			401,
			r#"{"error":{"code":"UNAUTHENTICATED","message":"no"}}"#,
		)]);
		let (code, lines, stdout) = run(
			&["renew"],
			env(&[("RESEARCH_API_URL", &worker.url), ("RUNNER_TOKEN", TOKEN)]),
		);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(
			lines[1].contains(r#""level":"error","event":"renew_failed","code":"UNAUTHENTICATED""#)
		);
	}

	#[test]
	fn a_rejected_credential_stops_the_loop_after_the_warnings_and_exits_1() {
		let (worker, _runtime) = serve_blocking(vec![json(
			403,
			r#"{"error":{"code":"FORBIDDEN","message":"no"}}"#,
		)]);
		// No agent backends: nothing probes a CLI on the machine running the test.
		let scratch = tempfile::tempdir().unwrap();
		let (code, lines, _) = run(
			&[],
			env(&[
				("RESEARCH_API_URL", &worker.url),
				("RUNNER_TOKEN", TOKEN),
				("RESEARCH_AGENT_SET", "external-only"),
				("RUNNER_SCRATCH_ROOT", scratch.path().to_str().unwrap()),
			]),
		);
		assert_eq!(code, 1);
		let events: Vec<&str> = lines
			.iter()
			.filter_map(|line| line.split(r#""event":""#).nth(1)?.split('"').next())
			// Present only when the companion binary was not built beside the test.
			.filter(|event| *event != "process_helper_missing")
			.collect();
		assert_eq!(
			events,
			[
				"runner_started",
				"sec_tools_disabled",
				"web_pages_disabled",
				"market_source_disabled",
				"market_source_disabled",
				"earnings_source_disabled",
				"runner_credential_rejected",
			]
		);
		assert!(lines[1].contains(r#""reason":"SEC_USER_AGENT not set""#));
		assert!(lines[4].contains(r#""reason":"TWELVE_DATA_API_KEY not set""#));
		// The claim carried the runner version and no agents.
		let request = &worker.requests()[0];
		assert_eq!(request.path, "/api/v1/runner/jobs/claim");
		assert_eq!(request.body, r#"{"runnerVersion":"0.1.0","agents":[]}"#);
	}
}
