//! The production Google Calendar port (FR-019): the shell hands a claimed
//! `google-calendar` job to `research-google` and, when the API does not
//! accept a `connect`, gives the stored grant back.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use research_application::ports::Clock;
use research_application::reporter::PipelineReporter;
use research_contracts::jobs::{CompleteJobRequest, GoogleCalendarJob};
use research_effects::EventLogger;
use research_finance::pacing::MarketPacer;
use research_finance::ports::Sleeper;
use research_google::http::GoogleHttp;
use research_google::jobs::{
	GoogleAuthUrlSender, GoogleExecutionEnv, GoogleExecutionError, discard_stored_google_grant,
	execute_google_calendar,
};
use research_google::oauth::OAuthClient;
use tokio_util::sync::CancellationToken;

/// What the job shell needs from Google Calendar sync. A port, so the shell's
/// grant rule is testable without OAuth and the E2E harness can script the
/// OAuth dance (no browser, no Google).
#[async_trait]
pub trait GoogleCalendarPort: Send + Sync {
	/// Runs connect / sync / disconnect.
	async fn execute(
		&self,
		job: &GoogleCalendarJob,
		cancel: &CancellationToken,
		reporter: &dyn PipelineReporter,
		sender: &dyn GoogleAuthUrlSender,
	) -> Result<CompleteJobRequest, GoogleExecutionError>;

	/// Revokes and deletes a stored grant whose connect was not accepted.
	async fn discard_grant(&self, run_id: &str) -> Result<(), GoogleExecutionError>;
}

/// Desktop-app OAuth over the narrow pinned port; the token file path comes
/// from the launch plan (`GOOGLE_TOKEN_FILE`).
pub struct GoogleSync {
	/// `None` when either client credential is unconfigured: every job then
	/// fails honestly with `GOOGLE_NOT_CONFIGURED`.
	pub client: Option<OAuthClient>,
	/// Refresh-token file (mode 0600).
	pub token_file: PathBuf,
	/// The narrow HTTP port.
	pub http: Arc<dyn GoogleHttp>,
	/// Wall clock.
	pub clock: Arc<dyn Clock>,
	/// Logger.
	pub logger: Arc<dyn EventLogger>,
	/// Shared provider quota gate.
	pub pacer: Arc<dyn MarketPacer>,
	/// Cancellation-aware sleep.
	pub sleeper: Arc<dyn Sleeper>,
}

impl GoogleSync {
	fn env(&self) -> GoogleExecutionEnv<'_> {
		GoogleExecutionEnv {
			client: self.client.as_ref(),
			token_file: &self.token_file,
			http: &*self.http,
			clock: &*self.clock,
			logger: &*self.logger,
			pacer: &*self.pacer,
			sleep: Arc::clone(&self.sleeper),
		}
	}
}

#[async_trait]
impl GoogleCalendarPort for GoogleSync {
	async fn execute(
		&self,
		job: &GoogleCalendarJob,
		cancel: &CancellationToken,
		reporter: &dyn PipelineReporter,
		sender: &dyn GoogleAuthUrlSender,
	) -> Result<CompleteJobRequest, GoogleExecutionError> {
		execute_google_calendar(job, &self.env(), cancel, reporter, sender).await
	}

	async fn discard_grant(&self, run_id: &str) -> Result<(), GoogleExecutionError> {
		discard_stored_google_grant(&self.env(), run_id).await
	}
}
