//! Replays `vectors/google/*.json` (written by Node from the real
//! TypeScript: `node scripts/vectors/index.ts google`): the OAuth helpers,
//! the Calendar client, the token file and the runner's connect / sync /
//! disconnect flows over the real loopback listener and token store.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing,
	clippy::cast_possible_truncation,
	clippy::cast_possible_wrap,
	clippy::cast_sign_loss
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use research_application::ports::Clock;
use research_application::reporter::{PipelineReporter, ToolCallOutcome};
use research_contracts::google_calendar::{
	GoogleCalendarFailureCode as Code, is_google_sign_in_url,
};
use research_domain::calendar::google_sync::GoogleEventBody;
use research_domain::jobs::budget::ResourceUsage;
use research_domain::jobs::state_machine::JobState;
use research_effects::{EventLogger, LogValue};
use research_finance::pacing::{MarketPacer, MarketRateLimit, WindowMarketPacer};
use research_finance::ports::{BeforeRequest, Secret, Sleeper};
use research_google::calendar::{CalendarClient, CalendarTokens, GoogleCallError};
use research_google::http::{
	GoogleHttp, GoogleHttpError, GoogleHttpErrorCode, GoogleHttpRequest, GoogleHttpResponse,
};
use research_google::jobs::{
	GoogleAuthUrlSender, GoogleExecutionEnv, discard_stored_google_grant, execute_google_calendar,
};
use research_google::oauth::{
	OAuthClient, build_authorization_url, code_challenge_s256, exchange_code, map_token_failure,
	new_code_verifier, new_oauth_state, refresh_access_token, revoke_token, scope_granted,
};
use research_google::token_store::{
	GoogleTokenRecord, decode_token_record, encode_token_record, read_google_token_file,
	write_google_token_file,
};
use research_js::json::Value;
use serde_json::{Map, Number, Value as Json, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/* ---------- loading and comparing ---------- */

fn load(name: &str) -> Value {
	let path = format!("{}/../../vectors/google/{name}", env!("CARGO_MANIFEST_DIR"));
	let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
	research_js::json::parse(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn has<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
	value.as_object().and_then(|o| o.get(key))
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
	has(value, key).unwrap_or_else(|| panic!("missing field {key}"))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
	field(value, key)
		.as_str()
		.unwrap_or_else(|| panic!("{key} not a string"))
}

fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	match has(value, key) {
		None | Some(Value::Null) => None,
		Some(other) => other.as_str(),
	}
}

fn number(value: &Value, key: &str) -> f64 {
	field(value, key)
		.as_f64()
		.unwrap_or_else(|| panic!("{key} not a number"))
}

fn flag(value: &Value, key: &str) -> bool {
	field(value, key)
		.as_bool()
		.unwrap_or_else(|| panic!("{key} not a boolean"))
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
	field(value, key)
		.as_array()
		.unwrap_or_else(|| panic!("{key} not an array"))
}

fn to_serde(value: &Value) -> Json {
	match value {
		Value::Null => Json::Null,
		Value::Bool(b) => Json::Bool(*b),
		Value::Number(n) => Number::from_f64(*n).map_or(Json::Null, Json::Number),
		Value::String(s) => Json::String(s.clone()),
		Value::Array(items) => Json::Array(items.iter().map(to_serde).collect()),
		Value::Object(o) => {
			let mut map = Map::new();
			for (k, v) in o.iter() {
				map.insert(k.to_owned(), to_serde(v));
			}
			Json::Object(map)
		}
	}
}

fn norm(value: &Json) -> Json {
	match value {
		Json::Number(n) => {
			let d = n.as_f64().unwrap_or(f64::NAN);
			if d == 0.0 && d.is_sign_negative() {
				// The exporters write a negative zero as this marker.
				Json::String("-0(neg)".to_owned())
			} else {
				Number::from_f64(d).map_or(Json::Null, Json::Number)
			}
		}
		Json::Array(items) => Json::Array(items.iter().map(norm).collect()),
		Json::Object(map) => Json::Object(map.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
		other => other.clone(),
	}
}

fn report(failures: &[String]) {
	assert!(
		failures.is_empty(),
		"{} mismatches, first: {:#?}",
		failures.len(),
		failures.iter().take(4).collect::<Vec<_>>()
	);
}

fn check(failures: &mut Vec<String>, label: String, actual: &Json, expected: &Value) {
	let expected = to_serde(expected);
	if norm(actual) != norm(&expected) {
		// Only the top-level keys that differ, to keep the report readable.
		let (a, e) = (norm(actual), norm(&expected));
		let detail = match (a.as_object(), e.as_object()) {
			(Some(a), Some(e)) => a
				.keys()
				.chain(e.keys())
				.filter(|k| a.get(*k) != e.get(*k))
				.map(|k| {
					format!(
						"{k}: {} != expected {}",
						a.get(k).unwrap_or(&Json::Null),
						e.get(k).unwrap_or(&Json::Null)
					)
				})
				.collect::<Vec<_>>()
				.join("\n   "),
			_ => format!("{a} != expected {e}"),
		};
		failures.push(format!("{label}:\n   {detail}"));
	}
}

/* ---------- scripted narrow HTTP ---------- */

#[derive(Clone, Default)]
struct Requests(Arc<Mutex<Vec<Json>>>);

fn http_error_code(name: &str) -> GoogleHttpErrorCode {
	match name {
		"HOST_NOT_ALLOWED" => GoogleHttpErrorCode::HostNotAllowed,
		"DNS_FAILED" => GoogleHttpErrorCode::DnsFailed,
		"UNSAFE_DESTINATION" => GoogleHttpErrorCode::UnsafeDestination,
		"NETWORK_ERROR" => GoogleHttpErrorCode::NetworkError,
		"TIMEOUT" => GoogleHttpErrorCode::Timeout,
		"RESPONSE_TOO_LARGE" => GoogleHttpErrorCode::ResponseTooLarge,
		other => panic!("unknown code {other}"),
	}
}

fn answer(entry: Option<&Value>) -> Result<GoogleHttpResponse, GoogleHttpError> {
	let Some(entry) = entry else {
		return Ok(GoogleHttpResponse {
			status: 404,
			location: None,
			content_type: None,
			text: "{}".to_owned(),
		});
	};
	if let Some(error) = has(entry, "error") {
		return Err(GoogleHttpError {
			code: http_error_code(text(error, "code")),
			detail: text(error, "detail").to_owned(),
		});
	}
	Ok(GoogleHttpResponse {
		status: number(entry, "status") as u16,
		location: optional_text(entry, "location").map(str::to_owned),
		content_type: Some("application/json".to_owned()),
		text: text(entry, "text").to_owned(),
	})
}

fn request_json(request: &GoogleHttpRequest<'_>, body: Json) -> Json {
	let headers: Map<String, Json> = request
		.headers
		.iter()
		.map(|(k, v)| ((*k).to_owned(), Json::String((*v).to_owned())))
		.collect();
	json!({"host": request.host, "method": request.method, "path": request.path, "headers": headers, "body": body})
}

struct SequentialHttp {
	script: Vec<Value>,
	next: Mutex<usize>,
	requests: Requests,
	on_call: Box<dyn Fn(usize) + Send + Sync>,
}

#[async_trait]
impl GoogleHttp for SequentialHttp {
	async fn send(
		&self,
		request: GoogleHttpRequest<'_>,
	) -> Result<GoogleHttpResponse, GoogleHttpError> {
		self.requests.0.lock().unwrap().push(request_json(
			&request,
			request
				.body
				.map_or(Json::Null, |b| Json::String(b.to_owned())),
		));
		let count = {
			let mut next = self.next.lock().unwrap();
			*next += 1;
			*next
		};
		let result = answer(self.script.get(count - 1));
		(self.on_call)(count);
		result
	}
}

fn sequential(
	script: &Value,
	requests: &Requests,
	on_call: Box<dyn Fn(usize) + Send + Sync>,
) -> SequentialHttp {
	SequentialHttp {
		script: script.as_array().unwrap().to_vec(),
		next: Mutex::new(0),
		requests: requests.clone(),
		on_call,
	}
}

/* ---------- pure helpers ---------- */

#[test]
fn pure_helpers_match_typescript() {
	let file = load("pure.json");
	let mut failures = Vec::new();
	for (i, case) in array(&file, "urls").iter().enumerate() {
		let url = build_authorization_url(
			text(case, "clientId"),
			text(case, "redirectUri"),
			text(case, "state"),
			text(case, "challenge"),
		);
		if url != text(case, "url") {
			failures.push(format!("url {i}: {url}"));
		}
		if is_google_sign_in_url(&url) != flag(case, "signIn") {
			failures.push(format!("signIn {i}"));
		}
	}
	for case in array(&file, "challenges") {
		if code_challenge_s256(text(case, "verifier")) != text(case, "challenge") {
			failures.push(format!("challenge {:?}", text(case, "verifier")));
		}
	}
	for case in array(&file, "scopes") {
		if scope_granted(optional_text(case, "scope")) != flag(case, "output") {
			failures.push(format!("scope {:?}", optional_text(case, "scope")));
		}
	}
	for case in array(&file, "failures") {
		let status = has(case, "status")
			.and_then(Value::as_f64)
			.map(|n| n as u16);
		let actual = map_token_failure(status, optional_text(case, "text")).as_str();
		if actual != text(case, "output") {
			failures.push(format!(
				"failure {status:?} {:?}: {actual}",
				optional_text(case, "text")
			));
		}
	}
	report(&failures);
	// Fresh random values are 43 base64url characters.
	for value in [
		new_code_verifier().unwrap().expose().to_owned(),
		new_oauth_state().unwrap(),
	] {
		assert_eq!(value.len(), 43);
		assert!(
			value
				.bytes()
				.all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
		);
	}
}

/* ---------- OAuth ---------- */

#[tokio::test]
async fn oauth_matches_typescript() {
	let file = load("oauth.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 200);
	let mut failures = Vec::new();
	for (i, case) in cases.iter().enumerate() {
		let requests = Requests::default();
		let http = sequential(field(case, "script"), &requests, Box::new(|_| {}));
		let cancel = CancellationToken::new();
		let client = OAuthClient {
			client_id: "cid & 1".to_owned(),
			client_secret: Secret::new("sec=ret"),
		};
		let output = match text(case, "op") {
			"exchange" => {
				let result = exchange_code(
					&http,
					&client,
					&Secret::new("co de/+"),
					&Secret::new("veri~fier"),
					"http://127.0.0.1:5555/",
					&cancel,
				)
				.await;
				match result {
					Ok(t) => json!({"ok": true, "value": {
						"accessToken": t.access_token.expose(),
						"refreshToken": t.refresh_token.expose(),
						"scope": t.scope,
						"expiresIn": t.expires_in,
					}}),
					Err(failure) => {
						json!({"ok": false, "error": serde_json::to_value(failure).unwrap()})
					}
				}
			}
			"refresh" => {
				let client = OAuthClient {
					client_id: "cid".to_owned(),
					client_secret: Secret::new("sec"),
				};
				match refresh_access_token(&http, &client, &Secret::new("re fresh"), &cancel).await
				{
					Ok(t) => {
						json!({"ok": true, "value": {"accessToken": t.access_token.expose(), "expiresIn": t.expires_in}})
					}
					Err(failure) => {
						json!({"ok": false, "error": serde_json::to_value(failure).unwrap()})
					}
				}
			}
			_ => json!({"revoked": revoke_token(&http, &Secret::new("to ken&="), &cancel).await}),
		};
		check(
			&mut failures,
			format!("oauth {i} output"),
			&output,
			field(case, "output"),
		);
		let actual_requests = Json::Array(requests.0.lock().unwrap().clone());
		check(
			&mut failures,
			format!("oauth {i} requests"),
			&actual_requests,
			field(case, "requests"),
		);
	}
	report(&failures);
}

/* ---------- Calendar ---------- */

struct ScriptedTokens {
	current: Mutex<String>,
	refreshes: Vec<Value>,
	next: Mutex<usize>,
	trace: Arc<Mutex<Vec<Json>>>,
}

#[async_trait]
impl CalendarTokens for ScriptedTokens {
	fn access_token(&self) -> Secret {
		Secret::new(self.current.lock().unwrap().clone())
	}

	async fn refresh_access_token(&self) -> Result<Secret, GoogleCallError> {
		let index = {
			let mut next = self.next.lock().unwrap();
			*next += 1;
			*next - 1
		};
		self.trace.lock().unwrap().push(json!({"refresh": true}));
		match self.refreshes.get(index) {
			None => Err(GoogleCallError::from(Code::RequestFailed)),
			Some(entry) if has(entry, "code").is_some() => match text(entry, "code") {
				"ABORTED" => Err(GoogleCallError::Aborted),
				other => Err(GoogleCallError::Failed {
					code: Code::from_str_value(other).unwrap_or(Code::RequestFailed),
					// Google's status the scripted refresh answered with (§4a).
					upstream_status: has(entry, "upstreamStatus")
						.and_then(Value::as_f64)
						.and_then(research_domain::upstream::upstream_status_from_number),
				}),
			},
			Some(entry) => {
				let token = text(entry, "token").to_owned();
				*self.current.lock().unwrap() = token.clone();
				Ok(Secret::new(token))
			}
		}
	}
}

struct ScriptedBefore {
	answers: Vec<bool>,
	next: Mutex<usize>,
	trace: Arc<Mutex<Vec<Json>>>,
}

#[async_trait]
impl BeforeRequest for ScriptedBefore {
	async fn before_request(&self) -> bool {
		self.trace.lock().unwrap().push(json!({"before": true}));
		let mut next = self.next.lock().unwrap();
		let answer = self.answers.get(*next).copied().unwrap_or(true);
		*next += 1;
		answer
	}
}

fn call_json<T>(result: Result<T, GoogleCallError>, ok: impl FnOnce(T) -> Json) -> Json {
	match result {
		Ok(value) => json!({"ok": true, "value": ok(value)}),
		Err(GoogleCallError::Aborted) => {
			json!({"ok": false, "error": {"code": "ABORTED", "upstreamStatus": null}})
		}
		Err(GoogleCallError::Failed {
			code,
			upstream_status,
		}) => {
			json!({"ok": false, "error": {"code": code.as_str(), "upstreamStatus": upstream_status}})
		}
	}
}

#[tokio::test]
async fn calendar_client_matches_typescript() {
	let file = load("calendar.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 500);
	let mut failures = Vec::new();
	for (i, case) in cases.iter().enumerate() {
		let requests = Requests::default();
		let cancel = CancellationToken::new();
		if flag(case, "abortBeforeStart") {
			cancel.cancel();
		}
		let abort_after = has(case, "abortAfterRequest")
			.and_then(Value::as_f64)
			.map(|n| n as usize);
		let token = cancel.clone();
		let http = sequential(
			field(case, "script"),
			&requests,
			Box::new(move |count| {
				if abort_after == Some(count) {
					token.cancel();
				}
			}),
		);
		let trace = Arc::new(Mutex::new(Vec::new()));
		let tokens = ScriptedTokens {
			current: Mutex::new("tok-0".to_owned()),
			refreshes: array(case, "refreshes").to_vec(),
			next: Mutex::new(0),
			trace: trace.clone(),
		};
		let before = ScriptedBefore {
			answers: array(case, "before")
				.iter()
				.map(|v| matches!(v, Value::Bool(true)))
				.collect(),
			next: Mutex::new(0),
			trace: trace.clone(),
		};
		let client = CalendarClient {
			http: &http,
			tokens: &tokens,
			before_request: &before,
			cancel: &cancel,
		};
		let mut outputs = Vec::new();
		for op in array(case, "ops") {
			let calendar = optional_text(op, "calendarId").unwrap_or("").to_owned();
			let body = || -> GoogleEventBody {
				serde_json::from_value(to_serde(field(op, "body"))).unwrap()
			};
			let out = match text(op, "name") {
				"get" => call_json(client.get_calendar(&calendar).await, |found| match found {
					Some(id) => json!({"found": true, "id": id}),
					None => json!({"found": false}),
				}),
				"create" => call_json(
					client
						.create_calendar("Earnings calendar", "d \"q\" é", "UTC")
						.await,
					|id| json!({"id": id}),
				),
				"list" => call_json(client.list_managed_events(&calendar).await, |events| {
					serde_json::to_value(events).unwrap()
				}),
				"insert" => call_json(client.insert_event(&calendar, &body()).await, |inserted| {
					if inserted {
						json!({"inserted": true})
					} else {
						json!({"inserted": false, "conflict": true})
					}
				}),
				"update" => call_json(
					client.update_event(&calendar, &body()).await,
					|()| json!({"updated": true}),
				),
				_ => call_json(
					client.delete_event(&calendar, text(op, "eventId")).await,
					|()| json!({"deleted": true}),
				),
			};
			outputs.push(out);
		}
		let actual = json!({"outputs": outputs, "trace": trace.lock().unwrap().clone()});
		check(
			&mut failures,
			format!("calendar {i} output"),
			&actual,
			field(case, "output"),
		);
		let actual_requests = Json::Array(requests.0.lock().unwrap().clone());
		check(
			&mut failures,
			format!("calendar {i} requests"),
			&actual_requests,
			field(case, "requests"),
		);
	}
	report(&failures);
}

/* ---------- token store ---------- */

fn record_json(record: &Option<GoogleTokenRecord>) -> Json {
	match record {
		None => Json::Null,
		Some(r) => json!({
			"version": 1,
			"refreshToken": r.refresh_token.expose(),
			"calendarId": r.calendar_id,
			"scope": r.scope,
			"savedAt": r.saved_at,
		}),
	}
}

#[tokio::test]
async fn token_store_matches_typescript() {
	let file = load("token_store.json");
	let dir = tempfile::tempdir().unwrap();
	let mut failures = Vec::new();
	for (i, case) in array(&file, "reads").iter().enumerate() {
		let path = dir.path().join("read.json");
		std::fs::write(&path, text(case, "text")).unwrap();
		let actual = record_json(&read_google_token_file(&path).await);
		check(
			&mut failures,
			format!("read {i}"),
			&actual,
			field(case, "output"),
		);
		let pure = record_json(&decode_token_record(text(case, "text")));
		check(
			&mut failures,
			format!("decode {i}"),
			&pure,
			field(case, "output"),
		);
	}
	let missing = record_json(&read_google_token_file(&dir.path().join("missing.json")).await);
	check(
		&mut failures,
		"missing".to_owned(),
		&missing,
		field(&file, "missing"),
	);
	std::fs::write(dir.path().join("bytes.json"), [0x7b, 0xff, 0x7d]).unwrap();
	let lossy = record_json(&read_google_token_file(&dir.path().join("bytes.json")).await);
	check(
		&mut failures,
		"lossy".to_owned(),
		&lossy,
		field(&file, "lossy"),
	);
	for (i, case) in array(&file, "writes").iter().enumerate() {
		let record = field(case, "record");
		let value = GoogleTokenRecord {
			refresh_token: Secret::new(text(record, "refreshToken")),
			calendar_id: text(record, "calendarId").to_owned(),
			scope: text(record, "scope").to_owned(),
			saved_at: text(record, "savedAt").to_owned(),
		};
		let path = dir.path().join("write.json");
		let outcome = match write_google_token_file(&path, &value).await {
			Ok(()) => {
				use std::os::unix::fs::PermissionsExt;
				let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
				let text = std::fs::read_to_string(&path).unwrap();
				let _ = std::fs::remove_file(&path);
				// The encoder is pure and must produce the same bytes.
				assert_eq!(encode_token_record(&value).unwrap(), text);
				json!({"text": text, "mode": format!("{mode:o}")})
			}
			Err(_) => json!({"failed": true}),
		};
		check(
			&mut failures,
			format!("write {i}"),
			&outcome,
			field(case, "outcome"),
		);
	}
	report(&failures);
}

/* ---------- runner flows ---------- */

struct FlowClock(AtomicI64);

impl Clock for FlowClock {
	fn now_ms(&self) -> i64 {
		self.0.load(Ordering::SeqCst)
	}
	fn now_iso(&self) -> String {
		research_js::date::epoch_ms_to_iso(self.now_ms()).unwrap()
	}
}

struct FlowShared {
	cancel: CancellationToken,
	abort_at: Option<String>,
}

impl FlowShared {
	fn abort_when(&self, place: &str) {
		if self.abort_at.as_deref() == Some(place) {
			self.cancel.cancel();
		}
	}
}

struct FlowSleeper {
	log: Arc<Mutex<Vec<i64>>>,
	timeout_fires: bool,
	pace: bool,
	clock: Arc<FlowClock>,
}

#[async_trait]
impl Sleeper for FlowSleeper {
	async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>) {
		self.log.lock().unwrap().push(ms as i64);
		if self.pace {
			self.clock.0.fetch_add(ms as i64, Ordering::SeqCst);
			return;
		}
		if ms == 300_000 && !self.timeout_fires {
			if let Some(cancel) = cancel {
				cancel.cancelled().await;
			} else {
				std::future::pending::<()>().await;
			}
		}
	}
}

struct FlowReporter {
	states: Mutex<Vec<String>>,
	shared: Arc<FlowShared>,
}

#[async_trait]
impl PipelineReporter for FlowReporter {
	async fn state(&self, state: JobState) {
		self.states.lock().unwrap().push(state.as_str().to_owned());
		self.shared.abort_when(&format!("state:{}", state.as_str()));
	}
	async fn note(&self, _: &str) {}
	async fn tool(&self, _: &str, _: ToolCallOutcome, _: &str) {}
	async fn usage(&self, _: &ResourceUsage) {}
}

#[derive(Default)]
struct FlowLogger(Mutex<Vec<Json>>);

impl FlowLogger {
	fn push(&self, level: &str, event: &str, fields: &[(&str, LogValue<'_>)]) {
		let mut map = Map::new();
		for (key, value) in fields {
			map.insert(
				(*key).to_owned(),
				match value {
					LogValue::Str(s) => Json::String(s.to_string()),
					LogValue::Int(n) => json!(n),
					LogValue::Num(n) => json!(n),
					LogValue::Bool(b) => json!(b),
					LogValue::Null => Json::Null,
				},
			);
		}
		self.0
			.lock()
			.unwrap()
			.push(json!({"level": level, "event": event, "fields": map}));
	}
}

impl EventLogger for FlowLogger {
	fn info(&self, e: &str, f: &[(&str, LogValue<'_>)]) {
		self.push("info", e, f);
	}
	fn warn(&self, e: &str, f: &[(&str, LogValue<'_>)]) {
		self.push("warn", e, f);
	}
	fn error(&self, e: &str, f: &[(&str, LogValue<'_>)]) {
		self.push("error", e, f);
	}
	fn log_failures(&self) -> u64 {
		0
	}
}

type LinkParams = Arc<Mutex<Option<Vec<(String, String)>>>>;

struct FlowHttp {
	routes: Vec<(String, Vec<Value>)>,
	index: Mutex<HashMap<String, usize>>,
	requests: Mutex<Vec<Json>>,
	url_params: LinkParams,
	shared: Arc<FlowShared>,
}

/// Masks the random PKCE verifier and loopback redirect after checking them against the link.
fn mask_body(body: Option<&str>, params: &Option<Vec<(String, String)>>) -> Json {
	use base64::Engine as _;
	use sha2::{Digest, Sha256};
	let Some(body) = body else { return Json::Null };
	if !body.contains('=') || body.starts_with('{') {
		return Json::String(body.to_owned());
	}
	let mut pairs: Vec<(String, String)> = url::form_urlencoded::parse(body.as_bytes())
		.into_owned()
		.collect();
	if let Some(link) = params {
		let get = |k: &str| {
			link.iter()
				.find(|(key, _)| key == k)
				.map(|(_, v)| v.clone())
		};
		for (key, value) in &mut pairs {
			if key == "code_verifier" {
				let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
					.encode(Sha256::digest(value.as_bytes()));
				assert_eq!(
					Some(challenge),
					get("code_challenge"),
					"verifier does not match the challenge"
				);
				"<verifier>".clone_into(value);
			}
			if key == "redirect_uri" {
				assert_eq!(Some(value.clone()), get("redirect_uri"));
				"<redirect>".clone_into(value);
			}
		}
	}
	Json::String(
		url::form_urlencoded::Serializer::new(String::new())
			.extend_pairs(pairs)
			.finish(),
	)
}

#[async_trait]
impl GoogleHttp for FlowHttp {
	async fn send(
		&self,
		request: GoogleHttpRequest<'_>,
	) -> Result<GoogleHttpResponse, GoogleHttpError> {
		let pathname = request.path.split('?').next().unwrap_or("");
		let key = format!("{} {pathname}", request.method);
		let masked = mask_body(request.body, &self.url_params.lock().unwrap());
		self.requests
			.lock()
			.unwrap()
			.push(request_json(&request, masked));
		let entry = self
			.routes
			.iter()
			.find(|(k, _)| *k == key)
			.and_then(|(_, answers)| {
				let mut index = self.index.lock().unwrap();
				let position = index.entry(key.clone()).or_insert(0);
				let chosen = answers.get((*position).min(answers.len() - 1)).cloned();
				*position += 1;
				chosen
			});
		let result = answer(entry.as_ref());
		self.shared.abort_when(&key);
		result
	}
}

struct FlowSender {
	attempts: AtomicUsize,
	deliver_after: Option<usize>,
	urls: Mutex<Vec<String>>,
	shared: Arc<FlowShared>,
}

#[async_trait]
impl GoogleAuthUrlSender for FlowSender {
	async fn send_auth_url(&self, url: &str) -> bool {
		let attempt = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
		self.urls.lock().unwrap().push(url.to_owned());
		match self.deliver_after {
			Some(failures) if attempt > failures => {
				self.shared.abort_when("authUrl");
				true
			}
			_ => false,
		}
	}
}

struct RecordingPacer {
	inner: WindowMarketPacer,
	log: Arc<Mutex<Vec<Json>>>,
}

#[async_trait]
impl MarketPacer for RecordingPacer {
	async fn pace(
		&self,
		provider: &str,
		cancel: &CancellationToken,
		requests: Option<usize>,
	) -> bool {
		let granted = self.inner.pace(provider, cancel, requests).await;
		self.log
			.lock()
			.unwrap()
			.push(json!({"provider": provider, "granted": granted}));
		granted
	}
}

fn mask_url(url: &str) -> String {
	let mut parsed = url::Url::parse(url).unwrap();
	let pairs: Vec<(String, String)> = parsed
		.query_pairs()
		.map(|(k, v)| {
			let masked = matches!(k.as_ref(), "state" | "code_challenge" | "redirect_uri");
			(
				k.to_string(),
				if masked {
					format!("<{k}>")
				} else {
					v.to_string()
				},
			)
		})
		.collect();
	parsed.query_pairs_mut().clear().extend_pairs(pairs);
	parsed.to_string()
}

/// One raw HTTP request to the loopback listener: the status, or "closed".
async fn browser_request(port: u16, method: &str, query: &str, host: &str) -> Json {
	let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
		return json!("closed");
	};
	let request =
		format!("{method} /?{query} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
	if stream.write_all(request.as_bytes()).await.is_err() {
		return json!("closed");
	}
	let mut response = Vec::new();
	let _ = stream.read_to_end(&mut response).await;
	let head = String::from_utf8_lossy(&response);
	head.split(' ')
		.nth(1)
		.and_then(|s| s.parse::<u16>().ok())
		.map_or(json!("closed"), |s| json!(s))
}

fn encode_component(text: &str) -> String {
	url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// Acts as the browser once the link is delivered.
async fn act_as_browser(
	case: &Value,
	sender: &FlowSender,
	shared: &FlowShared,
	url_params: &LinkParams,
	deliver: Option<usize>,
	log: &mut Vec<Json>,
) {
	let delivered = deliver.is_some_and(|d| sender.attempts.load(Ordering::SeqCst) > d);
	if !(delivered && !shared.cancel.is_cancelled()) {
		return;
	}
	let sent = sender.urls.lock().unwrap().last().cloned().unwrap();
	let params: Vec<(String, String)> = url::Url::parse(&sent)
		.unwrap()
		.query_pairs()
		.into_owned()
		.collect();
	*url_params.lock().unwrap() = Some(params.clone());
	let get = |k: &str| {
		params
			.iter()
			.find(|(key, _)| key == k)
			.map(|(_, v)| v.clone())
			.unwrap_or_default()
	};
	let state = get("state");
	let port: u16 = url::Url::parse(&get("redirect_uri"))
		.unwrap()
		.port()
		.unwrap();
	for request in array(field(case, "browser"), "requests") {
		let kind = text(request, "kind");
		let host = format!("127.0.0.1:{port}");
		let (method, query, host) = match kind {
			"code" => (
				"GET",
				format!(
					"code={}&state={state}",
					encode_component(text(request, "code"))
				),
				host,
			),
			"badState" => ("GET", format!("code=c&state={state}x"), host),
			"noState" => ("GET", "code=c".to_owned(), host),
			"error" => (
				"GET",
				format!(
					"error={}&state={state}",
					encode_component(text(request, "error"))
				),
				host,
			),
			"emptyCode" => ("GET", format!("code=&state={state}"), host),
			"longCode" => (
				"GET",
				format!("code={}&state={state}", "x".repeat(501)),
				host,
			),
			"post" => ("POST", format!("code=c&state={state}"), host),
			_ => (
				"GET",
				format!("code=c&state={state}"),
				"localhost".to_owned(),
			),
		};
		let status = browser_request(port, method, &query, &host).await;
		log.push(json!({"kind": kind, "status": status}));
	}
}

#[tokio::test]
async fn google_flows_match_typescript() {
	let file = load("flows.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 60);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let dir = tempfile::tempdir().unwrap();
		let token_path = dir.path().join("sub").join("google-token.json");
		if let Some(content) = optional_text(case, "tokenFile") {
			std::fs::create_dir_all(token_path.parent().unwrap()).unwrap();
			std::fs::write(&token_path, content).unwrap();
			// The TypeScript harness creates the file through the token store (0600).
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).unwrap();
		}
		if has(case, "tokenFileBlocked").and_then(Value::as_bool) == Some(true) {
			// A directory in the token file's place: writing the record fails.
			std::fs::create_dir_all(&token_path).unwrap();
		}
		let shared = Arc::new(FlowShared {
			cancel: CancellationToken::new(),
			abort_at: optional_text(case, "abortAt").map(str::to_owned),
		});
		if shared.abort_at.as_deref() == Some("before") {
			shared.cancel.cancel();
		}
		let clock = Arc::new(FlowClock(AtomicI64::new(1_792_206_000_000)));
		let google_sleeps = Arc::new(Mutex::new(Vec::new()));
		let pace_sleeps = Arc::new(Mutex::new(Vec::new()));
		let url_params: LinkParams = Arc::new(Mutex::new(None));
		let http = FlowHttp {
			routes: array(case, "routes")
				.iter()
				.map(|r| (text(r, "key").to_owned(), array(r, "answers").to_vec()))
				.collect(),
			index: Mutex::new(HashMap::new()),
			requests: Mutex::new(Vec::new()),
			url_params: url_params.clone(),
			shared: shared.clone(),
		};
		let pace_log = Arc::new(Mutex::new(Vec::new()));
		let pacer = RecordingPacer {
			inner: WindowMarketPacer::new(
				clock.clone(),
				Arc::new(FlowSleeper {
					log: pace_sleeps.clone(),
					timeout_fires: false,
					pace: true,
					clock: clock.clone(),
				}),
				HashMap::from([(
					"google".to_owned(),
					MarketRateLimit {
						max_per_window: 5,
						window_ms: 1_000,
					},
				)]),
				HashMap::new(),
			),
			log: pace_log.clone(),
		};
		let logger = FlowLogger::default();
		let client = flag(case, "clientConfigured").then(|| OAuthClient {
			client_id: "test-client-id-abc".to_owned(),
			client_secret: Secret::new("test-client-secret-xyz"),
		});
		let env = GoogleExecutionEnv {
			client: client.as_ref(),
			token_file: &token_path,
			http: &http,
			clock: clock.as_ref(),
			logger: &logger,
			pacer: &pacer,
			sleep: Arc::new(FlowSleeper {
				log: google_sleeps.clone(),
				timeout_fires: flag(case, "timeoutFires"),
				pace: false,
				clock: clock.clone(),
			}),
		};
		let reporter = FlowReporter {
			states: Mutex::new(Vec::new()),
			shared: shared.clone(),
		};
		let deliver = has(case, "deliverAfterFailures")
			.and_then(Value::as_f64)
			.map(|n| n as usize);
		let sender = FlowSender {
			attempts: AtomicUsize::new(0),
			deliver_after: deliver,
			urls: Mutex::new(Vec::new()),
			shared: shared.clone(),
		};
		let job_json = field(case, "job");
		let job = research_contracts::jobs::GoogleCalendarJob {
			lease: research_contracts::jobs::Lease {
				run_id: text(job_json, "runId").to_owned(),
				lease_generation: number(job_json, "leaseGeneration") as u64,
				lease_expires_at: text(job_json, "leaseExpiresAt").to_owned(),
				attempt: 1,
				heartbeat_interval_ms: 20_000,
				sources: Vec::new(),
			},
			action: research_contracts::google_calendar::GoogleCalendarAction::from_str_value(
				text(job_json, "action"),
			)
			.unwrap(),
			calendar_id: match has(job_json, "calendarId") {
				None => research_contracts::Tri::Absent,
				Some(Value::Null) => research_contracts::Tri::Null,
				Some(v) => research_contracts::Tri::Value(v.as_str().unwrap().to_owned()),
			},
			desired_digest: optional_text(job_json, "desiredDigest").map(str::to_owned),
			events: has(job_json, "events").map(|v| {
				v.as_array()
					.unwrap()
					.iter()
					.map(|e| serde_json::from_value(to_serde(e)).unwrap())
					.collect()
			}),
		};
		let action = text(case, "action");
		let run = async {
			if action == "discard" {
				discard_stored_google_grant(&env, "run_google")
					.await
					.unwrap();
				None
			} else {
				// A fault that escapes is part of the contract (a failed token write).
				Some(
					execute_google_calendar(&job, &env, &shared.cancel, &reporter, &sender)
						.await
						.map_err(|_| ()),
				)
			}
		};
		tokio::pin!(run);
		let mut browser_log = Vec::new();
		let browses = action == "connect"
			&& field(case, "browser")
				.as_object()
				.and_then(|b| b.get("kind"))
				.and_then(Value::as_str)
				== Some("callbacks");
		let completion = if browses {
			let mut browsed = false;
			loop {
				tokio::select! {
					result = &mut run => break result,
					() = tokio::time::sleep(std::time::Duration::from_millis(5)), if !browsed => {
						let delivered = deliver.is_some_and(|d| sender.attempts.load(Ordering::SeqCst) > d);
						if delivered || shared.cancel.is_cancelled() {
							browsed = true;
							act_as_browser(case, &sender, &shared, &url_params, deliver, &mut browser_log).await;
						}
					}
				}
			}
		} else {
			(&mut run).await
		};
		let token_file = std::fs::read_to_string(&token_path).ok().map(|text| {
			use std::os::unix::fs::PermissionsExt;
			let mode = std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777;
			json!({"text": text, "mode": format!("{mode:o}")})
		});
		let urls = sender.urls.lock().unwrap().clone();
		let actual = json!({
			"completion": match &completion {
				None => Json::Null,
				Some(Ok(c)) => serde_json::to_value(c).unwrap(),
				Some(Err(())) => json!({"threw": true}),
			},
			"states": reporter.states.lock().unwrap().clone(),
			"logs": logger.0.lock().unwrap().clone(),
			"requests": http.requests.lock().unwrap().clone(),
			"sentUrls": urls.iter().map(|u| mask_url(u)).collect::<Vec<_>>(),
			"signIn": urls.first().map(|u| is_google_sign_in_url(u)),
			"attempts": sender.attempts.load(Ordering::SeqCst),
			"browser": browser_log,
			"googleSleeps": google_sleeps.lock().unwrap().clone(),
			"paceSleeps": pace_sleeps.lock().unwrap().clone(),
			"paceCalls": pace_log.lock().unwrap().clone(),
			"tokenFile": token_file,
		});
		check(
			&mut failures,
			format!("flow {index} ({action})"),
			&actual,
			field(case, "output"),
		);
	}
	report(&failures);
}
