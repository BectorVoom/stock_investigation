//! The scripted Google Calendar executor (FR-019 section 2.7; port of
//! `executeGoogleCalendar` in `tests/e2e/runnerHarness.ts` and
//! `tests/e2e/googleFlag.ts`): the browser suite scripts the OAuth dance
//! instead of performing it (no browser consent, no Google).
//!
//! Connect sends one fixture sign-in URL, waits so the test can see it, then
//! completes as connected; sync completes with fixture counts; disconnect
//! completes unrevoked. While the flag file `test-results/e2e-google-unconfigured`
//! exists every google-calendar job fails honestly with `GOOGLE_NOT_CONFIGURED`,
//! exactly like the unconfigured runner.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use research_application::reporter::PipelineReporter;
use research_contracts::Tri;
use research_contracts::google_calendar::GoogleCalendarAction;
use research_contracts::jobs::{CompleteJobRequest, EMPTY_USAGE, GoogleCalendarJob, JobState};
use research_effects::{EventLogger, LogValue};
use research_finance::ports::Sleeper;
use research_google::jobs::{GoogleAuthUrlSender, GoogleExecutionError};
use research_runner::google_sync::GoogleCalendarPort;
use tokio_util::sync::CancellationToken;

/// The calendar every scripted connect and sync reports.
pub const CALENDAR_ID: &str = "e2e-calendar";
/// The "owner signs in" hold: long enough to span one queued-cadence poll (10 s).
const SIGN_IN_HOLDS: u32 = 24;
const SIGN_IN_HOLD_MS: u64 = 500;
/// A sync without a digest reports an all-zero one.
const ZERO_DIGEST_LENGTH: usize = 64;

/// The scripted executor.
pub struct ScriptedGoogle {
	/// Flag file whose existence makes every job fail as unconfigured.
	pub unconfigured_flag: PathBuf,
	/// The sign-in URL connect delivers.
	pub auth_url: String,
	/// Logger.
	pub logger: Arc<dyn EventLogger>,
	/// Capped sleep.
	pub sleeper: Arc<dyn Sleeper>,
}

fn failed(job: &GoogleCalendarJob, code: &str) -> CompleteJobRequest {
	CompleteJobRequest::Failed {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		failure_code: code.to_owned(),
		failure_detail: Tri::Absent,
		// A scripted failure: no Google answer caused it (§4a).
		failure_upstream_status: Tri::Absent,
		retryable: false,
	}
}

/// The full pipeline chain (the transition matrix rejects jumps like
/// collecting straight to publishing).
async fn enter_states(reporter: &dyn PipelineReporter, from: &[JobState]) {
	for state in from {
		reporter.state(*state).await;
	}
}

impl ScriptedGoogle {
	async fn connect(
		&self,
		job: &GoogleCalendarJob,
		cancel: &CancellationToken,
		reporter: &dyn PipelineReporter,
		sender: &dyn GoogleAuthUrlSender,
	) -> CompleteJobRequest {
		let run_id = job.lease.run_id.as_str();
		reporter.state(JobState::Planning).await;
		if !sender.send_auth_url(&self.auth_url).await {
			self.logger
				.warn("google_auth_timeout", &[("runId", LogValue::from(run_id))]);
			return failed(job, "GOOGLE_AUTH_TIMEOUT");
		}
		reporter.state(JobState::Collecting).await;
		// The owner "signs in": hold the URL visible across at least one
		// queued-cadence poll, then connect.
		for _ in 0..SIGN_IN_HOLDS {
			if cancel.is_cancelled() {
				break;
			}
			self.sleeper.sleep(SIGN_IN_HOLD_MS, Some(cancel)).await;
		}
		if cancel.is_cancelled() {
			return failed(job, "GOOGLE_AUTH_TIMEOUT");
		}
		enter_states(reporter, &[JobState::Analyzing, JobState::Verifying]).await;
		self.logger.info(
			"google_connected",
			&[
				("runId", LogValue::from(run_id)),
				("calendarId", LogValue::from(CALENDAR_ID)),
			],
		);
		reporter.state(JobState::Publishing).await;
		CompleteJobRequest::GoogleCalendarConnected {
			lease_generation: job.lease.lease_generation,
			usage: EMPTY_USAGE,
			calendar_id: CALENDAR_ID.to_owned(),
		}
	}

