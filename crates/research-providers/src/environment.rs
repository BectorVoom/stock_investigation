//! Child processes receive a complete allowlisted environment (SEC-010).
use crate::{http::HttpClient, process::ProcessRunner};
use std::{collections::BTreeMap, sync::Arc};

/// The runner's environment, never inherited wholesale by a child.
pub type Environment = BTreeMap<String, String>;
/// Dependencies shared by all provider adapters.
#[derive(Clone)]
pub struct ProviderEnvironment {
	/// The hardened process adapter.
	pub process_runner: Arc<dyn ProcessRunner>,
	/// Fixed-host HTTPS transport.
	pub http: Arc<dyn HttpClient>,
	/// The runner's own environment.
	pub env: Environment,
}
/// Only these ambient values are shared with every CLI.
pub const BASE_CHILD_ENV_KEYS: &[&str] =
	&["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TERM"];
/// Builds the child's complete environment; empty values are omitted.
pub fn build_child_env(source: &Environment, provider_keys: &[&str]) -> Environment {
	BASE_CHILD_ENV_KEYS
		.iter()
		.chain(provider_keys)
		.filter_map(|key| {
			source
				.get(*key)
				.filter(|value| !value.is_empty())
				.map(|value| ((*key).to_owned(), value.clone()))
		})
		.collect()
}
/// Nullish fallback: an explicitly empty TMPDIR remains empty, like Node.
pub fn probe_working_directory(source: &Environment) -> &str {
	source
		.get("TMPDIR")
		.or_else(|| source.get("HOME"))
		.map_or("/", String::as_str)
}
