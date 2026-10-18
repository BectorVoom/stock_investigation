/**
 * Scripted collaborators shared by the generated and the targeted pipeline
 * scenarios: an agent whose turns can abort the run between events or throw,
 * and a clock the scenario can advance.
 */
import type { AgentProbe, AgentRunContext, AgentRuntime } from "@research/agent-core";
import type {
	AgentAvailability,
	AgentEvent,
	AgentRequest,
	CostModel,
	ToolIsolation,
} from "@research/contracts";

/** What a scripted turn does. */
export interface TurnScript {
	readonly events: readonly AgentEvent[];
	/** Abort the run while producing event `abortAfter` (0 = before the first event). */
	readonly abortAfter?: number;
	/** Throw an error named "Panic" after the events (the Rust adapter panics). */
	readonly throws?: boolean;
}

/** The error name the Rust port maps every adapter panic to (ADR-0030). */
export class AgentPanic extends Error {
	override name = "Panic";
}

/** A tool failure thrown as the Rust tools panic: detail "panic". */
export class ToolPanic extends Error {
	override name = "panic";
}

export function textTurn(text: string, extra: readonly AgentEvent[] = []): TurnScript {
	const middle = Array.from(text).length >> 1;
	const points = Array.from(text);
	return {
		events: [
			{ type: "text.delta", text: points.slice(0, middle).join("") },
			{ type: "text.delta", text: points.slice(middle).join("") },
			...extra,
			{ type: "completed" },
		],
	};
}

export interface WorldAgentOptions {
	readonly costModel?: CostModel;
	readonly toolIsolation?: ToolIsolation;
	readonly availability?: AgentAvailability;
	readonly controller: AbortController;
	readonly script: (request: AgentRequest, turnIndex: number) => TurnScript | string;
}

export function worldAgent(options: WorldAgentOptions): AgentRuntime {
	let turnIndex = 0;
	return {
		agentId: "scripted",
		displayName: "Scripted world agent",
		costModel: options.costModel ?? "plan-limited",
		toolIsolation: options.toolIsolation ?? "enforced",
		async probe(): Promise<AgentProbe> {
			return {
				capabilities: { supported: ["stream"] },
				availability: options.availability ?? { status: "available" },
			};
		},
		async *run(request: AgentRequest, _context: AgentRunContext): AsyncIterable<AgentEvent> {
			const scripted = options.script(request, turnIndex++);
			const turn = typeof scripted === "string" ? textTurn(scripted) : scripted;
			for (const [index, event] of turn.events.entries()) {
				if (turn.abortAfter === index) options.controller.abort();
				yield event;
			}
			if (turn.abortAfter !== undefined && turn.abortAfter >= turn.events.length) {
				options.controller.abort();
			}
			if (turn.throws === true) throw new AgentPanic("adapter failed");
		},
	};
}
