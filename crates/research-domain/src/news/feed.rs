//! Feed normalisation — port of `normalizeFeed` and helpers in
//! `packages/domain/src/news/feed.ts`.
//!
//! OWNER: the feed worker (ADR-0030). Rayon: parallel per-item map, then a
//! sequential dedupe fold (output identical to the sequential TS).
