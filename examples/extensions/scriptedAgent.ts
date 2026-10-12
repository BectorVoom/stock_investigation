import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import type {
	AgentAvailability,
	AgentEvent,
	AgentRequest,
	CostModel,
	ToolIsolation,
} from "@research/contracts";

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
