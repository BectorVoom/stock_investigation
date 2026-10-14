import { JOB_STATES, parseStockId as parseDomainStockId, WATCHLIST_LIMITS } from "@research/domain";
import { z } from "zod";
import { httpsUrlSchema, idSchema, isoDateSchema, isoDateTimeSchema } from "./primitives.ts";

/**
 * Google Calendar sync contract (FR-019 section 2.4). Stable failure codes
 * each have ONE fixed human reason sentence (like
 * `EARNINGS_UNAVAILABLE_REASONS`): provider text is untrusted and never
 * stored, shown or logged.
 */
export const GOOGLE_CALENDAR_FAILURE_CODES = [
	"GOOGLE_NOT_CONFIGURED",
	"GOOGLE_AUTH_TIMEOUT",
	"GOOGLE_CONSENT_DENIED",
	"GOOGLE_SCOPE_MISSING",
	"GOOGLE_AUTH_EXPIRED",
	"GOOGLE_RATE_LIMITED",
	"GOOGLE_REQUEST_FAILED",
	"GOOGLE_NOT_CONNECTED",
] as const;

export const googleCalendarFailureCodeSchema = z.enum(GOOGLE_CALENDAR_FAILURE_CODES);
export type GoogleCalendarFailureCode = z.infer<typeof googleCalendarFailureCodeSchema>;

export const GOOGLE_CALENDAR_FAILURE_REASONS: {
	readonly [C in GoogleCalendarFailureCode]: string;
} = {
	GOOGLE_NOT_CONFIGURED:
		"Google Calendar is not configured; set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in apps/runner/.env.",
	GOOGLE_AUTH_TIMEOUT: "Google sign-in timed out after 5 minutes; try connecting again.",
	GOOGLE_CONSENT_DENIED: "Google sign-in was not completed; consent was denied.",
	GOOGLE_SCOPE_MISSING: "Google did not grant the calendar permission; reconnect and allow access.",
	GOOGLE_AUTH_EXPIRED: "The Google connection expired; reconnect Google Calendar.",
	GOOGLE_RATE_LIMITED: "The Google Calendar rate limit was reached; try again later.",
	GOOGLE_REQUEST_FAILED: "The Google Calendar request failed.",
	GOOGLE_NOT_CONNECTED: "Google Calendar is not connected; connect it before syncing.",
} as const;

export function googleCalendarFailureReason(code: GoogleCalendarFailureCode): string {
	return GOOGLE_CALENDAR_FAILURE_REASONS[code];
}

export function googleCalendarFailure(
	code: GoogleCalendarFailureCode,
	at: string,
): { readonly code: GoogleCalendarFailureCode; readonly reason: string; readonly at: string } {
	return { code, reason: googleCalendarFailureReason(code), at };
}

export const googleCalendarFailureSchema = z.strictObject({
	code: googleCalendarFailureCodeSchema,
	reason: z.string().min(1).max(300),
	at: isoDateTimeSchema,
});
export type GoogleCalendarFailure = z.infer<typeof googleCalendarFailureSchema>;

export const googleCalendarStatusSchema = z.enum([
	"disconnected",
	"connecting",
	"connected",
	"needs-reconnect",
]);
export type GoogleCalendarStatus = z.infer<typeof googleCalendarStatusSchema>;

export const googleCalendarActionSchema = z.enum(["connect", "sync", "disconnect"]);
export type GoogleCalendarAction = z.infer<typeof googleCalendarActionSchema>;

/** Authorization URL: only ever the Google OAuth endpoint prefix below. */
export const GOOGLE_AUTH_URL_PREFIX = "https://accounts.google.com/o/oauth2/v2/auth?";

/** The ONE OAuth scope a sign-in link may ask for: calendars this app created. */
export const GOOGLE_CALENDAR_OAUTH_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

/** Printable ASCII without spaces: safe in a header, a log line and a link. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

const AUTH_URL_PARAMETERS: ReadonlySet<string> = new Set([
	"response_type",
	"client_id",
	"redirect_uri",
	"scope",
	"access_type",
	"prompt",
	"code_challenge",
	"code_challenge_method",
	"state",
]);

/**
 * True only for the sign-in link the runner is meant to build: the Google
 * endpoint, the authorization-code flow with PKCE S256, the single
 * app-created-calendars scope, and a redirect to the loopback address of the
 * machine the runner runs on. The prefix alone would let a compromised
 * runner put a genuine Google consent screen for ANOTHER scope, or a
 * redirect to another host, behind the app's own "Open Google sign-in"
 * link; this pins everything a link can vary on. Every parameter appears at
 * most once and nothing unlisted is accepted.
 */
