/**
 * Desktop-app OAuth for Google (FR-019 section 2.2), over the narrow pinned
 * port (`googleHttp.ts`). Endpoints verified against Google's documentation
 * on 2026-10-13:
 *
 *   authorize  GET  https://accounts.google.com/o/oauth2/v2/auth
 *   token      POST https://oauth2.googleapis.com/token
 *              (`application/x-www-form-urlencoded`)
 *   revoke     POST https://oauth2.googleapis.com/revoke (form field `token`;
 *              200 = revoked)
 *
 * Pure builders (`newCodeVerifier`, `codeChallengeS256`, `newOAuthState`,
 * `buildAuthorizationUrl`) are unit-tested on their own; the HTTP calls take
 * a `GoogleHttp`-shaped function so tests run them against a local fake
 * Google server, never the real endpoints.
 *
 * Error mapping is defensive (NOT yet observed live — see the spec): only
 * `invalid_grant` (expired or revoked refresh token), rate-limit signals and
 * transport failures are distinguished; every other provider answer is the
 * generic `GOOGLE_REQUEST_FAILED`. Provider bodies are parsed with zod and
 * never logged, stored or shown — only the stable code leaves this module.
 */
import { createHash, randomBytes } from "node:crypto";
import { err, ok, parseJsonOrNull, type Result } from "@research/domain";
import { z } from "zod";
import { GOOGLE_CALENDAR_HOST, GOOGLE_OAUTH_HOST, type GoogleHttpError } from "./googleHttp.ts";

/** The ONLY scope requested: secondary calendars this app created. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
/** Authorization endpoint for the Desktop-app flow. */
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export type GoogleOAuthHttp = (request: {
	readonly host: string;
	readonly method: "GET" | "POST" | "PUT" | "DELETE";
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string | null;
	readonly signal: AbortSignal;
}) => Promise<
	Result<
		{ readonly status: number; readonly location: string | null; readonly text: string },
		GoogleHttpError
	>
>;

export type GoogleStableCode =
	| "GOOGLE_AUTH_EXPIRED"
	| "GOOGLE_RATE_LIMITED"
	| "GOOGLE_REQUEST_FAILED";

/** 32 random bytes, base64url without padding (PKCE verifier). */
export function newCodeVerifier(random: (bytes: number) => Uint8Array = randomBytes): string {
	return Buffer.from(random(32)).toString("base64url");
}

/** S256 challenge for a verifier (RFC 7636). */
export function codeChallengeS256(verifier: string): string {
	return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** 32 random bytes of `state` (login-CSRF defence for the loopback callback). */
export function newOAuthState(random: (bytes: number) => Uint8Array = randomBytes): string {
	return Buffer.from(random(32)).toString("base64url");
}

export interface AuthorizationUrlInput {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly state: string;
	readonly challenge: string;
}

/**
 * Authorization URL builder. Carries the client id, the loopback redirect,
 * `state` and the PKCE challenge — none of them a credential — so this URL
 * is the ONE Google value allowed to reach the API (as a `google-auth-url`
 * event) and the browser.
 */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: input.clientId,
		redirect_uri: input.redirectUri,
		scope: GOOGLE_CALENDAR_SCOPE,
		access_type: "offline",
		prompt: "consent",
		code_challenge: input.challenge,
		code_challenge_method: "S256",
		state: input.state,
	});
	return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().int().nonnegative().optional(),
	refresh_token: z.string().min(1).optional(),
	scope: z.string().optional(),
	token_type: z.string().optional(),
});

const tokenErrorSchema = z.object({
	error: z.union([z.string(), z.looseObject({ code: z.string().optional() })]).optional(),
	error_description: z.string().optional(),
	rateLimitExceeded: z.boolean().optional(),
});

/**
 * Maps a token-endpoint failure to a stable code. `invalid_grant` (expired
 * or revoked refresh token — documentation-derived) is the only body that
 * changes the answer; rate limits (429, or a `rateLimitExceeded` marker) are
 * the other. Everything else — including every 3xx, since redirects are
 * never followed — is the generic request failure.
 */
export function mapTokenFailure(status: number | null, text: string | null): GoogleStableCode {
	if (status === 429) return "GOOGLE_RATE_LIMITED";
	if (status !== null && status >= 300 && status < 400) return "GOOGLE_REQUEST_FAILED";
	const parsed = text === null ? null : tokenErrorSchema.safeParse(parseJsonOrNull(text));
	if (parsed?.success) {
		const error = parsed.data.error;
		const code = typeof error === "string" ? error : (error?.code ?? null);
		if (code === "invalid_grant") return "GOOGLE_AUTH_EXPIRED";
		if (code === "rateLimitExceeded" || parsed.data.rateLimitExceeded === true) {
			return "GOOGLE_RATE_LIMITED";
		}
	}
	return "GOOGLE_REQUEST_FAILED";
}

