//! Real child processes: the process runner, the external-process protocol and the registry
//! composition. Uses the compiled `research-provider-spawn` companion, which the runner package owns.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing,
	unreachable_pub
)]
mod support;
use futures_util::StreamExt;
use research_agent_core::runtime::AgentRuntime;
use research_contracts::agent::{AgentAvailability, AgentEvent, UnavailableReason};
use research_providers::{
	environment::{Environment, ProviderEnvironment},
	external::{ExternalProcessRuntime, parse_external_configs},
	process::{ProcessRunner, ProcessSpec, UnixProcessRunner},
};
use std::{path::PathBuf, sync::Arc, time::Instant};
use support::*;
use tokio_util::sync::CancellationToken;

fn runner() -> UnixProcessRunner {
	UnixProcessRunner::with_helper(PathBuf::from(env!("CARGO_BIN_EXE_research-provider-spawn")))
		.unwrap()
}

fn real_env() -> Environment {
	let mut env = Environment::new();
	for key in ["PATH", "HOME", "USER", "LANG", "TMPDIR"] {
		if let Ok(v) = std::env::var(key) {
			env.insert(key.to_owned(), v);
		}
	}
	env
}

fn spec(command: &str, args: &[&str], cancel: CancellationToken) -> ProcessSpec {
	ProcessSpec {
		command: command.to_owned(),
		args: args.iter().map(|s| (*s).to_owned()).collect(),
		cwd: std::env::temp_dir(),
		env: real_env(),
		stdin: String::new(),
		cancel,
	}
}

async fn drain(spec: ProcessSpec) -> (Vec<String>, research_providers::process::ProcessExit) {
	let handle = runner().run(spec).unwrap();
	let lines = handle.stdout_lines.collect::<Vec<_>>().await;
	(lines, handle.exit.await.unwrap())
}

#[tokio::test]
async fn stdin_stdout_exit_and_a_complete_environment() {
	let mut s = spec(
		"sh",
		&["-c", "cat; echo \"[$SECRET_KEY]\"; echo oops >&2; exit 3"],
		CancellationToken::new(),
	);
	s.stdin = "one\r\ntwo\n".to_owned();
	let (lines, exit) = drain(s).await;
	assert_eq!(lines, vec!["one", "two", "[]"]);
	assert_eq!(exit.code, Some(3));
	assert_eq!(exit.signal, None);
	assert_eq!(exit.stderr_tail, "oops\n");
}

#[tokio::test]
async fn a_missing_command_is_not_found() {
	let error = runner()
		.run(spec("no-such-command-xyz", &[], CancellationToken::new()))
		.err()
		.unwrap();
	assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
}

#[tokio::test]
async fn abort_terminates_the_whole_process_group_within_the_bound() {
	let cancel = CancellationToken::new();
	let started = Instant::now();
	let handle = runner()
		.run(spec(
			"sh",
			&["-c", "sleep 60 & sleep 60 & wait"],
			cancel.clone(),
		))
		.unwrap();
	tokio::time::sleep(std::time::Duration::from_millis(200)).await;
	cancel.cancel();
	let exit = handle.exit.await.unwrap();
	assert_eq!(exit.signal.as_deref(), Some("SIGTERM"));
	assert!(
		started.elapsed().as_millis() < 3100,
		"{:?}",
		started.elapsed()
	);
}

#[tokio::test]
async fn a_pre_aborted_spawn_still_kills_the_new_group() {
	let cancel = CancellationToken::new();
	cancel.cancel();
	let handle = runner().run(spec("sleep", &["60"], cancel)).unwrap();
	let exit = handle.exit.await.unwrap();
	assert_eq!(exit.signal.as_deref(), Some("SIGTERM"));
}

#[tokio::test]
async fn a_normal_exit_never_signals_surviving_descendants() {
	let marker = tempfile::tempdir().unwrap();
	let pid_file = marker.path().join("pid");
	let script = format!("sleep 5 >/dev/null 2>&1 & echo $! > {}", pid_file.display());
	let (_, exit) = drain(spec("sh", &["-c", &script], CancellationToken::new())).await;
	assert_eq!(exit.code, Some(0));
	let pid = std::fs::read_to_string(&pid_file)
		.unwrap()
		.trim()
		.to_owned();
	let alive = std::process::Command::new("kill")
		.args(["-0", &pid])
		.status()
		.unwrap()
		.success();
	let _ = std::process::Command::new("kill").arg(&pid).status();
	assert!(alive, "descendant must survive a run that ended on its own");
}

fn external_environment() -> ProviderEnvironment {
	environment(Arc::new(runner()), unused_http(), real_env())
}

fn external_config(root: &std::path::Path) -> String {
	serde_json::json!([{
		"agentId": "scripted",
		"displayName": "Scripted example agent",
		"costModel": "plan-limited",
		"toolIsolation": "enforced",
		"command": "node",
		"args": [root.join("examples/extensions/externalProcess/scripted.ts")],
		"cwd": root,
		"envKeys": []
	}])
	.to_string()
}

