//! Codex text-only backend; tool isolation remains honestly unverified.
use crate::{
	cli_probe::*, cli_turn::*, environment::*, opencode::fatal, process::*, schema::*, turn::*,
};
use async_trait::async_trait;
use research_agent_core::runtime::*;
use research_contracts::agent::*;
use research_js::json::Value;
use std::path::PathBuf;

/// Tool and ambient extension feature flags disabled in the verified CLI version.
pub const CODEX_DISABLED_FEATURES: &[&str] = &[
	"shell_tool",
	"unified_exec",
	"apps",
	"plugins",
	"remote_plugin",
	"hooks",
	"multi_agent",
	"browser_use",
	"browser_use_external",
	"computer_use",
	"image_generation",
	"view_image",
	"memories",
	"skill_search",
	"tool_suggest",
	"goals",
	"sleep_tool",
	"in_app_browser",
	"code_mode_host",
	"workspace_dependencies",
	"skill_mcp_dependency_install",
];
/// Output budget for `codex debug models`: one JSON line carrying every model's
/// instructions (about 560 KB for 9 models in codex-cli 0.163.0).
pub const CODEX_MODEL_CATALOG_MAX_CHARS: usize = 4 * 1024 * 1024;
/// Model ids in Codex model-picker order: visibility "list", ascending priority
/// (none = last), catalog order on ties; odd entries and invalid ids are skipped
/// one by one and duplicates keep their first place. None when not a catalog.
pub fn parse_codex_model_catalog(text: &str) -> Option<Vec<String>> {
	let value = parse(text).ok()?;
	let entries = value.as_object()?.get("models")?.as_array()?;
	let mut listed: Vec<(&str, f64)> = Vec::new();
	for entry in entries {
		let parse_entry = || -> Result<Option<(&str, f64)>, Malformed> {
			let entry = object(entry)?;
			let slug = string(entry, "slug")?;
			let visibility = optional_string(entry, "visibility")?;
			let priority = match entry.get("priority") {
				None => f64::INFINITY,
				Some(v) => v.as_f64().filter(|p| p.is_finite()).ok_or(Malformed)?,
			};
			Ok((visibility == Some("list") && is_valid_model_id(slug)).then_some((slug, priority)))
		};
		if let Ok(Some(item)) = parse_entry() {
			listed.push(item);
		}
	}
	// Stable sort: equal priorities keep catalog order, as in JavaScript.
	listed.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
	let mut seen = std::collections::HashSet::new();
	Some(
		listed
			.into_iter()
			.filter(|(slug, _)| seen.insert(*slug))
			.take(300)
			.map(|(slug, _)| slug.to_owned())
			.collect(),
	)
}
/// Exact literal argv, including quoted TOML values and final stdin marker.
pub fn build_codex_args(scratch: &str, model: Option<&str>, effort: Effort) -> Vec<String> {
	let mut args: Vec<_> = [
		"exec",
		"--json",
		"--color",
		"never",
		"--sandbox",
		"read-only",
		"--skip-git-repo-check",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"-C",
		scratch,
		"-c",
		"approval_policy=\"never\"",
		"-c",
		"web_search=\"disabled\"",
		"-c",
		"mcp_servers={}",
		"-c",
		"notify=[]",
		"-c",
		"project_doc_max_bytes=0",
		"-c",
		"shell_environment_policy.inherit=\"none\"",
		"-c",
	]
	.into_iter()
	.map(str::to_owned)
	.collect();
	args.push(format!("model_reasoning_effort=\"{}\"", effort.as_str()));
	for feature in CODEX_DISABLED_FEATURES {
		args.push("--disable".to_owned());
		args.push((*feature).to_owned());
	}
	if let Some(model) = model {
		args.extend(["-m".to_owned(), model.to_owned()]);
	}
	args.push("-".to_owned());
	args
}
/// Per-turn sequential Codex interpreter.
#[derive(Default)]
pub struct CodexInterpreter {
	join: SegmentJoiner,
	completed: bool,
	failure_message: Option<String>,
}
impl CodexInterpreter {
	fn interpret(&mut self, value: &Value) -> Result<LineVerdict, Malformed> {
		let value = object(value)?;
		let kind = string(value, "type")?;
		if kind.starts_with("item.") {
			let item = object(value.get("item").ok_or(Malformed)?)?;
			let ty = string(item, "type")?;
			let text = optional_string(item, "text")?;
			if !["agent_message", "reasoning", "error", "todo_list"].contains(&ty) {
				return Ok(fatal("PROVIDER_TOOL_ISOLATION_VIOLATED"));
			}
			return Ok(if kind == "item.completed" && ty == "agent_message" {
				LineVerdict::Text {
					text: self.join.join(text.unwrap_or("")),
				}
			} else {
				LineVerdict::Ignored
			});
		}
		if kind == "turn.completed" {
			self.completed = true;
		}
		if kind == "turn.failed" {
			self.failure_message = Some(
				optional_object(value, "error")
					.and_then(|v| v.map(|v| optional_string(v, "message")).transpose())
					.ok()
					.flatten()
					.flatten()
					.unwrap_or("")
					.to_owned(),
			);
		}
		Ok(LineVerdict::Ignored)
	}
}
impl CliStreamInterpreter for CodexInterpreter {
	fn interpret_line(&mut self, line: &str) -> LineVerdict {
		parse(line)
			.and_then(|v| self.interpret(&v))
			.unwrap_or(LineVerdict::Malformed)
	}
	fn conclude(&mut self, exit: &ProcessExit, emitted: usize) -> TurnConclusion {
		let failure = if exit.code == Some(0) && self.completed && self.failure_message.is_none() {
			if emitted > 0 {
				None
			} else {
				Some(ProviderFailure::new("PROVIDER_OUTPUT_EMPTY"))
			}
		} else {
			Some(
				hint_from_text(&format!(
					"{}\n{}",
					self.failure_message.as_deref().unwrap_or(""),
					exit.stderr_tail
				))
				.map_or_else(
					|| {
						ProviderFailure::new(if exit.code != Some(0) {
							"PROVIDER_EXIT_NONZERO"
						} else if self.failure_message.is_none() {
							"PROVIDER_OUTPUT_INVALID"
						} else {
							"PROVIDER_ERROR"
						})
					},
					failure_for_hint,
				),
			)
		};
		TurnConclusion::new(failure)
	}
}
/// Subscription-only Codex runtime.
#[derive(Clone)]
pub struct CodexRuntime {
	environment: ProviderEnvironment,
}
impl CodexRuntime {
	/// No process environment or filesystem capability is inherited implicitly.
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
			command: "codex".to_owned(),
			args,
			cwd,
			env: build_child_env(&self.environment.env, &["CODEX_HOME"]),
			stdin,
			cancel,
		}
	}
}
#[async_trait]
impl AgentRuntime for CodexRuntime {
	fn agent_id(&self) -> &str {
		"codex"
	}
	fn display_name(&self) -> &str {
		"Codex"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::PlanLimited
	}
	fn tool_isolation(&self) -> ToolIsolation {
		ToolIsolation::Unverified
	}
	async fn probe(&self) -> AgentProbe {
		let mut capabilities = AgentCapabilities {
			supported: vec![],
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
			"Codex",
			[0.0, 160.0, 0.0],
		)
		.await
		{
			Err(a) => a,
			Ok(_) => {
				match capture_command(&self.environment.process_runner, spec(&["login", "status"]))
					.await
				{
					Capture::Exited {
						code,
						stdout,
						stderr_tail,
					} => {
						let text = format!("{stdout}\n{stderr_tail}");
						if code != Some(0) || contains_ascii_case(&text, "not logged in") {
							unavailable(
								UnavailableReason::NotAuthenticated,
								"Codex is not logged in; run `codex login`",
							)
						} else if contains_ascii_case(&text, "api key") {
							unavailable(
								UnavailableReason::NotConfigured,
								"Codex is logged in with a metered API key; this plan-limited adapter only runs on a ChatGPT login",
							)
						} else if !contains_ascii_case(&text, "logged in") {
							unavailable(
								UnavailableReason::ProbeFailed,
								"`codex login status` output was not understood",
							)
						} else {
							AgentAvailability::Available
						}
					}
					_ => unavailable(
						UnavailableReason::ProbeFailed,
						"`codex login status` did not complete",
					),
				}
			}
		};
		// Quota-free model-picker catalog for the settings selector; a failure omits the list.
		if availability == AgentAvailability::Available {
			if let Capture::Exited {
				code: Some(0),
				stdout,
				..
			} = capture_command_limited(
				&self.environment.process_runner,
				spec(&["debug", "models"]),
				CODEX_MODEL_CATALOG_MAX_CHARS,
			)
			.await
			{
				capabilities.models = parse_codex_model_catalog(&stdout);
			}
		}
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
		let args = build_codex_args(
			&scratch.to_string_lossy(),
			context.model.as_deref(),
			context.effort,
		);
		run_cli_turn(
			self.environment.process_runner.clone(),
			self.spec(args, scratch, request.prompt, context.cancel),
			Box::<CodexInterpreter>::default(),
			deadline,
		)
	}
}
