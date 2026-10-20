/**
 * Codex adapter — one text turn through `codex exec --json`.
 *
 * VERIFIED 2026-10-11 against `codex-cli` 0.160.0 (`codex --help`,
 * `codex exec --help`, `codex login --help`, `codex features list`,
 * `codex debug prompt-input`) and the config reference at
 * https://developers.openai.com/codex/config-reference (redirects to
 * https://learn.chatgpt.com/docs/config-file/config-reference) and
 * https://developers.openai.com/codex/noninteractive, plus live invocations.
 *
 * TOOL ISOLATION IS "unverified" — AND KNOWN TO BE INCOMPLETE. Codex has no
 * switch that removes every tool, and its output never lists the tools it
 * offered. With every hardening flag in `buildCodexArgs`, a live turn asked to
 * list its callable tools still named `functions.exec`,
 * `functions.request_user_input`, `functions.wait` and the `collaboration.*`
 * sub-agent tools (`--disable multi_agent` did not remove them). In that turn
 * `exec` failed closed ("code-mode host is disabled") and no command ran, but
 * that is an observation of one run, not an enforced property. What the flags
 * do provide:
 *   - `--sandbox read-only` + `approval_policy="never"`: model-run commands
 *     cannot write or use the network, and nothing can be escalated. A
 *     read-only sandbox STILL lets a command read files outside the scratch
 *     directory (anything the owner's account can read).
 *   - `--ignore-user-config`, `--ignore-rules`, `mcp_servers={}`, `notify=[]`:
 *     the owner's MCP servers, notify hook and exec-policy rules are not loaded.
 *   - `web_search="disabled"` and the `--disable` feature list: shell, unified
 *     exec, apps/connectors, plugins, hooks, browser/computer use, image tools.
 *   - `shell_environment_policy.inherit="none"`: commands get no environment.
 * As a second line of defence the adapter fails the turn closed
 * (`PROVIDER_TOOL_ISOLATION_VIOLATED`) and kills the process as soon as the
 * event stream shows any item that is not plain text, reasoning, a plan update
 * or a warning — i.e. on the first command, file change, MCP call, web search
 * or sub-agent call. That is detection, not prevention.
 *
 * Output shape (live): `thread.started`, `turn.started`,
 * `item.completed {item:{type:"agent_message", text}}` (whole messages — there
 * are no incremental deltas, so `stream` is NOT claimed), `turn.completed
 * {usage}` with token counts and no cost. `item.completed {item:{type:"error"}}`
 * is a non-fatal warning and top-level `error` lines are transient
 * ("Reconnecting... 2/5"); only `turn.failed` or a non-zero exit fail the turn.
 * Not logged in (captured with an empty CODEX_HOME, no quota used): repeated
 * 401 `error` lines, then `turn.failed`, exit 1; `codex login status` prints
 * "Not logged in" on stderr and exits 1 ("Logged in using ChatGPT", exit 0,
 * when logged in).
 *
 * Deliberately NOT forwarded: OPENAI_API_KEY, CODEX_API_KEY, OPENAI_BASE_URL.
 * An API-key login is metered and Codex reports no cost at all, so the probe
 * refuses it (NOT_CONFIGURED) rather than run metered work under a
 * "plan-limited" label (AGT-012). The API-key wording of `codex login status`
 * is doc-derived, not observed.
 *
 * Other limits: `~/.codex/AGENTS.md` (the owner's own global instructions) is
 * still injected by the CLI; every `--disable` name must exist in the installed
 * version or the CLI exits with "Unknown feature flag" (fails closed).
 *
 * Terms caveat: OpenAI's docs call API keys "the right default for automation"
 * and ChatGPT-managed auth in automation an advanced path for trusted runners.
 * This adapter runs the owner's own login on the owner's own machine; whether
 * the plan permits it is for the owner to confirm.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime, Effort } from "@research/agent-core";
import type { AgentCapabilities, AgentEvent, AgentRequest } from "@research/contracts";
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
	createSegmentJoiner,
	IGNORED,
	type LineVerdict,
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
	parseJsonLine,
	preflightTurn,
} from "./turn.ts";

const COMMAND = "codex";
const DISPLAY_NAME = "Codex";
const MINIMUM_VERSION: Version = [0, 160, 0];

const CODEX_ENV_KEYS = ["CODEX_HOME"] as const;

/** No `stream` (whole messages only) and no `cancel` (a process kill is not a provider cancel). */
const CAPABILITIES: AgentCapabilities = { supported: [] };

