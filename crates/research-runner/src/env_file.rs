//! The `--env-file-if-exists=<path>` flag (shell-wire spec section 8).
//!
//! Node parses the file with its own dotenv dialect (`src/node_dotenv.cc`)
//! and lets existing environment variables win over file values. The Rust
//! binary implements the flag itself, before anything else in `main`: the
//! parser below reproduces Node 23's `Dotenv::ParseContent` quirk for quirk
//! (pinned by `vectors/runner/env_file.json`, generated with
//! `util.parseEnv` over a corpus), and the result is an overlay map handed to
//! configuration loading and to the agent runtimes — nothing calls
//! `std::env::set_var`, which is racy once threads exist.

use std::collections::BTreeMap;
use std::path::Path;

use crate::config::Env;

/// The flag's spelling, kept so launch plans and tests change minimally.
pub const ENV_FILE_FLAG: &str = "--env-file-if-exists=";

/// Why an env file could not be applied.
#[derive(Debug, thiserror::Error)]
pub enum EnvFileError {
	/// The file exists but could not be read (Node exits with an error too).
	#[error("env file unreadable")]
	Unreadable,
}

/// Spaces only: Node's `trim_spaces` leaves tabs alone.
fn trim_spaces(text: &str) -> &str {
	text.trim_matches(' ')
}

/// Parses dotenv text exactly like Node 23's `util.parseEnv`.
///
/// Several of Node's behaviours are bugs that are kept on purpose because a
/// file written for Node must mean the same here: a last line without a
/// newline does not advance the cursor (so `A=b=c` also defines `b`), `#`
/// comments are only stripped from an unquoted value that is followed by a
/// newline, and text after a closing quote is skipped up to the next newline.
#[must_use]
pub fn parse(input: &str) -> BTreeMap<String, String> {
	// Windows newlines: every "\r" is removed.
	let lines: String = input
		.chars()
		.filter(|&character| character != '\r')
		.collect();
	let mut content = trim_spaces(&lines);
	let mut store = BTreeMap::new();

	while !content.is_empty() {
		// Skip empty lines and comments.
		// Without a newline a leading `#` is not a comment (it starts a key).
		if content.starts_with('\n') || content.starts_with('#') {
			if let Some((_, rest)) = content.split_once('\n') {
				content = rest;
				continue;
			}
		}
		// The key ends at the next equals sign; no equals sign ends parsing.
		let Some((raw_key, after_equals)) = content.split_once('=') else {
			break;
		};
		let mut key = trim_spaces(raw_key);
		if key.is_empty() && !raw_key.is_empty() {
			// A key of only spaces: Node's `trim_spaces` strips the whole view with an
			// out-of-range `remove_prefix`, which leaves the byte just before the key.
			// Here that byte is always the newline that ended the previous line.
			key = "\n";
		}
		content = after_equals;
		if key.is_empty() {
			break;
		}
		key = key.strip_prefix("export ").unwrap_or(key);
		// `KEY=` (or `KEY=` followed by a newline) is the empty string.
		if content.is_empty() || content.starts_with('\n') {
			store.insert(key.to_owned(), String::new());
			continue;
		}
		content = trim_spaces(content);
		if content.is_empty() {
			store.insert(key.to_owned(), String::new());
			break;
		}
		let Some(opening) = content.chars().next() else {
			break;
		};
		let quoted = matches!(opening, '"' | '\'' | '`');
		let closing = quoted
			.then(|| {
				content
					.get(1..)
					.and_then(|rest| rest.find(opening))
					.map(|offset| offset + 1)
			})
			.flatten();
		if let (true, Some(closing)) = (quoted, closing) {
			let Some(value) = content.get(1..closing) else {
				break;
			};
			let value = if opening == '"' {
				// "\n" inside double quotes expands to a newline.
				value.replace("\\n", "\n")
			} else {
				value.to_owned()
			};
			store.insert(key.to_owned(), value);
			// The rest of the line after the closing quote is skipped. Without a
			// newline the cursor stays where it is (Node's behaviour).
			if let Some(rest) = content
				.get(closing + 1..)
				.and_then(|rest| rest.split_once('\n'))
			{
				content = rest.1;
			}
		} else if quoted {
			// No closing quote: the whole line is the value, quote included.
			if let Some((line, _)) = content.split_once('\n') {
				store.insert(key.to_owned(), line.to_owned());
				content = content.get(line.len()..).unwrap_or("");
			}
		} else if let Some((line, _)) = content.split_once('\n') {
			// A `#` starts a comment, but only before a newline.
			let value = line.split_once('#').map_or(line, |(before, _)| before);
			store.insert(key.to_owned(), trim_spaces(value).to_owned());
			content = content.get(line.len()..).unwrap_or("");
		} else {
			store.insert(key.to_owned(), trim_spaces(content).to_owned());
		}
	}
	store
}

