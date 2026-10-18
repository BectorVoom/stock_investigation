//! The setsid/exec trampoline the agent CLIs are started through
//! (`research_providers::spawn_helper`). `cargo build -p research-runner`
//! builds only this package's binaries, so the runner package declares the
//! companion itself; the launcher copies it beside `research-runner`.

use std::process::ExitCode;

fn main() -> ExitCode {
	research_providers::spawn_helper::run()
}
