//! Claude API backend: Anthropic's Messages API, one streaming request over
//! HTTPS — a faithful port of claudeApi.ts (see its header for the evidence and
//! the decisions: fixed origin, no tools, no fallback, cost from a price table).
use crate::{cli_probe::unavailable, environment::*, http::*, http_turn::*, schema::*, turn::*};
use async_trait::async_trait;
use research_agent_core::runtime::*;
use research_contracts::agent::*;
use research_js::{
	json::{self, Object, Value},
	utf16::utf16_len,
	whitespace::trim,
};
use std::collections::BTreeMap;

/// The API version sent in `anthropic-version`.
pub const CLAUDE_API_VERSION: &str = "2026-10-21";
/// Thinking plus visible output one request may generate (AGT-008).
pub const MAX_OUTPUT_TOKENS: f64 = 16000.0;
/// The model used when Settings leaves the model empty.
pub const CLAUDE_API_DEFAULT_MODEL: &str = "claude-opus-5-5";

/// Prices in USD per million tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClaudeModelPrice {
	/// Uncached input.
	pub input: f64,
	/// Output, thinking included.
	pub output: f64,
	/// Cache reads.
	pub cache_read: f64,
}
/// A higher price for every token of a request whose prompt exceeds `above_tokens`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LongPromptPrice {
	/// Prompt tokens (input + cache writes + cache reads) above which it applies.
	pub above_tokens: f64,
	/// The price then.
	pub price: ClaudeModelPrice,
}
/// A model this backend runs, with its price.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClaudeModel {
	/// Exact API id.
	pub id: &'static str,
	/// Standard price.
	pub price: ClaudeModelPrice,
	/// Long-prompt tier, when the model has one.
	pub long_prompt: Option<LongPromptPrice>,
}
const fn price(input: f64, output: f64, cache_read: f64) -> ClaudeModelPrice {
	ClaudeModelPrice {
		input,
		output,
		cache_read,
	}
}
/// `CLAUDE_API_MODELS`: the accepted ids, most capable first, with first-party prices.
pub const CLAUDE_API_MODELS: [ClaudeModel; 4] = [
	ClaudeModel {
		id: "claude-fable-5-1",
		price: price(10.0, 50.0, 0.25),
		long_prompt: None,
	},
	ClaudeModel {
		id: "claude-opus-5-5",
		price: price(4.0, 20.0, 0.2),
		long_prompt: None,
	},
	ClaudeModel {
		id: "claude-sonnet-5-5",
		price: price(2.0, 10.0, 0.2),
		long_prompt: None,
	},
	ClaudeModel {
		id: "claude-haiku-5-5",
		price: price(0.1, 0.5, 0.01),
		long_prompt: Some(LongPromptPrice {
			above_tokens: 100000.0,
			price: price(0.5, 2.5, 0.05),
		}),
	},
];
/// The priced model with this exact id.
pub fn claude_model(id: &str) -> Option<&'static ClaudeModel> {
	CLAUDE_API_MODELS.iter().find(|model| model.id == id)
}

