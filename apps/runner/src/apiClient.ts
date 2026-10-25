import {
	apiErrorBodySchema,
	type ClaimJobRequest,
	type ClaimJobResponse,
	type CompleteJobRequest,
	type CompleteJobResponse,
	claimJobResponseSchema,
	completeJobResponseSchema,
	type HeartbeatResponse,
	heartbeatResponseSchema,
	issuedRunnerCredentialSchema,
	type ReleaseJobRequest,
	type ReleaseJobResponse,
	RUNNER_API_PREFIX,
	type RunnerEventsRequest,
	releaseJobResponseSchema,
} from "@research/contracts";
import { err, ok, type Result, thrownName } from "@research/domain";
import { z } from "zod";

/** Failure of one runner API call. `code` is the API's stable code or a transport code. */
export interface RunnerApiError {
	readonly code: string;
	readonly detail: string;
	/** True when repeating the identical request later may succeed. */
	readonly transient: boolean;
}

export type RunnerApiResult<T> = Result<T, RunnerApiError>;

/** The runner's view of the Worker. A port, so job execution is testable without HTTP. */
export interface RunnerApi {
	claim(request: ClaimJobRequest): Promise<RunnerApiResult<ClaimJobResponse>>;
	heartbeat(runId: string, leaseGeneration: number): Promise<RunnerApiResult<HeartbeatResponse>>;
	events(
		runId: string,
		request: RunnerEventsRequest,
	): Promise<RunnerApiResult<{ cancelRequested: boolean }>>;
	complete(
		runId: string,
		request: CompleteJobRequest,
	): Promise<RunnerApiResult<CompleteJobResponse>>;
	/** Hands the lease back on shutdown (ADR-0036). One attempt, never retried. */
	release(runId: string, request: ReleaseJobRequest): Promise<RunnerApiResult<ReleaseJobResponse>>;
	renewCredential(expiresInDays: number): Promise<RunnerApiResult<{ token: string }>>;
}

export interface HttpRunnerApiOptions {
	readonly apiUrl: string;
	readonly runnerToken: string;
	readonly accessClientId: string | null;
	readonly accessClientSecret: string | null;
	readonly fetch: typeof fetch;
	readonly sleep: (ms: number) => Promise<void>;
	readonly requestTimeoutMs?: number;
	readonly maxAttempts?: number;
}

const eventsResponseSchema = z.object({ cancelRequested: z.boolean() });

/**
 * How long a lease hand-back may take (ADR-0036). Shutdown has already started
 * when it is sent, and the job's wind-down shares the launcher's 8 s grace.
 */
export const RELEASE_TIMEOUT_MS = 2_000;

/**
 * HTTPS client for the runner endpoints (API-007): every call has a timeout,
 * a bounded number of attempts with exponential backoff, and its response is
 * validated against the shared contract. Only transport failures, 429 and 5xx
 * are retried; all runner endpoints are idempotent, so a retry is safe.
 */
export function createHttpRunnerApi(options: HttpRunnerApiOptions): RunnerApi {
	const timeoutMs = options.requestTimeoutMs ?? 20_000;
	const maxAttempts = options.maxAttempts ?? 4;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.runnerToken}`,
		"Content-Type": "application/json",
	};
	if (options.accessClientId !== null && options.accessClientSecret !== null) {
		headers["CF-Access-Client-Id"] = options.accessClientId;
		headers["CF-Access-Client-Secret"] = options.accessClientSecret;
	}

	async function attempt<T>(
		path: string,
		body: unknown,
		schema: z.ZodType<T>,
		attemptTimeoutMs = timeoutMs,
	): Promise<RunnerApiResult<T>> {
		let response: Response;
		try {
			response = await options.fetch(new URL(`${RUNNER_API_PREFIX}${path}`, options.apiUrl), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(attemptTimeoutMs),
				redirect: "error",
			});
		} catch (error) {
			return err({ code: "TRANSPORT_ERROR", detail: thrownName(error), transient: true });
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return err({
				code: "INVALID_RESPONSE",
				detail: `HTTP ${response.status} with a non-JSON body`,
				transient: response.status >= 500,
			});
		}
		if (!response.ok) {
			const apiError = apiErrorBodySchema.safeParse(payload);
			return err({
				code: apiError.success ? apiError.data.error.code : `HTTP_${response.status}`,
				detail: apiError.success ? (apiError.data.error.detail ?? "") : "",
				// CONFLICT means "a version moved under you; send the same request again" — the
				// Worker stops retrying inside one request to stay within its query budget.
				transient:
					response.status === 429 ||
					response.status >= 500 ||
					(apiError.success && apiError.data.error.code === "CONFLICT"),
			});
		}
		const parsed = schema.safeParse(payload);
		return parsed.success
			? ok(parsed.data)
			: err({
					code: "INVALID_RESPONSE",
					detail: "response failed contract validation",
					transient: false,
				});
	}

	async function post<T>(
		path: string,
		body: unknown,
		schema: z.ZodType<T>,
	): Promise<RunnerApiResult<T>> {
		let result = await attempt(path, body, schema);
		for (let tries = 1; tries < maxAttempts && !result.ok && result.error.transient; tries += 1) {
			await options.sleep(500 * 2 ** (tries - 1));
			result = await attempt(path, body, schema);
		}
		return result;
	}

	return {
		claim: (request) => post("/jobs/claim", request, claimJobResponseSchema),
		heartbeat: (runId, leaseGeneration) =>
			post(`/jobs/${runId}/heartbeat`, { leaseGeneration }, heartbeatResponseSchema),
		events: (runId, request) => post(`/jobs/${runId}/events`, request, eventsResponseSchema),
		complete: (runId, request) =>
			post(`/jobs/${runId}/complete`, request, completeJobResponseSchema),
		// One attempt, no backoff: the runner is shutting down, and a release
		// that does not arrive only leaves the lease to run out, as before
		// ADR-0036.
		release: (runId, request) =>
			attempt(
				`/jobs/${runId}/release`,
				request,
				releaseJobResponseSchema,
				Math.min(timeoutMs, RELEASE_TIMEOUT_MS),
			),
		renewCredential: (expiresInDays) =>
			post("/credentials/renew", { expiresInDays }, issuedRunnerCredentialSchema),
	};
}
