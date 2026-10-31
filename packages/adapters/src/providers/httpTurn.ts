/**
 * The parts of a streaming HTTPS turn that every HTTP backend shares
 * (OpenRouter, Claude API): the idle watch, the bounded body reader, opening
 * the request, and retrying a request the provider turned away before it
 * generated anything. Each backend keeps only its own wire format.
 */
import type { AgentRunContext } from "@research/agent-core";
import type { AgentEvent } from "@research/contracts";
import { parseRetryAfterMs } from "../http/retryAfter.ts";
import type { ProviderEnvironment } from "./environment.ts";
import {
	createTurnGuard,
	failedEvent,
	failureForHint,
	failureForStop,
	hintFromHttpStatus,
	MAX_RAW_STREAM_CHARS,
	PROVIDER_FAILURES,
	type ProviderFailure,
	type Raced,
	raceStop,
	settle,
	type TurnGuard,
	usageEvent,
	withUpstreamStatus,
} from "./turn.ts";

/** Longest silence tolerated between two chunks (or before the response headers). */
export const IDLE_TIMEOUT_MS = 120_000;
/** A provider may send a long answer as one chunk; see MAX_LINE_CHARS in processRunner.ts. */
export const MAX_SSE_LINE_CHARS = 16 * 1024 * 1024;
/**
 * Bytes of a rejected answer's body read for its error code. Provider error
 * bodies are a few hundred bytes; a longer one is not an error object we know.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Printable ASCII without spaces: anything else cannot be a valid header value. */
const API_KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

/** The trimmed key from `value`, or null when it could not be sent as a header. */
export function readApiKey(value: string | undefined): string | null {
	const apiKey = value?.trim() ?? "";
	return API_KEY_PATTERN.test(apiKey) ? apiKey : null;
}

/** Our code for a provider's HTTP error answer, carrying the status itself unchanged (§4a). */
export function failureForHttpStatus(status: number): ProviderFailure {
	if (status === 408) return withUpstreamStatus(PROVIDER_FAILURES.PROVIDER_TIMEOUT, status);
	const hint = hintFromHttpStatus(status);
	return withUpstreamStatus(
		hint === null ? PROVIDER_FAILURES.PROVIDER_REQUEST_REJECTED : failureForHint(hint),
		status,
	);
}

export interface IdleWatch {
	touch(): void;
	clear(): void;
}

/** Stops the turn with "idle" when the provider goes silent for too long. */
function createIdleWatch(guard: TurnGuard): IdleWatch {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clear = (): void => {
		if (timer !== undefined) clearTimeout(timer);
	};
	const touch = (): void => {
		clear();
		timer = setTimeout(() => guard.stop("idle"), IDLE_TIMEOUT_MS);
	};
	return { touch, clear };
}

export interface BodyReadState {
	receivedBytes: number;
	tooLarge: boolean;
	readFailed: boolean;
}

export function newBodyReadState(): BodyReadState {
	return { receivedBytes: 0, tooLarge: false, readFailed: false };
}

/** Yields the body's bytes until it ends, the turn is stopped, or the size cap is reached. */
export async function* readBody(
	body: ReadableStream<Uint8Array>,
	guard: TurnGuard,
	onActivity: () => void,
	state: BodyReadState,
): AsyncGenerator<Uint8Array, void, undefined> {
	const reader = body.getReader();
	try {
		while (true) {
			const next = await raceStop(guard, settle(reader.read()));
			if (next.kind === "stopped") return;
			if (!next.value.ok) {
				state.readFailed = true;
				return;
			}
			const { done, value } = next.value.value;
			if (done) return;
			onActivity();
			state.receivedBytes += value.byteLength;
			if (state.receivedBytes > MAX_RAW_STREAM_CHARS) {
				state.tooLarge = true;
				return;
			}
			yield value;
		}
	} finally {
		// Releases the connection; whether cancelling succeeds no longer changes the turn's outcome.
		await settle(reader.cancel());
	}
}

/**
 * Transient rejections retried inside one turn. Only a request the provider
 * turned away before it generated anything is sent again — the same request
 * to the same model — so a retry is never billed and never falls back to
 * another model (AGT-008, AGT-012). Free models in particular are often
 * "temporarily overloaded" upstream for a few seconds; without this, the
 * job's own retries are spent within a second of each other.
 */
export const REJECTION_RETRY = {
	maxRetries: 3,
	baseDelayMs: 2_000,
	/** A longer Retry-After (e.g. a spent daily free quota) is not waited out inside a turn. */
	maxDelayMs: 30_000,
	/** Time the turn must still have after a wait, or the retried request could not finish. */
	minRemainingMs: 30_000,
} as const;

function isTransientRejection(failure: ProviderFailure): boolean {
	return (
		failure.code === PROVIDER_FAILURES.PROVIDER_UNAVAILABLE.code ||
		failure.code === PROVIDER_FAILURES.PROVIDER_RATE_LIMITED.code
	);
}

/**
 * The wait before retry number `retryIndex` (0-based): the provider's
 * Retry-After when given, otherwise exponential backoff. `null` means do not
 * retry — retries are used up, the provider asks for too long a wait, or the
 * turn's deadline leaves no room for another request.
 */
export function rejectionRetryDelayMs(
	retryIndex: number,
	retryAfterMs: number | null,
	remainingMs: number,
): number | null {
	if (retryIndex >= REJECTION_RETRY.maxRetries) return null;
	const delayMs = retryAfterMs ?? REJECTION_RETRY.baseDelayMs * 2 ** retryIndex;
	if (delayMs > REJECTION_RETRY.maxDelayMs) return null;
	if (remainingMs - delayMs < REJECTION_RETRY.minRemainingMs) return null;
	return delayMs;
}

