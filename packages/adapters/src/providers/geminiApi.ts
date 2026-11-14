/**
 * Gemini API adapter — Google's OpenAI-compatible chat completions, one
 * streaming request over HTTPS (ADR-0075).
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/gemini-api.md
 * Verified live on 2026-11-14: streamed answers from `gemini-3.5-flash`,
 * `gemini-3.5-flash-lite`, `gemini-3.6-flash` and `gemini-3.1-flash-lite`,
 * `finish_reason: "length"` at the token cap, and the 400 / 404 / 429 / 503 answers.
 *
 * - The SSE chunks have OpenRouter's shape (`choices[0].delta.content`,
 *   `finish_reason`, `[DONE]`), so each line is read by OpenRouter's
 *   `interpretSseLine`. Gemini's `delta.extra_content.google.thought_signature`
 *   is ignored and never forwarded.
 * - Tool isolation is "enforced" by construction: one user message, no `tools`.
 * - Plan-limited: the endpoint publishes no prices and returns no cost field,
 *   so every turn's cost is unknown (null) — never 0 — and a question carries
 *   no maximum spend.
 * - Fixed request fields: `model`, `messages`, `stream`,
 *   `max_completion_tokens` (16,000) and `reasoning_effort` set to the run's
 *   effort (accepted by every offered model).
 * - Bounded output per turn: `max_completion_tokens` is 16,000; a turn stopped
 *   by it is PROVIDER_OUTPUT_TRUNCATED, never a completed answer.
 * - No fallback (AGT-012): one model; a model the API does not serve answers
 *   404 and fails with PROVIDER_REQUEST_REJECTED.
 * - Transient rejections (network error, 429, 5xx, an error chunk before any
 *   content) are retried by `runHttpTurn`; status alone chooses the error code
 *   and travels unchanged as `upstreamStatus` (§4a).
 * - The key is read from GEMINI_API_KEY, sent only in the Authorization
 *   header to the fixed origin below, never logged and never placed in an
 *   event; redirects are refused so it cannot reach another host.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime, Effort } from "@research/agent-core";
import {
	type AgentCapabilities,
	type AgentEvent,
	type AgentRequest,
	GEMINI_API_AGENT_ID,
} from "@research/contracts";
import { AVAILABLE, unavailable } from "./cliProbe.ts";
import type { ProviderEnvironment } from "./environment.ts";
import {
	type AttemptEnd,
	FINISHED,
	failureForHttpStatus,
	type IdleWatch,
	MAX_SSE_LINE_CHARS,
	newBodyReadState,
	openStream,
	readApiKey,
	readBody,
	runHttpTurn,
} from "./httpTurn.ts";
import { splitLines } from "./lines.ts";
import { interpretSseLine } from "./openRouter.ts";
import {
	COMPLETED_EVENT,
	failedEvent,
	failureForStop,
	isValidModelId,
	MAX_MALFORMED_LINES,
	MAX_OUTPUT_TEXT_CHARS,
	PROVIDER_FAILURES,
	type ProviderFailure,
	preflightTurn,
	type TurnGuard,
	textDeltaEvent,
	usageEvent,
} from "./turn.ts";

export const GEMINI_CHAT_COMPLETIONS_URL =
	"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/** Output limit per turn (`max_completion_tokens`). */
export const GEMINI_MAX_COMPLETION_TOKENS = 16_000;

/**
 * Models Settings offers, checked live on 2026-11-14. Another model id can still
 * be typed through "Other"; the API refuses one it does not serve.
 */
export const GEMINI_API_MODELS: readonly string[] = [
	"gemini-3.5-flash",
	"gemini-3.5-flash-lite",
	"gemini-3.6-flash",
	"gemini-3.1-flash-lite",
];

/** The model used when Settings leaves the model empty and GEMINI_MODEL is unset. */
export const GEMINI_API_DEFAULT_MODEL = "gemini-3.5-flash";

/** The request body, keys in this order (both runners send the same bytes). */
export function buildGeminiRequestBody(model: string, prompt: string, effort: Effort): string {
	return JSON.stringify({
		model,
		messages: [{ role: "user", content: prompt }],
		stream: true,
		max_completion_tokens: GEMINI_MAX_COMPLETION_TOKENS,
		reasoning_effort: effort,
	});
}

/** Settings' model, else GEMINI_MODEL, else the default. */
export function resolveGeminiModel(
	env: Readonly<Record<string, string | undefined>>,
	requestedModel: string | null,
): string {
	if (requestedModel !== null) return requestedModel;
	const configured = env.GEMINI_MODEL?.trim() ?? "";
	return configured === "" ? GEMINI_API_DEFAULT_MODEL : configured;
}

