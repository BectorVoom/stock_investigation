//! Safe setsid/exec trampoline body. Never invokes a shell.
use std::{
	io::Write,
	os::unix::process::CommandExt,
	process::{Command, ExitCode},
};

/// Entry point of the `research-provider-spawn` executable. `cargo build -p research-runner`
/// does not build binaries of dependencies, so the runner crate must declare a
/// `[[bin]] research-provider-spawn` whose `main` calls this function (wave C).
pub fn run() -> ExitCode {
	if rustix::process::setsid().is_err() {
		return ExitCode::from(126);
	}
	// The parent waits for this handshake before signalling the newly created group.
	if std::io::stderr()
		.write_all(b"\x1eRESEARCH_PROCESS_READY\n")
		.is_err()
	{
		return ExitCode::from(126);
	}
	let mut args = std::env::args_os().skip(1);
	let (Some(command), Some(argv0)) = (args.next(), args.next()) else {
		return ExitCode::from(126);
	};
	let error = Command::new(command).arg0(argv0).args(args).exec();
	let _ = std::io::stderr().write_all(
		format!(
			"\n[runner] spawn: {}",
			research_net::errors::io_error_code(&error)
		)
		.as_bytes(),
	);
	ExitCode::from(127)
}
