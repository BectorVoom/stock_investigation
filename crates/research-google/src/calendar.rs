//! Google Calendar v3 calls: every attempt admitted by the quota gate, a token
//! refresh before any attempt whose token expired and once after a 401, and
//! bounded backoff on rate-limit answers (`googleCalendarClient.ts`).
//!
//! Wire format, limits and error mapping: docs/external-apis/apis/google-calendar.md
use crate::{
	http::*,
	oauth::{GoogleTokenFailure, field, text},
};
use async_trait::async_trait;
use research_application::ports::Clock;
use research_contracts::google_calendar::GoogleCalendarFailureCode as Code;
use research_domain::calendar::google_sync::{
	GOOGLE_EVENT_TRANSPARENCY, GoogleEventBody, GoogleEventTransparency, ManagedEventStatus,
	ManagedGoogleEvent,
};
use research_finance::ports::{Secret, Sleeper};
use research_js::{
	json::{self, Object, Value},
	uri::encode_uri_component,
};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// `events.patch` costs three quota units, every other call one. The gate
/// admits units, so the pacer's 5 per second (300 a minute) stay under
/// Google's 600 per minute per user even when a sync patches every event.
pub const PATCH_QUOTA_UNITS: usize = 3;

/// Admits one Calendar attempt worth `units` of Google's quota (`beforeRequest`).
#[async_trait]
pub trait QuotaGate: Send + Sync {
	/// False (a stop while waiting) ends the call.
	async fn admit(&self, units: usize) -> bool;
}

/// At most 4 retries of one request after rate-limit answers.
pub const RATE_LIMIT_MAX_RETRIES: i32 = 4;
/// Backoff before retry n (0-based): 1 s × 2^n plus up to 1 s of jitter.
const RATE_LIMIT_BASE_MS: f64 = 1_000.0;
const RATE_LIMIT_JITTER_MS: f64 = 1_000.0;
/// A `Retry-After` longer than this is not waited out: the call fails now.
pub const RATE_LIMIT_MAX_WAIT_MS: f64 = 30_000.0;
/// Total rate-limit waiting per job.
pub const RATE_LIMIT_JOB_BUDGET_MS: f64 = 60_000.0;
/// Rate-limit reasons: the Calendar errors guide's `usageLimits` reasons plus
/// the envelope status for the same.
const RATE_LIMIT_REASONS: [&str; 4] = [
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"quotaExceeded",
	"RESOURCE_EXHAUSTED",
];
/// The 403 reasons worth a backoff; `quotaExceeded` (the Calendar usage
/// limit, lifted after hours) is left out.
const BACKOFF_REASONS: [&str; 3] = [
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"RESOURCE_EXHAUSTED",
];

/// How rate-limit answers are waited out (`CalendarBackoff`). One value
/// serves every call of a job, so the budget bounds the job's total waiting.
pub struct RateLimitBackoff<'a> {
	sleeper: &'a dyn Sleeper,
	clock: &'a dyn Clock,
	jitter: &'a (dyn Fn() -> f64 + Send + Sync),
	remaining_ms: Mutex<f64>,
}
impl<'a> RateLimitBackoff<'a> {
	/// `jitter` is uniform in [0, 1); `budget_ms` is the job's waiting allowance.
	pub fn new(
		sleeper: &'a dyn Sleeper,
		clock: &'a dyn Clock,
		jitter: &'a (dyn Fn() -> f64 + Send + Sync),
		budget_ms: f64,
	) -> Self {
		Self {
			sleeper,
			clock,
			jitter,
			remaining_ms: Mutex::new(budget_ms),
		}
	}
	/// Waiting still allowed in this job.
	#[must_use]
	pub fn remaining_ms(&self) -> f64 {
		self.remaining_ms.lock().map_or(0.0, |r| *r)
	}
	/// The wait before retry `retry` of a rate-limited answer, or `None` to
	/// stop (`rateLimitDelay`): not a rate limit worth waiting for, retries
	/// used up, a `Retry-After` over the cap, or the budget spent.
	fn delay(&self, response: &GoogleHttpResponse, retry: i32) -> Option<f64> {
		if retry >= RATE_LIMIT_MAX_RETRIES {
			return None;
		}
		let limited = response.status == 429
			|| (response.status == 403
				&& json::parse(&response.text)
					.ok()
					.as_ref()
					.and_then(error_reasons)
					.unwrap_or_default()
					.iter()
					.any(|reason| BACKOFF_REASONS.contains(reason)));
		if !limited {
			return None;
		}
		#[allow(clippy::cast_precision_loss)]
		let now = self.clock.now_ms() as f64;
		let retry_after = parse_retry_after_ms(response.retry_after.as_deref(), now);
		if retry_after.is_some_and(|ms| ms > RATE_LIMIT_MAX_WAIT_MS) {
			return None;
		}
		let exponential = RATE_LIMIT_BASE_MS.mul_add(
			2f64.powi(retry),
			((self.jitter)() * RATE_LIMIT_JITTER_MS).floor(),
		);
		let delay = exponential.max(retry_after.unwrap_or(0.0));
		(delay <= self.remaining_ms()).then_some(delay)
	}
	async fn wait(&self, delay: f64, cancel: &CancellationToken) {
		if let Ok(mut remaining) = self.remaining_ms.lock() {
			*remaining -= delay;
		}
		#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
		self.sleeper.sleep(delay as u64, Some(cancel)).await;
	}
}

