/**
 * Claude API adapter — Anthropic's Messages API, one streaming request over HTTPS.
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/claude-api.md
 * Verified live on 2026-10-24 (real runner, Claude Haiku) and 2026-10-31; the
 * per-model prices remain documentation-derived. The pinned
 * `anthropic-version` rejects sampling parameters, so none are sent.
 *
 * - Distinct from the "claude-code" backend: that one runs the `claude` CLI on
 *   a subscription and refuses API keys; this one is metered and needs
 *   ANTHROPIC_API_KEY. The key is read only here, sent only in the `x-api-key`
 *   header to the fixed origin below, never logged and never placed in an
 *   event; ANTHROPIC_BASE_URL is deliberately ignored and redirects are refused
 *   so the key cannot reach another host.
 * - Tool isolation is "enforced" by construction: the request carries one user
 *   message and no `tools`, so the model has nothing to call. A `tool_use` or
 *   `server_tool_use` block (or stop reason) fails the turn closed with
 *   PROVIDER_TOOL_ISOLATION_VIOLATED all the same.
 * - Thinking: every listed model thinks adaptively by default (it cannot be
 *   turned off on Claude Opus 5.5); `output_config.effort` carries the run's
 *   effort. Thinking text is omitted by default and never forwarded.
 * - Cost (metered): the API reports token counts, not dollars, so the cost is
 *   computed from CLAUDE_API_MODELS' prices once the final usage
 *   (`message_delta`) has arrived. Only models with a known price are accepted
 *   — any other id is refused before any network activity — so a completed
 *   turn's cost is never unknown and a run never pauses for METERED_COST_UNKNOWN.
 *   No caching is requested, so cache tokens should be zero; if the provider
 *   reports cache writes anyway they are priced at the 1-hour write rate (2×
 *   input), the higher of the two, so spend is never under-reported.
 * - Bounded spend per turn: `max_tokens` (MAX_OUTPUT_TOKENS) caps thinking and
 *   visible output together. A turn that stops at the cap is reported as
 *   PROVIDER_OUTPUT_TRUNCATED (not retryable), never as a completed answer.
 * - No fallback (AGT-012): the request names exactly one model and no
 *   `fallbacks`; a safety refusal (`stop_reason: "refusal"`) fails the turn
 *   with PROVIDER_REFUSED and the owner chooses another model if they want one.
 * - Transient rejections: a network error, HTTP 429 / 5xx / 529, or an `error`
 *   event before `message_start` is retried like OpenRouter's (REJECTION_RETRY
 *   in httpTurn.ts). Once the message has started a turn is never retried. A
 *   rejected answer's error body is read (bounded) only to recognise a spend
 *   limit, which fails at once with PROVIDER_PAYMENT_REQUIRED: retrying it
 *   cannot succeed until the owner raises the limit. HTTP 504 and a
 *   `timeout_error` event are both PROVIDER_TIMEOUT, not retried in the turn.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import {
	type AgentCapabilities,
	type AgentEvent,
	type AgentRequest,
	CLAUDE_API_AGENT_ID,
} from "@research/contracts";
import { parseJson } from "@research/domain";
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
import {
	COMPLETED_EVENT,
	failedEvent,
	failureForStop,
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

export const CLAUDE_API_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** The API version sent in `anthropic-version`. */
export const CLAUDE_API_VERSION = "2026-10-21";

/**
 * Upper bound on the tokens (thinking + visible output) one request may
 * generate: what bounds a single turn's spend (AGT-008). Thinking is always on,
 * so this is larger than OpenRouter's cap; at Claude Fable 5.1's output price
 * one capped turn costs at most 0.80 USD.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

/** Prices in USD per million tokens. */
export interface ClaudeModelPrice {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
}

export interface ClaudeModel {
	readonly id: string;
	readonly price: ClaudeModelPrice;
	/** A higher price that applies to every token of a request whose prompt exceeds `aboveTokens`. */
	readonly longPrompt?: { readonly aboveTokens: number; readonly price: ClaudeModelPrice };
}

/**
 * The models this backend runs, most capable first (the order Settings shows),
 * with Anthropic's first-party prices (model table cached 2026-10-06). The
 * single source of truth for which ids are accepted: a model is added here
 * with its price, or it cannot be used. Claude Haiku 5.5's cache-read price is
 * not in the reference; 0.1× input, the usual ratio, is assumed (no caching is
 * requested, so it should never apply).
 */