export function isGoogleSignInUrl(value: string): boolean {
	if (!value.startsWith(GOOGLE_AUTH_URL_PREFIX) || !PRINTABLE_ASCII.test(value)) return false;
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
	const seen = new Map<string, string>();
	for (const [name, parameter] of url.searchParams) {
		if (!AUTH_URL_PARAMETERS.has(name) || seen.has(name)) return false;
		seen.set(name, parameter);
	}
	const clientId = seen.get("client_id") ?? "";
	return (
		seen.get("response_type") === "code" &&
		seen.get("scope") === GOOGLE_CALENDAR_OAUTH_SCOPE &&
		seen.get("code_challenge_method") === "S256" &&
		/^[A-Za-z0-9_-]{43}$/.test(seen.get("code_challenge") ?? "") &&
		/^[A-Za-z0-9_-]{16,128}$/.test(seen.get("state") ?? "") &&
		/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(seen.get("redirect_uri") ?? "") &&
		clientId.length > 0 &&
		clientId.length <= 200 &&
		(seen.get("access_type") ?? "offline") === "offline" &&
		(seen.get("prompt") ?? "consent") === "consent"
	);
}

/**
 * The sign-in link as the API returns it. The strict check ran when the
 * runner's event was accepted; here the value only has to be the Google
 * endpoint in printable ASCII.
 */
export const googleCalendarAuthUrlSchema = z
	.string()
	.max(2000)
	.refine((value) => value.startsWith(GOOGLE_AUTH_URL_PREFIX) && PRINTABLE_ASCII.test(value), {
		message: "auth URL must be the Google OAuth endpoint",
	})
	.nullable();

/** A Google calendar id (printable ASCII; it travels in an ETag and a URL path). */
export const googleCalendarIdSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(PRINTABLE_ASCII, "calendar id must be printable ASCII");

export const googleCalendarSyncCountsSchema = z.strictObject({
	inserted: z.number().int().nonnegative(),
	updated: z.number().int().nonnegative(),
	deleted: z.number().int().nonnegative(),
	unchanged: z.number().int().nonnegative(),
});
export type GoogleCalendarSyncCounts = z.infer<typeof googleCalendarSyncCountsSchema>;

export const googleCalendarStateSchema = z.strictObject({
	status: googleCalendarStatusSchema,
	/** Only while connecting; never a credential (client id, port, state and PKCE challenge only). */
	authUrl: googleCalendarAuthUrlSchema,
	calendarId: googleCalendarIdSchema.nullable(),
	connectedAt: isoDateTimeSchema.nullable(),
	lastSyncedAt: isoDateTimeSchema.nullable(),
	lastSync: googleCalendarSyncCountsSchema.nullable(),
	/** Null unless connected: whether the stored digest matches current desired events. */
	inSync: z.boolean().nullable(),
	activeRunId: idSchema.nullable(),
	activeRunState: z.enum(JOB_STATES).nullable(),
	activeAction: googleCalendarActionSchema.nullable(),
	lastFailure: googleCalendarFailureSchema.nullable(),
});
export type GoogleCalendarState = z.infer<typeof googleCalendarStateSchema>;

/**
 * Phase-G1 placeholder: the API has no repository-backed state yet, so every
 * response carries this constant (clearly marked; the next phase replaces it
 * with the real state). `inSync` is null because null means "not connected".
 */
export const DISCONNECTED_GOOGLE_CALENDAR_STATE: GoogleCalendarState = {
	status: "disconnected",
	authUrl: null,
	calendarId: null,
	connectedAt: null,
	lastSyncedAt: null,
	lastSync: null,
	inSync: null,
	activeRunId: null,
	activeRunState: null,
	activeAction: null,
	lastFailure: null,
};

/** The stored request for a `google-calendar` job: just the action. */
export const googleCalendarRequestSchema = z.strictObject({
	action: googleCalendarActionSchema,
});
export type GoogleCalendarRequest = z.infer<typeof googleCalendarRequestSchema>;

/** One Google event body as claimed for a sync (mirrors the domain's `GoogleEventBody`). */
const googleEventStockIdSchema = z
	.string()
	.max(64)
	.refine((value) => parseDomainStockId(value).ok, {
		message: "invalid watchlist stock id",
	});
