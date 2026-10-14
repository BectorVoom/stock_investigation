import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import type {
	AgentAvailability,
	AgentEvent,
	AgentRequest,
	CostModel,
	ToolIsolation,
} from "@research/contracts";
import {
	NOTEBOOK_ASSIST_TURN_MARKER,
	SELECTED_WIDGET_IDS_PREFIX,
} from "../../packages/application/src/notebook/prompts.ts";

/**
 * Example agent backend: replays scripted replies instead of calling a model.
 *
 * It exists for two reasons. It is the worked example for FR-013 — a new
 * backend is one object implementing `AgentRuntime`, registered at a
 * composition root, with no change to the orchestrator. And it makes the
 * pipeline, runner and browser tests deterministic. It is NOT a research
 * source: nothing it "says" is real data.
 */
export type ScriptedReply = string | readonly AgentEvent[];

export interface ScriptedAgentOptions {
	readonly agentId?: string;
	readonly costModel?: CostModel;
	readonly toolIsolation?: ToolIsolation;
	readonly availability?: AgentAvailability;
	/** Model ids reported as `capabilities.models`, as the OpenCode probe does. */
	readonly models?: readonly string[];
	/** Produces the reply for the n-th turn (0-based) of this agent instance. */
	readonly reply: (
		request: AgentRequest,
		turnIndex: number,
	) => ScriptedReply | Promise<ScriptedReply>;
	/** Cost reported per turn; omit to report nothing (an unknown cost). */
	readonly costPerTurnUsd?: number | null;
}

export interface ScriptedAgent extends AgentRuntime {
	/** Every request the agent received, for assertions. */
	readonly requests: readonly AgentRequest[];
	readonly contexts: readonly AgentRunContext[];
}

/** The instruction of a notebook-assistant prompt, lower-cased (the whole prompt when unfenced). */
function notebookInstruction(prompt: string): string {
	// The token is bound on both markers, so a forged marker inside fenced
	// data (whose token was stripped when fenced) can never match.
	const fenced = /<<<([^>\n]+?) instruction —[^\n]*>>>\r?\n([\s\S]*?)\r?\n<<<end \1>>>/.exec(
		prompt,
	)?.[2];
	return (fenced ?? prompt).toLowerCase();
}

/** Selected widget ids read back from the `Selected widget ids: [...]` prompt line. */
function notebookSelectedIds(prompt: string): string[] {
	const line = prompt
		.split("\n")
		.find((candidate) => candidate.startsWith(SELECTED_WIDGET_IDS_PREFIX));
	if (line === undefined) return [];
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(line.slice(SELECTED_WIDGET_IDS_PREFIX.length).trim()) as unknown;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((entry): entry is string => typeof entry === "string");
}

/** Grid positions read back from the `position N: {... "widgetId": "..." ...}` widget lines. */
function notebookPositions(prompt: string): Map<string, number> {
	const positions = new Map<string, number>();
	const pattern = /position (\d+):[^\n]*?"widgetId"\s*:\s*"([^"]*)"/g;
	for (let match = pattern.exec(prompt); match !== null; match = pattern.exec(prompt)) {
		const position = Number.parseInt(match[1] ?? "", 10);
		const widgetId = match[2] ?? "";
		if (Number.isInteger(position) && widgetId !== "" && !positions.has(widgetId)) {
			positions.set(widgetId, position);
		}
	}
	return positions;
}

/**
 * Deterministic reply for a notebook-assistant prompt (ADR-0020). The FIRST
 * rule whose phrase the (lower-cased) instruction contains wins:
 *
 * | instruction contains | reply | commands |
 * | `chart` | `Added a revenue chart.` | `add` a line `chart` titled `Revenue` |
 * | `larger` | `Made it larger.` | `resize` every selected id to `large` |
 * | `explain` | `Added an explanation.` | `add` a `text` explanation after the first selected widget |
 * | `bar` | `Switched to a bar chart.` | `update` every selected id with `{ chartType: "bar" }` |
 * | `duplicate` | `Duplicated it.` | `duplicate` every selected id |
 * | `remove` | `Proposed removing it.` | `remove` every selected id |
 * | anything else | `Noted.` | none |
 */
