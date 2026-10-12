import {
	conversationListResponseSchema,
	conversationResponseSchema,
	DEFAULT_CONVERSATION_TITLE,
	researchRunListResponseSchema,
	researchRunResponseSchema,
	workspaceEventsResponseSchema,
	workspaceSummarySchema,
	workspaceViewSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	apiError,
	body,
	completeRun,
	createHarness,
	createWorkspace,
	errorCode,
	type Harness,
	idempotencyKey,
	issueRunnerToken,
	queueRun,
	researchRequest,
} from "./helpers.ts";

async function rename(harness: Harness, workspaceId: string, title: unknown) {
	return harness.call("PATCH", `/workspaces/${workspaceId}`, { title });
}

async function titleOf(harness: Harness, workspaceId: string): Promise<string> {
	const response = await harness.call("GET", `/workspaces/${workspaceId}`);
	expect(response.status).toBe(200);
	return (await body(response, workspaceViewSchema)).workspace.title;
}

async function ask(harness: Harness, workspaceId: string, question: string) {
	const response = await harness.call(
		"POST",
		"/research-runs",
		researchRequest(workspaceId, { question }),
		idempotencyKey(),
	);
	expect(response.status).toBe(202);
	return body(response, researchRunResponseSchema);
}

describe("renaming a conversation (PATCH /workspaces/:id)", () => {
	it("renames, moves updatedAt, and keeps the canvas version", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Old title");
		const token = await issueRunnerToken(harness);
		await completeRun(harness, token, workspaceId);
		const before = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		expect(before.state.version).toBe(2);

		harness.time.advance(5_000);
		const response = await rename(harness, workspaceId, "New title");
		expect(response.status).toBe(200);
		const renamed = await body(response, workspaceSummarySchema);
		expect(renamed.workspaceId).toBe(workspaceId);
		expect(renamed.title).toBe("New title");
		expect(renamed.version).toBe(2);
		expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(before.workspace.updatedAt));
		expect(await titleOf(harness, workspaceId)).toBe("New title");
	});

	it("renaming to the current title succeeds", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Same");
		const response = await rename(harness, workspaceId, "Same");
		expect(response.status).toBe(200);
		expect((await body(response, workspaceSummarySchema)).title).toBe("Same");
	});

	it("answers 404 for an unknown id, a malformed id, and another owner's id", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Mine");
		for (const id of ["ws_doesnotexist1", "!!!"]) {
			const response = await rename(harness, id, "New title");
			expect(response.status).toBe(404);
			expect(await errorCode(response)).toBe("NOT_FOUND");
		}
		const other = createHarness();
		const foreign = await rename(other, workspaceId, "New title");
		expect(foreign.status).toBe(404);
		expect(await errorCode(foreign)).toBe("NOT_FOUND");
		// The failed rename changed nothing.
		expect(await titleOf(harness, workspaceId)).toBe("Mine");
	});

	it("validates the title and refuses unprotected writes", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Mine");
		for (const payload of [{}, { title: "" }, { title: "   " }, { title: 42 }]) {
			const response = await harness.call("PATCH", `/workspaces/${workspaceId}`, payload);
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe("VALIDATION_FAILED");
		}
		const csrf = await harness.raw("PATCH", `/workspaces/${workspaceId}`, {
			body: { title: "New title" },
			headers: { Origin: "http://localhost" },
		});
		expect(csrf.status).toBe(403);
		expect(await errorCode(csrf)).toBe("CSRF_REJECTED");
		const anonymous = await harness.raw("PATCH", `/workspaces/${workspaceId}`, {
			body: { title: "New title" },
			headers: { "X-Test-Anonymous": "1" },
		});
		expect(anonymous.status).toBe(401);
	});

	it("changes the conversation-list and workspace-view ETags", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Old title");

		const listFirst = await harness.call("GET", "/conversations");
		const listEtag = listFirst.headers.get("ETag");
		expect(listEtag).not.toBeNull();
		const viewFirst = await harness.call("GET", `/workspaces/${workspaceId}`);
		const viewEtag = viewFirst.headers.get("ETag");
		expect(viewEtag).not.toBeNull();

		// Before the rename both validators still match.
		expect(
			(
				await harness.raw("GET", "/conversations", {
					headers: { "If-None-Match": listEtag ?? "" },
				})
			).status,
		).toBe(304);
		expect(
			(
				await harness.raw("GET", `/workspaces/${workspaceId}`, {
					headers: { "If-None-Match": viewEtag ?? "" },
				})
			).status,
		).toBe(304);

		expect((await rename(harness, workspaceId, "New title")).status).toBe(200);

		// After the rename the old validators are stale: the lists show the new title.
		const listChanged = await harness.raw("GET", "/conversations", {
			headers: { "If-None-Match": listEtag ?? "" },
		});
		expect(listChanged.status).toBe(200);
		expect(listChanged.headers.get("ETag")).not.toBe(listEtag);
		const listed = await body(
			await harness.call("GET", "/conversations"),
			conversationListResponseSchema,
		);
		expect(listed.conversations.map((entry) => entry.title)).toEqual(["New title"]);

		const viewChanged = await harness.raw("GET", `/workspaces/${workspaceId}`, {
			headers: { "If-None-Match": viewEtag ?? "" },
		});
		expect(viewChanged.status).toBe(200);
		expect(viewChanged.headers.get("ETag")).not.toBe(viewEtag);
	});
});

