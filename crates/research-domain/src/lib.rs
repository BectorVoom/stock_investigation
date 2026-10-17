//! Pure domain rules the runner applies — a port of `packages/domain`
//! (ADR-0030). No I/O, no clocks, no randomness: time and ids are inputs.
//!
//! OWNER: the domain worker, except `news::{url_policy, ip_classification,
//! canonical_url}` (net worker) and `news::feed` (feed worker).

pub mod news;
