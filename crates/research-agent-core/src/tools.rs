//! The research tool port (`packages/agent-core/src/tools.ts`).
//!
//! Tools are plain values behind the [`Tool`] trait: the orchestrator
//! authorizes calls against its own allowlist and budget before any tool
//! code runs (AGT-006), and every call re-validates its arguments.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use research_contracts::jobs::SubscribedSourceRef;
use research_contracts::records::{
	Evidence, FinancialObservation, IngestedArticle, InvestorFiling, PositionObservation, Security,
};
use research_js::json::Value;
use tokio_util::sync::CancellationToken;

/// Evidence plus the full retrieved text, kept in memory only for quote
/// verification (`CollectedEvidence`).
#[derive(Clone, Debug, PartialEq)]
pub struct CollectedEvidence {
	/// The evidence record.
	pub evidence: Evidence,
	/// The full retrieved text (never stored unless quotes may be retained).
	pub retrieved_text: String,
	/// Whether a verbatim passage from this evidence may be stored with a
	/// claim (DATA-010). False for sources licensed for headline and link
	/// only: such text may be read for verification during the run but is
	/// not retained.
	pub retain_quotes: bool,
}

/// Uniform tool output, so the orchestrator needs no per-tool knowledge
/// (ARCH-006).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolOutput {
	/// Bounded text shown to the model. It is untrusted data, never instructions.
	pub model_text: String,
	/// Evidence collected by the call.
	pub evidence: Vec<CollectedEvidence>,
	/// Securities identified.
	pub securities: Vec<Security>,
	/// Financial observations.
	pub financial_observations: Vec<FinancialObservation>,
	/// Position observations.
	pub position_observations: Vec<PositionObservation>,
	/// Investor filings.
	pub investor_filings: Vec<InvestorFiling>,
	/// Articles ingested.
	pub articles: Vec<IngestedArticle>,
}

/// A failed tool call (`ToolFailure`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolFailure {
	/// Stable code, e.g. `"UNSAFE_URL"`.
	pub code: String,
	/// Log-safe detail.
	pub detail: String,
	/// Whether repeating the call may succeed.
	pub retryable: bool,
	/// The status the external service the tool called answered with,
	/// unchanged (docs/rule/error_handling.md §4a). `None` when nothing
	/// answered or the failure is the tool's own.
	pub upstream_status: Option<u16>,
}

/// Billing/limit class of a tool (`ToolCostCategory`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCostCategory {
	/// `"free"`.
	Free,
	/// `"rate-limited"`.
	RateLimited,
	/// `"metered"`.
	Metered,
}

/// What a tool does besides reading (`ToolSideEffect`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolSideEffect {
	/// `"none"`.
	None,
	/// `"external-read"`.
	ExternalRead,
	/// `"external-read+archive-write"`.
	ExternalReadArchiveWrite,
}

/// Hosts a tool may contact (`ToolNetworkAllowlist`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolNetworkAllowlist {
	/// No network.
	None,
	/// A fixed list.
	Hosts(Vec<String>),
	/// The hosts of the owner's subscribed sources.
	SubscribedSources,
	/// The public web.
	PublicWeb,
}

/// A tool's static description (the `ToolDefinition` fields).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolMeta {
	/// Stable id, e.g. `"web.search"`.
	pub tool_id: &'static str,
	/// Semantic version.
	pub version: &'static str,
	/// Shown to the model in the tool catalog.
	pub description: &'static str,
	/// JSON-ish description of the arguments, shown to the model.
	pub args_hint: &'static str,
	/// The tool's own time limit.
	pub timeout_ms: u64,
	/// Always `"research-read"` today.
	pub permission: &'static str,
	/// Cost class.
	pub cost_category: ToolCostCategory,
	/// Side effect.
	pub side_effect: ToolSideEffect,
	/// Network allowlist.
	pub network_allowlist: ToolNetworkAllowlist,
}

/// Run-scoped id allocation: `next_id("ev")` → `"<runId>_ev3"`, one counter
/// per prefix shared by the pipeline and every tool of the run.
pub trait IdAllocator: Send + Sync {
	/// The next id with this prefix.
	fn next_id(&self, prefix: &str) -> String;
}

/// Per-call context (`ToolContext`).
#[derive(Clone)]
pub struct ToolContext {
	/// The run id.
	pub run_id: String,
	/// The call's cancellation: the run's token combined with the tool's
	/// time limit by `execute_tool_call`.
	pub cancel: CancellationToken,
	/// `Date.prototype.toISOString` of now.
	pub now_iso: Arc<dyn Fn() -> String + Send + Sync>,
	/// Run-scoped id allocation.
	pub ids: Arc<dyn IdAllocator>,
	/// The owner's subscribed sources.
	pub subscribed_sources: Arc<[SubscribedSourceRef]>,
}

impl fmt::Debug for ToolContext {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ToolContext")
			.field("run_id", &self.run_id)
			.field("cancelled", &self.cancel.is_cancelled())
			.field("subscribed_sources", &self.subscribed_sources.len())
			.finish_non_exhaustive()
	}
}

/// A research tool (`ToolDefinition`).
#[async_trait]
pub trait Tool: Send + Sync {
	/// Static description.
	fn meta(&self) -> &ToolMeta;
	/// Validates `args` exactly like the tool's zod `argsSchema.safeParse`
	/// and returns the parsed value (with zod's trims and defaults applied);
	/// `None` when validation fails (→ `INVALID_ARGS`).
	fn parse_args(&self, args: &Value) -> Option<Value>;
	/// Runs one call with arguments that passed [`Tool::parse_args`]. Expected
	/// failures are `Err`; a panic is caught by `execute_tool_call`.
	async fn execute(&self, args: Value, context: ToolContext) -> Result<ToolOutput, ToolFailure>;
}
