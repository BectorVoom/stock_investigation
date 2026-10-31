//! Jobs and the runner protocol (`packages/contracts/src/jobs.ts`): budgets
//! and usage, the research request, the research bundle, claims, heartbeats,
//! events and completions.

use research_js::json::Value;
use serde::Serialize;

use crate::Contract;
use crate::agent::{AgentDescriptor, agent_id};
use crate::equity_financials::{
	CLAIM_KEYS as FINANCIAL_SYNC_CLAIM_KEYS, EquityFilingResult, EquityProvider, EquitySyncClaim,
	EquitySyncIdentity, claim_rules as financial_sync_claim_rules,
	decode_claim_fields as decode_financial_sync_claim, equity_sync_completion_problem,
	filings as financial_filings, provider as equity_provider, scanned_days,
};
use crate::google_calendar::{
	AUTH_URL, DESIRED_DIGEST, GOOGLE_SYNC_MAX_EVENTS, GoogleCalendarAction, GoogleEventBody,
	google_calendar_id,
};
use crate::json::{JsonObject, Record};
use crate::market::{
	MarketHistoryAnchor, MarketHistoryWrite, MarketObservation, MarketSeriesMeta,
	MarketUnavailableCode, limits as market_limits, market_series_id,
};
use crate::notebook::{Notebook, limits as notebook_limits};
use crate::patterns;
use crate::primitives::{ISO_DATE, ISO_DATE_TIME, Market, any_string, id, upstream_status};
use crate::records::{
	Claim, Dataset, DemandScenario, Evidence, FinancialObservation, IngestedArticle,
	InvestorFiling, LicensePolicy, PositionObservation, PricingPowerRecord, Security, SupplierLink,
};
use crate::stock_directory::{
	StockDirectoryEntry, limits as directory_limits, stock_directory_entries_problem,
};
use crate::ui::UiOperation;
use crate::watchlist::{
	EARNINGS_COMPANY_NAME_MAX, EarningsEvent, EarningsUnavailableCode, WatchMarket,
	limits as earnings_limits, watchlist_stock_id,
};
use crate::zod::{
	ArrCheck, Cx, Flow, IssueCode, NumCheck, StrCheck, Tri, array, boolean, decode_fields,
	decode_object, js_enum, nullable, nullish, number, number_literals, optional, record, refine,
	run_array, run_discriminated, run_string, string, uint, unrecognized,
};

/// The job lifecycle is the domain's (`packages/contracts` re-exports it so
/// the Worker, the runner and the SPA share one transition matrix).
pub use research_domain::jobs::state_machine::{
	IllegalTransition, JOB_STATES, JobState, LEASED_JOB_STATES, TERMINAL_JOB_STATES, transition_job,
};

/// Budgets, usage and the cost summary are the domain's (`jobs/budget.ts`).
pub use research_domain::jobs::budget::{
	CostStatus, CostSummary, EMPTY_USAGE, ResearchBudget, ResourceUsage,
};

js_enum! {
	/// `leasedJobStateSchema` (`LEASED_JOB_STATES`).
	pub enum LeasedJobState {
		Claimed = "claimed",
		Planning = "planning",
		Collecting = "collecting",
		Analyzing = "analyzing",
		Verifying = "verifying",
		Publishing = "publishing",
	}
}

js_enum! {
	/// `jobKindSchema`.
	pub enum JobKind {
		Research = "research",
		NewsIngest = "news-ingest",
		MarketRefresh = "market-refresh",
		EarningsRefresh = "earnings-refresh",
		GoogleCalendar = "google-calendar",
		NotebookAssist = "notebook-assist",
		StockDirectoryRefresh = "stock-directory-refresh",
		FinancialSync = "financial-sync",
	}
}

/* ---------- Budget, usage ---------- */

/// `BUDGET_LIMITS`: (min, max, default) of each per-question limit.
pub mod budget_limits {
	/// Agent steps.
	pub const MAX_AGENT_STEPS: (u64, u64, u64) = (1, 12, 6);
	/// Tool calls.
	pub const MAX_TOOL_CALLS: (u64, u64, u64) = (0, 60, 20);
	/// Wall-clock milliseconds.
	pub const MAX_WALL_CLOCK_MS: (u64, u64, u64) = (30_000, 1_800_000, 600_000);
	/// Input bytes.
	pub const MAX_INPUT_BYTES: (u64, u64, u64) = (10_000, 2_000_000, 400_000);
	/// Spend ceiling in USD (min, max).
	pub const MAX_SPEND_USD: (f64, f64) = (0.0, 50.0);
}

/// `RUN_LIMITS`: the fixed ceilings every question runs under (ADR-0029),
/// each at its `BUDGET_LIMITS` maximum.
pub mod run_limits {
	use super::budget_limits;

	/// Agent steps.
	pub const MAX_AGENT_STEPS: u64 = budget_limits::MAX_AGENT_STEPS.1;
	/// Tool calls.
	pub const MAX_TOOL_CALLS: u64 = budget_limits::MAX_TOOL_CALLS.1;
	/// Wall-clock milliseconds.
	pub const MAX_WALL_CLOCK_MS: u64 = budget_limits::MAX_WALL_CLOCK_MS.1;
	/// Input bytes.
	pub const MAX_INPUT_BYTES: u64 = budget_limits::MAX_INPUT_BYTES.1;
}

/// `runBudget(maxSpendUsd)`: the fixed limits plus the owner's spend ceiling.
#[must_use]
pub const fn run_budget(max_spend_usd: Option<f64>) -> ResearchBudget {
	ResearchBudget {
		max_agent_steps: run_limits::MAX_AGENT_STEPS,
		max_tool_calls: run_limits::MAX_TOOL_CALLS,
		max_wall_clock_ms: run_limits::MAX_WALL_CLOCK_MS,
		max_input_bytes: run_limits::MAX_INPUT_BYTES,
		max_spend_usd,
	}
}

/// `researchBudgetSchema`.
impl Contract for ResearchBudget {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			max_agent_steps: "maxAgentSteps" => uint(&[NumCheck::Int, NumCheck::Gte(1.0), NumCheck::Lte(12.0)]),
			max_tool_calls: "maxToolCalls" => uint(&[NumCheck::Int, NumCheck::Gte(0.0), NumCheck::Lte(60.0)]),
			max_wall_clock_ms: "maxWallClockMs" => uint(&[NumCheck::Int, NumCheck::Gte(30_000.0), NumCheck::Lte(1_800_000.0)]),
			max_input_bytes: "maxInputBytes" => uint(&[NumCheck::Int, NumCheck::Gte(10_000.0), NumCheck::Lte(2_000_000.0)]),
			max_spend_usd: "maxSpendUsd" => nullable(number(&[NumCheck::Gte(0.0), NumCheck::Lte(50.0)])),
		})
	}
}

const NON_NEGATIVE_INT: &[NumCheck] = &[NumCheck::Int, NumCheck::Gte(0.0)];
const POSITIVE_INT: &[NumCheck] = &[NumCheck::Int, NumCheck::Gt(0.0)];

/// `resourceUsageSchema`.
impl Contract for ResourceUsage {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			agent_steps: "agentSteps" => uint(NON_NEGATIVE_INT),
			tool_calls: "toolCalls" => uint(NON_NEGATIVE_INT),
			input_bytes: "inputBytes" => uint(NON_NEGATIVE_INT),
			known_cost_usd: "knownCostUsd" => number(&[NumCheck::Gte(0.0)]),
			has_unmetered_usage: "hasUnmeteredUsage" => boolean,
		})
	}
}

/* ---------- Research request ---------- */

js_enum! {
	/// `effortSchema`.
	pub enum Effort {
		Low = "low",
		Medium = "medium",
		High = "high",
	}
}

js_enum! {
	/// `webAccessSchema` (ARCH-017: absent means "off").
	pub enum WebAccess {
		Off = "off",
		PublicWeb = "public-web",
	}
}

const QUESTION: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(3), StrCheck::Max(2000)];
const MODEL: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(100)];

