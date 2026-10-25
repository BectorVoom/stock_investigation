//! Replays `vectors/net/*.json` (written by Node from the TypeScript:
//! `node scripts/vectors/index.ts net`).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use research_application::ports::{
	ArchivedPage, Hasher, OmittedCounts, RedirectAuthorizer, SafeBinaryFetcher, SafeFetchOptions,
	SafeFetcher,
};
use research_net::archive::prepare;
use research_net::core::{
	BodyError, HopBody, HopOutcome, HopRequest, HopResponse, HopTransport, SafeFetchCore,
};
use research_net::is_same_ip_address;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn vector_file(name: &str) -> String {
	let path = format!("{}/../../vectors/net/{name}", env!("CARGO_MANIFEST_DIR"));
	std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[derive(Deserialize)]
struct Case<I, O> {
	input: I,
	output: O,
}

#[test]
fn text_decoder_matches_node() {
	let cases: Vec<Case<String, String>> =
		serde_json::from_str(&vector_file("text-decoder.json")).unwrap();
	assert!(cases.len() > 3_000);
	for case in &cases {
		let bytes = hex::decode(&case.input).unwrap();
		assert_eq!(
			research_js::text_decoder::decode_utf8(&bytes),
			case.output,
			"{}",
			case.input
		);
		assert_eq!(
			research_js::text_decoder::decode_utf8_owned(bytes),
			case.output
		);
	}
}

#[derive(Deserialize)]
struct SameIp {
	actual: Option<String>,
	expected: String,
}

#[test]
fn same_ip_address_matches_typescript() {
	let cases: Vec<Case<SameIp, bool>> =
		serde_json::from_str(&vector_file("same-ip.json")).unwrap();
	for case in &cases {
		assert_eq!(
			is_same_ip_address(case.input.actual.as_deref(), &case.input.expected),
			case.output,
			"{:?} vs {}",
			case.input.actual,
			case.input.expected
		);
	}
}

/* ---------- page archive ---------- */

struct Sha256Hasher;

impl Hasher for Sha256Hasher {
	fn sha256_hex(&self, text: &str) -> String {
		hex::encode(Sha256::digest(text.as_bytes()))
	}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OmittedInput {
	boilerplate_blocks: u32,
	menu_lists: u32,
	leading_blocks: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInput {
	source_url: String,
	final_url: String,
	title: Option<String>,
	retrieved_at: String,
	markdown: String,
	omitted: Option<OmittedInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedOutput {
	file_name: String,
	content: String,
}

#[test]
fn page_archive_names_and_bytes_match_typescript() {
	let cases: Vec<Case<PageInput, SavedOutput>> =
		serde_json::from_str(&vector_file("page-archive.json")).unwrap();
	assert!(cases.len() > 100);
	for case in cases {
		let page = ArchivedPage {
			source_url: case.input.source_url,
			final_url: case.input.final_url,
			title: case.input.title,
			retrieved_at: case.input.retrieved_at,
			markdown: case.input.markdown,
			omitted: case.input.omitted.map(|omitted| OmittedCounts {
				boilerplate_blocks: omitted.boilerplate_blocks,
				menu_lists: omitted.menu_lists,
				leading_blocks: omitted.leading_blocks,
			}),
		};
		let (file_name, content) = prepare(&page, &Sha256Hasher);
		assert_eq!(file_name, case.output.file_name, "{}", page.final_url);
		assert_eq!(content, case.output.content, "{}", page.final_url);
	}
}

/* ---------- hop core over the recorded script ---------- */

#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Scripted {
	#[serde(rename_all = "camelCase")]
	Response {
		status: u16,
		location: Option<String>,
		content_type: Option<String>,
		content_length: Option<u64>,
		chunks: Vec<String>,
		body_error: Option<String>,
	},
	UnsafeDestination {
		detail: String,
	},
	NetworkError {
		detail: String,
	},
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Answer {
	Allow(bool),
	Throw(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HopOptions {
	max_bytes: usize,
	timeout_ms: u64,
	accept: String,
	allowed_hosts: Option<Vec<String>>,
	user_agent: Option<String>,
	authorization: Option<String>,
	finnhub_token: Option<String>,
	include_error_body: bool,
	authorize: Option<Vec<Answer>>,
}

#[derive(Deserialize)]
struct HopInput {
	url: String,
	binary: bool,
	options: HopOptions,
	script: HashMap<String, Scripted>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HopOutput {
	requests: Vec<Value>,
	authorize_calls: Vec<String>,
	result: Value,
}

struct Transport {
	script: HashMap<String, Scripted>,
	requests: Mutex<Vec<Value>>,
}

struct Body {
	chunks: std::vec::IntoIter<Bytes>,
	error: Option<BodyError>,
}

#[async_trait]
impl HopBody for Body {
	async fn next_chunk(&mut self) -> Option<Result<Bytes, BodyError>> {
		match self.chunks.next() {
			Some(chunk) => Some(Ok(chunk)),
			None => self.error.take().map(Err),
		}
	}
}

#[async_trait]
impl HopTransport for Transport {
	async fn hop(&self, request: HopRequest<'_>) -> HopOutcome {
		self.requests.lock().unwrap().push(json!({
			"url": request.url.as_str(),
			"hostname": request.hostname,
			"accept": request.headers.accept,
			"userAgent": request.headers.user_agent,
			"authorization": request.headers.authorization,
			"finnhubToken": request.headers.finnhub_token,
			"maxBytes": request.max_bytes,
		}));
		match self.script.get(request.url.as_str()).cloned() {
			None => HopOutcome::NetworkError {
				detail: "unscripted".to_owned(),
			},
			Some(Scripted::UnsafeDestination { detail }) => {
				HopOutcome::UnsafeDestination { detail }
			}
			Some(Scripted::NetworkError { detail }) => HopOutcome::NetworkError { detail },
			Some(Scripted::Response {
				status,
				location,
				content_type,
				content_length,
				chunks,
				body_error,
			}) => HopOutcome::Response(HopResponse {
				status,
				location,
				content_type,
				content_length,
				body: Box::new(Body {
					chunks: chunks
						.iter()
						.map(|chunk| Bytes::from(hex::decode(chunk).unwrap()))
						.collect::<Vec<_>>()
						.into_iter(),
					error: body_error.map(|error| {
						if error == "too-large" {
							BodyError::TooLarge
						} else {
							BodyError::Failed(error)
						}
					}),
				}),
			}),
		}
	}
}

struct Authorizer {
	answers: Vec<Option<bool>>,
	calls: Mutex<Vec<String>>,
}

#[async_trait]
impl RedirectAuthorizer for Authorizer {
	async fn authorize(&self, url: &str) -> bool {
		let index = {
			let mut calls = self.calls.lock().unwrap();
			calls.push(url.to_owned());
			calls.len() - 1
		};
		match self.answers.get(index).copied().flatten() {
			Some(answer) => answer,
			// The TypeScript's throw (a refusal) is a panic here.
			None if index < self.answers.len() => panic!("authorizer failure"),
			None => false,
		}
	}
}

#[tokio::test]
async fn hop_core_matches_typescript() {
	let cases: Vec<Case<HopInput, HopOutput>> =
		serde_json::from_str(&vector_file("hop-core.json")).unwrap();
	assert!(cases.len() > 2_500);
	for case in cases {
		let input = case.input;
		let authorizer = input.options.authorize.map(|answers| {
			Arc::new(Authorizer {
				answers: answers
					.into_iter()
					.map(|answer| match answer {
						Answer::Allow(allow) => Some(allow),
						Answer::Throw(_) => None,
					})
					.collect(),
				calls: Mutex::new(Vec::new()),
			})
		});
		let options = SafeFetchOptions {
			max_bytes: input.options.max_bytes,
			timeout_ms: input.options.timeout_ms,
			accept: input.options.accept,
			cancel: None,
			allowed_hosts: input
				.options
				.allowed_hosts
				.map(|hosts| hosts.into_iter().collect()),
			authorize_redirect: authorizer
				.clone()
				.map(|authorizer| authorizer as Arc<dyn RedirectAuthorizer>),
			user_agent: input.options.user_agent,
			authorization: input.options.authorization,
			finnhub_token: input.options.finnhub_token,
			include_error_body: input.options.include_error_body,
			json_body: None,
		};
		let transport = Arc::new(Transport {
			script: input.script,
			requests: Mutex::new(Vec::new()),
		});
		let fetcher = SafeFetchCore::new(Arc::clone(&transport));
		let result = if input.binary {
			match fetcher.fetch_bytes(&input.url, &options).await {
				Ok(document) => json!({
					"ok": true,
					"finalUrl": document.final_url,
					"contentType": document.content_type,
					"bytes": hex::encode(document.bytes),
				}),
				Err(error) => failure_json(&error),
			}
		} else {
			match fetcher.fetch_text(&input.url, &options).await {
				Ok(document) => json!({
					"ok": true,
					"finalUrl": document.final_url,
					"contentType": document.content_type,
					"text": document.text,
				}),
				Err(error) => failure_json(&error),
			}
		};
		let label = &input.url;
		assert_eq!(result, case.output.result, "result of {label}");
		assert_eq!(
			*transport.requests.lock().unwrap(),
			case.output.requests,
			"requests of {label}"
		);
		let calls = authorizer.map(|authorizer| authorizer.calls.lock().unwrap().clone());
		assert_eq!(
			calls.unwrap_or_default(),
			case.output.authorize_calls,
			"authorizer of {label}"
		);
	}
}

fn failure_json(error: &research_application::ports::SafeFetchError) -> Value {
	let mut value = json!({ "ok": false, "code": error.code.as_str(), "detail": error.detail });
	if let Some(body) = &error.body {
		value["body"] = json!(body);
	}
	value
}

/* ---------- content decoding (Node's zlib / brotli) ---------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecodeInput {
	encoding: String,
	chunks: Vec<String>,
	max_bytes: usize,
}

/// Reads the real pinned body as `readBounded` does: decoded bytes over the
/// cap, or the transport's wire-cap error, are "too large".
async fn read_decoded(input: &DecodeInput, max_bytes: usize) -> Value {
	let frames = input
		.chunks
		.iter()
		.map(|chunk| Bytes::from(hex::decode(chunk).unwrap()))
		.collect();
	let mut body =
		research_net::pinned::decoded_body_from_frames(Some(&input.encoding), frames, max_bytes)
			.unwrap();
	let mut bytes = Vec::new();
	while let Some(chunk) = body.next_chunk().await {
		match chunk {
			Ok(chunk) => {
				if bytes.len() + chunk.len() > max_bytes {
					return json!({ "tooLarge": true });
				}
				bytes.extend_from_slice(&chunk);
			}
			Err(BodyError::TooLarge) => return json!({ "tooLarge": true }),
			Err(BodyError::Failed(code)) => return json!({ "error": code }),
		}
	}
	if bytes.len() <= 2_048 {
		json!({ "ok": hex::encode(&bytes) })
	} else {
		json!({ "okLength": bytes.len(), "okSha256": hex::encode(Sha256::digest(&bytes)) })
	}
}

/// brotli-decompressor lacks C brotli's METABLOCK_DONE length check, so a
/// corrupt stream can fail with the other BLOCK_LENGTH name (see decode.rs).
fn brotli_block_length_name(rust: &Value, node: &Value) -> bool {
	let name = |value: &Value| {
		value
			.get("error")
			.and_then(Value::as_str)
			.map(str::to_owned)
	};
	matches!(
		(name(rust), name(node)),
		(Some(a), Some(b)) if a.starts_with("ERR__ERROR_FORMAT_BLOCK_LENGTH_")
			&& b.starts_with("ERR__ERROR_FORMAT_BLOCK_LENGTH_")
	)
}

/// Node's own result for a few inputs depends on WHEN data reaches its
/// stream machinery, not on the bytes: `Readable.from(boundedWireBytes(…))`
/// checks the wire cap as chunks arrive (ahead of decoding), and a decoder
/// error destroys the stream together with output not yet read. The
/// exporter feeds everything at once; a socket feeds it over time, where the
/// TypeScript gives the answer Rust gives. Accepted only in two shapes:
/// - Node "too large" while the wire itself exceeds the cap (the eager wire
///   check pre-empted a later decode error or an early end);
/// - Rust "too large" while Node reports the error the stream really has
///   (Rust without a cap reports the same code): both are failures; which
///   one surfaces is the race.
async fn arrival_order_race(input: &DecodeInput, rust: &Value, node: &Value) -> bool {
	let wire: usize = input.chunks.iter().map(|chunk| chunk.len() / 2).sum();
	let too_large = json!({ "tooLarge": true });
	if *node == too_large && *rust != too_large {
		return wire > input.max_bytes;
	}
	if *rust == too_large && node.get("error").is_some() {
		return read_decoded(input, usize::MAX).await == *node;
	}
	false
}

#[tokio::test]
async fn content_decoding_matches_node_zlib_and_brotli() {
	let cases: Vec<Case<DecodeInput, Value>> =
		serde_json::from_str(&vector_file("decode.json")).unwrap();
	assert!(cases.len() >= 1_500);
	let mut mismatches = Vec::new();
	let mut races = 0;
	for (index, case) in cases.iter().enumerate() {
		let actual = read_decoded(&case.input, case.input.max_bytes).await;
		if actual == case.output {
			continue;
		}
		if brotli_block_length_name(&actual, &case.output) {
			continue;
		}
		if arrival_order_race(&case.input, &actual, &case.output).await {
			races += 1;
			continue;
		}
		mismatches.push(format!(
			"#{index} {} chunks={} max={}: rust {actual} node {}",
			case.input.encoding,
			case.input.chunks.len(),
			case.input.max_bytes,
			case.output
		));
	}
	assert!(
		mismatches.is_empty(),
		"{} mismatches:\n{}",
		mismatches.len(),
		mismatches.join("\n")
	);
	// Races are corner cases (a cap and a broken stream at once), not the norm.
	assert!(races * 50 < cases.len(), "{races} arrival-order races");
}
