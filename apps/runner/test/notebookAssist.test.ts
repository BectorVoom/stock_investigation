import { type AgentRunContext, createAgentRegistry } from "@research/agent-core";
import { type ClaimedJob, completeJobRequestSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	chartWidget,
	notebookFixture,
	textWidget,
} from "../../../packages/application/test/support.ts";
import { executeJob } from "../src/jobExecution.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;

function notebookJob(
	overrides: Partial<Extract<ClaimedJob, { kind: "notebook-assist" }>> = {},
): Extract<ClaimedJob, { kind: "notebook-assist" }> {
	return {
		kind: "notebook-assist",
		runId: "run_notebook",
		leaseGeneration: 3,
		leaseExpiresAt: "2026-10-11T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		workspaceId: "ws_test",
		agent: { agentId: "scripted", model: null, effort: "medium" },
		instruction: "Please add a chart.",
		selectedWidgetIds: [],
		notebook: notebookFixture([textWidget("w-text", "Body of w-text."), chartWidget("w-chart")]),
		notebookVersion: 7,
		conversationContext: [],
		...overrides,
	};
}

function stateSequence(
	events: { events: { seq: number; event: { type: string; state?: string } }[] }[],
) {
	return events
		.flatMap((request) => request.events)
		.filter((entry) => entry.event.type === "state")
		.map((entry) => entry.event.state);
}

describe("notebook-assist jobs (ADR-0020)", () => {
	it("completes notebook-assisted with the claimed base version", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(notebookJob(), harness.deps, never);

		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(calls.completions).toHaveLength(1);
		const completion = calls.completions[0];
		expect(completeJobRequestSchema.safeParse(completion).success).toBe(true);
		expect(completion).toMatchObject({
			outcome: "notebook-assisted",
			leaseGeneration: 3,
			baseVersion: 7,
			reply: "Added a revenue chart.",
			proposedRemovals: [],
		});
		if (completion?.outcome !== "notebook-assisted") throw new Error("expected assistance");
		expect(completion.commands).toHaveLength(1);
		expect(completion.usage).toMatchObject({ agentSteps: 1 });
		expect(harness.scratch.created).toEqual(["/scratch/run_notebook"]);
		expect(harness.scratch.removed).toEqual(["/scratch/run_notebook"]);
		expect(harness.timers.every((timer) => timer.stopped)).toBe(true);
	});

	it("hands the agent the job's own scratch directory", async () => {
		// The real OpenCode adapter refuses to start without one
		// (SCRATCH_DIRECTORY_REQUIRED); the scripted agent does not care, so
		// only this check catches a turn that forgets to pass it.
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const scripted = harness.deps.agents.get("scripted");
		if (scripted === undefined) throw new Error("the scripted agent is not registered");
		const contexts: AgentRunContext[] = [];
		const recording = {
			...scripted,
			run: (request: Parameters<typeof scripted.run>[0], context: AgentRunContext) => {
				contexts.push(context);
				return scripted.run(request, context);
			},
		};
		await executeJob(
			notebookJob(),
			{ ...harness.deps, agents: createAgentRegistry([recording]) },
			never,
		);
		expect(calls.completions[0]?.outcome).toBe("notebook-assisted");
		expect(contexts.map((context) => context.scratchDirectory)).toEqual(["/scratch/run_notebook"]);
	});

	it("returns removals as proposals without commands", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			notebookJob({ instruction: "Remove it.", selectedWidgetIds: ["w-text"] }),
			harness.deps,
			never,
		);
		const completion = calls.completions[0];
		expect(completion).toMatchObject({
			outcome: "notebook-assisted",
			reply: "Proposed removing it.",
			commands: [],
			proposedRemovals: ["w-text"],
		});
	});

	it("passes duplicate commands through for the API to apply", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			notebookJob({ instruction: "Duplicate it.", selectedWidgetIds: ["w-text"] }),
			harness.deps,
			never,
		);
		const completion = calls.completions[0];
		expect(completion).toMatchObject({
			outcome: "notebook-assisted",
			reply: "Duplicated it.",
			proposedRemovals: [],
		});
		if (completion?.outcome !== "notebook-assisted") throw new Error("expected assistance");
		expect(completion.commands).toEqual([{ kind: "duplicate", widgetId: "w-text" }]);
	});

	it("fails without retry when the backend is not registered", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			notebookJob({ agent: { agentId: "codex", model: null, effort: "medium" } }),
			harness.deps,
			never,
		);
		expect(calls.completions).toEqual([
			expect.objectContaining({
				outcome: "failed",
				failureCode: "AGENT_NOT_REGISTERED",
				retryable: false,
			}),
		]);
		expect(harness.agent.requests).toHaveLength(0);
	});

	it("fails closed when the prompt would exceed its byte budget", async () => {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const widgets = Array.from({ length: 40 }, (_, index) =>
			textWidget(`w-${index}`, "y".repeat(8000)),
		);
		await executeJob(
			notebookJob({
				notebook: notebookFixture(widgets),
				selectedWidgetIds: widgets.map((widget) => widget.widgetId),
			}),
			harness.deps,
			never,
		);
		expect(calls.completions).toEqual([
			expect.objectContaining({
				outcome: "failed",
				failureCode: "NOTEBOOK_PROMPT_TOO_LARGE",
				retryable: false,
			}),
		]);
		expect(harness.agent.requests).toHaveLength(0);
	});

	it("reports cancelled when the server asks for cancellation", async () => {
		const { api, calls } = createFakeApi({
			events: [{ ok: true, value: { cancelRequested: true } }],
		});
		const harness = createDeps(api);
		await executeJob(notebookJob(), harness.deps, never);
		expect(calls.completions).toEqual([
			expect.objectContaining({ outcome: "cancelled", leaseGeneration: 3 }),
		]);
	});
});