/// `researchRequestSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRequest {
	/// Workspace id.
	pub workspace_id: String,
	/// Question (trimmed, 3..2000).
	pub question: String,
	/// Agent id.
	pub agent_id: String,
	/// Model (1..100), or null for the backend default.
	pub model: Option<String>,
	/// Effort.
	pub effort: Effort,
	/// 3, 4 or 5 years.
	pub horizon_years: f64,
	/// Markets (1..2).
	pub markets: Vec<Market>,
	/// Budget.
	pub budget: ResearchBudget,
	/// Web access (default "off", ARCH-017).
	pub web_access: WebAccess,
}

/// `webAccessSchema.default("off")`.
fn web_access(cx: &mut Cx, input: Option<&Value>) -> Option<WebAccess> {
	match input {
		None => Some(WebAccess::Off),
		Some(_) => WebAccess::decode(cx, input),
	}
}

impl ResearchRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			workspace_id: "workspaceId" => id,
			question: "question" => string(QUESTION),
			agent_id: "agentId" => agent_id,
			model: "model" => nullable(string(MODEL)),
			effort: "effort" => Effort::decode,
			horizon_years: "horizonYears" => number_literals(&[3.0, 4.0, 5.0]),
			markets: "markets" => array(Market::decode, &[ArrCheck::Min(1), ArrCheck::Max(2)]),
			budget: "budget" => ResearchBudget::decode,
			web_access: "webAccess" => web_access,
		})
	}
}

js_enum! {
	/// `verificationStatusSchema`.
	pub enum VerificationStatus {
		Verified = "verified",
		PartiallyVerified = "partially-verified",
		Unverified = "unverified",
	}
}

const PROVIDER_MODEL: &[StrCheck] = &[StrCheck::Max(100)];
const PROMPT_VERSION: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(40)];
const TOOL_ID_KEY: &[StrCheck] = &[StrCheck::Max(80)];
const TOOL_VERSION: &[StrCheck] = &[StrCheck::Max(20)];

/// `bundleProvenanceSchema` (AGT-010).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleProvenance {
	/// Agent id.
	pub agent_id: String,
	/// Provider model (≤ 100).
	pub provider_model: Option<String>,
	/// Prompt version (1..40).
	pub prompt_version: String,
	/// Tool id → version.
	pub tool_versions: Record<String>,
	/// Data cutoff.
	pub data_cutoff_at: String,
}

impl BundleProvenance {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			agent_id: "agentId" => agent_id,
			provider_model: "providerModel" => nullable(string(PROVIDER_MODEL)),
			prompt_version: "promptVersion" => string(PROMPT_VERSION),
			tool_versions: "toolVersions" => |cx: &mut Cx, input| record(TOOL_ID_KEY, string(TOOL_VERSION))(cx, input).map(Record),
			data_cutoff_at: "dataCutoffAt" => string(ISO_DATE_TIME),
		})
	}
}

/* ---------- Failure codes ---------- */

/// `stableFailureCodeSchema` (`STABLE_FAILURE_CODE_PATTERN`).
pub(crate) const STABLE_FAILURE_CODE: &[StrCheck] =
	&[StrCheck::Regex(&patterns::STABLE_FAILURE_CODE, None)];

/// The fallback for a tool error code that is not stable.
pub const TOOL_ERROR_FALLBACK_CODE: &str = "TOOL_ERROR";

/// `failureCodeTakesDetail`: a `failureDetail` accompanies only these codes.
#[must_use]
pub fn failure_code_takes_detail(failure_code: Option<&str>) -> bool {
	matches!(
		failure_code,
		Some("ALL_TOOL_CALLS_FAILED" | "NO_EVIDENCE_COLLECTED")
	)
}

/// Whether `code` has the stable failure-code shape.
#[must_use]
pub fn is_stable_failure_code(code: &str) -> bool {
	(patterns::STABLE_FAILURE_CODE.matches)(code)
}

/// `sanitizeToolErrorCode`: a code that is not stable becomes `TOOL_ERROR`.
#[must_use]
pub fn sanitize_tool_error_code(code: &str) -> &str {
	if is_stable_failure_code(code) {
		code
	} else {
		TOOL_ERROR_FALLBACK_CODE
	}
}

/* ---------- Research bundle ---------- */

/// `BUNDLE_LIMITS`.
pub mod bundle_limits {
	/// Evidence records.
	pub const EVIDENCE: usize = 80;
	/// Claims.
	pub const CLAIMS: usize = 80;
	/// Scenarios.
	pub const SCENARIOS: usize = 12;
	/// Securities.
	pub const SECURITIES: usize = 40;
	/// Supplier links.
	pub const SUPPLIER_LINKS: usize = 60;
	/// Financial observations.
	pub const FINANCIAL_OBSERVATIONS: usize = 200;
	/// Position observations.
	pub const POSITION_OBSERVATIONS: usize = 80;
	/// Investor filings.
	pub const INVESTOR_FILINGS: usize = 12;
	/// Pricing power records.
	pub const PRICING_POWER: usize = 40;
	/// Datasets.
	pub const DATASETS: usize = 8;
	/// Table cells across all datasets of one bundle.
	pub const DATASET_CELLS: usize = 3_000;
	/// UI operations.
	pub const UI_OPERATIONS: usize = 30;
	/// Ingested articles of one completion.
	pub const ARTICLES: usize = 400;
}

/// `countCells`: cells of every row of every dataset, by the loose probe
/// (`z.array(z.looseObject({rows: z.array(z.record(z.string(), z.unknown()))}))`);
/// a shape the probe cannot read counts 0 (the real schema rejects it).
fn count_cells(datasets: &[Value]) -> usize {
	let mut total = 0usize;
	for dataset in datasets {
		let Some(rows) = dataset
			.as_object()
			.and_then(|object| object.get("rows"))
			.and_then(Value::as_array)
		else {
			return 0;
		};
		for row in rows {
			let Some(row) = row.as_object() else { return 0 };
			// The record parse drops `__proto__`, so `Object.keys` never sees it.
			total += row.keys().filter(|key| *key != "__proto__").count();
		}
	}
	total
}

/// `boundedDatasets(8, 3000)`: a cheap size gate (count, then cells) in
/// front of the full validation, joined by a pipe — any gate issue stops it.
fn bounded_datasets(cx: &mut Cx, input: Option<&Value>) -> Option<Vec<Dataset>> {
	let mark = cx.mark();
	let accept_any = |_: &mut Cx, _: Option<&Value>| Some(());
	let gate = run_array(
		cx,
		input,
		&accept_any,
		&[ArrCheck::Max(bundle_limits::DATASETS)],
	);
	if gate.is_some()
		&& !cx.aborted_since(mark)
		&& let Some(items) = input.and_then(Value::as_array)
		&& count_cells(items) > bundle_limits::DATASET_CELLS
	{
		cx.push(
			IssueCode::Custom,
			"at most 3000 table cells are allowed".to_owned(),
			Flow::Continue,
		);
	}
	// The pipe forwards only when the gate raised nothing but unknown keys.
	if cx.has_issues_since(mark) {
		return None;
	}
	run_array(cx, input, &Dataset::decode, &[])
}

const ANSWER_TEXT: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(6000)];

/// `researchBundleSchema`: what a research run publishes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchBundle {
	/// Evidence (≤ 80).
	pub evidence: Vec<Evidence>,
	/// Claims (≤ 80).
	pub claims: Vec<Claim>,
	/// Scenarios (≤ 12).
	pub scenarios: Vec<DemandScenario>,
	/// Securities (≤ 40).
	pub securities: Vec<Security>,
	/// Supplier links (≤ 60).
	pub supplier_links: Vec<SupplierLink>,
	/// Financial observations (≤ 200).
	pub financial_observations: Vec<FinancialObservation>,
	/// Position observations (≤ 80).
	pub position_observations: Vec<PositionObservation>,
	/// Investor filings (≤ 12).
	pub investor_filings: Vec<InvestorFiling>,
	/// Pricing power (≤ 40).
	pub pricing_power: Vec<PricingPowerRecord>,
	/// Datasets (≤ 8, ≤ 3000 cells in all).
	pub datasets: Vec<Dataset>,
	/// UI operations, applied in order (≤ 30).
	pub ui_operations: Vec<UiOperation>,
	/// Plain-text answer (1..6000), never rendered as HTML.
	pub answer_text: String,
	/// Claims the answer cites (≤ 80).
	pub answer_claim_ids: Vec<String>,
	/// Verification status.
	pub verification_status: VerificationStatus,
	/// Provenance.
	pub provenance: BundleProvenance,
}