function scriptedNotebookAssistReply(prompt: string): string {
	const instruction = notebookInstruction(prompt);
	const selected = notebookSelectedIds(prompt);
	const positions = notebookPositions(prompt);
	const answer = (reply: string, commands: readonly unknown[]): string =>
		JSON.stringify({ reply, commands });
	if (instruction.includes("chart")) {
		return answer("Added a revenue chart.", [
			{
				kind: "add",
				type: "chart",
				title: "Revenue",
				config: {
					chartType: "line",
					unit: "USD",
					series: [
						{
							name: "Revenue",
							points: [
								{ x: "2022", y: 10 },
								{ x: "2023", y: 12 },
								{ x: "2024", y: 15 },
							],
						},
					],
				},
			},
		]);
	}
	if (instruction.includes("larger")) {
		return answer(
			"Made it larger.",
			selected.map((widgetId) => ({ kind: "resize", widgetId, size: "large" })),
		);
	}
	if (instruction.includes("explain")) {
		const first = selected[0];
		const position = first === undefined ? undefined : positions.get(first);
		return answer("Added an explanation.", [
			{
				kind: "add",
				type: "text",
				title: "Explanation",
				config: { text: "Revenue rises from 10 to 15 over three years." },
				...(position === undefined ? {} : { toIndex: position + 1 }),
			},
		]);
	}
	if (instruction.includes("bar")) {
		return answer(
			"Switched to a bar chart.",
			selected.map((widgetId) => ({ kind: "update", widgetId, config: { chartType: "bar" } })),
		);
	}
	if (instruction.includes("duplicate")) {
		return answer(
			"Duplicated it.",
			selected.map((widgetId) => ({ kind: "duplicate", widgetId })),
		);
	}
	if (instruction.includes("remove")) {
		return answer(
			"Proposed removing it.",
			selected.map((widgetId) => ({ kind: "remove", widgetId })),
		);
	}
	return answer("Noted.", []);
}

export function createScriptedAgent(options: ScriptedAgentOptions): ScriptedAgent {
	const requests: AgentRequest[] = [];
	const contexts: AgentRunContext[] = [];
	return {
		agentId: options.agentId ?? "scripted",
		displayName: "Scripted example agent",
		costModel: options.costModel ?? "plan-limited",
		toolIsolation: options.toolIsolation ?? "enforced",
		requests,
		contexts,
		async probe(): Promise<AgentProbe> {
			return {
				capabilities: {
					supported: ["stream"],
					...(options.models === undefined ? {} : { models: [...options.models] }),
				},
				availability: options.availability ?? { status: "available" },
			};
		},
		async *run(request: AgentRequest, context: AgentRunContext): AsyncIterable<AgentEvent> {
			const turnIndex = requests.length;
			requests.push(request);
			contexts.push(context);
			if (request.prompt.startsWith(NOTEBOOK_ASSIST_TURN_MARKER)) {
				const notebookReply = scriptedNotebookAssistReply(request.prompt);
				const middle = Math.floor(notebookReply.length / 2);
				yield { type: "text.delta", text: notebookReply.slice(0, middle) };
				yield { type: "text.delta", text: notebookReply.slice(middle) };
				if (options.costPerTurnUsd !== undefined) {
					yield { type: "usage", knownCostUsd: options.costPerTurnUsd };
				}
				yield { type: "completed" };
				return;
			}
			const reply = await options.reply(request, turnIndex);
			if (typeof reply !== "string") {
				yield* reply;
				return;
			}
			// Split in two so consumers are exercised with more than one delta.
			const middle = Math.floor(reply.length / 2);
			yield { type: "text.delta", text: reply.slice(0, middle) };
			yield { type: "text.delta", text: reply.slice(middle) };
			if (options.costPerTurnUsd !== undefined) {
				yield { type: "usage", knownCostUsd: options.costPerTurnUsd };
			}
			yield { type: "completed" };
		},
	};
}
