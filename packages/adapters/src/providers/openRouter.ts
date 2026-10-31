/**
 * OpenRouter adapters — one streaming chat completion over HTTPS, in two runtimes.
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/openrouter.md
 * The chat path (a streamed free-model turn and its 401, 403 and 429 answers)
 * and the model catalogue were verified live on 2026-10-31.
 *
 * The free runtime (`openrouter-free`, "OpenRouter (free models)") shares the
 * turn below with the metered runtime: the same endpoint, the same one-model
 * request with no `tools` and no `models` list, the same SSE handling. Its
 * model list comes from the public model catalogue (see openRouterModels.ts),
 * fetched with no Authorization header — the key is only ever sent to the
 * chat endpoint.
 *
 * - Tool isolation is "enforced" by construction: the request carries one user
 *   message and no `tools`, so the model has nothing to call and nothing runs
 *   on the owner's machine.
 * - `stream`: `choices[0].delta.content` chunks are forwarded as they arrive.
 *   `cancel`: aborting the HTTP request is the documented way to stop a stream
 *   (the docs note that some upstream providers keep generating and bill
 *   anyway, which is why an aborted turn reports its cost as unknown).
 * - Cost (metered): `usage.cost` from the final chunk is the amount charged, in credits
 *   whose base currency is USD. The docs say usage is now always included and
 *   that `usage: {include: true}` is a deprecated no-op; it is still sent so
 *   older behaviour is covered. No cost in the response => unknown (null),
 *   never 0.
 * - Cost (free): any chunk reporting a cost greater than 0 stops the turn at
 *   once with PROVIDER_FREE_MODEL_CHARGED; otherwise the usage is always
 *   unknown (null), even when the provider says 0 (AGT-008, AGT-012).
 * - Bounded spend per turn: every request carries `max_completion_tokens`
 *   (MAX_COMPLETION_TOKENS). The API reference marks `max_tokens` as
 *   deprecated in favour of `max_completion_tokens`, so that one is sent. For reasoning models the
 *   limit covers reasoning and visible output together, and the docs warn that
 *   a small limit can be used up by reasoning, ending with
 *   `finish_reason: "length"`. A turn that ends that way is reported as
 *   PROVIDER_OUTPUT_TRUNCATED (not retryable: the same cap would cut it off
 *   again), never as a completed answer.
 * - No fallback: the request names exactly one model and no `models` list
 *   (AGT-012). OpenRouter may still route the SAME model to another upstream
 *   provider, at that provider's price.
 * - Transient rejections: when the provider refuses the request before any
 *   output — a network error, HTTP 429 / 5xx, or an error chunk ahead of any
 *   content (an upstream-overloaded chunk under HTTP 200 was observed live) —
 *   the SAME request is sent again after a backoff (REJECTION_RETRY), within
 *   the turn's deadline.
 *   Nothing was generated, so nothing is billed. Once any content arrived the
 *   turn is never retried. A rejected answer's error body is read (bounded)
 *   only for `error.metadata.limit_source`: a spent credit, key, guardrail or
 *   workspace budget is PROVIDER_PAYMENT_REQUIRED, whatever the status.
 * - The API key is read from OPENROUTER_API_KEY, sent only in the
 *   Authorization header to the fixed origin below, never logged and never
 *   placed in an event; redirects are refused so it cannot be forwarded.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import {
	type AgentCapabilities,
	type AgentEvent,
	type AgentRequest,
	isOpenRouterFreeModelId,
	OPENROUTER_FREE_AGENT_ID,
} from "@research/contracts";
import { parseJson, upstreamStatusOrNull } from "@research/domain";
import { z } from "zod";
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
import { createFreeModelCatalog, type FreeModelCatalog } from "./openRouterModels.ts";
import {
	asKnownCostUsd,
	COMPLETED_EVENT,
	failedEvent,
	failureForHint,
	failureForStop,
	hintFromHttpStatus,
	isValidModelId,
	MAX_MALFORMED_LINES,
	MAX_OUTPUT_TEXT_CHARS,
	PROVIDER_FAILURES,
	type ProviderFailure,
	preflightTurn,
	type TurnGuard,
	textDeltaEvent,
	usageEvent,
	withUpstreamStatus,
} from "./turn.ts";

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Upper bound on the tokens (reasoning + visible output) one request may
 * generate. This is what bounds a single turn's spend on a metered backend
 * (AGT-008): without it the provider's own maximum, often 100k+ tokens, applies.
 */
export const MAX_COMPLETION_TOKENS = 8_192;

