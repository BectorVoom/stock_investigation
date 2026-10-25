/**
 * Claude Code adapter — one tool-less, config-less text turn through the CLI's
 * print mode.
 *
 * VERIFIED 2026-10-11 against `claude` 2.1.296 (`claude --help`,
 * `claude auth status --help`) and by live invocations on the owner's machine:
 *
 * - Integration: `claude -p --output-format stream-json --verbose
 *   --include-partial-messages`, prompt on stdin, cwd = the job scratch dir.
 * - Tool isolation ("enforced"): with the flags in `buildClaudeArgs` the CLI's
 *   own `system/init` event reported `tools: []`, `mcp_servers: []`,
 *   `slash_commands: []`, `skills: []` and `permissionMode: "dontAsk"`; the
 *   whole request was 623 input tokens (no tool schemas); and a prompt that
 *   explicitly asked it to read /etc/hosts and run `echo hi` produced no
 *   tool_use block and the answer NO_TOOLS. The claim is also re-checked on
 *   EVERY run: an init event listing any tool or MCP server, a missing init
 *   event, or any tool_use block fails the turn closed, so a future CLI version
 *   that changes a flag's meaning cannot silently regain tools.
 * - Streaming: `stream_event` / `content_block_delta` / `text_delta` lines
 *   arrive incrementally, hence the `stream` capability. Killing the process
 *   is best effort and is NOT advertised as `cancel`.
 * - Not logged in (captured with an empty CLAUDE_CONFIG_DIR, no quota used):
 *   an `assistant` line with `error: "authentication_failed"`, then a `result`
 *   with `is_error: true` and exit code 1. `claude auth status --json` prints
 *   `{"loggedIn": false, "authMethod": "none", ...}` and exits 1.
 *
 * SUBSCRIPTION AUTH ONLY (AGT-012). This adapter declares `plan-limited`, so it
 * must never run on metered API-key billing: that would spend money without
 * the owner's spend consent. Two independent checks, both before a turn can
 * complete:
 *   1. `probe()` reads `claude auth status --json`, which DOES tell the kinds
 *      apart (all three observed with the real CLI, no prompt sent):
 *        subscription login   {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":...}
 *        `claude setup-token` {"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}
 *        API key              {"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}
 *      Only the first two are accepted. An API key, a non-first-party provider
 *      (Bedrock/Vertex/Foundry) or an auth method this adapter does not know is
 *      reported as unavailable NOT_CONFIGURED.
 *   2. `run()` reads the `apiKeySource` of the CLI's own init event, which is
 *      emitted before the model request. Anything but "none" (the value seen
 *      for a subscription login) kills the process and fails the turn with
 *      PROVIDER_METERED_AUTH_NOT_ALLOWED. This also covers a login that changed
 *      between probe and run. The kill races the request, so the turn still
 *      reports `usage { knownCostUsd: null }`: something may have been billed.
 *
 * Cost: always unknown (null). On a subscription the `total_cost_usd` the CLI
 * prints is a notional API-equivalent figure, not money the owner was charged,
 * and a metered run never completes (see above).
 *
 * Deliberately NOT forwarded to the child: ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and the Bedrock/Vertex switches. A
 * stray key in the runner's environment would otherwise silently turn this
 * plan-limited backend into a metered one.
 *
 * Terms caveat: this drives the owner's own CLI login on the owner's own
 * machine. Whether a given plan permits unattended/automated use is governed by
 * Anthropic's terms for that plan and must be re-checked by the owner.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime, Effort } from "@research/agent-core";
import type {
	AgentAvailability,
	AgentCapabilities,
	AgentEvent,
	AgentRequest,
} from "@research/contracts";
import { parseJson, upstreamStatusOrNull } from "@research/domain";
import { z } from "zod";
import {
	AVAILABLE,
	captureCommand,
	probeCliVersion,
	unavailable,
	type Version,
} from "./cliProbe.ts";
import {
	type CliStreamInterpreter,
	IGNORED,
	type LineVerdict,
	MALFORMED,
	runCliTurn,
	type TurnConclusion,
} from "./cliTurn.ts";
import { buildChildEnv, type ProviderEnvironment, probeWorkingDirectory } from "./environment.ts";
import type { ProcessExit } from "./processRunner.ts";
import {
	type FailureHint,
	failedEvent,
	failureForHint,
	hintFromHttpStatus,
	hintFromText,
	PROVIDER_FAILURES,
	type ProviderFailure,
	preflightTurn,
	withUpstreamStatus,
} from "./turn.ts";

const COMMAND = "claude";
const DISPLAY_NAME = "Claude Code";
const MINIMUM_VERSION: Version = [2, 1, 296];

/** The CLI's own documented configuration/auth variables that are safe to forward. */
const CLAUDE_ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