/// Token counts as reported; a later event's field replaces an earlier one.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
	/// Uncached input tokens.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub input_tokens: Option<f64>,
	/// Tokens written to the cache.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cache_creation_input_tokens: Option<f64>,
	/// Tokens read from the cache.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cache_read_input_tokens: Option<f64>,
	/// Output tokens (cumulative).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub output_tokens: Option<f64>,
}
impl ClaudeUsage {
	fn merge(&mut self, later: &Self) {
		for (mine, theirs) in [
			(&mut self.input_tokens, later.input_tokens),
			(
				&mut self.cache_creation_input_tokens,
				later.cache_creation_input_tokens,
			),
			(
				&mut self.cache_read_input_tokens,
				later.cache_read_input_tokens,
			),
			(&mut self.output_tokens, later.output_tokens),
		] {
			if theirs.is_some() {
				*mine = theirs;
			}
		}
	}
}
/// 1-hour cache writes cost 2× input, the higher of the two write rates.
const CACHE_WRITE_INPUT_MULTIPLIER: f64 = 2.0;
/// USD for one request's usage; None until input and output are known.
/// Same operations in the same order as `claudeCostUsd`, so the same double.
pub fn claude_cost_usd(model: &ClaudeModel, usage: &ClaudeUsage) -> Option<f64> {
	let (Some(input), Some(output)) = (usage.input_tokens, usage.output_tokens) else {
		return None;
	};
	let cache_write = usage.cache_creation_input_tokens.unwrap_or(0.0);
	let cache_read = usage.cache_read_input_tokens.unwrap_or(0.0);
	let prompt = input + cache_write + cache_read;
	let price = match model.long_prompt {
		Some(long) if prompt > long.above_tokens => long.price,
		_ => model.price,
	};
	let micro_dollars = input * price.input
		+ cache_write * price.input * CACHE_WRITE_INPUT_MULTIPLIER
		+ cache_read * price.cache_read
		+ output * price.output;
	Some(micro_dollars / 1000000.0)
}
fn object_fields(fields: Vec<(&str, Value)>) -> Value {
	Value::Object(Object::from_members(
		fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
	))
}
/// Exact request body, key order included.
pub fn build_request_body(model: &str, prompt: &str, effort: Effort) -> String {
	json::stringify(&object_fields(vec![
		("model", model.into()),
		("max_tokens", MAX_OUTPUT_TOKENS.into()),
		(
			"messages",
			Value::Array(vec![object_fields(vec![
				("role", "user".into()),
				("content", prompt.into()),
			])]),
		),
		("stream", true.into()),
		(
			"output_config",
			object_fields(vec![("effort", effort.as_str().into())]),
		),
	]))
}
/// A 404 names a model this key cannot use; other statuses as for any HTTP backend.
pub fn failure_for_claude_http_status(status: u16) -> ProviderFailure {
	if status == 404 {
		with_upstream_status(
			ProviderFailure::new("PROVIDER_MODEL_UNAVAILABLE"),
			Some(status),
		)
	} else {
		failure_for_http_status(status)
	}
}
/// The `error.type` of an `error` event.
pub fn failure_for_claude_error_type(kind: Option<&str>) -> ProviderFailure {
	ProviderFailure::new(match kind {
		Some("overloaded_error" | "api_error") => "PROVIDER_UNAVAILABLE",
		Some("rate_limit_error") => "PROVIDER_RATE_LIMITED",
		Some("authentication_error" | "permission_error") => "PROVIDER_AUTH",
		Some("billing_error") => "PROVIDER_PAYMENT_REQUIRED",
		Some("timeout_error") => "PROVIDER_TIMEOUT",
		Some("not_found_error") => "PROVIDER_MODEL_UNAVAILABLE",
		_ => "PROVIDER_REQUEST_REJECTED",
	})
}
/// How a `stop_reason` ends the turn; None = a complete answer.
pub fn failure_for_stop_reason(stop_reason: &str) -> Option<ProviderFailure> {
	match stop_reason {
		"end_turn" | "stop_sequence" => None,
		"max_tokens" | "model_context_window_exceeded" => {
			Some(ProviderFailure::new("PROVIDER_OUTPUT_TRUNCATED"))
		}
		"refusal" => Some(ProviderFailure::new("PROVIDER_REFUSED")),
		"tool_use" | "pause_turn" => Some(ProviderFailure::new("PROVIDER_TOOL_ISOLATION_VIOLATED")),
		_ => Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID")),
	}
}