impl ResearchBundle {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		use bundle_limits as limits;
		decode_object!(cx, input, strict, [], Self {
			evidence: "evidence" => array(Evidence::decode, &[ArrCheck::Max(limits::EVIDENCE)]),
			claims: "claims" => array(Claim::decode, &[ArrCheck::Max(limits::CLAIMS)]),
			scenarios: "scenarios" => array(DemandScenario::decode, &[ArrCheck::Max(limits::SCENARIOS)]),
			securities: "securities" => array(Security::decode, &[ArrCheck::Max(limits::SECURITIES)]),
			supplier_links: "supplierLinks" => array(SupplierLink::decode, &[ArrCheck::Max(limits::SUPPLIER_LINKS)]),
			financial_observations: "financialObservations" => array(FinancialObservation::decode, &[ArrCheck::Max(limits::FINANCIAL_OBSERVATIONS)]),
			position_observations: "positionObservations" => array(PositionObservation::decode, &[ArrCheck::Max(limits::POSITION_OBSERVATIONS)]),
			investor_filings: "investorFilings" => array(InvestorFiling::decode, &[ArrCheck::Max(limits::INVESTOR_FILINGS)]),
			pricing_power: "pricingPower" => array(PricingPowerRecord::decode, &[ArrCheck::Max(limits::PRICING_POWER)]),
			datasets: "datasets" => bounded_datasets,
			ui_operations: "uiOperations" => array(UiOperation::decode, &[ArrCheck::Max(limits::UI_OPERATIONS)]),
			answer_text: "answerText" => string(ANSWER_TEXT),
			answer_claim_ids: "answerClaimIds" => array(id, &[ArrCheck::Max(limits::CLAIMS)]),
			verification_status: "verificationStatus" => VerificationStatus::decode,
			provenance: "provenance" => BundleProvenance::decode,
		})
	}
}

const ERROR_CODE_100: &[StrCheck] = &[StrCheck::Max(100)];

/// `sourceFetchReportSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFetchReport {
	/// Source id.
	pub source_id: String,
	/// Fetch time.
	pub fetched_at: String,
	/// Null on success; else a stable error code (≤ 100).
	pub error_code: Option<String>,
	/// The status the feed host answered with when it caused `error_code`,
	/// unchanged (docs/rule/error_handling.md §4a). Optional so a runner
	/// built before the field existed still reports.
	#[serde(skip_serializing_if = "Tri::is_absent")]
	pub upstream_status: Tri<u16>,
}

impl SourceFetchReport {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let decoded = decode_object!(cx, input, strict, [], Self {
			source_id: "sourceId" => id,
			fetched_at: "fetchedAt" => string(ISO_DATE_TIME),
			error_code: "errorCode" => nullable(string(ERROR_CODE_100)),
			upstream_status: "upstreamStatus" => nullish(upstream_status),
		});
		refine(cx, mark, decoded.as_ref(), |cx, report| {
			if report.upstream_status.value().is_some() && report.error_code.is_none() {
				cx.refine_failed(
					Some("upstreamStatus"),
					"upstreamStatus may be set only with an errorCode",
				);
			}
		});
		decoded
	}
}

/* ---------- Claims ---------- */

/// `subscribedSourceRefSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedSourceRef {
	/// Source id.
	pub source_id: String,
	/// Canonical URL (plain string).
	pub canonical_url: String,
	/// Publisher.
	pub publisher: String,
	/// Title.
	pub title: String,
	/// License policy.
	pub license_policy: LicensePolicy,
}

impl SubscribedSourceRef {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			source_id: "sourceId" => id,
			canonical_url: "canonicalUrl" => any_string,
			publisher: "publisher" => any_string,
			title: "title" => any_string,
			license_policy: "licensePolicy" => LicensePolicy::decode,
		})
	}
}

const RUNNER_VERSION: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(40)];

/// `claimJobRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimJobRequest {
	/// Runner version (1..40).
	pub runner_version: String,
	/// Every backend the runner knows (≤ 16), unavailable ones included.
	pub agents: Vec<AgentDescriptor>,
}

impl ClaimJobRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			runner_version: "runnerVersion" => string(RUNNER_VERSION),
			agents: "agents" => array(AgentDescriptor::decode, &[ArrCheck::Max(16)]),
		})
	}
}

/// `workspaceComponentSummarySchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceComponentSummary {
	/// Component id.
	pub component_id: String,
	/// Component type.
	pub component_type: String,
	/// Title, when the component has one.
	pub title: Option<String>,
}

impl WorkspaceComponentSummary {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			component_id: "componentId" => any_string,
			component_type: "componentType" => any_string,
			title: "title" => nullable(any_string),
		})
	}
}

/// `CONVERSATION_CONTEXT_LIMITS`.
pub mod conversation_context_limits {
	/// Messages.
	pub const MAX_MESSAGES: usize = 6;
	/// Characters of one message.
	pub const MAX_MESSAGE_CHARS: usize = 600;
	/// UTF-8 bytes of all messages.
	pub const MAX_TOTAL_BYTES: usize = 2_400;
}

js_enum! {
	/// Who wrote a conversation message.
	pub enum ConversationRole {
		Owner = "owner",
		Assistant = "assistant",
	}
}

const MESSAGE_TEXT: &[StrCheck] = &[
	StrCheck::Min(1),
	StrCheck::Max(conversation_context_limits::MAX_MESSAGE_CHARS),
];

/// `conversationContextMessageSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConversationContextMessage {
	/// Role.
	pub role: ConversationRole,
	/// Text (1..600).
	pub text: String,
}

impl ConversationContextMessage {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			role: "role" => ConversationRole::decode,
			text: "text" => string(MESSAGE_TEXT),
		})
	}
}

/// `conversationContextSchema`: at most 6 messages whose UTF-8 bytes sum to
/// at most 2 400 (a lone surrogate counts 3 bytes, as U+FFFD does here).
pub fn decode_conversation_context(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Vec<ConversationContextMessage>> {
	let mark = cx.mark();
	let messages = run_array(
		cx,
		input,
		&ConversationContextMessage::decode,
		&[ArrCheck::Max(conversation_context_limits::MAX_MESSAGES)],
	);
	refine(cx, mark, messages.as_ref(), |cx, messages| {
		let bytes: usize = messages.iter().map(|message| message.text.len()).sum();
		if bytes > conversation_context_limits::MAX_TOTAL_BYTES {
			cx.push(
				IssueCode::Custom,
				"conversation context must fit 2400 UTF-8 bytes".to_owned(),
				Flow::Continue,
			);
		}
	});
	messages
}

/// The lease shape every claimed job carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
	/// Run id.
	pub run_id: String,
	/// Lease generation (> 0).
	pub lease_generation: u64,
	/// Lease expiry.
	pub lease_expires_at: String,
	/// Attempt (> 0).
	pub attempt: u64,
	/// Heartbeat interval (> 0 ms).
	pub heartbeat_interval_ms: u64,
	/// Subscribed sources (≤ 200).
	pub sources: Vec<SubscribedSourceRef>,
}

const LEASE_KEYS: [&str; 6] = [
	"runId",
	"leaseGeneration",
	"leaseExpiresAt",
	"attempt",
	"heartbeatIntervalMs",
	"sources",
];

fn decode_lease(cx: &mut Cx, object: &research_js::json::Object) -> Option<Lease> {
	decode_fields!(cx, object, Lease {
		run_id: "runId" => id,
		lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
		lease_expires_at: "leaseExpiresAt" => |cx: &mut Cx, input| run_string(cx, input, ISO_DATE_TIME),
		attempt: "attempt" => uint(POSITIVE_INT),
		heartbeat_interval_ms: "heartbeatIntervalMs" => uint(POSITIVE_INT),
		sources: "sources" => array(SubscribedSourceRef::decode, &[ArrCheck::Max(200)]),
	})
}

