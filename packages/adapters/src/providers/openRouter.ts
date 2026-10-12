/**
 * OpenRouter adapter — one streaming chat completion over HTTPS.
 *
 * DOC-DERIVED, NOT LIVE-VERIFIED (no API key was available). Written
 * 2026-10-11 from:
 *   https://openrouter.ai/docs/quickstart                 (endpoint, Bearer auth)
 *   https://openrouter.ai/docs/api-reference/chat-completion
 *   https://openrouter.ai/docs/api-reference/streaming    (SSE, comments, [DONE], mid-stream errors, cancel)
 *   https://openrouter.ai/docs/use-cases/usage-accounting (usage.cost in the final chunk)
 *   https://openrouter.ai/docs/api-reference/errors       (status codes)
 *   https://openrouter.ai/docs/faq                        (credits are denominated in US dollars)
 *
 * - Tool isolation is "enforced" by construction: the request carries one user
 *   message and no `tools`, so the model has nothing to call and nothing runs
 *   on the owner's machine.
 * - `stream`: `choices[0].delta.content` chunks are forwarded as they arrive.
 *   `cancel`: aborting the HTTP request is the documented way to stop a stream
 *   (the docs note that some upstream providers keep generating and bill
 *   anyway, which is why an aborted turn reports its cost as unknown).
 * - Cost: `usage.cost` from the final chunk is the amount charged, in credits
 *   whose base currency is USD. The docs say usage is now always included and
 *   that `usage: {include: true}` is a deprecated no-op; it is still sent so
 *   older behaviour is covered. No cost in the response => unknown (null),
 *   never 0.
 * - Bounded spend per turn: every request carries `max_completion_tokens`
 *   (MAX_COMPLETION_TOKENS). Both `max_tokens` and `max_completion_tokens` are
 *   documented at https://openrouter.ai/docs/api-reference/parameters with the
 *   same meaning; the API reference marks `max_tokens` as deprecated in favour
 *   of `max_completion_tokens`, so that one is sent. For reasoning models the
 *   limit covers reasoning and visible output together, and the docs warn that
 *   a small limit can be used up by reasoning, ending with
 *   `finish_reason: "length"`. A turn that ends that way is reported as
 *   PROVIDER_OUTPUT_TRUNCATED (not retryable: the same cap would cut it off
 *   again), never as a completed answer.
 * - No fallback: the request names exactly one model and no `models` list, and
 *   the adapter never retries (AGT-012). OpenRouter may still route the SAME
 *   model to another upstream provider, at that provider's price.
 * - The API key is read from OPENROUTER_API_KEY, sent only in the
 *   Authorization header to the fixed origin below, never logged and never
 *   placed in an event; redirects are refused so it cannot be forwarded.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import type { AgentCapabilities, AgentEvent, AgentRequest } from "@research/contracts";
import { z } from "zod";
import { AVAILABLE, unavailable } from "./cliProbe.ts";
import type { ProviderEnvironment } from "./environment.ts";
import { splitLines } from "./lines.ts";
import {
	asKnownCostUsd,
	COMPLETED_EVENT,
	createTurnGuard,
	failedEvent,
	failureForHint,
	failureForStop,
	hintFromHttpStatus,
	isValidModelId,
	MAX_MALFORMED_LINES,
	MAX_OUTPUT_TEXT_CHARS,
	MAX_RAW_STREAM_CHARS,
	PROVIDER_FAILURES,
	type ProviderFailure,
	parseJsonLine,
	preflightTurn,
	raceStop,
	settle,
	type TurnGuard,
	textDeltaEvent,
	usageEvent,
} from "./turn.ts";

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Upper bound on the tokens (reasoning + visible output) one request may
 * generate. This is what bounds a single turn's spend on a metered backend
 * (AGT-008): without it the provider's own maximum, often 100k+ tokens, applies.
 */
export const MAX_COMPLETION_TOKENS = 8_192;

/** Longest silence tolerated between two chunks (or before the response headers). */
const IDLE_TIMEOUT_MS = 120_000;
/** A provider may send a long answer as one chunk; see MAX_LINE_CHARS in processRunner.ts. */
const MAX_SSE_LINE_CHARS = 16 * 1024 * 1024;

/** Printable ASCII without spaces: anything else cannot be a valid header value. */
const API_KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

interface OpenRouterConfig {
	readonly apiKey: string;
	readonly model: string;
}

