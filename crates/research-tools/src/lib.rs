//! The research tool catalogue (port of `packages/adapters/src/tools`,
//! ADR-0030).
//!
//! OWNERS (modules are pre-declared so parallel work never edits this file):
//! `shared` is a seam module (session lead); `news`, `search`, `web`,
//! `robots` and `catalogue` belong to the tools worker; `sec` and
//! `positions` belong to the finance worker (they are thin wrappers around
//! the finance sources).

pub mod catalogue;
pub mod news;
pub mod positions;
pub mod robots;
pub mod search;
pub mod sec;
pub mod shared;
pub mod web;