/// A `research` job.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchJob {
	/// Lease.
	#[serde(flatten)]
	pub lease: Lease,
	/// The request.
	pub request: ResearchRequest,
	/// Usage of earlier attempts (budgets are per run).
	pub prior_usage: ResourceUsage,
	/// What is on the canvas (≤ 60).
	pub workspace_components: Vec<WorkspaceComponentSummary>,
	/// Earlier conversation, oldest first.
	pub conversation_context: Vec<ConversationContextMessage>,
}

/// The agent choice of a notebook-assist job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookAssistAgent {
	/// Agent id.
	pub agent_id: String,
	/// Model (1..100) or null.
	pub model: Option<String>,
	/// Effort.
	pub effort: Effort,
}

impl NotebookAssistAgent {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			agent_id: "agentId" => agent_id,
			model: "model" => nullable(string(MODEL)),
			effort: "effort" => Effort::decode,
		})
	}
}

const INSTRUCTION: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(notebook_limits::MAX_INSTRUCTION_CHARS),
];

/// A `notebook-assist` job (ADR-0020).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookAssistJob {
	/// Lease.
	#[serde(flatten)]
	pub lease: Lease,
	/// Workspace id.
	pub workspace_id: String,
	/// Agent choice saved in Settings.
	pub agent: NotebookAssistAgent,
	/// Owner instruction (trimmed, 1..2000).
	pub instruction: String,
	/// Selected widgets (≤ 12).
	pub selected_widget_ids: Vec<String>,
	/// The notebook as the owner saw it.
	pub notebook: Notebook,
	/// Its version.
	pub notebook_version: u64,
	/// Earlier conversation.
	pub conversation_context: Vec<ConversationContextMessage>,
}

/// One series of a `market-refresh` job.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRefreshSeries {
	/// Series id.
	pub series_id: String,
	/// Latest stored observation date.
	pub latest_observed_on: Option<String>,
	/// ADR-0044: the stored observation the window fetch must reproduce;
	/// `None` when nothing is stored (fetch everything).
	pub anchor: Option<MarketHistoryAnchor>,
	/// ADR-0044: fetch everything although the anchor is set (periodic full
	/// check); never true without an anchor.
	pub full_check: bool,
}

impl MarketRefreshSeries {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let decoded = decode_object!(cx, input, strict, [], Self {
			series_id: "seriesId" => market_series_id,
			latest_observed_on: "latestObservedOn" => nullable(string(ISO_DATE)),
			anchor: "anchor" => nullable(MarketHistoryAnchor::decode),
			full_check: "fullCheck" => boolean,
		});
		refine(cx, mark, decoded.as_ref(), |cx, entry| {
			if entry.anchor.is_none() && entry.full_check {
				cx.refine_failed(None, "fullCheck needs an anchor");
			}
		});
		decoded
	}
}

/// A `market-refresh` job.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MarketRefreshJob {
	/// Lease.
	#[serde(flatten)]
	pub lease: Lease,
	/// Series to refresh (≤ 60).
	pub series: Vec<MarketRefreshSeries>,
}

const COMPANY_NAME: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(EARNINGS_COMPANY_NAME_MAX),
];

/// One stock of an `earnings-refresh` job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningsRefreshStock {
	/// Stock id.
	pub stock_id: String,
	/// Stored company name, null when never retrieved.
	pub name: Option<String>,
}

impl EarningsRefreshStock {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			stock_id: "stockId" => watchlist_stock_id,
			name: "name" => nullable(string(COMPANY_NAME)),
		})
	}
}

/// An `earnings-refresh` job (FR-018).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningsRefreshJob {
	/// Lease.
	#[serde(flatten)]
	pub lease: Lease,
	/// Window start (UTC date).
	pub from_date: String,
	/// Window end (UTC date).
	pub to_date: String,
	/// Stocks (≤ 50).
	pub stocks: Vec<EarningsRefreshStock>,
}

/// A `google-calendar` job (FR-019): `sync` carries the three sync keys
/// (`calendarId` may be null); `connect` and `disconnect` carry none of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarJob {
	/// Lease.
	#[serde(flatten)]
	pub lease: Lease,
	/// The action.
	pub action: GoogleCalendarAction,
	/// Calendar id: absent, null (never connected) or an id.
	#[serde(skip_serializing_if = "Tri::is_absent")]
	pub calendar_id: Tri<String>,
	/// SHA-256 hex digest of the desired set.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub desired_digest: Option<String>,
	/// Desired event bodies (≤ 400).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub events: Option<Vec<GoogleEventBody>>,
}

/// A `stock-directory-refresh` job (ADR-0034): download one market's full
/// list of listed stocks (SEC for US, JPX for JP).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDirectoryRefreshJob {
	/// Lease.
	#[serde(flatten)]
	pub lease: Lease,
	/// The market whose list is downloaded.
	pub market: WatchMarket,
}

/// A `financial-sync` job (ADR-0048): synchronise one company's annual
/// financial statements, SEC for US and EDINET for JP.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FinancialSyncJob {
	/// Lease.
	#[serde(flatten)]
	pub lease: Lease,
	/// The company, the concepts and the provider request.
	#[serde(flatten)]
	pub claim: EquitySyncClaim,
}

/// `watchMarketSchema` decoder.
fn watch_market(cx: &mut Cx, input: Option<&Value>) -> Option<WatchMarket> {
	<WatchMarket as crate::Contract>::decode(cx, input)
}

/// `claimedJobSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum ClaimedJob {
	/// A research question.
	#[serde(rename = "research")]
	Research(ResearchJob),
	/// A news ingest.
	#[serde(rename = "news-ingest")]
	NewsIngest(Lease),
	/// A notebook-assistant turn.
	#[serde(rename = "notebook-assist")]
	NotebookAssist(NotebookAssistJob),
	/// A market refresh.
	#[serde(rename = "market-refresh")]
	MarketRefresh(MarketRefreshJob),
	/// An earnings refresh.
	#[serde(rename = "earnings-refresh")]
	EarningsRefresh(EarningsRefreshJob),
	/// A Google Calendar step.
	#[serde(rename = "google-calendar")]
	GoogleCalendar(GoogleCalendarJob),
	/// A stock-directory refresh (ADR-0034).
	#[serde(rename = "stock-directory-refresh")]
	StockDirectoryRefresh(StockDirectoryRefreshJob),
	/// A financial-statement sync of one company (ADR-0048).
	#[serde(rename = "financial-sync")]
	FinancialSync(FinancialSyncJob),
}

const JOB_KINDS: &[&str] = &[
	"research",
	"news-ingest",
	"notebook-assist",
	"market-refresh",
	"earnings-refresh",
	"google-calendar",
	"stock-directory-refresh",
	"financial-sync",
];

