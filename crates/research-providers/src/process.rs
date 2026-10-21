//! Process groups, output drains and bounded SIGTERM → SIGKILL escalation.
use crate::{
	environment::Environment,
	lines::{LineSplitter, MAX_LINE_CHARS, Utf8Decoder},
};
use futures_util::{StreamExt, future::BoxFuture, stream::BoxStream};
use research_js::utf16::{slice, utf16_len};
use rustix::{
	io::Errno,
	process::{Pid, Signal, kill_process_group, test_kill_process_group},
};
use std::os::unix::{fs::PermissionsExt, process::ExitStatusExt};
use std::{
	io,
	path::{Path, PathBuf},
	process::Stdio,
	sync::{Arc, Mutex},
	time::Duration,
};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

/// Last 4096 UTF-16 units of stderr, including safe runner diagnostics.
pub const STDERR_TAIL_CHARS: usize = 4096;
/// Default graceful termination window.
pub const DEFAULT_KILL_GRACE_MS: u64 = 2000;
/// Group liveness polling interval.
pub const GROUP_POLL_MS: u64 = 25;
/// SIGKILL confirmation window.
pub const KILL_CONFIRM_MS: u64 = 1000;
/// Maximum termination duration including polling slack.
pub const MAX_TERMINATION_MS: u64 = 3050;
/// Complete invocation: stdin is never an argv element.
#[derive(Clone, Debug)]
pub struct ProcessSpec {
	/// Executable (PATH lookup uses the child's environment).
	pub command: String,
	/// Literal arguments, never shell evaluated.
	pub args: Vec<String>,
	/// Working directory.
	pub cwd: PathBuf,
	/// Complete environment.
	pub env: Environment,
	/// Entire stdin, then EOF.
	pub stdin: String,
	/// Abort starts group termination.
	pub cancel: CancellationToken,
}
/// Node `close` outcome: child waited and both output streams closed.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExit {
	/// Exit code, or null when signalled.
	pub code: Option<i32>,
	/// Signal name, or null.
	pub signal: Option<String>,
	/// Bounded diagnostics.
	pub stderr_tail: String,
}
/// Lines and the independent reaping future (drain both concurrently).
pub struct ProcessHandle {
	/// Taking/dropping this stream abandons stdout.
	pub stdout_lines: BoxStream<'static, String>,
	/// Resolves only after stdio closes and an active termination finishes.
	pub exit: BoxFuture<'static, io::Result<ProcessExit>>,
}
/// Process boundary; scripted implementations belong in tests/testkit.
pub trait ProcessRunner: Send + Sync {
	/// Spawns without a shell. Spawn errors are typed OS errors.
	fn run(&self, spec: ProcessSpec) -> io::Result<ProcessHandle>;
}
/// File name of the setsid/exec companion executable.
pub const HELPER_NAME: &str = "research-provider-spawn";
/// Error payload (inside an `io::Error` of kind `Other`) naming a missing or
/// unusable companion executable. It is deliberately not `NotFound`, which the
/// backends report as "CLI not installed".
#[derive(Debug, thiserror::Error)]
#[error("process helper {} is missing or not executable", .0.display())]
pub struct HelperMissing(pub PathBuf);
/// True when `error` is a [`HelperMissing`].
pub fn is_helper_missing(error: &io::Error) -> bool {
	error
		.get_ref()
		.is_some_and(|inner| inner.is::<HelperMissing>())
}
fn check_helper(helper: &Path) -> io::Result<()> {
	match std::fs::metadata(helper) {
		Ok(m) if m.is_file() && m.permissions().mode() & 0o111 != 0 => Ok(()),
		_ => Err(io::Error::other(HelperMissing(helper.to_owned()))),
	}
}
/// Production Unix runner using the safe setsid/exec companion executable.
#[derive(Clone, Debug)]
pub struct UnixProcessRunner {
	helper: PathBuf,
}
impl UnixProcessRunner {
	/// Locates `research-provider-spawn` beside the application binary.
	pub fn new() -> io::Result<Self> {
		let executable = std::env::current_exe()?;
		let directory = executable
			.parent()
			.ok_or_else(|| io::Error::other("executable has no directory"))?;
		let directory = if directory.file_name().is_some_and(|v| v == "deps") {
			directory.parent().unwrap_or(directory)
		} else {
			directory
		};
		Self::with_helper(directory.join(HELPER_NAME))
	}
	/// Sets a trusted companion path at composition time (release packaging).
	/// Fails at once when the helper is not an executable file, so a packaging
	/// mistake is never mistaken for "CLI not installed".
	pub fn with_helper(helper: PathBuf) -> io::Result<Self> {
		check_helper(&helper)?;
		Ok(Self { helper })
	}
}
fn tail_append(tail: &Mutex<String>, text: &str) {
	let mut tail = tail
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner);
	tail.push_str(text);
	let length = utf16_len(&tail);
	if length > STDERR_TAIL_CHARS {
		*tail = slice(&tail, length - STDERR_TAIL_CHARS, length).into_owned();
	}
}
fn diagnostic(tail: &Mutex<String>, operation: &str, error: &io::Error) {
	tail_append(
		tail,
		&format!(
			"\n[runner] {operation}: {}",
			research_net::errors::io_error_code(error)
		),
	);
}
fn executable(command: &str, env: &Environment, cwd: &Path) -> io::Result<PathBuf> {
	let candidate = if command.contains('/') {
		let path = Path::new(command);
		if path.is_absolute() {
			path.to_owned()
		} else {
			cwd.join(path)
		}
	} else {
		let path = env.get("PATH").map_or("/usr/bin:/bin", String::as_str);
		let mut permission = false;
		let found = std::env::split_paths(path).find_map(|dir| {
			let dir = if dir.is_absolute() {
				dir
			} else {
				cwd.join(dir)
			};
			let file = dir.join(command);
			match std::fs::metadata(&file) {
				Ok(m) if m.is_file() && m.permissions().mode() & 0o111 != 0 => Some(file),
				Ok(_) => {
					permission = true;
					None
				}
				Err(e) => {
					permission |= e.kind() == io::ErrorKind::PermissionDenied;
					None
				}
			}
		});
		return found.ok_or_else(|| {
			io::Error::from_raw_os_error(if permission {
				libc::EACCES
			} else {
				libc::ENOENT
			})
		});
	};
	let metadata = std::fs::metadata(&candidate)?;
	if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
		return Err(io::Error::from_raw_os_error(libc::EACCES));
	}
	Ok(candidate)
}
fn signal_group(pid: Pid, signal: Signal, tail: &Mutex<String>) {
	if let Err(error) = kill_process_group(pid, signal) {
		if error != Errno::SRCH {
			diagnostic(
				tail,
				&format!(
					"SIG{}",
					if signal == Signal::TERM {
						"TERM"
					} else {
						"KILL"
					}
				),
				&io::Error::from_raw_os_error(error.raw_os_error()),
			);
		}
	}
}
// Known limitation shared with the TypeScript: between the liveness poll and a signal the
// group id could in theory be reused by an unrelated process (pid-reuse window). The poll
// stops signalling as soon as the group is gone, which keeps the window to 25 ms.
async fn terminate(pid: Pid, tail: &Mutex<String>) {
	signal_group(pid, Signal::TERM, tail);
	let mut waited = 0;
	let mut force = false;
	loop {
		tokio::time::sleep(Duration::from_millis(GROUP_POLL_MS)).await;
		waited += GROUP_POLL_MS;
		if test_kill_process_group(pid) == Err(Errno::SRCH) {
			return;
		}
		if !force && waited >= DEFAULT_KILL_GRACE_MS {
			signal_group(pid, Signal::KILL, tail);
			force = true;
		} else if force && waited >= DEFAULT_KILL_GRACE_MS + KILL_CONFIRM_MS {
			tail_append(tail, "\n[runner] process group still alive after SIGKILL");
			return;
		}
	}
}
impl ProcessRunner for UnixProcessRunner {
	fn run(&self, spec: ProcessSpec) -> io::Result<ProcessHandle> {
		// Empty cwd is an ENOENT as for Node, rather than silently using the parent cwd.
		if spec.cwd.as_os_str().is_empty() {
			return Err(io::Error::from_raw_os_error(libc::ENOENT));
		}
		let cwd = if spec.cwd.is_absolute() {
			spec.cwd.clone()
		} else {
			std::env::current_dir()?.join(&spec.cwd)
		};
		check_helper(&self.helper)?;
		let command = executable(&spec.command, &spec.env, &cwd)?;
		// argv[0] is the command exactly as given (Node/libuv parity); the helper gets
		// the resolved path first and the argv[0] second.
		let mut child = tokio::process::Command::new(&self.helper)
			.arg(command)
			.arg(&spec.command)
			.args(&spec.args)
			.current_dir(cwd)
			.env_clear()
			.envs(&spec.env)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()?;
		let pid = child
			.id()
			.and_then(|v| i32::try_from(v).ok())
			.and_then(Pid::from_raw)
			.ok_or_else(|| io::Error::other("child pid unavailable"))?;
		let tail = Arc::new(Mutex::new(String::new()));
		let (lines_tx, lines_rx) = mpsc::channel(64);
		let (ready_tx, ready_rx) = oneshot::channel();
		let stdout = child.stdout.take();
		let stderr = child.stderr.take();
		let stdin = child.stdin.take();
		let out_tail = tail.clone();
		let stdout_task = tokio::spawn(async move {
			let Some(mut stdout) = stdout else {
				return;
			};
			let mut splitter = LineSplitter::new(MAX_LINE_CHARS);
			let mut buffer = vec![0; 65536];
			loop {
				let read = tokio::select! { biased; _ = lines_tx.closed() => return, v = stdout.read(&mut buffer) => v };
				match read {
					Ok(0) => {
						for line in splitter.finish() {
							if lines_tx.send(line).await.is_err() {
								return;
							}
						}
						return;
					}
					Ok(n) => {
						for line in splitter.push(buffer.get(..n).unwrap_or_default()) {
							if lines_tx.send(line).await.is_err() {
								return;
							}
						}
					}
					Err(error) => {
						diagnostic(&out_tail, "stdout", &error);
						return;
					}
				}
			}
		});
		let err_tail = tail.clone();
		let stderr_task = tokio::spawn(async move {
			let Some(mut stderr) = stderr else {
				return;
			};
			let mut buffer = vec![0; 65536];
			let mut decoder = Utf8Decoder::new(false);
			let mut handshake = Vec::new();
			let mut ready = Some(ready_tx);
			loop {
				match stderr.read(&mut buffer).await {
					Ok(0) => {
						tail_append(&err_tail, &decoder.push(&[], true));
						return;
					}
					Ok(n) => {
						let mut bytes = buffer.get(..n).unwrap_or_default();
						if ready.is_some() {
							handshake.extend_from_slice(bytes);
							let Some(newline) = memchr::memchr(b'\n', &handshake) else {
								continue;
							};
							if handshake.get(..=newline) == Some(b"\x1eRESEARCH_PROCESS_READY\n") {
								if let Some(tx) = ready.take() {
									// The spawner may have stopped waiting (aborted); nothing to tell.
									let _ = tx.send(());
								}
							} else {
								ready.take();
							}
							bytes = handshake.get(newline + 1..).unwrap_or_default();
						}
						tail_append(&err_tail, &decoder.push(bytes, false));
						handshake.clear();
					}
					Err(error) => {
						diagnostic(&err_tail, "stderr", &error);
						return;
					}
				}
			}
		});
		let in_tail = tail.clone();
		let stdin_task = tokio::spawn(async move {
			if let Some(mut stdin) = stdin {
				if let Err(error) = stdin.write_all(spec.stdin.as_bytes()).await {
					diagnostic(&in_tail, "stdin", &error);
				}
			}
		});
		let (exit_tx, exit_rx) = oneshot::channel();
		tokio::spawn(async move {
			// Reap immediately and concurrently with group polling: zombies keep killpg(0) alive.
			let wait_task = tokio::spawn(async move { child.wait().await });
			let closed = async {
				let status = wait_task.await.map_err(io::Error::other)?;
				// The readers' output is already in the tail; their end must not hide the exit status.
				let _ = stdout_task.await;
				let _ = stderr_task.await;
				status
			};
			tokio::pin!(closed);
			let status = tokio::select! { biased;
				status = &mut closed => status,
				_ = spec.cancel.cancelled() => {
					// Do not race setsid: a pre-aborted spawn must still kill the new group.
					let _ = ready_rx.await;
					let (_,status) = tokio::join!(terminate(pid, &tail), &mut closed);
					status
				},
			};
			stdin_task.abort();
			let result = status.map(|status| ProcessExit {
				code: status.code(),
				signal: status.signal().map(|n| {
					format!(
						"SIG{}",
						match n {
							libc::SIGTERM => "TERM".to_owned(),
							libc::SIGKILL => "KILL".to_owned(),
							libc::SIGINT => "INT".to_owned(),
							libc::SIGPIPE => "PIPE".to_owned(),
							libc::SIGABRT => "ABRT".to_owned(),
							_ => n.to_string(),
						}
					)
				}),
				stderr_tail: tail
					.lock()
					.unwrap_or_else(std::sync::PoisonError::into_inner)
					.clone(),
			});
			// The handle may have been dropped (turn closed); nobody is left to tell.
			let _ = exit_tx.send(result);
		});
		Ok(ProcessHandle {
			stdout_lines: futures_util::stream::unfold(lines_rx, |mut rx| async {
				rx.recv().await.map(|line| (line, rx))
			})
			.boxed(),
			exit: Box::pin(async { exit_rx.await.map_err(io::Error::other)? }),
		})
	}
}
