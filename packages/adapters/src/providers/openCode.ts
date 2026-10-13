/**
 * OpenCode adapter — one text-only turn through `opencode run`.
 *
 * VERIFIED 2026-10-12 against `opencode` v2.0.27 (npm `@opencode/cli`;
 * `opencode --help`, `run --help`, `auth --help`, `serve --help`,
 * `debug config`, `debug agents`) and the v2 documentation at
 * https://opencode.ai/v2/docs/{config,permissions,agents,cli}. The v1 pages
 * under https://docs.opencode.ai/docs/ (SDK, server, permissions, config) were
 * read too but describe a DIFFERENT config schema (`permission` object,
 * `--attach`, OPENCODE_PERMISSION) that this CLI does not use; the bundled
 * `@opencode-ai/sdk` 1.19 targets that older server and is therefore not used.
 * Earlier evidence was gathered on v2.0.24 (2026-10-11); both configs below
 * were re-verified on v2.0.27 on 2026-10-12.
 *
 * - Integration: `opencode run --standalone --format json --agent research-text
 *   --model <provider/model>`, prompt on stdin, cwd = the job scratch dir.
 *   `--standalone` makes the CLI start a PRIVATE server as its own child over
 *   stdio (`opencode serve --stdio --port 0`, seen in its logs) instead of
 *   using the per-user background service, so the tool-executing process gets
 *   only this adapter's allowlisted environment and exits with the run. No
 *   port is exposed and nothing is left running (checked with `ps`).
 * - Tool isolation, plan models ("enforced"): the adapter writes `opencode.jsonc`
 *   into the scratch dir (documented project config; the owner's global config
 *   is never touched). It defines the agent `research-text` whose rules end in
 *   `{action:"*", resource:"*", effect:"deny"}`. Evidence on this machine:
 *   `opencode debug agents` showed that agent's resolved rule list ending in
 *   deny-all (identical to the built-in `title` agent the docs describe as
 *   "deny all actions"; the last matching rule wins); a live prompt that asked
 *   it to run `echo hi` and read /etc/hosts answered NO_TOOLS with no tool
 *   event; and that request was 397 input tokens, i.e. no tool schemas were
 *   sent. This deny-all config is the default and the stronger isolation: it
 *   is used for every non-free model. If the config is not loaded the run
 *   cannot fall back to a tool-capable agent: the CLI exits with
 *   `Agent not found: "research-text"` (verified). Any tool event in the
 *   stream still fails the turn closed. Because there is no per-run tool
 *   listing to re-check, the claim is pinned to the verified release line:
 *   outside 2.0.x (>= 2.0.27, < 2.1.0) `probe()` reports
 *   UNSUPPORTED_VERSION / TOOL_ISOLATION_UNVERIFIED instead of "available".
 * - Tool isolation, free-tier models (`-free` suffix, ask-and-reject): the
 *   provider refuses a free-tier request that does not carry OpenCode's tool
 *   set, so the deny-all config above is answered with `provider.auth` / 403.
 *   For a free-tier model only, the adapter writes a second config whose rule
 *   list is deny-first, then `ask` for the ten verified gated permissions
 *   (OPENCODE_FREE_TIER_GATED_PERMISSIONS; `edit` covers both the `edit` and
 *   `write` tools, so ten permissions advertise eleven tools). The free-tier
 *   request is therefore accepted, and a non-interactive `opencode run`
 *   (never `--auto`) rejects every ask before the tool runs: stderr prints
 *   `permission requested: <permission> (<resource>); auto-rejecting`, and the
 *   JSON stream carries a `tool_use` event whose `part.state.status` is
 *   `"error"`. Forced calls were tried for every gated tool on v2.0.27 and
 *   each was rejected with no side effect (no file created, canary content
 *   never returned). The `execute` tool is NOT permission-gated and ran to
 *   completion under an ask-everything rule, so it must stay denied: the
 *   deny-first rule keeps it (and any unknown future tool) out of the request.
 *   This is a weaker mechanism than deny-all (tools are advertised and blocked
 *   at call time by the CLI rather than never sent). Stream handling stays
 *   fail-closed: ANY tool event ends the turn immediately; a tool event whose
 *   state status is `"error"` in a free-tier run (the call was rejected,
 *   nothing ran) fails with PROVIDER_TOOL_CALL_REJECTED, any other tool event
 *   — and every tool event in a plan-model run, where no tool is sent — fails
 *   with PROVIDER_TOOL_ISOLATION_VIOLATED. Only the status is read, never the
 *   provider's message text or tool inputs (SEC-010).
 * - Residual risks: the free-tier claim rests on the CLI rejecting asks in
 *   non-interactive mode and on the gated-permission list verified on v2.0.27
 *   (2026-10-12). A later 2.0.x release could add another ungated tool, which
 *   the deny-first rule keeps out of the request because unknown tools are
 *   denied; a changed ask-rejection behaviour would surface as
 *   PROVIDER_TOOL_ISOLATION_VIOLATED (fail-closed). The provider's acceptance
 *   check is its own policy and may change, in which case the turn fails with
 *   PROVIDER_AUTH (fail-closed). Whether running free-tier models as an
 *   application backend fits the provider's terms is for the owner to check.
 * - Output shape (live): `step_start`, `text` (one whole text part — no
 *   incremental deltas, so `stream` is NOT claimed), sometimes `step_finish`
 *   (it was missing from one of two runs, so nothing depends on it), and
 *   `{"type":"error","error":{type,message}}` with exit 1 on failure.
 * - Cost: always unknown (null). `step_finish.cost` is OpenCode's own estimate
 *   and is notional on a subscription provider; this machine has both a
 *   subscription (`opencode-go/*`) and a metered credential (`opencode/*`), so
 *   the adapter REQUIRES an explicit model (run context or OPENCODE_MODEL) and
 *   never lets the CLI pick its default provider (AGT-012). Choosing a model on
 *   a metered provider is the owner's decision; its spend is still "unknown".
 *
 * Deliberately NOT forwarded: every provider API key (GEMINI_API_KEY,
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENCODE_API_KEY, ...), so only
 * credentials stored by `opencode auth login` are usable, and OPENCODE_CONFIG /
 * OPENCODE_CONFIG_CONTENT / OPENCODE_CONFIG_DIR, which could add allow rules.
 *
 * Known limits: sessions are persisted in the owner's OpenCode database (the
 * CLI has no ephemeral mode; OPENCODE_DB=":memory:" also hides the stored
 * credentials). Plugins and MCP servers from the owner's GLOBAL config are
 * still loaded by the private server (their tools are denied by the "*" rule,
 * but a plugin is arbitrary code the owner installed). A global agent that is
 * also called `research-text` would be merged with this one.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import type { AgentCapabilities, AgentEvent, AgentRequest } from "@research/contracts";
import { isFreeTierModelId } from "@research/contracts";
import { z } from "zod";
import {
	AVAILABLE,
	captureCommand,
	compareVersions,
	formatVersion,
	probeCliVersion,
	unavailable,
	type Version,
} from "./cliProbe.ts";
import {
	type CliStreamInterpreter,
	createSegmentJoiner,
	IGNORED,
	MALFORMED,
	runCliTurn,
	type TurnConclusion,
} from "./cliTurn.ts";
import { buildChildEnv, type ProviderEnvironment, probeWorkingDirectory } from "./environment.ts";
import {
	failedEvent,
	failureForHint,
	hintFromText,
	isValidModelId,
	PROVIDER_FAILURES,
	type ProviderFailure,
	parseJsonLine,
	preflightTurn,
	settle,
} from "./turn.ts";

const COMMAND = "opencode";
const DISPLAY_NAME = "OpenCode";
const MINIMUM_VERSION: Version = [2, 0, 27];
/** First version whose permission semantics have NOT been verified. */
const UNVERIFIED_FROM_VERSION: Version = [2, 1, 0];