impl ClaimedJob {
	/// The lease of any job.
	#[must_use]
	pub const fn lease(&self) -> &Lease {
		match self {
			Self::Research(job) => &job.lease,
			Self::NewsIngest(lease) => lease,
			Self::NotebookAssist(job) => &job.lease,
			Self::MarketRefresh(job) => &job.lease,
			Self::EarningsRefresh(job) => &job.lease,
			Self::GoogleCalendar(job) => &job.lease,
			Self::StockDirectoryRefresh(job) => &job.lease,
			Self::FinancialSync(job) => &job.lease,
		}
	}

	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "kind", JOB_KINDS, |cx, tag| {
			let object = input.and_then(Value::as_object)?;
			// The google-calendar superRefine runs over this member's own issues.
			let mark = cx.mark();
			let lease = decode_lease(cx, object);
			match tag {
				0 => {
					let rest = decode_fields!(cx, object, ResearchRest {
						request: "request" => ResearchRequest::decode,
						prior_usage: "priorUsage" => ResourceUsage::decode,
						workspace_components: "workspaceComponents" => array(WorkspaceComponentSummary::decode, &[ArrCheck::Max(60)]),
						conversation_context: "conversationContext" => decode_conversation_context,
					});
					known_keys(
						cx,
						object,
						&[
							"request",
							"priorUsage",
							"workspaceComponents",
							"conversationContext",
						],
					);
					let rest = rest?;
					Some(Self::Research(ResearchJob {
						lease: lease?,
						request: rest.request,
						prior_usage: rest.prior_usage,
						workspace_components: rest.workspace_components,
						conversation_context: rest.conversation_context,
					}))
				}
				1 => {
					known_keys(cx, object, &[]);
					Some(Self::NewsIngest(lease?))
				}
				2 => {
					let rest = decode_fields!(cx, object, NotebookRest {
						workspace_id: "workspaceId" => id,
						agent: "agent" => NotebookAssistAgent::decode,
						instruction: "instruction" => string(INSTRUCTION),
						selected_widget_ids: "selectedWidgetIds" => array(id, &[ArrCheck::Max(notebook_limits::MAX_SELECTED_WIDGETS)]),
						notebook: "notebook" => Notebook::decode,
						notebook_version: "notebookVersion" => uint(NON_NEGATIVE_INT),
						conversation_context: "conversationContext" => decode_conversation_context,
					});
					known_keys(
						cx,
						object,
						&[
							"workspaceId",
							"agent",
							"instruction",
							"selectedWidgetIds",
							"notebook",
							"notebookVersion",
							"conversationContext",
						],
					);
					let rest = rest?;
					Some(Self::NotebookAssist(NotebookAssistJob {
						lease: lease?,
						workspace_id: rest.workspace_id,
						agent: rest.agent,
						instruction: rest.instruction,
						selected_widget_ids: rest.selected_widget_ids,
						notebook: rest.notebook,
						notebook_version: rest.notebook_version,
						conversation_context: rest.conversation_context,
					}))
				}
				3 => {
					let series = cx.at_key("series", |cx| {
						run_array(
							cx,
							object.get("series"),
							&MarketRefreshSeries::decode,
							&[ArrCheck::Max(market_limits::MAX_TRACKED_SERIES)],
						)
					});
					known_keys(cx, object, &["series"]);
					Some(Self::MarketRefresh(MarketRefreshJob {
						lease: lease?,
						series: series?,
					}))
				}
				4 => {
					let rest = decode_fields!(cx, object, EarningsRest {
						from_date: "fromDate" => string(ISO_DATE),
						to_date: "toDate" => string(ISO_DATE),
						stocks: "stocks" => array(EarningsRefreshStock::decode, &[ArrCheck::Max(earnings_limits::MAX_STOCKS)]),
					});
					known_keys(cx, object, &["fromDate", "toDate", "stocks"]);
					let rest = rest?;
					Some(Self::EarningsRefresh(EarningsRefreshJob {
						lease: lease?,
						from_date: rest.from_date,
						to_date: rest.to_date,
						stocks: rest.stocks,
					}))
				}
				5 => {
					let job = decode_google_calendar_job(cx, object, lease);
					refine(cx, mark, job.as_ref(), google_calendar_rules);
					job.map(Self::GoogleCalendar)
				}
				6 => {
					let market = cx.at_key("market", |cx| watch_market(cx, object.get("market")));
					known_keys(cx, object, &["market"]);
					Some(Self::StockDirectoryRefresh(StockDirectoryRefreshJob {
						lease: lease?,
						market: market?,
					}))
				}
				_ => {
					let claim = decode_financial_sync_claim(cx, object);
					known_keys(cx, object, &FINANCIAL_SYNC_CLAIM_KEYS);
					let job = FinancialSyncJob {
						lease: lease?,
						claim: claim?,
					};
					refine(cx, mark, Some(&job.claim), financial_sync_claim_rules);
					Some(Self::FinancialSync(job))
				}
			}
		})
	}
}

struct ResearchRest {
	request: ResearchRequest,
	prior_usage: ResourceUsage,
	workspace_components: Vec<WorkspaceComponentSummary>,
	conversation_context: Vec<ConversationContextMessage>,
}

struct NotebookRest {
	workspace_id: String,
	agent: NotebookAssistAgent,
	instruction: String,
	selected_widget_ids: Vec<String>,
	notebook: Notebook,
	notebook_version: u64,
	conversation_context: Vec<ConversationContextMessage>,
}

struct EarningsRest {
	from_date: String,
	to_date: String,
	stocks: Vec<EarningsRefreshStock>,
}

struct GoogleRest {
	action: GoogleCalendarAction,
	calendar_id: Tri<String>,
	desired_digest: Option<String>,
	events: Option<Vec<GoogleEventBody>>,
}

/// Reports unknown keys of a claimed job: `kind`, the lease and `extra` are known.
fn known_keys(cx: &mut Cx, object: &research_js::json::Object, extra: &[&str]) {
	let mut known: Vec<&str> = vec!["kind"];
	known.extend_from_slice(&LEASE_KEYS);
	known.extend_from_slice(extra);
	unrecognized(cx, object, &known);
}

fn decode_google_calendar_job(
	cx: &mut Cx,
	object: &research_js::json::Object,
	lease: Option<Lease>,
) -> Option<GoogleCalendarJob> {
	let rest = decode_fields!(cx, object, GoogleRest {
		action: "action" => GoogleCalendarAction::decode,
		calendar_id: "calendarId" => nullish(google_calendar_id),
		desired_digest: "desiredDigest" => optional(string(DESIRED_DIGEST)),
		events: "events" => optional(array(GoogleEventBody::decode, &[ArrCheck::Max(GOOGLE_SYNC_MAX_EVENTS)])),
	});
	known_keys(
		cx,
		object,
		&["action", "calendarId", "desiredDigest", "events"],
	);
	let (lease, rest) = (lease?, rest?);
	Some(GoogleCalendarJob {
		lease,
		action: rest.action,
		calendar_id: rest.calendar_id,
		desired_digest: rest.desired_digest,
		events: rest.events,
	})
}

/// The google-calendar superRefine: sync requires the three keys, connect
/// and disconnect carry none (absent, not null).
fn google_calendar_rules(cx: &mut Cx, job: &GoogleCalendarJob) {
	let present = [
		("calendarId", !job.calendar_id.is_absent()),
		("desiredDigest", job.desired_digest.is_some()),
		("events", job.events.is_some()),
	];
	if job.action == GoogleCalendarAction::Sync {
		for (field, is_present) in present {
			if !is_present {
				cx.push_at_key(
					field,
					IssueCode::Custom,
					format!("sync requires {field}"),
					Flow::Continue,
				);
			}
		}
		return;
	}
	for (field, is_present) in present {
		if is_present {
			cx.push_at_key(
				field,
				IssueCode::Custom,
				format!("{} carries no {field}", job.action.as_str()),
				Flow::Continue,
			);
		}
	}
}

/// `claimJobResponseSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimJobResponse {
	/// The claimed job, or null when there is none.
	pub job: Option<ClaimedJob>,
	/// Server hint for the next poll (> 0 ms).
	pub poll_after_ms: u64,
}

impl ClaimJobResponse {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			job: "job" => nullable(ClaimedJob::decode),
			poll_after_ms: "pollAfterMs" => uint(POSITIVE_INT),
		})
	}
}

/* ---------- Heartbeat and events ---------- */

/// `heartbeatRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
	/// Lease generation (> 0).
	pub lease_generation: u64,
}

impl HeartbeatRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
		})
	}
}

/// `heartbeatResponseSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
	/// New lease expiry.
	pub lease_expires_at: String,
	/// Whether the owner asked to cancel.
	pub cancel_requested: bool,
}

impl HeartbeatResponse {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			lease_expires_at: "leaseExpiresAt" => string(ISO_DATE_TIME),
			cancel_requested: "cancelRequested" => boolean,
		})
	}
}

/// `releaseJobRequestSchema` (ADR-0036): a runner that is shutting down hands
/// its lease back, with the run's consumption so far.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseJobRequest {
	/// Lease generation (> 0).
	pub lease_generation: u64,
	/// The run's usage so far (AGT-008).
	pub usage: ResourceUsage,
}

impl ReleaseJobRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
			usage: "usage" => ResourceUsage::decode,
		})
	}
}

js_enum! {
	/// The state a hand-back left the job in.
	pub enum ReleasedJobState {
		Pending = "pending",
		Cancelled = "cancelled",
	}
}