function readConfig(
	env: Readonly<Record<string, string | undefined>>,
	requestedModel: string | null,
): OpenRouterConfig | null {
	const apiKey = env.OPENROUTER_API_KEY?.trim() ?? "";
	const model = requestedModel ?? env.OPENROUTER_MODEL?.trim() ?? "";
	if (!API_KEY_PATTERN.test(apiKey) || !isValidModelId(model)) return null;
	return { apiKey, model };
}

export function failureForHttpStatus(status: number): ProviderFailure {
	if (status === 408) return PROVIDER_FAILURES.PROVIDER_TIMEOUT;
	const hint = hintFromHttpStatus(status);
	return hint === null ? PROVIDER_FAILURES.PROVIDER_REQUEST_REJECTED : failureForHint(hint);
}

const chunkSchema = z.looseObject({
	error: z.looseObject({ code: z.union([z.number(), z.string()]).optional() }).optional(),
	choices: z
		.array(
			z.looseObject({
				delta: z.looseObject({ content: z.string().nullable().optional() }).optional(),
				finish_reason: z.string().nullable().optional(),
			}),
		)
		.optional(),
	usage: z.looseObject({ cost: z.number().nullable().optional() }).nullable().optional(),
});

/** A mid-stream error arrives with HTTP 200; its `code` mirrors an HTTP status when numeric. */
function failureForStreamError(code: number | string | undefined): ProviderFailure {
	const hint = typeof code === "number" ? hintFromHttpStatus(code) : null;
	return failureForHint(hint ?? "unavailable");
}

export type SseVerdict =
	| { readonly kind: "ignored" }
	| { readonly kind: "malformed" }
	| { readonly kind: "done" }
	| { readonly kind: "failed"; readonly failure: ProviderFailure }
	| {
			readonly kind: "chunk";
			readonly text: string;
			readonly finished: boolean;
			/** The provider stopped at the output-token cap, so the text is cut off. */
			readonly truncated: boolean;
			/** `undefined` when this chunk carries no usage object. */
			readonly knownCostUsd: number | null | undefined;
	  };

/** Interprets one line of the SSE body. Pure, so chunk-boundary handling is tested separately. */
export function interpretSseLine(line: string): SseVerdict {
	// Blank separators, ": OPENROUTER PROCESSING" keep-alive comments, and event:/id: fields.
	if (!line.startsWith("data:")) return { kind: "ignored" };
	const payload = line.slice("data:".length).trim();
	if (payload === "[DONE]") return { kind: "done" };
	const json = parseJsonLine(payload);
	if (!json.ok) return { kind: "malformed" };
	const parsed = chunkSchema.safeParse(json.value);
	if (!parsed.success) return { kind: "malformed" };
	const chunk = parsed.data;
	if (chunk.error !== undefined) {
		return { kind: "failed", failure: failureForStreamError(chunk.error.code) };
	}
	const choice = chunk.choices?.[0];
	if (choice?.finish_reason === "error") {
		return { kind: "failed", failure: PROVIDER_FAILURES.PROVIDER_UNAVAILABLE };
	}
	return {
		kind: "chunk",
		text: choice?.delta?.content ?? "",
		finished: typeof choice?.finish_reason === "string",
		truncated: choice?.finish_reason === "length",
		knownCostUsd:
			chunk.usage === undefined || chunk.usage === null
				? undefined
				: asKnownCostUsd(chunk.usage.cost),
	};
}

