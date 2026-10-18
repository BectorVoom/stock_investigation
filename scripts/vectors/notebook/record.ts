/** Records the whole production turn against the caller's existing scripted fakes. */

import { appendFileSync } from "node:fs";
import type {
	NotebookAssistTurnDeps,
	NotebookAssistTurnInput,
	runNotebookAssistTurn,
} from "../../../packages/application/src/notebook/assistTurn.ts";
import { doubleBits } from "../shared.ts";

/**
 * Appends one captured case. Callers that generate many huge notebooks pass
 * `NOTEBOOK_SKIP_OVER_BYTES` so a case above that size is dropped: the whole-turn
 * transcript already pins its outcome and the vector files stay small.
 */
export function save(value: unknown): void {
	const target = process.env.NOTEBOOK_CAPTURE_FILE;
	if (target === undefined) throw new Error("NOTEBOOK_CAPTURE_FILE is required");
	const line = JSON.stringify(encodeNumbers(value));
	const limit = Number(process.env.NOTEBOOK_SKIP_OVER_BYTES ?? Number.POSITIVE_INFINITY);
	if (
		typeof value === "object" &&
		value !== null &&
		"area" in value &&
		value.area === "commands" &&
		line.length > limit
	)
		return;
	appendFileSync(target, `${line}\n`);
}

export async function recordTurn(
	input: NotebookAssistTurnInput,
	deps: NotebookAssistTurnDeps,
	real: typeof runNotebookAssistTurn,
) {
	const { signal, ...job } = input;
	const calls: unknown[] = [];
	const turns: { events: unknown[]; aborted: boolean; threw?: string }[] = [];
	const fences: string[] = [];
	const clocks: number[] = [];
	let probe: unknown = null;
	const preAborted = signal.aborted;
	const cancelAfterCalls: number[] = [];
	const markCancellation = () => {
		if (signal.aborted) cancelAfterCalls.push(calls.length);
	};
	const reporter = deps.reporter;
	const wrapped: NotebookAssistTurnDeps = {
		...deps,
		newFenceToken: () => {
			const token = deps.newFenceToken();
			fences.push(token);
			calls.push({ fence: token });
			return token;
		},
		clock: {
			...deps.clock,
			nowMs: () => {
				const ms = deps.clock.nowMs();
				clocks.push(ms);
				calls.push({ clock: ms });
				return ms;
			},
		},
		reporter: {
			state: async (state) => {
				calls.push({ state });
				await reporter.state(state);
				markCancellation();
			},
			note: async (note) => {
				calls.push({ note });
				await reporter.note(note);
				markCancellation();
			},
			usage: async (usage) => {
				calls.push({ usage });
				await reporter.usage(usage);
				markCancellation();
			},
			tool: async (toolId, outcome, detail) => {
				calls.push({ toolId, outcome, detail });
				await reporter.tool(toolId, outcome, detail);
			},
		},
		agent: {
			...deps.agent,
			probe: async () => {
				const result = await deps.agent.probe();
				probe = result;
				calls.push({ probe: result });
				return result;
			},
			async *run(request, context) {
				calls.push({
					request,
					context: {
						scratchDirectory: context.scratchDirectory,
						model: context.model,
						effort: context.effort,
					},
				});
				const turn: { events: unknown[]; aborted: boolean; threw?: string } = {
					events: [],
					aborted: false,
				};
				turns.push(turn);
				try {
					for await (const event of deps.agent.run(request, context)) {
						turn.events.push(event);
						yield event;
					}
				} catch (error) {
					turn.threw = error instanceof Error ? error.name : "unknown";
					throw error;
				} finally {
					turn.aborted = signal.aborted;
				}
			},
		},
	};
	const output = await real(input, wrapped);
	save({
		area: "turn",
		input: {
			job,
			preAborted,
			cancelAfterCalls,
			isolation: deps.agent.toolIsolation,
			probe,
			turns,
			fences,
			clocks,
			scratchDirectory: deps.scratchDirectory,
		},
		output: { calls, outcome: output },
	});
	return output;
}

/** Capture bits before JSON.stringify can erase -0, NaN or Infinity. */
export function encodeNumbers(value: unknown): unknown {
	if (typeof value === "number") return { $doubleBits: doubleBits(value) };
	if (Array.isArray(value)) return value.map((entry: unknown) => encodeNumbers(entry));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]: [string, unknown]) => [key, encodeNumbers(entry)]),
		);
	return value;
}
