import { type AgentRuntime, extractJsonObject, parseAgentEvent } from "@research/agent-core";
import { type ClaimedJob, NOTEBOOK_LIMITS } from "@research/contracts";
import { addUsage, EMPTY_USAGE, type ResourceUsage } from "@research/domain";
import { isJsonObject, type JsonObject } from "@research/widget-grid/agent";
import { z } from "zod";
import { agentThrewCode } from "../errors.ts";
import type { Clock } from "../ports.ts";
import type { PipelineReporter } from "../research/pipeline.ts";
import { applyNotebookCommands } from "./notebookAgent.ts";
import {
	NOTEBOOK_PROMPT_BUDGET_BYTES,
	notebookAssistPrompt,
	notebookResearchComponentIds,
} from "./prompts.ts";

/**
 * The notebook-assistant turn (ADR-0020): one model turn (plus at most one
 * repair turn) turns the owner's instruction into a short reply and
 * widget-grid commands, pre-checked against the claimed notebook. No tools,
 * no network, no evidence. Removals are never applied: they are returned as
 * `proposedRemovals` for the owner to confirm.
 */

/** A claimed `notebook-assist` job plus the turn's signal and isolation opt-in. */
export type NotebookAssistTurnJob = Extract<ClaimedJob, { kind: "notebook-assist" }>;

export interface NotebookAssistTurnInput extends NotebookAssistTurnJob {
	readonly signal: AbortSignal;
	/**
	 * Explicit owner opt-in to run a backend whose own tools could not be
	 * shown to be disabled. Defaults to refusing such a backend (fail closed).
	 */
	readonly allowUnverifiedToolIsolation: boolean;
}

export interface NotebookAssistTurnDeps {
	readonly agent: AgentRuntime;
	readonly clock: Clock;
	readonly reporter: PipelineReporter;
	/** Fresh unguessable token used to fence untrusted text in prompts. */
	readonly newFenceToken: () => string;
	/**
	 * The job's own empty scratch directory (AGT-004). CLI backends need one
	 * (OpenCode writes its deny-all config there and refuses to start without
	 * it, `SCRATCH_DIRECTORY_REQUIRED`); null only for backends that need none.
	 */
	readonly scratchDirectory: string | null;
}

export type NotebookAssistTurnOutcome =
	| {
			readonly kind: "assisted";
			readonly reply: string;
			/** Non-remove commands in the model's order; removals travel separately. */
			readonly commands: readonly JsonObject[];
			readonly proposedRemovals: readonly string[];
			readonly baseVersion: number;
			readonly usage: ResourceUsage;
	  }
	| {
			readonly kind: "failed";
			readonly failureCode: string;
			readonly retryable: boolean;
			readonly usage: ResourceUsage;
	  }
	| { readonly kind: "cancelled"; readonly usage: ResourceUsage };

const notebookAssistReplySchema = z.strictObject({
	reply: z.string(),
	commands: z.array(z.unknown()).max(NOTEBOOK_LIMITS.maxCommandsPerTurn),
});

const MAX_MODEL_OUTPUT_CHARS = 400_000;

type ModelTurnResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly cancelled: true }
	| {
			readonly ok: false;
			readonly cancelled: false;
			readonly code: string;
			readonly retryable: boolean;
	  };

interface CheckedTurn {
	readonly reply: string;
	readonly commands: JsonObject[];
	readonly proposedRemovals: string[];
}

type CheckFailure = { readonly ok: false; readonly code: string; readonly message: string };

