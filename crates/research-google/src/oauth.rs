//! Desktop-app code exchange, PKCE S256, token refresh and best-effort revocation.
use crate::http::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use research_contracts::google_calendar::GoogleCalendarFailureCode as Code;
use research_finance::ports::Secret;
use research_js::json::{self, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
/// The only requested scope: calendars created by this application.
pub const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.app.created";
/// Desktop-app authorization endpoint.
pub const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// Error from OS cryptographic randomness, without exposing random bytes.
#[derive(Debug, thiserror::Error)]
#[error("secure random generation failed")]
pub struct RandomError;
/// Generates 32 CSPRNG bytes as 43 base64url characters, without padding.
pub fn new_oauth_state() -> Result<String, RandomError> {
	let mut bytes = [0; 32];
	getrandom::getrandom(&mut bytes).map_err(|_| RandomError)?;
	Ok(URL_SAFE_NO_PAD.encode(bytes))
}
/// Generates a secret PKCE verifier.
pub fn new_code_verifier() -> Result<Secret, RandomError> {
	new_oauth_state().map(Secret::new)
}
/// RFC 7636 S256 challenge, with no base64 padding.
pub fn code_challenge_s256(verifier: &str) -> String {
	URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
/// Builds the exact nine parameters in TypeScript insertion order.
pub fn build_authorization_url(
	client_id: &str,
	redirect_uri: &str,
	state: &str,
	challenge: &str,
) -> String {
	format!(
		"{GOOGLE_AUTH_ENDPOINT}?{}",
		form(&[
			("response_type", "code"),
			("client_id", client_id),
			("redirect_uri", redirect_uri),
			("scope", GOOGLE_CALENDAR_SCOPE),
			("access_type", "offline"),
			("prompt", "consent"),
			("code_challenge", challenge),
			("code_challenge_method", "S256"),
			("state", state)
		])
	)
}
fn form(pairs: &[(&str, &str)]) -> String {
	url::form_urlencoded::Serializer::new(String::new())
		.extend_pairs(pairs.iter().copied())
		.finish()
}
pub(crate) fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
	value.as_object()?.get(key)
}
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	field(value, key)?.as_str()
}
/// Maps token endpoint status/body without leaking provider text.
pub fn map_token_failure(status: Option<u16>, body: Option<&str>) -> Code {
	if status == Some(429) {
		return Code::RateLimited;
	}
	if status.is_some_and(|s| (300..400).contains(&s)) {
		return Code::RequestFailed;
	}
	let parsed = body.and_then(|s| json::parse(s).ok());
	if let Some(v) = parsed.as_ref().filter(|v| valid_error(v)) {
		let code = field(v, "error").and_then(|e| e.as_str().or_else(|| text(e, "code")));
		if code == Some("invalid_grant") {
			return Code::AuthExpired;
		}
		if code == Some("rateLimitExceeded")
			|| field(v, "rateLimitExceeded").and_then(Value::as_bool) == Some(true)
		{
			return Code::RateLimited;
		}
	}
	Code::RequestFailed
}
fn valid_error(v: &Value) -> bool {
	v.as_object().is_some()
		&& field(v, "error_description").is_none_or(|v| v.as_str().is_some())
		&& field(v, "rateLimitExceeded").is_none_or(|v| v.as_bool().is_some())
		&& field(v, "error").is_none_or(|e| {
			e.as_str().is_some()
				|| (e.as_object().is_some()
					&& field(e, "code").is_none_or(|v| v.as_str().is_some()))
		})
}
/// Configured Desktop-app client credentials; Debug redacts the secret.
#[derive(Clone, Debug)]
pub struct OAuthClient {
	/// Public client id.
	pub client_id: String,
	/// Client secret.
	pub client_secret: Secret,
}
/// In-memory tokens from a code exchange.
#[derive(Clone, Debug)]
pub struct TokenSuccess {
	/// Short-lived access token, never stored.
	pub access_token: Secret,
	/// Long-lived refresh token.
	pub refresh_token: Secret,
	/// Provider-granted scopes.
	pub scope: Option<String>,
	/// Access expiry seconds.
	pub expires_in: Option<f64>,
}
/// Refreshed access token, kept in memory only.
#[derive(Clone, Debug)]
pub struct RefreshedToken {
	/// Short-lived credential.
	pub access_token: Secret,
	/// Access expiry seconds.
	pub expires_in: Option<f64>,
}
fn token_response(body: &str) -> Option<Value> {
	let v = json::parse(body).ok()?;
	if text(&v, "access_token").is_none_or(str::is_empty)
		|| field(&v, "refresh_token").is_some_and(|v| v.as_str().is_none_or(str::is_empty))
		|| ["scope", "token_type"]
			.iter()
			.any(|key| field(&v, key).is_some_and(|v| v.as_str().is_none()))
		|| field(&v, "expires_in").is_some_and(|v| {
			!v.as_f64().is_some_and(|n| {
				n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0
			})
		}) {
		return None;
	}
	Some(v)
}
async fn token_post(
	http: &dyn GoogleHttp,
	pairs: &[(&str, &str)],
	cancel: &CancellationToken,
) -> Result<Value, Code> {
	let body = form(pairs);
	let response = http
		.send(GoogleHttpRequest {
			host: GOOGLE_OAUTH_HOST,
			method: "POST",
			path: "/token",
			headers: &[("content-type", "application/x-www-form-urlencoded")],
			body: Some(&body),
			cancel,
		})
		.await
		.map_err(|_| Code::RequestFailed)?;
	if response.status != 200 {
		return Err(map_token_failure(
			Some(response.status),
			Some(&response.text),
		));
	}
	token_response(&response.text).ok_or(Code::RequestFailed)
}
/// Exchanges one callback code; no retry and no implicit scope fallback.
pub async fn exchange_code(
	http: &dyn GoogleHttp,
	client: &OAuthClient,
	code: &Secret,
	verifier: &Secret,
	redirect_uri: &str,
	cancel: &CancellationToken,
) -> Result<TokenSuccess, Code> {
	let v = token_post(
		http,
		&[
			("grant_type", "authorization_code"),
			("code", code.expose()),
			("client_id", &client.client_id),
			("client_secret", client.client_secret.expose()),
			("redirect_uri", redirect_uri),
			("code_verifier", verifier.expose()),
		],
		cancel,
	)
	.await?;
	Ok(TokenSuccess {
		access_token: Secret::new(text(&v, "access_token").ok_or(Code::RequestFailed)?),
		refresh_token: Secret::new(text(&v, "refresh_token").ok_or(Code::ScopeMissing)?),
		scope: text(&v, "scope").map(str::to_owned),
		expires_in: field(&v, "expires_in").and_then(Value::as_f64),
	})
}
/// Refreshes once; no retries or persistence of access tokens.
pub async fn refresh_access_token(
	http: &dyn GoogleHttp,
	client: &OAuthClient,
	refresh_token: &Secret,
	cancel: &CancellationToken,
) -> Result<RefreshedToken, Code> {
	let v = token_post(
		http,
		&[
			("grant_type", "refresh_token"),
			("client_id", &client.client_id),
			("client_secret", client.client_secret.expose()),
			("refresh_token", refresh_token.expose()),
		],
		cancel,
	)
	.await?;
	Ok(RefreshedToken {
		access_token: Secret::new(text(&v, "access_token").ok_or(Code::RequestFailed)?),
		expires_in: field(&v, "expires_in").and_then(Value::as_f64),
	})
}
/// Best-effort revocation; only HTTP 200 means revoked.
pub async fn revoke_token(
	http: &dyn GoogleHttp,
	token: &Secret,
	cancel: &CancellationToken,
) -> bool {
	let body = form(&[("token", token.expose())]);
	http.send(GoogleHttpRequest {
		host: GOOGLE_OAUTH_HOST,
		method: "POST",
		path: "/revoke",
		headers: &[("content-type", "application/x-www-form-urlencoded")],
		body: Some(&body),
		cancel,
	})
	.await
	.is_ok_and(|r| r.status == 200)
}
/// Tests exact space-delimited scope membership.
pub fn scope_granted(scope: Option<&str>) -> bool {
	scope.is_some_and(|s| s.split(' ').any(|scope| scope == GOOGLE_CALENDAR_SCOPE))
}
