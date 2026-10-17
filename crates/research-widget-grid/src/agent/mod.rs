//! The agent layer: how an AI agent reads and rearranges a widget grid
//! (fail closed, ARCH-017: a command is applied only when it parses against
//! the versioned command schema, names a registered widget type, builds a
//! widget the host accepts and yields a layout the host accepts).

pub mod commands;
pub mod host;
pub mod types;
