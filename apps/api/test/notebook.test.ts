/**
 * The per-conversation Notebook through the owner API (ADR-0020): stored,
 * served and edited with compare-and-set, undone from a 20-deep history, and
 * the `notebook-assist` job claimed and completed so the assistant's commands
 * are validated and applied by the API. Runs in both API projects (real
 * local D1 and Node SQLite) against the production migrations.
 */
import { env } from "cloudflare:test";
import {
	completeJobResponseSchema,
	conversationResponseSchema,
	notebookAssistResponseSchema,
	notebookResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	claim,
	completeRun,
	createHarness,
	createWorkspace,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

const NOW_TEXT = "hello";

function textWidget(widgetId: string, text: string = NOW_TEXT, title = `Widget ${widgetId}`) {
	return {
		widgetId,
		type: "text",
		title,
		size: "medium",
		text,
		createdAt: "2026-10-14T00:00:00.000Z",
		updatedAt: "2026-10-14T00:00:00.000Z",
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	};
}

const SETTINGS = {
	defaultAgentId: "claude-code",
	models: {},
	effort: "medium",
	budget: {
		maxAgentSteps: 6,
		maxToolCalls: 20,
		maxWallClockMs: 600_000,
		maxInputBytes: 400_000,
		maxSpendUsd: null,
	},
	webAccess: "off",
} as const;

async function saveSettings(harness: ReturnType<typeof createHarness>) {
	const response = await harness.call("PUT", "/settings/agent", { ...SETTINGS });
	expect(response.status).toBe(200);
}

async function saveNotebook(
	harness: ReturnType<typeof createHarness>,
	workspaceId: string,
	widgets: readonly unknown[],
	expectedVersion: number,
) {
	return harness.call("PUT", `/workspaces/${workspaceId}/notebook`, {
		notebook: { widgets },
		expectedVersion,
	});
}

async function readNotebook(harness: ReturnType<typeof createHarness>, workspaceId: string) {
	const response = await harness.call("GET", `/workspaces/${workspaceId}/notebook`);
	expect(response.status).toBe(200);
	return body(response, notebookResponseSchema);
}

async function assist(
	harness: ReturnType<typeof createHarness>,
	workspaceId: string,
	request: { instruction: string; selectedWidgetIds: readonly string[]; notebookVersion: number },
	key: Record<string, string> = idempotencyKey(),
) {
	const response = await harness.call(
		"POST",
		`/workspaces/${workspaceId}/notebook/assist`,
		{ ...request, selectedWidgetIds: [...request.selectedWidgetIds] },
		key,
	);
	return response;
}

function assistedCompletion(
	lease: { leaseGeneration: number },
	baseVersion: number,
	extra: {
		commands?: readonly unknown[];
		proposedRemovals?: readonly string[];
		reply?: string;
	} = {},
) {
	return {
		outcome: "notebook-assisted",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		baseVersion,
		reply: extra.reply ?? "Done",
		commands: extra.commands ?? [],
		proposedRemovals: extra.proposedRemovals ?? [],
	};
}

describe("notebook routes", () => {
	it("returns the empty notebook before any save", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const notebook = await readNotebook(harness, workspaceId);
		expect(notebook).toMatchObject({
			workspaceId,
			notebook: { widgets: [] },
			version: 0,
			updatedAt: null,
			undoAvailable: false,
			turns: [],
		});
	});

	it("answers 404 for a workspace the owner does not have", async () => {
		const harness = createHarness();
		const response = await harness.call("GET", "/workspaces/ws_missing/notebook");
		expect(response.status).toBe(404);
		expect(await errorCode(response)).toBe("NOT_FOUND");
	});

	it("saves a notebook and reports the saved copy", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const saved = await body(
			await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0),
			notebookResponseSchema,
		);
		expect(saved.version).toBe(1);
		expect(saved.notebook.widgets.map((widget) => widget.widgetId)).toEqual(["w-1"]);
		expect(saved.undoAvailable).toBe(true);
		const reread = await readNotebook(harness, workspaceId);
		expect(reread.notebook).toEqual(saved.notebook);
		expect(reread.version).toBe(1);
	});

	it("rejects a stale version with a stable conflict code", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		const conflict = await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		expect(conflict.status).toBe(409);
		expect(await errorCode(conflict)).toBe("VERSION_CONFLICT");
	});

	it("rejects a research widget that names no canvas component", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const response = await saveNotebook(
			harness,
			workspaceId,
			[
				{
					widgetId: "w-r",
					type: "research",
					title: "Result",
					size: "large",
					componentId: "comp_missing",
					createdAt: "2026-10-14T00:00:00.000Z",
					updatedAt: "2026-10-14T00:00:00.000Z",
					revision: 1,
					origin: { kind: "chat", messageId: "msg_1", runId: null, componentId: "comp_missing" },
				},
			],
			0,
		);
		expect(response.status).toBe(422);
		expect(await errorCode(response)).toBe("INVALID_NOTEBOOK");
	});

	it("accepts a research widget saved from a run's canvas component", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		const { runId } = await completeRun(harness, token, workspaceId);
		const componentId = `${runId}_table`;
		const response = await saveNotebook(
			harness,
			workspaceId,
			[
				{
					widgetId: "w-r",
					type: "research",
					title: "Result",
					size: "large",
					componentId,
					createdAt: "2026-10-14T00:00:00.000Z",
					updatedAt: "2026-10-14T00:00:00.000Z",
					revision: 1,
					origin: { kind: "chat", messageId: "msg_1", runId, componentId },
				},
			],
			0,
		);
		expect(response.status).toBe(200);
	});

	it("scopes notebooks per owner and defends writes with CSRF", async () => {
		const first = createHarness();
		const second = createHarness();
		const workspaceId = await createWorkspace(first);
		await saveNotebook(first, workspaceId, [textWidget("w-1")], 0);
		const csrf = await first.raw("PUT", `/workspaces/${workspaceId}/notebook`, {
			body: { notebook: { widgets: [textWidget("w-1")] }, expectedVersion: 1 },
			headers: { Origin: "http://localhost" },
		});
		expect(csrf.status).toBe(403);
		expect(await errorCode(csrf)).toBe("CSRF_REJECTED");
		const other = await second.call("GET", `/workspaces/${workspaceId}/notebook`);
		expect(other.status).toBe(404);
	});

	it("records an owner audit row on save", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		const rows = await env.DB.prepare(
			"SELECT action, detail FROM audit_log WHERE owner_id = ? AND action = ?",
		)
			.bind(harness.ownerId, "notebook.update")
			.all<{ action: string; detail: string }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]?.detail).toBe("widgets=1");
	});
});