#[tokio::test]
async fn the_typescript_wrapper_serves_probe_and_run_over_the_protocol() {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../..")
		.canonicalize()
		.unwrap();
	let configs = parse_external_configs(&external_config(&root)).unwrap();
	let runtime = ExternalProcessRuntime::new(configs[0].clone(), external_environment());
	let probe = runtime.probe().await;
	assert!(matches!(probe.availability, AgentAvailability::Available));
	let events = collect(runtime.run(request(), ctx())).await;
	let text: String = events
		.iter()
		.filter_map(|e| match e {
			AgentEvent::TextDelta { text } => Some(text.as_str()),
			_ => None,
		})
		.collect();
	assert_eq!(text, "OK 😀");
	assert!(matches!(events.last(), Some(AgentEvent::Completed)));
}

#[tokio::test]
async fn an_unknown_external_command_probes_as_not_installed() {
	let root = std::env::temp_dir();
	let mut text: serde_json::Value = serde_json::from_str(&external_config(&root)).unwrap();
	text[0]["command"] = "no-such-command-xyz".into();
	let configs = parse_external_configs(&text.to_string()).unwrap();
	let probe = ExternalProcessRuntime::new(configs[0].clone(), external_environment())
		.probe()
		.await;
	assert!(matches!(
		probe.availability,
		AgentAvailability::Unavailable {
			reason_code: UnavailableReason::NotInstalled,
			..
		}
	));
}

#[test]
fn registration_files_are_strict() {
	let root = std::env::temp_dir();
	let good: serde_json::Value = serde_json::from_str(&external_config(&root)).unwrap();
	assert_eq!(parse_external_configs(&good.to_string()).unwrap().len(), 1);
	let mut extra = good.clone();
	extra[0]["unknown"] = 1.into();
	let mut relative = good.clone();
	relative[0]["cwd"] = "relative".into();
	let mut bad_env = good.clone();
	bad_env[0]["envKeys"] = serde_json::json!(["A=B"]);
	let mut bad_id = good.clone();
	bad_id[0]["agentId"] = "Bad Id".into();
	for bad in [extra, relative, bad_env, bad_id] {
		assert!(parse_external_configs(&bad.to_string()).is_err(), "{bad}");
	}
	assert!(parse_external_configs("{").is_err());
	assert!(parse_external_configs("{}").is_err());
}

/// Real-environment check (quota-free `opencode models`): run with
/// `cargo test -p research-providers --test process -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "needs the opencode CLI installed"]
async fn the_real_opencode_probe_prints_its_descriptor() {
	let mut env = real_env();
	env.remove("OPENCODE_MODEL");
	let runtime = research_providers::opencode::OpenCodeRuntime::new(environment(
		Arc::new(runner()),
		unused_http(),
		env,
	));
	let probe = runtime.probe().await;
	println!(
		"PROBE {}",
		serde_json::json!({"capabilities": probe.capabilities, "availability": probe.availability})
	);
}

fn alive(pid: &str) -> bool {
	std::process::Command::new("kill")
		.args(["-0", pid])
		.status()
		.unwrap()
		.success()
}

/// Review finding: a CLI the wrapped runtime started in its own process group must die
/// when the runner aborts the external process.
#[tokio::test]
async fn aborting_an_external_turn_kills_a_detached_grandchild() {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../..")
		.canonicalize()
		.unwrap();
	let dir = tempfile::tempdir().unwrap();
	let pid_file = dir.path().join("pid");
	let mut config: serde_json::Value = serde_json::from_str(&external_config(&root)).unwrap();
	config[0]["args"] =
		serde_json::json!([root.join("examples/extensions/externalProcess/detachedChild.ts")]);
	config[0]["envKeys"] = serde_json::json!(["PIDFILE"]);
	let configs = parse_external_configs(&config.to_string()).unwrap();
	let mut env = real_env();
	env.insert("PIDFILE".to_owned(), pid_file.display().to_string());
	let runtime = ExternalProcessRuntime::new(
		configs[0].clone(),
		environment(Arc::new(runner()), unused_http(), env),
	);
	let cancel = CancellationToken::new();
	let mut context = ctx();
	context.cancel = cancel.clone();
	let mut turn = runtime.run(request(), context);
	let mut pid = String::new();
	for _ in 0..100 {
		if let Ok(text) = std::fs::read_to_string(&pid_file) {
			if text.ends_with('\n') {
				pid = text.trim().to_owned();
				break;
			}
		}
		tokio::time::sleep(std::time::Duration::from_millis(100)).await;
	}
	assert!(!pid.is_empty(), "the grandchild never started");
	assert!(alive(&pid));
	cancel.cancel();
	while turn.next().await.is_some() {}
	let _ = turn.close().await;
	tokio::time::sleep(std::time::Duration::from_millis(300)).await;
	let survived = alive(&pid);
	if survived {
		let _ = std::process::Command::new("kill")
			.args(["-9", &pid])
			.status();
	}
	assert!(!survived, "detached grandchild survived the abort");
}

#[tokio::test]
async fn a_missing_helper_is_reported_distinctly() {
	let error =
		UnixProcessRunner::with_helper(PathBuf::from("/nonexistent/research-provider-spawn"))
			.err()
			.unwrap();
	assert!(research_providers::process::is_helper_missing(&error));
	assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
}

/// Wave C guard: events written for the wire print integers without a fraction.
#[test]
fn wire_events_print_zero_not_zero_point_zero() {
	let event = AgentEvent::Usage {
		known_cost_usd: Some(0.0),
	};
	assert_eq!(
		research_contracts::json::to_js_json(&event).unwrap(),
		r#"{"type":"usage","knownCostUsd":0}"#
	);
}