/// Uniform jitter in [0, 1) from the OS generator; 0 when it is unavailable.
#[must_use]
pub fn os_jitter() -> f64 {
	let mut bytes = [0; 4];
	if getrandom::getrandom(&mut bytes).is_err() {
		return 0.0;
	}
	f64::from(u32::from_le_bytes(bytes)) / 4_294_967_296.0
}

use research_net::retry_after::parse_retry_after_ms;

/// Calendar failure (`GoogleCallFailure`) distinguishes a caller stop from
/// provider failures.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum GoogleCallError {
	/// Caller or quota hook stopped the work.
	#[error("ABORTED")]
	Aborted,
	/// Stable OAuth/Calendar code.
	#[error("{code:?}")]
	Failed {
		/// Stable code.
		code: Code,
		/// The status Google answered with when its answer caused the
		/// failure, unchanged; `None` otherwise (timed out, an unusable 200)
		/// (docs/rule/error_handling.md §4a).
		upstream_status: Option<u16>,
	},
}
impl GoogleCallError {
	/// Google's answer status behind the failure, `None` when there is none.
	#[must_use]
	pub const fn upstream_status(&self) -> Option<u16> {
		match self {
			Self::Aborted => None,
			Self::Failed {
				upstream_status, ..
			} => *upstream_status,
		}
	}
}
impl From<Code> for GoogleCallError {
	/// A failure no Google answer status caused.
	fn from(code: Code) -> Self {
		Self::Failed {
			code,
			upstream_status: None,
		}
	}
}
impl From<GoogleTokenFailure> for GoogleCallError {
	/// A failed token refresh, Google's status kept.
	fn from(failure: GoogleTokenFailure) -> Self {
		Self::Failed {
			code: failure.code,
			upstream_status: failure.upstream_status,
		}
	}
}
/// Google's error answer: our code for it, with Google's status kept unchanged.
fn fail_status(response: &GoogleHttpResponse) -> GoogleCallError {
	GoogleCallError::Failed {
		code: map_status(response.status, &response.text),
		upstream_status: Some(response.status),
	}
}
/// In-memory token access and one-shot refresh seam.
#[async_trait]
pub trait CalendarTokens: Send + Sync {
	/// Current access token.
	fn access_token(&self) -> Secret;
	/// True once the access token's lifetime (`expires_in`) has run out.
	fn access_token_expired(&self) -> bool;
	/// Refreshes and updates the current token; the implementation paces it.
	async fn refresh_access_token(&self) -> Result<Secret, GoogleCallError>;
}
/// Dependencies shared by each operation in a sync.
pub struct CalendarClient<'a> {
	/// Narrow pinned HTTP.
	pub http: &'a dyn GoogleHttp,
	/// Current and refreshed credentials.
	pub tokens: &'a dyn CalendarTokens,
	/// One admission per attempt (the 401 retry and backoff retries included).
	pub before_request: &'a dyn QuotaGate,
	/// Rate-limit waits, shared by the job's calls.
	pub backoff: &'a RateLimitBackoff<'a>,
	/// Run cancellation.
	pub cancel: &'a CancellationToken,
}
fn object(entries: Vec<(&str, Value)>) -> Value {
	Value::Object(
		entries
			.into_iter()
			.map(|(k, v)| (k.to_owned(), v))
			.collect::<Object>(),
	)
}
fn string(text: &str) -> Value {
	Value::String(text.to_owned())
}
/// The fields this app manages, in wire order (`managedFields`): confirmed
/// status restores a deleted event; `transparent` shows the day as free, like
/// the `.ics`.
fn managed_fields(body: &GoogleEventBody) -> Vec<(&'static str, Value)> {
	vec![
		("status", string("confirmed")),
		("summary", string(&body.summary)),
		("description", string(&body.description)),
		("start", object(vec![("date", string(&body.start_date))])),
		("end", object(vec![("date", string(&body.end_date))])),
		("transparency", string(GOOGLE_EVENT_TRANSPARENCY.as_str())),
		(
			"extendedProperties",
			object(vec![(
				"private",
				object(vec![
					(
						"researchWorkspace",
						string(&body.private_properties.research_workspace),
					),
					("stockId", string(&body.private_properties.stock_id)),
					("periodKey", string(&body.private_properties.period_key)),
				]),
			)]),
		),
		(
			"source",
			object(vec![
				("title", string(&body.source_title)),
				("url", string(&body.source_url)),
			]),
		),
	]
}
/// Insert body: `id`, then the managed fields.
pub fn event_resource(body: &GoogleEventBody) -> String {
	let mut entries = vec![("id", string(&body.id))];
	entries.extend(managed_fields(body));
	json::stringify(&object(entries))
}
/// PATCH body: only the managed fields, so the owner's reminders and colour survive.
pub fn event_patch(body: &GoogleEventBody) -> String {
	json::stringify(&object(managed_fields(body)))
}
fn error_reasons(v: &Value) -> Option<Vec<&str>> {
	v.as_object()?;
	let Some(error) = field(v, "error") else {
		return Some(Vec::new());
	};
	if let Some(text) = error.as_str() {
		return Some(vec![text]);
	}
	error.as_object()?;
	if field(error, "code").is_some_and(|v| v.as_f64().is_none_or(|n| !n.is_finite())) {
		return None;
	}
	if ["reason", "status"]
		.iter()
		.any(|k| field(error, k).is_some_and(|v| v.as_str().is_none()))
	{
		return None;
	}
	let mut reasons: Vec<_> = ["reason", "status"]
		.into_iter()
		.filter_map(|k| text(error, k))
		.collect();
	if let Some(items) = field(error, "errors") {
		for item in items.as_array()? {
			item.as_object()?;
			if let Some(reason) = field(item, "reason") {
				reasons.push(reason.as_str()?);
			}
		}
	}
	Some(reasons)
}
/// Defensive error mapping; 429 and rate reasons take precedence over invalid_grant.
pub fn map_status(status: u16, body: &str) -> Code {
	if status == 429 {
		return Code::RateLimited;
	}
	if (300..400).contains(&status) {
		return Code::RequestFailed;
	}
	let json = json::parse(body).ok();
	let reasons = json.as_ref().and_then(error_reasons).unwrap_or_default();
	if reasons.iter().any(|s| RATE_LIMIT_REASONS.contains(s)) {
		return Code::RateLimited;
	}
	if reasons.contains(&"invalid_grant") {
		return Code::AuthExpired;
	}
	Code::RequestFailed
}
fn valid_event(v: &Value) -> bool {
	text(v, "id").is_some_and(|s| !s.is_empty())
		&& ["status", "summary", "description", "transparency"]
			.iter()
			.all(|k| field(v, k).is_none_or(|v| v.as_str().is_some()))
		&& ["start", "end"].iter().all(|k| {
			field(v, k).is_none_or(|v| {
				v.as_object().is_some()
					&& ["date", "dateTime"]
						.iter()
						.all(|k| field(v, k).is_none_or(|v| v.as_str().is_some()))
			})
		})
}
/// Normalizes a provider event after validating its shape.
pub fn to_managed(v: &Value) -> Option<ManagedGoogleEvent> {
	if !valid_event(v) {
		return None;
	}
	let date = |key| {
		field(v, key)
			.map(|v| {
				text(v, "date").map(str::to_owned).unwrap_or_else(|| {
					research_js::utf16::slice(text(v, "dateTime").unwrap_or(""), 0, 10).into_owned()
				})
			})
			.unwrap_or_default()
	};
	Some(ManagedGoogleEvent {
		id: text(v, "id")?.to_owned(),
		status: if text(v, "status") == Some("cancelled") {
			ManagedEventStatus::Cancelled
		} else {
			ManagedEventStatus::Confirmed
		},
		start_date: date("start"),
		end_date: date("end"),
		summary: text(v, "summary").unwrap_or("").to_owned(),
		description: text(v, "description").unwrap_or("").to_owned(),
		// Absent (Google's default) or anything else is busy.
		transparency: if text(v, "transparency") == Some("transparent") {
			GoogleEventTransparency::Transparent
		} else {
			GoogleEventTransparency::Opaque
		},
	})
}
fn calendar_path(id: &str) -> String {
	format!("/calendar/v3/calendars/{}", encode_uri_component(id))
}
fn calendar_id(body: &str) -> Result<String, GoogleCallError> {
	json::parse(body)
		.ok()
		.as_ref()
		.and_then(|v| text(v, "id"))
		.filter(|s| !s.is_empty())
		.map(str::to_owned)
		.ok_or(Code::RequestFailed.into())
}
impl CalendarClient<'_> {
	async fn attempt(
		&self,
		method: &str,
		path: &str,
		body: Option<&str>,
		token: &Secret,
	) -> Result<GoogleHttpResponse, GoogleCallError> {
		let auth = format!("Bearer {}", token.expose());
		let mut headers = vec![("authorization", auth.as_str())];
		if body.is_some() {
			headers.push(("content-type", "application/json; charset=utf-8"));
		}
		self.http
			.send(GoogleHttpRequest {
				host: GOOGLE_CALENDAR_HOST,
				method,
				path,
				headers: &headers,
				body,
				cancel: self.cancel,
			})
			.await
			.map_err(|_| {
				if self.cancel.is_cancelled() {
					GoogleCallError::Aborted
				} else {
					Code::RequestFailed.into()
				}
			})
	}
	async fn admitted(&self, units: usize) -> bool {
		!self.cancel.is_cancelled()
			&& self.before_request.admit(units).await
			&& !self.cancel.is_cancelled()
	}
	async fn refresh(&self) -> Result<(), GoogleCallError> {
		self.tokens.refresh_access_token().await?;
		if self.cancel.is_cancelled() {
			return Err(GoogleCallError::Aborted);
		}
		Ok(())
	}
	/// Readies one attempt (`ready`): an expired token is refreshed FIRST —
	/// the refresh waits on the same gate and is a request of its own, so
	/// units reserved before it could age out of the window — and the units
	/// are reserved right before sending. When that wait outlived a token
	/// that was still fresh, it is refreshed and the units reserved once
	/// more (bounded: no loop).
	async fn ready(&self, units: usize) -> Result<(), GoogleCallError> {
		let expired = self.tokens.access_token_expired();
		if expired {
			self.refresh().await?;
		}
		if !self.admitted(units).await {
			return Err(GoogleCallError::Aborted);
		}
		if expired || !self.tokens.access_token_expired() {
			return Ok(());
		}
		self.refresh().await?;
		if self.admitted(units).await {
			Ok(())
		} else {
			Err(GoogleCallError::Aborted)
		}
	}
	/// One request (`send`): every attempt readied by `ready`; a 401
	/// refreshed and retried once per call, also after an expiry refresh; a
	/// rate-limit answer retried after the backoff's delay.
	async fn send(
		&self,
		method: &str,
		path: &str,
		body: Option<&str>,
	) -> Result<GoogleHttpResponse, GoogleCallError> {
		if self.cancel.is_cancelled() {
			return Err(GoogleCallError::Aborted);
		}
		let units = if method == "PATCH" {
			PATCH_QUOTA_UNITS
		} else {
			1
		};
		// The 401 fallback is spent at most once per call, and separately from
		// expiry refreshes: a token refreshed on expiry can still be rejected.
		let mut auth_retried = false;
		let mut retry = 0;
		loop {
			self.ready(units).await?;
			let mut answer = self
				.attempt(method, path, body, &self.tokens.access_token())
				.await?;
			if answer.status == 401 && !auth_retried {
				auth_retried = true;
				self.refresh().await?;
				// The retry is a request of its own: the gate admits it too,
				// after the refresh, right before it is sent.
				if !self.admitted(units).await {
					return Err(GoogleCallError::Aborted);
				}
				answer = self
					.attempt(method, path, body, &self.tokens.access_token())
					.await?;
			}
			let Some(delay) = self.backoff.delay(&answer, retry) else {
				return Ok(answer);
			};
			self.backoff.wait(delay, self.cancel).await;
			if self.cancel.is_cancelled() {
				return Err(GoogleCallError::Aborted);
			}
			retry += 1;
		}
	}
	/// Creates a secondary calendar from an exactly ordered resource body.
	pub async fn create_calendar(
		&self,
		summary: &str,
		description: &str,
		time_zone: &str,
	) -> Result<String, GoogleCallError> {
		let body = json::stringify(&object(vec![
			("summary", string(summary)),
			("description", string(description)),
			("timeZone", string(time_zone)),
		]));
		let r = self
			.send("POST", "/calendar/v3/calendars", Some(&body))
			.await?;
		if r.status != 200 {
			return Err(fail_status(&r));
		}
		calendar_id(&r.text)
	}
	/// Returns None for 404; a found id is read from the response.
	pub async fn get_calendar(&self, id: &str) -> Result<Option<String>, GoogleCallError> {
		let r = self.send("GET", &calendar_path(id), None).await?;
		if r.status == 404 {
			return Ok(None);
		}
		if r.status != 200 {
			return Err(fail_status(&r));
		}
		calendar_id(&r.text).map(Some)
	}
	/// Lists all managed events, refusing partial listings beyond ten pages.
	pub async fn list_managed_events(
		&self,
		id: &str,
	) -> Result<Vec<ManagedGoogleEvent>, GoogleCallError> {
		let mut events = Vec::new();
		let mut page_token: Option<String> = None;
		for _ in 0..10 {
			let query = {
				let mut query = url::form_urlencoded::Serializer::new(String::new());
				query
					.append_pair("privateExtendedProperty", "researchWorkspace=earnings")
					.append_pair("showDeleted", "true")
					.append_pair("maxResults", "250");
				if let Some(token) = &page_token {
					query.append_pair("pageToken", token);
				}
				query.finish()
			};
			let r = self
				.send(
					"GET",
					&format!("{}/events?{query}", calendar_path(id)),
					None,
				)
				.await?;
			if r.status != 200 {
				return Err(fail_status(&r));
			}
			let v = json::parse(&r.text).map_err(|_| GoogleCallError::from(Code::RequestFailed))?;
			if v.as_object().is_none()
				|| field(&v, "nextPageToken").is_some_and(|v| v.as_str().is_none())
			{
				return Err(Code::RequestFailed.into());
			}
			if let Some(items) = field(&v, "items") {
				for item in items.as_array().ok_or(Code::RequestFailed)? {
					events.push(to_managed(item).ok_or(Code::RequestFailed)?);
				}
			}
			page_token = text(&v, "nextPageToken").map(str::to_owned);
			if page_token.is_none() {
				return Ok(events);
			}
		}
		Err(Code::RequestFailed.into())
	}
	/// True when inserted, false on a 409 that the caller may update once.
	pub async fn insert_event(
		&self,
		id: &str,
		event: &GoogleEventBody,
	) -> Result<bool, GoogleCallError> {
		let r = self
			.send(
				"POST",
				&format!("{}/events", calendar_path(id)),
				Some(&event_resource(event)),
			)
			.await?;
		match r.status {
			200 => Ok(true),
			409 => Ok(false),
			_ => Err(fail_status(&r)),
		}
	}
	/// Updates the managed fields with PATCH (the owner's reminders and colour
	/// survive); the confirmed status restores a cancelled event.
	pub async fn update_event(
		&self,
		id: &str,
		event: &GoogleEventBody,
	) -> Result<(), GoogleCallError> {
		let r = self
			.send(
				"PATCH",
				&format!(
					"{}/events/{}",
					calendar_path(id),
					encode_uri_component(&event.id)
				),
				Some(&event_patch(event)),
			)
			.await?;
		if r.status == 200 {
			Ok(())
		} else {
			Err(fail_status(&r))
		}
	}
	/// Treats an already-gone event (404/410) as successful deletion.
	pub async fn delete_event(&self, id: &str, event_id: &str) -> Result<(), GoogleCallError> {
		let r = self
			.send(
				"DELETE",
				&format!(
					"{}/events/{}",
					calendar_path(id),
					encode_uri_component(event_id)
				),
				None,
			)
			.await?;
		if [200, 204, 404, 410].contains(&r.status) {
			Ok(())
		} else {
			Err(fail_status(&r))
		}
	}
}
#[cfg(test)]
mod tests {
	use super::*;

