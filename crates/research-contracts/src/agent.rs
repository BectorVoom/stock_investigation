//! Agent backends (`packages/contracts/src/agent.ts`): descriptors the
//! runner reports when claiming (FR-013), requests and the events an
//! adapter may emit (AGT-002).

use research_js::json::Value;
use serde::Serialize;

use crate::json::JsonValue;
use crate::patterns;
use crate::primitives::ISO_DATE_TIME;
use crate::zod::{
	ArrCheck, Cx, NumCheck, StrCheck, array, boolean, decode_object, js_enum, nullable, number,
	optional, run_discriminated, string, uint,
};

/// `agentIdSchema` checks.
pub(crate) const AGENT_ID: &[StrCheck] = &[StrCheck::Regex(
	&patterns::AGENT_ID,
	Some("invalid agent id"),
)];

/// `agentIdSchema` decoder.
pub(crate) fn agent_id(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	crate::zod::run_string(cx, input, AGENT_ID)
}

/// The four V1 backends (`BASELINE_AGENT_IDS`), in registry order.
pub const BASELINE_AGENT_IDS: [&str; 4] = ["opencode", "codex", "claude-code", "openrouter"];

/// Agent id of the OpenRouter free-models backend.
pub const OPENROUTER_FREE_AGENT_ID: &str = "openrouter-free";

/// Router id that selects a free model on the owner's behalf.
pub const OPENROUTER_FREE_ROUTER_MODEL_ID: &str = "openrouter/free";

/// `isFreeTierModelId`: an OpenCode free-tier model id ends in `-free`.
#[must_use]
pub fn is_free_tier_model_id(model_id: &str) -> bool {
	model_id.ends_with("-free")
}

/// `isOpenRouterFreeModelId`: the free router, or an id ending in `:free`
/// with at least one character before it. No trimming, case-sensitive.
#[must_use]
pub fn is_open_router_free_model_id(model_id: &str) -> bool {
	model_id == OPENROUTER_FREE_ROUTER_MODEL_ID
		|| (research_js::utf16::utf16_len(model_id) > ":free".len() && model_id.ends_with(":free"))
}

js_enum! {
	/// `capabilitySchema`.
	pub enum Capability {
		Stream = "stream",
		Cancel = "cancel",
		ToolCalls = "tool-calls",
		StructuredOutput = "structured-output",
		ImageInput = "image-input",
	}
}

js_enum! {
	/// `costModelSchema`: "plan-limited" cost is unknown and never shown as $0.
	pub enum CostModel {
		Metered = "metered",
		PlanLimited = "plan-limited",
	}
}

js_enum! {
	/// `toolIsolationSchema`.
	pub enum ToolIsolation {
		Enforced = "enforced",
		Unverified = "unverified",
	}
}

js_enum! {
	/// Why a backend is unavailable (`agentAvailabilitySchema`).
	pub enum UnavailableReason {
		NotInstalled = "NOT_INSTALLED",
		NotAuthenticated = "NOT_AUTHENTICATED",
		NotConfigured = "NOT_CONFIGURED",
		UnsupportedVersion = "UNSUPPORTED_VERSION",
		ToolIsolationUnverified = "TOOL_ISOLATION_UNVERIFIED",
		ProbeFailed = "PROBE_FAILED",
	}
}

const MAX_100: &[StrCheck] = &[StrCheck::Max(100)];
const MODEL_ID: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(100)];

/// `agentCapabilitiesSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
	/// Supported capabilities (≤ 8).
	pub supported: Vec<Capability>,
	/// The default model, when known (≤ 100).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub model: Option<String>,
	/// Model ids the probe listed (≤ 300 of 1..100 characters).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub models: Option<Vec<String>>,
}

impl AgentCapabilities {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			supported: "supported" => array(Capability::decode, &[ArrCheck::Max(8)]),
			model: "model" => optional(string(MAX_100)),
			models: "models" => optional(array(string(MODEL_ID), &[ArrCheck::Max(300)])),
		})
	}
}

/// `agentAvailabilitySchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status")]
pub enum AgentAvailability {
	/// `{status: "available"}`.
	#[serde(rename = "available")]
	Available,
	/// `{status: "unavailable", reasonCode, detail}`.
	#[serde(rename = "unavailable", rename_all = "camelCase")]
	Unavailable {
		/// Why.
		reason_code: UnavailableReason,
		/// Fixed detail text (≤ 300).
		detail: String,
	},
}

const MAX_300: &[StrCheck] = &[StrCheck::Max(300)];

impl AgentAvailability {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(
			cx,
			input,
			"status",
			&["available", "unavailable"],
			|cx, tag| {
				if tag == 0 {
					decode_object!(cx, input, strict, ["status"], Self::Available {})
				} else {
					decode_object!(cx, input, strict, ["status"], Self::Unavailable {
						reason_code: "reasonCode" => UnavailableReason::decode,
						detail: "detail" => string(MAX_300),
					})
				}
			},
		)
	}
}

const DISPLAY_NAME: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(60)];

