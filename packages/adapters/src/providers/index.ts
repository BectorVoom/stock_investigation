import type { AgentRuntime } from "@research/agent-core";
import { createClaudeCodeRuntime } from "./claudeCode.ts";
import { createCodexRuntime } from "./codex.ts";
import type { ProviderEnvironment } from "./environment.ts";
import { createOpenCodeRuntime } from "./openCode.ts";
import { createOpenRouterRuntime } from "./openRouter.ts";

export { createClaudeCodeRuntime } from "./claudeCode.ts";
export { createCodexRuntime } from "./codex.ts";
export type { ProviderEnvironment } from "./environment.ts";
export { createOpenCodeRuntime, type OpenCodeRuntimeOptions } from "./openCode.ts";
export { createOpenRouterRuntime } from "./openRouter.ts";
export {
	createNodeProcessRunner,
	type NodeProcessRunnerOptions,
	type ProcessExit,
	type ProcessHandle,
	type ProcessRunner,
	type ProcessSpec,
	type SpawnedChild,
	type TerminationSignal,
} from "./processRunner.ts";
export { PROVIDER_FAILURES, type ProviderFailure } from "./turn.ts";

/**
 * The four V1 backends in BASELINE_AGENT_IDS order. Each is prompt in, text
 * out: the orchestrator mediates every tool itself, so no adapter emits
 * `tool.request`, `tool.result` or `ui.command` or claims `tool-calls`.
 */
export function createBaselineAgentRuntimes(
	environment: ProviderEnvironment,
): readonly AgentRuntime[] {
	return [
		createOpenCodeRuntime(environment),
		createCodexRuntime(environment),
		createClaudeCodeRuntime(environment),
		createOpenRouterRuntime(environment),
	];
}