export const CLAUDE_API_MODELS: readonly ClaudeModel[] = [
	{ id: "claude-fable-5-1", price: { input: 10, output: 50, cacheRead: 0.25 } },
	{ id: "claude-opus-5-5", price: { input: 4, output: 20, cacheRead: 0.2 } },
	{ id: "claude-sonnet-5-5", price: { input: 2, output: 10, cacheRead: 0.2 } },
	{
		id: "claude-haiku-5-5",
		price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
		longPrompt: { aboveTokens: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
	},
];

/** The model used when Settings leaves the model empty. */
export const CLAUDE_API_DEFAULT_MODEL = "claude-opus-5-5";

export function claudeModel(id: string): ClaudeModel | null {
	return CLAUDE_API_MODELS.find((model) => model.id === id) ?? null;
}

/** Token counts as the API reports them; a later event's field replaces an earlier one. */
export interface ClaudeUsage {
	readonly inputTokens?: number;
	readonly cacheCreationInputTokens?: number;
	readonly cacheReadInputTokens?: number;
	readonly outputTokens?: number;
}

/** 1-hour cache writes cost 2× input, 5-minute ones 1.25×; the higher is charged (see header). */
const CACHE_WRITE_INPUT_MULTIPLIER = 2;

/**
 * The cost in USD of one request's usage, or null when the input or output
 * count is missing. Pure; the same operations in the same order as the Rust
 * port, so both produce the same double.
 */
export function claudeCostUsd(model: ClaudeModel, usage: ClaudeUsage): number | null {
	const { inputTokens, outputTokens } = usage;
	if (inputTokens === undefined || outputTokens === undefined) return null;
	const cacheWrite = usage.cacheCreationInputTokens ?? 0;
	const cacheRead = usage.cacheReadInputTokens ?? 0;
	const promptTokens = inputTokens + cacheWrite + cacheRead;
	const price =
		model.longPrompt !== undefined && promptTokens > model.longPrompt.aboveTokens
			? model.longPrompt.price
			: model.price;
	const microDollars =
		inputTokens * price.input +
		cacheWrite * price.input * CACHE_WRITE_INPUT_MULTIPLIER +
		cacheRead * price.cacheRead +
		outputTokens * price.output;
	return microDollars / 1_000_000;
}

/** The exact request body; key order is part of the Rust parity vectors. */
export function buildClaudeRequestBody(
	model: string,
	prompt: string,
	effort: AgentRunContext["effort"],
): string {
	return JSON.stringify({
		model,
		max_tokens: MAX_OUTPUT_TOKENS,
		messages: [{ role: "user", content: prompt }],
		stream: true,
		output_config: { effort },
	});
}

/**
 * A rejected request's error body, as far as it chooses the code
 * (https://platform.claude.com/docs/en/api/errors). The message is read only
 * for the documented prefix of an owner-set spend limit; it is never stored,
 * logged or placed in an event.
 */
const claudeErrorBodySchema = z.looseObject({
	error: z.looseObject({
		type: z.string().optional(),
		message: z.string().optional(),
		details: z.looseObject({ error_code: z.string().optional() }).nullable().optional(),
	}),
});

/** `error.details.error_code` of the 429 the usage tier's monthly spend cap answers. */
const SPEND_CAP_ERROR_CODE = "enforced_spend_limit_reached";
/** How the 400 for an organization or workspace spend limit the owner set begins. */
const OWN_SPEND_LIMIT_MESSAGE_PREFIX = "You have reached your specified";

/**
 * Whether the body says a spend limit was reached: the tier's monthly cap (a
 * 429 without Retry-After that keeps failing until the next month) or a limit
 * the owner set (a 400). Retrying either is useless until the owner acts.
 */
export function isClaudeSpendLimit(body: string | null): boolean {
	if (body === null) return false;
	const json = parseJson(body);
	if (!json.ok) return false;
	const parsed = claudeErrorBodySchema.safeParse(json.value);
	if (!parsed.success) return false;
	const { type, message, details } = parsed.data.error;
	if (type === "rate_limit_error") return details?.error_code === SPEND_CAP_ERROR_CODE;
	return (
		type === "invalid_request_error" &&
		message !== undefined &&
		message.startsWith(OWN_SPEND_LIMIT_MESSAGE_PREFIX)
	);
}

/**
 * Our code for a rejected request, carrying its status unchanged (§4a). A
 * spend limit fails at once as PROVIDER_PAYMENT_REQUIRED (not retried); a 404
 * names a model this key cannot use; a 504 is the API's `timeout_error`, the
 * same code its stream `error` event maps to; other statuses read as for any
 * HTTP backend.
 */
export function failureForClaudeRejection(status: number, body: string | null): ProviderFailure {
	if (isClaudeSpendLimit(body)) {
		return withUpstreamStatus(PROVIDER_FAILURES.PROVIDER_PAYMENT_REQUIRED, status);
	}
	if (status === 404) {
		return withUpstreamStatus(PROVIDER_FAILURES.PROVIDER_MODEL_UNAVAILABLE, status);
	}
	if (status === 504) return withUpstreamStatus(PROVIDER_FAILURES.PROVIDER_TIMEOUT, status);
	return failureForHttpStatus(status);
}

/**
 * The `error.type` of a stream `error` event. A non-2xx answer maps by its
 * status and body (`failureForClaudeRejection`).
 */
export function failureForClaudeErrorType(type: string | undefined): ProviderFailure {
	switch (type) {
		case "overloaded_error":
		case "api_error":
			return PROVIDER_FAILURES.PROVIDER_UNAVAILABLE;
		case "rate_limit_error":
			return PROVIDER_FAILURES.PROVIDER_RATE_LIMITED;
		case "authentication_error":
		case "permission_error":
			return PROVIDER_FAILURES.PROVIDER_AUTH;
		case "billing_error":
			return PROVIDER_FAILURES.PROVIDER_PAYMENT_REQUIRED;
		case "timeout_error":
			return PROVIDER_FAILURES.PROVIDER_TIMEOUT;
		case "not_found_error":
			return PROVIDER_FAILURES.PROVIDER_MODEL_UNAVAILABLE;
		default:
			return PROVIDER_FAILURES.PROVIDER_REQUEST_REJECTED;
	}
}

/** How a `stop_reason` ends the turn; null = a complete answer. */
export function failureForStopReason(stopReason: string): ProviderFailure | null {
	switch (stopReason) {
		case "end_turn":
		case "stop_sequence":
			return null;
		case "max_tokens":
		case "model_context_window_exceeded":
			return PROVIDER_FAILURES.PROVIDER_OUTPUT_TRUNCATED;
		case "refusal":
			return PROVIDER_FAILURES.PROVIDER_REFUSED;
		case "tool_use":
		case "pause_turn":
			return PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_VIOLATED;
		default:
			return PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
	}
}

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const usageSchema = z.looseObject({
	input_tokens: tokenCount.nullable().optional(),
	cache_creation_input_tokens: tokenCount.nullable().optional(),
	cache_read_input_tokens: tokenCount.nullable().optional(),
	output_tokens: tokenCount.nullable().optional(),
});

/** Content blocks that carry no tool and are safe to receive (thinking text is never forwarded). */
const SAFE_BLOCK_TYPES: ReadonlySet<string> = new Set(["text", "thinking", "redacted_thinking"]);

const eventSchema = z.discriminatedUnion("type", [
	z.looseObject({
		type: z.literal("message_start"),
		message: z.looseObject({ usage: usageSchema.optional() }),
	}),
	z.looseObject({
		type: z.literal("content_block_start"),
		content_block: z.looseObject({ type: z.string(), text: z.string().optional() }),
	}),
	z.looseObject({
		type: z.literal("content_block_delta"),
		delta: z.looseObject({ type: z.string(), text: z.string().optional() }),
	}),
	z.looseObject({
		type: z.literal("message_delta"),
		delta: z.looseObject({ stop_reason: z.string().nullable().optional() }),
		usage: usageSchema.nullable().optional(),
	}),
	z.looseObject({ type: z.literal("message_stop") }),
	z.looseObject({ type: z.literal("content_block_stop") }),
	z.looseObject({ type: z.literal("ping") }),
	z.looseObject({
		type: z.literal("error"),
		error: z.looseObject({ type: z.string().optional() }),
	}),
]);

export type ClaudeSseVerdict =
	| { readonly kind: "ignored" }
	| { readonly kind: "malformed" }
	| { readonly kind: "started"; readonly usage: ClaudeUsage }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "failed"; readonly failure: ProviderFailure }
	| {
			readonly kind: "delta";
			/** null when this event names no stop reason. */
			readonly stopReason: string | null;
			/** null when this event carries no usage object. */
			readonly usage: ClaudeUsage | null;
	  }
	| { readonly kind: "done" };

