//! Runner-side use cases — research pipeline, notebook assist, news ingest —
//! and the ports adapters implement (port of `packages/application`,
//! ADR-0030).
//!
//! `ports` is the seam written first so the adapter crates (net, feed,
//! tools, finance, google) can be built in parallel; the use cases are added
//! by the wave B pipeline worker.

pub mod ports;
