/**
 * Sarashina API adapter — SB Intuitions' OpenAI-compatible chat completions,
 * one streaming request over HTTPS (ADR-0074).
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/sarashina-api.md
 * Verified live on 2026-11-13: the model list, streamed answers from
 * `sarashina3-mini` and `sarashina3.2-mini-thinking`, `finish_reason: "length"`
 * at the token cap, and the 400 / 401 answers.
 *
 * - The SSE chunks have OpenRouter's shape (`choices[0].delta.content`,
 *   `finish_reason`, a final `usage` chunk with `choices: []`, `[DONE]`), so
 *   each line is read by OpenRouter's `interpretSseLine`. A thinking model's
 *   `delta.reasoning` is an opaque encrypted string; it is never forwarded.
 * - Tool isolation is "enforced" by construction: one user message, no `tools`.
 * - Plan-limited: the API is a free beta, publishes no prices and reports
 *   token counts only (`usage` has no cost), so every turn's cost is unknown
 *   (null) — never 0 — and a question carries no maximum spend.
 * - The API refuses undocumented fields with 400, so the body carries only
 *   `model`, `messages`, `stream`, `max_completion_tokens` and, for a thinking
 *   model (id ending in `-thinking`), `reasoning_effort`; other models answer
 *   `reasoning_effort` with 400 ("not supported for model").
 * - Bounded output per turn: `max_completion_tokens` is the API's own maximum,
 *   8,000 (a larger value is refused with 400). It covers thinking and answer;
 *   a turn stopped by it is PROVIDER_OUTPUT_TRUNCATED, never a completed answer.
 * - No fallback (AGT-012): one model; a model the API does not serve answers
 *   400 and the turn fails with PROVIDER_REQUEST_REJECTED.
 * - Transient rejections (network error, 429, 5xx, an error chunk before any
 *   content) are retried by `runHttpTurn` like OpenRouter's. Error bodies are
 *   `{"message": "..."}`; the message never leaves the adapter, the status is
 *   kept unchanged (§4a).
 * - The key is read from SARASHINA_API_KEY, sent only in the Authorization
 *   header to the fixed origin below, never logged and never placed in an
 *   event; redirects are refused so it cannot reach another host.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime, Effort } from "@research/agent-core";
import {
	type AgentCapabilities,
	type AgentEvent,
	type AgentRequest,
	SARASHINA_API_AGENT_ID,
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

export const SARASHINA_CHAT_COMPLETIONS_URL = "https://api.sarashina.ai/v1/chat/completions";

/** The API's own maximum for `max_completion_tokens` (thinking and answer together). */
export const SARASHINA_MAX_COMPLETION_TOKENS = 8_000;

/**
 * The chat models Settings offers, most capable first (from `GET /v1/models`,
 * 2026-11-13, without the embedding, rerank and guard models). Another id can
 * still be typed; the API refuses one it does not serve.
 */
export const SARASHINA_API_MODELS: readonly string[] = [
	"sarashina3.2-mini-thinking",
	"sarashina3-mini",
	"sarashina3-nano",
];

/** The model used when Settings leaves the model empty and SARASHINA_MODEL is unset. */
export const SARASHINA_API_DEFAULT_MODEL = "sarashina3.2-mini-thinking";

/** True for a thinking model, the only kind that accepts `reasoning_effort`. */
export function isSarashinaThinkingModel(model: string): boolean {
	return model.endsWith("-thinking");
}

/** The request body, keys in this order (both runners send the same bytes). */
export function buildSarashinaRequestBody(model: string, prompt: string, effort: Effort): string {
	return JSON.stringify({
		model,
		messages: [{ role: "user", content: prompt }],
		stream: true,
		max_completion_tokens: SARASHINA_MAX_COMPLETION_TOKENS,
		...(isSarashinaThinkingModel(model) ? { reasoning_effort: effort } : {}),
	});
}

/** Settings' model, else SARASHINA_MODEL, else the default. */
export function resolveSarashinaModel(
	env: Readonly<Record<string, string | undefined>>,
	requestedModel: string | null,
): string {
	if (requestedModel !== null) return requestedModel;
	const configured = env.SARASHINA_MODEL?.trim() ?? "";
	return configured === "" ? SARASHINA_API_DEFAULT_MODEL : configured;
}

function readKey(env: Readonly<Record<string, string | undefined>>): string | null {
	return readApiKey(env.SARASHINA_API_KEY);
}

interface SarashinaConfig {
	readonly apiKey: string;
	readonly model: string;
}

async function* attemptChatCompletion(
	environment: ProviderEnvironment,
	config: SarashinaConfig,
	request: AgentRequest,
	context: AgentRunContext,
	guard: TurnGuard,
	idle: IdleWatch,
): AsyncGenerator<AgentEvent, AttemptEnd> {
	const opened = await openStream(
		environment,
		{
			url: SARASHINA_CHAT_COMPLETIONS_URL,
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: buildSarashinaRequestBody(config.model, request.prompt, context.effort),
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
	// Plan-limited: the API reports tokens, not money, so the cost is unknown.
	yield usageEvent(null);
	yield failure === null ? COMPLETED_EVENT : failedEvent(failure);
	return FINISHED;
}

export function createSarashinaApiRuntime(environment: ProviderEnvironment): AgentRuntime {
	// Deliberately offline: a probe must not spend quota, and key validity shows up as PROVIDER_AUTH.
	async function probe(): Promise<AgentProbe> {
		const model = resolveSarashinaModel(environment.env, null);
		const capabilities: AgentCapabilities = {
			supported: ["stream", "cancel"],
			...(isValidModelId(model) ? { model } : {}),
			models: [...SARASHINA_API_MODELS],
		};
		return {
			capabilities,
			availability:
				readKey(environment.env) !== null
					? AVAILABLE
					: unavailable(
							"NOT_CONFIGURED",
							"The Sarashina API needs SARASHINA_API_KEY in the runner environment",
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
		const model = resolveSarashinaModel(environment.env, context.model);
		if (!isValidModelId(model)) {
			yield failedEvent(PROVIDER_FAILURES.PROVIDER_MODEL_INVALID);
			return;
		}
		const config: SarashinaConfig = { apiKey, model };
		yield* runHttpTurn(context, preflight.deadlineEpochMs, (guard, idle) =>
			attemptChatCompletion(environment, config, request, context, guard, idle),
		);
	}

	return {
		agentId: SARASHINA_API_AGENT_ID,
		displayName: "Sarashina API",
		costModel: "plan-limited",
		toolIsolation: "enforced",
		probe,
		run,
	};
}