const CAPABILITIES: AgentCapabilities = { supported: ["stream"] };

/**
 * Models Settings → AI agent offers for this backend. The CLI has no command
 * that lists models, but `--model` takes these aliases, each naming the newest
 * model of its family, so the owner never needs a dated model id (checked
 * with Claude Code 2.1.302 on a subscription login: fable, opus, sonnet and
 * haiku each answered). Ordered from most to least capable.
 */
export const CLAUDE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/** Replaces the CLI's coding-agent system prompt; the research instructions arrive in the prompt. */
const SYSTEM_PROMPT =
	"You are a text-generation backend for a research application. You have no tools and cannot take actions. Answer the user message with text only, in exactly the format it asks for.";

export function buildClaudeArgs(model: string | null, effort: Effort): readonly string[] {
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--input-format",
		"text",
		// No built-in tools at all (shell, file read/edit, web fetch/search, sub-agents).
		"--tools",
		"",
		// No MCP servers: only --mcp-config would be honoured, and none is given.
		"--strict-mcp-config",
		// No user/project/local settings, hence no hooks, permission rules or env from them.
		"--setting-sources",
		"",
		"--disable-slash-commands",
		"--no-session-persistence",
		// No CLAUDE.md, skills, plugins, hooks, custom agents or commands.
		"--safe-mode",
		// Anything that would need approval is denied instead of asked.
		"--permission-mode",
		"dontAsk",
		"--permission-prompts",
		"none",
		"--system-prompt",
		SYSTEM_PROMPT,
		"--effort",
		effort,
		...(model === null ? [] : ["--model", model]),
	];
}

const typedLineSchema = z.looseObject({ type: z.string(), subtype: z.string().optional() });

const initLineSchema = z.looseObject({
	tools: z.array(z.unknown()),
	mcp_servers: z.array(z.unknown()),
	apiKeySource: z.string().optional(),
});

const streamEventLineSchema = z.looseObject({
	event: z.looseObject({
		type: z.string(),
		delta: z.looseObject({ type: z.string(), text: z.string().optional() }).optional(),
		content_block: z.looseObject({ type: z.string() }).optional(),
	}),
});

const assistantLineSchema = z.looseObject({
	error: z.string().optional(),
	message: z
		.looseObject({ content: z.array(z.looseObject({ type: z.string() })).optional() })
		.optional(),
});

const resultLineSchema = z.looseObject({
	subtype: z.string().optional(),
	is_error: z.boolean(),
	result: z.string().optional(),
	api_error_status: z.number().nullable().optional(),
});

const rateLimitLineSchema = z.looseObject({
	rate_limit_info: z.looseObject({ status: z.string() }),
});

type ResultLine = z.infer<typeof resultLineSchema>;

/** Content block types that mean the model was handed a tool despite the flags. */
function isToolBlock(blockType: string): boolean {
	return blockType.includes("tool_use") || blockType.includes("tool_result");
}

const ISOLATION_VIOLATED: LineVerdict = {
	kind: "fatal",
	failure: PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_VIOLATED,
};
const ISOLATION_UNVERIFIED: LineVerdict = {
	kind: "fatal",
	failure: PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_UNVERIFIED,
};

const METERED_AUTH: LineVerdict = {
	kind: "fatal",
	failure: PROVIDER_FAILURES.PROVIDER_METERED_AUTH_NOT_ALLOWED,
};

/** The init event's `apiKeySource` for a subscription login (observed live). */
const SUBSCRIPTION_API_KEY_SOURCE = "none";

const ASSISTANT_ERROR_HINTS: Readonly<Record<string, FailureHint>> = {
	authentication_failed: "auth",
	billing_error: "payment",
	rate_limit: "rate-limit",
	server_error: "unavailable",
	overloaded: "unavailable",
};

