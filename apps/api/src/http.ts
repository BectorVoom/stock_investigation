import type { RunnerIdentity, UseCaseError, UseCaseResult } from "@research/application";
import {
	type ApiErrorBody,
	type ApiErrorCode,
	IDEMPOTENCY_KEY_HEADER,
	idempotencyKeySchema,
	idSchema,
} from "@research/contracts";
import { parseJson, responseStatusForUpstream } from "@research/domain";
import { attemptResult, type EventLogger, logIsolated, UnexpectedError } from "@research/effects";
import { Data, Effect } from "effect";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { AuthFailure, OwnerIdentity } from "./auth.ts";
import type { Services } from "./composition.ts";
import type { Env } from "./env.ts";

export interface AppEnv {
	Bindings: Env & { readonly DEV_ALLOWED_ORIGIN?: string };
	Variables: { services: Services; owner: OwnerIdentity; runner: RunnerIdentity };
}
export type AppContext = Context<AppEnv>;

/**
 * An expected failure that maps to a stable API error code (API-008). Handlers
 * fail with this (via `readJson`, `pathId`, `idempotencyKey` or `useCase`) and
 * `respond` turns it into the JSON error body below.
 */
export class HttpFailure extends Data.TaggedError("HttpFailure")<{
	readonly error: UseCaseError;
}> {}

/** Stable code -> HTTP status mapping (API-008). */
export const STATUS: { readonly [C in ApiErrorCode]: ContentfulStatusCode } = {
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	CSRF_REJECTED: 403,
	NOT_FOUND: 404,
	VALIDATION_FAILED: 400,
	PAYLOAD_TOO_LARGE: 413,
	RATE_LIMITED: 429,
	CONFLICT: 409,
	IDEMPOTENCY_KEY_REUSED: 409,
	UNSAFE_URL: 422,
	FETCH_FAILED: 502,
	NOT_A_FEED: 422,
	DUPLICATE_SOURCE: 409,
	UNKNOWN_AGENT: 422,
	SPEND_CONSENT_REQUIRED: 422,
	ILLEGAL_TRANSITION: 409,
	STALE_LEASE: 409,
	UI_COMMAND_REJECTED: 422,
	VERSION_CONFLICT: 409,
	INTEGRITY_VIOLATION: 422,
	UNSUPPORTED_EXPORT_VERSION: 422,
	STORED_DASHBOARD_UNREADABLE: 500,
	STORED_NOTEBOOK_UNREADABLE: 500,
	INVALID_NOTEBOOK: 422,
	INVALID_NOTEBOOK_SELECTION: 422,
	NOTHING_TO_UNDO: 409,
	AGENT_NOT_CONFIGURED: 422,
	NOTEBOOK_ASSIST_ACTIVE: 409,
	// The sign-in check could not reach a valid answer from the key endpoint (as FETCH_FAILED).
	AUTH_KEYS_UNAVAILABLE: 502,
	EQUITY_COMPANY_NOT_FOUND: 404,
	EQUITY_COMPANY_ALREADY_TRACKED: 409,
	EQUITY_COMPANY_LIMIT_REACHED: 422,
	INTERNAL: 500,
};

/**
 * The JSON error body and status of a use-case failure. When an external
 * service caused it (`upstreamStatus`), the body carries that status and the
 * response answers with it unchanged when it is a 4xx/5xx; otherwise (no
 * answer, or a 1xx–3xx) the code's own status from `STATUS` stands
 * (docs/rule/error_handling.md §4a, ADR-0037).
 */
export function failure(c: AppContext, error: UseCaseError): Response {
	const base: ApiErrorBody["error"] =
		error.detail === undefined
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, detail: error.detail };
	const body: ApiErrorBody = {
		error:
			error.upstreamStatus === undefined ? base : { ...base, upstreamStatus: error.upstreamStatus },
	};
	const ownStatus = STATUS[error.code];
	const response = c.json(body, ownStatus);
	const status = responseStatusForUpstream(error.upstreamStatus, ownStatus);
	// Hono types a status as the codes it has registered, and an upstream may
	// answer with any 4xx/5xx (Anthropic's 529, Cloudflare's 52x). The JSON
	// response Hono built (its headers included) is re-issued with the
	// upstream's status instead of narrowing the number with a cast.
	return status === ownStatus
		? response
		: new Response(response.body, { status, headers: response.headers });
}

