//! File-system `PageArchive` for the runner (port of
//! `packages/adapters/src/node/pageArchive.ts`).
//!
//! The archive is write-only storage for already-retrieved pages: the file
//! name is built only from the retrieval date, the final URL's host and a
//! hash of the final URL, so no page content can steer where a file is
//! written (SEC-001). Front matter values are `JSON.stringify` scalars, so a
//! hostile title cannot break out of the front matter block.
//!
//! Write sequence (identical to the TypeScript): `mkdir -p` with mode 0700,
//! write `<name>.tmp-<16 hex>` with mode 0600, `chmod 0600`, atomic rename
//! over `<name>` (the same URL on the same day replaces the file); any failure
//! removes the temporary file and is reported ONCE as `ARCHIVE_WRITE_FAILED`
//! with the OS error code (`EACCES`) or the error class, never a path or page
//! content.

use std::fs::{DirBuilder, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use research_application::ports::{ArchiveWriteFailed, ArchivedPage, Hasher, PageArchive};
use research_js::json_text::quote;
use url::Url;

/// `createFilePageArchive({ directory, hasher })`.
pub struct FilePageArchive {
	directory: PathBuf,
	hasher: Arc<dyn Hasher>,
}

impl std::fmt::Debug for FilePageArchive {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("FilePageArchive")
			.field("directory", &self.directory)
			.finish()
	}
}

impl FilePageArchive {
	/// An archive writing into `directory` (created on first save).
	#[must_use]
	pub fn new(directory: impl Into<PathBuf>, hasher: Arc<dyn Hasher>) -> Self {
		Self {
			directory: directory.into(),
			hasher,
		}
	}
}

/// `/^(\d{4}-\d{2}-\d{2})/` else `"0000-00-00"`.
fn date_part(retrieved_at: &str) -> &str {
	let bytes = retrieved_at.as_bytes();
	let shaped = bytes.len() >= 10
		&& bytes.iter().take(10).enumerate().all(|(index, byte)| {
			if index == 4 || index == 7 {
				*byte == b'-'
			} else {
				byte.is_ascii_digit()
			}
		});
	if shaped {
		retrieved_at.get(..10).unwrap_or("0000-00-00")
	} else {
		"0000-00-00"
	}
}

/// Hostname reduced to `[a-z0-9.-]` and cut to 80 characters; never empty.
fn safe_host(final_url: &str) -> String {
	// `new URL(finalUrl).hostname.toLowerCase()`; a malformed URL names no host
	// and the hash in the name still keeps the file unique.
	let host = Url::parse(final_url).map_or_else(
		|_| "unknown-host".to_owned(),
		|url| url.host_str().unwrap_or("").to_lowercase(),
	);
	// Only ASCII survives, so 80 characters are 80 bytes.
	let cleaned: String = host
		.chars()
		.filter(|character| {
			character.is_ascii_lowercase()
				|| character.is_ascii_digit()
				|| *character == '.'
				|| *character == '-'
		})
		.take(80)
		.collect();
	if cleaned.is_empty() {
		"unknown-host".to_owned()
	} else {
		cleaned
	}
}

fn render_file(page: &ArchivedPage, body_hash: &str) -> String {
	let omitted = page.omitted.unwrap_or_default();
	let title = page
		.title
		.as_deref()
		.map_or_else(|| "null".to_owned(), quote);
	[
		"---".to_owned(),
		format!("source_url: {}", quote(&page.source_url)),
		format!("final_url: {}", quote(&page.final_url)),
		format!("title: {title}"),
		format!("retrieved_at: {}", quote(&page.retrieved_at)),
		format!("sha256: {}", quote(body_hash)),
		format!("generator: {}", quote("research-workspace")),
		format!("omitted_boilerplate_blocks: {}", omitted.boilerplate_blocks),
		format!("omitted_menu_lists: {}", omitted.menu_lists),
		format!("omitted_leading_blocks: {}", omitted.leading_blocks),
		"---".to_owned(),
		String::new(),
		page.markdown.clone(),
		String::new(),
	]
	.join("\n")
}

/// The archive file name and content of `page`.
#[must_use]
pub fn prepare(page: &ArchivedPage, hasher: &dyn Hasher) -> (String, String) {
	let url_hash = hasher.sha256_hex(&page.final_url);
	let body_hash = hasher.sha256_hex(&page.markdown);
	let file_name = format!(
		"{}-{}-{}.md",
		date_part(&page.retrieved_at),
		safe_host(&page.final_url),
		url_hash.get(..16).unwrap_or(&url_hash)
	);
	(file_name, render_file(page, &body_hash))
}