/**
 * Output budget for `codex debug models`. The catalog is one JSON line that
 * carries each model's full instructions (about 560 KB for 9 models in
 * codex-cli 0.163.0), so the status-command budget would cut it off.
 */
export const CODEX_MODEL_CATALOG_MAX_CHARS = 4 * 1024 * 1024;

/** Contract cap on `capabilities.models`. */
const MAX_REPORTED_MODELS = 300;

const catalogEnvelopeSchema = z.looseObject({ models: z.array(z.unknown()) });

const catalogEntrySchema = z.looseObject({
	slug: z.string(),
	visibility: z.string().optional(),
	priority: z.number().optional(),
});

/**
 * Model ids from `codex debug models`, in the order the Codex model picker
 * shows them: entries with visibility "list", by ascending `priority` (an
 * entry without one goes last), catalog order breaking ties. Each entry is
 * checked on its own, so one odd entry never hides the rest; ids that fail
 * the model-id validation are dropped and duplicates keep their first place.
 * Null when the output is not a catalog at all.
 */
export function parseCodexModelCatalog(stdout: string): string[] | null {
	const json = parseJsonLine(stdout);
	const envelope = json.ok ? catalogEnvelopeSchema.safeParse(json.value) : null;
	if (envelope === null || !envelope.success) return null;
	const listed: { readonly slug: string; readonly priority: number }[] = [];
	for (const entry of envelope.data.models) {
		const parsed = catalogEntrySchema.safeParse(entry);
		if (!parsed.success || parsed.data.visibility !== "list") continue;
		if (!isValidModelId(parsed.data.slug)) continue;
		listed.push({
			slug: parsed.data.slug,
			priority: parsed.data.priority ?? Number.POSITIVE_INFINITY,
		});
	}
	// Array.prototype.sort is stable, so equal priorities keep catalog order.
	listed.sort((left, right) =>
		left.priority < right.priority ? -1 : left.priority > right.priority ? 1 : 0,
	);
	return [...new Set(listed.map((entry) => entry.slug))].slice(0, MAX_REPORTED_MODELS);
}

/** Feature flags that exist in codex-cli 0.160.0 and each add a tool or an ambient extension. */
export const CODEX_DISABLED_FEATURES = [
	"shell_tool",
	"unified_exec",
	"apps",
	"plugins",
	"remote_plugin",
	"hooks",
	"multi_agent",
	"browser_use",
	"browser_use_external",
	"computer_use",
	"image_generation",
	"view_image",
	"memories",
	"skill_search",
	"tool_suggest",
	"goals",
	"sleep_tool",
	"in_app_browser",
	"code_mode_host",
	"workspace_dependencies",
	"skill_mcp_dependency_install",
] as const;

export function buildCodexArgs(
	scratchDirectory: string,
	model: string | null,
	effort: Effort,
): readonly string[] {
	return [
		"exec",
		"--json",
		"--color",
		"never",
		"--sandbox",
		"read-only",
		"--skip-git-repo-check",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"-C",
		scratchDirectory,
		"-c",
		'approval_policy="never"',
		"-c",
		'web_search="disabled"',
		"-c",
		"mcp_servers={}",
		"-c",
		"notify=[]",
		"-c",
		"project_doc_max_bytes=0",
		"-c",
		'shell_environment_policy.inherit="none"',
		"-c",
		`model_reasoning_effort="${effort}"`,
		...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
		...(model === null ? [] : ["-m", model]),
		// "-" makes the CLI read the prompt from stdin instead of argv.
		"-",
	];
}

const typedLineSchema = z.looseObject({ type: z.string() });

const itemLineSchema = z.looseObject({
	item: z.looseObject({ type: z.string(), text: z.string().optional() }),
});

const turnFailedLineSchema = z.looseObject({
	error: z.looseObject({ message: z.string().optional() }).optional(),
});

/** Item types that are text or bookkeeping; anything else is the model using a tool. */
const BENIGN_ITEM_TYPES: ReadonlySet<string> = new Set([
	"agent_message",
	"reasoning",
	"error",
	"todo_list",
]);

