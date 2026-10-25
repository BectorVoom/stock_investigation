//! OpenRouter SSE and free-cost enforcement; retries and the idle watch live in http_turn.
use crate::{
	cli_probe::unavailable, environment::*, http::*, http_turn::*, openrouter_models::*, schema::*,
	turn::*,
};
use async_trait::async_trait;
use research_agent_core::runtime::*;
use research_contracts::agent::*;
use research_domain::upstream::upstream_status_from_number;
use research_js::{
	json::{self, Object, Value},
	utf16::utf16_len,
	whitespace::trim,
};
use std::collections::BTreeMap;
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
		// A mid-stream error arrives with HTTP 200; its `code` mirrors an HTTP
		// status when numeric, and is then kept unchanged as the upstream
		// status (§4a).
		let code = error.get("code").and_then(Value::as_f64);
		return Ok(SseVerdict::Failed {
			failure: with_upstream_status(
				failure_for_hint(
					code.and_then(hint_from_http_status)
						.unwrap_or(FailureHint::Unavailable),
				),
				code.and_then(upstream_status_from_number),
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
	read_api_key(env.get("OPENROUTER_API_KEY"))
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
	free: bool,
}
#[async_trait]
impl SseHandler for AttemptState {
	async fn line(&mut self, line: &str, sender: &TurnSender) -> bool {
		let free = self.free;
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
/// One request with its fixed key and body.
struct OpenRouterAttempt {
	environment: ProviderEnvironment,
	key: String,
	body: String,
	free: bool,
}
#[async_trait]
impl HttpAttempt for OpenRouterAttempt {
	async fn attempt(&self, guard: &TurnGuard, sender: &TurnSender) -> Option<Rejected> {
		let request = HttpRequest {
			method: "POST".to_owned(),
			url: CHAT_URL.to_owned(),
			headers: BTreeMap::from([
				("authorization".to_owned(), format!("Bearer {}", self.key)),
				("content-type".to_owned(), "application/json".to_owned()),
				("accept".to_owned(), "text/event-stream".to_owned()),
			]),
			body: self.body.clone(),
		};
		let mut state = AttemptState {
			free: self.free,
			..AttemptState::default()
		};
		let end = match stream_request(
			&self.environment,
			request,
			failure_for_http_status,
			guard,
			&mut state,
			sender,
		)
		.await
		{
			Streamed::Ended(rejected) => return rejected,
			Streamed::Read(end) => end,
		};
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
				if end.too_large {
					Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"))
				} else if end.read_failed {
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
		send_end(sender, if self.free { None } else { state.cost }, failure).await;
		None
	}
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
		run_http_turn(
			&context.cancel,
			deadline,
			OpenRouterAttempt {
				environment: self.environment.clone(),
				key,
				body,
				free: self.free,
			},
		)
	}
}