/// `failure.errorCode ?? failure.errorName`.
fn failure_detail(error: &io::Error) -> String {
	error
		.raw_os_error()
		.and_then(crate::errors::errno_name)
		.unwrap_or_else(|| crate::errors::io_error_code(error))
		.to_owned()
}

fn random_suffix() -> io::Result<String> {
	let mut bytes = [0u8; 8];
	getrandom::getrandom(&mut bytes)
		.map_err(|error| io::Error::from_raw_os_error(error.raw_os_error().unwrap_or(libc::EIO)))?;
	Ok(hex::encode(bytes))
}

/// Sets the flag when dropped: the save future was cancelled (ADR-0030 C3).
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		self.0.store(true, Ordering::SeqCst);
	}
}

fn write_atomically(
	directory: &Path,
	file_name: &str,
	content: &str,
	cancelled: &AtomicBool,
) -> io::Result<()> {
	DirBuilder::new()
		.recursive(true)
		.mode(0o700)
		.create(directory)?;
	let temporary = directory.join(format!("{file_name}.tmp-{}", random_suffix()?));
	let final_path = directory.join(file_name);
	let written = (|| {
		let mut file = OpenOptions::new()
			.write(true)
			.create(true)
			.truncate(true)
			.mode(0o600)
			.open(&temporary)?;
		file.write_all(content.as_bytes())?;
		drop(file);
		std::fs::set_permissions(&temporary, Permissions::from_mode(0o600))?;
		// C3: a cancelled call must leave no archive file. The check sits right
		// before the atomic rename, the only step that makes the page visible
		// (a drop landing between check and rename is the residual window).
		if cancelled.load(Ordering::SeqCst) {
			return Err(io::Error::from(io::ErrorKind::Interrupted));
		}
		std::fs::rename(&temporary, &final_path)
	})();
	if written.is_err() {
		// Never leave a half-written page behind; a failed rename keeps the old file.
		let _ = std::fs::remove_file(&temporary);
	}
	written
}