/// `agentDescriptorSchema`: one backend as the runner reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
	/// Backend id.
	pub agent_id: String,
	/// Name shown in Settings (1..60).
	pub display_name: String,
	/// Capabilities.
	pub capabilities: AgentCapabilities,
	/// Billing model.
	pub cost_model: CostModel,
	/// Tool isolation.
	pub tool_isolation: ToolIsolation,
	/// Availability.
	pub availability: AgentAvailability,
}

impl AgentDescriptor {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			agent_id: "agentId" => agent_id,
			display_name: "displayName" => string(DISPLAY_NAME),
			capabilities: "capabilities" => AgentCapabilities::decode,
			cost_model: "costModel" => CostModel::decode,
			tool_isolation: "toolIsolation" => ToolIsolation::decode,
			availability: "availability" => AgentAvailability::decode,
		})
	}
}

const RUN_ID: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(96)];
const PROMPT: &[StrCheck] = &[StrCheck::Min(1)];
const MAX_80: &[StrCheck] = &[StrCheck::Max(80)];
const MAX_200: &[StrCheck] = &[StrCheck::Max(200)];
const CODE: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(60)];

/// `agentRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
	/// Run id (1..96).
	pub run_id: String,
	/// Conversation id (1..96).
	pub conversation_id: String,
	/// The prompt (non-empty).
	pub prompt: String,
	/// Tool ids the agent may request (each ≤ 80).
	pub permitted_tool_ids: Vec<String>,
	/// Tool-call budget.
	pub max_tool_calls: u64,
	/// ISO datetime with offset.
	pub deadline: String,
}

impl AgentRequest {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			run_id: "runId" => string(RUN_ID),
			conversation_id: "conversationId" => string(RUN_ID),
			prompt: "prompt" => string(PROMPT),
			permitted_tool_ids: "permittedToolIds" => array(string(MAX_80), &[]),
			max_tool_calls: "maxToolCalls" => uint(&[NumCheck::Int, NumCheck::Gte(0.0)]),
			deadline: "deadline" => string(ISO_DATE_TIME),
		})
	}
}

/// `agentEventSchema`: what an adapter may emit; provider-native shapes
/// never cross this boundary (AGT-002).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
	/// Answer text.
	#[serde(rename = "text.delta")]
	TextDelta {
		/// The text.
		text: String,
	},
	/// A tool call request.
	#[serde(rename = "tool.request", rename_all = "camelCase")]
	ToolRequest {
		/// Tool id (≤ 80).
		tool_id: String,
		/// Bounded JSON arguments.
		args: JsonValue,
		/// Call id (1..96).
		call_id: String,
	},
	/// A tool result reference.
	#[serde(rename = "tool.result", rename_all = "camelCase")]
	ToolResult {
		/// Call id (1..96).
		call_id: String,
		/// Result reference (≤ 200).
		result_ref: String,
	},
	/// A UI command.
	#[serde(rename = "ui.command")]
	UiCommand {
		/// Bounded JSON command.
		command: JsonValue,
	},
	/// Usage report.
	#[serde(rename = "usage", rename_all = "camelCase")]
	Usage {
		/// Known cost, or null when the provider cannot report it.
		known_cost_usd: Option<f64>,
	},
	/// Terminal success.
	#[serde(rename = "completed")]
	Completed,
	/// Terminal failure.
	#[serde(rename = "failed")]
	Failed {
		/// Failure code (1..60).
		code: String,
		/// Whether a retry may help.
		retryable: bool,
	},
}

/// The `type` tags of [`AgentEvent`], in schema order.
const AGENT_EVENT_TAGS: &[&str] = &[
	"text.delta",
	"tool.request",
	"tool.result",
	"ui.command",
	"usage",
	"completed",
	"failed",
];

impl AgentEvent {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "type", AGENT_EVENT_TAGS, |cx, tag| match tag {
			0 => decode_object!(cx, input, strict, ["type"], Self::TextDelta {
				text: "text" => string(&[]),
			}),
			1 => decode_object!(cx, input, strict, ["type"], Self::ToolRequest {
				tool_id: "toolId" => string(MAX_80),
				args: "args" => JsonValue::decode,
				call_id: "callId" => string(RUN_ID),
			}),
			2 => decode_object!(cx, input, strict, ["type"], Self::ToolResult {
				call_id: "callId" => string(RUN_ID),
				result_ref: "resultRef" => string(MAX_200),
			}),
			3 => decode_object!(cx, input, strict, ["type"], Self::UiCommand {
				command: "command" => JsonValue::decode,
			}),
			4 => decode_object!(cx, input, strict, ["type"], Self::Usage {
				known_cost_usd: "knownCostUsd" => nullable(number(&[NumCheck::Gte(0.0)])),
			}),
			5 => decode_object!(cx, input, strict, ["type"], Self::Completed {}),
			_ => decode_object!(cx, input, strict, ["type"], Self::Failed {
				code: "code" => string(CODE),
				retryable: "retryable" => boolean,
			}),
		})
	}
}
