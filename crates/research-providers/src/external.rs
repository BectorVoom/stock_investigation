//! Owner-registered language-independent backends (FR-013, protocol version 1).
use crate::{cli_probe::*, cli_turn::*, environment::*, process::*, turn::*};
use async_trait::async_trait;
use research_agent_core::runtime::*;
use research_contracts::{agent::*, json::to_js_json};
use research_js::json::{self, Object, Value};
use std::{path::PathBuf, sync::Arc};

/// Configuration errors name fields, never supplied values or secrets.
#[derive(Debug, thiserror::Error)]
pub enum ExternalConfigError {
	/// The registration file could not be read.
	#[error("external agents file could not be read: {0}")]
	Io(#[from] std::io::Error),
	/// Invalid JSON/schema/configuration field.
	#[error("invalid external agent {0}")]
	Invalid(&'static str),
}
/// Trusted owner declaration; metadata is checked with the descriptor contract.
#[derive(Clone, Debug)]
pub struct ExternalProcessConfig {
	/// Stable extensible agent id.
	pub agent_id: String,
	/// User-facing name.
	pub display_name: String,
	/// Owner-declared billing model.
	pub cost_model: CostModel,
	/// Owner-declared isolation; core policy still enforces it.
	pub tool_isolation: ToolIsolation,
	/// Executable, never a shell command.
	pub command: String,
	/// Literal arguments before `probe` / `run`.
	pub args: Vec<String>,
	/// Configured existing cwd, independent of the job's scratch path.
	pub cwd: PathBuf,
	/// Explicit extra environment keys.
	pub env_keys: Vec<String>,
}
fn string_array(value: Option<&Value>) -> Result<Vec<String>, ExternalConfigError> {
	value
		.and_then(Value::as_array)
		.ok_or(ExternalConfigError::Invalid("string array"))?
		.iter()
		.map(|v| {
			v.as_str()
				.map(str::to_owned)
				.ok_or(ExternalConfigError::Invalid("string array"))
		})
		.collect()
}
/// Strict owner registration document; no discovery or automatic executable loading.
pub fn parse_external_configs(
	text: &str,
) -> Result<Vec<ExternalProcessConfig>, ExternalConfigError> {
	let value = json::parse(text).map_err(|_| ExternalConfigError::Invalid("JSON"))?;
	let entries = value
		.as_array()
		.ok_or(ExternalConfigError::Invalid("list"))?;
	let mut configs = Vec::with_capacity(entries.len());
	for entry in entries {
		let entry = entry
			.as_object()
			.ok_or(ExternalConfigError::Invalid("entry"))?;
		let keys = [
			"agentId",
			"displayName",
			"costModel",
			"toolIsolation",
			"command",
			"args",
			"cwd",
			"envKeys",
		];
		if entry.keys().any(|k| !keys.contains(&k)) {
			return Err(ExternalConfigError::Invalid("field"));
		}
		let mut metadata = Object::new();
		for key in ["agentId", "displayName", "costModel", "toolIsolation"] {
			metadata.insert(
				key,
				entry
					.get(key)
					.cloned()
					.ok_or(ExternalConfigError::Invalid("metadata"))?,
			);
		}
		metadata.insert(
			"capabilities",
			json::parse("{\"supported\":[]}")
				.map_err(|_| ExternalConfigError::Invalid("metadata"))?,
		);
		metadata.insert(
			"availability",
			json::parse("{\"status\":\"available\"}")
				.map_err(|_| ExternalConfigError::Invalid("metadata"))?,
		);
		let descriptor: AgentDescriptor = research_contracts::validate(&Value::Object(metadata))
			.map_err(|_| ExternalConfigError::Invalid("metadata"))?;
		let get = |key| {
			entry
				.get(key)
				.and_then(Value::as_str)
				.filter(|s| !s.is_empty() && !s.contains('\0'))
				.map(str::to_owned)
				.ok_or(ExternalConfigError::Invalid("command/cwd"))
		};
		let command = get("command")?;
		let cwd = PathBuf::from(get("cwd")?);
		if !cwd.is_absolute() {
			return Err(ExternalConfigError::Invalid("cwd (must be absolute)"));
		}
		let args = string_array(entry.get("args"))?;
		if args.iter().any(|s| s.contains('\0')) {
			return Err(ExternalConfigError::Invalid("args"));
		}
		let env_keys = string_array(entry.get("envKeys"))?;
		if env_keys
			.iter()
			.any(|key| key.is_empty() || key.contains(['=', '\0']))
		{
			return Err(ExternalConfigError::Invalid("envKeys"));
		}
		configs.push(ExternalProcessConfig {
			agent_id: descriptor.agent_id,
			display_name: descriptor.display_name,
			cost_model: descriptor.cost_model,
			tool_isolation: descriptor.tool_isolation,
			command,
			args,
			cwd,
			env_keys,
		});
	}
	Ok(configs)
}
/// Runtime is activated only by explicit owner registration.
#[derive(Clone)]
pub struct ExternalProcessRuntime {
	config: ExternalProcessConfig,
	environment: ProviderEnvironment,
}
impl ExternalProcessRuntime {
	/// Validated registration plus the same hardened process boundary as built-ins.
	pub fn new(config: ExternalProcessConfig, environment: ProviderEnvironment) -> Self {
		Self {
			config,
			environment,
		}
	}
	fn spec(
		&self,
		mode: &str,
		stdin: String,
		cancel: tokio_util::sync::CancellationToken,
	) -> ProcessSpec {
		let mut args = self.config.args.clone();
		args.push(mode.to_owned());
		let keys: Vec<_> = self.config.env_keys.iter().map(String::as_str).collect();
		ProcessSpec {
			command: self.config.command.clone(),
			args,
			cwd: self.config.cwd.clone(),
			env: build_child_env(&self.environment.env, &keys),
			stdin,
			cancel,
		}
	}
}
fn parse_probe(text: &str) -> Option<AgentProbe> {
	let value = json::parse(text).ok()?;
	let value = value.as_object()?;
	if value.len() != 3 || value.get("protocol").and_then(Value::as_f64) != Some(1.0) {
		return None;
	}
	Some(AgentProbe {
		capabilities: research_contracts::validate(value.get("capabilities")?).ok()?,
		availability: research_contracts::validate(value.get("availability")?).ok()?,
	})
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalContext<'a> {
	scratch_directory: Option<String>,
	model: Option<&'a str>,
	effort: &'a str,
}
#[derive(serde::Serialize)]
struct RunEnvelope<'a> {
	protocol: u8,
	request: &'a AgentRequest,
	context: ExternalContext<'a>,
}
/// Encodes the single versioned run request, newline and EOF.
pub fn encode_run_request(
	request: &AgentRequest,
	context: &AgentRunContext,
) -> Result<String, ExternalConfigError> {
	let envelope = RunEnvelope {
		protocol: 1,
		request,
		context: ExternalContext {
			scratch_directory: context
				.scratch_directory
				.as_ref()
				.map(|p| p.to_string_lossy().into_owned()),
			model: context.model.as_deref(),
			effort: context.effort.as_str(),
		},
	};
	to_js_json(&envelope)
		.map(|s| format!("{s}\n"))
		.map_err(|_| ExternalConfigError::Invalid("run request"))
}
/// Strict public-event decoder with bounded research-tool mediation.
pub struct ExternalEventInterpreter {
	permitted: Vec<String>,
	maximum: u64,
	requests: u64,
	cost: Option<f64>,
}
impl ExternalEventInterpreter {
	/// One fresh interpreter per run; usage is last-wins.
	pub fn new(request: &AgentRequest) -> Self {
		Self {
			permitted: request.permitted_tool_ids.clone(),
			maximum: request.max_tool_calls,
			requests: 0,
			cost: None,
		}
	}
}
impl CliStreamInterpreter for ExternalEventInterpreter {
	fn interpret_line(&mut self, line: &str) -> LineVerdict {
		match research_contracts::parse::<AgentEvent>(line) {
			Err(_) => LineVerdict::Malformed,
			Ok(AgentEvent::TextDelta { text }) => LineVerdict::Text { text },
			Ok(AgentEvent::ToolRequest {
				tool_id,
				args,
				call_id,
			}) => {
				if self.requests >= self.maximum || !self.permitted.contains(&tool_id) {
					return LineVerdict::Malformed;
				}
				self.requests += 1;
				LineVerdict::ToolRequest {
					tool_id,
					args,
					call_id,
				}
			}
			Ok(AgentEvent::Usage { known_cost_usd }) => {
				self.cost = known_cost_usd;
				LineVerdict::Ignored
			}
			// The backend's report of its API's answer status travels unchanged (§4a).
			Ok(AgentEvent::Failed {
				code,
				retryable,
				upstream_status,
			}) => LineVerdict::Fatal {
				failure: with_upstream_status(
					ProviderFailure {
						code,
						retryable,
						upstream_status: None,
					},
					upstream_status,
				),
			},
			Ok(AgentEvent::Completed) => LineVerdict::Finished,
			Ok(AgentEvent::ToolResult { .. } | AgentEvent::UiCommand { .. }) => {
				LineVerdict::Ignored
			}
		}
	}
	fn conclude(&mut self, exit: &ProcessExit, _: usize) -> TurnConclusion {
		TurnConclusion {
			failure: Some(ProviderFailure::new(if exit.code == Some(0) {
				"PROVIDER_OUTPUT_INVALID"
			} else {
				"PROVIDER_EXIT_NONZERO"
			})),
			trailing_text: String::new(),
			known_cost_usd: self.cost,
		}
	}
	fn terminal_cost(&self) -> Option<f64> {
		self.cost
	}
}
#[async_trait]
impl AgentRuntime for ExternalProcessRuntime {
	fn agent_id(&self) -> &str {
		&self.config.agent_id
	}
	fn display_name(&self) -> &str {
		&self.config.display_name
	}
	fn cost_model(&self) -> CostModel {
		self.config.cost_model
	}
	fn tool_isolation(&self) -> ToolIsolation {
		self.config.tool_isolation
	}
	async fn probe(&self) -> AgentProbe {
		let result = capture_command(
			&self.environment.process_runner,
			self.spec(
				"probe",
				String::new(),
				tokio_util::sync::CancellationToken::new(),
			),
		)
		.await;
		if let Capture::Exited {
			code: Some(0),
			ref stdout,
			..
		} = result
		{
			if let Some(probe) = parse_probe(stdout) {
				return probe;
			}
		}
		AgentProbe {
			capabilities: AgentCapabilities {
				supported: vec![],
				model: None,
				models: None,
			},
			availability: if matches!(result, Capture::HelperMissing) {
				helper_missing()
			} else if matches!(result, Capture::NotInstalled) {
				unavailable(
					UnavailableReason::NotInstalled,
					"External agent command was not found on PATH",
				)
			} else {
				unavailable(
					UnavailableReason::ProbeFailed,
					"External agent did not report a valid protocol 1 probe",
				)
			},
		}
	}
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn {
		let deadline = match preflight_turn(&request, &context, now_ms()) {
			Ok(v) => v,
			Err(f) => return AgentTurn::from_events(vec![f.event()]),
		};
		let stdin = match encode_run_request(&request, &context) {
			Ok(v) => v,
			Err(_) => {
				return AgentTurn::from_events(vec![
					ProviderFailure::new("REQUEST_INVALID").event(),
				]);
			}
		};
		run_cli_turn(
			self.environment.process_runner.clone(),
			self.spec("run", stdin, context.cancel),
			Box::new(ExternalEventInterpreter::new(&request)),
			deadline,
		)
	}
}
/// Reads only the explicitly configured file; absence means no external backends.
pub fn load_external_runtimes(
	environment: &ProviderEnvironment,
) -> Result<Vec<Arc<dyn AgentRuntime>>, ExternalConfigError> {
	let Some(path) = environment.env.get("RESEARCH_EXTERNAL_AGENTS") else {
		return Ok(vec![]);
	};
	parse_external_configs(&std::fs::read_to_string(path)?).map(|configs| {
		configs
			.into_iter()
			.map(|c| {
				Arc::new(ExternalProcessRuntime::new(c, environment.clone()))
					as Arc<dyn AgentRuntime>
			})
			.collect()
	})
}
