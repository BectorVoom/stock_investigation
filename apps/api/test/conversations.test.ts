import { conversationListResponseSchema, conversationResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	body,
	completeRun,
	createHarness,
	createWorkspace,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	queueRun,
	researchRequest,
} from "./helpers.ts";

async function listConversations(harness: ReturnType<typeof createHarness>) {
	const response = await harness.call("GET", "/conversations");
	expect(response.status).toBe(200);
	return body(response, conversationListResponseSchema);
}

async function conversation(
	harness: ReturnType<typeof createHarness>,
	workspaceId: string,
	query = "",
) {
	const response = await harness.call("GET", `/workspaces/${workspaceId}/messages${query}`);
	expect(response.status).toBe(200);
	return body(response, conversationResponseSchema);
}

describe("conversation listing (FR-010)", () => {
	it("is empty for a new owner", async () => {
		const harness = createHarness();
		expect((await listConversations(harness)).conversations).toEqual([]);
	});

	it("shows a workspace without messages with nulls and messageCount 0", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness, "Empty");
		const { conversations } = await listConversations(harness);
		expect(conversations).toHaveLength(1);
		const entry = conversations[0];
		expect(entry?.workspaceId).toBe(workspaceId);
		expect(entry?.title).toBe("Empty");
		expect(entry?.messageCount).toBe(0);
		expect(entry?.lastMessageAt).toBeNull();
		expect(entry?.lastMessageRole).toBeNull();
		expect(entry?.lastMessagePreview).toBeNull();
		expect(typeof entry?.lastActivityAt).toBe("string");
	});

	it("orders by last activity, newest first", async () => {
		const harness = createHarness();
		const first = await createWorkspace(harness, "First");
		harness.time.advance(1_000);
		const second = await createWorkspace(harness, "Second");
		// Newest workspace (no messages yet) sorts first by its creation time.
		expect((await listConversations(harness)).conversations.map((c) => c.workspaceId)).toEqual([
			second,
			first,
		]);
		// Writing in the older workspace moves it to the front.
		harness.time.advance(1_000);
		await queueRun(harness, first);
		expect((await listConversations(harness)).conversations.map((c) => c.workspaceId)).toEqual([
			first,
			second,
		]);
		const entries = (await listConversations(harness)).conversations;
		expect(entries[0]?.messageCount).toBe(1);
		expect(entries[0]?.lastMessageRole).toBe("owner");
		expect(typeof entries[0]?.lastMessageAt).toBe("string");
		expect(entries[1]?.messageCount).toBe(0);
	});

	it("cuts the preview at 160 characters", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const longQuestion = `q ${"a".repeat(500)}`;
		const response = await harness.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId, { question: longQuestion }),
			idempotencyKey(),
		);
		expect(response.status).toBe(202);
		const { conversations } = await listConversations(harness);
		expect(conversations).toHaveLength(1);
		const entry = conversations[0];
		expect(entry?.messageCount).toBe(1);
		expect(entry?.lastMessagePreview).toBe(longQuestion.slice(0, 160));
		expect(entry?.lastMessagePreview?.length).toBeLessThanOrEqual(160);
	});

	it("isolates owners from each other", async () => {
		const a = createHarness();
		const workspaceId = await createWorkspace(a);
		await queueRun(a, workspaceId);
		const b = createHarness();
		expect((await listConversations(b)).conversations).toEqual([]);
		// A still sees only its own workspace.
		expect((await listConversations(a)).conversations.map((c) => c.workspaceId)).toEqual([
			workspaceId,
		]);
	});

	it("answers 304 until a new message changes the ETag", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const first = await harness.call("GET", "/conversations");
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		expect(
			(await harness.raw("GET", "/conversations", { headers: { "If-None-Match": etag ?? "" } }))
				.status,
		).toBe(304);
		await queueRun(harness, workspaceId);
		const changed = await harness.raw("GET", "/conversations", {
			headers: { "If-None-Match": etag ?? "" },
		});
		expect(changed.status).toBe(200);
		expect(changed.headers.get("ETag")).not.toBe(etag);
	});
});

describe("paging backwards through one conversation", () => {
	async function seededSix() {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		for (let index = 0; index < 3; index += 1) {
			harness.time.advance(1_000);
			await completeRun(harness, token, workspaceId);
		}
		return { harness, workspaceId };
	}

	it("pages newest-first with hasEarlier and covers every message exactly once", async () => {
		const { harness, workspaceId } = await seededSix();
		const all = await conversation(harness, workspaceId);
		expect(all.messages).toHaveLength(6);
		expect(all.hasEarlier).toBe(false);
		const seqs = all.messages.map((m) => m.seq);
		expect(seqs).toEqual([0, 1, 2, 3, 4, 5]);

		const page1 = await conversation(harness, workspaceId, "?limit=2");
		expect(page1.messages.map((m) => m.seq)).toEqual([4, 5]);
		expect(page1.hasEarlier).toBe(true);

		const oldest = page1.messages.at(0)?.seq;
		expect(oldest).toBe(4);
		const page2 = await conversation(harness, workspaceId, `?limit=2&before=${oldest}`);
		expect(page2.messages.map((m) => m.seq)).toEqual([2, 3]);
		expect(page2.hasEarlier).toBe(true);

		const page3 = await conversation(harness, workspaceId, "?limit=2&before=2");
		expect(page3.messages.map((m) => m.seq)).toEqual([0, 1]);
		expect(page3.hasEarlier).toBe(false);

		// No overlap; together every message exactly once.
		const paged = [...page1.messages, ...page2.messages, ...page3.messages]
			.map((m) => m.seq)
			.sort((a, b) => a - b);
		expect(paged).toEqual(seqs);
		const ids = [...page1.messages, ...page2.messages, ...page3.messages].map((m) => m.messageId);
		expect(new Set(ids).size).toBe(6);
	});

	it("keeps claims and evidence to exactly the returned messages", async () => {
		const { harness, workspaceId } = await seededSix();
		const page = await conversation(harness, workspaceId, "?limit=2");
		const referenced = new Set(page.messages.flatMap((m) => m.claimIds));
		expect(page.claims.map((c) => c.claimId).sort()).toEqual([...referenced].sort());
		const linked = new Set(page.claims.flatMap((c) => c.links.map((l) => l.evidenceId)));
		expect(page.evidence.map((e) => e.evidenceId).sort()).toEqual([...linked].sort());
	});

	it("rejects invalid before and limit values", async () => {
		const { harness, workspaceId } = await seededSix();
		for (const query of [
			"?before=abc",
			"?before=-1",
			"?before=1.5",
			"?limit=0",
			"?limit=201",
			"?limit=abc",
			"?limit=-3",
		]) {
			const response = await harness.call("GET", `/workspaces/${workspaceId}/messages${query}`);
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe("VALIDATION_FAILED");
		}
	});

	it("changes the ETag with before and limit", async () => {
		const { harness, workspaceId } = await seededSix();
		const a = await harness.call("GET", `/workspaces/${workspaceId}/messages?limit=2`);
		const b = await harness.call("GET", `/workspaces/${workspaceId}/messages?limit=3`);
		expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
		const etag = a.headers.get("ETag") ?? "";
		expect(
			(
				await harness.raw("GET", `/workspaces/${workspaceId}/messages?limit=2`, {
					headers: { "If-None-Match": etag },
				})
			).status,
		).toBe(304);
	});
});