export function createCodexStreamInterpreter(): CliStreamInterpreter {
	const joinSegment = createSegmentJoiner();
	let turnCompleted = false;
	let turnFailureMessage: string | null = null;

	function interpretItem(eventType: string, value: unknown): LineVerdict {
		const parsed = itemLineSchema.safeParse(value);
		if (!parsed.success) return MALFORMED;
		const { item } = parsed.data;
		if (!BENIGN_ITEM_TYPES.has(item.type)) {
			return { kind: "fatal", failure: PROVIDER_FAILURES.PROVIDER_TOOL_ISOLATION_VIOLATED };
		}
		if (eventType !== "item.completed" || item.type !== "agent_message") return IGNORED;
		return { kind: "text", text: joinSegment(item.text ?? "") };
	}

	return {
		interpretLine(line) {
			const json = parseJsonLine(line);
			if (!json.ok) return MALFORMED;
			const typed = typedLineSchema.safeParse(json.value);
			if (!typed.success) return MALFORMED;
			const { type } = typed.data;
			if (type.startsWith("item.")) return interpretItem(type, json.value);
			if (type === "turn.completed") {
				turnCompleted = true;
				return IGNORED;
			}
			if (type === "turn.failed") {
				const parsed = turnFailedLineSchema.safeParse(json.value);
				turnFailureMessage = parsed.success ? (parsed.data.error?.message ?? "") : "";
				return IGNORED;
			}
			// thread.started, turn.started, transient top-level `error` notices, future types.
			return IGNORED;
		},
		conclude(exit, emittedTextChars): TurnConclusion {
			const unknownCost = { trailingText: "", knownCostUsd: null };
			if (exit.code === 0 && turnCompleted && turnFailureMessage === null) {
				return emittedTextChars > 0
					? { failure: null, ...unknownCost }
					: { failure: PROVIDER_FAILURES.PROVIDER_OUTPUT_EMPTY, ...unknownCost };
			}
			const hint = hintFromText(`${turnFailureMessage ?? ""}\n${exit.stderrTail}`);
			if (hint !== null) return { failure: failureForHint(hint), ...unknownCost };
			if (exit.code !== 0)
				return { failure: PROVIDER_FAILURES.PROVIDER_EXIT_NONZERO, ...unknownCost };
			return {
				failure:
					turnFailureMessage === null
						? PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID
						: PROVIDER_FAILURES.PROVIDER_ERROR,
				...unknownCost,
			};
		},
	};
}

export function createCodexRuntime(environment: ProviderEnvironment): AgentRuntime {
	const childEnv = (): Record<string, string> => buildChildEnv(environment.env, CODEX_ENV_KEYS);

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
			args: ["login", "status"],
		});
		if (status.kind !== "exited") {
			return {
				capabilities: CAPABILITIES,
				availability: unavailable("PROBE_FAILED", "`codex login status` did not complete"),
			};
		}
		// The status line goes to stderr. It can contain a masked key, so it is only matched, never echoed.
		const statusText = `${status.stdout}\n${status.stderrTail}`;
		if (status.code !== 0 || /not logged in/i.test(statusText)) {
			return {
				capabilities: CAPABILITIES,
				availability: unavailable("NOT_AUTHENTICATED", "Codex is not logged in; run `codex login`"),
			};
		}
		if (/api key/i.test(statusText)) {
			return {
				capabilities: CAPABILITIES,
				availability: unavailable(
					"NOT_CONFIGURED",
					"Codex is logged in with a metered API key; this plan-limited adapter only runs on a ChatGPT login",
				),
			};
		}
		if (!/logged in/i.test(statusText)) {
			return {
				capabilities: CAPABILITIES,
				availability: unavailable("PROBE_FAILED", "`codex login status` output was not understood"),
			};
		}
		// The model list lets Settings → AI agent offer a selector instead of
		// asking the owner for an id. `codex debug models` prints the catalog
		// the model picker uses; it sends no prompt and spends no quota. When
		// it fails, the backend stays available and the list is omitted.
		const catalog = await captureCommand(
			environment.processRunner,
			{ ...base, command: COMMAND, args: ["debug", "models"] },
			{ maxOutputChars: CODEX_MODEL_CATALOG_MAX_CHARS },
		);
		const models =
			catalog.kind === "exited" && catalog.code === 0
				? parseCodexModelCatalog(catalog.stdout)
				: null;
		return {
			capabilities: models === null ? CAPABILITIES : { ...CAPABILITIES, models },
			availability: AVAILABLE,
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
				args: buildCodexArgs(context.scratchDirectory, context.model, context.effort),
				cwd: context.scratchDirectory,
				env: childEnv(),
				stdin: request.prompt,
			},
			interpreter: createCodexStreamInterpreter(),
			externalSignal: context.signal,
			deadlineEpochMs: preflight.deadlineEpochMs,
			nowEpochMs: Date.now(),
		});
	}

	return {
		agentId: "codex",
		displayName: DISPLAY_NAME,
		costModel: "plan-limited",
		toolIsolation: "unverified",
		probe,
		run,
	};
}
