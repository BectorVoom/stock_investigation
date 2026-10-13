import type { AgentRunContext } from "@research/agent-core";
import type { AgentEvent, AgentRequest } from "@research/contracts";

export interface ProviderFailure {
	readonly code: string;
	readonly retryable: boolean;
}

/**
 * Stable failure codes shared by all adapters. `retryable` is conservative:
 * it is true only where trying the SAME backend again can plausibly succeed
 * without the owner changing anything, because every retry spends quota.
 */
export const PROVIDER_FAILURES = {
	ABORTED: { code: "ABORTED", retryable: false },
	DEADLINE_EXCEEDED: { code: "DEADLINE_EXCEEDED", retryable: false },
	NOT_CONFIGURED: { code: "NOT_CONFIGURED", retryable: false },
	REQUEST_INVALID: { code: "REQUEST_INVALID", retryable: false },
	SCRATCH_DIRECTORY_REQUIRED: { code: "SCRATCH_DIRECTORY_REQUIRED", retryable: false },
	PROVIDER_NOT_INSTALLED: { code: "PROVIDER_NOT_INSTALLED", retryable: false },
	PROVIDER_SPAWN_FAILED: { code: "PROVIDER_SPAWN_FAILED", retryable: false },
	PROVIDER_CONFIG_WRITE_FAILED: { code: "PROVIDER_CONFIG_WRITE_FAILED", retryable: false },
	PROVIDER_MODEL_REQUIRED: { code: "PROVIDER_MODEL_REQUIRED", retryable: false },
	PROVIDER_MODEL_INVALID: { code: "PROVIDER_MODEL_INVALID", retryable: false },
	PROVIDER_MODEL_UNAVAILABLE: { code: "PROVIDER_MODEL_UNAVAILABLE", retryable: false },
	PROVIDER_AUTH: { code: "PROVIDER_AUTH", retryable: false },
	/**
	 * A plan-limited backend turned out to be authenticated with a metered API
	 * key. Running it would spend money without the owner's consent (AGT-012).
	 */
	PROVIDER_METERED_AUTH_NOT_ALLOWED: {
		code: "PROVIDER_METERED_AUTH_NOT_ALLOWED",
		retryable: false,
	},
	/**
	 * A backend that only runs free models was charged for a request; continuing would
	 * spend money without the owner's consent (AGT-012).
	 */
	PROVIDER_FREE_MODEL_CHARGED: { code: "PROVIDER_FREE_MODEL_CHARGED", retryable: false },
	PROVIDER_PAYMENT_REQUIRED: { code: "PROVIDER_PAYMENT_REQUIRED", retryable: false },
	PROVIDER_RATE_LIMITED: { code: "PROVIDER_RATE_LIMITED", retryable: true },
	PROVIDER_UNAVAILABLE: { code: "PROVIDER_UNAVAILABLE", retryable: true },
	PROVIDER_TIMEOUT: { code: "PROVIDER_TIMEOUT", retryable: true },
	PROVIDER_REQUEST_REJECTED: { code: "PROVIDER_REQUEST_REJECTED", retryable: false },
	PROVIDER_EXIT_NONZERO: { code: "PROVIDER_EXIT_NONZERO", retryable: false },
	PROVIDER_ERROR: { code: "PROVIDER_ERROR", retryable: false },
	PROVIDER_OUTPUT_INVALID: { code: "PROVIDER_OUTPUT_INVALID", retryable: false },
	PROVIDER_OUTPUT_EMPTY: { code: "PROVIDER_OUTPUT_EMPTY", retryable: true },
	PROVIDER_OUTPUT_TOO_LARGE: { code: "PROVIDER_OUTPUT_TOO_LARGE", retryable: false },
	/** The provider cut the answer off at the output-token cap; retrying would cut it off again. */
	PROVIDER_OUTPUT_TRUNCATED: { code: "PROVIDER_OUTPUT_TRUNCATED", retryable: false },
	/** The backend exposed or used a tool of its own although the adapter forbids all of them. */
	PROVIDER_TOOL_ISOLATION_VIOLATED: { code: "PROVIDER_TOOL_ISOLATION_VIOLATED", retryable: false },
	/**
	 * The model tried a tool call that the CLI rejected before it ran
	 * (OpenCode free-tier ask-and-reject path): nothing executed, so this is
	 * not an isolation violation. Non-retryable like the other model-output
	 * failures (e.g. PROVIDER_OUTPUT_INVALID): the same prompt would likely
	 * try a tool again, and every retry spends quota.
	 */
	PROVIDER_TOOL_CALL_REJECTED: { code: "PROVIDER_TOOL_CALL_REJECTED", retryable: false },
	/** The backend did not report the tool list the adapter needs to confirm isolation. */
	PROVIDER_TOOL_ISOLATION_UNVERIFIED: {
		code: "PROVIDER_TOOL_ISOLATION_UNVERIFIED",
		retryable: false,
	},
} as const satisfies Record<string, ProviderFailure>;

