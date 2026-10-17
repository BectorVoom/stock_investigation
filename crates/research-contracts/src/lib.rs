//! The wire contract with the Worker API (ADR-0030 decision 4): typed
//! values, zod-equivalent decoders and JavaScript-exact serialisation.
//!
//! Every schema of `packages/contracts` the runner reaches has a Rust type
//! with a `decode` that behaves like the zod schema's `safeParse` (verdict,
//! parsed value, issue order, paths and messages — see [`zod`]) and a
//! `Serialize` implementation that writes zod's parsed value in schema key
//! order ([`json::to_js_json`]). Conformance is proved by
//! `vectors/contracts/*.json`, exported from the real zod schemas by
//! `scripts/vectors/contracts.ts` and replayed by `tests/vectors.rs`.
//!
//! Decoding goes through [`research_js::json`] (JavaScript `JSON.parse`
//! semantics: duplicate keys, key order, doubles), never through a serde
//! shape: zod's abort rules and issue order cannot be expressed by serde.

pub mod agent;
pub mod api;
pub mod google_calendar;
pub mod jobs;
pub mod json;
pub mod market;
pub mod notebook;
pub mod patterns;
pub mod primitives;
pub mod records;
pub mod ui;
pub mod watchlist;
pub mod widgets;
pub mod zod;

use research_js::json::{ParseError, Value};

pub use zod::{Cx, Issue, IssueCode, PathSegment, Tri};

/// Why a message is not a valid contract value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractError {
	/// The body is not JSON (`JSON.parse` would throw).
	Json(ParseError),
	/// The JSON does not satisfy the schema; zod's issues, in order.
	Invalid(Vec<Issue>),
}

impl std::fmt::Display for ContractError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Json(error) => write!(formatter, "{error}"),
			Self::Invalid(issues) => {
				formatter.write_str("invalid contract value")?;
				for issue in issues {
					write!(formatter, "; {issue}")?;
				}
				Ok(())
			}
		}
	}
}

impl std::error::Error for ContractError {}

/// A contract type: decodable like its zod schema.
pub trait Contract: Sized {
	/// The zod decoder: `None` with issues in `cx` when the input is invalid.
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self>;
}

/// `schema.safeParse(value)`: the parsed value, or zod's issues.
///
/// # Errors
/// [`ContractError::Invalid`] with zod's issues.
pub fn validate<T: Contract>(value: &Value) -> Result<T, ContractError> {
	let mut cx = Cx::new();
	let decoded = T::decode(&mut cx, Some(value));
	match decoded {
		Some(decoded) if cx.issues().is_empty() => Ok(decoded),
		_ => Err(ContractError::Invalid(cx.into_issues())),
	}
}

/// `schema.safeParse(JSON.parse(text))`.
///
/// # Errors
/// [`ContractError::Json`] when `text` is not JSON, [`ContractError::Invalid`]
/// when it does not satisfy the schema.
pub fn parse<T: Contract>(text: &str) -> Result<T, ContractError> {
	let value = research_js::json::parse(text).map_err(ContractError::Json)?;
	validate(&value)
}

/// [`parse`] of a response body (UTF-8 with replacement, BOM removed, as
/// `response.json()` decodes it).
///
/// # Errors
/// As [`parse`].
pub fn parse_bytes<T: Contract>(body: &[u8]) -> Result<T, ContractError> {
	let value = research_js::json::parse_bytes(body).map_err(ContractError::Json)?;
	validate(&value)
}

/// Implements [`Contract`] for types with an inherent `decode`.
macro_rules! contract {
	($($ty:ty),* $(,)?) => {
		$(impl $crate::Contract for $ty {
			fn decode(cx: &mut $crate::zod::Cx, input: Option<&research_js::json::Value>) -> Option<Self> {
				<$ty>::decode(cx, input)
			}
		})*
	};
}

contract!(
	agent::AgentAvailability,
	agent::AgentCapabilities,
	agent::AgentDescriptor,
	agent::AgentEvent,
	agent::AgentRequest,
	api::ApiErrorBody,
	api::IssuedRunnerCredential,
	api::RunnerCredential,
	google_calendar::GoogleEventBody,
	jobs::BundleProvenance,
	jobs::ClaimJobRequest,
	jobs::ClaimJobResponse,
	jobs::ClaimedJob,
	jobs::CompleteJobRequest,
	jobs::CompleteJobResponse,
	jobs::ConversationContextMessage,
	jobs::EventsResponse,
	jobs::HeartbeatRequest,
	jobs::HeartbeatResponse,
	jobs::ResearchBudget,
	jobs::ResearchBundle,
	jobs::ResearchRequest,
	jobs::ResourceUsage,
	jobs::RunnerEvent,
	jobs::RunnerEventsRequest,
	jobs::SourceFetchReport,
	jobs::SubscribedSourceRef,
	jobs::WorkspaceComponentSummary,
	market::MarketObservation,
	market::MarketSeriesMeta,
	notebook::Notebook,
	notebook::NotebookWidget,
	records::Claim,
	records::Dataset,
	records::DatasetCell,
	records::DatasetColumn,
	records::DemandScenario,
	records::Evidence,
	records::FinancialObservation,
	records::IngestedArticle,
	records::InvestorFiling,
	records::PositionFigures,
	records::PositionObservation,
	records::PricingPowerRecord,
	records::ReportingPeriod,
	records::Security,
	records::SupplierLink,
	ui::UiOperation,
	watchlist::EarningsEvent,
	widgets::WidgetCore,
);

/// `conversationContextSchema` as a contract value.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct ConversationContext(pub Vec<jobs::ConversationContextMessage>);

impl Contract for ConversationContext {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		jobs::decode_conversation_context(cx, input).map(Self)
	}
}