interface OpenRouterConfig {
	readonly apiKey: string;
	readonly model: string;
}

function readConfig(
	env: Readonly<Record<string, string | undefined>>,
	requestedModel: string | null,
): OpenRouterConfig | null {
	const apiKey = readApiKey(env.OPENROUTER_API_KEY);
	const model = requestedModel ?? env.OPENROUTER_MODEL?.trim() ?? "";
	if (apiKey === null || !isValidModelId(model)) return null;
	return { apiKey, model };
}

function readFreeApiKey(env: Readonly<Record<string, string | undefined>>): string | null {
	return readApiKey(env.OPENROUTER_API_KEY);
}

function resolveFreeModel(
	env: Readonly<Record<string, string | undefined>>,
	requestedModel: string | null,
): string {
	return requestedModel ?? env.OPENROUTER_FREE_MODEL?.trim() ?? "";
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

/**
 * A rejected request's error body, as far as it chooses the code
 * (https://openrouter.ai/docs/api-reference/limits): only
 * `error.metadata.limit_source` is read; the message never leaves the adapter.
 */
const errorBodySchema = z.looseObject({
	error: z.looseObject({
		metadata: z.looseObject({ limit_source: z.string().optional() }).nullable().optional(),
	}),
});

/**
 * Limits that refuse a request for money, not for the key: credits, the key's
 * own credit limit, a guardrail or a workspace budget. OpenRouter answers
 * these with 402 or 403 (a spent key limit answered 403 live on 2026-10-31).
 */
const SPENT_BUDGET_LIMIT_SOURCES: ReadonlySet<string> = new Set([
	"openrouter_credits",
	"openrouter_key_limit",
	"openrouter_guardrail_budget",
	"openrouter_workspace_budget",
]);

/** `error.metadata.limit_source` of a rejected answer's body, or null. */
function limitSource(body: string | null): string | null {
	if (body === null) return null;
	const json = parseJson(body);
	if (!json.ok) return null;
	const parsed = errorBodySchema.safeParse(json.value);
	return parsed.success ? (parsed.data.error.metadata?.limit_source ?? null) : null;
}

/**
 * Our code for a rejected request, carrying its status unchanged (§4a): a
 * spent budget is PROVIDER_PAYMENT_REQUIRED whatever the status, so a 403
 * key limit is not mistaken for a bad key; anything else maps by status.
 */
export function failureForOpenRouterRejection(
	status: number,
	body: string | null,
): ProviderFailure {
	const source = limitSource(body);
	return source !== null && SPENT_BUDGET_LIMIT_SOURCES.has(source)
		? withUpstreamStatus(PROVIDER_FAILURES.PROVIDER_PAYMENT_REQUIRED, status)
		: failureForHttpStatus(status);
}

/**
 * A mid-stream error arrives with HTTP 200; its `code` mirrors an HTTP
 * status when numeric, and is then kept unchanged as the upstream status (§4a).
 */
function failureForStreamError(code: number | string | undefined): ProviderFailure {
	const hint = typeof code === "number" ? hintFromHttpStatus(code) : null;
	return withUpstreamStatus(failureForHint(hint ?? "unavailable"), upstreamStatusOrNull(code));
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
	const json = parseJson(payload);
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

/**
 * One streaming chat completion, shared by the metered and the free runtime.
 * When `freeCostEnforcement` is true any chunk reporting a cost above 0 fails
 * the turn closed with PROVIDER_FREE_MODEL_CHARGED and the usage is otherwise
 * always unknown (null); when false the provider's cost is reported as-is.
 * A transient rejection before any output is retried (REJECTION_RETRY).
 */
function runChatCompletion(
	environment: ProviderEnvironment,
	config: OpenRouterConfig,
	request: AgentRequest,
	context: AgentRunContext,
	deadlineEpochMs: number,
	freeCostEnforcement: boolean,
): AsyncGenerator<AgentEvent> {
	return runHttpTurn(context, deadlineEpochMs, (guard, idle) =>
		attemptChatCompletion(environment, config, request, context, guard, idle, freeCostEnforcement),
	);
}

async function* attemptChatCompletion(
	environment: ProviderEnvironment,
	config: OpenRouterConfig,
	request: AgentRequest,
	context: AgentRunContext,
	guard: TurnGuard,
	idle: IdleWatch,
	freeCostEnforcement: boolean,
): AsyncGenerator<AgentEvent, AttemptEnd> {
	const opened = await openStream(
		environment,
		{
			url: OPENROUTER_CHAT_COMPLETIONS_URL,
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
			failureForStatus: failureForOpenRouterRejection,
		},
		guard,
		idle,
	);
	if (opened.kind === "ended") {
		yield* opened.events;
		return opened.end;
	}

	const bodyState = newBodyReadState();
	let knownCostUsd: number | null = null;
	let freeChargedCost: number | null = null;
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
		if (verdict.knownCostUsd !== undefined) knownCostUsd = verdict.knownCostUsd;
		if (freeCostEnforcement && (verdict.knownCostUsd ?? 0) > 0) {
			freeChargedCost = verdict.knownCostUsd ?? 0;
			break;
		}
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

	if (freeCostEnforcement && freeChargedCost !== null) {
		yield usageEvent(freeChargedCost);
		yield failedEvent(PROVIDER_FAILURES.PROVIDER_FREE_MODEL_CHARGED);
		return FINISHED;
	}
	const stopReason = guard.reason();
	if (stopReason === null && rejectedBeforeOutput !== null) {
		// The error chunk carries no usage, so the cost of this request is unknown.
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
		// The connection closed without [DONE] or a finish_reason: the answer is truncated.
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
	} else if (failure === null && truncated) {
		// Stopped at MAX_COMPLETION_TOKENS, possibly inside reasoning with no visible text at
		// all. Checked before "empty" so a capped turn is never retried into the same cap.
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TRUNCATED;
	} else if (failure === null && emittedTextChars === 0) {
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_EMPTY;
	}
	yield usageEvent(freeCostEnforcement ? null : knownCostUsd);
	yield failure === null ? COMPLETED_EVENT : failedEvent(failure);
	return FINISHED;
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
		yield* runChatCompletion(
			environment,
			config,
			request,
			context,
			preflight.deadlineEpochMs,
			false,
		);
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

export interface OpenRouterFreeRuntimeOptions {
	readonly catalog?: FreeModelCatalog;
}

/**
 * OpenRouter free-models backend: plan-limited, free ids only. Refuses any
 * non-free model before any network activity and fails closed when the
 * provider reports a charge.
 */
export function createOpenRouterFreeRuntime(
	environment: ProviderEnvironment,
	options: OpenRouterFreeRuntimeOptions = {},
): AgentRuntime {
	const catalog = options.catalog ?? createFreeModelCatalog(environment);

	async function probe(): Promise<AgentProbe> {
		if (readFreeApiKey(environment.env) === null) {
			return {
				capabilities: { supported: ["stream", "cancel"] },
				availability: unavailable(
					"NOT_CONFIGURED",
					"OpenRouter free models need OPENROUTER_API_KEY in the runner environment; a key from a free account works",
				),
			};
		}
		const freeModel = environment.env.OPENROUTER_FREE_MODEL?.trim() ?? "";
		const model =
			freeModel !== "" && isValidModelId(freeModel) && isOpenRouterFreeModelId(freeModel)
				? freeModel
				: undefined;
		const models = await catalog.list();
		const capabilities: AgentCapabilities = {
			supported: ["stream", "cancel"],
			...(model === undefined ? {} : { model }),
			// Omitted when the list could not be read: the backend still runs with a typed id.
			...(models === null ? {} : { models: [...models] }),
		};
		return { capabilities, availability: AVAILABLE };
	}

	async function* run(request: AgentRequest, context: AgentRunContext): AsyncGenerator<AgentEvent> {
		const preflight = preflightTurn(request, context, Date.now());
		if (!preflight.ok) {
			yield failedEvent(preflight.failure);
			return;
		}
		const apiKey = readFreeApiKey(environment.env);
		if (apiKey === null) {
			yield failedEvent(PROVIDER_FAILURES.NOT_CONFIGURED);
			return;
		}
		const model = resolveFreeModel(environment.env, context.model);
		if (model === "") {
			yield failedEvent(PROVIDER_FAILURES.PROVIDER_MODEL_REQUIRED);
			return;
		}
		if (!isValidModelId(model) || !isOpenRouterFreeModelId(model)) {
			yield failedEvent(PROVIDER_FAILURES.PROVIDER_MODEL_INVALID);
			return;
		}
		yield* runChatCompletion(
			environment,
			{ apiKey, model },
			request,
			context,
			preflight.deadlineEpochMs,
			true,
		);
	}

	return {
		agentId: OPENROUTER_FREE_AGENT_ID,
		displayName: "OpenRouter (free models)",
		costModel: "plan-limited",
		toolIsolation: "enforced",
		probe,
		run,
	};
}
