import type { AgentRuntime } from "@research/agent-core";
import { createClaudeApiRuntime } from "./claudeApi.ts";
import { createClaudeCodeRuntime } from "./claudeCode.ts";
import { createCodexRuntime } from "./codex.ts";
import type { ProviderEnvironment } from "./environment.ts";
import { createGeminiApiRuntime } from "./geminiApi.ts";
import { createOpenCodeRuntime } from "./openCode.ts";
import { createOpenRouterFreeRuntime, createOpenRouterRuntime } from "./openRouter.ts";
import { createSarashinaApiRuntime } from "./sarashinaApi.ts";

export {
	CLAUDE_API_MESSAGES_URL,
	CLAUDE_API_MODELS,
	CLAUDE_API_VERSION,
	type ClaudeUsage,
	claudeCostUsd,
	claudeModel,
	createClaudeApiRuntime,
} from "./claudeApi.ts";
export { createClaudeCodeRuntime } from "./claudeCode.ts";
export { createCodexRuntime } from "./codex.ts";
export type { ProviderEnvironment } from "./environment.ts";
export {
	buildGeminiRequestBody,
	createGeminiApiRuntime,
	GEMINI_API_DEFAULT_MODEL,
	GEMINI_API_MODELS,
	GEMINI_CHAT_COMPLETIONS_URL,
	GEMINI_MAX_COMPLETION_TOKENS,
	resolveGeminiModel,
} from "./geminiApi.ts";
export { createOpenCodeRuntime, type OpenCodeRuntimeOptions } from "./openCode.ts";
export { createOpenRouterFreeRuntime, createOpenRouterRuntime } from "./openRouter.ts";
export {
	createFreeModelCatalog,
	type FreeModelCatalog,
	OPENROUTER_MODELS_URL,
} from "./openRouterModels.ts";
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
export {
	buildSarashinaRequestBody,
	createSarashinaApiRuntime,
	isSarashinaThinkingModel,
	SARASHINA_API_DEFAULT_MODEL,
	SARASHINA_API_MODELS,
	SARASHINA_CHAT_COMPLETIONS_URL,
	SARASHINA_MAX_COMPLETION_TOKENS,
} from "./sarashinaApi.ts";
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

/** Baseline backends plus the OpenRouter free-models, Claude API, Sarashina API and Gemini API backends. */
export function createAgentRuntimes(environment: ProviderEnvironment): readonly AgentRuntime[] {
	return [
		...createBaselineAgentRuntimes(environment),
		createOpenRouterFreeRuntime(environment),
		createClaudeApiRuntime(environment),
		createSarashinaApiRuntime(environment),
		createGeminiApiRuntime(environment),
	];
}