function usageFrom(usage: z.infer<typeof usageSchema>): ClaudeUsage {
	return {
		...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
		...(typeof usage.cache_creation_input_tokens === "number"
			? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
			: {}),
		...(typeof usage.cache_read_input_tokens === "number"
			? { cacheReadInputTokens: usage.cache_read_input_tokens }
			: {}),
		...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
	};
}

/** Event names the adapter knows; any other `type` is a future event and is skipped. */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
	"ping",
	"error",
]);

const typedSchema = z.looseObject({ type: z.string() });

/** Interprets one line of the SSE body. Pure, so chunk-boundary handling is tested separately. */
export function interpretClaudeSseLine(line: string): ClaudeSseVerdict {
	// Blank separators and `event:` lines: every data payload names its own type.
	if (!line.startsWith("data:")) return { kind: "ignored" };
	const json = parseJson(line.slice("data:".length).trim());
	if (!json.ok) return { kind: "malformed" };
	const typed = typedSchema.safeParse(json.value);
	if (!typed.success) return { kind: "malformed" };
	if (!KNOWN_EVENT_TYPES.has(typed.data.type)) return { kind: "ignored" };
	const parsed = eventSchema.safeParse(json.value);
	if (!parsed.success) return { kind: "malformed" };
	const event = parsed.data;
	switch (event.type) {
		case "message_start":
			return { kind: "started", usage: usageFrom(event.message.usage ?? {}) };
		case "content_block_start":
			if (!SAFE_BLOCK_TYPES.has(event.content_block.type)) {
				return { kind: "failed", failure: PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_VIOLATED };
			}
			return event.content_block.type === "text" && (event.content_block.text ?? "") !== ""
				? { kind: "text", text: event.content_block.text ?? "" }
				: { kind: "ignored" };
		case "content_block_delta":
			if (event.delta.type === "input_json_delta") {
				return { kind: "failed", failure: PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_VIOLATED };
			}
			return event.delta.type === "text_delta" && (event.delta.text ?? "") !== ""
				? { kind: "text", text: event.delta.text ?? "" }
				: { kind: "ignored" };
		case "message_delta":
			return {
				kind: "delta",
				stopReason: event.delta.stop_reason ?? null,
				usage: event.usage === undefined || event.usage === null ? null : usageFrom(event.usage),
			};
		case "message_stop":
			return { kind: "done" };
		case "error":
			return { kind: "failed", failure: failureForClaudeErrorType(event.error.type) };
		default:
			return { kind: "ignored" };
	}
}

