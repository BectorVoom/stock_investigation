//! Hardened CLI and HTTPS agent backends (AGT-001..014, ADR-0030).

pub mod claude_api;
pub mod claude_code;
pub mod cli_probe;
pub mod cli_turn;
pub mod codex;
mod composition;
pub mod environment;
pub mod external;
pub mod http;
pub mod http_turn;
pub mod lines;
pub mod opencode;
pub mod openrouter;
pub mod openrouter_models;
pub mod process;
mod schema;
pub mod spawn_helper;
pub mod turn;
pub use composition::{create_agent_runtimes, create_baseline_agent_runtimes};
