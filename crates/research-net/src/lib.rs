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
pub use dns::{DnsLookup, SystemLookup};
pub use pinned::{PinnedConnect, PinnedHttpsConnect, PinnedRequest, PinnedResponse};
pub use tls::{ConnectError, PinnedTls, PinnedTlsOverrides, is_same_ip_address};
pub use transport::{
	NodeSafeFetcher, NodeSafeFetcherOverrides, PinnedHopTransport, create_node_safe_fetcher,
	create_node_safe_fetcher_with,
};