export async function runNotebookAssistTurn(
	input: NotebookAssistTurnInput,
	deps: NotebookAssistTurnDeps,
): Promise<NotebookAssistTurnOutcome> {
	let usage: ResourceUsage = EMPTY_USAGE;
	const failed = (failureCode: string, retryable: boolean): NotebookAssistTurnOutcome => ({
		kind: "failed",
		failureCode,
		retryable,
		usage,
	});
	const assisted = (checked: CheckedTurn): NotebookAssistTurnOutcome => ({
		kind: "assisted",
		reply: checked.reply,
		commands: checked.commands,
		proposedRemovals: checked.proposedRemovals,
		baseVersion: input.notebookVersion,
		usage,
	});

	if (input.signal.aborted) return { kind: "cancelled", usage };

	const probe = await deps.agent.probe();
	if (probe.availability.status !== "available") {
		return failed(`AGENT_UNAVAILABLE_${probe.availability.reasonCode}`, false);
	}
	if (deps.agent.toolIsolation !== "enforced" && !input.allowUnverifiedToolIsolation) {
		return failed("TOOL_ISOLATION_UNVERIFIED", false);
	}

	await deps.reporter.state("planning");

	const byteLength = (text: string): number => new TextEncoder().encode(text).length;

	/** One model turn under no budget (the turn is two short prompts, not a tool loop). Never throws. */
	async function modelTurn(prompt: string): Promise<ModelTurnResult> {
		if (input.signal.aborted) return { ok: false, cancelled: true };
		usage = addUsage(usage, { agentSteps: 1, inputBytes: byteLength(prompt) });
		let text = "";
		// undefined = the provider reported nothing; that is an unknown cost, not a zero one.
		let reportedCost: number | null | undefined;
		let providerFailure: { readonly code: string; readonly retryable: boolean } | null = null;
		let finished = false;
		try {
			const events = deps.agent.run(
				{
					runId: input.runId,
					conversationId: input.workspaceId,
					prompt,
					permittedToolIds: [],
					maxToolCalls: 0,
					deadline: new Date(deps.clock.nowMs() + 600_000).toISOString(),
				},
				{
					signal: input.signal,
					scratchDirectory: deps.scratchDirectory,
					model: input.agent.model,
					effort: input.agent.effort,
				},
			);
			for await (const raw of events) {
				const parsed = parseAgentEvent(raw);
				if (!parsed.ok) {
					providerFailure = { code: "AGENT_EVENT_INVALID", retryable: false };
					break;
				}
				const event = parsed.value;
				if (event.type === "text.delta") {
					text += event.text;
					if (text.length > MAX_MODEL_OUTPUT_CHARS) {
						providerFailure = { code: "AGENT_OUTPUT_TOO_LARGE", retryable: false };
						break;
					}
				} else if (event.type === "usage") {
					reportedCost = event.knownCostUsd;
				} else if (event.type === "failed") {
					providerFailure = { code: event.code, retryable: event.retryable };
					break;
				} else if (event.type === "completed") {
					finished = true;
					break;
				}
				// Tool and UI events are ignored: the assistant has no tools.
			}
		} catch (error) {
			// Adapters are contractually non-throwing; treat a throw as a provider failure, not a crash.
			providerFailure = { code: agentThrewCode(error), retryable: true };
		}
		usage = addUsage(usage, { costUsd: reportedCost ?? null });
		await deps.reporter.usage(usage);
		if (input.signal.aborted) return { ok: false, cancelled: true };
		if (providerFailure !== null) {
			return { ok: false, cancelled: false, ...providerFailure };
		}
		if (!finished) {
			return { ok: false, cancelled: false, code: "AGENT_STREAM_ENDED_EARLY", retryable: true };
		}
		return { ok: true, text };
	}

	/** Parses one model reply and pre-applies its commands to the claimed notebook. */
	async function checkTurn(
		text: string,
	): Promise<{ readonly ok: true; readonly value: CheckedTurn } | CheckFailure> {
		const fail = (code: string, message: string): CheckFailure => ({ ok: false, code, message });
		const json = extractJsonObject(text);
		if (!json.ok) {
			return fail(
				"NOTEBOOK_REPLY_INVALID",
				json.error === "NO_JSON_OBJECT"
					? "the reply contained no parseable JSON object."
					: "the reply contained malformed JSON.",
			);
		}
		const parsed = notebookAssistReplySchema.safeParse(json.value);
		if (!parsed.success) {
			const fields = parsed.error.issues
				.slice(0, 6)
				.map((issue) => issue.path.join("."))
				.join(", ");
			return fail(
				"NOTEBOOK_REPLY_INVALID",
				fields === "" ? "the reply is not a reply object." : `invalid reply fields: ${fields}.`,
			);
		}
		const reply = parsed.data.reply.trim();
		if (reply.length === 0) {
			return fail("NOTEBOOK_REPLY_INVALID", "the reply text is empty.");
		}
		if (reply.length > NOTEBOOK_LIMITS.maxReplyChars) {
			return fail(
				"NOTEBOOK_REPLY_INVALID",
				`the reply exceeds ${NOTEBOOK_LIMITS.maxReplyChars} characters.`,
			);
		}
		const existing = new Set(input.notebook.widgets.map((widget) => widget.widgetId));
		const proposedRemovals: string[] = [];
		const rest: unknown[] = [];
		for (const command of parsed.data.commands) {
			if (isJsonObject(command) && command.kind === "remove") {
				const widgetId = command.widgetId;
				if (typeof widgetId !== "string" || widgetId.length === 0) {
					return fail(
						"NOTEBOOK_REPLY_INVALID",
						`invalid command: "widgetId" must be a non-empty string.`,
					);
				}
				if (existing.has(widgetId) && !proposedRemovals.includes(widgetId)) {
					proposedRemovals.push(widgetId);
				}
				continue;
			}
			rest.push(command);
		}
		let counter = 0;
		const applied = await applyNotebookCommands(input.notebook, rest, {
			knownComponentIds: notebookResearchComponentIds(input.notebook),
			newWidgetId: () => {
				counter += 1;
				return `assist-preview-${counter}`;
			},
		});
		if (!applied.ok) {
			return fail(
				applied.error.failure.code,
				`command ${applied.error.index + 1}: ${applied.error.failure.message}`,
			);
		}
		// Commands the turn returns, in the model's order (removals travel separately).
		const commands: JsonObject[] = [];
		for (const [restIndex, command] of rest.entries()) {
			if (!isJsonObject(command)) {
				return fail("INVALID_COMMAND", `command ${restIndex + 1} is not an object.`);
			}
			commands.push(command);
		}
		return { ok: true, value: { reply, commands, proposedRemovals } };
	}

	// The job state machine (proved in Lean) only moves forward one stage at a
	// time, so every stage is reported even where a notebook turn has little
	// to do in it: collecting = reading the claimed notebook into a prompt,
	// analyzing = the model turn, verifying = pre-checking its commands (and
	// the one repair turn), publishing = handing the result to the API.
	await deps.reporter.state("collecting");
	const promptInput = {
		notebook: input.notebook,
		selectedWidgetIds: input.selectedWidgetIds,
		instruction: input.instruction,
		conversationContext: input.conversationContext,
	};
	const firstPrompt = notebookAssistPrompt({
		...promptInput,
		fenceToken: deps.newFenceToken(),
		repairNote: null,
	});
	// Fail closed: never send a prompt over budget.
	if (byteLength(firstPrompt) > NOTEBOOK_PROMPT_BUDGET_BYTES) {
		return failed("NOTEBOOK_PROMPT_TOO_LARGE", false);
	}
	await deps.reporter.state("analyzing");
	const first = await modelTurn(firstPrompt);
	if (!first.ok) {
		return first.cancelled ? { kind: "cancelled", usage } : failed(first.code, first.retryable);
	}
	await deps.reporter.state("verifying");
	const checked = await checkTurn(first.text);
	if (checked.ok) {
		await deps.reporter.state("publishing");
		return assisted(checked.value);
	}
	// One repair turn that states the failure code and message, then give up.
	await deps.reporter.note(
		`The first reply was rejected (${checked.code}); asking for corrected JSON.`,
	);
	if (input.signal.aborted) return { kind: "cancelled", usage };
	const repairPrompt = notebookAssistPrompt({
		...promptInput,
		fenceToken: deps.newFenceToken(),
		repairNote: `${checked.code}: ${checked.message}`,
	});
	if (byteLength(repairPrompt) > NOTEBOOK_PROMPT_BUDGET_BYTES) {
		return failed("NOTEBOOK_PROMPT_TOO_LARGE", false);
	}
	const second = await modelTurn(repairPrompt);
	if (!second.ok) {
		return second.cancelled ? { kind: "cancelled", usage } : failed(second.code, second.retryable);
	}
	const rechecked = await checkTurn(second.text);
	if (rechecked.ok) {
		await deps.reporter.state("publishing");
		return assisted(rechecked.value);
	}
	return failed("NOTEBOOK_REPLY_INVALID", false);
}
