/**
 * Shared fakes for the provider adapter tests.
 *
 * Fixture provenance (packages/adapters/test/providers/fixtures), all captured
 * or written on 2026-10-11; ids, account data and host paths are replaced by
 * placeholders:
 *   claude-code/ok.stream.jsonl, no-tools-attempt.stream.jsonl  LIVE, claude 2.1.296, subscription login
 *   claude-code/not-logged-in.stream.jsonl, auth-status.*.json    LIVE, real CLI with an empty CLAUDE_CONFIG_DIR / real login
 *     (auth-status.api-key.json and .oauth-token.json: real `claude auth status --json` with a
 *     placeholder ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN and an empty config dir; no prompt sent)
 *   codex/ok.jsonl, tool-attempt.jsonl                            LIVE, codex-cli 0.160.0, ChatGPT login
 *   codex/not-logged-in.jsonl                                     LIVE, real CLI with an empty CODEX_HOME
 *   opencode/ok.jsonl, no-tools-attempt.jsonl                     LIVE, opencode 2.0.24, opencode-go model
 *   opencode/model-unavailable.jsonl, agent-not-found.jsonl       LIVE, real CLI, failures before any model request
 *   opencode/provider-auth.jsonl                              SHAPE from a LIVE provider.auth refusal; message redacted (SEC-010)
 *   opencode/auth-list.json                                       LIVE, `opencode auth list --standalone --format json`
 *   opencode/models.txt                                            LIVE, `opencode models` (one provider/model id per line)
 *   openrouter/*.sse                                              DOC-DERIVED from openrouter.ai/docs (no API key was available)
 *   openrouter/models.json                                         LIVE, public GET /api/v1/models, 2026-10-12, trimmed to nine entries
 */
import { readFileSync } from "node:fs";
import type { AgentRunContext } from "@research/agent-core";
import type { AgentEvent, AgentRequest } from "@research/contracts";
import type {
	ProcessExit,
	ProcessRunner,
	ProcessSpec,
	ProviderEnvironment,
} from "../../src/providers/index.ts";

export function fixtureText(relativePath: string): string {
	return readFileSync(new URL(`./fixtures/${relativePath}`, import.meta.url), "utf8");
}

export function fixtureLines(relativePath: string): readonly string[] {
	return fixtureText(relativePath)
		.split("\n")
		.filter((line) => line.length > 0);
}

export interface FakeProcessScript {
	readonly lines?: readonly string[];
	readonly exit?: Partial<ProcessExit>;
	/** `exit` rejects with an error carrying this code, as Node does for a failed spawn. */
	readonly spawnErrorCode?: string;
	/** After `lines`, stdout stays open until the signal aborts; then the process "dies". */
	readonly hang?: boolean;
	/** With `hang`: how long after the abort the process tree takes to be gone (default: at once). */
	readonly exitAfterAbortMs?: number;
	/** A misbehaving runner: stdout never ends and `exit` never settles, even after an abort. */
	readonly ignoreAbort?: boolean;
}

export interface FakeProcessRunner {
	readonly runner: ProcessRunner;
	readonly spawns: ProcessSpec[];
}

function spawnError(code: string): Error {
	return Object.assign(new Error(`spawn failed: ${code}`), { code });
}

function onceAborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

const NEVER = new Promise<never>(() => undefined);

export function createFakeProcessRunner(
	script: FakeProcessScript | ((spec: ProcessSpec) => FakeProcessScript),
): FakeProcessRunner {
	const spawns: ProcessSpec[] = [];
	const runner: ProcessRunner = {
		run(spec) {
			spawns.push(spec);
			const plan = typeof script === "function" ? script(spec) : script;
			const exitValue: ProcessExit = {
				code: plan.exit?.code === undefined ? 0 : plan.exit.code,
				signal: plan.exit?.signal ?? null,
				stderrTail: plan.exit?.stderrTail ?? "",
			};
			async function* stdoutLines(): AsyncGenerator<string, void, undefined> {
				if (plan.spawnErrorCode !== undefined) return;
				for (const line of plan.lines ?? []) yield line;
				if (plan.ignoreAbort === true) await NEVER;
				if (plan.hang === true) await onceAborted(spec.signal);
			}
			const exit = (async (): Promise<ProcessExit> => {
				if (plan.spawnErrorCode !== undefined) throw spawnError(plan.spawnErrorCode);
				if (plan.ignoreAbort === true) return NEVER;
				if (plan.hang === true) {
					await onceAborted(spec.signal);
					const delayMs = plan.exitAfterAbortMs;
					if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
					return { code: null, signal: "SIGTERM", stderrTail: exitValue.stderrTail };
				}
				return exitValue;
			})();
			// The adapter under test decides what a failed spawn means; this only stops
			// Node from reporting the fake's rejection before the adapter attaches to it.
			exit.catch(() => "handled by the adapter under test");
			return { stdoutLines: stdoutLines(), exit };
		},
	};
	return { runner, spawns };
}