/** Model text one turn may deliver before it is rejected (AGT-008). */
export const MAX_OUTPUT_TEXT_CHARS = 2 * 1024 * 1024;
/**
 * Raw transport (JSONL / SSE) one turn may deliver. Streaming envelopes carry a
 * few characters of text in a few hundred bytes of JSON, so this bound is
 * separate from, and larger than, the text bound.
 */
export const MAX_RAW_STREAM_CHARS = 32 * 1024 * 1024;
/** Unparseable lines tolerated in one turn (stray warnings) before the output is rejected. */
export const MAX_MALFORMED_LINES = 8;

export const COMPLETED_EVENT: AgentEvent = { type: "completed" };

export function textDeltaEvent(text: string): AgentEvent {
	return { type: "text.delta", text };
}

/** `null` means "unknown", which is what plan-limited backends always report (AGT-008). */
export function usageEvent(knownCostUsd: number | null): AgentEvent {
	return { type: "usage", knownCostUsd };
}

export function failedEvent(failure: ProviderFailure): AgentEvent {
	return { type: "failed", code: failure.code, retryable: failure.retryable };
}

/** A cost is "known" only when it is a finite, non-negative number. */
export function asKnownCostUsd(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Model ids reach a CLI's argv, so they are restricted to an identifier
 * alphabet and may never start with "-" (which a CLI would read as an option).
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9~@][A-Za-z0-9._:/#~@+-]{0,99}$/;

export function isValidModelId(model: string): boolean {
	return MODEL_ID_PATTERN.test(model);
}

export type Preflight =
	| { readonly ok: true; readonly deadlineEpochMs: number }
	| { readonly ok: false; readonly failure: ProviderFailure };

/** Checks done before any process is spawned or any request is sent. */
export function preflightTurn(
	request: AgentRequest,
	context: AgentRunContext,
	nowEpochMs: number,
): Preflight {
	if (context.signal.aborted) return { ok: false, failure: PROVIDER_FAILURES.ABORTED };
	const deadlineEpochMs = Date.parse(request.deadline);
	if (!Number.isFinite(deadlineEpochMs)) {
		return { ok: false, failure: PROVIDER_FAILURES.REQUEST_INVALID };
	}
	if (deadlineEpochMs <= nowEpochMs) {
		return { ok: false, failure: PROVIDER_FAILURES.DEADLINE_EXCEEDED };
	}
	if (context.model !== null && !isValidModelId(context.model)) {
		return { ok: false, failure: PROVIDER_FAILURES.PROVIDER_MODEL_INVALID };
	}
	return { ok: true, deadlineEpochMs };
}

export type StopReason = "aborted" | "deadline" | "idle" | "finished";

export function failureForStop(reason: StopReason): ProviderFailure {
	if (reason === "deadline") return PROVIDER_FAILURES.DEADLINE_EXCEEDED;
	if (reason === "idle") return PROVIDER_FAILURES.PROVIDER_TIMEOUT;
	return PROVIDER_FAILURES.ABORTED;
}

/**
 * One turn's lifetime: `signal` aborts when the caller cancels, the deadline
 * passes, or the adapter itself stops the turn. The first reason wins, so a
 * late deadline cannot relabel a cancellation.
 */
export interface TurnGuard {
	readonly signal: AbortSignal;
	/** Resolves (never rejects) once the turn has been stopped. */
	readonly stopped: Promise<StopReason>;
	reason(): StopReason | null;
	stop(reason: StopReason): void;
}

/** `setTimeout` cannot represent a longer delay; later deadlines are re-armed by the next turn. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createTurnGuard(
	externalSignal: AbortSignal,
	deadlineEpochMs: number,
	nowEpochMs: number,
): TurnGuard {
	const controller = new AbortController();
	let stopReason: StopReason | null = null;
	let resolveStopped: (reason: StopReason) => void = () => undefined;
	const stopped = new Promise<StopReason>((resolve) => {
		resolveStopped = resolve;
	});
	const onExternalAbort = (): void => stop("aborted");
	const deadlineTimer = setTimeout(
		() => stop("deadline"),
		Math.min(Math.max(deadlineEpochMs - nowEpochMs, 0), MAX_TIMER_DELAY_MS),
	);

	function stop(reason: StopReason): void {
		if (stopReason !== null) return;
		stopReason = reason;
		clearTimeout(deadlineTimer);
		externalSignal.removeEventListener("abort", onExternalAbort);
		controller.abort();
		resolveStopped(reason);
	}

	if (externalSignal.aborted) stop("aborted");
	else externalSignal.addEventListener("abort", onExternalAbort, { once: true });

	return { signal: controller.signal, stopped, reason: () => stopReason, stop };
}

export type Raced<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "stopped"; readonly reason: StopReason };

/** Awaits `work`, but returns as soon as the turn is stopped so no adapter can hang on a provider. */
export function raceStop<T>(guard: TurnGuard, work: Promise<T>): Promise<Raced<T>> {
	return Promise.race([
		work.then((value): Raced<T> => ({ kind: "value", value })),
		guard.stopped.then((reason): Raced<T> => ({ kind: "stopped", reason })),
	]);
}

export type Settled<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: unknown };

