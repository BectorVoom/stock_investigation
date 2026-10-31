import { z } from "zod";
import { upstreamStatusSchema } from "./primitives.ts";

/** Stable machine-readable API error codes (API-008). Never rename; add new ones instead. */
export const API_ERROR_CODES = [
	"UNAUTHENTICATED",
	"FORBIDDEN",
	"CSRF_REJECTED",
	"NOT_FOUND",
	"VALIDATION_FAILED",
	"PAYLOAD_TOO_LARGE",
	"RATE_LIMITED",
	"CONFLICT",
	"IDEMPOTENCY_KEY_REUSED",
	"UNSAFE_URL",
	"FETCH_FAILED",
	"NOT_A_FEED",
	"DUPLICATE_SOURCE",
	"UNKNOWN_AGENT",
	"SPEND_CONSENT_REQUIRED",
	"ILLEGAL_TRANSITION",
	"STALE_LEASE",
	"UI_COMMAND_REJECTED",
	"VERSION_CONFLICT",
	"INTEGRITY_VIOLATION",
	"UNSUPPORTED_EXPORT_VERSION",
	"STORED_DASHBOARD_UNREADABLE",
	"STORED_NOTEBOOK_UNREADABLE",
	"INVALID_NOTEBOOK",
	"INVALID_NOTEBOOK_SELECTION",
	"NOTHING_TO_UNDO",
	"AGENT_NOT_CONFIGURED",
	"NOTEBOOK_ASSIST_ACTIVE",
	"AUTH_KEYS_UNAVAILABLE",
	/** ADR-0048: the owner tracks no company with this id. */
	"EQUITY_COMPANY_NOT_FOUND",
	/** ADR-0048: the listing is already tracked. */
	"EQUITY_COMPANY_ALREADY_TRACKED",
	/** ADR-0048: the owner already tracks `maxTrackedCompanies` companies. */
	"EQUITY_COMPANY_LIMIT_REACHED",
	"INTERNAL",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorBodySchema = z.strictObject({
	error: z.strictObject({
		code: apiErrorCodeSchema,
		message: z.string(),
		/** Machine-readable sub-reason, e.g. a UI command or URL policy error code. */
		detail: z.string().optional(),
		/**
		 * Present when an external service caused the failure: the status it
		 * answered with, unchanged. The response's own status is the same
		 * value when it is a 4xx/5xx (docs/rule/error_handling.md §4a).
		 */
		upstreamStatus: upstreamStatusSchema.optional(),
	}),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