/// Classification of one SSE line (`ClaudeSseVerdict`).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ClaudeSseVerdict {
	/// Not a data line, or an event that carries nothing for the turn.
	Ignored,
	/// Invalid JSON or event schema.
	Malformed,
	/// `message_start` with its usage.
	Started {
		/// Counts it reported.
		usage: ClaudeUsage,
	},
	/// Visible text.
	Text {
		/// Non-empty text.
		text: String,
	},
	/// An error event or a tool block.
	Failed {
		/// Stable error.
		failure: ProviderFailure,
	},
	/// `message_delta`.
	#[serde(rename_all = "camelCase")]
	Delta {
		/// None when this event names no stop reason.
		stop_reason: Option<String>,
		/// None when this event carries no usage object.
		usage: Option<ClaudeUsage>,
	},
	/// `message_stop`.
	Done,
}
/// zod `z.number().int().nonnegative().max(MAX_SAFE_INTEGER).nullable().optional()`.
fn token_count(obj: &Object, key: &str) -> Result<Option<f64>, Malformed> {
	match obj.get(key) {
		None | Some(Value::Null) => Ok(None),
		Some(Value::Number(n))
			if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9007199254740991.0 =>
		{
			Ok(Some(*n))
		}
		Some(_) => Err(Malformed),
	}
}
fn usage_from(value: &Value) -> Result<ClaudeUsage, Malformed> {
	let usage = object(value)?;
	Ok(ClaudeUsage {
		input_tokens: token_count(usage, "input_tokens")?,
		cache_creation_input_tokens: token_count(usage, "cache_creation_input_tokens")?,
		cache_read_input_tokens: token_count(usage, "cache_read_input_tokens")?,
		output_tokens: token_count(usage, "output_tokens")?,
	})
}
fn required_object<'a>(obj: &'a Object, key: &str) -> Result<&'a Object, Malformed> {
	object(obj.get(key).ok_or(Malformed)?)
}
/// zod `.nullable().optional()` string.
fn nullable_string<'a>(obj: &'a Object, key: &str) -> Result<Option<&'a str>, Malformed> {
	match obj.get(key) {
		None | Some(Value::Null) => Ok(None),
		Some(v) => v.as_str().map(Some).ok_or(Malformed),
	}
}
/// Content blocks that carry no tool (thinking text is never forwarded).
const SAFE_BLOCK_TYPES: [&str; 3] = ["text", "thinking", "redacted_thinking"];
fn text_or_ignored(forward: bool, text: Option<&str>) -> ClaudeSseVerdict {
	match text {
		Some(text) if forward && !text.is_empty() => ClaudeSseVerdict::Text {
			text: text.to_owned(),
		},
		_ => ClaudeSseVerdict::Ignored,
	}
}
fn violated() -> ClaudeSseVerdict {
	ClaudeSseVerdict::Failed {
		failure: ProviderFailure::new("PROVIDER_TOOL_ISOLATION_VIOLATED"),
	}
}
fn interpret_event(value: &Value) -> Result<ClaudeSseVerdict, Malformed> {
	let event = object(value)?;
	Ok(match string(event, "type")? {
		"message_start" => {
			let message = required_object(event, "message")?;
			ClaudeSseVerdict::Started {
				usage: message
					.get("usage")
					.map(usage_from)
					.transpose()?
					.unwrap_or_default(),
			}
		}
		"content_block_start" => {
			let block = required_object(event, "content_block")?;
			let kind = string(block, "type")?;
			let text = optional_string(block, "text")?;
			if !SAFE_BLOCK_TYPES.contains(&kind) {
				violated()
			} else {
				text_or_ignored(kind == "text", text)
			}
		}
		"content_block_delta" => {
			let delta = required_object(event, "delta")?;
			let kind = string(delta, "type")?;
			let text = optional_string(delta, "text")?;
			if kind == "input_json_delta" {
				violated()
			} else {
				text_or_ignored(kind == "text_delta", text)
			}
		}
		"message_delta" => {
			let delta = required_object(event, "delta")?;
			let stop_reason = nullable_string(delta, "stop_reason")?.map(str::to_owned);
			let usage = match event.get("usage") {
				None | Some(Value::Null) => None,
				Some(v) => Some(usage_from(v)?),
			};
			ClaudeSseVerdict::Delta { stop_reason, usage }
		}
		"message_stop" => ClaudeSseVerdict::Done,
		"error" => {
			let error = required_object(event, "error")?;
			ClaudeSseVerdict::Failed {
				failure: failure_for_claude_error_type(optional_string(error, "type")?),
			}
		}
		// content_block_stop, ping, and events added after this adapter was written.
		_ => ClaudeSseVerdict::Ignored,
	})
}
/// `interpretClaudeSseLine`: `data:` with optional space, JS trim, zod-loose schema.
pub fn interpret_claude_sse_line(line: &str) -> ClaudeSseVerdict {
	let Some(payload) = line.strip_prefix("data:") else {
		return ClaudeSseVerdict::Ignored;
	};
	json::parse(trim(payload))
		.map_err(|_| Malformed)
		.and_then(|v| interpret_event(&v))
		.unwrap_or(ClaudeSseVerdict::Malformed)
}

