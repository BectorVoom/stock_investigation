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
mod tests {
	use super::*;
	use crate::tools::{
		IdAllocator, ToolCostCategory, ToolMeta, ToolNetworkAllowlist, ToolSideEffect,
	};
	use async_trait::async_trait;
	use research_js::json::Object;
	use std::sync::Mutex;
	use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
	use tokio_util::sync::CancellationToken;

	/// How a scripted tool behaves once executed.
	enum Behaviour {
		Text,
		Fail,
		Panic,
		Never,
		/// Sleeps past any timeout, then raises the flag (an archive write).
		LateSideEffect(Arc<AtomicBool>),
		/// Waits for its cancellation and records that it saw it.
		WaitsForCancel(Arc<AtomicBool>),
	}

	struct Search {
		meta: ToolMeta,
		behaviour: Behaviour,
		executions: AtomicUsize,
		seen_ids: Mutex<Vec<String>>,
	}

	fn meta(tool_id: &'static str, timeout_ms: u64) -> ToolMeta {
		ToolMeta {
			tool_id,
			version: "1.0.0",
			description: "Searches subscribed news sources.",
			args_hint: "{\"query\": string, \"limit\"?: number}",
			timeout_ms,
			permission: "research-read",
			cost_category: ToolCostCategory::Free,
			side_effect: ToolSideEffect::ExternalRead,
			network_allowlist: ToolNetworkAllowlist::SubscribedSources,
		}
	}

	fn search(tool_id: &'static str, timeout_ms: u64, behaviour: Behaviour) -> Arc<Search> {
		Arc::new(Search {
			meta: meta(tool_id, timeout_ms),
			behaviour,
			executions: AtomicUsize::new(0),
			seen_ids: Mutex::new(Vec::new()),
		})
	}

	#[async_trait]
	impl Tool for Search {
		fn meta(&self) -> &ToolMeta {
			&self.meta
		}
		/// `z.strictObject({query: string 1..200, limit: int 1..20 default 5})`.
		fn parse_args(&self, args: &Value) -> Option<Value> {
			let Value::Object(object) = args else {
				return None;
			};
			let mut parsed = Object::new();
			let Some(Value::String(query)) = object.get("query") else {
				return None;
			};
			if query.is_empty() || query.chars().count() > 200 {
				return None;
			}
			parsed.insert("query", Value::String(query.clone()));
			let limit = match object.get("limit") {
				None => 5.0,
				Some(Value::Number(n)) if n.fract() == 0.0 && (1.0..=20.0).contains(n) => *n,
				Some(_) => return None,
			};
			parsed.insert("limit", Value::Number(limit));
			(object.len() == if object.get("limit").is_some() { 2 } else { 1 })
				.then_some(Value::Object(parsed))
		}
		async fn execute(
			&self,
			args: Value,
			context: ToolContext,
		) -> Result<ToolOutput, ToolFailure> {
			self.executions.fetch_add(1, Ordering::SeqCst);
			let ids = vec![context.ids.next_id("ev"), context.ids.next_id("ev")];
			self.seen_ids.lock().unwrap().extend(ids);
			match &self.behaviour {
				Behaviour::Text => Ok(ToolOutput {
					model_text: format!("results for {}", research_js::json::stringify(&args)),
					..ToolOutput::default()
				}),
				Behaviour::Fail => Err(failure("FETCH_FAILED", "upstream 503", true)),
				Behaviour::Panic => panic!("secret token sk-test-123 leaked in message"),
				Behaviour::Never => std::future::pending().await,
				Behaviour::LateSideEffect(flag) => {
					tokio::time::sleep(Duration::from_secs(3600)).await;
					flag.store(true, Ordering::SeqCst);
					Ok(ToolOutput::default())
				}
				Behaviour::WaitsForCancel(flag) => {
					context.cancel.cancelled().await;
					flag.store(true, Ordering::SeqCst);
					Err(failure("CANCELLED", "cancelled by owner", false))
				}
			}
		}
	}

	struct Ids(Mutex<u64>);
	impl IdAllocator for Ids {
		fn next_id(&self, prefix: &str) -> String {
			let mut counter = self.0.lock().unwrap();
			*counter += 1;
			format!("run_1_{prefix}{counter}")
		}
	}

	fn context(cancel: CancellationToken) -> ToolContext {
		ToolContext {
			run_id: "run_1".to_owned(),
			cancel,
			now_iso: Arc::new(|| "2026-10-11T00:00:00.000Z".to_owned()),
			ids: Arc::new(Ids(Mutex::new(0))),
			subscribed_sources: Arc::from(Vec::new()),
		}
	}

