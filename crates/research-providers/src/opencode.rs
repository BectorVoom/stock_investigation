//! OpenCode permission configs, variant memory and native research calls (ADR-0012/27/28/29).
use crate::{cli_probe::*, cli_turn::*, environment::*, process::*, schema::*, turn::*};
use async_trait::async_trait;
use research_agent_core::runtime::{AgentProbe, AgentRunContext, AgentRuntime, AgentTurn, Effort};
use research_contracts::{
	agent::*,
	json::{JsonValue, is_bounded_json},
};
use research_js::{
	json::{self, Object, Value},
	utf16::{truncate, utf16_len},
	whitespace::trim,
};
use std::{
	collections::{HashMap, HashSet},
	path::PathBuf,
	sync::{Arc, Mutex},
};

const ENV_KEYS: &[&str] = &[
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
];
/// Plan-limited system instruction, shared with Claude Code.
pub const TEXT_ONLY_SYSTEM_PROMPT: &str = "You are a text-generation backend for a research application. You have no tools and cannot take actions. Answer the user message with text only, in exactly the format it asks for.";
const FREE_SYSTEM_PROMPT: &str = "You are a text-generation backend for a research application. This session lists tools only because the provider requires it for this model, but every tool call is rejected before it runs and returns nothing. You have no working tools. Answer the user message with text only, in exactly the format it asks for. Do not call any tool.";
/// Rejected calls beyond this bound fail the turn.
pub const MAX_REJECTED_TOOL_CALLS: usize = 4;
/// OpenCode free-tier suffix, case sensitive and untrimmed.
pub fn is_free_tier_model_id(model: &str) -> bool {
	model.ends_with("-free")
}
fn obj(fields: Vec<(&str, Value)>) -> Value {
	Value::Object(Object::from_members(
		fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
	))
}
/// Exact ordered JSON config with tab indentation, newline and no execute permission.
pub fn build_opencode_config_content(model: &str) -> String {
	let free = is_free_tier_model_id(model);
	let mut permissions = vec![obj(vec![
		("action", "*".into()),
		("resource", "*".into()),
		("effect", "deny".into()),
	])];
	if free {
		for action in [
			"edit",
			"glob",
			"grep",
			"question",
			"read",
			"shell",
			"skill",
			"subagent",
			"webfetch",
			"websearch",
		] {
			permissions.push(obj(vec![
				("action", action.into()),
				("resource", "*".into()),
				("effect", "ask".into()),
			]));
		}
	}
	let permissions = Value::Array(permissions);
	let agent = obj(vec![
		(
			"description",
			if free {
				"Text-only generation backend with every tool call rejected"
			} else {
				"Text-only generation backend with no tools"
			}
			.into(),
		),
		("mode", "primary".into()),
		(
			"system",
			if free {
				FREE_SYSTEM_PROMPT
			} else {
				TEXT_ONLY_SYSTEM_PROMPT
			}
			.into(),
		),
		("permissions", permissions.clone()),
	]);
	let config = obj(vec![
		("$schema", "https://opencode.ai/config.json".into()),
		("permissions", permissions),
		("default_agent", "research-text".into()),
		("agents", obj(vec![("research-text", agent)])),
	]);
	format!("{}\n", json::stringify_pretty(&config, "\t"))
}
/// Literal argv with stdin prompt and private standalone server.
pub fn build_opencode_args(model: &str) -> Vec<String> {
	[
		"run",
		"--standalone",
		"--format",
		"json",
		"--agent",
		"research-text",
		"--model",
		model,
	]
	.into_iter()
	.map(str::to_owned)
	.collect()
}
/// Nearest effort variants, skipping previously refused variants, then bare model.
pub fn model_arguments_for(model: &str, effort: Effort, refused: &HashSet<String>) -> Vec<String> {
	if model.contains('#') {
		return vec![model.to_owned()];
	}
	let variants = match effort {
		Effort::Low => ["low", "minimal"],
		Effort::Medium => ["medium", "low"],
		Effort::High => ["high", "max"],
	};
	variants
		.into_iter()
		.filter(|v| !refused.contains(*v))
		.map(|v| format!("{model}#{v}"))
		.chain(std::iter::once(model.to_owned()))
		.collect()
}
/// Sorted unique model list; sort happens before the 300-id cap.
pub fn parse_model_list(text: &str) -> Vec<String> {
	let mut ids: Vec<_> = text
		.split('\n')
		.map(trim)
		.filter(|s| is_valid_model_id(s))
		.map(str::to_owned)
		.collect::<HashSet<_>>()
		.into_iter()
		.collect();
	ids.sort();
	ids.truncate(300);
	ids
}
/// Options for the native-tool bridge; only rejected, unexecuted calls are permitted.
#[derive(Clone, Default)]
pub struct OpenCodeInterpreterOptions {
	/// The free-tier ask-and-reject config is active.
	pub ask_and_reject: bool,
	/// Research tool ids permitted by this turn.
	pub permitted_tool_ids: Vec<String>,
	/// Remaining orchestrator tool budget.
	pub max_tool_requests: u64,
}
/// Sequential JSONL interpreter.
pub struct OpenCodeInterpreter {
	options: OpenCodeInterpreterOptions,
	join: SegmentJoiner,
	error: Option<ProviderFailure>,
	rejected: usize,
	requests: u64,
}
impl OpenCodeInterpreter {
	/// Creates fresh per-turn state.
	pub fn new(options: OpenCodeInterpreterOptions) -> Self {
		Self {
			options,
			join: SegmentJoiner::default(),
			error: None,
			rejected: 0,
			requests: 0,
		}
	}
	fn interpret(&mut self, value: &Value) -> Result<LineVerdict, Malformed> {
		let event = object(value)?;
		let kind = string(event, "type")?;
		let part = optional_object(event, "part")?;
		let error = optional_object(event, "error")?;
		if let Some(error) = error {
			strings(error, &["type", "message"])?;
		}
		let mut state = None;
		let mut executed = false;
		if let Some(part) = part {
			strings(part, &["type", "text", "tool", "id"])?;
			state = optional_object(part, "state")?;
			if let Some(state) = state {
				strings(state, &["status"])?;
				if let Some(metadata) = optional_object(state, "metadata")? {
					if let Some(call) = optional_object(metadata, "providerCall")? {
						if let Some(value) = call.get("executed") {
							executed = value.as_bool().ok_or(Malformed)?;
						}
					}
				}
			}
		}
		let get = |key| {
			part.and_then(|p| p.get(key))
				.and_then(Value::as_str)
				.unwrap_or("")
		};
		if contains_ascii_case(kind, "tool") || contains_ascii_case(get("type"), "tool") {
			if self.options.ask_and_reject
				&& state.and_then(|s| s.get("status")).and_then(Value::as_str) == Some("error")
				&& !executed
			{
				let tool = get("tool");
				let args = state
					.and_then(|s| s.get("input"))
					.filter(|v| v.as_object().is_some() && is_bounded_json(v));
				if self.options.permitted_tool_ids.iter().any(|id| id == tool)
					&& args.is_some()
					&& self.requests < self.options.max_tool_requests
				{
					if let Some(args) = args {
						self.requests += 1;
						let id = get("id");
						return Ok(LineVerdict::ToolRequest {
							tool_id: truncate(tool, 80).into_owned(),
							args: JsonValue(args.clone()),
							call_id: if (1..=96).contains(&utf16_len(id)) {
								id.to_owned()
							} else {
								format!("opencode-call-{}", self.requests)
							},
						});
					}
				}
				self.rejected += 1;
				return Ok(if self.rejected > MAX_REJECTED_TOOL_CALLS {
					fatal("PROVIDER_TOOL_CALL_REJECTED")
				} else {
					LineVerdict::Ignored
				});
			}
			return Ok(fatal("PROVIDER_TOOL_ISOLATION_VIOLATED"));
		}
		if kind == "error" {
			let ty = error
				.and_then(|e| e.get("type"))
				.and_then(Value::as_str)
				.unwrap_or("");
			let message = error
				.and_then(|e| e.get("message"))
				.and_then(Value::as_str)
				.unwrap_or("");
			self.error = Some(if ty == "provider.no-route" {
				ProviderFailure::new(
					if message
						.get(..19)
						.is_some_and(|s| s.eq_ignore_ascii_case("variant unavailable"))
					{
						"PROVIDER_VARIANT_UNAVAILABLE"
					} else {
						"PROVIDER_MODEL_UNAVAILABLE"
					},
				)
			} else if ty == "provider.auth" {
				ProviderFailure::new("PROVIDER_AUTH")
			} else {
				hint_from_text(&format!("{ty} {message}"))
					.map_or_else(|| ProviderFailure::new("PROVIDER_ERROR"), failure_for_hint)
			});
			return Ok(LineVerdict::Ignored);
		}
		if kind == "text" {
			return Ok(LineVerdict::Text {
				text: self.join.join(get("text")),
			});
		}
		if kind == "step_finish" && self.requests > 0 {
			return Ok(LineVerdict::Finished);
		}
		Ok(LineVerdict::Ignored)
	}
}
pub(crate) fn fatal(code: &str) -> LineVerdict {
	LineVerdict::Fatal {
		failure: ProviderFailure::new(code),
	}
}
impl CliStreamInterpreter for OpenCodeInterpreter {
	fn interpret_line(&mut self, line: &str) -> LineVerdict {
		parse(line)
			.and_then(|v| self.interpret(&v))
			.unwrap_or(LineVerdict::Malformed)
	}
	fn conclude(&mut self, exit: &ProcessExit, emitted: usize) -> TurnConclusion {
		let failure = self.error.clone().or_else(|| {
			if exit.code != Some(0) {
				Some(hint_from_text(&exit.stderr_tail).map_or_else(
					|| ProviderFailure::new("PROVIDER_EXIT_NONZERO"),
					failure_for_hint,
				))
			} else if emitted > 0 || self.requests > 0 {
				None
			} else {
				Some(ProviderFailure::new(if self.rejected > 0 {
					"PROVIDER_TOOL_CALL_REJECTED"
				} else {
					"PROVIDER_OUTPUT_EMPTY"
				}))
			}
		});
		TurnConclusion::new(failure)
	}
}
/// OpenCode runtime with refused-variant memory lasting for the process lifetime.
#[derive(Clone)]
pub struct OpenCodeRuntime {
	environment: ProviderEnvironment,
	refused: Arc<Mutex<HashMap<String, HashSet<String>>>>,
}
impl OpenCodeRuntime {
	/// Uses quota-free probes and per-job permission configs.
	pub fn new(environment: ProviderEnvironment) -> Self {
		Self {
			environment,
			refused: Arc::new(Mutex::new(HashMap::new())),
		}
	}
	fn configured_model(&self) -> Option<String> {
		self.environment
			.env
			.get("OPENCODE_MODEL")
			.filter(|s| is_valid_model_id(s))
			.cloned()
	}
	fn probe_spec(&self, args: &[&str]) -> ProcessSpec {
		ProcessSpec {
			command: "opencode".to_owned(),
			args: args.iter().map(|s| (*s).to_owned()).collect(),
			cwd: PathBuf::from(probe_working_directory(&self.environment.env)),
			env: build_child_env(&self.environment.env, ENV_KEYS),
			stdin: String::new(),
			cancel: tokio_util::sync::CancellationToken::new(),
		}
	}
}
#[async_trait]
impl AgentRuntime for OpenCodeRuntime {
	fn agent_id(&self) -> &str {
		"opencode"
	}
	fn display_name(&self) -> &str {
		"OpenCode"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::PlanLimited
	}
	fn tool_isolation(&self) -> ToolIsolation {
		ToolIsolation::Enforced
	}
	async fn probe(&self) -> AgentProbe {
		let mut capabilities = AgentCapabilities {
			supported: vec![],
			model: self.configured_model(),
			models: None,
		};
		let version = match probe_cli_version(
			&self.environment.process_runner,
			self.probe_spec(&["--version"]),
			"OpenCode",
			[2.0, 0.0, 27.0],
		)
		.await
		{
			Ok(v) => v,
			Err(availability) => {
				return AgentProbe {
					capabilities,
					availability,
				};
			}
		};
		if version >= [2.0, 1.0, 0.0] {
			return AgentProbe {
				capabilities,
				availability: unavailable(
					UnavailableReason::ToolIsolationUnverified,
					&format!(
						"OpenCode {} is newer than the 2.0.x line on which the permission configs were verified",
						format_version(version)
					),
				),
			};
		}
		let status = capture_command(
			&self.environment.process_runner,
			self.probe_spec(&["auth", "list", "--standalone", "--format", "json"]),
		)
		.await;
		let availability = match status {
			Capture::Exited {
				code: Some(0),
				stdout,
				..
			} => match parse_auth_list(&stdout) {
				Some(true) => AgentAvailability::Available,
				Some(false) => unavailable(
					UnavailableReason::NotAuthenticated,
					"OpenCode has no stored credential; run `opencode auth login`",
				),
				None => unavailable(
					UnavailableReason::ProbeFailed,
					"`opencode auth list` output was not understood",
				),
			},
			_ => unavailable(
				UnavailableReason::ProbeFailed,
				"`opencode auth list` did not complete",
			),
		};
		if availability == AgentAvailability::Available {
			if let Capture::Exited {
				code: Some(0),
				stdout,
				..
			} = capture_command(
				&self.environment.process_runner,
				self.probe_spec(&["models"]),
			)
			.await
			{
				capabilities.models = Some(parse_model_list(&stdout));
			}
		}
		AgentProbe {
			capabilities,
			availability,
		}
	}
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn {
		let runtime = self.clone();
		let cancel = context.cancel.clone();
		AgentTurn::spawn(&cancel, move |sender| async move {
			let deadline = match preflight_turn(&request, &context, now_ms()) {
				Ok(v) => v,
				Err(f) => {
					let _ = sender.send(f.event()).await;
					return;
				}
			};
			let Some(scratch) = context.scratch_directory else {
				let _ = sender
					.send(ProviderFailure::new("SCRATCH_DIRECTORY_REQUIRED").event())
					.await;
				return;
			};
			let Some(model) = context.model.or_else(|| runtime.configured_model()) else {
				let _ = sender
					.send(ProviderFailure::new("PROVIDER_MODEL_REQUIRED").event())
					.await;
				return;
			};
			let write = async {
				let mut options = tokio::fs::OpenOptions::new();
				options.create(true).truncate(true).write(true).mode(0o600);
				let mut file = options.open(scratch.join("opencode.jsonc")).await?;
				tokio::io::AsyncWriteExt::write_all(
					&mut file,
					build_opencode_config_content(&model).as_bytes(),
				)
				.await
			}
			.await;
			if write.is_err() {
				let _ = sender
					.send(ProviderFailure::new("PROVIDER_CONFIG_WRITE_FAILED").event())
					.await;
				return;
			}
			let refused = runtime
				.refused
				.lock()
				.unwrap_or_else(std::sync::PoisonError::into_inner)
				.get(&model)
				.cloned()
				.unwrap_or_default();
			let arguments = model_arguments_for(&model, context.effort, &refused);
			let count = arguments.len();
			for (index, argument) in arguments.into_iter().enumerate() {
				let spec = ProcessSpec {
					command: "opencode".to_owned(),
					args: build_opencode_args(&argument),
					cwd: scratch.clone(),
					env: build_child_env(&runtime.environment.env, ENV_KEYS),
					stdin: request.prompt.clone(),
					cancel: sender.cancel_token().clone(),
				};
				let mut turn = run_cli_turn(
					runtime.environment.process_runner.clone(),
					spec,
					Box::new(OpenCodeInterpreter::new(OpenCodeInterpreterOptions {
						ask_and_reject: is_free_tier_model_id(&model),
						permitted_tool_ids: request.permitted_tool_ids.clone(),
						max_tool_requests: request.max_tool_calls,
					})),
					deadline,
				);
				let mut usage = None;
				let mut retry = false;
				let mut gone = false;
				while let Some(event) = turn.next().await {
					if matches!(event, AgentEvent::Usage { .. }) {
						usage = Some(event);
						continue;
					}
					if index + 1 < count
						&& matches!(&event,AgentEvent::Failed { code,.. } if code=="PROVIDER_VARIANT_UNAVAILABLE")
					{
						if let Some(variant) = argument.strip_prefix(&format!("{model}#")) {
							runtime
								.refused
								.lock()
								.unwrap_or_else(std::sync::PoisonError::into_inner)
								.entry(model.clone())
								.or_default()
								.insert(variant.to_owned());
						}
						retry = true;
						break;
					}
					if let Some(usage) = usage.take() {
						if !sender.send(usage).await {
							gone = true;
							break;
						}
					}
					if !sender.send(event).await {
						gone = true;
						break;
					}
				}
				turn.close().await;
				if gone {
					return;
				}
				if retry {
					continue;
				}
				if let Some(usage) = usage {
					let _ = sender.send(usage).await;
				}
				return;
			}
		})
	}
}
fn parse_auth_list(text: &str) -> Option<bool> {
	let value = json::parse(text).ok()?;
	let items = value.as_array()?;
	let mut credential = false;
	for item in items {
		let item = object(item).ok()?;
		if let Some(connections) = item.get("connections") {
			for c in connections.as_array()? {
				credential |= string(object(c).ok()?, "type").ok()? == "credential";
			}
		}
	}
	Some(credential)
}
