import type {
	AgentAvailability,
	AgentCapabilities,
	AgentDescriptor,
	AgentEvent,
	AgentId,
	AgentRequest,
	CostModel,
	ToolIsolation,
} from "@research/contracts";

export type Effort = "low" | "medium" | "high";

export interface AgentRunContext {
	/** Aborted on cancellation or deadline. Honouring it reliably is the "cancel" capability. */
	readonly signal: AbortSignal;
	/** Per-job scratch directory for CLI backends; null for pure HTTPS backends. */
	readonly scratchDirectory: string | null;
	readonly model: string | null;
	readonly effort: Effort;
}

export interface AgentProbe {
	readonly capabilities: AgentCapabilities;
	readonly availability: AgentAvailability;
}

/**
 * Port every agent backend implements (AGT-001). An adapter exposes only what
 * its provider genuinely supports; the orchestrator negotiates on `probe()`
 * rather than assuming the full common contract.
 */
export interface AgentRuntime {
	readonly agentId: AgentId;
	readonly displayName: string;
	readonly costModel: CostModel;
	readonly toolIsolation: ToolIsolation;
	/** Detects installation/authentication without spending provider quota. */
	probe(): Promise<AgentProbe>;
	/**
	 * Runs one model turn. Must end with exactly one `completed` or `failed`
	 * event and must never throw for provider-side failures.
	 */
	run(request: AgentRequest, context: AgentRunContext): AsyncIterable<AgentEvent>;
}

export interface AgentRegistry {
	readonly get: (agentId: AgentId) => AgentRuntime | undefined;
	readonly ids: () => readonly AgentId[];
	readonly describeAll: () => Promise<readonly AgentDescriptor[]>;
}

/** Registry of backends (ARCH-006): adding one is a new entry here, not a new switch case. */
export function createAgentRegistry(runtimes: readonly AgentRuntime[]): AgentRegistry {
	const byId = new Map<AgentId, AgentRuntime>();
	for (const runtime of runtimes) {
		if (byId.has(runtime.agentId)) throw new Error(`duplicate agent id "${runtime.agentId}"`);
		byId.set(runtime.agentId, runtime);
	}
	return {
		get: (agentId) => byId.get(agentId),
		ids: () => [...byId.keys()],
		describeAll: () =>
			Promise.all(
				[...byId.values()].map(async (runtime) => {
					// One misbehaving backend must not hide the others: a throwing probe is
					// reported as that backend being unavailable.
					const probe = await runtime.probe().catch(
						(error: unknown): AgentProbe => ({
							capabilities: { supported: [] },
							availability: {
								status: "unavailable",
								reasonCode: "PROBE_FAILED",
								detail: error instanceof Error ? error.name : "probe threw",
							},
						}),
					);
					return {
						agentId: runtime.agentId,
						displayName: runtime.displayName,
						capabilities: probe.capabilities,
						costModel: runtime.costModel,
						toolIsolation: runtime.toolIsolation,
						availability: probe.availability,
					};
				}),
			),
	};
}
