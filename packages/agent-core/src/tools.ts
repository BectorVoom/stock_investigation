import type {
	Evidence,
	FinancialObservation,
	IngestedArticle,
	InvestorFiling,
	PositionObservation,
	Security,
	SubscribedSourceRef,
} from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import type { z } from "zod";

/** Evidence plus the full retrieved text, kept in memory only for quote verification. */
export interface CollectedEvidence {
	readonly evidence: Evidence;
	readonly retrievedText: string;
	/**
	 * Whether a verbatim passage from this evidence may be stored with a claim
	 * (DATA-010). False for sources licensed for headline and link only: such
	 * text may be read for verification during the run but is not retained.
	 */
	readonly retainQuotes: boolean;
}

/** Uniform tool output so the orchestrator needs no per-tool knowledge (ARCH-006). */
export interface ToolOutput {
	/** Bounded text shown to the model. It is untrusted data, never instructions. */
	readonly modelText: string;
	readonly evidence: readonly CollectedEvidence[];
	readonly securities: readonly Security[];
	readonly financialObservations: readonly FinancialObservation[];
	readonly positionObservations: readonly PositionObservation[];
	readonly investorFilings: readonly InvestorFiling[];
	readonly articles: readonly IngestedArticle[];
}

export const EMPTY_TOOL_OUTPUT: ToolOutput = {
	modelText: "",
	evidence: [],
	securities: [],
	financialObservations: [],
	positionObservations: [],
	investorFilings: [],
	articles: [],
};

export interface ToolFailure {
	readonly code: string;
	readonly detail: string;
	readonly retryable: boolean;
}

export interface ToolContext {
	readonly runId: string;
	readonly signal: AbortSignal;
	readonly nowIso: () => string;
	/** Allocates a run-scoped id, e.g. `nextId("ev")` -> "<runId>_ev3". */
	readonly nextId: (prefix: string) => string;
	readonly subscribedSources: readonly SubscribedSourceRef[];
}

export type ToolCostCategory = "free" | "rate-limited" | "metered";
export type ToolSideEffect = "none" | "external-read" | "external-read+archive-write";

/** Hosts a tool may contact: a fixed list, the hosts of the owner's subscribed sources, or the public web. */
export type ToolNetworkAllowlist =
	| { readonly kind: "none" }
	| { readonly kind: "hosts"; readonly hosts: readonly string[] }
	| { readonly kind: "subscribed-sources" }
	| { readonly kind: "public-web" };

export interface ToolDefinition<Args = unknown> {
	readonly toolId: string;
	readonly version: string;
	readonly description: string;
	readonly argsSchema: z.ZodType<Args>;
	/** JSON-ish description of the arguments, shown to the model in the tool catalog. */
	readonly argsHint: string;
	readonly timeoutMs: number;
	readonly permission: "research-read";
	readonly costCategory: ToolCostCategory;
	readonly sideEffect: ToolSideEffect;
	readonly networkAllowlist: ToolNetworkAllowlist;
	execute(args: Args, context: ToolContext): Promise<Result<ToolOutput, ToolFailure>>;
}

export interface ToolRegistry {
	readonly get: (toolId: string) => ToolDefinition | undefined;
	readonly list: () => readonly ToolDefinition[];
}

/** Type-erases a tool's argument type; arguments are re-validated on every call. */
export function defineTool<Args>(tool: ToolDefinition<Args>): ToolDefinition {
	return {
		...tool,
		execute: async (args, context) => {
			const parsed = tool.argsSchema.safeParse(args);
			if (!parsed.success) {
				return err({
					code: "INVALID_ARGS",
					detail: "arguments failed validation",
					retryable: false,
				});
			}
			return tool.execute(parsed.data, context);
		},
	};
}

export function createToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
	const byId = new Map<string, ToolDefinition>();
	for (const tool of tools) {
		if (byId.has(tool.toolId)) throw new Error(`duplicate tool id "${tool.toolId}"`);
		byId.set(tool.toolId, tool);
	}
	return { get: (toolId) => byId.get(toolId), list: () => [...byId.values()] };
}

export type ToolDenialCode =
	| "UNKNOWN_TOOL"
	| "TOOL_NOT_PERMITTED"
	| "INVALID_ARGS"
	| "TOOL_CALL_BUDGET_EXHAUSTED";

export interface AuthorizedToolCall {
	readonly tool: ToolDefinition;
	readonly args: unknown;
}

export interface ToolPolicy {
	readonly permittedToolIds: ReadonlySet<string>;
	readonly remainingToolCalls: number;
}

/**
 * Authorization happens here, outside the model (AGT-006). Whatever text a
 * model or a fetched article contains, a call runs only if the tool is
 * registered, on this run's allowlist, within budget and schema-valid.
 */
export function authorizeToolCall(
	registry: ToolRegistry,
	policy: ToolPolicy,
	request: { readonly toolId: string; readonly args: unknown },
): Result<AuthorizedToolCall, ToolDenialCode> {
	const tool = registry.get(request.toolId);
	if (tool === undefined) return err("UNKNOWN_TOOL");
	if (!policy.permittedToolIds.has(request.toolId)) return err("TOOL_NOT_PERMITTED");
	if (policy.remainingToolCalls <= 0) return err("TOOL_CALL_BUDGET_EXHAUSTED");
	const parsed = tool.argsSchema.safeParse(request.args);
	if (!parsed.success) return err("INVALID_ARGS");
	return ok({ tool, args: parsed.data });
}

/**
 * Runs an authorized call under the tool's own timeout, translating throws into
 * failures. The timeout is enforced by racing, not by trusting the tool to
 * honour its abort signal: a tool that ignores the signal still cannot stall
 * the run (AGT-008). Its abandoned promise is left to settle on its own.
 */
export async function executeToolCall(
	call: AuthorizedToolCall,
	context: ToolContext,
): Promise<Result<ToolOutput, ToolFailure>> {
	const timeout = AbortSignal.timeout(call.tool.timeoutMs);
	const signal = AbortSignal.any([context.signal, timeout]);
	const stopped = new Promise<Result<ToolOutput, ToolFailure>>((resolve) => {
		const onAbort = () =>
			resolve(
				err(
					timeout.aborted
						? { code: "TOOL_TIMEOUT", detail: "tool exceeded its time limit", retryable: true }
						: { code: "TOOL_ABORTED", detail: "run was cancelled", retryable: false },
				),
			);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	const execution = (async (): Promise<Result<ToolOutput, ToolFailure>> => {
		try {
			return await call.tool.execute(call.args, { ...context, signal });
		} catch (error) {
			// Adapters should return typed failures; a throw is unexpected and is reported, not hidden.
			const detail = error instanceof Error ? error.name : "unknown error";
			return err({
				code: timeout.aborted ? "TOOL_TIMEOUT" : "TOOL_THREW",
				detail,
				retryable: timeout.aborted,
			});
		}
	})();
	return Promise.race([execution, stopped]);
}
