//! Composition root of the Rust runner (ADR-0030). Not wired yet: until the
//! port is complete the launcher keeps starting the TypeScript runner.

use std::process::ExitCode;

fn main() -> ExitCode {
	eprintln!("research-runner: the Rust runner is not complete yet (ADR-0030)");
	ExitCode::from(1)
}
