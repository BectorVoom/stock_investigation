import {
	type ApiErrorCode,
	apiErrorBodySchema,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	IDEMPOTENCY_KEY_HEADER,
} from "@research/contracts";
import { parseJson } from "@research/domain";

/** Failure codes produced by the client itself, alongside the server's `ApiErrorCode`s. */
export type ClientErrorCode =
	| "NETWORK_ERROR"
	| "TIMEOUT"
	| "INVALID_REQUEST"
	| "INVALID_RESPONSE"
	| "UNEXPECTED_STATUS";

/**
 * Every way an API call can fail, as data (ARCH-010). `code` is stable and
 * machine-readable; `message` is safe to show the owner.
 */
export interface ApiFailure {
	readonly kind: "api" | "network" | "invalid-request" | "invalid-response";
	readonly code: ApiErrorCode | ClientErrorCode;
	/** HTTP status, or null when no response was received. */
	readonly status: number | null;
	readonly message: string;
	/** Server-provided machine-readable sub-reason, when any. */
	readonly detail: string | null;
	/** Schema issues ("path: message") for invalid requests/responses. */
	readonly issues: readonly string[];
}

export type ApiResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: ApiFailure };

/** Result of a conditional GET: 304 Not Modified means the caller's copy is current. */
export type Conditional<T> =
	| { readonly changed: true; readonly value: T; readonly etag: string | null }
	| { readonly changed: false };

interface SchemaIssue {
	readonly path: readonly PropertyKey[];
	readonly message: string;
}

/**
 * The slice of a zod schema the client needs. Declared structurally so this
 * module depends on the contracts' schema objects, not on the validation library.
 */
export interface Parser<T> {
	safeParse(
		input: unknown,
	):
		| { readonly success: true; readonly data: T }
		| { readonly success: false; readonly error: { readonly issues: readonly SchemaIssue[] } };
}

export type Parsed<S> = S extends { safeParse: (input: unknown) => infer R }
	? R extends { readonly success: true; readonly data: infer T }
		? T
		: never
	: never;

const MAX_REPORTED_ISSUES = 8;

export function describeIssues(issues: readonly SchemaIssue[]): readonly string[] {
	const described = issues
		.slice(0, MAX_REPORTED_ISSUES)
		.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
	return issues.length > MAX_REPORTED_ISSUES
		? [...described, `…and ${issues.length - MAX_REPORTED_ISSUES} more`]
		: described;
}

export function ok<T>(value: T): ApiResult<T> {
	return { ok: true, value };
}

export function fail(failure: Omit<ApiFailure, "detail" | "issues"> & Partial<ApiFailure>): {
	readonly ok: false;
	readonly error: ApiFailure;
} {
	return { ok: false, error: { detail: null, issues: [], ...failure } };
}

/** Validates data against a contract schema, mapping a mismatch to a typed failure. */
export function validate<T>(
	schema: Parser<T>,
	input: unknown,
	onInvalid: {
		readonly kind: "invalid-request" | "invalid-response";
		readonly status: number | null;
	},
): ApiResult<T> {
	const parsed = schema.safeParse(input);
	if (parsed.success) return ok(parsed.data);
	return fail({
		kind: onInvalid.kind,
		code: onInvalid.kind === "invalid-request" ? "INVALID_REQUEST" : "INVALID_RESPONSE",
		status: onInvalid.status,
		message:
			onInvalid.kind === "invalid-request"
				? "The request does not match the API contract and was not sent."
				: "The server response does not match the API contract.",
		issues: describeIssues(parsed.error.issues),
	});
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
	readonly fetch: FetchLike;
	readonly timeoutMs: number;
}

export interface RequestSpec {
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly path: string;
	/** Already validated against the request schema. */
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	/** Sent as If-None-Match; a 304 is then returned to the caller as a success. */
	readonly ifNoneMatch?: string | null;
	readonly accept?: string;
}