export function reject(c: AppContext, code: ApiErrorCode, message: string): Response {
	return failure(c, { code, message });
}

/**
 * The answer to a request whose owner could not be authenticated. A key
 * endpoint that failed is not an expired session: it answers
 * AUTH_KEYS_UNAVAILABLE with the endpoint's status (§4a) and is logged, so an
 * outage can be told apart from "sign in" in the response and the logs.
 */
export function ownerAuthFailure(c: AppContext, logger: EventLogger, error: AuthFailure): Response {
	if (error === "FORBIDDEN") {
		return reject(c, "FORBIDDEN", "This account is not the workspace owner.");
	}
	if (error === "UNAUTHENTICATED") return reject(c, "UNAUTHENTICATED", "Sign-in required.");
	logIsolated(() =>
		logger.warn("owner_auth_keys_unavailable", {
			detail: error.detail,
			upstreamStatus: error.upstreamStatus ?? null,
			route: c.req.routePath,
		}),
	);
	const base = {
		code: error.code,
		message: "The sign-in check could not read the identity provider's signing keys.",
		detail: error.detail,
	};
	return failure(
		c,
		error.upstreamStatus === undefined ? base : { ...base, upstreamStatus: error.upstreamStatus },
	);
}

/** The VALIDATION_FAILED answer for a payload that failed its schema: field names only. */
function invalidPayload(error: z.ZodError, what: string, root: string): HttpFailure {
	const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || root))];
	return new HttpFailure({
		error: {
			code: "VALIDATION_FAILED",
			message: `${what} failed validation.`,
			detail: fields.slice(0, 8).join(", "),
		},
	});
}

/**
 * As `readJson`, for a body whose every field has a default: an empty body
 * validates as `{}`; a non-empty one must be JSON.
 */
export function readOptionalJson<T>(
	c: AppContext,
	schema: z.ZodType<T>,
): Effect.Effect<T, HttpFailure> {
	return Effect.flatMap(
		Effect.tryPromise({
			try: (): Promise<string> => c.req.text(),
			catch: () =>
				new HttpFailure({
					error: { code: "VALIDATION_FAILED", message: "Request body could not be read." },
				}),
		}),
		(text) => {
			let payload: unknown = {};
			if (text.trim() !== "") {
				const contentType = c.req.header("Content-Type") ?? "";
				if (!contentType.toLowerCase().startsWith("application/json")) {
					return Effect.fail(
						new HttpFailure({
							error: {
								code: "VALIDATION_FAILED",
								message: "Content-Type must be application/json.",
							},
						}),
					);
				}
				const parsedJson = parseJson(text);
				if (!parsedJson.ok) {
					return Effect.fail(
						new HttpFailure({
							error: { code: "VALIDATION_FAILED", message: "Request body is not valid JSON." },
						}),
					);
				}
				payload = parsedJson.value;
			}
			const parsed = schema.safeParse(payload);
			return parsed.success
				? Effect.succeed(parsed.data)
				: Effect.fail(invalidPayload(parsed.error, "Request body", "(body)"));
		},
	);
}

/** Parses and validates a JSON body. Error details name fields only, never echo values. */
export function readJson<T>(c: AppContext, schema: z.ZodType<T>): Effect.Effect<T, HttpFailure> {
	const contentType = c.req.header("Content-Type") ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		return Effect.fail(
			new HttpFailure({
				error: { code: "VALIDATION_FAILED", message: "Content-Type must be application/json." },
			}),
		);
	}
	return Effect.flatMap(
		Effect.tryPromise({
			try: (): Promise<unknown> => c.req.json(),
			catch: () =>
				new HttpFailure({
					error: { code: "VALIDATION_FAILED", message: "Request body is not valid JSON." },
				}),
		}),
		(payload) => {
			const parsed = schema.safeParse(payload);
			return parsed.success
				? Effect.succeed(parsed.data)
				: Effect.fail(invalidPayload(parsed.error, "Request body", "(body)"));
		},
	);
}

