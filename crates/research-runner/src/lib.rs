//! The local runner (ADR-0030): configuration, the Worker API client, the
//! poll loop and job execution. `main.rs` is the composition root.
//!
//! The shell owns everything between the process boundary and the job
//! bodies: start-up and exit codes ([`exit_codes`]), configuration and the
//! env file ([`config`], [`env_file`]), the Worker API ([`api_client`]), the
//! poll loop ([`runner_loop`]), one job's lease, events, heartbeat and
//! completion ([`job_execution`]) and the composition of every adapter
//! ([`composition`]).

pub mod api_client;
pub mod composition;
pub mod config;
pub mod env_file;
pub mod exit_codes;
pub mod google_sync;
pub mod job_execution;
pub mod runner_loop;
pub mod runtime;
pub mod scratch;
pub mod startup;

#[cfg(test)]
mod job_tests;
#[cfg(test)]
mod log_events;
#[cfg(test)]
mod test_support;
