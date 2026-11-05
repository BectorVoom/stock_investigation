import { env } from "cloudflare:test";
import { stockResearchResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { seedStockResearch } from "../../../packages/adapters/test/sql/stockResearchFixtures.ts";
import {
	body,
	claim,
	createHarness,
	createWorkspace,
	issueRunnerToken,
	queueRun,
} from "./helpers.ts";

async function setup() {
	const harness = createHarness();
	const token = await issueRunnerToken(harness);
	await queueRun(harness, await createWorkspace(harness));
	const job = await claim(harness, token);
	if (job?.kind !== "research") throw new Error("Expected a research lease");
	return { harness, token, job };
}

describe("runner stored stock retrieval", () => {
	it("retrieves all three stored corpora through the authenticated, leased API", async () => {
		const { harness, token, job } = await setup();
		await seedStockResearch(env.DB, harness.ownerId);
		const result = await harness.runner(token, `/jobs/${job.runId}/stock-search`, {
			query: "solar",
			leaseGeneration: job.leaseGeneration,
		});
		expect(result.status).toBe(200);
		const retrieved = await body(result, stockResearchResponseSchema);
		expect(new Set(retrieved.hits.map((hit) => hit.kind))).toEqual(
			new Set(["company", "financials", "news"]),
		);
		expect(harness.fetchCalls).toEqual([]);
		const { harness: other, token: otherToken, job: otherJob } = await setup();
		const otherResult = await other.runner(otherToken, `/jobs/${otherJob.runId}/stock-search`, {
			query: "solar",
			leaseGeneration: otherJob.leaseGeneration,
		});
		expect((await body(otherResult, stockResearchResponseSchema)).hits).toEqual([]);
		expect(
			(
				await other.runner(otherToken, `/jobs/${job.runId}/stock-search`, {
					query: "solar",
					leaseGeneration: job.leaseGeneration,
				})
			).status,
		).toBe(404);
	});
	it("rejects stale, expired and other-credential leases, injected owner and invalid arguments", async () => {
		const { harness, token, job } = await setup();
		const path = `/jobs/${job.runId}/stock-search`;
		const query = { query: "solar", leaseGeneration: job.leaseGeneration };
		expect(
			(await harness.runner(token, path, { ...query, leaseGeneration: job.leaseGeneration + 1 }))
				.status,
		).toBe(403);
		const secondToken = await issueRunnerToken(harness, "other runner");
		expect((await harness.runner(secondToken, path, query)).status).toBe(403);
		for (const invalid of [
			{ ...query, ownerId: "victim" },
			{ ...query, query: " " },
			{ ...query, limit: 13 },
			{ ...query, query: "a b c d e f g h i" },
		]) {
			expect((await harness.runner(token, path, invalid)).status).toBe(400);
		}
		harness.time.advance(100_000);
		expect((await harness.runner(token, path, query)).status).toBe(403);
	});
	it("rejects requests without a runner token", async () => {
		const { harness, job } = await setup();
		expect(
			(
				await harness.raw("POST", `/runner/jobs/${job.runId}/stock-search`, {
					body: { query: "solar", leaseGeneration: job.leaseGeneration },
				})
			).status,
		).toBe(401);
	});
	it("refuses retrieval after cancellation", async () => {
		const { harness, token, job } = await setup();
		expect((await harness.call("POST", `/research-runs/${job.runId}/cancel`, {})).status).toBe(200);
		expect(
			(
				await harness.runner(token, `/jobs/${job.runId}/stock-search`, {
					query: "solar",
					leaseGeneration: job.leaseGeneration,
				})
			).status,
		).toBe(403);
	});
});
