//! Google Calendar job bodies, scoped grant cleanup and progress reporting (FR-019).
use crate::{calendar::*, http::GoogleHttp, loopback::*, oauth::*, token_store::*};
use async_trait::async_trait;
use research_application::{ports::Clock, reporter::PipelineReporter};
use research_contracts::{
	Tri,
	google_calendar::{GoogleCalendarAction, GoogleCalendarFailureCode as Code},
	jobs::{CompleteJobRequest, EMPTY_USAGE, GoogleCalendarJob, JobState},
};
use research_domain::calendar::google_sync::plan_google_sync;
use research_effects::{EventLogger, LogValue};
use research_finance::{
	pacing::MarketPacer,
	ports::{BeforeRequest, Secret, Sleeper},
};
use std::{
	path::Path,
	sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
/// Dedicated secondary calendar name.
pub const GOOGLE_CALENDAR_SUMMARY: &str = "Earnings calendar (Research workspace)";
/// Dedicated secondary calendar description.
pub const GOOGLE_CALENDAR_DESCRIPTION: &str = "Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.";
/// Google execution dependencies; the shell supplies clocks, cancellation and event delivery.
pub struct GoogleExecutionEnv<'a> {
	/// None when either Desktop-app client credential is unconfigured.
	pub client: Option<&'a OAuthClient>,
	/// Owner-only refresh-token file.
	pub token_file: &'a Path,
	/// Narrow HTTP.
	pub http: &'a dyn GoogleHttp,
	/// Injected time.
	pub clock: &'a dyn Clock,
	/// One shared logger.
	pub logger: &'a dyn EventLogger,
	/// Process-wide provider quota gate.
	pub pacer: &'a dyn MarketPacer,
	/// Injected cancellation-aware sleep.
	pub sleep: Arc<dyn Sleeper>,
}
/// Unexpected local failures propagate to the shell's job crash boundary.
#[derive(Debug, thiserror::Error)]
pub enum GoogleExecutionError {
	/// Filesystem operation failed.
	#[error(transparent)]
	Store(#[from] TokenStoreError),
	/// Listener could not bind.
	#[error(transparent)]
	Loopback(#[from] LoopbackError),
	/// OS randomness unavailable.
	#[error(transparent)]
	Random(#[from] RandomError),
}
/// The shell queues and flushes the one public authorization URL.
#[async_trait]
pub trait GoogleAuthUrlSender: Send + Sync {
	/// True only when the API event queue is empty after flushing.
	async fn send_auth_url(&self, url: &str) -> bool;
}
fn count_of(count: u64) -> i64 {
	i64::try_from(count).unwrap_or(i64::MAX)
}
fn failed(job: &GoogleCalendarJob, code: Code) -> CompleteJobRequest {
	failed_upstream(job, code, None)
}
/// A failed completion; `upstream_status` is Google's answer status behind
/// the failure, unchanged (§4a), and the key is written only with one.
fn failed_upstream(
	job: &GoogleCalendarJob,
	code: Code,
	upstream_status: Option<u16>,
) -> CompleteJobRequest {
	CompleteJobRequest::Failed {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		failure_code: code.as_str().to_owned(),
		failure_detail: Tri::Absent,
		failure_upstream_status: Tri::or_absent(upstream_status),
		retryable: code == Code::RateLimited,
	}
}
fn aborted(job: &GoogleCalendarJob) -> CompleteJobRequest {
	failed(job, Code::RequestFailed)
}
fn call_failed(
	job: &GoogleCalendarJob,
	error: GoogleCallError,
	cancel: &CancellationToken,
) -> CompleteJobRequest {
	if cancel.is_cancelled() {
		return aborted(job);
	}
	match error {
		GoogleCallError::Aborted => aborted(job),
		GoogleCallError::Failed {
			code,
			upstream_status,
		} => failed_upstream(job, code, upstream_status),
	}
}
fn warn(env: &GoogleExecutionEnv<'_>, job: &GoogleCalendarJob, event: &str, code: Option<Code>) {
	let mut fields = vec![("runId", LogValue::from(job.lease.run_id.as_str()))];
	if let Some(code) = code {
		fields.push(("code", LogValue::from(code.as_str())));
	}
	env.logger.warn(event, &fields);
}
async fn revoke_grant(env: &GoogleExecutionEnv<'_>, token: &Secret) -> bool {
	let cancel = CancellationToken::new();
	let result = tokio::time::timeout(
		std::time::Duration::from_secs(10),
		revoke_token(env.http, token, &cancel),
	)
	.await;
	cancel.cancel();
	result.unwrap_or(false)
}
async fn give_back(
	env: &GoogleExecutionEnv<'_>,
	job: &GoogleCalendarJob,
	token: &Secret,
	completion: CompleteJobRequest,
) -> CompleteJobRequest {
	let revoked = revoke_grant(env, token).await;
	env.logger.info(
		"google_grant_discarded",
		&[
			("runId", LogValue::from(job.lease.run_id.as_str())),
			("revoked", LogValue::Bool(revoked)),
		],
	);
	completion
}
/// Revokes and deletes a connect whose API completion was not accepted, even after job cancellation.
pub async fn discard_stored_google_grant(
	env: &GoogleExecutionEnv<'_>,
	run_id: &str,
) -> Result<(), GoogleExecutionError> {
	let stored = read_google_token_file(env.token_file).await;
	let revoked = match stored {
		Some(stored) => revoke_grant(env, &stored.refresh_token).await,
		None => false,
	};
	delete_google_token_file(env.token_file).await?;
	env.logger.info(
		"google_grant_discarded",
		&[
			("runId", LogValue::from(run_id)),
			("revoked", LogValue::Bool(revoked)),
		],
	);
	Ok(())
}
struct Gate<'a> {
	pacer: &'a dyn MarketPacer,
	cancel: &'a CancellationToken,
}
#[async_trait]
impl BeforeRequest for Gate<'_> {
	async fn before_request(&self) -> bool {
		self.pacer.pace("google", self.cancel, None).await
	}
}
struct Session<'a> {
	http: &'a dyn GoogleHttp,
	client: &'a OAuthClient,
	refresh: &'a Secret,
	cancel: &'a CancellationToken,
	access: Mutex<Secret>,
}
#[async_trait]
impl CalendarTokens for Session<'_> {
	fn access_token(&self) -> Secret {
		self.access
			.lock()
			.map(|s| s.clone())
			.unwrap_or_else(|_| Secret::new(""))
	}
	async fn refresh_access_token(&self) -> Result<Secret, GoogleCallError> {
		let refreshed =
			refresh_access_token(self.http, self.client, self.refresh, self.cancel).await?;
		let mut access = self
			.access
			.lock()
			.map_err(|_| GoogleCallError::from(Code::RequestFailed))?;
		*access = refreshed.access_token.clone();
		Ok(refreshed.access_token)
	}
}
/// Executes connect/sync/disconnect; lease and stop-result overrides remain in the shell.
pub async fn execute_google_calendar(
	job: &GoogleCalendarJob,
	env: &GoogleExecutionEnv<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
	sender: &dyn GoogleAuthUrlSender,
) -> Result<CompleteJobRequest, GoogleExecutionError> {
	match job.action {
		GoogleCalendarAction::Connect => connect(job, env, cancel, reporter, sender).await,
		GoogleCalendarAction::Sync => sync(job, env, cancel, reporter).await,
		GoogleCalendarAction::Disconnect => disconnect(job, env, cancel, reporter).await,
	}
}
async fn connect(
	job: &GoogleCalendarJob,
	env: &GoogleExecutionEnv<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
	sender: &dyn GoogleAuthUrlSender,
) -> Result<CompleteJobRequest, GoogleExecutionError> {
	if env.client.is_none() {
		warn(env, job, "google_not_configured", None);
		return Ok(failed(job, Code::NotConfigured));
	}
	reporter.state(JobState::Planning).await;
	let state = new_oauth_state()?;
	let mut listener = start_loopback_listener(
		state.clone(),
		300_000,
		cancel.clone(),
		env.sleep.clone(),
		500,
	)
	.await?;
	let result = connect_listening(job, env, cancel, reporter, sender, &state, &mut listener).await;
	listener.close().await;
	result
}
async fn connect_listening(
	job: &GoogleCalendarJob,
	env: &GoogleExecutionEnv<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
	sender: &dyn GoogleAuthUrlSender,
	state: &str,
	listener: &mut LoopbackHandle,
) -> Result<CompleteJobRequest, GoogleExecutionError> {
	let Some(client) = env.client else {
		return Ok(failed(job, Code::NotConfigured));
	};
	let verifier = new_code_verifier()?;
	let url = build_authorization_url(
		&client.client_id,
		&listener.redirect_uri,
		state,
		&code_challenge_s256(verifier.expose()),
	);
	reporter.state(JobState::Collecting).await;
	// The first send is unconditional; each retry checks the stop before and
	// after its pause, and a stop after the loop wins even over a delivery.
	let mut delivered = sender.send_auth_url(&url).await;
	let mut attempt = 1;
	while !delivered && attempt < 4 {
		if cancel.is_cancelled() {
			return Ok(aborted(job));
		}
		env.sleep.sleep(2_000, Some(cancel)).await;
		if cancel.is_cancelled() {
			return Ok(aborted(job));
		}
		delivered = sender.send_auth_url(&url).await;
		attempt += 1;
	}
	if cancel.is_cancelled() {
		return Ok(aborted(job));
	}
	if !delivered {
		warn(env, job, "google_auth_url_not_delivered", None);
		return Ok(failed(job, Code::RequestFailed));
	}
	let result = listener.wait().await;
	if cancel.is_cancelled() || matches!(result, LoopbackResult::Aborted) {
		return Ok(aborted(job));
	}
	let code = match result {
		LoopbackResult::Timeout => {
			warn(env, job, "google_auth_timeout", None);
			return Ok(failed(job, Code::AuthTimeout));
		}
		LoopbackResult::Denied => {
			warn(env, job, "google_consent_denied", None);
			return Ok(failed(job, Code::ConsentDenied));
		}
		LoopbackResult::Code(code) => code,
		LoopbackResult::Aborted => return Ok(aborted(job)),
	};
	reporter.state(JobState::Analyzing).await;
	let tokens = match exchange_code(
		env.http,
		client,
		&code,
		&verifier,
		&listener.redirect_uri,
		cancel,
	)
	.await
	{
		Ok(tokens) => tokens,
		Err(failure) => {
			if cancel.is_cancelled() {
				return Ok(aborted(job));
			}
			let upstream_status = failure
				.upstream_status
				.map_or(LogValue::Null, |status| LogValue::Int(i64::from(status)));
			env.logger.warn(
				"google_exchange_failed",
				&[
					("runId", LogValue::from(job.lease.run_id.as_str())),
					("code", LogValue::from(failure.code.as_str())),
					("upstreamStatus", upstream_status),
				],
			);
			return Ok(failed_upstream(job, failure.code, failure.upstream_status));
		}
	};
	if !scope_granted(tokens.scope.as_deref()) {
		warn(env, job, "google_scope_missing", None);
		return Ok(give_back(
			env,
			job,
			&tokens.refresh_token,
			failed(job, Code::ScopeMissing),
		)
		.await);
	}
	reporter.state(JobState::Verifying).await;
	let session = Session {
		http: env.http,
		client,
		refresh: &tokens.refresh_token,
		cancel,
		access: Mutex::new(tokens.access_token),
	};
	let gate = Gate {
		pacer: env.pacer,
		cancel,
	};
	let calls = CalendarClient {
		http: env.http,
		tokens: &session,
		before_request: &gate,
		cancel,
	};
	let previous = read_google_token_file(env.token_file).await;
	let mut id = None;
	if let Some(previous) = previous {
		match calls.get_calendar(&previous.calendar_id).await {
			Ok(Some(_)) => id = Some(previous.calendar_id),
			Ok(None) => {}
			Err(error) => {
				return Ok(give_back(
					env,
					job,
					&tokens.refresh_token,
					call_failed(job, error, cancel),
				)
				.await);
			}
		}
	}
	let calendar_id = match id {
		Some(id) => id,
		None => {
			if cancel.is_cancelled() {
				return Ok(give_back(env, job, &tokens.refresh_token, aborted(job)).await);
			}
			match calls
				.create_calendar(GOOGLE_CALENDAR_SUMMARY, GOOGLE_CALENDAR_DESCRIPTION, "UTC")
				.await
			{
				Ok(id) => id,
				Err(error) => {
					if !cancel.is_cancelled() {
						let code = match error {
							GoogleCallError::Aborted => "ABORTED",
							GoogleCallError::Failed { code, .. } => code.as_str(),
						};
						env.logger.warn(
							"google_create_failed",
							&[
								("runId", job.lease.run_id.as_str().into()),
								("code", code.into()),
							],
						);
					}
					return Ok(give_back(
						env,
						job,
						&tokens.refresh_token,
						call_failed(job, error, cancel),
					)
					.await);
				}
			}
		}
	};
	if cancel.is_cancelled() {
		return Ok(give_back(env, job, &tokens.refresh_token, aborted(job)).await);
	}
	// F1: a grant that could not be stored is given back before the fault propagates.
	let record = GoogleTokenRecord {
		refresh_token: tokens.refresh_token.clone(),
		calendar_id: calendar_id.clone(),
		scope: GOOGLE_CALENDAR_SCOPE.to_owned(),
		saved_at: env.clock.now_iso(),
	};
	if let Err(error) = write_google_token_file(env.token_file, &record).await {
		give_back(env, job, &tokens.refresh_token, aborted(job)).await;
		return Err(error.into());
	}
	env.logger.info(
		"google_connected",
		&[
			("runId", job.lease.run_id.as_str().into()),
			("calendarId", calendar_id.as_str().into()),
		],
	);
	reporter.state(JobState::Publishing).await;
	Ok(CompleteJobRequest::GoogleCalendarConnected {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		calendar_id,
	})
}
async fn sync(
	job: &GoogleCalendarJob,
	env: &GoogleExecutionEnv<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> Result<CompleteJobRequest, GoogleExecutionError> {
	let Some(client) = env.client else {
		warn(env, job, "google_not_configured", None);
		return Ok(failed(job, Code::NotConfigured));
	};
	reporter.state(JobState::Planning).await;
	let Some(mut stored) = read_google_token_file(env.token_file).await else {
		warn(env, job, "google_auth_expired", None);
		return Ok(failed(job, Code::AuthExpired));
	};
	let (Some(digest), Some(events)) = (&job.desired_digest, &job.events) else {
		return Ok(failed(job, Code::RequestFailed));
	};
	if job.calendar_id.is_absent() {
		return Ok(failed(job, Code::RequestFailed));
	}
	reporter.state(JobState::Collecting).await;
	let session = Session {
		http: env.http,
		client,
		refresh: &stored.refresh_token,
		cancel,
		access: Mutex::new(Secret::new("")),
	};
	if let Err(error) = session.refresh_access_token().await {
		let GoogleCallError::Failed {
			code,
			upstream_status,
		} = error
		else {
			return Ok(aborted(job));
		};
		if cancel.is_cancelled() {
			return Ok(aborted(job));
		}
		warn(env, job, "google_refresh_failed", Some(code));
		return Ok(failed_upstream(job, code, upstream_status));
	}
	let gate = Gate {
		pacer: env.pacer,
		cancel,
	};
	let calls = CalendarClient {
		http: env.http,
		tokens: &session,
		before_request: &gate,
		cancel,
	};
	reporter.state(JobState::Analyzing).await;
	// The claim names the calendar the API believes is connected; the token
	// file's id is the fallback for a claim that carries none (null).
	let mut calendar_id = job
		.calendar_id
		.value()
		.unwrap_or(&stored.calendar_id)
		.clone();
	let existing = match calls.get_calendar(&calendar_id).await {
		Err(error) => return Ok(call_failed(job, error, cancel)),
		Ok(Some(_)) => match calls.list_managed_events(&calendar_id).await {
			Ok(events) => events,
			Err(error) => return Ok(call_failed(job, error, cancel)),
		},
		Ok(None) => {
			if cancel.is_cancelled() {
				return Ok(aborted(job));
			}
			calendar_id = match calls
				.create_calendar(GOOGLE_CALENDAR_SUMMARY, GOOGLE_CALENDAR_DESCRIPTION, "UTC")
				.await
			{
				Ok(id) => id,
				Err(error) => return Ok(call_failed(job, error, cancel)),
			};
			// Preserve the refresh token and update only the calendar lineage.
			stored.calendar_id = calendar_id.clone();
			stored.saved_at = env.clock.now_iso();
			write_google_token_file(env.token_file, &stored).await?;
			Vec::new()
		}
	};
	let Ok(plan) = plan_google_sync(events, &existing) else {
		warn(env, job, "google_plan_failed", None);
		return Ok(failed(job, Code::RequestFailed));
	};
	reporter.state(JobState::Verifying).await;
	let (mut inserted, mut updated, mut deleted) = (0u64, 0u64, 0u64);
	for id in plan.deletes {
		if cancel.is_cancelled() {
			return Ok(aborted(job));
		}
		if let Err(error) = calls.delete_event(&calendar_id, id).await {
			return Ok(call_failed(job, error, cancel));
		}
		deleted += 1;
	}
	for event in plan.updates {
		if cancel.is_cancelled() {
			return Ok(aborted(job));
		}
		if let Err(error) = calls.update_event(&calendar_id, event).await {
			return Ok(call_failed(job, error, cancel));
		}
		updated += 1;
	}
	for event in plan.inserts {
		if cancel.is_cancelled() {
			return Ok(aborted(job));
		}
		match calls.insert_event(&calendar_id, event).await {
			Err(error) => return Ok(call_failed(job, error, cancel)),
			Ok(true) => inserted += 1,
			Ok(false) => {
				if let Err(error) = calls.update_event(&calendar_id, event).await {
					return Ok(call_failed(job, error, cancel));
				}
				updated += 1;
			}
		}
	}
	let unchanged = u64::try_from(plan.unchanged.len()).unwrap_or(u64::MAX);
	env.logger.info(
		"google_synced",
		&[
			("runId", job.lease.run_id.as_str().into()),
			("calendarId", calendar_id.as_str().into()),
			("inserted", LogValue::Int(count_of(inserted))),
			("updated", LogValue::Int(count_of(updated))),
			("deleted", LogValue::Int(count_of(deleted))),
			("unchanged", LogValue::Int(count_of(unchanged))),
		],
	);
	reporter.state(JobState::Publishing).await;
	Ok(CompleteJobRequest::GoogleCalendarSynced {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		calendar_id,
		desired_digest: digest.clone(),
		inserted,
		updated,
		deleted,
		unchanged,
	})
}
async fn disconnect(
	job: &GoogleCalendarJob,
	env: &GoogleExecutionEnv<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> Result<CompleteJobRequest, GoogleExecutionError> {
	reporter.state(JobState::Planning).await;
	let stored = read_google_token_file(env.token_file).await;
	let mut revoked = false;
	// Every job walks planning, collecting, analyzing, verifying, publishing.
	reporter.state(JobState::Collecting).await;
	if let Some(stored) = &stored {
		if !cancel.is_cancelled() {
			revoked = revoke_token(env.http, &stored.refresh_token, cancel).await;
		}
	}
	if cancel.is_cancelled() && stored.is_some() && !revoked {
		return Ok(aborted(job));
	}
	delete_google_token_file(env.token_file).await?;
	env.logger.info(
		"google_disconnected",
		&[
			("runId", job.lease.run_id.as_str().into()),
			("revoked", LogValue::Bool(revoked)),
		],
	);
	for state in [
		JobState::Analyzing,
		JobState::Verifying,
		JobState::Publishing,
	] {
		reporter.state(state).await;
	}
	Ok(CompleteJobRequest::GoogleCalendarDisconnected {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		revoked,
	})
}
