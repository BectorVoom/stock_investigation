//! API constants, runner credentials and the error body
//! (`packages/contracts/src/api.ts`, `errors.ts`).

use research_js::json::Value;
use serde::Serialize;

use crate::primitives::{ISO_DATE_TIME, SHORT_TEXT, id, upstream_status};
use crate::zod::{Cx, StrCheck, decode_object, js_enum, nullable, optional, string};

/// `API_PREFIX`.
pub const API_PREFIX: &str = "/api/v1";
/// `RUNNER_API_PREFIX`.
pub const RUNNER_API_PREFIX: &str = "/api/v1/runner";
/// `MAX_REQUEST_BODY_BYTES`: the Worker's request body limit.
pub const MAX_REQUEST_BODY_BYTES: usize = 1_000_000;

/// `runnerCredentialSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCredential {
	/// Credential id.
	pub credential_id: String,
	/// Label (trimmed, 1..300).
	pub label: String,
	/// Creation time.
	pub created_at: String,
	/// Expiry.
	pub expires_at: String,
	/// Revocation time.
	pub revoked_at: Option<String>,
	/// Last use.
	pub last_used_at: Option<String>,
}

impl RunnerCredential {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			credential_id: "credentialId" => id,
			label: "label" => string(SHORT_TEXT),
			created_at: "createdAt" => string(ISO_DATE_TIME),
			expires_at: "expiresAt" => string(ISO_DATE_TIME),
			revoked_at: "revokedAt" => nullable(string(ISO_DATE_TIME)),
			last_used_at: "lastUsedAt" => nullable(string(ISO_DATE_TIME)),
		})
	}
}

const TOKEN: &[StrCheck] = &[StrCheck::Min(40)];

/// `issuedRunnerCredentialSchema`: the bearer token is returned exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IssuedRunnerCredential {
	/// The credential.
	pub credential: RunnerCredential,
	/// The bearer token (≥ 40 characters).
	pub token: String,
}

impl IssuedRunnerCredential {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			credential: "credential" => RunnerCredential::decode,
			token: "token" => string(TOKEN),
		})
	}
}

js_enum! {
	/// `apiErrorCodeSchema` (API-008: never renamed).
	pub enum ApiErrorCode {
		Unauthenticated = "UNAUTHENTICATED",
		Forbidden = "FORBIDDEN",
		CsrfRejected = "CSRF_REJECTED",
		NotFound = "NOT_FOUND",
		ValidationFailed = "VALIDATION_FAILED",
		PayloadTooLarge = "PAYLOAD_TOO_LARGE",
		RateLimited = "RATE_LIMITED",
		Conflict = "CONFLICT",
		IdempotencyKeyReused = "IDEMPOTENCY_KEY_REUSED",
		UnsafeUrl = "UNSAFE_URL",
		FetchFailed = "FETCH_FAILED",
		NotAFeed = "NOT_A_FEED",
		DuplicateSource = "DUPLICATE_SOURCE",
		UnknownAgent = "UNKNOWN_AGENT",
		SpendConsentRequired = "SPEND_CONSENT_REQUIRED",
		IllegalTransition = "ILLEGAL_TRANSITION",
		StaleLease = "STALE_LEASE",
		UiCommandRejected = "UI_COMMAND_REJECTED",
		VersionConflict = "VERSION_CONFLICT",
		IntegrityViolation = "INTEGRITY_VIOLATION",
		UnsupportedExportVersion = "UNSUPPORTED_EXPORT_VERSION",
		StoredDashboardUnreadable = "STORED_DASHBOARD_UNREADABLE",
		StoredNotebookUnreadable = "STORED_NOTEBOOK_UNREADABLE",
		InvalidNotebook = "INVALID_NOTEBOOK",
		InvalidNotebookSelection = "INVALID_NOTEBOOK_SELECTION",
		NothingToUndo = "NOTHING_TO_UNDO",
		AgentNotConfigured = "AGENT_NOT_CONFIGURED",
		NotebookAssistActive = "NOTEBOOK_ASSIST_ACTIVE",
		AuthKeysUnavailable = "AUTH_KEYS_UNAVAILABLE",
		/// ADR-0045: the tracked company does not exist.
		EquityCompanyNotFound = "EQUITY_COMPANY_NOT_FOUND",
		/// ADR-0045: the stock is already tracked.
		EquityCompanyAlreadyTracked = "EQUITY_COMPANY_ALREADY_TRACKED",
		/// ADR-0045: the owner tracks the maximum number of companies.
		EquityCompanyLimitReached = "EQUITY_COMPANY_LIMIT_REACHED",
		Internal = "INTERNAL",
	}
}

/// The `error` member of an error body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApiError {
	/// Stable code.
	pub code: ApiErrorCode,
	/// Human message.
	pub message: String,
	/// Machine-readable sub-reason.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub detail: Option<String>,
	/// Present when an external service caused the failure: the status it
	/// answered with, unchanged (docs/rule/error_handling.md §4a).
	#[serde(rename = "upstreamStatus", skip_serializing_if = "Option::is_none")]
	pub upstream_status: Option<u16>,
}

impl ApiError {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			code: "code" => ApiErrorCode::decode,
			message: "message" => string(&[]),
			detail: "detail" => optional(string(&[])),
			upstream_status: "upstreamStatus" => optional(upstream_status),
		})
	}
}

/// `apiErrorBodySchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApiErrorBody {
	/// The error.
	pub error: ApiError,
}

impl ApiErrorBody {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			error: "error" => ApiError::decode,
		})
	}
}