#[async_trait]
impl PageArchive for FilePageArchive {
	async fn save(&self, page: &ArchivedPage) -> Result<String, ArchiveWriteFailed> {
		let directory = self.directory.clone();
		let hasher = Arc::clone(&self.hasher);
		let page = page.clone();
		let cancelled = Arc::new(AtomicBool::new(false));
		// Dropping this future (the call was cancelled) trips the flag; the
		// blocking job cannot be stopped, but it then removes its temp file
		// instead of renaming it into place.
		let _on_drop = CancelOnDrop(Arc::clone(&cancelled));
		// Hashing and file I/O are blocking work: keep them off the async workers.
		let outcome = tokio::task::spawn_blocking(move || {
			let (file_name, content) = prepare(&page, hasher.as_ref());
			write_atomically(&directory, &file_name, &content, &cancelled).map(|()| file_name)
		})
		.await;
		match outcome {
			Ok(Ok(file_name)) => Ok(file_name),
			Ok(Err(error)) => Err(ArchiveWriteFailed {
				detail: failure_detail(&error),
			}),
			Err(_) => Err(ArchiveWriteFailed {
				detail: "Error".to_owned(),
			}),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use research_application::ports::OmittedCounts;
	use sha2::{Digest, Sha256};

	struct Sha256Hasher;

	impl Hasher for Sha256Hasher {
		fn sha256_hex(&self, text: &str) -> String {
			hex::encode(Sha256::digest(text.as_bytes()))
		}
	}

	fn page() -> ArchivedPage {
		ArchivedPage {
			source_url: "https://news.synthetic-wire.org/feed-item".to_owned(),
			final_url: "https://news.synthetic-wire.org/2026/10/grid-battery-orders".to_owned(),
			title: Some("Grid battery orders double".to_owned()),
			retrieved_at: "2026-10-11T03:00:00.000Z".to_owned(),
			markdown: "# Grid battery orders double\n\nOrders doubled year over year.".to_owned(),
			omitted: None,
		}
	}

	fn archive(directory: &Path) -> FilePageArchive {
		FilePageArchive::new(directory, Arc::new(Sha256Hasher))
	}

	fn listing(directory: &Path) -> Vec<String> {
		let mut names: Vec<String> = std::fs::read_dir(directory)
			.unwrap()
			.map(|entry| entry.unwrap().file_name().into_string().unwrap())
			.collect();
		names.sort();
		names
	}

	/// Front matter fields (JSON values) and the body after the blank line.
	fn front_matter(content: &str) -> (Vec<(String, serde_json::Value)>, String) {
		let lines: Vec<&str> = content.split('\n').collect();
		assert_eq!(lines[0], "---");
		let mut fields = Vec::new();
		let mut index = 1;
		while lines[index] != "---" {
			let (name, value) = lines[index].split_once(':').unwrap();
			fields.push((name.to_owned(), serde_json::from_str(value.trim()).unwrap()));
			index += 1;
		}
		assert_eq!(lines[index + 1], "");
		(fields, lines[index + 2..].join("\n"))
	}

	fn field(fields: &[(String, serde_json::Value)], name: &str) -> serde_json::Value {
		fields
			.iter()
			.find(|(key, _)| key == name)
			.unwrap()
			.1
			.clone()
	}

	#[tokio::test]
	async fn writes_a_file_whose_name_carries_date_host_and_url_hash() {
		let directory = tempfile::tempdir().unwrap();
		let saved = archive(directory.path()).save(&page()).await.unwrap();
		let url_hash = Sha256Hasher.sha256_hex(&page().final_url);
		assert_eq!(
			saved,
			format!("2026-10-11-news.synthetic-wire.org-{}.md", &url_hash[..16])
		);
		assert_eq!(listing(directory.path()), [saved]);
	}

	#[tokio::test]
	async fn writes_front_matter_that_parses_back_to_the_page() {
		let directory = tempfile::tempdir().unwrap();
		let saved = archive(directory.path()).save(&page()).await.unwrap();
		let content = std::fs::read_to_string(directory.path().join(&saved)).unwrap();
		let (fields, body) = front_matter(&content);
		assert_eq!(field(&fields, "source_url"), page().source_url.as_str());
		assert_eq!(field(&fields, "final_url"), page().final_url.as_str());
		assert_eq!(field(&fields, "title"), "Grid battery orders double");
		assert_eq!(field(&fields, "retrieved_at"), page().retrieved_at.as_str());
		assert_eq!(field(&fields, "generator"), "research-workspace");
		assert_eq!(
			field(&fields, "sha256"),
			Sha256Hasher.sha256_hex(&page().markdown).as_str()
		);
		assert_eq!(field(&fields, "omitted_menu_lists"), 0);
		assert_eq!(body, format!("{}\n", page().markdown));
	}

	#[tokio::test]
	async fn writes_a_null_title_as_null_and_omitted_counts() {
		let directory = tempfile::tempdir().unwrap();
		let mut untitled = page();
		untitled.title = None;
		untitled.omitted = Some(OmittedCounts {
			boilerplate_blocks: 3,
			menu_lists: 2,
			leading_blocks: 1,
		});
		let saved = archive(directory.path()).save(&untitled).await.unwrap();
		let content = std::fs::read_to_string(directory.path().join(&saved)).unwrap();
		let (fields, _) = front_matter(&content);
		assert_eq!(field(&fields, "title"), serde_json::Value::Null);
		assert_eq!(field(&fields, "omitted_boilerplate_blocks"), 3);
		assert_eq!(field(&fields, "omitted_leading_blocks"), 1);
	}

	#[tokio::test]
	async fn keeps_a_hostile_title_inside_one_scalar() {
		let directory = tempfile::tempdir().unwrap();
		let hostile = "x\n---\nsource_url: evil\ntitle: \"injected";
		let mut page_with_title = page();
		page_with_title.title = Some(hostile.to_owned());
		let saved = archive(directory.path())
			.save(&page_with_title)
			.await
			.unwrap();
		let content = std::fs::read_to_string(directory.path().join(&saved)).unwrap();
		let (fields, _) = front_matter(&content);
		assert_eq!(field(&fields, "title"), hostile);
		assert_eq!(field(&fields, "source_url"), page().source_url.as_str());
	}

	#[tokio::test]
	async fn never_lets_hostile_hostname_characters_reach_the_file_name() {
		let directory = tempfile::tempdir().unwrap();
		let mut ipv6 = page();
		ipv6.final_url = "https://[::1]:8080/x?y=1".to_owned();
		let saved = archive(directory.path()).save(&ipv6).await.unwrap();
		assert!(saved.starts_with("2026-10-11-1-"), "{saved}");
		assert!(!saved.contains('[') && !saved.contains(':'));
		assert_eq!(safe_host("not a url"), "unknown-host");
		assert_eq!(
			safe_host("https://ÄÖ.example.org/"),
			"xn--4ca0b.example.org"
		);
		assert_eq!(
			safe_host(&format!("https://{}.org/", "a".repeat(100))).len(),
			80
		);
		assert_eq!(date_part("2026-1-11"), "0000-00-00");
		assert_eq!(date_part("2026-10-11"), "2026-10-11");
	}

	#[tokio::test]
	async fn creates_the_directory_with_mode_0700_and_files_with_mode_0600() {
		let parent = tempfile::tempdir().unwrap();
		let directory = parent.path().join("nested").join("archive");
		let saved = archive(&directory).save(&page()).await.unwrap();
		let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode(&directory), 0o700);
		assert_eq!(mode(&directory.join(saved)), 0o600);
	}

	#[tokio::test]
	async fn replaces_the_file_for_the_same_url_and_day_and_adds_one_for_another_day() {
		let directory = tempfile::tempdir().unwrap();
		let store = archive(directory.path());
		let first = store.save(&page()).await.unwrap();
		let mut updated = page();
		updated.markdown = "updated body".to_owned();
		let second = store.save(&updated).await.unwrap();
		assert_eq!(first, second);
		assert_eq!(listing(directory.path()).len(), 1);
		let content = std::fs::read_to_string(directory.path().join(&second)).unwrap();
		assert_eq!(front_matter(&content).1, "updated body\n");
		let mut next_day = page();
		next_day.retrieved_at = "2026-10-12T03:00:00.000Z".to_owned();
		assert_ne!(store.save(&next_day).await.unwrap(), first);
		assert_eq!(listing(directory.path()).len(), 2);
	}

	#[tokio::test]
	async fn leaves_no_temp_files_behind_and_reports_the_os_code_on_a_failed_write() {
		let directory = tempfile::tempdir().unwrap();
		let store = archive(directory.path());
		let saved = store.save(&page()).await.unwrap();
		std::fs::set_permissions(directory.path(), Permissions::from_mode(0o500)).unwrap();
		let mut blocked = page();
		blocked.markdown = "cannot land".to_owned();
		let failed = store.save(&blocked).await;
		std::fs::set_permissions(directory.path(), Permissions::from_mode(0o700)).unwrap();
		let failed = failed.unwrap_err();
		assert_eq!(failed.detail, "EACCES");
		assert!(
			listing(directory.path())
				.iter()
				.all(|name| !name.contains(".tmp-"))
		);
		let under_a_file = archive(&directory.path().join(saved).join("x"));
		assert_eq!(
			under_a_file.save(&page()).await.unwrap_err().detail,
			"ENOTDIR"
		);
	}

	/// Blocks inside the blocking job (while hashing) until released, so a test
	/// can drop the save future while the write is still pending.
	struct GatedHasher {
		entered: std::sync::mpsc::Sender<()>,
		release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
	}

	impl Hasher for GatedHasher {
		fn sha256_hex(&self, text: &str) -> String {
			let _ = self.entered.send(());
			let _ = self.release.lock().unwrap().recv();
			Sha256Hasher.sha256_hex(text)
		}
	}

	/// ADR-0030 C3: a save future dropped while its write is pending leaves no
	/// archive file and no temp file behind.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_dropped_save_leaves_no_file() {
		let directory = tempfile::tempdir().unwrap();
		let (entered, entered_receiver) = std::sync::mpsc::channel();
		let (release, release_receiver) = std::sync::mpsc::channel();
		let archive = FilePageArchive::new(
			directory.path(),
			Arc::new(GatedHasher {
				entered,
				release: std::sync::Mutex::new(release_receiver),
			}),
		);
		let page = page();
		{
			let mut save = Box::pin(archive.save(&page));
			tokio::select! {
				biased;
				_ = &mut save => panic!("finished before the drop"),
				_ = tokio::task::spawn_blocking(move || {
					entered_receiver.recv().unwrap();
				}) => {}
			}
			// `save` is dropped here, mid-job.
		}
		// Let the job continue (it hashes twice) and finish.
		release.send(()).unwrap();
		release.send(()).unwrap();
		tokio::time::sleep(std::time::Duration::from_millis(300)).await;
		assert_eq!(listing(directory.path()), Vec::<String>::new());
	}
}
