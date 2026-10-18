//! Safe setsid/exec trampoline. Ship beside research-runner; never invokes a shell.
use std::{
	io::Write,
	os::unix::process::CommandExt,
	process::{Command, ExitCode},
};

fn main() -> ExitCode {
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
	let Some(command) = args.next() else {
		return ExitCode::from(126);
	};
	let error = Command::new(command).args(args).exec();
	let _ = std::io::stderr().write_all(
		format!(
			"\n[runner] spawn: {}",
			research_net::errors::io_error_code(&error)
		)
		.as_bytes(),
	);
	ExitCode::from(127)
}
