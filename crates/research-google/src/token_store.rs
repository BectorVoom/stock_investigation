//! Atomic owner-only refresh-token persistence (SEC-005). Corrupt reads remain untouched.
use research_finance::ports::Secret;
use research_js::json::{self, Object, Value};
use std::path::Path;
use tokio::io::AsyncWriteExt;
/// Version-one token record. Debug redacts the refresh token.
#[derive(Clone, Debug)]
pub struct GoogleTokenRecord {
	/// Long-lived credential.
	pub refresh_token: Secret,
	/// App-created calendar id.
	pub calendar_id: String,
	/// Granted scope string.
	pub scope: String,
	/// Time of persistence.
	pub saved_at: String,
}
/// Fixed, log-safe token-store failure.
#[derive(Debug, thiserror::Error)]
pub enum TokenStoreError {
	/// Record does not meet the persisted schema.
	#[error("invalid Google token record")]
	InvalidRecord,
	/// Filesystem failure. The error never contains the token record.
	#[error("Google token file operation failed: {0}")]
	Io(#[from] std::io::Error),
}
/// Decodes the strict version-one record with code-point string bounds and JS JSON semantics.
pub fn decode_token_record(text: &str) -> Option<GoogleTokenRecord> {
	let value = json::parse(text).ok()?;
	let object = value.as_object()?;
	if object.len() != 5 || object.get("version")?.as_f64() != Some(1.0) {
		return None;
	}
	let read = |key, max| {
		let text = object.get(key)?.as_str()?;
		(1..=max)
			.contains(&text.chars().count())
			.then(|| text.to_owned())
	};
	Some(GoogleTokenRecord {
		refresh_token: Secret::new(read("refreshToken", 2000)?),
		calendar_id: read("calendarId", 256)?,
		scope: read("scope", 200)?,
		saved_at: read("savedAt", 64)?,
	})
}
/// Serializes keys in their exact schema order, with a trailing newline.
pub fn encode_token_record(record: &GoogleTokenRecord) -> Result<String, TokenStoreError> {
	let mut object = Object::new();
	object.insert("version", Value::Number(1.0));
	for (key, text, max) in [
		("refreshToken", record.refresh_token.expose(), 2000),
		("calendarId", &record.calendar_id, 256),
		("scope", &record.scope, 200),
		("savedAt", &record.saved_at, 64),
	] {
		if !(1..=max).contains(&text.chars().count()) {
			return Err(TokenStoreError::InvalidRecord);
		}
		object.insert(key, Value::String(text.to_owned()));
	}
	Ok(format!("{}\n", json::stringify(&Value::Object(object))))
}
/// Missing, unreadable, malformed and invalid records all mean not connected.
pub async fn read_google_token_file(path: &Path) -> Option<GoogleTokenRecord> {
	let bytes = tokio::fs::read(path).await.ok()?;
	decode_token_record(&String::from_utf8_lossy(&bytes))
}
// RECORDED (same as the TypeScript, deliberately not changed): the temporary
// file is opened without O_EXCL / no-follow and neither it nor its directory is
// fsynced before the rename. The directory is the owner's 0700 runner directory.
/// Atomically replaces the token record with mode 0600; creates new parent directories 0700.
pub async fn write_google_token_file(
	path: &Path,
	record: &GoogleTokenRecord,
) -> Result<(), TokenStoreError> {
	let text = encode_token_record(record)?;
	let parent = path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.unwrap_or_else(|| Path::new("."));
	let mut builder = tokio::fs::DirBuilder::new();
	builder.recursive(true);
	#[cfg(unix)]
	builder.mode(0o700);
	builder.create(parent).await?;
	let mut temp = path.as_os_str().to_os_string();
	temp.push(format!(".{}.tmp", std::process::id()));
	let temp = std::path::PathBuf::from(temp);
	let written = async {
		let mut options = tokio::fs::OpenOptions::new();
		options.write(true).create(true).truncate(true);
		#[cfg(unix)]
		options.mode(0o600);
		let mut file = options.open(&temp).await?;
		file.write_all(text.as_bytes()).await?;
		drop(file);
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await?;
		}
		tokio::fs::rename(&temp, path).await
	}
	.await;
	if written.is_err() {
		let _ = tokio::fs::remove_file(&temp).await;
	}
	written.map_err(TokenStoreError::Io)
}
/// Removes a record, including a corrupt one; missing is already disconnected.
pub async fn delete_google_token_file(path: &Path) -> Result<(), TokenStoreError> {
	match tokio::fs::remove_file(path).await {
		Ok(()) => Ok(()),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
		Err(e) => Err(e.into()),
	}
}