/// `releaseJobResponseSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReleaseJobResponse {
	/// `pending` (back in the queue) or `cancelled` (the owner had asked to cancel).
	pub state: ReleasedJobState,
}

impl ReleaseJobResponse {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			state: "state" => ReleasedJobState::decode,
		})
	}
}

/// The events response: `z.object({cancelRequested})`, non-strict — unknown
/// keys are stripped, not rejected (`apiClient.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsResponse {
	/// Whether the owner asked to cancel.
	pub cancel_requested: bool,
}

impl EventsResponse {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, loose, [], Self {
			cancel_requested: "cancelRequested" => boolean,
		})
	}
}

js_enum! {
	/// Outcome of a tool event.
	pub enum ToolOutcome {
		Executed = "executed",
		Denied = "denied",
		Failed = "failed",
	}
}

const NOTE_TEXT: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(500)];
const TOOL_ID: &[StrCheck] = &[StrCheck::Max(80)];
const TOOL_DETAIL: &[StrCheck] = &[StrCheck::Max(300)];
const SESSION_REF: &[StrCheck] = &[StrCheck::Max(200)];

/// The `event` of a runner event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum RunnerEventBody {
	/// A state change.
	#[serde(rename = "state")]
	State {
		/// The new leased state.
		state: LeasedJobState,
	},
	/// A progress note (1..500).
	#[serde(rename = "note")]
	Note {
		/// The note.
		text: String,
	},
	/// A tool outcome.
	#[serde(rename = "tool", rename_all = "camelCase")]
	Tool {
		/// Tool id (≤ 80).
		tool_id: String,
		/// Outcome.
		outcome: ToolOutcome,
		/// Detail (≤ 300).
		detail: String,
	},
	/// Usage so far.
	#[serde(rename = "usage")]
	Usage {
		/// The usage.
		usage: ResourceUsage,
	},
	/// A provider session reference (never sent by the runner today).
	#[serde(rename = "provider-session", rename_all = "camelCase")]
	ProviderSession {
		/// The reference (≤ 200).
		session_ref: String,
	},
	/// The Google sign-in link (FR-019).
	#[serde(rename = "google-auth-url")]
	GoogleAuthUrl {
		/// The sign-in URL.
		url: String,
	},
}

const EVENT_TYPES: &[&str] = &[
	"state",
	"note",
	"tool",
	"usage",
	"provider-session",
	"google-auth-url",
];

impl RunnerEventBody {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "type", EVENT_TYPES, |cx, tag| match tag {
			0 => decode_object!(cx, input, strict, ["type"], Self::State {
				state: "state" => LeasedJobState::decode,
			}),
			1 => decode_object!(cx, input, strict, ["type"], Self::Note {
				text: "text" => string(NOTE_TEXT),
			}),
			2 => decode_object!(cx, input, strict, ["type"], Self::Tool {
				tool_id: "toolId" => string(TOOL_ID),
				outcome: "outcome" => ToolOutcome::decode,
				detail: "detail" => string(TOOL_DETAIL),
			}),
			3 => decode_object!(cx, input, strict, ["type"], Self::Usage {
				usage: "usage" => ResourceUsage::decode,
			}),
			4 => decode_object!(cx, input, strict, ["type"], Self::ProviderSession {
				session_ref: "sessionRef" => string(SESSION_REF),
			}),
			_ => decode_object!(cx, input, strict, ["type"], Self::GoogleAuthUrl {
				url: "url" => string(AUTH_URL),
			}),
		})
	}
}

/// `runnerEventSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunnerEvent {
	/// Monotonic per lease generation.
	pub seq: u64,
	/// Time of the event.
	pub at: String,
	/// The event.
	pub event: RunnerEventBody,
}

impl RunnerEvent {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			seq: "seq" => uint(NON_NEGATIVE_INT),
			at: "at" => string(ISO_DATE_TIME),
			event: "event" => RunnerEventBody::decode,
		})
	}
}

/// `MAX_RUNNER_EVENTS_PER_REQUEST`.
pub const MAX_RUNNER_EVENTS_PER_REQUEST: usize = 50;

/// `runnerEventsRequestSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerEventsRequest {
	/// Lease generation.
	pub lease_generation: u64,
	/// Events (1..50).
	pub events: Vec<RunnerEvent>,
}

impl RunnerEventsRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
			events: "events" => array(RunnerEvent::decode, &[ArrCheck::Min(1), ArrCheck::Max(MAX_RUNNER_EVENTS_PER_REQUEST)]),
		})
	}
}

/* ---------- Completions ---------- */

/// One series of a `market-refreshed` completion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRefreshedSeries {
	/// Series id.
	pub series_id: String,
	/// Fetch time.
	pub fetched_at: String,
	/// Metadata, null exactly when `error_code` is set.
	pub meta: Option<MarketSeriesMeta>,
	/// Observations (≤ 800; none with an error).
	pub observations: Vec<MarketObservation>,
	/// Why the series is unavailable.
	pub error_code: Option<MarketUnavailableCode>,
	/// The provider's answer status behind `error_code`, unchanged (§4a).
	#[serde(skip_serializing_if = "Tri::is_absent")]
	pub upstream_status: Tri<u16>,
	/// ADR-0044: how the observations replace the stored history. Absent (a
	/// runner from before ADR-0044, or a failed or empty answer) merges: no
	/// stored row is deleted.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub history: Option<MarketHistoryWrite>,
}

impl MarketRefreshedSeries {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			series_id: "seriesId" => market_series_id,
			fetched_at: "fetchedAt" => string(ISO_DATE_TIME),
			meta: "meta" => nullable(MarketSeriesMeta::decode),
			observations: "observations" => array(MarketObservation::decode, &[ArrCheck::Max(market_limits::MAX_OBSERVATIONS_PER_RESPONSE)]),
			error_code: "errorCode" => nullable(MarketUnavailableCode::decode),
			upstream_status: "upstreamStatus" => nullish(upstream_status),
			history: "history" => optional(MarketHistoryWrite::decode),
		})
	}
}

/// One stock of an `earnings-refreshed` completion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningsRefreshedStock {
	/// Stock id.
	pub stock_id: String,
	/// Fetch time.
	pub fetched_at: String,
	/// Company name (trimmed, 1..200).
	pub name: Option<String>,
	/// Events (≤ 8; none with an error).
	pub events: Vec<EarningsEvent>,
	/// Why no dates are available.
	pub error_code: Option<EarningsUnavailableCode>,
	/// The provider's answer status behind `error_code`, unchanged (§4a).
	#[serde(skip_serializing_if = "Tri::is_absent")]
	pub upstream_status: Tri<u16>,
}

impl EarningsRefreshedStock {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			stock_id: "stockId" => watchlist_stock_id,
			fetched_at: "fetchedAt" => string(ISO_DATE_TIME),
			name: "name" => nullable(string(COMPANY_NAME)),
			events: "events" => array(EarningsEvent::decode, &[ArrCheck::Max(earnings_limits::MAX_EVENTS_PER_STOCK)]),
			error_code: "errorCode" => nullable(EarningsUnavailableCode::decode),
			upstream_status: "upstreamStatus" => nullish(upstream_status),
		})
	}
}

/// The approval a run waits for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
	/// Reason code (1..80).
	pub reason_code: String,
	/// Detail (≤ 400).
	pub detail: String,
}

const FAILURE_CODE: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(80)];
const APPROVAL_DETAIL: &[StrCheck] = &[StrCheck::Max(400)];
const REPLY: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(notebook_limits::MAX_REPLY_CHARS),
];

impl ApprovalRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			reason_code: "reasonCode" => string(FAILURE_CODE),
			detail: "detail" => string(APPROVAL_DETAIL),
		})
	}
}