/** A fetch that fails the test if an adapter that must stay offline calls it. */
export const forbiddenFetch: typeof fetch = () => {
	throw new Error("fetch must not be called in this test");
};

export function makeEnvironment(overrides: Partial<ProviderEnvironment> = {}): ProviderEnvironment {
	return {
		processRunner: createFakeProcessRunner({}).runner,
		fetch: forbiddenFetch,
		env: BASE_ENV,
		...overrides,
	};
}

export const BASE_ENV: Readonly<Record<string, string | undefined>> = {
	PATH: "/usr/bin:/bin",
	HOME: "/home/owner",
	USER: "owner",
	LANG: "en_US.UTF-8",
	LC_ALL: "en_US.UTF-8",
	TMPDIR: "/tmp/owner",
	TERM: "dumb",
};

/** Everything a runner process might hold that no child CLI may ever receive. */
export const SECRET_ENV: Readonly<Record<string, string>> = {
	RESEARCH_RUNNER_TOKEN: "secret-runner-token",
	RUNNER_SHARED_SECRET: "secret-runner-shared",
	WORKER_API_SECRET: "secret-worker",
	CLOUDFLARE_API_TOKEN: "secret-cloudflare",
	CLOUDFLARE_ACCOUNT_ID: "secret-cloudflare-account",
	OPENROUTER_API_KEY: "sk-or-v1-secret-openrouter-key",
	OPENROUTER_MODEL: "example/model",
	OPENROUTER_FREE_MODEL: "example/model:free",
	DATABASE_URL: "postgres://user:secret-db-password@host/db",
	D1_DATABASE_TOKEN: "secret-d1",
	ANTHROPIC_API_KEY: "sk-ant-secret",
	ANTHROPIC_BASE_URL: "https://attacker.example",
	OPENAI_API_KEY: "sk-openai-secret",
	CODEX_API_KEY: "sk-codex-secret",
	GEMINI_API_KEY: "secret-gemini",
	OPENCODE_API_KEY: "secret-opencode",
	OPENCODE_CONFIG_CONTENT: '{"permissions":[{"action":"*","resource":"*","effect":"allow"}]}',
	OPENCODE_CONFIG: "/home/owner/permissive.json",
	GITHUB_TOKEN: "secret-github",
	AWS_SECRET_ACCESS_KEY: "secret-aws",
	NODE_OPTIONS: "--require /tmp/evil.js",
	SSH_AUTH_SOCK: "/tmp/ssh.sock",
};

const FAR_FUTURE_DEADLINE = "2999-01-01T00:00:00.000Z";

export function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
	return {
		runId: "run_1",
		conversationId: "conv_1",
		prompt: "PROMPT-MARKER: reply with the single word OK.",
		permittedToolIds: [],
		maxToolCalls: 0,
		deadline: FAR_FUTURE_DEADLINE,
		...overrides,
	};
}

export function makeContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
	return {
		signal: new AbortController().signal,
		scratchDirectory: "/scratch/job_1",
		model: null,
		effort: "medium",
		...overrides,
	};
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const collected: AgentEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

export function textOf(events: readonly AgentEvent[]): string {
	return events.map((event) => (event.type === "text.delta" ? event.text : "")).join("");
}

export function terminalEvents(events: readonly AgentEvent[]): AgentEvent[] {
	return events.filter((event) => event.type === "completed" || event.type === "failed");
}

export function usageEvents(events: readonly AgentEvent[]): AgentEvent[] {
	return events.filter((event) => event.type === "usage");
}

/** Narrowing accessor for arrays under `noUncheckedIndexedAccess`. */
export function itemAt<T>(items: readonly T[], index: number): T {
	const item = items.at(index);
	if (item === undefined) throw new Error(`expected an item at index ${index}`);
	return item;
}

/** The value following a flag in an argv, e.g. `valueAfter(args, "--model")`. */
export function valueAfter(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}