export function createClaudeStreamInterpreter(): CliStreamInterpreter {
	let isolationConfirmed = false;
	let assistantErrorHint: FailureHint | null = null;
	let rateLimitRejected = false;
	let result: ResultLine | null = null;

	function interpretInit(value: unknown): LineVerdict {
		const init = initLineSchema.safeParse(value);
		// An init event that cannot be read cannot confirm anything: fail closed.
		if (!init.success) return ISOLATION_UNVERIFIED;
		if (init.data.tools.length > 0 || init.data.mcp_servers.length > 0) return ISOLATION_VIOLATED;
		// Fail closed before the turn can complete: a named key source is metered billing, and
		// a missing field means the CLI no longer says which kind of billing this is.
		if (init.data.apiKeySource !== SUBSCRIPTION_API_KEY_SOURCE) return METERED_AUTH;
		isolationConfirmed = true;
		return IGNORED;
	}

	function interpretStreamEvent(value: unknown): LineVerdict {
		const parsed = streamEventLineSchema.safeParse(value);
		if (!parsed.success) return MALFORMED;
		const { event } = parsed.data;
		if (event.content_block !== undefined && isToolBlock(event.content_block.type)) {
			return ISOLATION_VIOLATED;
		}
		if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") return IGNORED;
		if (!isolationConfirmed) return ISOLATION_UNVERIFIED;
		return { kind: "text", text: event.delta.text ?? "" };
	}

	function interpretAssistant(value: unknown): LineVerdict {
		const parsed = assistantLineSchema.safeParse(value);
		if (!parsed.success) return MALFORMED;
		const blocks = parsed.data.message?.content ?? [];
		if (blocks.some((block) => isToolBlock(block.type))) return ISOLATION_VIOLATED;
		if (parsed.data.error !== undefined) {
			assistantErrorHint = ASSISTANT_ERROR_HINTS[parsed.data.error] ?? assistantErrorHint;
		}
		// The text itself is NOT taken from here: it was already streamed as deltas, and on
		// failures this line carries the CLI's own error message rather than model output.
		return IGNORED;
	}

	function interpretResult(value: unknown): LineVerdict {
		const parsed = resultLineSchema.safeParse(value);
		if (!parsed.success) return MALFORMED;
		result = parsed.data;
		return IGNORED;
	}

	function interpretRateLimit(value: unknown): LineVerdict {
		const parsed = rateLimitLineSchema.safeParse(value);
		if (!parsed.success) return MALFORMED;
		if (parsed.data.rate_limit_info.status === "rejected") rateLimitRejected = true;
		return IGNORED;
	}

	function failureFor(exit: ProcessExit, finalResult: ResultLine | null): ProviderFailure {
		const statusHint =
			typeof finalResult?.api_error_status === "number"
				? hintFromHttpStatus(finalResult.api_error_status)
				: null;
		const hint =
			assistantErrorHint ??
			statusHint ??
			(rateLimitRejected ? "rate-limit" : null) ??
			hintFromText(`${finalResult?.result ?? ""}\n${exit.stderrTail}`);
		// The CLI's report of its API's answer status travels unchanged,
		// whichever signal chose the code (§4a).
		const upstreamStatus = upstreamStatusOrNull(finalResult?.api_error_status);
		if (hint !== null) return withUpstreamStatus(failureForHint(hint), upstreamStatus);
		if (exit.code !== 0) {
			return withUpstreamStatus(PROVIDER_FAILURES.PROVIDER_EXIT_NONZERO, upstreamStatus);
		}
		return withUpstreamStatus(
			finalResult === null
				? PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID
				: PROVIDER_FAILURES.PROVIDER_ERROR,
			upstreamStatus,
		);
	}

	return {
		interpretLine(line) {
			const json = parseJson(line);
			if (!json.ok) return MALFORMED;
			const typed = typedLineSchema.safeParse(json.value);
			if (!typed.success) return MALFORMED;
			const { type, subtype } = typed.data;
			if (type === "system") return subtype === "init" ? interpretInit(json.value) : IGNORED;
			if (type === "stream_event") return interpretStreamEvent(json.value);
			if (type === "assistant") return interpretAssistant(json.value);
			if (type === "result") return interpretResult(json.value);
			if (type === "rate_limit_event") return interpretRateLimit(json.value);
			return IGNORED;
		},
		conclude(exit, emittedTextChars): TurnConclusion {
			const finalResult = result;
			const succeeded =
				exit.code === 0 &&
				finalResult !== null &&
				!finalResult.is_error &&
				finalResult.subtype === "success";
			// Always unknown: only subscription runs get this far (see file header).
			const knownCostUsd = null;
			if (!succeeded) {
				return { failure: failureFor(exit, finalResult), trailingText: "", knownCostUsd };
			}
			if (!isolationConfirmed) {
				return {
					failure: PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_UNVERIFIED,
					trailingText: "",
					knownCostUsd,
				};
			}
			// Partial messages are requested, so this only applies if the CLI streamed nothing.
			const trailingText = emittedTextChars === 0 ? (finalResult.result ?? "") : "";
			if (emittedTextChars === 0 && trailingText.length === 0) {
				return { failure: PROVIDER_FAILURES.PROVIDER_OUTPUT_EMPTY, trailingText: "", knownCostUsd };
			}
			return { failure: null, trailingText, knownCostUsd };
		},
	};
}

