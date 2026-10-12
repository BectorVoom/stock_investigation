import { env } from "cloudflare:test";
import {
	articleListResponseSchema,
	completeJobResponseSchema,
	newsSourceSchema,
	researchExportSchema,
	researchRunResponseSchema,
	submitCommandResponseSchema,
	workspaceSummarySchema,
	workspaceViewSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import { ownerAuthenticatorFor } from "../src/auth.ts";
import {
	advanceToPublishing,
	apiError,
	body,
	bundleFor,
	claim,
	completeRun,
	completion,
	createHarness,
	createWorkspace,
	errorCode,
	type Harness,
	idempotencyKey,
	issueRunnerToken,
	queueRun,
	researchRequest,
	stateEvents,
	TO_PUBLISHING,
	USAGE,
} from "./helpers.ts";

/** Regression tests for defects found by independent review. */

async function runView(harness: Harness, runId: string) {
	return (
		await body(await harness.call("GET", `/research-runs/${runId}`), researchRunResponseSchema)
	).run;
}

describe("idempotent enqueue and admission control (ARCH-016)", () => {
	it("answers a replay from the stored run even when the owner is at the unfinished cap", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const key = idempotencyKey();
		const first = await harness.call("POST", "/research-runs", researchRequest(workspaceId), key);
		const firstRun = (await body(first, researchRunResponseSchema)).run;
		for (let index = 0; index < 4; index += 1) await queueRun(harness, workspaceId);

		// Five unfinished runs: a NEW request is refused...
		const fresh = await harness.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId),
			idempotencyKey(),
		);
		expect(fresh.status).toBe(429);
		// ...but resending the first request is not a new request.
		const replay = await harness.call("POST", "/research-runs", researchRequest(workspaceId), key);
		expect(replay.status).toBe(202);
		expect((await body(replay, researchRunResponseSchema)).run.runId).toBe(firstRun.runId);
	});

	it("does not let concurrent requests slip past the unfinished cap", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		for (let index = 0; index < 4; index += 1) await queueRun(harness, workspaceId);
		const responses = await Promise.all(
			[0, 1, 2].map(() =>
				harness.call("POST", "/research-runs", researchRequest(workspaceId), idempotencyKey()),
			),
		);
		expect(responses.map((response) => response.status).sort()).toEqual([202, 429, 429]);
		const unfinished = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND state = 'pending'",
		)
			.bind(harness.ownerId)
			.first<{ n: number }>();
		expect(unfinished?.n).toBe(5);
	});
});

describe("budgets and attempts over the life of a run (AGT-008, FR-014)", () => {
	it("never lets reported usage go down", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		const high = {
			agentSteps: 5,
			toolCalls: 18,
			inputBytes: 9_000,
			knownCostUsd: 1,
			hasUnmeteredUsage: true,
		};
		const low = {
			agentSteps: 0,
			toolCalls: 0,
			inputBytes: 0,
			knownCostUsd: 0,
			hasUnmeteredUsage: false,
		};
		const usageEvent = (seq: number, usage: typeof high) => ({
			leaseGeneration: lease.leaseGeneration,
			events: [{ seq, at: harness.time.clock.nowIso(), event: { type: "usage", usage } }],
		});
		await harness.runner(token, `/jobs/${runId}/events`, usageEvent(0, high));
		await harness.runner(token, `/jobs/${runId}/events`, usageEvent(1, low));
		expect((await runView(harness, runId)).usage).toEqual(high);

		// A completion that under-reports cannot erase it either.
		await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: low,
			failureCode: "PROVIDER_AUTH",
			retryable: false,
		});
		const run = await runView(harness, runId);
		expect(run.usage).toEqual(high);
		expect(run.cost.status).toBe("unknown-plan-limited");
	});

	it("does not spend the failure-retry allowance on owner approvals", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const budget = researchRequest(workspaceId).budget;
		// More approval pauses than the retry ceiling of three.
		for (let round = 0; round < 5; round += 1) {
			const lease = await claim(harness, token);
			if (lease === null) throw new Error(`round ${round}: expected the run to be claimable`);
			expect(lease.attempt).toBe(1);
			await harness.runner(
				token,
				`/jobs/${runId}/events`,
				stateEvents(harness, lease, ["planning"], round),
			);
			await harness.runner(token, `/jobs/${runId}/complete`, {
				outcome: "waiting_approval",
				leaseGeneration: lease.leaseGeneration,
				usage: USAGE,
				approvalRequest: { reasonCode: "SPEND_LIMIT_REACHED", detail: "limit reached" },
			});
			const approved = await harness.call("POST", `/research-runs/${runId}/approve`, { budget });
			expect(approved.status).toBe(200);
		}
		expect((await runView(harness, runId)).state).toBe("pending");
	});

	it("keeps the provenance of a published result with the run (AGT-010)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const { runId } = await completeRun(harness, token, workspaceId);
		expect((await runView(harness, runId)).provenance).toEqual({
			agentId: "claude-code",
			providerModel: null,
			promptVersion: "research-v1",
			toolVersions: { "news.fetch_feed": "1" },
			dataCutoffAt: "2026-10-11T00:00:00.000Z",
		});
	});
});

