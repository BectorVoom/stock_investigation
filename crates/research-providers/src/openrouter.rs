//! OpenRouter SSE, bounded rejection retries, idle watch and free-cost enforcement.
use crate::{
	cli_probe::unavailable, environment::*, http::*, lines::*, openrouter_models::*, schema::*,
	turn::*,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use research_agent_core::runtime::*;
use research_contracts::agent::*;
use research_js::{
	json::{self, Object, Value},
	utf16::utf16_len,
	whitespace::trim,
};
use std::{collections::BTreeMap, time::Duration};

/// No headers/body progress for two minutes ends the turn.
pub const IDLE_TIMEOUT_MS: u64 = 120000;
/// Classification of one SSE line; missing cost differs from explicit null.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SseVerdict {
	/// Comment or non-data field.
	Ignored,
	/// Invalid JSON or chunk schema.
	Malformed,
	/// `[DONE]`.
	Done,
	/// Explicit upstream error.
	Failed {
		/// Stable error.
		failure: ProviderFailure,
	},
	/// A chunk, including an empty role-only chunk.
	#[serde(rename_all = "camelCase")]
	Chunk {
		/// Model text.
		text: String,
		/// A string finish reason was present.
		finished: bool,
		/// Output token cap was reached.
		truncated: bool,
		/// None = absent usage; Some(None) = unknown cost.
		#[serde(skip_serializing_if = "Option::is_none")]
		known_cost_usd: Option<Option<f64>>,
	},
}
fn nullable_string<'a>(obj: &'a Object, key: &str) -> Result<Option<&'a str>, Malformed> {
	match obj.get(key) {
		None | Some(Value::Null) => Ok(None),
		Some(v) => v.as_str().map(Some).ok_or(Malformed),
	}
}
fn interpret_payload(value: &Value) -> Result<SseVerdict, Malformed> {
	let chunk = object(value)?;
	let error = optional_object(chunk, "error")?;
	if let Some(error) = error {
		if let Some(code) = error.get("code") {
			if code.as_str().is_none() && code.as_f64().is_none_or(|n| !n.is_finite()) {
				return Err(Malformed);
			}
		}
	}
	let mut first = None;
	if let Some(choices) = chunk.get("choices") {
		for (index, choice) in choices.as_array().ok_or(Malformed)?.iter().enumerate() {
			let choice = object(choice)?;
			let delta = optional_object(choice, "delta")?;
			let reason = nullable_string(choice, "finish_reason")?;
			let text = delta
				.map(|d| nullable_string(d, "content"))
				.transpose()?
				.flatten()
				.unwrap_or("");
			if index == 0 {
				first = Some((text, reason));
			}
		}
	}
	let cost = match chunk.get("usage") {
		None | Some(Value::Null) => None,
		Some(value) => {
			let usage = object(value)?;
			let cost = match usage.get("cost") {
				None | Some(Value::Null) => None,
				Some(v) => Some(v.as_f64().filter(|n| n.is_finite()).ok_or(Malformed)?),
			};
			Some(as_known_cost_usd(cost))
		}
	};
	if let Some(error) = error {
		return Ok(SseVerdict::Failed {
			failure: failure_for_hint(
				error
					.get("code")
					.and_then(Value::as_f64)
					.and_then(hint_from_http_status)
					.unwrap_or(FailureHint::Unavailable),
			),
		});
	}
	let (text, reason) = first.unwrap_or(("", None));
	if reason == Some("error") {
		return Ok(SseVerdict::Failed {
			failure: ProviderFailure::new("PROVIDER_UNAVAILABLE"),
		});
	}
	Ok(SseVerdict::Chunk {
		text: text.to_owned(),
		finished: reason.is_some(),
		truncated: reason == Some("length"),
		known_cost_usd: cost,
	})
}
/// Interprets `data:` with optional space, JS trim, and strict optional-field types.
pub fn interpret_sse_line(line: &str) -> SseVerdict {
	let Some(payload) = line.strip_prefix("data:") else {
		return SseVerdict::Ignored;
	};
	let payload = trim(payload);
	if payload == "[DONE]" {
		return SseVerdict::Done;
	}
	json::parse(payload)
		.map_err(|_| Malformed)
		.and_then(|v| interpret_payload(&v))
		.unwrap_or(SseVerdict::Malformed)
}
/// Rejected HTTP status mapping, distinct from SSE error status mapping.
pub fn failure_for_http_status(status: u16) -> ProviderFailure {
	if status == 408 {
		ProviderFailure::new("PROVIDER_TIMEOUT")
	} else {
		hint_from_http_status(f64::from(status)).map_or_else(
			|| ProviderFailure::new("PROVIDER_REQUEST_REJECTED"),
			failure_for_hint,
		)
	}
}
/// Only a rejection before any SSE chunk may be retried.
pub fn is_transient_rejection(failure: &ProviderFailure) -> bool {
	matches!(
		failure.code.as_str(),
		"PROVIDER_UNAVAILABLE" | "PROVIDER_RATE_LIMITED"
	)
}
/// Three exponential waits, bounded by header delay and deadline reserve.
pub fn rejection_retry_delay_ms(
	index: u32,
	retry_after: Option<f64>,
	remaining: f64,
) -> Option<f64> {
	if index >= 3 {
		return None;
	}
	let delay = retry_after.unwrap_or(2000.0 * 2.0_f64.powf(f64::from(index)));
	if delay > 30000.0 || remaining - delay < 30000.0 {
		None
	} else {
		Some(delay)
	}
}
/// Huge digit strings remain infinite/huge and therefore suppress retry.
pub fn parse_retry_after_ms(value: Option<&str>, now: f64) -> Option<f64> {
	let value = trim(value?);
	if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
		return Some(value.parse::<f64>().unwrap_or(f64::INFINITY) * 1000.0);
	}
	let bytes = value.as_bytes();
	if !bytes
		.get(..3)
		.is_some_and(|b| b.iter().all(u8::is_ascii_alphabetic))
		|| bytes.get(3..5) != Some(b", ")
	{
		return None;
	}
	let at = research_js::date::parse(value);
	if at.is_finite() {
		Some((at - now).max(0.0))
	} else {
		None
	}
}
fn object_fields(fields: Vec<(&str, Value)>) -> Value {
	Value::Object(Object::from_members(
		fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
	))
}
/// Exact key order and fixed output token cap (ADR-0029).
pub fn build_request_body(model: &str, prompt: &str, effort: Effort) -> String {
	json::stringify(&object_fields(vec![
		("model", model.into()),
		(
			"messages",
			Value::Array(vec![object_fields(vec![
				("role", "user".into()),
				("content", prompt.into()),
			])]),
		),
		("stream", true.into()),
		("max_completion_tokens", 8192.0.into()),
		("usage", object_fields(vec![("include", true.into())])),
		(
			"reasoning",
			object_fields(vec![("effort", effort.as_str().into())]),
		),
	]))
}
fn read_key(env: &Environment) -> Option<String> {
	let key = trim(env.get("OPENROUTER_API_KEY")?);
	if (8..=512).contains(&key.len()) && key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
		Some(key.to_owned())
	} else {
		None
	}
}
#[derive(Default)]
struct AttemptState {
	saw_chunk: bool,
	saw_end: bool,
	truncated: bool,
	malformed: usize,
	emitted: usize,
	cost: Option<f64>,
	failure: Option<ProviderFailure>,
	rejected: Option<ProviderFailure>,
	charged: bool,
}
impl AttemptState {
	async fn line(&mut self, line: &str, free: bool, sender: &TurnSender) -> bool {
		match interpret_sse_line(line) {
			SseVerdict::Ignored => {}
			SseVerdict::Malformed => {
				self.malformed += 1;
				if self.malformed > MAX_MALFORMED_LINES {
					self.failure = Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID"));
					return false;
				}
			}
			SseVerdict::Done => {
				self.saw_end = true;
				return false;
			}
			SseVerdict::Failed { failure } => {
				if self.saw_chunk {
					self.failure = Some(failure);
				} else {
					self.rejected = Some(failure);
				}
				return false;
			}
			SseVerdict::Chunk {
				text,
				finished,
				truncated,
				known_cost_usd,
			} => {
				self.saw_chunk = true;
				if let Some(cost) = known_cost_usd {
					self.cost = cost;
				}
				if free && self.cost.is_some_and(|c| c > 0.0) {
					self.charged = true;
					return false;
				}
				self.saw_end |= finished;
				self.truncated |= truncated;
				if !text.is_empty() {
					self.emitted += utf16_len(&text);
					if self.emitted > MAX_OUTPUT_TEXT_CHARS {
						self.failure = Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"));
						return false;
					}
					if !sender.send(AgentEvent::TextDelta { text }).await {
						return false;
					}
				}
			}
		}
		true
	}
}
struct Rejected {
	failure: ProviderFailure,
	retry_after: Option<f64>,
	usage: bool,
}
async fn send_end(sender: &TurnSender, cost: Option<f64>, failure: Option<ProviderFailure>) {
	let _ = sender
		.send(AgentEvent::Usage {
			known_cost_usd: cost,
		})
		.await;
	let _ = sender
		.send(failure.map_or(AgentEvent::Completed, ProviderFailure::event))
		.await;
}
async fn attempt(
	environment: &ProviderEnvironment,
	key: &str,
	body: &str,
	guard: &TurnGuard,
	free: bool,
	sender: &TurnSender,
) -> Option<Rejected> {
	let idle = tokio::time::sleep(Duration::from_millis(IDLE_TIMEOUT_MS));
	tokio::pin!(idle);
	let request = HttpRequest {
		method: "POST".to_owned(),
		url: CHAT_URL.to_owned(),
		headers: BTreeMap::from([
			("authorization".to_owned(), format!("Bearer {key}")),
			("content-type".to_owned(), "application/json".to_owned()),
			("accept".to_owned(), "text/event-stream".to_owned()),
		]),
		body: body.to_owned(),
	};
	let response = tokio::select! { biased;
		_=guard.cancel.cancelled()=>None,
		_=&mut idle=>{ guard.stop(StopReason::Idle);None },
		result=environment.http.send(request,guard.cancel.clone())=>Some(result),
	};
	let response = match response {
		None => {
			send_end(
				sender,
				None,
				Some(failure_for_stop(
					guard.reason().unwrap_or(StopReason::Aborted),
				)),
			)
			.await;
			return None;
		}
		Some(Err(_)) => {
			return Some(Rejected {
				failure: ProviderFailure::new("PROVIDER_UNAVAILABLE"),
				retry_after: None,
				usage: false,
			});
		}
		Some(Ok(response)) => response,
	};
	if !(200..300).contains(&response.status) {
		return Some(Rejected {
			failure: failure_for_http_status(response.status),
			retry_after: parse_retry_after_ms(
				response.headers.get("retry-after").map(String::as_str),
				now_ms(),
			),
			usage: false,
		});
	}
	let Some(mut body) = response.body else {
		send_end(
			sender,
			None,
			Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID")),
		)
		.await;
		return None;
	};
	let mut state = AttemptState::default();
	let mut splitter = LineSplitter::new(MAX_LINE_CHARS);
	let mut received = 0usize;
	let mut too_large = false;
	let mut read_failed = false;
	'read: loop {
		let chunk = tokio::select! { biased;
			_=guard.cancel.cancelled()=>break,
			_=&mut idle=>{ guard.stop(StopReason::Idle);break; },
			chunk=body.next()=>chunk,
		};
		match chunk {
			None => {
				for line in splitter.finish() {
					if !state.line(&line, free, sender).await {
						break;
					}
				}
				break;
			}
			Some(Err(_)) => {
				read_failed = true;
				break;
			}
			Some(Ok(bytes)) => {
				idle.as_mut()
					.reset(tokio::time::Instant::now() + Duration::from_millis(IDLE_TIMEOUT_MS));
				received += bytes.len();
				if received > MAX_RAW_STREAM_CHARS {
					too_large = true;
					break;
				}
				for line in splitter.push(&bytes) {
					if !state.line(&line, free, sender).await {
						break 'read;
					}
				}
			}
		}
	}
	drop(body);
	if state.charged {
		send_end(
			sender,
			state.cost,
			Some(ProviderFailure::new("PROVIDER_FREE_MODEL_CHARGED")),
		)
		.await;
		return None;
	}
	if guard.reason().is_none() {
		if let Some(failure) = state.rejected {
			return Some(Rejected {
				failure,
				retry_after: None,
				usage: true,
			});
		}
	}
	let failure = guard
		.reason()
		.map(failure_for_stop)
		.or(state.failure)
		.or_else(|| {
			if too_large {
				Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"))
			} else if read_failed {
				Some(ProviderFailure::new("PROVIDER_UNAVAILABLE"))
			} else if !state.saw_end {
				Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID"))
			} else if state.truncated {
				Some(ProviderFailure::new("PROVIDER_OUTPUT_TRUNCATED"))
			} else if state.emitted == 0 {
				Some(ProviderFailure::new("PROVIDER_OUTPUT_EMPTY"))
			} else {
				None
			}
		});
	send_end(sender, if free { None } else { state.cost }, failure).await;
	None
}
/// Shared metered and free-model backend, differing only in config and charge enforcement.
#[derive(Clone)]
pub struct OpenRouterRuntime {
	environment: ProviderEnvironment,
	free: bool,
	catalog: FreeModelCatalog,
}
impl OpenRouterRuntime {
	/// Metered OpenRouter runtime; never called without spend authorization upstream.
	pub fn new(environment: ProviderEnvironment) -> Self {
		let catalog = FreeModelCatalog::new(environment.http.clone());
		Self {
			environment,
			free: false,
			catalog,
		}
	}
	/// Free-model runtime using the shared public catalog.
	pub fn free(environment: ProviderEnvironment) -> Self {
		let catalog = FreeModelCatalog::new(environment.http.clone());
		Self {
			environment,
			free: true,
			catalog,
		}
	}
	/// Uses an application-supplied catalog, shared across runtime instances.
	pub fn with_catalog(environment: ProviderEnvironment, catalog: FreeModelCatalog) -> Self {
		Self {
			environment,
			free: true,
			catalog,
		}
	}
	fn default_model(&self) -> &str {
		self.environment
			.env
			.get(if self.free {
				"OPENROUTER_FREE_MODEL"
			} else {
				"OPENROUTER_MODEL"
			})
			.map_or("", |v| trim(v))
	}
}
#[async_trait]
impl AgentRuntime for OpenRouterRuntime {
	fn agent_id(&self) -> &str {
		if self.free {
			"openrouter-free"
		} else {
			"openrouter"
		}
	}
	fn display_name(&self) -> &str {
		if self.free {
			"OpenRouter (free models)"
		} else {
			"OpenRouter"
		}
	}
	fn cost_model(&self) -> CostModel {
		if self.free {
			CostModel::PlanLimited
		} else {
			CostModel::Metered
		}
	}
	fn tool_isolation(&self) -> ToolIsolation {
		ToolIsolation::Enforced
	}
	async fn probe(&self) -> AgentProbe {
		let model = self.default_model();
		let valid = is_valid_model_id(model) && (!self.free || is_openrouter_free_model_id(model));
		let configured = read_key(&self.environment.env).is_some() && (self.free || valid);
		let availability = if configured {
			AgentAvailability::Available
		} else {
			unavailable(
				UnavailableReason::NotConfigured,
				if self.free {
					"OpenRouter free models need OPENROUTER_API_KEY in the runner environment; a key from a free account works"
				} else {
					"OpenRouter needs OPENROUTER_API_KEY and OPENROUTER_MODEL in the runner environment"
				},
			)
		};
		let capabilities = AgentCapabilities {
			supported: vec![Capability::Stream, Capability::Cancel],
			model: if valid && (!self.free || configured) {
				Some(model.to_owned())
			} else {
				None
			},
			models: if self.free && configured {
				self.catalog.list().await
			} else {
				None
			},
		};
		AgentProbe {
			capabilities,
			availability,
		}
	}
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn {
		let deadline = match preflight_turn(&request, &context, now_ms()) {
			Ok(v) => v,
			Err(f) => return AgentTurn::from_events(vec![f.event()]),
		};
		let Some(key) = read_key(&self.environment.env) else {
			return AgentTurn::from_events(vec![ProviderFailure::new("NOT_CONFIGURED").event()]);
		};
		let model = context
			.model
			.as_deref()
			.unwrap_or_else(|| self.default_model());
		let failure = if self.free && model.is_empty() {
			Some("PROVIDER_MODEL_REQUIRED")
		} else if self.free && (!is_valid_model_id(model) || !is_openrouter_free_model_id(model)) {
			Some("PROVIDER_MODEL_INVALID")
		} else if !is_valid_model_id(model) {
			Some("NOT_CONFIGURED")
		} else {
			None
		};
		if let Some(code) = failure {
			return AgentTurn::from_events(vec![ProviderFailure::new(code).event()]);
		}
		let body = build_request_body(model, &request.prompt, context.effort);
		let runtime = self.clone();
		AgentTurn::spawn(&context.cancel, move |sender| async move {
			let guard = TurnGuard::new(sender.cancel_token().clone(), deadline, now_ms());
			for index in 0..=3 {
				let Some(rejected) = attempt(
					&runtime.environment,
					&key,
					&body,
					&guard,
					runtime.free,
					&sender,
				)
				.await
				else {
					break;
				};
				let delay = if is_transient_rejection(&rejected.failure) {
					rejection_retry_delay_ms(index, rejected.retry_after, deadline - now_ms())
				} else {
					None
				};
				let Some(delay) = delay else {
					if rejected.usage {
						let _ = sender
							.send(AgentEvent::Usage {
								known_cost_usd: None,
							})
							.await;
					}
					let _ = sender.send(rejected.failure.event()).await;
					break;
				};
				let stopped = tokio::select! { biased;_=guard.cancel.cancelled()=>true,_=tokio::time::sleep(Duration::from_secs_f64(delay.max(0.0)/1000.0))=>false };
				if stopped {
					let _ = sender
						.send(
							failure_for_stop(guard.reason().unwrap_or(StopReason::Aborted)).event(),
						)
						.await;
					break;
				}
			}
			guard.stop(StopReason::Finished);
		})
	}
}