/**
 * Parses and validates the query string (every parameter, so an unknown one
 * is refused by a strict schema). Error details name fields only, never echo
 * values — a search query is the owner's own typing.
 */
export function readQuery<T>(c: AppContext, schema: z.ZodType<T>): Effect.Effect<T, HttpFailure> {
	const parsed = schema.safeParse(c.req.query());
	return parsed.success
		? Effect.succeed(parsed.data)
		: Effect.fail(invalidPayload(parsed.error, "Query string", "(query)"));
}

export function pathId(c: AppContext, name: string): Effect.Effect<string, HttpFailure> {
	const parsed = idSchema.safeParse(c.req.param(name));
	return parsed.success
		? Effect.succeed(parsed.data)
		: Effect.fail(
				new HttpFailure({ error: { code: "NOT_FOUND", message: "Resource not found." } }),
			);
}

export function idempotencyKey(c: AppContext): Effect.Effect<string, HttpFailure> {
	const parsed = idempotencyKeySchema.safeParse(c.req.header(IDEMPOTENCY_KEY_HEADER));
	return parsed.success
		? Effect.succeed(parsed.data)
		: Effect.fail(
				new HttpFailure({
					error: {
						code: "VALIDATION_FAILED",
						message: `A valid ${IDEMPOTENCY_KEY_HEADER} header is required.`,
					},
				}),
			);
}

/**
 * Lifts one use-case call into the HTTP error channel: an expected
 * `UseCaseError` becomes an `HttpFailure`, while a throw or rejection becomes
 * an `UnexpectedError` (which keeps the operation and class name only, never
 * the message, per SEC-010).
 */
export function useCase<T>(
	operation: string,
	run: () => Promise<UseCaseResult<T>>,
): Effect.Effect<T, HttpFailure | UnexpectedError> {
	return Effect.mapError(attemptResult(operation, run), (error) =>
		error instanceof UnexpectedError ? error : new HttpFailure({ error }),
	);
}

/**
 * The single error boundary for route handlers (ARCH-010): an `HttpFailure`
 * becomes the JSON error body with its stable status, an `UnexpectedError` is
 * logged once as `unhandled_error` and answered as `INTERNAL` / 500. A defect
 * is not caught here; it reaches `app.onError`, which keeps logging as now.
 */
export function respond(
	c: AppContext,
	logger: EventLogger,
	program: Effect.Effect<Response, HttpFailure | UnexpectedError>,
): Promise<Response> {
	return Effect.runPromise(
		program.pipe(
			Effect.catchTags({
				HttpFailure: (error) => Effect.succeed(failure(c, error.error)),
				UnexpectedError: (error) =>
					Effect.sync(() => {
						// Log the operation and error class only: messages may carry stored
						// content or identifiers (SEC-010). The log call itself is
						// isolated: the stable INTERNAL answer must go out even when the
						// log writer is down (the logger counts that failure itself).
						logIsolated(() =>
							logger.error("unhandled_error", {
								operation: error.operation,
								name: error.errorName,
								method: c.req.method,
								route: c.req.routePath,
							}),
						);
						return reject(c, "INTERNAL", "Internal error.");
					}),
			}),
		),
	);
}

/**
 * Short non-cryptographic fingerprint (FNV-1a, 32 bit) for cache validators.
 * It only decides whether a polling client re-downloads; it protects nothing.
 */
export function fingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** JSON with a validator; answers 304 when the client already holds this version. */
export function conditionalJson(c: AppContext, version: string, body: unknown): Response {
	const etag = `"${version}"`;
	c.header("ETag", etag);
	c.header("Cache-Control", "private, no-cache");
	if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
	return c.json(body);
}