/// Overlays `file` on `process`: an existing variable always wins, so the
/// launcher's `RESEARCH_API_URL`, `RUNNER_TOKEN`, `RUNNER_PAGES_DIR` and
/// `GOOGLE_TOKEN_FILE` can never be redirected by the file.
pub fn overlay(process: &mut Env, file: BTreeMap<String, String>) {
	for (key, value) in file {
		process.entry(key).or_insert(value);
	}
}

/// The path named by the first `--env-file-if-exists=<path>` argument.
#[must_use]
pub fn env_file_argument<I, S>(arguments: I) -> Option<String>
where
	I: IntoIterator<Item = S>,
	S: AsRef<str>,
{
	arguments.into_iter().find_map(|argument| {
		argument
			.as_ref()
			.strip_prefix(ENV_FILE_FLAG)
			.map(str::to_owned)
	})
}

/// Reads and overlays the file. A missing file is silently ignored (the flag
/// is "if exists"); any other read error is reported.
///
/// # Errors
/// [`EnvFileError::Unreadable`] when an existing file cannot be read.
pub fn apply_env_file(process: &mut Env, path: &Path) -> Result<(), EnvFileError> {
	match std::fs::read(path) {
		Ok(bytes) => {
			overlay(process, parse(&String::from_utf8_lossy(&bytes)));
			Ok(())
		}
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
		Err(_) => Err(EnvFileError::Unreadable),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parsed(text: &str) -> Vec<(String, String)> {
		parse(text).into_iter().collect()
	}

	fn pair(key: &str, value: &str) -> (String, String) {
		(key.to_owned(), value.to_owned())
	}

	#[test]
	fn plain_quoted_and_commented_lines() {
		assert_eq!(parsed("A=1\nB = 2"), [pair("A", "1"), pair("B", "2")]);
		assert_eq!(parsed("A=\"x\\ny\""), [pair("A", "x\ny")]);
		assert_eq!(parsed("A='x\\ny'"), [pair("A", "x\\ny")]);
		assert_eq!(
			parsed("# c\nA=1 # c\nB=2"),
			[pair("A", "1"), pair("B", "2")]
		);
		assert_eq!(parsed("export A=1"), [pair("A", "1")]);
	}

	#[test]
	fn last_line_without_a_newline_keeps_node_quirks() {
		assert_eq!(
			parsed("KEY=va=lue"),
			[pair("KEY", "va=lue"), pair("va", "lue")]
		);
		assert_eq!(parsed("A=x # c"), [pair("A", "x # c")]);
	}

	#[test]
	fn an_existing_variable_wins() {
		let mut process = Env::new();
		process.insert("RUNNER_TOKEN".to_owned(), "from_launcher".to_owned());
		overlay(
			&mut process,
			parse("RUNNER_TOKEN=from_file\nSEC_USER_AGENT=agent@example.org"),
		);
		assert_eq!(process["RUNNER_TOKEN"], "from_launcher");
		assert_eq!(process["SEC_USER_AGENT"], "agent@example.org");
	}

	#[test]
	fn a_missing_file_is_ignored_and_the_flag_is_found() {
		let mut process = Env::new();
		assert!(apply_env_file(&mut process, Path::new("/nonexistent/.env")).is_ok());
		assert!(process.is_empty());
		assert_eq!(
			env_file_argument(["renew", "--env-file-if-exists=/a/b"]).as_deref(),
			Some("/a/b")
		);
		assert_eq!(env_file_argument(["renew"]), None);
	}
}
