//! DNS-pinned HTTPS fetcher with keep-alive reuse (SEC-002, ADR-0030 C1) and
//! the page archive — the Rust port of `packages/adapters/src/node/*` and
//! `packages/adapters/src/worker/safeFetchCore.ts`.
//!
//! Layers, outermost first:
//! - [`core`]: the hop loop (URL policy, allowlist, redirects re-validated per
//!   hop, header allowlist, deadline and cancellation, decoded byte cap,
//!   UTF-8 decode), generic over a [`core::HopTransport`];
//! - [`transport`]: resolve with getaddrinfo, refuse unless every answer is
//!   public, try up to three validated addresses in order;
//! - [`pinned`]: one GET over HTTP/1.1, content decoding with a wire-byte cap,
//!   and the keep-alive [`pool`];
//! - [`tls`]: TCP to the validated IP literal, peer check before TLS, rustls
//!   verified against the host name — also the low-level API for adapters
//!   that speak their own HTTP (Google Calendar).
//!
//! [`archive`] is `createFilePageArchive`.
//!
//! OWNER: net worker (rr-net) (ADR-0030).

pub mod archive;
pub mod core;
pub mod decode;
pub mod dns;
pub mod errors;
pub mod pinned;
pub mod pool;
pub mod tls;
pub mod transport;

pub use archive::FilePageArchive;
pub use core::{DEFAULT_USER_AGENT, MAX_REDIRECT_HOPS, SafeFetchCore, fetch_raw_bytes};
pub use dns::{DnsLookup, ResolveError, SystemLookup, ValidatedAddress, resolve_public};
pub use pinned::{PinnedConnect, PinnedHttpsConnect, PinnedRequest, PinnedResponse};
#[cfg(any(test, feature = "test-seams"))]
pub use tls::PinnedTlsOverrides;
pub use tls::{ConnectError, PinnedTls, is_same_ip_address};
pub use transport::{NodeSafeFetcher, PinnedHopTransport, create_node_safe_fetcher};
#[cfg(any(test, feature = "test-seams"))]
pub use transport::{NodeSafeFetcherOverrides, create_node_safe_fetcher_with};

#[cfg(test)]
mod seam_gate {
	//! The test seams (loopback dialing, extra roots, injected DNS and
	//! connections, assumed-valid addresses) exist only with the `test-seams`
	//! feature. Only this crate's own tests (its dev-dependency on itself) and
	//! the separate E2E testkit may enable it; the production binary
	//! (`cargo build -p research-runner`) must not.

	fn manifest(crate_dir: &str) -> String {
		let path = format!("{}/../{crate_dir}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
		std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
	}

	/// `(section, line)` for every line of a manifest naming the feature.
	fn feature_mentions(text: &str) -> Vec<(String, String)> {
		let mut section = String::new();
		let mut found = Vec::new();
		for line in text.lines() {
			let trimmed = line.trim();
			if trimmed.starts_with('[') {
				section = trimmed.to_owned();
			} else if trimmed.contains("test-seams") {
				found.push((section.clone(), trimmed.to_owned()));
			}
		}
		found
	}

	#[test]
	fn the_feature_is_off_by_default_and_enabled_only_for_tests() {
		let own = manifest("research-net");
		let mentions = feature_mentions(&own);
		assert!(
			mentions
				.iter()
				.all(|(section, line)| section == "[features]"
					&& (line == "default = []" || line.starts_with("test-seams = "))
					|| section == "[dev-dependencies]"),
			"{mentions:?}"
		);
		assert!(own.contains("default = []"));
		let crates = std::fs::read_dir(format!("{}/..", env!("CARGO_MANIFEST_DIR"))).unwrap();
		for entry in crates {
			let name = entry.unwrap().file_name().into_string().unwrap();
			if name == "research-net" || name == "research-runner-testkit" {
				continue;
			}
			let Ok(text) = std::fs::read_to_string(format!(
				"{}/../{name}/Cargo.toml",
				env!("CARGO_MANIFEST_DIR")
			)) else {
				continue;
			};
			for (section, line) in feature_mentions(&text) {
				assert!(
					section == "[dev-dependencies]",
					"{name} enables test-seams outside [dev-dependencies]: {section} {line}"
				);
			}
		}
		assert!(!manifest("research-runner").contains("test-seams"));
	}
}