function readKey(env: Readonly<Record<string, string | undefined>>): string | null {
	return readApiKey(env.GEMINI_API_KEY);
}

interface GeminiConfig {
	readonly apiKey: string;
	readonly model: string;
}

async function* attemptChatCompletion(
	environment: ProviderEnvironment,
	config: GeminiConfig,
	request: AgentRequest,
	context: AgentRunContext,
	guard: TurnGuard,
	idle: IdleWatch,
): AsyncGenerator<AgentEvent, AttemptEnd> {
	const opened = await openStream(
		environment,
		{
			url: GEMINI_CHAT_COMPLETIONS_URL,
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: buildGeminiRequestBody(config.model, request.prompt, context.effort),
			failureForStatus: failureForHttpStatus,
		},
		guard,
		idle,
	);
	if (opened.kind === "ended") {
		yield* opened.events;
		return opened.end;
	}

	const bodyState = newBodyReadState();
	let emittedTextChars = 0;
	let malformedLines = 0;
	let sawChunk = false;
	let sawEnd = false;
	let truncated = false;
	let failure: ProviderFailure | null = null;
	/** An error chunk that arrived before any content: the provider refused the request. */
	let rejectedBeforeOutput: ProviderFailure | null = null;
	const sseLines = splitLines(
		readBody(opened.body, guard, idle.touch, bodyState),
		MAX_SSE_LINE_CHARS,
	);
	for await (const line of sseLines) {
		const verdict = interpretSseLine(line);
		if (verdict.kind === "done") {
			sawEnd = true;
			break;
		}
		if (verdict.kind === "failed") {
			if (!sawChunk) rejectedBeforeOutput = verdict.failure;
			else failure = verdict.failure;
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
		sawChunk = true;
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
	if (stopReason === null && rejectedBeforeOutput !== null) {
		return {
			kind: "rejected",
			failure: rejectedBeforeOutput,
			retryAfterMs: null,
			events: [usageEvent(null), failedEvent(rejectedBeforeOutput)],
		};
	}
	if (stopReason !== null) failure = failureForStop(stopReason);
	else if (failure === null && bodyState.tooLarge) {
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE;
	} else if (failure === null && bodyState.readFailed) {
		failure = PROVIDER_FAILURES.PROVIDER_UNAVAILABLE;
	} else if (failure === null && !sawEnd) {
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
	} else if (failure === null && truncated) {
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TRUNCATED;
	} else if (failure === null && emittedTextChars === 0) {
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_EMPTY;
	}
	// Plan-limited: the endpoint returns no cost, so cost is always unknown.
	yield usageEvent(null);
	yield failure === null ? COMPLETED_EVENT : failedEvent(failure);
	return FINISHED;
}

export function createGeminiApiRuntime(environment: ProviderEnvironment): AgentRuntime {
	// Deliberately offline: a probe must not spend quota.
	async function probe(): Promise<AgentProbe> {
		const model = resolveGeminiModel(environment.env, null);
		const capabilities: AgentCapabilities = {
			supported: ["stream", "cancel"],
			...(isValidModelId(model) ? { model } : {}),
			models: [...GEMINI_API_MODELS],
		};
		return {
			capabilities,
			availability:
				readKey(environment.env) !== null
					? AVAILABLE
					: unavailable(
							"NOT_CONFIGURED",
							"The Gemini API needs GEMINI_API_KEY in the runner environment",
						),
		};
	}

	async function* run(request: AgentRequest, context: AgentRunContext): AsyncGenerator<AgentEvent> {
		const preflight = preflightTurn(request, context, Date.now());
		if (!preflight.ok) {
			yield failedEvent(preflight.failure);
			return;
		}
		// Fail closed before any network activity when the key or a usable model id is missing.
		const apiKey = readKey(environment.env);
		if (apiKey === null) {
			yield failedEvent(PROVIDER_FAILURES.NOT_CONFIGURED);
			return;
		}
		const model = resolveGeminiModel(environment.env, context.model);
		if (!isValidModelId(model)) {
			yield failedEvent(PROVIDER_FAILURES.PROVIDER_MODEL_INVALID);
			return;
		}
		const config: GeminiConfig = { apiKey, model };
		yield* runHttpTurn(context, preflight.deadlineEpochMs, (guard, idle) =>
			attemptChatCompletion(environment, config, request, context, guard, idle),
		);
	}

	return {
		agentId: GEMINI_API_AGENT_ID,
		displayName: "Gemini API",
		costModel: "plan-limited",
		toolIsolation: "enforced",
		probe,
		run,
	};
}