const authStatusSchema = z.looseObject({
	loggedIn: z.boolean(),
	authMethod: z.string().optional(),
	apiProvider: z.string().optional(),
	apiKeySource: z.string().optional(),
});

type AuthStatus = z.infer<typeof authStatusSchema>;

/** `authMethod` values that are a Claude subscription: the app login and `claude setup-token`. */
const SUBSCRIPTION_AUTH_METHODS: ReadonlySet<string> = new Set(["claude.ai", "oauth_token"]);
const FIRST_PARTY_PROVIDER = "firstParty";

/**
 * Maps the CLI's own auth status to an availability. Details are fixed texts:
 * nothing from the status output (which can name a key source) is echoed.
 */
export function availabilityForAuthStatus(status: AuthStatus): AgentAvailability {
	if (!status.loggedIn) {
		return unavailable(
			"NOT_AUTHENTICATED",
			"Claude Code is not logged in; run `claude` and /login",
		);
	}
	const usesApiKey =
		status.authMethod === "api_key" ||
		(status.apiKeySource !== undefined && status.apiKeySource !== SUBSCRIPTION_API_KEY_SOURCE);
	if (usesApiKey) {
		return unavailable(
			"NOT_CONFIGURED",
			"Claude Code is authenticated with a metered API key; this plan-limited adapter only runs on a Claude subscription login",
		);
	}
	const isSubscription =
		status.authMethod !== undefined &&
		SUBSCRIPTION_AUTH_METHODS.has(status.authMethod) &&
		status.apiProvider === FIRST_PARTY_PROVIDER;
	if (!isSubscription) {
		return unavailable(
			"NOT_CONFIGURED",
			"Claude Code does not report a Claude subscription login (third-party provider or unrecognised auth method); metered or unknown billing is not supported by this plan-limited adapter",
		);
	}
	return AVAILABLE;
}

export function createClaudeCodeRuntime(environment: ProviderEnvironment): AgentRuntime {
	const childEnv = (): Record<string, string> => buildChildEnv(environment.env, CLAUDE_ENV_KEYS);

	async function probe(): Promise<AgentProbe> {
		const base = { cwd: probeWorkingDirectory(environment.env), env: childEnv() };
		const version = await probeCliVersion(
			environment.processRunner,
			{ ...base, command: COMMAND, args: ["--version"] },
			DISPLAY_NAME,
			MINIMUM_VERSION,
		);
		if (!version.ok) return { capabilities: CAPABILITIES, availability: version.availability };
		// Documented local status command; it makes no model request.
		const status = await captureCommand(environment.processRunner, {
			...base,
			command: COMMAND,
			args: ["auth", "status", "--json"],
		});
		if (status.kind !== "exited") {
			return {
				capabilities: CAPABILITIES,
				availability: unavailable("PROBE_FAILED", "`claude auth status` did not complete"),
			};
		}
		const json = parseJson(status.stdout);
		const parsed = json.ok ? authStatusSchema.safeParse(json.value) : null;
		if (parsed === null || !parsed.success) {
			return {
				capabilities: CAPABILITIES,
				availability: unavailable("PROBE_FAILED", "`claude auth status` output was not understood"),
			};
		}
		const availability = availabilityForAuthStatus(parsed.data);
		return {
			capabilities:
				availability.status === "available"
					? { ...CAPABILITIES, models: [...CLAUDE_MODEL_ALIASES] }
					: CAPABILITIES,
			availability,
		};
	}

	async function* run(request: AgentRequest, context: AgentRunContext): AsyncGenerator<AgentEvent> {
		const preflight = preflightTurn(request, context, Date.now());
		if (!preflight.ok) {
			yield failedEvent(preflight.failure);
			return;
		}
		if (context.scratchDirectory === null) {
			yield failedEvent(PROVIDER_FAILURES.SCRATCH_DIRECTORY_REQUIRED);
			return;
		}
		yield* runCliTurn({
			processRunner: environment.processRunner,
			invocation: {
				command: COMMAND,
				args: buildClaudeArgs(context.model, context.effort),
				cwd: context.scratchDirectory,
				env: childEnv(),
				// stdin, never argv: prompts are large and contain untrusted article text.
				stdin: request.prompt,
			},
			interpreter: createClaudeStreamInterpreter(),
			externalSignal: context.signal,
			deadlineEpochMs: preflight.deadlineEpochMs,
			nowEpochMs: Date.now(),
		});
	}

	return {
		agentId: "claude-code",
		displayName: DISPLAY_NAME,
		costModel: "plan-limited",
		toolIsolation: "enforced",
		probe,
		run,
	};
}
