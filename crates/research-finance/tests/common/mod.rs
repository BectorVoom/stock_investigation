//! Helpers shared by the vector replays: vector loading, JSON navigation,
//! the scripted fetcher with its call log, and the comparison normaliser.
#![allow(
	dead_code,
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine as _;
use research_application::ports::{
	BinaryDocument, FetchedDocument, SafeBinaryFetcher, SafeFetchError, SafeFetchErrorCode,
	SafeFetchOptions, SafeFetcher,
};
use research_js::json::Value;
use serde_json::{Map, Number, Value as Json, json};

/// Parses `vectors/finance/<name>` with JavaScript's `JSON.parse` semantics.
pub(crate) fn load(name: &str) -> Value {
	let path = format!(
		"{}/../../vectors/finance/{name}",
		env!("CARGO_MANIFEST_DIR")
	);
	let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
	research_js::json::parse(&text).unwrap_or_else(|error| panic!("{path}: {error}"))
}

pub(crate) fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
	value
		.as_object()
		.and_then(|object| object.get(key))
		.unwrap_or_else(|| panic!("missing field {key}"))
}

pub(crate) fn has<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
	value.as_object().and_then(|object| object.get(key))
}

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
	field(value, key)
		.as_str()
		.unwrap_or_else(|| panic!("field {key} is not a string"))
}

pub(crate) fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	match has(value, key) {
		Some(Value::Null) | None => None,
		Some(other) => Some(
			other
				.as_str()
				.unwrap_or_else(|| panic!("{key} not a string")),
		),
	}
}

pub(crate) fn number(value: &Value, key: &str) -> f64 {
	field(value, key)
		.as_f64()
		.unwrap_or_else(|| panic!("field {key} is not a number"))
}

pub(crate) fn flag(value: &Value, key: &str) -> bool {
	field(value, key)
		.as_bool()
		.unwrap_or_else(|| panic!("field {key} is not a boolean"))
}

pub(crate) fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
	field(value, key)
		.as_array()
		.unwrap_or_else(|| panic!("field {key} is not an array"))
}

pub(crate) fn double_bits(value: f64) -> String {
	format!("{:016x}", value.to_bits())
}

pub(crate) fn report(failures: &[String]) {
	assert!(
		failures.is_empty(),
		"{} mismatches, first: {:#?}",
		failures.len(),
		failures.iter().take(5).collect::<Vec<_>>()
	);
}

pub(crate) fn error_code(text: &str) -> SafeFetchErrorCode {
	match text {
		"UNSAFE_URL" => SafeFetchErrorCode::UnsafeUrl,
		"HOST_NOT_ALLOWED" => SafeFetchErrorCode::HostNotAllowed,
		"UNSAFE_REDIRECT" => SafeFetchErrorCode::UnsafeRedirect,
		"TOO_MANY_REDIRECTS" => SafeFetchErrorCode::TooManyRedirects,
		"REDIRECT_NOT_AUTHORIZED" => SafeFetchErrorCode::RedirectNotAuthorized,
		"TIMEOUT" => SafeFetchErrorCode::Timeout,
		"HTTP_ERROR" => SafeFetchErrorCode::HttpError,
		"RESPONSE_TOO_LARGE" => SafeFetchErrorCode::ResponseTooLarge,
		"NETWORK_ERROR" => SafeFetchErrorCode::NetworkError,
		other => panic!("unknown fetch error code {other}"),
	}
}

/// A JavaScript JSON value as `serde_json` (numbers as doubles).
pub(crate) fn js_to_serde(value: &Value) -> Json {
	match value {
		Value::Null => Json::Null,
		Value::Bool(flag) => Json::Bool(*flag),
		Value::Number(number) => Number::from_f64(*number).map_or(Json::Null, Json::Number),
		Value::String(text) => Json::String(text.clone()),
		Value::Array(items) => Json::Array(items.iter().map(js_to_serde).collect()),
		Value::Object(object) => {
			let mut map = Map::new();
			for (key, item) in object.iter() {
				map.insert(key.to_owned(), js_to_serde(item));
			}
			Json::Object(map)
		}
	}
}

pub(crate) fn value_to_serde(value: &Value) -> Json {
	js_to_serde(value)
}