describe("deleting a conversation (DELETE /workspaces/:id)", () => {
	it("answers 404 for an unknown id, a malformed id, and another owner's id", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Mine");
		for (const id of ["ws_doesnotexist1", "!!!"]) {
			const response = await harness.call("DELETE", `/workspaces/${id}`);
			expect(response.status).toBe(404);
			expect(await errorCode(response)).toBe("NOT_FOUND");
		}
		const other = createHarness();
		const foreign = await other.call("DELETE", `/workspaces/${workspaceId}`);
		expect(foreign.status).toBe(404);
		expect(await errorCode(foreign)).toBe("NOT_FOUND");
		// Nothing was deleted.
		expect((await harness.call("GET", `/workspaces/${workspaceId}`)).status).toBe(200);
		const anonymous = await harness.raw("DELETE", `/workspaces/${workspaceId}`, {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect(anonymous.status).toBe(401);
		const csrf = await harness.raw("DELETE", `/workspaces/${workspaceId}`, {
			headers: { Origin: "http://localhost" },
		});
		expect(csrf.status).toBe(403);
	});

	it("refuses while a run is unfinished and deletes nothing", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Busy");
		const runId = await queueRun(harness, workspaceId);

		const refused = await harness.call("DELETE", `/workspaces/${workspaceId}`);
		expect(refused.status).toBe(409);
		const refusal = await apiError(refused);
		expect(refusal.code).toBe("CONFLICT");
		expect(refusal.message).toContain("Stop the running question first");

		// Nothing was deleted: the conversation and its run are intact.
		expect((await harness.call("GET", `/workspaces/${workspaceId}`)).status).toBe(200);
		expect((await harness.call("GET", `/research-runs/${runId}`)).status).toBe(200);

		// Once the owner stops the run, the delete goes through.
		expect((await harness.call("POST", `/research-runs/${runId}/cancel`)).status).toBe(200);
		expect((await harness.call("DELETE", `/workspaces/${workspaceId}`)).status).toBe(204);
	});

	it("removes the conversation, its runs and its records, and nothing else", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Doomed");
		const token = await issueRunnerToken(harness);
		const { runId } = await completeRun(harness, token, workspaceId);
		const survivorId = await createWorkspace(harness, "Survivor");

		const deleted = await harness.call("DELETE", `/workspaces/${workspaceId}`);
		expect(deleted.status).toBe(204);
		expect(await deleted.text()).toBe("");

		// The conversation is gone everywhere it used to appear.
		for (const path of [
			`/workspaces/${workspaceId}`,
			`/workspaces/${workspaceId}/messages`,
			`/workspaces/${workspaceId}/events`,
			`/workspaces/${workspaceId}/export`,
			`/research-runs/${runId}`,
			`/research-runs/${runId}/records`,
		]) {
			const response = await harness.call("GET", path);
			expect(response.status, path).toBe(404);
		}
		const workspaces = await harness.call("GET", "/workspaces");
		expect(JSON.stringify(await workspaces.json())).not.toContain(workspaceId);
		const conversations = await body(
			await harness.call("GET", "/conversations"),
			conversationListResponseSchema,
		);
		expect(conversations.conversations.map((entry) => entry.workspaceId)).not.toContain(
			workspaceId,
		);
		const runs = await body(
			await harness.call("GET", `/research-runs?workspaceId=${workspaceId}`),
			researchRunListResponseSchema,
		);
		expect(runs.runs).toEqual([]);
		const allRuns = await body(
			await harness.call("GET", "/research-runs"),
			researchRunListResponseSchema,
		);
		expect(allRuns.runs.map((run) => run.runId)).not.toContain(runId);

		// The surviving conversation is untouched, and a repeat delete is 404.
		expect((await harness.call("GET", `/workspaces/${survivorId}`)).status).toBe(200);
		const repeat = await harness.call("DELETE", `/workspaces/${workspaceId}`);
		expect(repeat.status).toBe(404);
	});

	it("keeps records another conversation still borrows", async () => {
		const harness = createHarness();
		const lenderId = await createWorkspace(harness, "Lender");
		const token = await issueRunnerToken(harness);
		const { runId } = await completeRun(harness, token, lenderId);
		const datasetId = `${runId}_ds_scenarios`;
		const evidenceId = `${runId}_ev1`;

		// The borrower binds the lender's dataset and cites its evidence.
		const borrowerId = await createWorkspace(harness, "Borrower");
		const borrowed = await harness.call("POST", `/workspaces/${borrowerId}/commands`, {
			protocolVersion: 1,
			commandId: "cmd_borrow_1",
			workspaceId: borrowerId,
			expectedWorkspaceVersion: 0,
			operation: "component.create",
			componentId: "borrowed_table",
			componentType: "data-table",
			schemaVersion: 1,
			props: { title: "Borrowed", datasetRef: datasetId, sourceIds: [evidenceId] },
		});
		expect(borrowed.status).toBe(200);

		expect((await harness.call("DELETE", `/workspaces/${lenderId}`)).status).toBe(204);

		// The borrowed rows survived: the borrower's canvas still resolves them.
		const view = await body(
			await harness.call("GET", `/workspaces/${borrowerId}`),
			workspaceViewSchema,
		);
		expect(view.datasets.map((dataset) => dataset.datasetId)).toEqual([datasetId]);
		expect(view.sources.map((source) => source.evidenceId)).toEqual([evidenceId]);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${borrowerId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages).toEqual([]);
		const events = await body(
			await harness.call("GET", `/workspaces/${borrowerId}/events`),
			workspaceEventsResponseSchema,
		);
		expect(events.currentVersion).toBe(1);
	});
});