	fn query(text: &str) -> Value {
		let mut object = Object::new();
		object.insert("query", Value::String(text.to_owned()));
		Value::Object(object)
	}

	fn permitted(ids: &[&str]) -> HashSet<String> {
		ids.iter().map(|id| (*id).to_owned()).collect()
	}

	fn authorize(
		registry: &ToolRegistry,
		permitted: &HashSet<String>,
		remaining: i128,
		tool_id: &str,
		args: Value,
	) -> Result<AuthorizedToolCall, ToolDenialCode> {
		authorize_tool_call(
			registry,
			ToolPolicy {
				permitted_tool_ids: permitted,
				remaining_tool_calls: remaining,
			},
			&ToolRequest {
				tool_id: tool_id.to_owned(),
				args,
			},
		)
	}

	fn authorized(tool: &Arc<Search>) -> AuthorizedToolCall {
		let registry = ToolRegistry::new(vec![Arc::clone(tool) as Arc<dyn Tool>]).unwrap();
		authorize(
			&registry,
			&permitted(&[tool.meta.tool_id]),
			3,
			tool.meta.tool_id,
			query("battery demand"),
		)
		.ok()
		.unwrap()
	}

	#[test]
	fn registry_lists_in_order_and_refuses_duplicates() {
		let search_tool = search("news.search", 5000, Behaviour::Text);
		let filings = search("filings.lookup", 5000, Behaviour::Text);
		let registry = ToolRegistry::new(vec![
			Arc::clone(&search_tool) as Arc<dyn Tool>,
			Arc::clone(&filings) as Arc<dyn Tool>,
		])
		.unwrap();
		let order: Vec<_> = registry.list().iter().map(|t| t.meta().tool_id).collect();
		assert_eq!(order, ["news.search", "filings.lookup"]);
		assert!(registry.get("filings.lookup").is_some());
		for id in [
			"shell",
			"",
			"constructor",
			"__proto__",
			"toString",
			"NEWS.SEARCH",
		] {
			assert!(registry.get(id).is_none(), "{id}");
		}
		let duplicate = ToolRegistry::new(vec![
			Arc::clone(&search_tool) as Arc<dyn Tool>,
			search("news.search", 5000, Behaviour::Text) as Arc<dyn Tool>,
		]);
		assert_eq!(
			duplicate.err().unwrap().to_string(),
			"duplicate tool id \"news.search\""
		);
	}

	#[test]
	fn authorization_checks_run_in_the_observable_order() {
		let tools: Vec<Arc<dyn Tool>> = vec![
			search("news.search", 5000, Behaviour::Text),
			search("filings.lookup", 5000, Behaviour::Text),
		];
		let registry = ToolRegistry::new(tools).unwrap();
		let allowed = permitted(&["news.search", "shell"]);
		let denial = |remaining, id: &str, args| {
			authorize(&registry, &allowed, remaining, id, args)
				.err()
				.unwrap()
		};
		// Unregistered wins even when the allowlist names the tool.
		assert_eq!(denial(3, "shell", Value::Null), ToolDenialCode::UnknownTool);
		assert_eq!(
			denial(3, "NEWS.SEARCH", Value::Null),
			ToolDenialCode::UnknownTool
		);
		// Permission before budget before arguments.
		assert_eq!(
			denial(0, "filings.lookup", query("x")),
			ToolDenialCode::ToolNotPermitted
		);
		assert_eq!(
			denial(0, "news.search", Value::Null),
			ToolDenialCode::ToolCallBudgetExhausted
		);
		assert_eq!(
			denial(-100, "news.search", query("x")),
			ToolDenialCode::ToolCallBudgetExhausted
		);
		for args in [Value::Null, query(""), Value::Array(vec![])] {
			assert_eq!(denial(1, "news.search", args), ToolDenialCode::InvalidArgs);
		}
		let call = authorize(
			&registry,
			&allowed,
			1,
			"news.search",
			query("battery demand"),
		)
		.ok()
		.unwrap();
		// The parsed arguments come back with the schema default applied.
		assert_eq!(
			research_js::json::stringify(&call.args),
			"{\"query\":\"battery demand\",\"limit\":5}"
		);
	}

	#[tokio::test]
	async fn authorizing_never_executes_the_tool() {
		let tool = search("news.search", 5000, Behaviour::Text);
		let _ = authorized(&tool);
		assert_eq!(tool.executions.load(Ordering::SeqCst), 0);
	}

