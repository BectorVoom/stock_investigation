//! `research-runner-e2e`: the Rust runner with the E2E seams (see the crate
//! documentation). Spawned by `tests/e2e/rustRunnerHarness.ts`.

use std::collections::BTreeMap;
use std::process::ExitCode;

fn main() -> ExitCode {
	let env: BTreeMap<String, String> = std::env::vars_os()
		.map(|(key, value)| {
			(
				key.to_string_lossy().into_owned(),
				value.to_string_lossy().into_owned(),
			)
		})
		.collect();
	let runtime = match tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()
	{
		Ok(runtime) => runtime,
		Err(_) => return ExitCode::from(1),
	};
	match runtime.block_on(research_runner_testkit::harness::run(env)) {
		Ok(code) => ExitCode::from(code),
		Err(error) => {
			// Names the missing setting or component, never a value.
			eprintln!("research-runner-e2e: {error}");
			ExitCode::from(2)
		}
	}
}