/// Every number as a double (`1` and `1.0` compare equal; `-0` equals `0`).
pub(crate) fn norm(value: &Json) -> Json {
	match value {
		Json::Number(number) => {
			let double = number.as_f64().unwrap_or(f64::NAN);
			if double == 0.0 && double.is_sign_negative() {
				Json::String(NEGATIVE_ZERO.to_owned())
			} else {
				Number::from_f64(double).map_or(Json::Null, Json::Number)
			}
		}
		Json::Array(items) => Json::Array(items.iter().map(norm).collect()),
		Json::Object(map) => Json::Object(map.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
		other => other.clone(),
	}
}

/// The ordered record of calls made to the doubles of one case.
#[derive(Clone, Default)]
pub(crate) struct EventLog(Arc<Mutex<Vec<Json>>>);

impl EventLog {
	pub(crate) fn push(&self, event: Json) {
		self.0.lock().unwrap().push(event);
	}

	pub(crate) fn snapshot(&self) -> Json {
		Json::Array(self.0.lock().unwrap().clone())
	}
}

enum Entry {
	Text {
		text: String,
		content_type: Option<String>,
		final_url: Option<String>,
	},
	Bytes {
		bytes: Vec<u8>,
		content_type: Option<String>,
		final_url: Option<String>,
	},
	Error(SafeFetchError),
}

/// Answers the n-th call with the n-th entry; refuses hosts outside
/// `allowed_hosts`; 404 once the script is exhausted (the TypeScript double).
pub(crate) struct Scripted {
	entries: Vec<Entry>,
	next: Mutex<usize>,
	log: EventLog,
}

impl Scripted {
	pub(crate) fn new(script: &Value, log: &EventLog) -> Self {
		let entries = script
			.as_array()
			.unwrap()
			.iter()
			.map(|entry| {
				if let Some(error) = has(entry, "error") {
					return Entry::Error(SafeFetchError {
						code: error_code(text(error, "code")),
						detail: text(error, "detail").to_owned(),
						body: optional_text(error, "body").map(str::to_owned),
					});
				}
				let content_type = optional_text(entry, "contentType").map(str::to_owned);
				let final_url = optional_text(entry, "finalUrl").map(str::to_owned);
				if let Some(bytes) = has(entry, "bytes") {
					let bytes = base64::engine::general_purpose::STANDARD
						.decode(bytes.as_str().unwrap())
						.unwrap();
					Entry::Bytes {
						bytes,
						content_type,
						final_url,
					}
				} else {
					Entry::Text {
						text: text(entry, "text").to_owned(),
						content_type,
						final_url,
					}
				}
			})
			.collect();
		Self {
			entries,
			next: Mutex::new(0),
			log: log.clone(),
		}
	}

	fn take(&self, url: &str, options: &SafeFetchOptions) -> Result<&Entry, SafeFetchError> {
		let hosts = options
			.allowed_hosts
			.as_ref()
			.map(|hosts| hosts.iter().cloned().collect::<Vec<_>>());
		self.log.push(json!({"fetch": {
			"url": url,
			"accept": options.accept,
			"maxBytes": options.max_bytes,
			"timeoutMs": options.timeout_ms,
			"allowedHosts": hosts,
			"userAgent": options.user_agent,
			"authorization": options.authorization,
			"finnhubToken": options.finnhub_token,
			"includeErrorBody": options.include_error_body,
			"hasSignal": options.cancel.is_some(),
		}}));
		let host = url::Url::parse(url).unwrap().host_str().unwrap().to_owned();
		if options
			.allowed_hosts
			.as_ref()
			.is_some_and(|hosts| !hosts.contains(&host))
		{
			return Err(SafeFetchError {
				code: SafeFetchErrorCode::HostNotAllowed,
				detail: "host is not on the allowlist".to_owned(),
				body: None,
			});
		}
		let mut next = self.next.lock().unwrap();
		let entry = self.entries.get(*next);
		*next += 1;
		entry.ok_or_else(|| SafeFetchError {
			code: SafeFetchErrorCode::HttpError,
			detail: "HTTP 404".to_owned(),
			body: None,
		})
	}
}

#[async_trait]
impl SafeFetcher for Scripted {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		match self.take(url, options)? {
			Entry::Error(error) => Err(error.clone()),
			Entry::Bytes { .. } => Err(SafeFetchError {
				code: SafeFetchErrorCode::NetworkError,
				detail: "binary entry for text".to_owned(),
				body: None,
			}),
			Entry::Text {
				text,
				content_type,
				final_url,
			} => Ok(FetchedDocument {
				final_url: final_url.clone().unwrap_or_else(|| url.to_owned()),
				content_type: content_type.clone(),
				text: text.clone(),
			}),
		}
	}
}

#[async_trait]
impl SafeBinaryFetcher for Scripted {
	async fn fetch_bytes(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<BinaryDocument, SafeFetchError> {
		match self.take(url, options)? {
			Entry::Error(error) => Err(error.clone()),
			Entry::Text { .. } => Err(SafeFetchError {
				code: SafeFetchErrorCode::NetworkError,
				detail: "text entry for bytes".to_owned(),
				body: None,
			}),
			Entry::Bytes {
				bytes,
				content_type,
				final_url,
			} => Ok(BinaryDocument {
				final_url: final_url.clone().unwrap_or_else(|| url.to_owned()),
				content_type: content_type.clone(),
				bytes: bytes.clone(),
			}),
		}
	}
}

/// A fetch error as the exporters record it (`body` only when present).
pub(crate) fn error_json(error: &SafeFetchError) -> Json {
	let mut value = json!({"code": error.code.as_str(), "detail": error.detail});
	if let Some(body) = &error.body {
		value["body"] = Json::String(body.clone());
	}
	value
}

/// The marker the exporters write for a negative zero (JSON text cannot).
const NEGATIVE_ZERO: &str = "-0(neg)";

/// JSON with sorted keys and JavaScript number text (the exporter's `canonicalJson`).
fn canonical_json(value: &Json, out: &mut String) {
	match value {
		Json::Null => out.push_str("null"),
		Json::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
		Json::Number(number) => out.push_str(&research_js::number::to_js_string(
			number.as_f64().unwrap_or(f64::NAN),
		)),
		Json::String(text) => out.push_str(&research_js::json_text::quote(text)),
		Json::Array(items) => {
			out.push('[');
			for (index, item) in items.iter().enumerate() {
				if index > 0 {
					out.push(',');
				}
				canonical_json(item, out);
			}
			out.push(']');
		}
		Json::Object(map) => {
			out.push('{');
			for (index, (key, item)) in map.iter().enumerate() {
				if index > 0 {
					out.push(',');
				}
				out.push_str(&research_js::json_text::quote(key));
				out.push(':');
				canonical_json(item, out);
			}
			out.push('}');
		}
	}
}

/// SHA-256 (hex) of the canonical form, as the exporter's `digestOf` takes it.
pub(crate) fn digest_of(value: &Json) -> String {
	use sha2::{Digest, Sha256};
	let mut text = String::new();
	canonical_json(&norm(value), &mut text);
	hex::encode(Sha256::digest(text.as_bytes()))
}