describe("ingested articles are checked against the owner's sources (DATA-010)", () => {
	const FEED_URL = "https://news.example.org/feed.xml";
	const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
		<item><title>One</title><link>https://news.example.org/a/1</link></item></channel></rss>`;

	it("drops articles of unknown sources and strips excerpts a license does not permit", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		const source = await body(
			await harness.call("POST", "/sources", {
				url: FEED_URL,
				licensePolicy: "headline-and-link-only",
				trustClassification: "established-media",
			}),
			newsSourceSchema,
		);
		const token = await issueRunnerToken(harness);
		await harness.call("POST", "/sources/refresh", undefined, idempotencyKey());
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await harness.runner(
			token,
			`/jobs/${lease.runId}/events`,
			stateEvents(harness, lease, TO_PUBLISHING),
		);
		const article = (sourceId: string, path: string, digit: string) => ({
			sourceId,
			canonicalUrl: `https://news.example.org${path}`,
			publisher: "Example",
			title: `Article ${path}`,
			publishedAt: null,
			retrievedAt: "2026-10-11T00:00:00.000Z",
			contentFingerprint: digit.repeat(64),
			excerpt: "A passage the license does not allow us to keep.",
		});
		const response = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "ingested",
			leaseGeneration: lease.leaseGeneration,
			usage: { ...USAGE, agentSteps: 0, hasUnmeteredUsage: false },
			articles: [article(source.sourceId, "/a/1", "1"), article("src_missing", "/a/2", "2")],
			sourceReports: [
				{ sourceId: source.sourceId, fetchedAt: "2026-10-11T00:00:00.000Z", errorCode: null },
				{ sourceId: "src_missing", fetchedAt: "2026-10-11T00:00:00.000Z", errorCode: null },
			],
		});
		expect((await body(response, completeJobResponseSchema)).newArticleCount).toBe(1);
		const page = await body(await harness.call("GET", "/articles"), articleListResponseSchema);
		expect(page.articles).toHaveLength(1);
		expect(page.articles[0]).toMatchObject({ sourceId: source.sourceId, excerpt: null });
	});
});

