//! Agent and tool ports (port of `packages/agent-core`, ADR-0030).
//!
//! `runtime` (the `AgentRuntime` port and `AgentTurn`) and `tools` (the
//! tool port and its value types) are the seam written first so that the
//! providers, tools and pipeline crates can be built in parallel.
//!
//! OWNERS: `runtime`, `tools` and `model_text` are seam modules (session
//! lead). The providers worker adds `registry` (`AgentRegistry`,
//! `describe_all`); the pipeline worker adds `authorize`
//! (`authorize_tool_call`, `execute_tool_call`, `ToolRegistry`). Each adds
//! its own `pub mod` line.

pub mod model_text;
pub mod runtime;
pub mod tools;

pub mod authorize;
pub mod registry;