async function readErrorBody(response: Response): Promise<ApiFailure> {
	const unexpected: ApiFailure = {
		kind: "invalid-response",
		code: "UNEXPECTED_STATUS",
		status: response.status,
		message: `The server answered HTTP ${response.status} without a recognisable error body.`,
		detail: null,
		issues: [],
	};
	// Not JSON (e.g. an HTML error page from an intermediary) is reported as UNEXPECTED_STATUS.
	const body = parseJson(await response.text());
	if (!body.ok) return unexpected;
	const parsed = apiErrorBodySchema.safeParse(body.value);
	if (!parsed.success) return unexpected;
	return {
		kind: "api",
		code: parsed.data.error.code,
		status: response.status,
		message: parsed.data.error.message,
		detail: parsed.data.error.detail ?? null,
		issues: [],
	};
}

function describeCause(cause: unknown): string {
	return cause instanceof Error ? cause.message : "network error";
}

/** Reads a successful response's body into a typed result. Runs under the request's timeout. */
export type BodyReader<T> = (response: Response) => Promise<ApiResult<T>>;

/**
 * Performs one request and reads its body. `read` is called for 2xx responses
 * (and for 304 when `ifNoneMatch` was sent); every other outcome is a typed
 * failure. Writes carry the CSRF header (API-005); cookies are same-origin only.
 *
 * One timer covers the whole exchange — connecting, headers and the body — so
 * a response that stalls after its headers ends as TIMEOUT instead of hanging.
 * The timeout is raced against the exchange rather than relying on the abort
 * signal alone, so it holds even if a body read does not react to the abort.
 */
export async function request<T>(
	options: HttpOptions,
	spec: RequestSpec,
	read: BodyReader<T>,
): Promise<ApiResult<T>> {
	const headers: Record<string, string> = { Accept: spec.accept ?? "application/json" };
	if (spec.method !== "GET") {
		headers["Content-Type"] = "application/json";
		headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
	}
	if (spec.idempotencyKey !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = spec.idempotencyKey;
	const conditional = spec.ifNoneMatch !== undefined && spec.ifNoneMatch !== null;
	if (conditional) headers["If-None-Match"] = spec.ifNoneMatch ?? "";

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ApiResult<T>>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(
				fail({
					kind: "network",
					code: "TIMEOUT",
					status: null,
					message: `The server did not answer within ${Math.round(options.timeoutMs / 1000)} s.`,
				}),
			);
		}, options.timeoutMs);
	});

	/** Never rejects: every failure of the exchange is mapped to a typed result here. */
	const exchange = async (): Promise<ApiResult<T>> => {
		let response: Response;
		try {
			response = await options.fetch(spec.path, {
				method: spec.method,
				headers,
				credentials: "same-origin",
				signal: controller.signal,
				...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
			});
		} catch (cause) {
			return fail({
				kind: "network",
				code: "NETWORK_ERROR",
				status: null,
				message: `The request could not be completed (${describeCause(cause)}).`,
			});
		}
		try {
			if (response.ok || (response.status === 304 && conditional)) return await read(response);
			return { ok: false, error: await readErrorBody(response) };
		} catch (cause) {
			// The connection dropped (or was aborted) while the body was being read.
			return fail({
				kind: "network",
				code: "NETWORK_ERROR",
				status: response.status,
				message: `The response could not be read completely (${describeCause(cause)}).`,
			});
		}
	};

	try {
		return await Promise.race([exchange(), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export function jsonBody<T>(schema: Parser<T>): BodyReader<T> {
	return async (response) => {
		// A transport failure while reading rejects here and becomes NETWORK_ERROR in `request`.
		const body = parseJson(await response.text());
		if (!body.ok) {
			return fail({
				kind: "invalid-response",
				code: "INVALID_RESPONSE",
				status: response.status,
				message: "The server response is not valid JSON.",
			});
		}
		return validate(schema, body.value, { kind: "invalid-response", status: response.status });
	};
}