/// `completeJobRequestSchema`: one variant per outcome, each with the lease
/// generation and the usage.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "outcome")]
pub enum CompleteJobRequest {
	/// A finished research run.
	#[serde(rename = "completed", rename_all = "camelCase")]
	Completed {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// The bundle.
		bundle: ResearchBundle,
		/// Articles (≤ 400).
		articles: Vec<IngestedArticle>,
		/// Source reports (≤ 200).
		source_reports: Vec<SourceFetchReport>,
	},
	/// A run stopped early; verified portions are kept.
	#[serde(rename = "partial", rename_all = "camelCase")]
	Partial {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// What stopped the run (1..80).
		failure_code: String,
		/// As on `failed`: the external service's status that stopped the
		/// run, unchanged (§4a).
		#[serde(skip_serializing_if = "Tri::is_absent")]
		failure_upstream_status: Tri<u16>,
		/// The bundle.
		bundle: ResearchBundle,
		/// Articles (≤ 400).
		articles: Vec<IngestedArticle>,
		/// Source reports (≤ 200).
		source_reports: Vec<SourceFetchReport>,
	},
	/// A news ingest.
	#[serde(rename = "ingested", rename_all = "camelCase")]
	Ingested {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// Articles (≤ 400).
		articles: Vec<IngestedArticle>,
		/// Source reports (≤ 200).
		source_reports: Vec<SourceFetchReport>,
	},
	/// A market refresh.
	#[serde(rename = "market-refreshed", rename_all = "camelCase")]
	MarketRefreshed {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// Series (≤ 60).
		series: Vec<MarketRefreshedSeries>,
	},
	/// A failure.
	#[serde(rename = "failed", rename_all = "camelCase")]
	Failed {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// Failure code (1..80).
		failure_code: String,
		/// Stable detail code, only with `ALL_TOOL_CALLS_FAILED` / `NO_EVIDENCE_COLLECTED`.
		#[serde(skip_serializing_if = "Tri::is_absent")]
		failure_detail: Tri<String>,
		/// The status the external service that caused the failure answered
		/// with, unchanged (docs/rule/error_handling.md §4a). Absent or null
		/// when no external answer caused it.
		#[serde(skip_serializing_if = "Tri::is_absent")]
		failure_upstream_status: Tri<u16>,
		/// Whether a retry may help.
		retryable: bool,
	},
	/// A cancellation.
	#[serde(rename = "cancelled", rename_all = "camelCase")]
	Cancelled {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
	},
	/// A notebook-assistant result (ADR-0020).
	#[serde(rename = "notebook-assisted", rename_all = "camelCase")]
	NotebookAssisted {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// Notebook version the commands apply to.
		base_version: u64,
		/// Reply (trimmed, 1..2000).
		reply: String,
		/// Widget-grid agent commands (≤ 12).
		commands: Vec<JsonObject>,
		/// Removals for the owner to confirm (≤ 12).
		proposed_removals: Vec<String>,
	},
	/// The run waits for the owner's approval.
	#[serde(rename = "waiting_approval", rename_all = "camelCase")]
	WaitingApproval {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// What to approve.
		approval_request: ApprovalRequest,
	},
	/// An earnings refresh (FR-018).
	#[serde(rename = "earnings-refreshed", rename_all = "camelCase")]
	EarningsRefreshed {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// One entry per claimed stock (≤ 50).
		stocks: Vec<EarningsRefreshedStock>,
	},
	/// Google Calendar connected (FR-019).
	#[serde(rename = "google-calendar-connected", rename_all = "camelCase")]
	GoogleCalendarConnected {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// Calendar id.
		calendar_id: String,
	},
	/// Google Calendar synced.
	#[serde(rename = "google-calendar-synced", rename_all = "camelCase")]
	GoogleCalendarSynced {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// Calendar id.
		calendar_id: String,
		/// Digest of the applied desired set.
		desired_digest: String,
		/// Inserted events.
		inserted: u64,
		/// Updated events.
		updated: u64,
		/// Deleted events.
		deleted: u64,
		/// Unchanged events.
		unchanged: u64,
	},
	/// Google Calendar disconnected.
	#[serde(rename = "google-calendar-disconnected", rename_all = "camelCase")]
	GoogleCalendarDisconnected {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// Whether the refresh token was revoked.
		revoked: bool,
	},
	/// One market's full list (ADR-0034), replacing its stored rows all or nothing.
	#[serde(rename = "stock-directory-refreshed", rename_all = "camelCase")]
	StockDirectoryRefreshed {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// The market of the list.
		market: WatchMarket,
		/// The date the source says the list is effective (JPX); null for SEC.
		as_of: Option<String>,
		/// When the list was downloaded.
		fetched_at: String,
		/// The rows (1,000..=10,000, distinct symbols of the market's listings).
		entries: Vec<StockDirectoryEntry>,
	},
	/// One company's financial-statement sync (ADR-0048): identity, the
	/// EDINET dates fully listed, and the annual filings found with their facts.
	#[serde(rename = "financial-synced", rename_all = "camelCase")]
	FinancialSynced {
		/// Lease generation.
		lease_generation: u64,
		/// Usage.
		usage: ResourceUsage,
		/// The company.
		company_id: String,
		/// SEC or EDINET.
		provider: EquityProvider,
		/// When the sync read the source.
		fetched_at: String,
		/// What the source says about the company; null when nothing was learned.
		identity: Option<EquitySyncIdentity>,
		/// EDINET dates fully listed (always empty for SEC).
		scanned_days: Vec<String>,
		/// Annual filings found, newest first (≤ 60, ≤ 3,000 facts in all).
		filings: Vec<EquityFilingResult>,
		/// The job left work for the next one (filings cut by the caps).
		more: bool,
	},
}

const OUTCOMES: &[&str] = &[
	"completed",
	"partial",
	"ingested",
	"market-refreshed",
	"failed",
	"cancelled",
	"notebook-assisted",
	"waiting_approval",
	"earnings-refreshed",
	"google-calendar-connected",
	"google-calendar-synced",
	"google-calendar-disconnected",
	"stock-directory-refreshed",
	"financial-synced",
];

const ARTICLES: &[ArrCheck] = &[ArrCheck::Max(bundle_limits::ARTICLES)];
const REPORTS: &[ArrCheck] = &[ArrCheck::Max(200)];
const COMMANDS: &[ArrCheck] = &[ArrCheck::Max(notebook_limits::MAX_COMMANDS_PER_TURN)];
const DIRECTORY_ENTRIES: &[ArrCheck] = &[
	ArrCheck::Min(directory_limits::MIN_ENTRIES_PER_MARKET),
	ArrCheck::Max(directory_limits::MAX_ENTRIES_PER_MARKET),
];

