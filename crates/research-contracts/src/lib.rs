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
pub mod stock_directory;
pub mod ui;
pub mod watchlist;
pub mod widget_rules;
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
	jobs::ReleaseJobRequest,
	jobs::ReleaseJobResponse,
	jobs::ResearchBundle,
	jobs::ResearchRequest,
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
	records::PositionObservation,
	records::PricingPowerRecord,
	records::Security,
	records::SupplierLink,
	stock_directory::StockDirectoryEntry,
	ui::UiOperation,
	watchlist::EarningsEvent,
	widgets::WidgetCore,
);

/// Implements [`Contract`] for a literal union defined once in
/// `research-domain` (ARCH-013): zod's `z.enum` over its `VALUES`, in order.
macro_rules! literal_contract {
	($($ty:ty),* $(,)?) => {
		$(impl $crate::Contract for $ty {
			fn decode(cx: &mut $crate::zod::Cx, input: Option<&research_js::json::Value>) -> Option<Self> {
				$crate::zod::run_enum(cx, input, <$ty>::VALUES)
					.and_then(|index| <$ty>::ALL.get(index).copied())
			}
		})*
	};
}

literal_contract!(
	research_domain::evidence::verify_claims::ClaimStatus,
	research_domain::evidence::verify_claims::ClaimType,
	research_domain::evidence::verify_claims::EvidenceRelation,
	research_domain::finance::demand_scenario::DemandQuantityKind,
	research_domain::finance::filings::ReportedPositionChange,
	research_domain::finance::positions::PositionMetric,
	research_domain::finance::pricing_power::PricingPowerClassification,
	research_domain::finance::pricing_power::PricingPowerInputName,
	research_domain::finance::types::AccountingStandard,
	research_domain::finance::types::ActualOrEstimate,
	research_domain::finance::types::FiscalPeriod,
	research_domain::finance::types::Market,
	research_domain::jobs::state_machine::JobState,
	research_domain::market::series_id::MarketProviderId,
	research_domain::news::feed::LicensePolicy,
	research_domain::watchlist::limits::EarningsSourceId,
	research_domain::watchlist::stock_id::WatchMarket,
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

/// Re-validates an outgoing payload with the decoder of its schema (the
/// Worker parses it with zod): serialises it as JavaScript would and decodes
/// it again. Meant for debug builds and tests of the producers.
///
/// # Errors
/// zod's issues when the payload would be rejected.
pub fn check_outgoing<T: Contract + serde::Serialize>(value: &T) -> Result<(), ContractError> {
	let text = json::to_js_json(value).map_err(|error| {
		ContractError::Json(ParseError {
			offset: 0,
			reason: if error.is_io() {
				"serialisation failed"
			} else {
				"unserialisable value"
			},
		})
	})?;
	parse::<T>(&text).map(|_| ())
}

/// `claimJobResponseSchema.safeParse(JSON.parse(text))`.
///
/// # Errors
/// As [`parse`].
pub fn parse_claim_job_response(text: &str) -> Result<jobs::ClaimJobResponse, ContractError> {
	parse(text)
}

/// `heartbeatResponseSchema.safeParse(JSON.parse(text))`.
///
/// # Errors
/// As [`parse`].
pub fn parse_heartbeat_response(text: &str) -> Result<jobs::HeartbeatResponse, ContractError> {
	parse(text)
}

/// The events response (non-strict `{cancelRequested}`).
///
/// # Errors
/// As [`parse`].
pub fn parse_events_response(text: &str) -> Result<jobs::EventsResponse, ContractError> {
	parse(text)
}

/// `completeJobResponseSchema.safeParse(JSON.parse(text))`.
///
/// # Errors
/// As [`parse`].
pub fn parse_complete_job_response(text: &str) -> Result<jobs::CompleteJobResponse, ContractError> {
	parse(text)
}

/// `issuedRunnerCredentialSchema.safeParse(JSON.parse(text))`.
///
/// # Errors
/// As [`parse`].
pub fn parse_issued_runner_credential(
	text: &str,
) -> Result<api::IssuedRunnerCredential, ContractError> {
	parse(text)
}

/// `apiErrorBodySchema.safeParse(JSON.parse(text))`.
///
/// # Errors
/// As [`parse`].
pub fn parse_api_error_body(text: &str) -> Result<api::ApiErrorBody, ContractError> {
	parse(text)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn outgoing_payloads_are_checked_by_the_same_decoders() {
		let usage = jobs::EMPTY_USAGE;
		let cancelled = jobs::CompleteJobRequest::Cancelled {
			lease_generation: 1,
			usage,
		};
		assert!(check_outgoing(&cancelled).is_ok());
		let stale = jobs::CompleteJobRequest::Failed {
			lease_generation: 0,
			usage,
			failure_code: "X".to_owned(),
			failure_detail: Tri::Value("TIMEOUT".to_owned()),
			failure_upstream_status: Tri::Absent,
			retryable: false,
		};
		let Err(ContractError::Invalid(issues)) = check_outgoing(&stale) else {
			panic!("a zero lease generation and a stray detail must be rejected");
		};
		let paths: Vec<String> = issues.iter().map(|issue| issue.path_string(".")).collect();
		assert_eq!(paths, ["leaseGeneration", "failureDetail"]);
	}

	fn issue_paths(result: Result<impl std::fmt::Debug, ContractError>) -> Vec<String> {
		match result {
			Err(ContractError::Invalid(issues)) => {
				issues.iter().map(|issue| issue.path_string(".")).collect()
			}
			other => panic!("expected issues, got {other:?}"),
		}
	}

	#[test]
	fn upstream_statuses_are_decoded_with_their_range_and_refinements() {
		const USAGE: &str = r#""usage":{"agentSteps":0,"toolCalls":0,"inputBytes":0,"knownCostUsd":0,"hasUnmeteredUsage":false}"#;
		let failed = |status: &str| {
			format!(
				r#"{{"outcome":"failed","leaseGeneration":1,{USAGE},"failureCode":"PROVIDER_UNAVAILABLE"{status},"retryable":true}}"#
			)
		};
		// 529 is no table's status, and still a status (§4a); absent and null are none.
		let Ok(jobs::CompleteJobRequest::Failed {
			failure_upstream_status,
			..
		}) = parse::<jobs::CompleteJobRequest>(&failed(r#","failureUpstreamStatus":529"#))
		else {
			panic!("a failed completion with a status must decode");
		};
		assert_eq!(failure_upstream_status, Tri::Value(529));
		assert!(parse::<jobs::CompleteJobRequest>(&failed("")).is_ok());
		assert!(
			parse::<jobs::CompleteJobRequest>(&failed(r#","failureUpstreamStatus":null"#)).is_ok()
		);
		for bad in ["600", "99", "503.5", "\"503\""] {
			assert_eq!(
				issue_paths(parse::<jobs::CompleteJobRequest>(&failed(&format!(
					r#","failureUpstreamStatus":{bad}"#
				)))),
				["failureUpstreamStatus"],
				"{bad}"
			);
		}
		// A source report carries a status only with an error code.
		assert!(
			parse::<jobs::SourceFetchReport>(
				r#"{"sourceId":"src_1","fetchedAt":"2026-10-25T00:00:00.000Z","errorCode":"HTTP_ERROR","upstreamStatus":404}"#
			)
			.is_ok()
		);
		assert_eq!(
			issue_paths(parse::<jobs::SourceFetchReport>(
				r#"{"sourceId":"src_1","fetchedAt":"2026-10-25T00:00:00.000Z","errorCode":null,"upstreamStatus":404}"#
			)),
			["upstreamStatus"]
		);
		// So do market series and earnings stocks.
		let market = |error: &str| {
			format!(
				r#"{{"outcome":"market-refreshed","leaseGeneration":1,{USAGE},"series":[{{"seriesId":"fred:VIXCLS","fetchedAt":"2026-10-25T00:00:00.000Z","meta":null,"observations":[],{error}}}]}}"#
			)
		};
		assert!(
			parse::<jobs::CompleteJobRequest>(&market(
				r#""errorCode":"RATE_LIMITED","upstreamStatus":429"#
			))
			.is_ok()
		);
		assert_eq!(
			issue_paths(parse::<jobs::CompleteJobRequest>(&market(
				r#""errorCode":null,"upstreamStatus":429"#
			))),
			["series"]
		);
		let earnings = |error: &str| {
			format!(
				r#"{{"outcome":"earnings-refreshed","leaseGeneration":1,{USAGE},"stocks":[{{"stockId":"us:AAPL","fetchedAt":"2026-10-25T00:00:00.000Z","name":null,"events":[],{error}}}]}}"#
			)
		};
		assert!(
			parse::<jobs::CompleteJobRequest>(&earnings(
				r#""errorCode":"SOURCE_AUTH_FAILED","upstreamStatus":401"#
			))
			.is_ok()
		);
		assert_eq!(
			issue_paths(parse::<jobs::CompleteJobRequest>(&earnings(
				r#""errorCode":null,"upstreamStatus":401"#
			))),
			["stocks"]
		);
	}

	#[test]
	fn the_agent_failed_event_and_api_errors_accept_an_upstream_status() {
		assert_eq!(
			parse::<agent::AgentEvent>(
				r#"{"type":"failed","code":"PROVIDER_UNAVAILABLE","retryable":true,"upstreamStatus":529}"#
			),
			Ok(agent::AgentEvent::Failed {
				code: "PROVIDER_UNAVAILABLE".to_owned(),
				retryable: true,
				upstream_status: Some(529),
			})
		);
		let body = parse_api_error_body(
			r#"{"error":{"code":"FETCH_FAILED","message":"m","upstreamStatus":404}}"#,
		)
		.unwrap();
		assert_eq!(body.error.upstream_status, Some(404));
	}

	#[test]
	fn parses_bodies_with_javascript_semantics() {
		let body = "\u{FEFF}{\"cancelRequested\":false,\"cancelRequested\":true,\"extra\":1}";
		let parsed = parse_bytes::<jobs::EventsResponse>(body.as_bytes());
		assert_eq!(
			parsed,
			Ok(jobs::EventsResponse {
				cancel_requested: true
			})
		);
		assert!(matches!(
			parse_heartbeat_response("{"),
			Err(ContractError::Json(_))
		));
	}
}