	#[tokio::test]
	async fn runs_the_tool_and_passes_the_run_context_through() {
		let tool = search("news.search", 5000, Behaviour::Text);
		let output = execute_tool_call(authorized(&tool), context(CancellationToken::new()))
			.await
			.unwrap();
		assert_eq!(
			output.model_text,
			"results for {\"query\":\"battery demand\",\"limit\":5}"
		);
		assert_eq!(*tool.seen_ids.lock().unwrap(), ["run_1_ev1", "run_1_ev2"]);
	}

	#[tokio::test]
	async fn returns_a_typed_failure_unchanged() {
		let tool = search("news.search", 5000, Behaviour::Fail);
		let error = execute_tool_call(authorized(&tool), context(CancellationToken::new()))
			.await
			.unwrap_err();
		assert_eq!(error, failure("FETCH_FAILED", "upstream 503", true));
	}

	#[tokio::test]
	async fn a_panic_becomes_tool_threw_without_leaking_its_message() {
		let tool = search("news.search", 5000, Behaviour::Panic);
		let error = execute_tool_call(authorized(&tool), context(CancellationToken::new()))
			.await
			.unwrap_err();
		assert_eq!(error, failure("TOOL_THREW", "panic", false));
		assert!(!format!("{error:?}").contains("sk-test-123"));
	}

	#[tokio::test]
	async fn revalidates_arguments_at_the_execution_boundary() {
		let tool = search("news.search", 5000, Behaviour::Text);
		for args in [Value::Null, Value::Object(Object::new()), query("")] {
			let call = AuthorizedToolCall {
				tool: Arc::clone(&tool) as Arc<dyn Tool>,
				args,
			};
			let error = execute_tool_call(call, context(CancellationToken::new()))
				.await
				.unwrap_err();
			assert_eq!(
				error,
				failure("INVALID_ARGS", "arguments failed validation", false)
			);
		}
		assert_eq!(tool.executions.load(Ordering::SeqCst), 0);
	}

	#[tokio::test(start_paused = true)]
	async fn a_tool_that_never_returns_times_out_retryable() {
		let tool = search("news.search", 15, Behaviour::Never);
		let error = execute_tool_call(authorized(&tool), context(CancellationToken::new()))
			.await
			.unwrap_err();
		assert_eq!(
			error,
			failure("TOOL_TIMEOUT", "tool exceeded its time limit", true)
		);
	}

	/// ADR-0030 C3: the timed-out future is dropped, so its late write never
	/// happens (the TypeScript let `web.fetch_page` write its archive).
	#[tokio::test(start_paused = true)]
	async fn a_timed_out_tool_is_cancelled_and_never_completes_its_side_effect() {
		let wrote = Arc::new(AtomicBool::new(false));
		let tool = search(
			"news.search",
			15,
			Behaviour::LateSideEffect(Arc::clone(&wrote)),
		);
		let error = execute_tool_call(authorized(&tool), context(CancellationToken::new()))
			.await
			.unwrap_err();
		assert_eq!(error.code, "TOOL_TIMEOUT");
		tokio::time::sleep(Duration::from_secs(7200)).await;
		assert!(!wrote.load(Ordering::SeqCst), "late side effect ran");
	}

	#[tokio::test(start_paused = true)]
	async fn the_timeout_does_not_cancel_the_callers_token() {
		let parent = CancellationToken::new();
		let tool = search("news.search", 15, Behaviour::Never);
		let _ = execute_tool_call(authorized(&tool), context(parent.clone())).await;
		assert!(!parent.is_cancelled());
	}

	#[tokio::test]
	async fn caller_cancellation_reaches_the_tool_and_is_not_a_timeout() {
		let parent = CancellationToken::new();
		let saw_cancel = Arc::new(AtomicBool::new(false));
		let tool = search(
			"news.search",
			60_000,
			Behaviour::WaitsForCancel(Arc::clone(&saw_cancel)),
		);
		let call = authorized(&tool);
		let canceller = parent.clone();
		let pending = tokio::spawn(execute_tool_call(call, context(parent)));
		while tool.executions.load(Ordering::SeqCst) == 0 {
			tokio::task::yield_now().await;
		}
		canceller.cancel();
		let error = pending.await.unwrap().unwrap_err();
		assert_eq!(error, failure("TOOL_ABORTED", "run was cancelled", false));
	}

	#[tokio::test]
	async fn a_run_cancelled_before_the_call_is_aborted_at_once() {
		let parent = CancellationToken::new();
		parent.cancel();
		let tool = search("news.search", 60_000, Behaviour::Text);
		let error = execute_tool_call(authorized(&tool), context(parent))
			.await
			.unwrap_err();
		assert_eq!(error, failure("TOOL_ABORTED", "run was cancelled", false));
	}
}