describe("request validation is total (API-002)", () => {
	it("rejects deeply nested props with a validation error, not a crash", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		let nested: unknown = "leaf";
		for (let depth = 0; depth < 3_000; depth += 1) nested = { next: nested };
		const response = await harness.call("POST", `/workspaces/${workspaceId}/commands`, {
			protocolVersion: 1,
			commandId: "deep",
			workspaceId,
			expectedWorkspaceVersion: 0,
			operation: "component.create",
			componentId: "deep",
			componentType: "data-table",
			schemaVersion: 1,
			props: { title: "t", datasetRef: "x", sourceIds: [], extra: nested },
		});
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
	});

	it("refuses an 'available' metric that does not satisfy its own definition (DATA-005)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);
		const base = bundleFor(runId);
		const negativePer = bundleFor(runId, {
			financialObservations: [
				{
					...base.financialObservations[0],
					observationId: `${runId}_fo1`,
					securityId: `${runId}_sec1`,
					metricCode: "trailing-per",
					value: -20,
					unavailableReason: null,
					unit: "currency",
					currency: "USD",
					accountingStandard: null,
					period: null,
					actualOrEstimate: "estimate",
					marketDataAsOf: "2026-10-10T00:00:00.000Z",
					formula: null,
					sourceEvidenceId: `${runId}_ev1`,
				},
			],
		});
		const response = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(lease, negativePer),
		);
		expect(response.status).toBe(400);
		const error = await apiError(response);
		expect(error.code).toBe("VALIDATION_FAILED");
		expect(error.detail).toContain("bundle.financialObservations.0");
	});

	it("refuses a table figure with no source, date or stated basis (hard gate 6)", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const runId = await queueRun(harness, workspaceId);
		const token = await issueRunnerToken(harness);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);
		const base = bundleFor(runId);
		const bare = bundleFor(runId, {
			datasets: base.datasets.map((dataset) => ({
				...dataset,
				rows: [{ product: { v: "x" }, base: { v: 999 } }],
			})),
		});
		const response = await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			completion(lease, bare),
		);
		expect(response.status).toBe(400);
	});
});

describe("a later run may point at records of an earlier one", () => {
	it("accepts navigation to evidence the owner already stores", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const first = await completeRun(harness, token, workspaceId);

		const runId = await queueRun(harness, workspaceId);
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await advanceToPublishing(harness, token, lease);
		const bundle = bundleFor(runId, {
			uiOperations: [
				{
					operation: "navigation.open",
					target: { kind: "evidence", evidenceId: `${first.runId}_ev1` },
				},
			],
		});
		expect(
			(await harness.runner(token, `/jobs/${runId}/complete`, completion(lease, bundle))).status,
		).toBe(200);
		const view = await body(
			await harness.call("GET", `/workspaces/${workspaceId}`),
			workspaceViewSchema,
		);
		expect(view.state.lastNavigation?.target).toEqual({
			kind: "evidence",
			evidenceId: `${first.runId}_ev1`,
		});
	});
});