	async fn sync(
		&self,
		job: &GoogleCalendarJob,
		reporter: &dyn PipelineReporter,
	) -> CompleteJobRequest {
		enter_states(reporter, &[JobState::Planning, JobState::Collecting]).await;
		let inserted = job
			.events
			.as_ref()
			.map_or(0, |events| u64::try_from(events.len()).unwrap_or(u64::MAX));
		self.logger.info(
			"google_synced",
			&[
				("runId", LogValue::from(job.lease.run_id.as_str())),
				("calendarId", LogValue::from(CALENDAR_ID)),
				(
					"inserted",
					LogValue::Int(i64::try_from(inserted).unwrap_or(i64::MAX)),
				),
				("updated", LogValue::Int(0)),
				("deleted", LogValue::Int(0)),
				("unchanged", LogValue::Int(0)),
			],
		);
		enter_states(
			reporter,
			&[
				JobState::Analyzing,
				JobState::Verifying,
				JobState::Publishing,
			],
		)
		.await;
		CompleteJobRequest::GoogleCalendarSynced {
			lease_generation: job.lease.lease_generation,
			usage: EMPTY_USAGE,
			calendar_id: CALENDAR_ID.to_owned(),
			desired_digest: job
				.desired_digest
				.clone()
				.unwrap_or_else(|| "0".repeat(ZERO_DIGEST_LENGTH)),
			inserted,
			updated: 0,
			deleted: 0,
			unchanged: 0,
		}
	}

	async fn disconnect(
		&self,
		job: &GoogleCalendarJob,
		reporter: &dyn PipelineReporter,
	) -> CompleteJobRequest {
		enter_states(
			reporter,
			&[
				JobState::Planning,
				JobState::Collecting,
				JobState::Analyzing,
				JobState::Verifying,
			],
		)
		.await;
		self.logger.info(
			"google_disconnected",
			&[
				("runId", LogValue::from(job.lease.run_id.as_str())),
				("revoked", LogValue::Bool(false)),
			],
		);
		reporter.state(JobState::Publishing).await;
		CompleteJobRequest::GoogleCalendarDisconnected {
			lease_generation: job.lease.lease_generation,
			usage: EMPTY_USAGE,
			revoked: false,
		}
	}
}

#[async_trait]
impl GoogleCalendarPort for ScriptedGoogle {
	async fn execute(
		&self,
		job: &GoogleCalendarJob,
		cancel: &CancellationToken,
		reporter: &dyn PipelineReporter,
		sender: &dyn GoogleAuthUrlSender,
	) -> Result<CompleteJobRequest, GoogleExecutionError> {
		if tokio::fs::try_exists(&self.unconfigured_flag)
			.await
			.unwrap_or(false)
		{
			self.logger.warn(
				"google_not_configured",
				&[("runId", LogValue::from(job.lease.run_id.as_str()))],
			);
			return Ok(failed(job, "GOOGLE_NOT_CONFIGURED"));
		}
		Ok(match job.action {
			GoogleCalendarAction::Connect => self.connect(job, cancel, reporter, sender).await,
			GoogleCalendarAction::Sync => self.sync(job, reporter).await,
			GoogleCalendarAction::Disconnect => self.disconnect(job, reporter).await,
		})
	}

	/// The scripted connect stores no grant, so there is nothing to revoke.
	async fn discard_grant(&self, run_id: &str) -> Result<(), GoogleExecutionError> {
		self.logger.info(
			"google_grant_discarded",
			&[
				("runId", LogValue::from(run_id)),
				("revoked", LogValue::Bool(false)),
			],
		);
		Ok(())
	}
}