/** Turns a rejection into a value so provider errors are handled as data (ARCH-010). */
export function settle<T>(work: Promise<T>): Promise<Settled<T>> {
	return work.then(
		(value): Settled<T> => ({ ok: true, value }),
		(error: unknown): Settled<T> => ({ ok: false, error }),
	);
}

export type JsonLine = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export function parseJsonLine(line: string): JsonLine {
	try {
		const value: unknown = JSON.parse(line);
		return { ok: true, value };
	} catch {
		// JSON.parse only throws SyntaxError; the caller counts the line against MAX_MALFORMED_LINES.
		return { ok: false };
	}
}

export type FailureHint = "auth" | "payment" | "rate-limit" | "unavailable";

const AUTH_PATTERN =
	/not logged in|please run \/login|log ?in required|unauthori[sz]ed|authentication|invalid api key|invalid credentials|\b401\b|\b403\b/i;
const PAYMENT_PATTERN = /insufficient credits|payment required|billing|\b402\b/i;
const RATE_LIMIT_PATTERN = /rate limit|usage limit|limit reached|quota|too many requests|\b429\b/i;
const UNAVAILABLE_PATTERN = /overloaded|service unavailable|bad gateway|\b50[0234]\b|\b529\b/i;

/**
 * Best-effort reading of a provider's free-text error. Used only to choose a
 * failure code; the text itself never leaves the adapter.
 */
export function hintFromText(text: string): FailureHint | null {
	if (AUTH_PATTERN.test(text)) return "auth";
	if (PAYMENT_PATTERN.test(text)) return "payment";
	if (RATE_LIMIT_PATTERN.test(text)) return "rate-limit";
	if (UNAVAILABLE_PATTERN.test(text)) return "unavailable";
	return null;
}

export function hintFromHttpStatus(status: number): FailureHint | null {
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "payment";
	if (status === 429) return "rate-limit";
	if (status >= 500) return "unavailable";
	return null;
}

export function failureForHint(hint: FailureHint): ProviderFailure {
	if (hint === "auth") return PROVIDER_FAILURES.PROVIDER_AUTH;
	if (hint === "payment") return PROVIDER_FAILURES.PROVIDER_PAYMENT_REQUIRED;
	if (hint === "rate-limit") return PROVIDER_FAILURES.PROVIDER_RATE_LIMITED;
	return PROVIDER_FAILURES.PROVIDER_UNAVAILABLE;
}
