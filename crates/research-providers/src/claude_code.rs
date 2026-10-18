//! Claude Code subscription-only streaming backend, with fail-closed init verification.
use crate::{
	cli_probe::*,
	cli_turn::*,
	environment::*,
	opencode::{TEXT_ONLY_SYSTEM_PROMPT, fatal},
	process::*,
	schema::*,
	turn::*,
};
use async_trait::async_trait;
use research_agent_core::runtime::*;
use research_contracts::agent::*;
use research_js::json::{Object, Value};
use std::path::PathBuf;

/// Exact CLI argv with empty tool/settings lists and explicit subscription effort.
pub fn build_claude_args(model: Option<&str>, effort: Effort) -> Vec<String> {
	let mut args: Vec<_> = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--input-format",
		"text",
		"--tools",
		"",
		"--strict-mcp-config",
		"--setting-sources",
		"",
		"--disable-slash-commands",
		"--no-session-persistence",
		"--safe-mode",
		"--permission-mode",
		"dontAsk",
		"--permission-prompts",
		"none",
		"--system-prompt",
		TEXT_ONLY_SYSTEM_PROMPT,
		"--effort",
		effort.as_str(),
	]
	.into_iter()
	.map(str::to_owned)
	.collect();
	if let Some(model) = model {
		args.extend(["--model".to_owned(), model.to_owned()]);
	}
	args
}
#[derive(Default)]
struct ResultLine {
	subtype: Option<String>,
	is_error: bool,
	result: Option<String>,
	status: Option<f64>,
}
/// Per-turn state; assistant text is never duplicated after streamed deltas.
#[derive(Default)]
pub struct ClaudeInterpreter {
	confirmed: bool,
	hint: Option<FailureHint>,
	rate_limited: bool,
	result: Option<ResultLine>,
}
fn is_tool(ty: &str) -> bool {
	ty.contains("tool_use") || ty.contains("tool_result")
}
impl ClaudeInterpreter {
	fn interpret(&mut self, value: &Value) -> Result<LineVerdict, Malformed> {
		let value = object(value)?;
		let kind = string(value, "type")?;
		let subtype = optional_string(value, "subtype")?;
		match kind {
			"system" if subtype == Some("init") => {
				let valid = || -> Result<bool, Malformed> {
					let tools = value
						.get("tools")
						.and_then(Value::as_array)
						.ok_or(Malformed)?;
					let mcp = value
						.get("mcp_servers")
						.and_then(Value::as_array)
						.ok_or(Malformed)?;
					optional_string(value, "apiKeySource")?;
					Ok(tools.is_empty() && mcp.is_empty())
				};
				match valid() {
					Err(_) => return Ok(fatal("PROVIDER_TOOL_ISOLATION_UNVERIFIED")),
					Ok(false) => return Ok(fatal("PROVIDER_TOOL_ISOLATION_VIOLATED")),
					Ok(true) => {}
				}
				if optional_string(value, "apiKeySource")? != Some("none") {
					return Ok(fatal("PROVIDER_METERED_AUTH_NOT_ALLOWED"));
				}
				self.confirmed = true;
			}
			"stream_event" => {
				let event = object(value.get("event").ok_or(Malformed)?)?;
				let ty = string(event, "type")?;
				let delta = optional_object(event, "delta")?;
				let block = optional_object(event, "content_block")?;
				if let Some(delta) = delta {
					string(delta, "type")?;
					optional_string(delta, "text")?;
				}
				if let Some(block) = block {
					if is_tool(string(block, "type")?) {
						return Ok(fatal("PROVIDER_TOOL_ISOLATION_VIOLATED"));
					}
				}
				if ty == "content_block_delta"
					&& delta.and_then(|d| d.get("type")).and_then(Value::as_str)
						== Some("text_delta")
				{
					if !self.confirmed {
						return Ok(fatal("PROVIDER_TOOL_ISOLATION_UNVERIFIED"));
					}
					return Ok(LineVerdict::Text {
						text: delta
							.and_then(|d| d.get("text"))
							.and_then(Value::as_str)
							.unwrap_or("")
							.to_owned(),
					});
				}
			}
			"assistant" => {
				let error = optional_string(value, "error")?;
				let mut tool = false;
				if let Some(message) = optional_object(value, "message")? {
					if let Some(content) = message.get("content") {
						for block in content.as_array().ok_or(Malformed)? {
							tool |= is_tool(string(object(block)?, "type")?);
						}
					}
				}
				if tool {
					return Ok(fatal("PROVIDER_TOOL_ISOLATION_VIOLATED"));
				}
				self.hint = match error {
					Some("authentication_failed") => Some(FailureHint::Auth),
					Some("billing_error") => Some(FailureHint::Payment),
					Some("rate_limit") => Some(FailureHint::RateLimit),
					Some("server_error" | "overloaded") => Some(FailureHint::Unavailable),
					_ => self.hint,
				};
			}
			"result" => {
				let subtype = optional_string(value, "subtype")?.map(str::to_owned);
				let is_error = value
					.get("is_error")
					.and_then(Value::as_bool)
					.ok_or(Malformed)?;
				let result = optional_string(value, "result")?.map(str::to_owned);
				let status = match value.get("api_error_status") {
					None | Some(Value::Null) => None,
					Some(v) => Some(v.as_f64().filter(|n| n.is_finite()).ok_or(Malformed)?),
				};
				self.result = Some(ResultLine {
					subtype,
					is_error,
					result,
					status,
				});
			}
			"rate_limit_event" => {
				let info = object(value.get("rate_limit_info").ok_or(Malformed)?)?;
				if string(info, "status")? == "rejected" {
					self.rate_limited = true;
				}
			}
			_ => {}
		}
		Ok(LineVerdict::Ignored)
	}
}
impl CliStreamInterpreter for ClaudeInterpreter {
	fn interpret_line(&mut self, line: &str) -> LineVerdict {
		parse(line)
			.and_then(|v| self.interpret(&v))
			.unwrap_or(LineVerdict::Malformed)
	}
	fn conclude(&mut self, exit: &ProcessExit, emitted: usize) -> TurnConclusion {
		let succeeded = exit.code == Some(0)
			&& self
				.result
				.as_ref()
				.is_some_and(|r| !r.is_error && r.subtype.as_deref() == Some("success"));
		if !succeeded {
			let hint = self
				.hint
				.or_else(|| {
					self.result
						.as_ref()
						.and_then(|r| r.status)
						.and_then(hint_from_http_status)
				})
				.or(if self.rate_limited {
					Some(FailureHint::RateLimit)
				} else {
					None
				})
				.or_else(|| {
					hint_from_text(&format!(
						"{}\n{}",
						self.result
							.as_ref()
							.and_then(|r| r.result.as_deref())
							.unwrap_or(""),
						exit.stderr_tail
					))
				});
			return TurnConclusion::new(Some(hint.map_or_else(
				|| {
					ProviderFailure::new(if exit.code != Some(0) {
						"PROVIDER_EXIT_NONZERO"
					} else if self.result.is_none() {
						"PROVIDER_OUTPUT_INVALID"
					} else {
						"PROVIDER_ERROR"
					})
				},
				failure_for_hint,
			)));
		}
		if !self.confirmed {
			return TurnConclusion::new(Some(ProviderFailure::new(
				"PROVIDER_TOOL_ISOLATION_UNVERIFIED",
			)));
		}
		let trailing = if emitted == 0 {
			self.result
				.as_ref()
				.and_then(|r| r.result.clone())
				.unwrap_or_default()
		} else {
			String::new()
		};
		if emitted == 0 && trailing.is_empty() {
			return TurnConclusion::new(Some(ProviderFailure::new("PROVIDER_OUTPUT_EMPTY")));
		}
		TurnConclusion {
			failure: None,
			trailing_text: trailing,
			known_cost_usd: None,
		}
	}
}
/// A provider auth-status schema was not understood.
#[derive(Debug, thiserror::Error)]
#[error("invalid auth status")]
pub struct AuthStatusError;
/// Subscription auth availability. Unknown/metered billing is refused before a turn.
pub fn availability_for_auth_status(value: &Object) -> Result<AgentAvailability, AuthStatusError> {
	let invalid = || AuthStatusError;
	let logged = value
		.get("loggedIn")
		.and_then(Value::as_bool)
		.ok_or_else(invalid)?;
	let method = optional_string(value, "authMethod").map_err(|_| invalid())?;
	let provider = optional_string(value, "apiProvider").map_err(|_| invalid())?;
	let key = optional_string(value, "apiKeySource").map_err(|_| invalid())?;
	Ok(if !logged {
		unavailable(
			UnavailableReason::NotAuthenticated,
			"Claude Code is not logged in; run `claude` and /login",
		)
	} else if method == Some("api_key") || key.is_some_and(|k| k != "none") {
		unavailable(
			UnavailableReason::NotConfigured,
			"Claude Code is authenticated with a metered API key; this plan-limited adapter only runs on a Claude subscription login",
		)
	} else if matches!(method, Some("claude.ai" | "oauth_token")) && provider == Some("firstParty")
	{
		AgentAvailability::Available
	} else {
		unavailable(
			UnavailableReason::NotConfigured,
			"Claude Code does not report a Claude subscription login (third-party provider or unrecognised auth method); metered or unknown billing is not supported by this plan-limited adapter",
		)
	})
}
/// Claude Code runtime.
#[derive(Clone)]
pub struct ClaudeCodeRuntime {
	environment: ProviderEnvironment,
}
impl ClaudeCodeRuntime {
	/// Constructs the subscription-only adapter.
	pub fn new(environment: ProviderEnvironment) -> Self {
		Self { environment }
	}
	fn spec(
		&self,
		args: Vec<String>,
		cwd: PathBuf,
		stdin: String,
		cancel: tokio_util::sync::CancellationToken,
	) -> ProcessSpec {
		ProcessSpec {
			command: "claude".to_owned(),
			args,
			cwd,
			env: build_child_env(
				&self.environment.env,
				&["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"],
			),
			stdin,
			cancel,
		}
	}
}
#[async_trait]
impl AgentRuntime for ClaudeCodeRuntime {
	fn agent_id(&self) -> &str {
		"claude-code"
	}
	fn display_name(&self) -> &str {
		"Claude Code"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::PlanLimited
	}
	fn tool_isolation(&self) -> ToolIsolation {
		ToolIsolation::Enforced
	}
	async fn probe(&self) -> AgentProbe {
		let capabilities = AgentCapabilities {
			supported: vec![Capability::Stream],
			model: None,
			models: None,
		};
		let spec = |args: &[&str]| {
			self.spec(
				args.iter().map(|s| (*s).to_owned()).collect(),
				PathBuf::from(probe_working_directory(&self.environment.env)),
				String::new(),
				tokio_util::sync::CancellationToken::new(),
			)
		};
		let availability = match probe_cli_version(
			&self.environment.process_runner,
			spec(&["--version"]),
			"Claude Code",
			[2.0, 1.0, 296.0],
		)
		.await
		{
			Err(a) => a,
			Ok(_) => match capture_command(
				&self.environment.process_runner,
				spec(&["auth", "status", "--json"]),
			)
			.await
			{
				Capture::Exited { stdout, .. } => parse(&stdout)
					.ok()
					.and_then(|v| {
						v.as_object()
							.and_then(|v| availability_for_auth_status(v).ok())
					})
					.unwrap_or_else(|| {
						unavailable(
							UnavailableReason::ProbeFailed,
							"`claude auth status` output was not understood",
						)
					}),
				_ => unavailable(
					UnavailableReason::ProbeFailed,
					"`claude auth status` did not complete",
				),
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
		let Some(scratch) = context.scratch_directory else {
			return AgentTurn::from_events(vec![
				ProviderFailure::new("SCRATCH_DIRECTORY_REQUIRED").event(),
			]);
		};
		run_cli_turn(
			self.environment.process_runner.clone(),
			self.spec(
				build_claude_args(context.model.as_deref(), context.effort),
				scratch,
				request.prompt,
				context.cancel,
			),
			Box::<ClaudeInterpreter>::default(),
			deadline,
		)
	}
}