export const googleEventBodySchema = z.strictObject({
	id: z.string().regex(/^[0-9a-v]{32}$/, "event id must be 32 base32hex chars"),
	summary: z.string().min(1).max(300),
	description: z.string().min(1).max(2000),
	startDate: isoDateSchema,
	endDate: isoDateSchema,
	privateProperties: z.strictObject({
		researchWorkspace: z.literal("earnings"),
		stockId: googleEventStockIdSchema,
		periodKey: z.string().regex(/^[a-z0-9-]{1,48}$/, "period key must match [a-z0-9-]{1,48}"),
	}),
	sourceTitle: z.string().trim().min(1).max(200),
	sourceUrl: httpsUrlSchema,
});
export type GoogleEventBodyContract = z.infer<typeof googleEventBodySchema>;

/** Upper bound for claimed sync events: every stored event of every watched stock. */
export const GOOGLE_SYNC_MAX_EVENTS =
	WATCHLIST_LIMITS.maxStocks * WATCHLIST_LIMITS.maxEventsPerStock;

export const googleCalendarConnectPayloadSchema = z.strictObject({
	action: z.literal("connect"),
});
export const googleCalendarSyncPayloadSchema = z.strictObject({
	action: z.literal("sync"),
	calendarId: googleCalendarIdSchema.nullable(),
	desiredDigest: z.string().regex(/^[0-9a-f]{64}$/, "desired digest must be sha256 hex"),
	events: z.array(googleEventBodySchema).max(GOOGLE_SYNC_MAX_EVENTS),
});
export const googleCalendarDisconnectPayloadSchema = z.strictObject({
	action: z.literal("disconnect"),
});
export type GoogleCalendarConnectPayload = z.infer<typeof googleCalendarConnectPayloadSchema>;
export type GoogleCalendarSyncPayload = z.infer<typeof googleCalendarSyncPayloadSchema>;
export type GoogleCalendarDisconnectPayload = z.infer<typeof googleCalendarDisconnectPayloadSchema>;

/** Runner → API event carrying the sign-in URL (schema-pinned to the OAuth prefix). */
export const googleAuthUrlEventSchema = z.strictObject({
	type: z.literal("google-auth-url"),
	url: z.string().max(2000).refine(isGoogleSignInUrl, {
		message: "auth URL must be the runner's Google sign-in link",
	}),
});
export type GoogleAuthUrlEvent = z.infer<typeof googleAuthUrlEventSchema>;

export const googleCalendarConnectedSchema = z.strictObject({
	outcome: z.literal("google-calendar-connected"),
	leaseGeneration: z.number().int().positive(),
	usage: z.strictObject({
		agentSteps: z.number().int().nonnegative(),
		toolCalls: z.number().int().nonnegative(),
		inputBytes: z.number().int().nonnegative(),
		knownCostUsd: z.number().nonnegative(),
		hasUnmeteredUsage: z.boolean(),
	}),
	calendarId: googleCalendarIdSchema,
});
export const googleCalendarSyncedSchema = z.strictObject({
	outcome: z.literal("google-calendar-synced"),
	leaseGeneration: z.number().int().positive(),
	usage: z.strictObject({
		agentSteps: z.number().int().nonnegative(),
		toolCalls: z.number().int().nonnegative(),
		inputBytes: z.number().int().nonnegative(),
		knownCostUsd: z.number().nonnegative(),
		hasUnmeteredUsage: z.boolean(),
	}),
	calendarId: googleCalendarIdSchema,
	desiredDigest: z.string().regex(/^[0-9a-f]{64}$/, "desired digest must be sha256 hex"),
	inserted: z.number().int().nonnegative(),
	updated: z.number().int().nonnegative(),
	deleted: z.number().int().nonnegative(),
	unchanged: z.number().int().nonnegative(),
});
export const googleCalendarDisconnectedSchema = z.strictObject({
	outcome: z.literal("google-calendar-disconnected"),
	leaseGeneration: z.number().int().positive(),
	usage: z.strictObject({
		agentSteps: z.number().int().nonnegative(),
		toolCalls: z.number().int().nonnegative(),
		inputBytes: z.number().int().nonnegative(),
		knownCostUsd: z.number().nonnegative(),
		hasUnmeteredUsage: z.boolean(),
	}),
	revoked: z.boolean(),
});