impl CompleteJobRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let decoded = run_discriminated(cx, input, "outcome", OUTCOMES, |cx, tag| match tag {
			0 => decode_object!(cx, input, strict, ["outcome"], Self::Completed {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				bundle: "bundle" => ResearchBundle::decode,
				articles: "articles" => array(IngestedArticle::decode, ARTICLES),
				source_reports: "sourceReports" => array(SourceFetchReport::decode, REPORTS),
			}),
			1 => decode_object!(cx, input, strict, ["outcome"], Self::Partial {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				failure_code: "failureCode" => string(FAILURE_CODE),
				failure_upstream_status: "failureUpstreamStatus" => nullish(upstream_status),
				bundle: "bundle" => ResearchBundle::decode,
				articles: "articles" => array(IngestedArticle::decode, ARTICLES),
				source_reports: "sourceReports" => array(SourceFetchReport::decode, REPORTS),
			}),
			2 => decode_object!(cx, input, strict, ["outcome"], Self::Ingested {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				articles: "articles" => array(IngestedArticle::decode, ARTICLES),
				source_reports: "sourceReports" => array(SourceFetchReport::decode, REPORTS),
			}),
			3 => decode_object!(cx, input, strict, ["outcome"], Self::MarketRefreshed {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				series: "series" => array(MarketRefreshedSeries::decode, &[ArrCheck::Max(market_limits::MAX_TRACKED_SERIES)]),
			}),
			4 => decode_object!(cx, input, strict, ["outcome"], Self::Failed {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				failure_code: "failureCode" => string(FAILURE_CODE),
				failure_detail: "failureDetail" => nullish(string(STABLE_FAILURE_CODE)),
				failure_upstream_status: "failureUpstreamStatus" => nullish(upstream_status),
				retryable: "retryable" => boolean,
			}),
			5 => decode_object!(cx, input, strict, ["outcome"], Self::Cancelled {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
			}),
			6 => decode_object!(cx, input, strict, ["outcome"], Self::NotebookAssisted {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				base_version: "baseVersion" => uint(NON_NEGATIVE_INT),
				reply: "reply" => string(REPLY),
				commands: "commands" => array(JsonObject::decode, COMMANDS),
				proposed_removals: "proposedRemovals" => array(id, COMMANDS),
			}),
			7 => decode_object!(cx, input, strict, ["outcome"], Self::WaitingApproval {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				approval_request: "approvalRequest" => ApprovalRequest::decode,
			}),
			8 => decode_object!(cx, input, strict, ["outcome"], Self::EarningsRefreshed {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				stocks: "stocks" => array(EarningsRefreshedStock::decode, &[ArrCheck::Max(earnings_limits::MAX_STOCKS)]),
			}),
			9 => decode_object!(cx, input, strict, ["outcome"], Self::GoogleCalendarConnected {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				calendar_id: "calendarId" => google_calendar_id,
			}),
			10 => decode_object!(cx, input, strict, ["outcome"], Self::GoogleCalendarSynced {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				calendar_id: "calendarId" => google_calendar_id,
				desired_digest: "desiredDigest" => string(DESIRED_DIGEST),
				inserted: "inserted" => uint(NON_NEGATIVE_INT),
				updated: "updated" => uint(NON_NEGATIVE_INT),
				deleted: "deleted" => uint(NON_NEGATIVE_INT),
				unchanged: "unchanged" => uint(NON_NEGATIVE_INT),
			}),
			11 => decode_object!(cx, input, strict, ["outcome"], Self::GoogleCalendarDisconnected {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				revoked: "revoked" => boolean,
			}),
			12 => decode_object!(cx, input, strict, ["outcome"], Self::StockDirectoryRefreshed {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				market: "market" => watch_market,
				as_of: "asOf" => nullable(string(ISO_DATE)),
				fetched_at: "fetchedAt" => string(ISO_DATE_TIME),
				entries: "entries" => array(StockDirectoryEntry::decode, DIRECTORY_ENTRIES),
			}),
			_ => decode_object!(cx, input, strict, ["outcome"], Self::FinancialSynced {
				lease_generation: "leaseGeneration" => uint(POSITIVE_INT),
				usage: "usage" => ResourceUsage::decode,
				company_id: "companyId" => id,
				provider: "provider" => equity_provider,
				fetched_at: "fetchedAt" => string(ISO_DATE_TIME),
				identity: "identity" => nullable(EquitySyncIdentity::decode),
				scanned_days: "scannedDays" => scanned_days,
				filings: "filings" => financial_filings,
				more: "more" => boolean,
			}),
		});
		refine(cx, mark, decoded.as_ref(), completion_rules);
		decoded
	}
}

/// The refinements of the members that have them.
fn completion_rules(cx: &mut Cx, completion: &CompleteJobRequest) {
	match completion {
		CompleteJobRequest::Failed {
			failure_code,
			failure_detail,
			..
		} => {
			if failure_detail.value().is_some() && !failure_code_takes_detail(Some(failure_code)) {
				cx.refine_failed(
					Some("failureDetail"),
					"failureDetail may be non-null only when failureCode is ALL_TOOL_CALLS_FAILED or NO_EVIDENCE_COLLECTED",
				);
			}
		}
		CompleteJobRequest::MarketRefreshed { series, .. } => {
			let consistent = series.iter().all(|entry| {
				entry.error_code.is_none() == entry.meta.is_some()
					&& (entry.error_code.is_none() || entry.observations.is_empty())
					&& (entry.upstream_status.value().is_none() || entry.error_code.is_some())
			});
			if !consistent {
				cx.refine_failed(
					Some("series"),
					"errorCode is null exactly when meta is present; errors carry no observations; upstreamStatus only with an errorCode",
				);
			}
			// ADR-0044: a write may only replace what the answer covers, so an
			// error or an empty answer never deletes stored history.
			if !series.iter().all(history_write_covered) {
				cx.refine_failed(
					Some("series"),
					"history needs a successful series with observations, and its replaceFrom date must be one of them",
				);
			}
			// Two entries for one series would apply two history writes
			// (ADR-0044 deletes included) whose stored result differs from
			// merging them one by one; duplicates are rejected instead.
			if !all_distinct(series.iter().map(|entry| entry.series_id.as_str())) {
				cx.refine_failed(Some("series"), "series ids must be distinct");
			}
		}
		CompleteJobRequest::EarningsRefreshed { stocks, .. } => {
			if !stocks
				.iter()
				.all(|entry| entry.error_code.is_none() || entry.events.is_empty())
			{
				cx.refine_failed(Some("stocks"), "errors carry no events");
			}
			if !stocks
				.iter()
				.all(|entry| entry.upstream_status.value().is_none() || entry.error_code.is_some())
			{
				cx.refine_failed(
					Some("stocks"),
					"upstreamStatus may be set only with an errorCode",
				);
			}
			// A duplicate success+failure pair for one stock would delete the
			// events of a "failed" stock; duplicates are rejected instead.
			if !all_distinct(stocks.iter().map(|entry| entry.stock_id.as_str())) {
				cx.refine_failed(Some("stocks"), "stock ids must be distinct");
			}
			if !stocks.iter().all(|entry| {
				all_distinct(entry.events.iter().map(|event| event.period_key.as_str()))
			}) {
				cx.refine_failed(
					Some("stocks"),
					"period keys must be distinct within a stock",
				);
			}
		}
		CompleteJobRequest::StockDirectoryRefreshed {
			market, entries, ..
		} => {
			if let Some(problem) = stock_directory_entries_problem(*market, entries) {
				cx.refine_failed(Some("entries"), &problem);
			}
		}
		CompleteJobRequest::FinancialSynced {
			provider,
			identity,
			scanned_days,
			filings,
			..
		} => {
			if let Some(problem) =
				equity_sync_completion_problem(*provider, identity.as_ref(), scanned_days, filings)
			{
				cx.refine_failed(Some("filings"), problem);
			}
		}
		CompleteJobRequest::Completed { .. }
		| CompleteJobRequest::Partial { .. }
		| CompleteJobRequest::Ingested { .. }
		| CompleteJobRequest::Cancelled { .. }
		| CompleteJobRequest::NotebookAssisted { .. }
		| CompleteJobRequest::WaitingApproval { .. }
		| CompleteJobRequest::GoogleCalendarConnected { .. }
		| CompleteJobRequest::GoogleCalendarSynced { .. }
		| CompleteJobRequest::GoogleCalendarDisconnected { .. } => {}
	}
}

/// True when `entry` has no history write, or one the zod refinement admits:
/// on a success with observations, `replaceFrom` null or one of their dates.
fn history_write_covered(entry: &MarketRefreshedSeries) -> bool {
	let Some(history) = &entry.history else {
		return true;
	};
	if entry.error_code.is_some() || entry.observations.is_empty() {
		return false;
	}
	history.replace_from().is_none_or(|from| {
		entry
			.observations
			.iter()
			.any(|MarketObservation(observed_on, _)| observed_on == from)
	})
}

fn all_distinct<'a>(values: impl Iterator<Item = &'a str>) -> bool {
	let mut seen: Vec<&str> = values.collect();
	let count = seen.len();
	seen.sort_unstable();
	seen.dedup();
	seen.len() == count
}

/// `completeJobResponseSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteJobResponse {
	/// The run's state after the completion.
	pub state: JobState,
	/// True when this completion was already recorded (idempotent replay).
	pub replayed: bool,
	/// Newly stored articles.
	pub new_article_count: u64,
}

impl CompleteJobResponse {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			state: "state" => JobState::decode,
			replayed: "replayed" => boolean,
			new_article_count: "newArticleCount" => uint(NON_NEGATIVE_INT),
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn leased_job_states_are_the_domain_list() {
		let domain: Vec<&str> = LEASED_JOB_STATES
			.iter()
			.map(|state| state.as_str())
			.collect();
		assert_eq!(LeasedJobState::VALUES, domain.as_slice());
	}
}
