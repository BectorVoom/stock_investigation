//! JavaScript-faithful primitives (ADR-0030 decision 3).
//!
//! The TypeScript runner's observable outputs — prompts, model-facing text,
//! limits, archives — are defined by JavaScript semantics: string lengths in
//! UTF-16 code units, JS whitespace (which includes U+FEFF but not U+0085),
//! `Number.prototype.toString`, `toFixed`'s exact-value rounding,
//! `encodeURIComponent`, `JSON.stringify`, V8's `Date.parse`. Rust's own
//! equivalents differ in edge cases, so every crate that needs one of these
//! uses this crate and never re-implements it.
//!
//! Every function is checked against vectors produced by Node itself
//! (`vectors/js/*.json`, written by `scripts/vectors/js.ts`).
//!
//! Lone surrogates: a Rust `String` cannot hold one. Where JavaScript would
//! produce a lone surrogate (slicing through a surrogate pair), these
//! functions produce U+FFFD instead; that is the one documented divergence.

pub mod date;
pub mod json;
pub mod json_text;
pub mod number;
pub mod text_decoder;
pub mod uri;
pub mod utf16;
pub mod whitespace;
