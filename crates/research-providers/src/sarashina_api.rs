//! Sarashina API backend: SB Intuitions' OpenAI-compatible chat completions,
//! one streaming request over HTTPS — a faithful port of sarashinaApi.ts (see
//! its header for the decisions: fixed origin, no tools, plan-limited, only
//! documented fields, `reasoning_effort` for thinking models only).
//!
//! Wire format, limits and error mapping: docs/external-apis/apis/sarashina-api.md
use crate::{
	cli_probe::unavailable,
	environment::*,
	http::*,
	http_turn::*,
	openrouter::{SseVerdict, interpret_sse_line},
	turn::*,
};
use async_trait::async_trait;
use research_agent_core::runtime::*;
use research_contracts::agent::*;
use research_js::{
	json::{self, Object, Value},
	utf16::utf16_len,
	whitespace::trim,
};
use std::collections::BTreeMap;

/// The API's own maximum for `max_completion_tokens` (thinking and answer).
pub const SARASHINA_MAX_COMPLETION_TOKENS: f64 = 8000.0;
/// The chat models Settings offers, most capable first (`SARASHINA_API_MODELS`).
pub const SARASHINA_API_MODELS: [&str; 3] = [
	"sarashina3.2-mini-thinking",
	"sarashina3-mini",
	"sarashina3-nano",
];
/// The model used when Settings leaves it empty and SARASHINA_MODEL is unset.
pub const SARASHINA_API_DEFAULT_MODEL: &str = "sarashina3.2-mini-thinking";

/// `isSarashinaThinkingModel`: only a thinking model accepts `reasoning_effort`.
pub fn is_sarashina_thinking_model(model: &str) -> bool {
	model.ends_with("-thinking")
}

fn object_fields(fields: Vec<(&str, Value)>) -> Value {
	Value::Object(Object::from_members(
		fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
	))
}

/// `buildSarashinaRequestBody`: the exact key order of the TypeScript runner.
pub fn build_request_body(model: &str, prompt: &str, effort: Effort) -> String {
	let mut fields = vec![
		("model", model.into()),
		(
			"messages",
			Value::Array(vec![object_fields(vec![
				("role", "user".into()),
				("content", prompt.into()),
			])]),
		),
		("stream", true.into()),
		(
			"max_completion_tokens",
			SARASHINA_MAX_COMPLETION_TOKENS.into(),
		),
	];
	if is_sarashina_thinking_model(model) {
		fields.push(("reasoning_effort", effort.as_str().into()));
	}
	json::stringify(&object_fields(fields))
}

/// `resolveSarashinaModel`: Settings' model, else SARASHINA_MODEL, else the default.
pub fn resolve_model<'a>(env: &'a Environment, requested: Option<&'a str>) -> &'a str {
	if let Some(model) = requested {
		return model;
	}
	match env.get("SARASHINA_MODEL").map(|v| trim(v)) {
		Some(model) if !model.is_empty() => model,
		_ => SARASHINA_API_DEFAULT_MODEL,
	}
}

fn rejection(status: u16, _body: Option<&str>) -> ProviderFailure {
	failure_for_http_status(status)
}