export interface TokenExchangeInput {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly code: string;
	readonly verifier: string;
	readonly redirectUri: string;
	readonly signal: AbortSignal;
}

export interface TokenSuccess {
	/** Short-lived; stays in runner memory, never stored or logged. */
	readonly accessToken: string;
	/** Long-lived; stored in the 0600 token file, never logged. */
	readonly refreshToken: string;
	readonly scope: string | null;
	readonly expiresIn: number | null;
}

function formBody(fields: Readonly<Record<string, string>>): string {
	return new URLSearchParams(fields).toString();
}

/** Exchanges an authorization code for tokens (one attempt; no retry here). */
export async function exchangeCode(
	http: GoogleOAuthHttp,
	input: TokenExchangeInput,
): Promise<Result<TokenSuccess, GoogleStableCode | "GOOGLE_SCOPE_MISSING">> {
	const response = await http({
		host: GOOGLE_OAUTH_HOST,
		method: "POST",
		path: "/token",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: formBody({
			grant_type: "authorization_code",
			code: input.code,
			client_id: input.clientId,
			client_secret: input.clientSecret,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
		}),
		signal: input.signal,
	});
	if (!response.ok) return err("GOOGLE_REQUEST_FAILED");
	if (response.value.status !== 200) {
		return err(mapTokenFailure(response.value.status, response.value.text));
	}
	const parsed = tokenResponseSchema.safeParse(parseJsonOrNull(response.value.text));
	if (!parsed.success) return err("GOOGLE_REQUEST_FAILED");
	if (parsed.data.refresh_token === undefined) {
		// No refresh token: without it there is nothing to store, so the
		// grant is unusable. The caller reports GOOGLE_SCOPE_MISSING.
		return err("GOOGLE_SCOPE_MISSING");
	}
	return ok({
		accessToken: parsed.data.access_token,
		refreshToken: parsed.data.refresh_token,
		scope: parsed.data.scope ?? null,
		expiresIn: parsed.data.expires_in ?? null,
	});
}

export interface TokenRefreshInput {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
	readonly signal: AbortSignal;
}

/** Refreshes an access token (one attempt; `invalid_grant` means re-connect). */
export async function refreshAccessToken(
	http: GoogleOAuthHttp,
	input: TokenRefreshInput,
): Promise<
	Result<{ readonly accessToken: string; readonly expiresIn: number | null }, GoogleStableCode>
> {
	const response = await http({
		host: GOOGLE_OAUTH_HOST,
		method: "POST",
		path: "/token",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: formBody({
			grant_type: "refresh_token",
			client_id: input.clientId,
			client_secret: input.clientSecret,
			refresh_token: input.refreshToken,
		}),
		signal: input.signal,
	});
	if (!response.ok) return err("GOOGLE_REQUEST_FAILED");
	if (response.value.status !== 200) {
		return err(mapTokenFailure(response.value.status, response.value.text));
	}
	const parsed = tokenResponseSchema.safeParse(parseJsonOrNull(response.value.text));
	if (!parsed.success) return err("GOOGLE_REQUEST_FAILED");
	return ok({ accessToken: parsed.data.access_token, expiresIn: parsed.data.expires_in ?? null });
}

/**
 * Revokes a refresh token (best effort: any failure still ends with the
 * local token file deleted; the caller completes with `revoked: false`).
 */
export async function revokeToken(
	http: GoogleOAuthHttp,
	input: { readonly token: string; readonly signal: AbortSignal },
): Promise<{ readonly revoked: boolean }> {
	const response = await http({
		host: GOOGLE_OAUTH_HOST,
		method: "POST",
		path: "/revoke",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: formBody({ token: input.token }),
		signal: input.signal,
	});
	if (!response.ok) return { revoked: false };
	return { revoked: response.value.status === 200 };
}

/** True only when the granted scope string includes the one scope requested. */
export function scopeGranted(scope: string | null): boolean {
	if (scope === null) return false;
	return scope.split(" ").includes(GOOGLE_CALENDAR_SCOPE);
}

export { GOOGLE_CALENDAR_HOST };
