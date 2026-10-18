//! Per-job scratch directories (AGT-004; shell-wire spec section 1.4): created
//! empty before the job runs, removed when it ends.

use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use async_trait::async_trait;

/// Per-job scratch directories.
#[async_trait]
pub trait ScratchDirectories: Send + Sync {
	/// Creates an empty private directory for the job.
	async fn create(&self, run_id: &str) -> io::Result<PathBuf>;
	/// Removes a directory made by [`ScratchDirectories::create`], recursively; absent is fine.
	async fn remove(&self, path: &Path) -> io::Result<()>;
}

/// Scratch directories under one root: `<root>/job-XXXXXX`, mode 0700.
#[derive(Clone, Debug)]
pub struct TempScratch {
	root: PathBuf,
}

impl TempScratch {
	/// Scratch directories below `root` (created on first use).
	#[must_use]
	pub const fn new(root: PathBuf) -> Self {
		Self { root }
	}

	/// The default root below Node's `os.tmpdir()`: `TMPDIR`, then `TMP`, then
	/// `TEMP` (the first non-empty), else `/tmp`; a trailing slash is dropped
	/// (`/` itself stays). Rust's
	/// `temp_dir()` falls back to `confstr` on macOS where Node's `os.tmpdir()`
	/// does not, and the test environment strips `TMPDIR`.
	#[must_use]
	pub fn default_root_from_env(env: &crate::config::Env) -> PathBuf {
		let tmpdir = ["TMPDIR", "TMP", "TEMP"]
			.iter()
			.filter_map(|key| env.get(*key))
			.find(|value| !value.is_empty());
		Self::default_root(tmpdir.map(String::as_str))
	}

	/// As [`TempScratch::default_root_from_env`] for an already chosen directory.
	#[must_use]
	pub fn default_root(tmpdir: Option<&str>) -> PathBuf {
		let base = tmpdir.filter(|value| !value.is_empty()).unwrap_or("/tmp");
		let base = if base.len() > 1 {
			base.trim_end_matches('/')
		} else {
			base
		};
		let base = if base.is_empty() { "/" } else { base };
		Path::new(base).join("research-runner")
	}
}

#[async_trait]
impl ScratchDirectories for TempScratch {
	async fn create(&self, _run_id: &str) -> io::Result<PathBuf> {
		let root = self.root.clone();
		tokio::task::spawn_blocking(move || {
			std::fs::DirBuilder::new()
				.recursive(true)
				.mode(0o700)
				.create(&root)?;
			// The directory has mode 0700 and an unpredictable six-character suffix.
			let directory = tempfile::Builder::new()
				.prefix("job-")
				.rand_bytes(6)
				.permissions(std::fs::Permissions::from_mode(0o700))
				.tempdir_in(&root)?;
			Ok(directory.keep())
		})
		.await
		.map_err(io::Error::other)?
	}

	async fn remove(&self, path: &Path) -> io::Result<()> {
		match tokio::fs::remove_dir_all(path).await {
			Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
			_ => Ok(()),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn creates_private_job_directories_and_removes_them() {
		let base = tempfile::tempdir().unwrap();
		let scratch = TempScratch::new(base.path().join("nested/root"));
		let first = scratch.create("run_a").await.unwrap();
		let second = scratch.create("run_a").await.unwrap();
		assert_ne!(first, second);
		let name = first.file_name().unwrap().to_string_lossy().into_owned();
		assert!(name.starts_with("job-") && name.len() == 10, "{name}");
		for directory in [&first, &second] {
			let mode = std::fs::metadata(directory).unwrap().permissions().mode();
			assert_eq!(mode & 0o777, 0o700);
			assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
		}
		std::fs::write(first.join("file"), "x").unwrap();
		scratch.remove(&first).await.unwrap();
		assert!(!first.exists());
		// Removing twice is fine (force).
		scratch.remove(&first).await.unwrap();
		assert!(second.exists());
	}

	#[test]
	fn the_default_root_follows_node_tmpdir_order() {
		let env = |pairs: &[(&str, &str)]| -> crate::config::Env {
			pairs
				.iter()
				.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
				.collect()
		};
		let root = |pairs: &[(&str, &str)]| TempScratch::default_root_from_env(&env(pairs));
		assert_eq!(
			root(&[("TMPDIR", "/a/"), ("TMP", "/b")]),
			Path::new("/a/research-runner")
		);
		assert_eq!(
			root(&[("TMPDIR", ""), ("TMP", "/b")]),
			Path::new("/b/research-runner")
		);
		assert_eq!(root(&[("TEMP", "/c//")]), Path::new("/c/research-runner"));
		assert_eq!(
			root(&[("TMP", "/b"), ("TEMP", "/c")]),
			Path::new("/b/research-runner")
		);
		assert_eq!(root(&[]), Path::new("/tmp/research-runner"));
		assert_eq!(root(&[("TMPDIR", "/")]), Path::new("/research-runner"));
	}

	#[test]
	fn the_default_root_follows_tmpdir_then_tmp() {
		assert_eq!(
			TempScratch::default_root(Some("/var/x")),
			Path::new("/var/x/research-runner")
		);
		assert_eq!(
			TempScratch::default_root(None),
			Path::new("/tmp/research-runner")
		);
		assert_eq!(
			TempScratch::default_root(Some("")),
			Path::new("/tmp/research-runner")
		);
	}
}