	struct NoSleep;
	#[async_trait]
	impl Sleeper for NoSleep {
		async fn sleep(&self, _: u64, _: Option<&CancellationToken>) {}
	}
	struct Fixed;
	impl Clock for Fixed {
		fn now_ms(&self) -> i64 {
			1_793_430_000_000
		}
		fn now_iso(&self) -> String {
			"2026-10-31T07:00:00.000Z".to_owned()
		}
	}
	fn answer(status: u16, retry_after: Option<&str>, text: &str) -> GoogleHttpResponse {
		GoogleHttpResponse {
			status,
			location: None,
			content_type: None,
			retry_after: retry_after.map(str::to_owned),
			text: text.to_owned(),
		}
	}

	#[test]
	fn backs_off_exponentially_within_the_caps() {
		let jitter = || 0.5;
		let backoff = RateLimitBackoff::new(&NoSleep, &Fixed, &jitter, 10_000.0);
		let limited = answer(429, None, "{}");
		assert_eq!(backoff.delay(&limited, 0), Some(1_500.0));
		assert_eq!(backoff.delay(&limited, 3), Some(8_500.0));
		assert_eq!(backoff.delay(&limited, RATE_LIMIT_MAX_RETRIES), None);
		// A longer Retry-After wins; one over the cap is not waited out.
		assert_eq!(
			backoff.delay(&answer(429, Some("9"), "{}"), 0),
			Some(9_000.0)
		);
		assert_eq!(backoff.delay(&answer(429, Some("31"), "{}"), 0), None);
		// Over the remaining budget.
		assert_eq!(backoff.delay(&answer(429, Some("11"), "{}"), 0), None);
		// 403: only the per-request rate limits, not the Calendar usage limit.
		let reason = |r: &str| format!(r#"{{"error":{{"errors":[{{"reason":"{r}"}}]}}}}"#);
		assert!(
			backoff
				.delay(&answer(403, None, &reason("userRateLimitExceeded")), 0)
				.is_some()
		);
		assert_eq!(
			backoff.delay(&answer(403, None, &reason("quotaExceeded")), 0),
			None
		);
		assert_eq!(
			backoff.delay(&answer(403, None, &reason("forbidden")), 0),
			None
		);
		assert_eq!(map_status(403, &reason("quotaExceeded")), Code::RateLimited);
	}

	#[test]
	fn patch_body_is_the_managed_fields_without_id() {
		let body: GoogleEventBody = serde_json::from_value(serde_json::json!({
			"id": "a".repeat(32),
			"summary": "S",
			"description": "D",
			"startDate": "2026-10-29",
			"endDate": "2026-10-30",
			"privateProperties": {"researchWorkspace": "earnings", "stockId": "us:AAPL", "periodKey": "2026-q4"},
			"sourceTitle": "Finnhub",
			"sourceUrl": "https://finnhub.io/",
		}))
		.unwrap_or_else(|_| unreachable!());
		let patch = event_patch(&body);
		assert!(patch.starts_with(r#"{"status":"confirmed","#));
		assert!(patch.contains(r#""transparency":"transparent""#));
		assert!(!patch.contains(r#""id""#));
		assert_eq!(
			event_resource(&body),
			format!(r#"{{"id":"{}",{}"#, "a".repeat(32), &patch[1..])
		);
	}
}
