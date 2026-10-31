//! E2E seams for the Rust runner (ADR-0030, rr-spec-shell-wire section 10).
//!
//! `research-runner-e2e` is the real runner loop and tools from
//! `research-runner` with the seams of the TypeScript harness
//! (`tests/e2e/runnerHarness.ts`): the scripted agent (through the FR-013
//! external-process protocol), a fixture feed fetcher, fixture market
//! sources feeding the real FRED / Twelve Data adapters, fixture earnings
//! sources, fixture stock lists, a scripted Google executor, `X-E2E-Owner` injection and 500 ms
//! sleep caps. The production binary never depends on this crate; the
//! architecture guards in `tests/architecture` pin that.

pub mod agents;
pub mod directory;
pub mod earnings;
pub mod equity_sync;
pub mod fetchers;
pub mod fixtures;
pub mod google;
pub mod harness;
pub mod owner_proxy;
pub mod sleep;
