//! The scripted agent (port of the `createScriptedAgent` block of
//! `tests/e2e/runnerHarness.ts`) is NOT reimplemented: it is the TypeScript
//! backend `tests/e2e/e2eScriptedAgent.ts`, served through the FR-013
//! external-process protocol by `tests/e2e/e2eExternalAgent.ts` (the stdio
//! wrapper `examples/extensions/externalProcess/serve.ts`). The prompts the
//! Rust pipeline builds are therefore answered by the same scripted logic the
//! Node harness uses in process. This module writes the owner registration
//! file (`RESEARCH_EXTERNAL_AGENTS`) that points at it, and provides the
//! scripted scratch directories.

use std::io;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use research_runner::scratch::ScratchDirectories;

/// Repository-relative entry point of the scripted agent process.
pub const AGENT_ENTRY: &str = "tests/e2e/e2eExternalAgent.ts";

/// The registration document (docs/EXTERNAL_AGENT_PROTOCOL.md): one `scripted`
/// agent run by `node` from the repository root.
#[must_use]
pub fn registration_json(repo_root: &Path) -> String {
	serde_json::json!([{
		"agentId": "scripted",
		"displayName": "Scripted example agent",
		"costModel": "plan-limited",
		"toolIsolation": "enforced",
		"command": "node",
		"args": [repo_root.join(AGENT_ENTRY)],
		"cwd": repo_root,
		"envKeys": [],
	}])
	.to_string()
}

/// Writes the registration file into `directory` and returns its path.
///
/// # Errors
/// The file cannot be written.
pub fn write_registration(repo_root: &Path, directory: &Path) -> io::Result<PathBuf> {
	let file = directory.join("external-agents.json");
	std::fs::write(&file, registration_json(repo_root))?;
	Ok(file)
}

/// Scripted scratch directories: `create` returns `/nonexistent/e2e/<runId>`
/// and creates nothing, `remove` does nothing (the scripted agent never
/// touches the filesystem).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoScratch;

#[async_trait]
impl ScratchDirectories for NoScratch {
	async fn create(&self, run_id: &str) -> io::Result<PathBuf> {
		Ok(PathBuf::from(format!("/nonexistent/e2e/{run_id}")))
	}

	async fn remove(&self, _path: &Path) -> io::Result<()> {
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use research_providers::external::parse_external_configs;

	#[test]
	fn the_registration_passes_the_runner_own_validation() {
		let json = registration_json(Path::new("/repo"));
		let configs = parse_external_configs(&json).unwrap();
		assert_eq!(configs.len(), 1);
		assert_eq!(configs[0].agent_id, "scripted");
		assert_eq!(configs[0].command, "node");
		assert_eq!(
			configs[0].args,
			vec!["/repo/tests/e2e/e2eExternalAgent.ts".to_owned()]
		);
	}

	#[tokio::test]
	async fn scripted_scratch_creates_nothing() {
		let path = NoScratch.create("run_1").await.unwrap();
		assert_eq!(path, Path::new("/nonexistent/e2e/run_1"));
		assert!(!path.exists());
		NoScratch.remove(&path).await.unwrap();
	}
}