/** Waits `ms`, returning early when the turn is stopped; the timer never outlives the wait. */
async function waitOrStop(guard: TurnGuard, ms: number): Promise<Raced<void>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const elapsed = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	try {
		return await raceStop(guard, elapsed);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * How one request ended. `rejected`: the provider refused it before any
 * output, nothing was yielded yet, and `events` are what the turn reports if
 * it is not retried.
 */
export type AttemptEnd =
	| { readonly kind: "finished" }
	| {
			readonly kind: "rejected";
			readonly failure: ProviderFailure;
			readonly retryAfterMs: number | null;
			readonly events: readonly AgentEvent[];
	  };

export const FINISHED: AttemptEnd = { kind: "finished" };

/** One request of a turn, given the turn's guard and idle watch. */
export type HttpAttempt = (
	guard: TurnGuard,
	idle: IdleWatch,
) => AsyncGenerator<AgentEvent, AttemptEnd>;

/**
 * Runs `attempt` until it finishes, retrying a transient rejection before any
 * output (REJECTION_RETRY) within the turn's deadline.
 */
export async function* runHttpTurn(
	context: AgentRunContext,
	deadlineEpochMs: number,
	attempt: HttpAttempt,
): AsyncGenerator<AgentEvent> {
	const guard = createTurnGuard(context.signal, deadlineEpochMs, Date.now());
	const idle = createIdleWatch(guard);
	try {
		for (let retryIndex = 0; ; retryIndex += 1) {
			const end = yield* attempt(guard, idle);
			if (end.kind === "finished") return;
			const delayMs = isTransientRejection(end.failure)
				? rejectionRetryDelayMs(retryIndex, end.retryAfterMs, deadlineEpochMs - Date.now())
				: null;
			if (delayMs === null) {
				yield* end.events;
				return;
			}
			// The wait is ours, not the provider's silence: the idle watch restarts with the next request.
			idle.clear();
			const waited = await waitOrStop(guard, delayMs);
			if (waited.kind === "stopped") {
				// Nothing is in flight during the wait, so there is no usage to report.
				yield failedEvent(failureForStop(waited.reason));
				return;
			}
		}
	} finally {
		idle.clear();
		// Also aborts the HTTP request when the consumer stops iterating early.
		guard.stop("finished");
	}
}

/** What opening a streaming request produced: a body to read, or the end of the attempt. */
export type OpenedStream =
	| { readonly kind: "open"; readonly body: ReadableStream<Uint8Array> }
	| { readonly kind: "ended"; readonly end: AttemptEnd; readonly events: readonly AgentEvent[] };

export interface StreamRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	/**
	 * The backend's reading of a non-2xx answer: its status and its body
	 * (`readErrorBody`, `null` when unreadable). The body only chooses the
	 * code; its text never leaves the adapter.
	 */
	readonly failureForStatus: (status: number, body: string | null) => ProviderFailure;
}

/**
 * A rejected answer's body as text, for its error code: at most
 * MAX_ERROR_BODY_BYTES, `null` when it is longer, unreadable or the turn stops.
 * The BOM is kept, as the Rust port keeps it, so neither side parses it.
 */
async function readErrorBody(
	body: ReadableStream<Uint8Array> | null,
	guard: TurnGuard,
	idle: IdleWatch,
): Promise<string | null> {
	if (body === null) return null;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await raceStop(guard, settle(reader.read()));
			if (next.kind === "stopped" || !next.value.ok) return null;
			const { done, value } = next.value.value;
			if (done) break;
			idle.touch();
			size += value.byteLength;
			if (size > MAX_ERROR_BODY_BYTES) return null;
			chunks.push(value);
		}
	} finally {
		// Releases the connection; whether cancelling succeeds no longer matters.
		await settle(reader.cancel());
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * Sends one POST and classifies everything that can happen before the body:
 * the turn stopping, a network error, a rejecting status (with its
 * Retry-After and its bounded error body) and a missing body. Redirects are refused so the key cannot be
 * forwarded to another origin.
 */
export async function openStream(
	environment: ProviderEnvironment,
	request: StreamRequest,
	guard: TurnGuard,
	idle: IdleWatch,
): Promise<OpenedStream> {
	idle.touch();
	const responded = await raceStop(
		guard,
		settle(
			// Called through the environment so the runner controls the transport.
			environment.fetch(request.url, {
				method: "POST",
				headers: request.headers,
				body: request.body,
				redirect: "error",
				signal: guard.signal,
			}),
		),
	);
	if (responded.kind === "stopped") {
		// The request may have reached the provider, so the cost is unknown rather than absent.
		return {
			kind: "ended",
			end: FINISHED,
			events: [usageEvent(null), failedEvent(failureForStop(responded.reason))],
		};
	}
	if (!responded.value.ok) {
		const failure = PROVIDER_FAILURES.PROVIDER_UNAVAILABLE;
		return {
			kind: "ended",
			end: { kind: "rejected", failure, retryAfterMs: null, events: [failedEvent(failure)] },
			events: [],
		};
	}
	const response = responded.value.value;
	if (!response.ok) {
		// Rejected before generation started: nothing was produced, so no usage is reported.
		const failure = request.failureForStatus(
			response.status,
			await readErrorBody(response.body, guard, idle),
		);
		return {
			kind: "ended",
			end: {
				kind: "rejected",
				failure,
				retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"), Date.now()),
				events: [failedEvent(failure)],
			},
			events: [],
		};
	}
	if (response.body === null) {
		return {
			kind: "ended",
			end: FINISHED,
			events: [usageEvent(null), failedEvent(PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID)],
		};
	}
	return { kind: "open", body: response.body };
}