describe("notebook undo", () => {
	it("restores the earlier body as a new version", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "first")], 0);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "second")], 1);
		const undone = await body(
			await harness.call("POST", `/workspaces/${workspaceId}/notebook/undo`, {
				expectedVersion: 2,
			}),
			notebookResponseSchema,
		);
		expect(undone.version).toBe(3);
		expect(undone.notebook.widgets).toHaveLength(1);
		expect(undone.notebook.widgets[0]).toMatchObject({ widgetId: "w-1", text: "first" });
	});

	it("rejects a stale undo with VERSION_CONFLICT", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "first")], 0);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "second")], 1);
		const conflict = await harness.call("POST", `/workspaces/${workspaceId}/notebook/undo`, {
			expectedVersion: 1,
		});
		expect(conflict.status).toBe(409);
		expect(await errorCode(conflict)).toBe("VERSION_CONFLICT");
	});

	it("keeps a 20-deep history and prunes older bodies in the same write", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		for (let version = 0; version < 22; version += 1) {
			const response = await saveNotebook(
				harness,
				workspaceId,
				[textWidget("w-1", `revision ${version}`)],
				version,
			);
			expect(response.status).toBe(200);
		}
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM workspace_notebook_revisions WHERE owner_id = ? AND workspace_id = ?",
		)
			.bind(harness.ownerId, workspaceId)
			.all<{ n: number }>();
		expect(count.results[0]?.n).toBe(20);
		// Undo at version 22 still restores the body of version 21.
		const undone = await body(
			await harness.call("POST", `/workspaces/${workspaceId}/notebook/undo`, {
				expectedVersion: 22,
			}),
			notebookResponseSchema,
		);
		expect(undone.version).toBe(23);
		expect(undone.notebook.widgets[0]).toMatchObject({ text: "revision 20" });
	});
});