interface ClaudeConfig {
	readonly apiKey: string;
	readonly model: ClaudeModel;
}

function readKey(env: Readonly<Record<string, string | undefined>>): string | null {
	return readApiKey(env.ANTHROPIC_API_KEY);
}

async function* attemptMessage(
	environment: ProviderEnvironment,
	config: ClaudeConfig,
	request: AgentRequest,
	context: AgentRunContext,
	guard: TurnGuard,
	idle: IdleWatch,
): AsyncGenerator<AgentEvent, AttemptEnd> {
	const opened = await openStream(
		environment,
		{
			url: CLAUDE_API_MESSAGES_URL,
			headers: {
				"x-api-key": config.apiKey,
				"anthropic-version": CLAUDE_API_VERSION,
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: buildClaudeRequestBody(config.model.id, request.prompt, context.effort),
			failureForStatus: failureForClaudeRejection,
		},
		guard,
		idle,
	);
	if (opened.kind === "ended") {
		yield* opened.events;
		return opened.end;
	}

	const bodyState = newBodyReadState();
	let usage: ClaudeUsage = {};
	let sawFinalUsage = false;
	let started = false;
	let sawEnd = false;
	let stopReason: string | null = null;
	let emittedTextChars = 0;
	let malformedLines = 0;
	let failure: ProviderFailure | null = null;
	/** An error event before `message_start`: the provider refused the request. */
	let rejectedBeforeStart: ProviderFailure | null = null;
	const sseLines = splitLines(
		readBody(opened.body, guard, idle.touch, bodyState),
		MAX_SSE_LINE_CHARS,
	);
	for await (const line of sseLines) {
		const verdict = interpretClaudeSseLine(line);
		if (verdict.kind === "ignored") continue;
		if (verdict.kind === "done") {
			sawEnd = true;
			break;
		}
		if (verdict.kind === "malformed") {
			malformedLines += 1;
			if (malformedLines > MAX_MALFORMED_LINES) {
				failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
				break;
			}
			continue;
		}
		if (verdict.kind === "failed") {
			if (started) failure = verdict.failure;
			else rejectedBeforeStart = verdict.failure;
			break;
		}
		if (verdict.kind === "started") {
			started = true;
			usage = { ...usage, ...verdict.usage };
			continue;
		}
		if (verdict.kind === "delta") {
			if (verdict.stopReason !== null) stopReason = verdict.stopReason;
			if (verdict.usage !== null) {
				usage = { ...usage, ...verdict.usage };
				sawFinalUsage = true;
			}
			continue;
		}
		emittedTextChars += verdict.text.length;
		if (emittedTextChars > MAX_OUTPUT_TEXT_CHARS) {
			failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE;
			break;
		}
		yield textDeltaEvent(verdict.text);
	}

	const stop = guard.reason();
	if (stop === null && rejectedBeforeStart !== null) {
		// Nothing started, so nothing was generated; the cost of this request is unknown.
		return {
			kind: "rejected",
			failure: rejectedBeforeStart,
			retryAfterMs: null,
			events: [usageEvent(null), failedEvent(rejectedBeforeStart)],
		};
	}
	if (stop !== null) failure = failureForStop(stop);
	else if (failure === null && bodyState.tooLarge) {
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE;
	} else if (failure === null && bodyState.readFailed) {
		failure = PROVIDER_FAILURES.PROVIDER_UNAVAILABLE;
	} else if (failure === null && (!sawEnd || stopReason === null)) {
		// The connection closed before message_stop, or no stop reason was given.
		failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
	} else if (failure === null && stopReason !== null) {
		failure = failureForStopReason(stopReason);
		if (failure === null && emittedTextChars === 0)
			failure = PROVIDER_FAILURES.PROVIDER_OUTPUT_EMPTY;
	}
	yield usageEvent(sawFinalUsage ? claudeCostUsd(config.model, usage) : null);
	yield failure === null ? COMPLETED_EVENT : failedEvent(failure);
	return FINISHED;
}

export function createClaudeApiRuntime(environment: ProviderEnvironment): AgentRuntime {
	const capabilities = (): AgentCapabilities => ({
		supported: ["stream", "cancel"],
		model: CLAUDE_API_DEFAULT_MODEL,
		models: CLAUDE_API_MODELS.map((model) => model.id),
	});

	// Deliberately offline: a probe must not spend quota, and key validity shows up as PROVIDER_AUTH.
	async function probe(): Promise<AgentProbe> {
		return {
			capabilities: capabilities(),
			availability:
				readKey(environment.env) !== null
					? AVAILABLE
					: unavailable(
							"NOT_CONFIGURED",
							"The Claude API needs ANTHROPIC_API_KEY in the runner environment",
						),
		};
	}

	async function* run(request: AgentRequest, context: AgentRunContext): AsyncGenerator<AgentEvent> {
		const preflight = preflightTurn(request, context, Date.now());
		if (!preflight.ok) {
			yield failedEvent(preflight.failure);
			return;
		}
		// Fail closed before any network activity when the key is missing or the model has no price.
		const apiKey = readKey(environment.env);
		if (apiKey === null) {
			yield failedEvent(PROVIDER_FAILURES.NOT_CONFIGURED);
			return;
		}
		const model = claudeModel(context.model ?? CLAUDE_API_DEFAULT_MODEL);
		if (model === null) {
			yield failedEvent(PROVIDER_FAILURES.PROVIDER_MODEL_INVALID);
			return;
		}
		const config: ClaudeConfig = { apiKey, model };
		yield* runHttpTurn(context, preflight.deadlineEpochMs, (guard, idle) =>
			attemptMessage(environment, config, request, context, guard, idle),
		);
	}

	return {
		agentId: CLAUDE_API_AGENT_ID,
		displayName: "Claude API",
		costModel: "metered",
		toolIsolation: "enforced",
		probe,
		run,
	};
}
