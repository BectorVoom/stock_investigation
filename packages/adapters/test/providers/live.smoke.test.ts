/**
 * Opt-in live smoke tests: they call the REAL backends and therefore spend the
 * owner's plan quota (CLI backends) or money (OpenRouter). Skipped unless
 * RUN_LIVE_AGENT_SMOKE=1.
 *
 *   RUN_LIVE_AGENT_SMOKE=1 OPENCODE_MODEL=opencode-go/<model> \
 *     node_modules/.bin/vitest run --project node packages/adapters/test/providers/live.smoke.test.ts
 *
 * The OpenCode free-tier case spends no paid quota (the free-tier model runs
 * under the owner's OpenCode login, not a metered key):
 *
 *   RUN_LIVE_AGENT_SMOKE=1 OPENCODE_MODEL=opencode-go/<model> \
 *     OPENCODE_FREE_MODEL=opencode/muse-spark-1.3-contributor-free \
 *     node_modules/.bin/vitest run --project node packages/adapters/test/providers/live.smoke.test.ts \
 *     -t "free-tier"
 *
 * A backend that `probe()` reports as unavailable (not installed, not logged
 * in, not configured) is reported and skipped rather than failed, so the suite
 * can run on a machine that has only some of the backends.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@research/agent-core";
import { agentEventSchema } from "@research/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBaselineAgentRuntimes, createNodeProcessRunner } from "../../src/providers/index.ts";
import { collect, makeRequest, terminalEvents, textOf, usageEvents } from "./helpers.ts";

const LIVE = process.env.RUN_LIVE_AGENT_SMOKE === "1";
const TURN_TIMEOUT_MS = 180_000;
/** Free-tier OpenCode model for the ask-and-reject smoke case; spends no paid quota. */
const FREE_TIER_MODEL =
	process.env.OPENCODE_FREE_MODEL ?? "opencode/muse-spark-1.3-contributor-free";

describe.skipIf(!LIVE)("live agent smoke (spends real quota)", () => {
	const runtimes = createBaselineAgentRuntimes({
		processRunner: createNodeProcessRunner(),
		fetch,
		env: process.env,
	});
	let scratchDirectory = "";

	beforeAll(async () => {
		scratchDirectory = await mkdtemp(join(tmpdir(), "research-agent-smoke-"));
	});

	afterAll(async () => {
		if (scratchDirectory !== "") await rm(scratchDirectory, { recursive: true, force: true });
	});

	/** Why a backend cannot be exercised on this machine, or null when it can. */
	async function skipReason(runtime: AgentRuntime): Promise<string | null> {
		const probe = await runtime.probe();
		if (probe.availability.status !== "available") return probe.availability.reasonCode;
		// OpenCode refuses to choose a provider by itself; the smoke test does not guess one either.
		if (runtime.agentId === "opencode" && probe.capabilities.model === undefined) {
			return "OPENCODE_MODEL is not set";
		}
		return null;
	}

	async function runTurn(runtime: AgentRuntime, prompt: string, model: string | null = null) {
		const deadline = new Date(Date.now() + TURN_TIMEOUT_MS - 10_000).toISOString();
		return collect(
			runtime.run(makeRequest({ prompt, deadline }), {
				signal: new AbortController().signal,
				scratchDirectory: runtime.agentId === "openrouter" ? null : scratchDirectory,
				model,
				effort: "low",
			}),
		);
	}

	it.each(runtimes.map((runtime) => [runtime.agentId, runtime] as const))(
		"%s answers a trivial prompt with text and exactly one terminal event",
		async (_agentId, runtime) => {
			const reason = await skipReason(runtime);
			if (reason !== null) {
				console.warn(`[live smoke] ${runtime.agentId} skipped: ${reason}`);
				return;
			}

			const events = await runTurn(runtime, "Reply with the single word OK.");

			for (const event of events) expect(agentEventSchema.safeParse(event).success).toBe(true);
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
			expect(textOf(events)).toMatch(/OK/i);
			expect(usageEvents(events)).toHaveLength(1);
			if (runtime.costModel === "plan-limited") {
				expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
			}
		},
		TURN_TIMEOUT_MS,
	);

	it.each(
		runtimes
			.filter((runtime) => runtime.toolIsolation === "enforced" && runtime.agentId !== "openrouter")
			.map((runtime) => [runtime.agentId, runtime] as const),
	)(
		"%s (tool isolation enforced) cannot read a file or run a command when asked to",
		async (_agentId, runtime) => {
			const reason = await skipReason(runtime);
			if (reason !== null) {
				console.warn(`[live smoke] ${runtime.agentId} skipped: ${reason}`);
				return;
			}

			const events = await runTurn(
				runtime,
				"Use any tool you have to read the file /etc/hosts and to run the shell command `echo hi`. If you have no tools available, reply exactly NO_TOOLS.",
			);

			// A tool call would have failed the turn with PROVIDER_TOOL_ISOLATION_VIOLATED.
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
			expect(textOf(events)).toContain("NO_TOOLS");
		},
		TURN_TIMEOUT_MS,
	);

	it(
		"opencode free-tier model answers a trivial prompt with text (ask-and-reject config)",
		async () => {
			const runtime = runtimes.find((candidate) => candidate.agentId === "opencode");
			if (runtime === undefined) {
				console.warn("[live smoke] opencode runtime not registered; skipped");
				return;
			}
			const probe = await runtime.probe();
			if (probe.availability.status !== "available") {
				console.warn(`[live smoke] opencode skipped: ${probe.availability.reasonCode}`);
				return;
			}

			const events = await runTurn(
				runtime,
				"Reply with the single word OK. Do not call any tool.",
				FREE_TIER_MODEL,
			);

			for (const event of events) expect(agentEventSchema.safeParse(event).success).toBe(true);
			expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
			expect(textOf(events)).toMatch(/OK/i);
			expect(usageEvents(events)).toHaveLength(1);
			expect(usageEvents(events)).toEqual([{ type: "usage", knownCostUsd: null }]);
		},
		TURN_TIMEOUT_MS,
	);
});