describe("naming a new chat from its first question", () => {
	it("starts untitled and takes the first question's first line as its title", async () => {
		const harness = createHarness();
		const created = await harness.call("POST", "/workspaces", {});
		expect(created.status).toBe(201);
		const createdSummary = await body(created, workspaceSummarySchema);
		const workspaceId = createdSummary.workspaceId;
		expect(createdSummary.title).toBe(DEFAULT_CONVERSATION_TITLE);

		await ask(harness, workspaceId, "Why is grid storage growing?\nTell me more.");
		expect(await titleOf(harness, workspaceId)).toBe("Why is grid storage growing?");
		const listed = await body(
			await harness.call("GET", "/conversations"),
			conversationListResponseSchema,
		);
		expect(listed.conversations[0]?.title).toBe("Why is grid storage growing?");
	});

	it("collapses whitespace, truncates long questions, and never splits emoji", async () => {
		const harness = createHarness();
		const longId = (
			await body(await harness.call("POST", "/workspaces", {}), workspaceSummarySchema)
		).workspaceId;
		await ask(harness, longId, `  ${"a".repeat(100)}   `);
		expect(await titleOf(harness, longId)).toBe(`${"a".repeat(59)}…`);

		const emojiId = (
			await body(await harness.call("POST", "/workspaces", {}), workspaceSummarySchema)
		).workspaceId;
		await ask(harness, emojiId, `${"😀".repeat(100)} yes?`);
		const emojiTitle = await titleOf(harness, emojiId);
		expect(emojiTitle).toBe(`${"😀".repeat(59)}…`);
		expect(Array.from(emojiTitle)).toHaveLength(60);
	});

	it("never renames a conversation the owner already named, nor on later questions", async () => {
		const harness = createHarness();
		const renamedId = await createWorkspace(harness, "My research");
		await ask(harness, renamedId, "Why is grid storage growing?");
		expect(await titleOf(harness, renamedId)).toBe("My research");

		const freshId = (
			await body(await harness.call("POST", "/workspaces", {}), workspaceSummarySchema)
		).workspaceId;
		await ask(harness, freshId, "First question here?");
		expect(await titleOf(harness, freshId)).toBe("First question here?");
		await ask(harness, freshId, "Second question here?");
		expect(await titleOf(harness, freshId)).toBe("First question here?");
	});

	it("leaves the title alone when the run is rejected", async () => {
		const harness = createHarness();
		const workspaceId = (
			await body(await harness.call("POST", "/workspaces", {}), workspaceSummarySchema)
		).workspaceId;
		// An unknown backend rejects the question before anything is stored.
		const rejected = await harness.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId, { agentId: "no-such-backend", question: "Why storage?" }),
			idempotencyKey(),
		);
		expect(rejected.status).toBe(422);
		expect(await titleOf(harness, workspaceId)).toBe(DEFAULT_CONVERSATION_TITLE);
		expect(
			(
				await body(
					await harness.call("GET", `/workspaces/${workspaceId}/messages`),
					conversationResponseSchema,
				)
			).messages,
		).toEqual([]);
	});
});

describe("deleted conversations stay gone from exports", () => {
	it("exports 404 after delete", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Doomed");
		const token = await issueRunnerToken(harness);
		await completeRun(harness, token, workspaceId);
		expect((await harness.call("GET", `/workspaces/${workspaceId}/export`)).status).toBe(200);
		expect((await harness.call("DELETE", `/workspaces/${workspaceId}`)).status).toBe(204);
		const exported = await harness.call("GET", `/workspaces/${workspaceId}/export`);
		expect(exported.status).toBe(404);
		expect(exported.headers.get("ETag")).toBeNull();
	});
});