describe("export and import are closed, bounded and identity-safe (FR-015)", () => {
	async function seeded() {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		const run = await completeRun(harness, token, workspaceId);
		return { harness, workspaceId, token, runId: run.runId };
	}
	const exportOf = async (harness: Harness, workspaceId: string) =>
		body(await harness.call("GET", `/workspaces/${workspaceId}/export`), researchExportSchema);

	it("exports the evidence a borrowed dataset cites, so the file imports on its own", async () => {
		const { harness, workspaceId, runId } = await seeded();
		// A second workspace shows the first run's dataset; none of that run's records belong to it.
		const other = await createWorkspace(harness, "Borrower");
		const created = await harness.call("POST", `/workspaces/${other}/commands`, {
			protocolVersion: 1,
			commandId: "borrow",
			workspaceId: other,
			expectedWorkspaceVersion: 0,
			operation: "component.create",
			componentId: "borrowed",
			componentType: "data-table",
			schemaVersion: 1,
			props: { title: "Borrowed", datasetRef: `${runId}_ds_scenarios`, sourceIds: [] },
		});
		expect(created.status).toBe(200);
		const exported = await exportOf(harness, other);
		expect(exported.datasets.map((dataset) => dataset.datasetId)).toEqual([
			`${runId}_ds_scenarios`,
		]);
		// The dataset's cells cite the first run's evidence; it travels with the file.
		expect(exported.records.evidence.map((item) => item.evidenceId)).toEqual([`${runId}_ev1`]);
		expect((await harness.call("POST", "/workspaces/import", exported)).status).toBe(201);
		expect(workspaceId).not.toBe(other);
	});

	it("rejects a file whose components or messages point outside the file", async () => {
		const { harness, workspaceId } = await seeded();
		const exported = await exportOf(harness, workspaceId);
		// Strip the records but keep the components and messages that cite them.
		const hollow = {
			...exported,
			datasets: [],
			records: {
				...exported.records,
				evidence: [],
				claims: [],
				scenarios: [],
				supplierLinks: [],
				securities: [],
				financialObservations: [],
			},
		};
		const response = await harness.call("POST", "/workspaces/import", hollow);
		expect(response.status).toBe(422);
		const error = await apiError(response);
		expect(error.code).toBe("INTEGRITY_VIOLATION");
		expect(error.detail).toContain("DANGLING_REFERENCE");
	});

	it("gives the imported workspace one consistent identity even when ids collide", async () => {
		const { harness, workspaceId } = await seeded();
		const exported = await exportOf(harness, workspaceId);
		// A message whose run id equals the exported workspace's id.
		const colliding = {
			...exported,
			messages: exported.messages.map((message) => ({ ...message, runId: workspaceId })),
		};
		const imported = await harness.call("POST", "/workspaces/import", colliding);
		expect(imported.status).toBe(201);
		const summary = await body(imported, workspaceSummarySchema);
		const view = await body(
			await harness.call("GET", `/workspaces/${summary.workspaceId}`),
			workspaceViewSchema,
		);
		expect(view.state.workspaceId).toBe(summary.workspaceId);
		// The imported workspace accepts commands addressed to its own id.
		const focused = await harness.call("POST", `/workspaces/${summary.workspaceId}/commands`, {
			protocolVersion: 1,
			commandId: "after_import",
			workspaceId: summary.workspaceId,
			expectedWorkspaceVersion: view.state.version,
			operation: "component.focus",
			componentId: view.state.components[0]?.componentId ?? "",
		});
		expect(focused.status).toBe(200);
		expect((await body(focused, submitCommandResponseSchema)).state.workspaceId).toBe(
			summary.workspaceId,
		);
	});

	it("rejects a file whose workspace state breaks the reducer's invariants", async () => {
		const { harness, workspaceId } = await seeded();
		const exported = await exportOf(harness, workspaceId);
		const first = exported.workspace.state.components[0];
		const duplicated = {
			...exported,
			workspace: {
				...exported.workspace,
				state: {
					...exported.workspace.state,
					components: [first, first],
					layout: { order: [], columns: 1 },
				},
			},
		};
		const response = await harness.call("POST", "/workspaces/import", duplicated);
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
	});

	it("says so at export time when a workspace is too large to import back", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const token = await issueRunnerToken(harness);
		// Three runs of 1,200 table cells each: 3,600 > the 3,000 an import accepts.
		for (let round = 0; round < 3; round += 1) {
			const runId = await queueRun(harness, workspaceId);
			const lease = await claim(harness, token);
			if (lease === null) throw new Error("expected a lease");
			await advanceToPublishing(harness, token, lease);
			const [template] = bundleFor(runId).datasets;
			if (template === undefined) throw new Error("fixture has no dataset");
			// Two tables of 300 rows x 2 columns: 1,200 cells, within the per-run limit.
			const table = (suffix: string) => ({
				...template,
				datasetId: `${runId}_ds_${suffix}`,
				rows: Array.from({ length: 300 }, (_, row) => ({
					product: { v: `row ${row}` },
					base: { v: row, sourceId: `${runId}_ev1`, asOf: "2026-10-01" },
				})),
			});
			const response = await harness.runner(
				token,
				`/jobs/${runId}/complete`,
				completion(lease, bundleFor(runId, { datasets: [table("scenarios"), table("more")] })),
			);
			expect(response.status).toBe(200);
		}
		const exported = await harness.call("GET", `/workspaces/${workspaceId}/export`);
		expect(exported.status).toBe(413);
		expect(await errorCode(exported)).toBe("PAYLOAD_TOO_LARGE");
	});
});

describe("owner authenticator reuse", () => {
	it("keeps one authenticator (and so one signing-key cache) per configuration", () => {
		const config = {
			DB: env.DB,
			AUTH_MODE: "cloudflare-access",
			OWNER_EMAIL: "owner@example.test",
			ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.test",
			ACCESS_AUDIENCE: "aud",
		};
		expect(ownerAuthenticatorFor(config)).toBe(ownerAuthenticatorFor({ ...config }));
		expect(ownerAuthenticatorFor({ ...config, ACCESS_AUDIENCE: "other" })).not.toBe(
			ownerAuthenticatorFor(config),
		);
	});
});
