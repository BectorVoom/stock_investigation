//! Agent and tool ports (port of `packages/agent-core`, ADR-0030).
//!
//! `runtime` (the `AgentRuntime` port and `AgentTurn`) and `tools` (the
//! tool port and its value types) are the seam written first so that the
//! providers, tools and pipeline crates can be built in parallel.
//!
//! OWNERS: the seam types here are fixed. The providers worker adds
//! `registry` (`AgentRegistry`, `describe_all`); the pipeline worker adds
//! `authorize` (`authorize_tool_call`, `execute_tool_call`, `ToolRegistry`)
//! and `model_text` (`extract_json_object`, `fence_untrusted_text`,
//! `validate_agent_event`).

pub mod runtime;
pub mod tools;