#[derive(Default)]
struct ClaudeState {
	usage: ClaudeUsage,
	saw_final_usage: bool,
	started: bool,
	saw_end: bool,
	stop_reason: Option<String>,
	emitted: usize,
	malformed: usize,
	failure: Option<ProviderFailure>,
	/// An error event before `message_start`: the provider refused the request.
	rejected_before_start: Option<ProviderFailure>,
}
#[async_trait]
impl SseHandler for ClaudeState {
	async fn line(&mut self, line: &str, sender: &TurnSender) -> bool {
		match interpret_claude_sse_line(line) {
			ClaudeSseVerdict::Ignored => true,
			ClaudeSseVerdict::Done => {
				self.saw_end = true;
				false
			}
			ClaudeSseVerdict::Malformed => {
				self.malformed += 1;
				if self.malformed > MAX_MALFORMED_LINES {
					self.failure = Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID"));
					return false;
				}
				true
			}
			ClaudeSseVerdict::Failed { failure } => {
				if self.started {
					self.failure = Some(failure);
				} else {
					self.rejected_before_start = Some(failure);
				}
				false
			}
			ClaudeSseVerdict::Started { usage } => {
				self.started = true;
				self.usage.merge(&usage);
				true
			}
			ClaudeSseVerdict::Delta { stop_reason, usage } => {
				if stop_reason.is_some() {
					self.stop_reason = stop_reason;
				}
				if let Some(usage) = usage {
					self.usage.merge(&usage);
					self.saw_final_usage = true;
				}
				true
			}
			ClaudeSseVerdict::Text { text } => {
				self.emitted += utf16_len(&text);
				if self.emitted > MAX_OUTPUT_TEXT_CHARS {
					self.failure = Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"));
					return false;
				}
				sender.send(AgentEvent::TextDelta { text }).await
			}
		}
	}
}
/// One request with its fixed key, model and body.
struct ClaudeAttempt {
	environment: ProviderEnvironment,
	key: String,
	model: &'static ClaudeModel,
	body: String,
}
#[async_trait]
impl HttpAttempt for ClaudeAttempt {
	async fn attempt(&self, guard: &TurnGuard, sender: &TurnSender) -> Option<Rejected> {
		let request = HttpRequest {
			method: "POST".to_owned(),
			url: CLAUDE_MESSAGES_URL.to_owned(),
			headers: BTreeMap::from([
				("x-api-key".to_owned(), self.key.clone()),
				(
					"anthropic-version".to_owned(),
					CLAUDE_API_VERSION.to_owned(),
				),
				("content-type".to_owned(), "application/json".to_owned()),
				("accept".to_owned(), "text/event-stream".to_owned()),
			]),
			body: self.body.clone(),
		};
		let mut state = ClaudeState::default();
		let end = match stream_request(
			&self.environment,
			request,
			failure_for_claude_http_status,
			guard,
			&mut state,
			sender,
		)
		.await
		{
			Streamed::Ended(rejected) => return rejected,
			Streamed::Read(end) => end,
		};
		let stop = guard.reason();
		if stop.is_none() {
			if let Some(failure) = state.rejected_before_start {
				// Nothing started, so nothing was generated; the cost is unknown.
				return Some(Rejected {
					failure,
					retry_after: None,
					usage: true,
				});
			}
		}
		let failure = if let Some(stop) = stop {
			Some(failure_for_stop(stop))
		} else if state.failure.is_some() {
			state.failure
		} else if end.too_large {
			Some(ProviderFailure::new("PROVIDER_OUTPUT_TOO_LARGE"))
		} else if end.read_failed {
			Some(ProviderFailure::new("PROVIDER_UNAVAILABLE"))
		} else {
			match state.stop_reason.as_deref() {
				// Closed before message_stop, or no stop reason was given.
				Some(reason) if state.saw_end => failure_for_stop_reason(reason).or_else(|| {
					(state.emitted == 0).then(|| ProviderFailure::new("PROVIDER_OUTPUT_EMPTY"))
				}),
				_ => Some(ProviderFailure::new("PROVIDER_OUTPUT_INVALID")),
			}
		};
		let cost = if state.saw_final_usage {
			claude_cost_usd(self.model, &state.usage)
		} else {
			None
		};
		send_end(sender, cost, failure).await;
		None
	}
}