/** Stops the turn with "idle" when the provider goes silent for too long. */
function createIdleWatch(guard: TurnGuard): { touch(): void; clear(): void } {
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

interface BodyReadState {
	receivedBytes: number;
	tooLarge: boolean;
	readFailed: boolean;
}

/** Yields the body's bytes until it ends, the turn is stopped, or the size cap is reached. */
async function* readBody(
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

export function createOpenRouterRuntime(environment: ProviderEnvironment): AgentRuntime {
	const capabilities = (): AgentCapabilities => {
		const model = environment.env.OPENROUTER_MODEL?.trim() ?? "";
		const supported = ["stream", "cancel"] as const;
		return isValidModelId(model) ? { supported, model } : { supported };
	};

	// Deliberately offline: a probe must not spend quota, and key validity shows up as PROVIDER_AUTH.
	async function probe(): Promise<AgentProbe> {
		const configured = readConfig(environment.env, null) !== null;
		return {
			capabilities: capabilities(),
			availability: configured
				? AVAILABLE
				: unavailable(
						"NOT_CONFIGURED",
						"OpenRouter needs OPENROUTER_API_KEY and OPENROUTER_MODEL in the runner environment",
					),
		};
	}

	async function* run(request: AgentRequest, context: AgentRunContext): AsyncGenerator<AgentEvent> {
		const preflight = preflightTurn(request, context, Date.now());
		if (!preflight.ok) {
			yield failedEvent(preflight.failure);
			return;
		}
		// Fail closed before any network activity when the key or the model is missing.
		const config = readConfig(environment.env, context.model);
		if (config === null) {
			yield failedEvent(PROVIDER_FAILURES.NOT_CONFIGURED);
			return;
		}
		const guard = createTurnGuard(context.signal, preflight.deadlineEpochMs, Date.now());
		const idle = createIdleWatch(guard);
		try {
			idle.touch();
			const responded = await raceStop(
				guard,
				settle(
					// Called through the environment so the runner controls the transport.
					environment.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${config.apiKey}`,
							"Content-Type": "application/json",
							Accept: "text/event-stream",
						},
						body: JSON.stringify({
							model: config.model,
							messages: [{ role: "user", content: request.prompt }],
							stream: true,
							max_completion_tokens: MAX_COMPLETION_TOKENS,
							usage: { include: true },
							reasoning: { effort: context.effort },
						}),
						redirect: "error",
						signal: guard.signal,
					}),
				),
			);
			if (responded.kind === "stopped") {
				// The request may have reached the provider, so the cost is unknown rather than absent.
				yield usageEvent(null);
				yield failedEvent(failureForStop(responded.reason));
				return;
			}
			if (!responded.value.ok) {
				yield failedEvent(PROVIDER_FAILURES.PROVIDER_UNAVAILABLE);
				return;
			}
			const response = responded.value.value;
			if (!response.ok) {
				// Rejected before generation started: nothing was produced, so no usage is reported.
				await settle(response.body?.cancel() ?? Promise.resolve());
				yield failedEvent(failureForHttpStatus(response.status));
				return;
			}
			if (response.body === null) {
				yield usageEvent(null);
				yield failedEvent(PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID);
				return;
			}

			const bodyState: BodyReadState = { receivedBytes: 0, tooLarge: false, readFailed: false };
			let knownCostUsd: number | null = null;
			let emittedTextChars = 0;
			let malformedLines = 0;
			let sawEnd = false;
			let truncated = false;
			let failure: ProviderFailure | null = null;
			const sseLines = splitLines(
				readBody(response.body, guard, idle.touch, bodyState),
				MAX_SSE_LINE_CHARS,
			);
			for await (const line of sseLines) {
				const verdict = interpretSseLine(line);
				if (verdict.kind === "done") {
					sawEnd = true;
					break;
				}
				if (verdict.kind === "failed") {
					failure = verdict.failure;
					break;
				}
				if (verdict.kind === "malformed") {
					malformedLines += 1;
					if (malformedLines > MAX_MALFORMED_LINES) {
						failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
						break;
					}
				}
				if (verdict.kind !== "chunk") continue;
				if (verdict.knownCostUsd !== undefined) knownCostUsd = verdict.knownCostUsd;
				if (verdict.finished) sawEnd = true;
				if (verdict.truncated) truncated = true;
				if (verdict.text.length > 0) {
					emittedTextChars += verdict.text.length;
					if (emittedTextChars > MAX_OUTPUT_TEXT_CHARS) {
						failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE;
						break;
					}
					yield textDeltaEvent(verdict.text);
				}
			}

			const stopReason = guard.reason();
			if (stopReason !== null) failure = failureForStop(stopReason);
			else if (failure === null && bodyState.tooLarge) {
				failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE;
			} else if (failure === null && bodyState.readFailed) {
				failure = PROVIDER_FAILURES.PROVIDER_UNAVAILABLE;
			} else if (failure === null && !sawEnd) {
				// The connection closed without [DONE] or a finish_reason: the answer is truncated.
				failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
			} else if (failure === null && truncated) {
				// Stopped at MAX_COMPLETION_TOKENS, possibly inside reasoning with no visible text at
				// all. Checked before "empty" so a capped turn is never retried into the same cap.
				failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TRUNCATED;
			} else if (failure === null && emittedTextChars === 0) {
				failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_EMPTY;
			}
			yield usageEvent(knownCostUsd);
			yield failure === null ? COMPLETED_EVENT : failedEvent(failure);
		} finally {
			idle.clear();
			// Also aborts the HTTP request when the consumer stops iterating early.
			guard.stop("finished");
		}
	}

	return {
		agentId: "openrouter",
		displayName: "OpenRouter",
		costModel: "metered",
		toolIsolation: "enforced",
		probe,
		run,
	};
}
