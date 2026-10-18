//! Tool authorization (AGT-006) and bounded execution (AGT-008, ADR-0030 C3).

use crate::tools::{Tool, ToolContext, ToolFailure, ToolOutput};
use futures_util::FutureExt;
use research_js::json::Value;
use std::{
	collections::{HashMap, HashSet},
	panic::AssertUnwindSafe,
	sync::Arc,
	time::Duration,
};

/// Tools in registration order, with constant-time lookup.
#[derive(Default, Clone)]
pub struct ToolRegistry {
	tools: Vec<Arc<dyn Tool>>,
	by_id: HashMap<&'static str, usize>,
}

/// A duplicate registration is a composition error.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("duplicate tool id \"{0}\"")]
pub struct DuplicateToolId(pub String);

impl ToolRegistry {
	/// Builds a registry, refusing duplicate ids.
	pub fn new(tools: Vec<Arc<dyn Tool>>) -> Result<Self, DuplicateToolId> {
		let mut by_id = HashMap::with_capacity(tools.len());
		for (index, tool) in tools.iter().enumerate() {
			if by_id.insert(tool.meta().tool_id, index).is_some() {
				return Err(DuplicateToolId(tool.meta().tool_id.to_owned()));
			}
		}
		Ok(Self { tools, by_id })
	}
	/// Looks up one registered tool.
	pub fn get(&self, id: &str) -> Option<&Arc<dyn Tool>> {
		self.by_id.get(id).and_then(|index| self.tools.get(*index))
	}
	/// All tools in registration order.
	pub fn list(&self) -> &[Arc<dyn Tool>] {
		&self.tools
	}
}

/// Per-run permission and remaining call allowance.
pub struct ToolPolicy<'a> {
	/// Tools advertised to this run.
	pub permitted_tool_ids: &'a HashSet<String>,
	/// Calls remaining (zero and negative both refuse).
	pub remaining_tool_calls: i128,
}

/// An untrusted tool request from the model.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolRequest {
	/// Requested registered id.
	pub tool_id: String,
	/// Untrusted arguments, checked before execution.
	pub args: Value,
}

/// Why authorization refused a call, in observable check order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ToolDenialCode {
	/// No such tool.
	#[error("UNKNOWN_TOOL")]
	UnknownTool,
	/// Tool outside the run's allowlist.
	#[error("TOOL_NOT_PERMITTED")]
	ToolNotPermitted,
	/// No calls left.
	#[error("TOOL_CALL_BUDGET_EXHAUSTED")]
	ToolCallBudgetExhausted,
	/// Tool's schema refused the arguments.
	#[error("INVALID_ARGS")]
	InvalidArgs,
}

/// A tool plus schema-parsed arguments (including defaults/transforms).
pub struct AuthorizedToolCall {
	/// Tool whose permission was checked.
	pub tool: Arc<dyn Tool>,
	/// Schema-parsed arguments.
	pub args: Value,
}

/// Authorizes outside the model: registered, permitted, budget, then schema.
pub fn authorize_tool_call(
	registry: &ToolRegistry,
	policy: ToolPolicy<'_>,
	request: &ToolRequest,
) -> Result<AuthorizedToolCall, ToolDenialCode> {
	let tool = registry
		.get(&request.tool_id)
		.ok_or(ToolDenialCode::UnknownTool)?;
	if !policy.permitted_tool_ids.contains(&request.tool_id) {
		return Err(ToolDenialCode::ToolNotPermitted);
	}
	if policy.remaining_tool_calls <= 0 {
		return Err(ToolDenialCode::ToolCallBudgetExhausted);
	}
	let args = tool
		.parse_args(&request.args)
		.ok_or(ToolDenialCode::InvalidArgs)?;
	Ok(AuthorizedToolCall {
		tool: Arc::clone(tool),
		args,
	})
}

fn failure(code: &str, detail: &str, retryable: bool) -> ToolFailure {
	ToolFailure {
		code: code.to_owned(),
		detail: detail.to_owned(),
		retryable,
	}
}

/// Runs under the tool timeout and run cancellation. C3 deliberately drops
/// the losing future, so a timed-out page cannot later write its archive.
/// Panics at this adapter boundary become `TOOL_THREW`, detail `panic`.
pub async fn execute_tool_call(
	call: AuthorizedToolCall,
	mut context: ToolContext,
) -> Result<ToolOutput, ToolFailure> {
	let cancel = context.cancel.child_token();
	context.cancel = cancel.clone();
	let _cancel_on_drop = cancel.clone().drop_guard();
	let timeout = tokio::time::sleep(Duration::from_millis(call.tool.meta().timeout_ms));
	tokio::pin!(timeout);
	if cancel.is_cancelled() {
		return Err(failure("TOOL_ABORTED", "run was cancelled", false));
	}
	let execution = AssertUnwindSafe(async {
		// defineTool revalidates even the parsed value at the execution boundary.
		let args = call
			.tool
			.parse_args(&call.args)
			.ok_or_else(|| failure("INVALID_ARGS", "arguments failed validation", false))?;
		call.tool.execute(args, context).await
	})
	.catch_unwind();
	tokio::select! {
		biased;
		() = &mut timeout => Err(failure("TOOL_TIMEOUT", "tool exceeded its time limit", true)),
		() = cancel.cancelled() => Err(failure("TOOL_ABORTED", "run was cancelled", false)),
		result = execution => match result {
			Ok(result) => result,
			Err(_) => Err(failure("TOOL_THREW", "panic", false)),
		},
	}
}

#[cfg(test)]
mod tests {}