#[derive(Default)]
struct AttemptState {
	saw_chunk: bool,
	saw_end: bool,
	truncated: bool,
	malformed: usize,
	emitted: usize,
	failure: Option<ProviderFailure>,
	rejected: Option<ProviderFailure>,
}
#[async_trait]
impl SseHandler for AttemptState {
	async fn line(&mut self, line: &str, sender: &TurnSender) -> bool {
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
				..
			} => {
				self.saw_chunk = true;
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

struct SarashinaAttempt {
	environment: ProviderEnvironment,
	key: String,
	body: String,
}
#[async_trait]
impl HttpAttempt for SarashinaAttempt {
	async fn attempt(&self, guard: &TurnGuard, sender: &TurnSender) -> Option<Rejected> {
		let request = HttpRequest {
			method: "POST".to_owned(),
			url: SARASHINA_CHAT_URL.to_owned(),
			headers: BTreeMap::from([
				("authorization".to_owned(), format!("Bearer {}", self.key)),
				("content-type".to_owned(), "application/json".to_owned()),
				("accept".to_owned(), "text/event-stream".to_owned()),
			]),
			body: self.body.clone(),
		};
		let mut state = AttemptState::default();
		let end = match stream_request(
			&self.environment,
			request,
			rejection,
			guard,
			&mut state,
			sender,
		)
		.await
		{
			Streamed::Ended(rejected) => return rejected,
			Streamed::Read(end) => end,
		};
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
		// Plan-limited: the API reports tokens, not money, so the cost is unknown.
		send_end(sender, None, failure).await;
		None
	}
}

/// The plan-limited Sarashina API backend (`createSarashinaApiRuntime`).
#[derive(Clone)]
pub struct SarashinaApiRuntime {
	environment: ProviderEnvironment,
}
impl SarashinaApiRuntime {
	/// Reads SARASHINA_API_KEY from the runner environment at each probe and run.
	pub fn new(environment: ProviderEnvironment) -> Self {
		Self { environment }
	}
	fn key(&self) -> Option<String> {
		read_api_key(self.environment.env.get("SARASHINA_API_KEY"))
	}
}
#[async_trait]
impl AgentRuntime for SarashinaApiRuntime {
	fn agent_id(&self) -> &str {
		SARASHINA_API_AGENT_ID
	}
	fn display_name(&self) -> &str {
		"Sarashina API"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::PlanLimited
	}
	fn tool_isolation(&self) -> ToolIsolation {
		ToolIsolation::Enforced
	}
	// Deliberately offline: a probe must not spend quota.
	async fn probe(&self) -> AgentProbe {
		let model = resolve_model(&self.environment.env, None);
		AgentProbe {
			capabilities: AgentCapabilities {
				supported: vec![Capability::Stream, Capability::Cancel],
				model: is_valid_model_id(model).then(|| model.to_owned()),
				models: Some(
					SARASHINA_API_MODELS
						.iter()
						.map(|model| (*model).to_owned())
						.collect(),
				),
			},
			availability: if self.key().is_some() {
				AgentAvailability::Available
			} else {
				unavailable(
					UnavailableReason::NotConfigured,
					"The Sarashina API needs SARASHINA_API_KEY in the runner environment",
				)
			},
		}
	}
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn {
		let deadline = match preflight_turn(&request, &context, now_ms()) {
			Ok(v) => v,
			Err(f) => return AgentTurn::from_events(vec![f.event()]),
		};
		// Fail closed before any network activity: no key, or an unusable model id.
		let Some(key) = self.key() else {
			return AgentTurn::from_events(vec![ProviderFailure::new("NOT_CONFIGURED").event()]);
		};
		let model = resolve_model(&self.environment.env, context.model.as_deref());
		if !is_valid_model_id(model) {
			return AgentTurn::from_events(vec![
				ProviderFailure::new("PROVIDER_MODEL_INVALID").event(),
			]);
		}
		let body = build_request_body(model, &request.prompt, context.effort);
		run_http_turn(
			&context.cancel,
			deadline,
			SarashinaAttempt {
				environment: self.environment.clone(),
				key,
				body,
			},
		)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn body_matches_the_typescript_runner_byte_for_byte() {
		assert_eq!(
			build_request_body("sarashina3.2-mini-thinking", "p", Effort::High),
			r#"{"model":"sarashina3.2-mini-thinking","messages":[{"role":"user","content":"p"}],"stream":true,"max_completion_tokens":8000,"reasoning_effort":"high"}"#
		);
		assert_eq!(
			build_request_body("sarashina3-mini", "p", Effort::High),
			r#"{"model":"sarashina3-mini","messages":[{"role":"user","content":"p"}],"stream":true,"max_completion_tokens":8000}"#
		);
	}

	#[test]
	fn model_comes_from_settings_then_environment_then_default() {
		let mut env = Environment::new();
		assert_eq!(resolve_model(&env, None), SARASHINA_API_DEFAULT_MODEL);
		env.insert("SARASHINA_MODEL".to_owned(), " sarashina3-nano ".to_owned());
		assert_eq!(resolve_model(&env, None), "sarashina3-nano");
		assert_eq!(
			resolve_model(&env, Some("sarashina3-mini")),
			"sarashina3-mini"
		);
	}

	#[test]
	fn recorded_chunks_parse_as_openrouter_chunks() {
		let ok =
			include_str!("../../../packages/adapters/test/providers/fixtures/sarashina-api/ok.sse");
		let text: String = ok
			.lines()
			.filter_map(|line| match interpret_sse_line(line) {
				SseVerdict::Chunk { text, .. } => Some(text),
				_ => None,
			})
			.collect();
		assert_eq!(text, "OK");
		let length = include_str!(
			"../../../packages/adapters/test/providers/fixtures/sarashina-api/length.sse"
		);
		assert!(length.lines().any(|line| matches!(
			interpret_sse_line(line),
			SseVerdict::Chunk {
				truncated: true,
				..
			}
		)));
	}
}