/** Where OpenCode keeps its config, credentials and cache (XDG base directories). */
const OPENCODE_ENV_KEYS = [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

/** No `stream` (whole text parts only) and no `cancel` (a process kill is not a provider cancel). */
const CAPABILITIES_BASE: AgentCapabilities = { supported: [] };

export const OPENCODE_AGENT_ID = "research-text";
export const OPENCODE_CONFIG_FILE_NAME = "opencode.jsonc";

const DENY_EVERYTHING = { action: "*", resource: "*", effect: "deny" } as const;

/**
 * The ten gated permissions the free-tier ask-and-reject config was verified
 * against on v2.0.27 (2026-10-12). `edit` covers both the `edit` and `write`
 * tools, so these ten permissions advertise eleven tools. `execute` is
 * deliberately absent: it is not permission-gated and must stay denied by the
 * deny-first rule. The last matching rule wins, so every list built from this
 * starts with DENY_EVERYTHING.
 */
export const OPENCODE_FREE_TIER_GATED_PERMISSIONS = [
	"edit",
	"glob",
	"grep",
	"question",
	"read",
	"shell",
	"skill",
	"subagent",
	"webfetch",
	"websearch",
] as const;

export type OpenCodeFreeTierPermission = (typeof OPENCODE_FREE_TIER_GATED_PERMISSIONS)[number];

function askRule(action: OpenCodeFreeTierPermission): {
	readonly action: OpenCodeFreeTierPermission;
	readonly resource: "*";
	readonly effect: "ask";
} {
	return { action, resource: "*", effect: "ask" };
}

const FREE_TIER_ASK_RULES = OPENCODE_FREE_TIER_GATED_PERMISSIONS.map(askRule);

const FREE_TIER_SYSTEM_PROMPT =
	"You are a text-generation backend for a research application. This session lists tools only because the provider requires it for this model, but every tool call is rejected before it runs and ends the turn with a failure. You have no working tools. Answer the user message with text only, in exactly the format it asks for. Do not call any tool.";

/** Per-invocation project config: every permission denied, globally and for the agent used. */
export const OPENCODE_CONFIG_CONTENT = `${JSON.stringify(
	{
		$schema: "https://opencode.ai/config.json",
		permissions: [DENY_EVERYTHING],
		default_agent: OPENCODE_AGENT_ID,
		agents: {
			[OPENCODE_AGENT_ID]: {
				description: "Text-only generation backend with no tools",
				mode: "primary",
				system:
					"You are a text-generation backend for a research application. You have no tools and cannot take actions. Answer the user message with text only, in exactly the format it asks for.",
				permissions: [DENY_EVERYTHING],
			},
		},
	},
	null,
	"\t",
)}\n`;

/**
 * Per-invocation project config for free-tier models only: deny-first, then
 * `ask` for each gated permission at both levels. Unknown tools (including
 * `execute`) match only the deny rule and are never sent as usable tools.
 */
export const OPENCODE_FREE_TIER_CONFIG_CONTENT = `${JSON.stringify(
	{
		$schema: "https://opencode.ai/config.json",
		permissions: [DENY_EVERYTHING, ...FREE_TIER_ASK_RULES],
		default_agent: OPENCODE_AGENT_ID,
		agents: {
			[OPENCODE_AGENT_ID]: {
				description: "Text-only generation backend with every tool call rejected",
				mode: "primary",
				system: FREE_TIER_SYSTEM_PROMPT,
				permissions: [DENY_EVERYTHING, ...FREE_TIER_ASK_RULES],
			},
		},
	},
	null,
	"\t",
)}\n`;

/** Chooses the per-run config by model: deny-all everywhere except free-tier ids. */
export function buildOpenCodeConfigContent(model: string): string {
	return isFreeTierModelId(model) ? OPENCODE_FREE_TIER_CONFIG_CONTENT : OPENCODE_CONFIG_CONTENT;
}

export function buildOpenCodeArgs(model: string): readonly string[] {
	return [
		"run",
		// A private server for this run only, never the shared per-user background service.
		"--standalone",
		"--format",
		"json",
		"--agent",
		OPENCODE_AGENT_ID,
		"--model",
		model,
		// No message argument: the prompt is read from stdin. `--auto` is never passed.
	];
}

const eventLineSchema = z.looseObject({
	type: z.string(),
	part: z
		.looseObject({
			type: z.string().optional(),
			text: z.string().optional(),
			state: z.looseObject({ status: z.string().optional() }).optional(),
		})
		.optional(),
	error: z.looseObject({ type: z.string().optional(), message: z.string().optional() }).optional(),
});

function failureForErrorEvent(errorType: string, message: string): ProviderFailure {
	// Seen for an unknown model AND for a provider with no stored credential.
	if (errorType === "provider.no-route") return PROVIDER_FAILURES.PROVIDER_MODEL_UNAVAILABLE;
	// The provider refused the credentials/plan for this model (e.g. a
	// free-tier model outside its own client). Non-retryable: the same call
	// would be refused again. Only the error type is used, never the
	// provider's message text (SEC-010).
	if (errorType === "provider.auth") return PROVIDER_FAILURES.PROVIDER_AUTH;
	const hint = hintFromText(`${errorType} ${message}`);
	return hint === null ? PROVIDER_FAILURES.PROVIDER_ERROR : failureForHint(hint);
}

/**
 * `askAndReject` is true only for a run started with the free-tier config. A
 * plan-model run sends no tools at all, so a tool event there — whatever its
 * status — means the deny-all config did not hold and is always a violation.
 */
export function createOpenCodeStreamInterpreter(
	options: { readonly askAndReject: boolean } = { askAndReject: false },
): CliStreamInterpreter {
	const joinSegment = createSegmentJoiner();
	let errorFailure: ProviderFailure | null = null;

	return {
		interpretLine(line) {
			const json = parseJsonLine(line);
			if (!json.ok) return MALFORMED;
			const parsed = eventLineSchema.safeParse(json.value);
			if (!parsed.success) return MALFORMED;
			const event = parsed.data;
			// `tool_use` is the tool event name in this CLI; matching on "tool" also covers renames.
			// Fail-closed either way, but distinguish the free-tier ask-and-reject
			// case (status "error": the CLI rejected the call before it ran,
			// nothing executed) from a tool that ran or whose state is unknown.
			// Only the status is read, never message text or tool inputs (SEC-010).
			if (/tool/i.test(event.type) || /tool/i.test(event.part?.type ?? "")) {
				if (options.askAndReject && event.part?.state?.status === "error") {
					return { kind: "fatal", failure: PROVIDER_FAILURES.PROVIDER_TOOL_CALL_REJECTED };
				}
				return { kind: "fatal", failure: PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_VIOLATED };
			}
			if (event.type === "error") {
				errorFailure = failureForErrorEvent(event.error?.type ?? "", event.error?.message ?? "");
				return IGNORED;
			}
			if (event.type === "text") return { kind: "text", text: joinSegment(event.part?.text ?? "") };
			return IGNORED;
		},
		conclude(exit, emittedTextChars): TurnConclusion {
			const unknownCost = { trailingText: "", knownCostUsd: null };
			if (errorFailure !== null) return { failure: errorFailure, ...unknownCost };
			if (exit.code !== 0) {
				const hint = hintFromText(exit.stderrTail);
				return {
					failure: hint === null ? PROVIDER_FAILURES.PROVIDER_EXIT_NONZERO : failureForHint(hint),
					...unknownCost,
				};
			}
			return emittedTextChars > 0
				? { failure: null, ...unknownCost }
				: { failure: PROVIDER_FAILURES.PROVIDER_OUTPUT_EMPTY, ...unknownCost };
		},
	};
}

const authListSchema = z.array(
	z.looseObject({
		connections: z.array(z.looseObject({ type: z.string() })).optional(),
	}),
);

export interface OpenCodeRuntimeOptions {
	/** Writes the per-invocation config; replaceable so tests need no filesystem. */
	readonly writeConfigFile?: (path: string, content: string) => Promise<void>;
}

function writeOwnerOnlyFile(path: string, content: string): Promise<void> {
	return writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}

/** Model ids the `opencode models` listing may hold; at most this many are reported. */
export const MAX_REPORTED_MODELS = 300;

/**
 * Parses `opencode models` output: one `provider/model` id per line. Keeps
 * ids that pass the adapter's model-id validation, de-duplicates, sorts and
 * caps the list. Lines the CLI prints around the list (warnings, blanks) are
 * dropped rather than failing the probe.
 */
export function parseModelList(stdout: string): string[] {
	const ids = new Set<string>();
	for (const line of stdout.split("\n")) {
		const id = line.trim();
		if (id !== "" && isValidModelId(id)) ids.add(id);
	}
	return [...ids].sort().slice(0, MAX_REPORTED_MODELS);
}

export function createOpenCodeRuntime(
	environment: ProviderEnvironment,
	options: OpenCodeRuntimeOptions = {},
): AgentRuntime {
	const writeConfigFile = options.writeConfigFile ?? writeOwnerOnlyFile;
	const childEnv = (): Record<string, string> => buildChildEnv(environment.env, OPENCODE_ENV_KEYS);
	const configuredModel = (): string | null => {
		const model = environment.env.OPENCODE_MODEL;
		return model !== undefined && isValidModelId(model) ? model : null;
	};
	const capabilities = (): AgentCapabilities => {
		const model = configuredModel();
		return model === null ? CAPABILITIES_BASE : { ...CAPABILITIES_BASE, model };
	};

	async function probe(): Promise<AgentProbe> {
		const base = { cwd: probeWorkingDirectory(environment.env), env: childEnv() };
		const version = await probeCliVersion(
			environment.processRunner,
			{ ...base, command: COMMAND, args: ["--version"] },
			DISPLAY_NAME,
			MINIMUM_VERSION,
		);
		if (!version.ok) return { capabilities: capabilities(), availability: version.availability };
		if (compareVersions(version.version, UNVERIFIED_FROM_VERSION) >= 0) {
			return {
				capabilities: capabilities(),
				availability: unavailable(
					"TOOL_ISOLATION_UNVERIFIED",
					`OpenCode ${formatVersion(version.version)} is newer than the 2.0.x line on which the permission configs were verified`,
				),
			};
		}
		// Lists integrations without printing secrets (`auth export` is the command that does).
		const status = await captureCommand(environment.processRunner, {
			...base,
			command: COMMAND,
			args: ["auth", "list", "--standalone", "--format", "json"],
		});
		if (status.kind !== "exited" || status.code !== 0) {
			return {
				capabilities: capabilities(),
				availability: unavailable("PROBE_FAILED", "`opencode auth list` did not complete"),
			};
		}
		const json = parseJsonLine(status.stdout);
		const parsed = json.ok ? authListSchema.safeParse(json.value) : null;
		if (parsed === null || !parsed.success) {
			return {
				capabilities: capabilities(),
				availability: unavailable("PROBE_FAILED", "`opencode auth list` output was not understood"),
			};
		}
		// Environment-variable connections are not counted: provider keys are not forwarded to runs.
		const hasStoredCredential = parsed.data.some((integration) =>
			(integration.connections ?? []).some((connection) => connection.type === "credential"),
		);
		const availability = hasStoredCredential
			? AVAILABLE
			: unavailable(
					"NOT_AUTHENTICATED",
					"OpenCode has no stored credential; run `opencode auth login`",
				);
		// The model list is a convenience for the settings form, reported
		// alongside availability. `opencode models` only lists the local
		// catalog — it sends no prompt and spends no model quota. When it
		// fails, the backend is reported as it otherwise would be and the
		// list is simply omitted.
		const models = await captureCommand(environment.processRunner, {
			...base,
			command: COMMAND,
			args: ["models"],
		});
		if (models.kind !== "exited" || models.code !== 0) {
			return { capabilities: capabilities(), availability };
		}
		return {
			capabilities: { ...capabilities(), models: parseModelList(models.stdout) },
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
		const model = context.model ?? configuredModel();
		if (model === null) {
			yield failedEvent(PROVIDER_FAILURES.PROVIDER_MODEL_REQUIRED);
			return;
		}
		// Without this file there is no research-text agent, so a failed write ends the turn here.
		const written = await settle(
			writeConfigFile(
				join(context.scratchDirectory, OPENCODE_CONFIG_FILE_NAME),
				buildOpenCodeConfigContent(model),
			),
		);
		if (!written.ok) {
			yield failedEvent(PROVIDER_FAILURES.PROVIDER_CONFIG_WRITE_FAILED);
			return;
		}
		yield* runCliTurn({
			processRunner: environment.processRunner,
			invocation: {
				command: COMMAND,
				args: buildOpenCodeArgs(model),
				cwd: context.scratchDirectory,
				env: childEnv(),
				stdin: request.prompt,
			},
			interpreter: createOpenCodeStreamInterpreter({ askAndReject: isFreeTierModelId(model) }),
			externalSignal: context.signal,
			deadlineEpochMs: preflight.deadlineEpochMs,
			nowEpochMs: Date.now(),
		});
	}

	return {
		agentId: "opencode",
		displayName: DISPLAY_NAME,
		costModel: "plan-limited",
		toolIsolation: "enforced",
		probe,
		run,
	};
}
