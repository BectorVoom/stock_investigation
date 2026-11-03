import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import type {
	AgentAvailability,
	AgentEvent,
	AgentRequest,
	CostModel,
	ToolIsolation,
} from "@research/contracts";
import { COMPANY_SUMMARY_TURN_MARKER } from "../../packages/application/src/companySummaryTurn.ts";
import { NOTEBOOK_ASSIST_TURN_MARKER } from "../../packages/application/src/notebook/prompts.ts";

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

/**
 * The widgets the instruction names: every widget whose title (compared
 * lower-cased) appears in the instruction, in notebook order, read back from
 * the `position N: {...}` widget lines.
 */
function notebookNamedIds(prompt: string, instruction: string): string[] {
	const named: string[] = [];
	const pattern = /^position \d+: (\{.*\})$/gm;
	for (let match = pattern.exec(prompt); match !== null; match = pattern.exec(prompt)) {
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(match[1] ?? "") as unknown;
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const widgetId = "widgetId" in parsed ? parsed.widgetId : undefined;
		const title = "title" in parsed ? parsed.title : undefined;
		if (typeof widgetId !== "string" || typeof title !== "string" || title.trim() === "") continue;
		if (instruction.includes(title.trim().toLowerCase()) && !named.includes(widgetId)) {
			named.push(widgetId);
		}
	}
	return named;
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
 * rule whose phrase the (lower-cased) instruction contains wins; "named"
 * widgets are those whose title the instruction contains:
 *
 * | instruction contains | reply | commands |
 * | `gold` | `Added a gold price chart.` | `add` a `line-chart` titled `Gold price, past year` |
 * | `chart` | `Added a revenue chart.` | `add` a line `chart` titled `Revenue` |
 * | `larger` | `Made it larger.` | `resize` every named widget to `large` |
 * | `explain` | `Added an explanation.` | `add` a `text` explanation after the first named widget |
 * | `bar` | `Switched to a bar chart.` | `update` every named widget with `{ chartType: "bar" }` |
 * | `duplicate` | `Duplicated it.` | `duplicate` every named widget |
 * | `remove` | `Proposed removing it.` | `remove` every named widget |
 * | anything else | `Noted.` | none |
 */
function scriptedNotebookAssistReply(prompt: string): string {
	const instruction = notebookInstruction(prompt);
	const named = notebookNamedIds(prompt, instruction);
	const positions = notebookPositions(prompt);
	const answer = (reply: string, commands: readonly unknown[]): string =>
		JSON.stringify({ reply, commands });
	if (instruction.includes("gold")) {
		return answer("Added a gold price chart.", [
			{
				kind: "add",
				type: "line-chart",
				title: "Gold price, past year",
				size: "medium",
				config: { seriesIds: ["twelve-data:XAU/USD"], range: "1y" },
			},
		]);
	}
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
			named.map((widgetId) => ({ kind: "resize", widgetId, size: "large" })),
		);
	}
	if (instruction.includes("explain")) {
		const first = named[0];
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
			named.map((widgetId) => ({ kind: "update", widgetId, config: { chartType: "bar" } })),
		);
	}
	if (instruction.includes("duplicate")) {
		return answer(
			"Duplicated it.",
			named.map((widgetId) => ({ kind: "duplicate", widgetId })),
		);
	}
	if (instruction.includes("remove")) {
		return answer(
			"Proposed removing it.",
			named.map((widgetId) => ({ kind: "remove", widgetId })),
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
			if (request.prompt.startsWith(COMPANY_SUMMARY_TURN_MARKER)) {
				// ADR-0060: a fixed summary naming the stock the prompt asks about.
				const stockLine = request.prompt.split("\n").find((line) => line.startsWith("Stock: "));
				const stockId = stockLine?.slice("Stock: ".length) ?? "the stock";
				yield {
					type: "text.delta",
					text: JSON.stringify({
						description: {
							en: `Scripted summary of ${stockId}.`,
							ja: `${stockId} のスクリプト要約です。`,
						},
						themes: [{ en: "Scripted theme", ja: "スクリプトのテーマ" }],
					}),
				};
				yield { type: "completed" };
				return;
			}
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
