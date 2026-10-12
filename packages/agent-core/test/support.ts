import type { AgentCapabilities, AgentEvent } from "@research/contracts";
import { ok, type Result } from "@research/domain";
import { z } from "zod";
import type { AgentProbe, AgentRuntime } from "../src/agentRuntime.ts";
import {
	defineTool,
	EMPTY_TOOL_OUTPUT,
	type ToolContext,
	type ToolDefinition,
	type ToolFailure,
	type ToolOutput,
} from "../src/tools.ts";

export function expectOk<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw new Error(`expected ok, got error ${JSON.stringify(result.error)}`);
	return result.value;
}

export function expectErr<T, E>(result: Result<T, E>): E {
	if (result.ok) throw new Error(`expected an error, got ok ${JSON.stringify(result.value)}`);
	return result.error;
}

export function fakeRuntime(
	agentId: string,
	overrides: Partial<Omit<AgentRuntime, "agentId">> & {
		readonly capabilities?: AgentCapabilities;
	} = {},
): AgentRuntime {
	const { capabilities = { supported: ["stream"] }, ...rest } = overrides;
	const probe: AgentProbe = { capabilities, availability: { status: "available" } };
	return {
		agentId,
		displayName: `Fake ${agentId}`,
		costModel: "plan-limited",
		toolIsolation: "enforced",
		probe: async () => probe,
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "completed" };
		},
		...rest,
	};
}

export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
	let counter = 0;
	return {
		runId: "run_1",
		signal: new AbortController().signal,
		nowIso: () => "2026-10-11T00:00:00.000Z",
		nextId: (prefix) => {
			counter += 1;
			return `run_1_${prefix}${counter}`;
		},
		subscribedSources: [],
		...overrides,
	};
}

export const searchArgsSchema = z.strictObject({
	query: z.string().min(1).max(200),
	limit: z.number().int().min(1).max(20).default(5),
});
export type SearchArgs = z.infer<typeof searchArgsSchema>;

type Execute<Args> = (args: Args, context: ToolContext) => Promise<Result<ToolOutput, ToolFailure>>;

/** A read-only search tool whose behaviour each test supplies. */
export function searchTool(
	execute: Execute<SearchArgs> = async (args) =>
		ok({ ...EMPTY_TOOL_OUTPUT, modelText: `results for ${args.query} (limit ${args.limit})` }),
	overrides: Partial<Pick<ToolDefinition, "toolId" | "timeoutMs">> = {},
): ToolDefinition {
	return defineTool({
		toolId: "news.search",
		version: "1.0.0",
		description: "Searches subscribed news sources.",
		argsSchema: searchArgsSchema,
		argsHint: '{"query": string, "limit"?: number}',
		timeoutMs: 5000,
		permission: "research-read",
		costCategory: "free",
		sideEffect: "external-read",
		networkAllowlist: { kind: "subscribed-sources" },
		execute,
		...overrides,
	});
}

/** Resolves once `signal` aborts (immediately if it already has). */
export function aborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
