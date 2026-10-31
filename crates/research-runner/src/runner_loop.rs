//! The outbound-only polling loop (port of `apps/runner/src/runner.ts`,
//! shell-wire spec section 3): the runner always initiates the connection;
//! nothing listens on the owner's network. Idle polling follows the server's
//! `pollAfterMs` hint and failures back off exponentially.

use std::sync::Arc;

use research_contracts::agent::AgentAvailability;
use research_contracts::jobs::ClaimJobRequest;
use research_effects::LogValue;
use research_finance::ports::Sleeper;
use tokio_util::sync::CancellationToken;

use crate::job_execution::{JobDeps, execute_job};

/// Sent as `runnerVersion` (stored by the Worker, max 40 characters).
pub const RUNNER_VERSION: &str = "0.1.0";

const REPROBE_INTERVAL_MS: i64 = 300_000;
const MAX_IDLE_SLEEP_MS: u64 = 60_000;
const ERROR_BACKOFF_START_MS: u64 = 2_000;
const ERROR_BACKOFF_MAX_MS: u64 = 60_000;

/// Why the loop returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunnerExit {
	/// Shutdown was requested.
	Shutdown,
	/// The credential was rejected; it will not start working again.
	Unauthenticated,
}

/// The loop's dependencies: the job dependencies plus an interruptible sleep.
pub struct LoopDeps {
	/// Everything a job needs.
	pub jobs: Arc<JobDeps>,
	/// Resolves after `ms`, or immediately when the token is cancelled.
	pub sleeper: Arc<dyn Sleeper>,
}

/// Claims and runs jobs one at a time until shutdown or a rejected credential.
/// One job at a time: lease and heartbeat semantics (and the launcher's
/// readiness check) assume a single in-flight job; rayon is for CPU work
/// inside a job.
pub async fn run_runner_loop(deps: &LoopDeps, shutdown: &CancellationToken) -> RunnerExit {
	let jobs = &deps.jobs;
	let mut descriptors = Vec::new();
	// `-Infinity` until the first probe.
	let mut probed_at_ms: Option<i64> = None;
	let mut error_backoff_ms = ERROR_BACKOFF_START_MS;

	while !shutdown.is_cancelled() {
		// Measured at loop top, so a long job postpones the re-probe.
		if probed_at_ms
			.is_none_or(|at| jobs.clock.now_ms().saturating_sub(at) >= REPROBE_INTERVAL_MS)
		{
			// Probing runs CLIs (up to 15 s each): shutdown must not wait for it.
			let probed = tokio::select! {
				probed = jobs.agents.describe_all() => probed,
				() = shutdown.cancelled() => return RunnerExit::Shutdown,
			};
			descriptors = probed;
			probed_at_ms = Some(jobs.clock.now_ms());
			for descriptor in &descriptors {
				let (status, reason) = match &descriptor.availability {
					AgentAvailability::Available => ("available", None),
					AgentAvailability::Unavailable { reason_code, .. } => {
						("unavailable", Some(reason_code.as_str()))
					}
				};
				jobs.logger.info(
					"agent_probe",
					&[
						("agentId", LogValue::from(descriptor.agent_id.as_str())),
						("status", LogValue::from(status)),
						("reason", LogValue::from(reason)),
						(
							"toolIsolation",
							LogValue::from(descriptor.tool_isolation.as_str()),
						),
					],
				);
			}
		}

		let request = ClaimJobRequest {
			runner_version: RUNNER_VERSION.to_owned(),
			agents: descriptors.clone(),
		};
		// A claim in flight (up to four 20 s attempts plus backoff) is cancelled
		// by shutdown so the process exits within the launcher's 8 s grace.
		let claimed = tokio::select! {
			claimed = jobs.api.claim(&request) => claimed,
			() = shutdown.cancelled() => return RunnerExit::Shutdown,
		};
		let response = match claimed {
			Ok(response) => response,
			Err(error) => {
				if error.code == "UNAUTHENTICATED" || error.code == "FORBIDDEN" {
					// A revoked or expired credential will not start working again; stop
					// instead of hammering.
					jobs.logger.error(
						"runner_credential_rejected",
						&[("code", LogValue::from(error.code.as_str()))],
					);
					return RunnerExit::Unauthenticated;
				}
				jobs.logger.warn(
					"claim_failed",
					&[
						("code", LogValue::from(error.code.as_str())),
						(
							"retryInMs",
							LogValue::Int(i64::try_from(error_backoff_ms).unwrap_or(i64::MAX)),
						),
					],
				);
				deps.sleeper.sleep(error_backoff_ms, Some(shutdown)).await;
				error_backoff_ms = (error_backoff_ms * 2).min(ERROR_BACKOFF_MAX_MS);
				continue;
			}
		};
		error_backoff_ms = ERROR_BACKOFF_START_MS;

		let Some(job) = response.job else {
			deps.sleeper
				.sleep(
					response.poll_after_ms.min(MAX_IDLE_SLEEP_MS),
					Some(shutdown),
				)
				.await;
			continue;
		};
		let lease = job.lease();
		jobs.logger.info(
			"job_claimed",
			&[
				("runId", LogValue::from(lease.run_id.as_str())),
				("kind", LogValue::from(job_kind(&job))),
				(
					"attempt",
					LogValue::Int(i64::try_from(lease.attempt).unwrap_or(i64::MAX)),
				),
				(
					"leaseGeneration",
					LogValue::Int(i64::try_from(lease.lease_generation).unwrap_or(i64::MAX)),
				),
			],
		);
		// Run the job to its end, then loop again without sleeping.
		execute_job(job, Arc::clone(jobs), shutdown.clone()).await;
	}
	RunnerExit::Shutdown
}

/// The wire spelling of a job's kind.
const fn job_kind(job: &research_contracts::jobs::ClaimedJob) -> &'static str {
	use research_contracts::jobs::{ClaimedJob, JobKind};
	match job {
		ClaimedJob::Research(_) => JobKind::Research.as_str(),
		ClaimedJob::NewsIngest(_) => JobKind::NewsIngest.as_str(),
		ClaimedJob::NotebookAssist(_) => JobKind::NotebookAssist.as_str(),
		ClaimedJob::MarketRefresh(_) => JobKind::MarketRefresh.as_str(),
		ClaimedJob::EarningsRefresh(_) => JobKind::EarningsRefresh.as_str(),
		ClaimedJob::GoogleCalendar(_) => JobKind::GoogleCalendar.as_str(),
		ClaimedJob::StockDirectoryRefresh(_) => JobKind::StockDirectoryRefresh.as_str(),
		ClaimedJob::FinancialSync(_) => JobKind::FinancialSync.as_str(),
	}
}