describe("notebook assist", () => {
	it("requires a saved backend and names Settings", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const response = await assist(harness, workspaceId, {
			instruction: "Summarise",
			selectedWidgetIds: [],
			notebookVersion: 0,
		});
		expect(response.status).toBe(422);
		expect(await errorCode(response)).toBe("AGENT_NOT_CONFIGURED");
	});

	it("stores the instruction as the owner's message and queues one job", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		const key = idempotencyKey();
		const first = await body(
			await assist(
				harness,
				workspaceId,
				{ instruction: "Summarise this", selectedWidgetIds: ["w-1"], notebookVersion: 1 },
				key,
			),
			notebookAssistResponseSchema,
		);
		expect(first.message).toMatchObject({
			role: "owner",
			text: "Summarise this",
			runId: first.run.runId,
		});
		expect(first.run.kind).toBe("notebook-assist");
		// The same key answers with the same run, not a second job.
		const second = await body(
			await assist(
				harness,
				workspaceId,
				{ instruction: "Summarise this", selectedWidgetIds: ["w-1"], notebookVersion: 1 },
				key,
			),
			notebookAssistResponseSchema,
		);
		expect(second.run.runId).toBe(first.run.runId);
		expect(second.message.messageId).toBe(first.message.messageId);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages).toHaveLength(1);
	});

	it("refuses a second turn while one is queued or running", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const workspaceId = await createWorkspace(harness);
		const first = await assist(harness, workspaceId, {
			instruction: "First",
			selectedWidgetIds: [],
			notebookVersion: 0,
		});
		expect(first.status).toBe(202);
		const second = await assist(harness, workspaceId, {
			instruction: "Second",
			selectedWidgetIds: [],
			notebookVersion: 0,
		});
		expect(second.status).toBe(409);
		expect(await errorCode(second)).toBe("NOTEBOOK_ASSIST_ACTIVE");
	});

	it("rejects unknown selected widget ids", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		const response = await assist(harness, workspaceId, {
			instruction: "Change it",
			selectedWidgetIds: ["w-missing"],
			notebookVersion: 1,
		});
		expect(response.status).toBe(422);
		expect(await errorCode(response)).toBe("INVALID_NOTEBOOK_SELECTION");
	});

	it("claims the stored notebook at its version with the frozen agent choices", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		const queued = await assist(harness, workspaceId, {
			instruction: "Summarise this",
			selectedWidgetIds: ["w-1"],
			notebookVersion: 1,
		});
		expect(queued.status).toBe(202);
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		expect(job.workspaceId).toBe(workspaceId);
		expect(job.instruction).toBe("Summarise this");
		expect(job.selectedWidgetIds).toEqual(["w-1"]);
		expect(job.notebookVersion).toBe(1);
		expect(job.notebook.widgets.map((widget) => widget.widgetId)).toEqual(["w-1"]);
		expect(job.agent).toMatchObject({ agentId: "claude-code", effort: "medium" });
		expect(job.conversationContext).toEqual([]);
	});

	it("applies the turn: version bump, assistant message, recorded turn and agent audit", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "kept", "Keep")], 0);
		const queued = await assist(harness, workspaceId, {
			instruction: "Add a note",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		expect(queued.status).toBe(202);
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			...assistedCompletion(job, job.notebookVersion, {
				reply: "Added your note",
				commands: [{ kind: "add", type: "text", title: "Note", config: { text: "new body" } }],
			}),
		});
		expect(completed.status).toBe(200);
		expect((await body(completed, completeJobResponseSchema)).replayed).toBe(false);

		const notebook = await readNotebook(harness, workspaceId);
		expect(notebook.version).toBe(2);
		expect(notebook.notebook.widgets.map((widget) => widget.widgetId)).toHaveLength(2);
		const added = notebook.notebook.widgets.find((widget) => widget.title === "Note");
		expect(added?.origin).toMatchObject({ kind: "assistant", runId: job.runId });
		expect(notebook.turns).toHaveLength(1);
		expect(notebook.turns[0]).toMatchObject({
			runId: job.runId,
			baseVersion: 1,
			appliedVersion: 2,
			failure: null,
		});
		expect(notebook.turns[0]?.changes.map((change) => change.kind)).toEqual(["added"]);

		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages.map((message) => [message.role, message.text])).toEqual([
			["owner", "Add a note"],
			["assistant", "Added your note"],
		]);

		const audits = await env.DB.prepare(
			"SELECT actor, detail FROM audit_log WHERE owner_id = ? AND action = ?",
		)
			.bind(harness.ownerId, "notebook.assist.turn")
			.all<{ actor: string; detail: string }>();
		expect(audits.results).toHaveLength(1);
		expect(audits.results[0]?.actor.startsWith("runner:")).toBe(true);
		expect(audits.results[0]?.detail).toBe("appliedVersion=2");
	});

	it("applies nothing and records NOTEBOOK_CHANGED when the notebook moved", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "one")], 0);
		await assist(harness, workspaceId, {
			instruction: "Add a note",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		// The owner edits while the assistant works.
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "two")], 1);
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		await advanceToPublishing(harness, token, job);
		expect(job.notebookVersion).toBe(2);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			...assistedCompletion(job, 1, {
				reply: "Added late",
				commands: [{ kind: "add", type: "text", title: "Late", config: { text: "late" } }],
			}),
		});
		expect(completed.status).toBe(200);
		const notebook = await readNotebook(harness, workspaceId);
		expect(notebook.version).toBe(2);
		expect(notebook.notebook.widgets.map((widget) => widget.widgetId)).toEqual(["w-1"]);
		expect(notebook.turns).toHaveLength(1);
		expect(notebook.turns[0]?.appliedVersion).toBeNull();
		expect(notebook.turns[0]?.failure?.code).toBe("NOTEBOOK_CHANGED");
		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages).toHaveLength(2);
		expect(conversation.messages[1]).toMatchObject({ role: "assistant", text: "Added late" });
	});

	it("records the failure and applies nothing for an invalid command", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "kept")], 0);
		await assist(harness, workspaceId, {
			instruction: "Remove it",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			...assistedCompletion(job, job.notebookVersion, {
				reply: "Cannot remove",
				commands: [{ kind: "remove", widgetId: "w-1" }],
			}),
		});
		expect(completed.status).toBe(200);
		const notebook = await readNotebook(harness, workspaceId);
		expect(notebook.version).toBe(1);
		expect(notebook.turns[0]?.failure?.code).toBe("INVALID_COMMAND");
	});

	it("proposes removals with titles without removing anything", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1", "kept", "Keep me")], 0);
		await assist(harness, workspaceId, {
			instruction: "Tidy up",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			...assistedCompletion(job, job.notebookVersion, {
				reply: "Proposing a removal",
				commands: [],
				proposedRemovals: ["w-1", "w-gone"],
			}),
		});
		expect(completed.status).toBe(200);
		const notebook = await readNotebook(harness, workspaceId);
		expect(notebook.notebook.widgets.map((widget) => widget.widgetId)).toEqual(["w-1"]);
		// Only ids that exist are proposed, with their titles.
		expect(notebook.turns[0]?.proposedRemovals).toEqual([{ widgetId: "w-1", title: "Keep me" }]);
		expect(notebook.turns[0]?.failure).toBeNull();
	});

	it("replays a duplicate completion without a second message or write", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		await assist(harness, workspaceId, {
			instruction: "Add a note",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		await advanceToPublishing(harness, token, job);
		const payload = {
			...assistedCompletion(job, job.notebookVersion, {
				reply: "Added",
				commands: [{ kind: "add", type: "text", title: "Note", config: { text: "new" } }],
			}),
		};
		const first = await harness.runner(token, `/jobs/${job.runId}/complete`, payload);
		expect((await body(first, completeJobResponseSchema)).replayed).toBe(false);
		const replay = await harness.runner(token, `/jobs/${job.runId}/complete`, payload);
		expect((await body(replay, completeJobResponseSchema)).replayed).toBe(true);
		const notebook = await readNotebook(harness, workspaceId);
		expect(notebook.version).toBe(2);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages).toHaveLength(2);
	});

	it("leaves the notebook alone when the job fails", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		await assist(harness, workspaceId, {
			instruction: "Add a note",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		const failed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			failureCode: "MODEL_FAILED",
			retryable: false,
		});
		expect(failed.status).toBe(200);
		const notebook = await readNotebook(harness, workspaceId);
		expect(notebook.version).toBe(1);
		expect(notebook.turns).toEqual([]);
	});

	it("rejects a stale lease generation on completion", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		await assist(harness, workspaceId, {
			instruction: "Add a note",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		const stale = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			...assistedCompletion({ leaseGeneration: job.leaseGeneration + 1 }, job.notebookVersion),
		});
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("STALE_LEASE");
	});
});

describe("notebook delete cascade", () => {
	it("deleting a conversation deletes its notebook, revisions and turns", async () => {
		const harness = createHarness();
		await saveSettings(harness);
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0);
		await assist(harness, workspaceId, {
			instruction: "Add a note",
			selectedWidgetIds: [],
			notebookVersion: 1,
		});
		const job = await claim(harness, token);
		if (job?.kind !== "notebook-assist") throw new Error("expected the notebook-assist job");
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			...assistedCompletion(job, job.notebookVersion, { reply: "Added" }),
		});
		expect(completed.status).toBe(200);

		const deleted = await harness.call("DELETE", `/workspaces/${workspaceId}`);
		expect(deleted.status).toBe(204);
		for (const table of ["workspace_notebooks", "workspace_notebook_revisions", "notebook_turns"]) {
			const rows = await env.DB.prepare(
				`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ? AND workspace_id = ?`,
			)
				.bind(harness.ownerId, workspaceId)
				.all<{ n: number }>();
			expect(rows.results[0]?.n).toBe(0);
		}
	});
});
