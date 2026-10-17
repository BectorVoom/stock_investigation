//! Notebook widget layout and agent commands — a port of
//! `packages/widget-grid/src/core` and the agent layer the runner's
//! notebook-assist path uses (`agent/commands.ts`, `agent/host.ts`).
//!
//! Everything here is pure and synchronous: the runner's store is in memory
//! (the TypeScript store is async only because other hosts persist it).
//! The layout edits are the Lean-proved dashboard model; its vectors are
//! replayed in `tests/vectors.rs`.

pub mod agent;
pub mod core;
