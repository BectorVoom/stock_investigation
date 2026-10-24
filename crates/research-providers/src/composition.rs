//! Backend composition is additive; the orchestrator does not switch on backend ids.
use crate::{
	claude_api::ClaudeApiRuntime,
	claude_code::ClaudeCodeRuntime,
	codex::CodexRuntime,
	environment::ProviderEnvironment,
	external::{ExternalConfigError, load_external_runtimes},
	opencode::OpenCodeRuntime,
	openrouter::OpenRouterRuntime,
};
use research_agent_core::runtime::AgentRuntime;
use std::sync::Arc;

/// Baseline ids in contract order; live E2E uses precisely these four backends.
pub fn create_baseline_agent_runtimes(
	environment: ProviderEnvironment,
) -> Vec<Arc<dyn AgentRuntime>> {
	vec![
		Arc::new(OpenCodeRuntime::new(environment.clone())),
		Arc::new(CodexRuntime::new(environment.clone())),
		Arc::new(ClaudeCodeRuntime::new(environment.clone())),
		Arc::new(OpenRouterRuntime::new(environment)),
	]
}
/// Production defaults to six backends (the baseline four, OpenRouter free models, the
/// Claude API — the order of `createAgentRuntimes`); external-only/baseline modes support FR-013.
pub fn create_agent_runtimes(
	environment: ProviderEnvironment,
) -> Result<Vec<Arc<dyn AgentRuntime>>, ExternalConfigError> {
	let set = environment
		.env
		.get("RESEARCH_AGENT_SET")
		.map_or("all", String::as_str);
	let mut runtimes = match set {
		"external-only" => vec![],
		"all" | "baseline" => create_baseline_agent_runtimes(environment.clone()),
		_ => return Err(ExternalConfigError::Invalid("RESEARCH_AGENT_SET")),
	};
	if set == "all" {
		runtimes.push(Arc::new(OpenRouterRuntime::free(environment.clone())));
		runtimes.push(Arc::new(ClaudeApiRuntime::new(environment.clone())));
	}
	if set != "baseline" {
		runtimes.extend(load_external_runtimes(&environment)?);
	}
	Ok(runtimes)
}