/// The metered Claude API backend (`createClaudeApiRuntime`).
#[derive(Clone)]
pub struct ClaudeApiRuntime {
	environment: ProviderEnvironment,
}
impl ClaudeApiRuntime {
	/// Reads ANTHROPIC_API_KEY from the runner environment at each probe and run.
	pub fn new(environment: ProviderEnvironment) -> Self {
		Self { environment }
	}
	fn key(&self) -> Option<String> {
		read_api_key(self.environment.env.get("ANTHROPIC_API_KEY"))
	}
}
#[async_trait]
impl AgentRuntime for ClaudeApiRuntime {
	fn agent_id(&self) -> &str {
		CLAUDE_API_AGENT_ID
	}
	fn display_name(&self) -> &str {
		"Claude API"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::Metered
	}
	fn tool_isolation(&self) -> ToolIsolation {
		ToolIsolation::Enforced
	}
	// Deliberately offline: a probe must not spend quota.
	async fn probe(&self) -> AgentProbe {
		AgentProbe {
			capabilities: AgentCapabilities {
				supported: vec![Capability::Stream, Capability::Cancel],
				model: Some(CLAUDE_API_DEFAULT_MODEL.to_owned()),
				models: Some(
					CLAUDE_API_MODELS
						.iter()
						.map(|model| model.id.to_owned())
						.collect(),
				),
			},
			availability: if self.key().is_some() {
				AgentAvailability::Available
			} else {
				unavailable(
					UnavailableReason::NotConfigured,
					"The Claude API needs ANTHROPIC_API_KEY in the runner environment",
				)
			},
		}
	}
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn {
		let deadline = match preflight_turn(&request, &context, now_ms()) {
			Ok(v) => v,
			Err(f) => return AgentTurn::from_events(vec![f.event()]),
		};
		// Fail closed before any network activity: no key, or a model without a price.
		let Some(key) = self.key() else {
			return AgentTurn::from_events(vec![ProviderFailure::new("NOT_CONFIGURED").event()]);
		};
		let Some(model) =
			claude_model(context.model.as_deref().unwrap_or(CLAUDE_API_DEFAULT_MODEL))
		else {
			return AgentTurn::from_events(vec![
				ProviderFailure::new("PROVIDER_MODEL_INVALID").event(),
			]);
		};
		let body = build_request_body(model.id, &request.prompt, context.effort);
		run_http_turn(
			&context.cancel,
			deadline,
			ClaudeAttempt {
				environment: self.environment.clone(),
				key,
				model,
				body,
			},
		)
	}
}
