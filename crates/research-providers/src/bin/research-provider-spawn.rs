//! Safe setsid/exec trampoline. Ship beside research-runner; never invokes a shell.
use std::process::ExitCode;

fn main() -> ExitCode {
	research_providers::spawn_helper::run()
}
