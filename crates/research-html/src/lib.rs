//! HTML to Markdown for the research runner (ADR-0030 decision 6): a
//! byte-level port of htmlparser2 12.0.0 (tokenizer + parser), the entities
//! 8.1.0 decoder with its generated named-reference trie, and the converter
//! heuristics of `packages/adapters/src/tools/htmlToMarkdown.ts`.
//!
//! Output equals the TypeScript for every input (conformance vectors in
//! `vectors/html/`, written by `scripts/vectors/html.ts`). The one
//! representational difference: where JavaScript produces a lone surrogate
//! (an astral named reference such as `&Afr;` is two text chunks, and a
//! list keeps each chunk as its own item), the Rust output holds U+FFFD —
//! the same UTF-16 length and the same UTF-8 bytes once written.
//!
//! Everything retrieved is untrusted (SEC-001): parsing is streaming and
//! total — no input panics, and the cost is linear in the input (the parser's
//! open-element stack is indexed per name, unlike htmlparser2's O(depth)
//! scans).
//!
//! One page is one sequential state machine; [`convert_many`] converts
//! several pages in parallel on rayon, in input order.

mod converter;
mod entities;
#[rustfmt::skip]
mod entities_data;
pub mod names;
pub mod parser;
mod text;
mod tokenizer;

pub use converter::{MarkdownPage, OmittedCounts, Options, html_to_markdown};

use rayon::prelude::*;

/// Converts every `(html, options)` pair on the rayon pool; the result at
/// index `i` is `html_to_markdown(pages[i].0, &pages[i].1)`.
#[must_use]
pub fn convert_many(pages: &[(&str, Options<'_>)]) -> Vec<MarkdownPage> {
	pages
		.par_iter()
		.map(|(html, options)| html_to_markdown(html, options))
		.collect()
}

/// The packed named-reference trie generated from entities 8.1.0, exposed so
/// the vector test can check it against the package (length and SHA-256).
#[must_use]
pub fn entity_trie() -> &'static [u16] {
	&entities_data::HTML_DECODE_TREE
}
