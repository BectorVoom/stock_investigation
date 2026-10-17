//! Runner-side use cases — research pipeline, notebook assist, news ingest —
//! and the ports adapters implement (port of `packages/application`,
//! ADR-0030).
//!
//! OWNERS (modules pre-declared so parallel work never edits this file):
//! `ports` and `reporter` are seam modules (session lead); `research` and
//! `ingest` belong to the pipeline worker; `notebook` to the notebook
//! worker.

pub mod ingest;
pub mod notebook;
pub mod ports;
pub mod reporter;
pub mod research;
