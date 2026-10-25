//! Google Calendar v3 calls, with one quota grant and at most one token retry per call.
use crate::{
	http::*,
	oauth::{GoogleTokenFailure, field, text},
};
use async_trait::async_trait;
use research_contracts::google_calendar::GoogleCalendarFailureCode as Code;
use research_domain::calendar::google_sync::{
	GoogleEventBody, ManagedEventStatus, ManagedGoogleEvent,
};
use research_finance::ports::{BeforeRequest, Secret};
use research_js::{
	json::{self, Object, Value},
	uri::encode_uri_component,
};
use tokio_util::sync::CancellationToken;
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
	/// Refreshes and updates the current token.
	async fn refresh_access_token(&self) -> Result<Secret, GoogleCallError>;
}
/// Dependencies shared by each operation in a sync.
pub struct CalendarClient<'a> {
	/// Narrow pinned HTTP.
	pub http: &'a dyn GoogleHttp,
	/// Current and refreshed credentials.
	pub tokens: &'a dyn CalendarTokens,
	/// One quota grant per call, no extra grant for the 401 retry.
	pub before_request: &'a dyn BeforeRequest,
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
/// Exact provider JSON order, including confirmed status to restore deleted events.
pub fn event_resource(body: &GoogleEventBody) -> String {
	json::stringify(&object(vec![
		("id", string(&body.id)),
		("status", string("confirmed")),
		("summary", string(&body.summary)),
		("description", string(&body.description)),
		("start", object(vec![("date", string(&body.start_date))])),
		("end", object(vec![("date", string(&body.end_date))])),
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
	]))
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
	if reasons.iter().any(|s| {
		[
			"rateLimitExceeded",
			"userRateLimitExceeded",
			"quotaExceeded",
			"RESOURCE_EXHAUSTED",
		]
		.contains(s)
	}) {
		return Code::RateLimited;
	}
	if reasons.contains(&"invalid_grant") {
		return Code::AuthExpired;
	}
	Code::RequestFailed
}
fn valid_event(v: &Value) -> bool {
	text(v, "id").is_some_and(|s| !s.is_empty())
		&& ["status", "summary", "description"]
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
	async fn send(
		&self,
		method: &str,
		path: &str,
		body: Option<&str>,
	) -> Result<GoogleHttpResponse, GoogleCallError> {
		if self.cancel.is_cancelled()
			|| !self.before_request.before_request().await
			|| self.cancel.is_cancelled()
		{
			return Err(GoogleCallError::Aborted);
		}
		let first = self
			.attempt(method, path, body, &self.tokens.access_token())
			.await?;
		if first.status != 401 {
			return Ok(first);
		}
		let token = self.tokens.refresh_access_token().await?;
		if self.cancel.is_cancelled() {
			return Err(GoogleCallError::Aborted);
		}
		self.attempt(method, path, body, &token).await
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
	/// Restores/upserts the desired event with confirmed status.
	pub async fn update_event(
		&self,
		id: &str,
		event: &GoogleEventBody,
	) -> Result<(), GoogleCallError> {
		let r = self
			.send(
				"PUT",
				&format!(
					"{}/events/{}",
					calendar_path(id),
					encode_uri_component(&event.id)
				),
				Some(&event_resource(event)),
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
