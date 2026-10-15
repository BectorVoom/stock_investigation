/**
 * Notebook market data through the owner API (ADR-0021): live series of a
 * conversation's notebook market widgets in the Home data shape, with the
 * same conditional GET as `/home/data`. Runs in both API projects (real
 * local D1 and Node SQLite) against the production migrations — the JSON
 * scan over the stored notebook bodies runs on the real database here.
 */
import { env } from "cloudflare:test";
import { homeDataResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	claim,
	createHarness,
	createWorkspace,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

const NOW = "2026-10-14T00:00:00.000Z";

function marketMetric(widgetId: string, seriesId: string) {
	return {
		widgetId,
		type: "market-metric",
		title: `Metric ${widgetId}`,
		size: "small",
		seriesId,
		createdAt: NOW,
		updatedAt: NOW,
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	};
}

function textWidget(widgetId: string) {
	return {
		widgetId,
		type: "text",
		title: `Notes ${widgetId}`,
		size: "medium",
		text: "hello",
		createdAt: NOW,
		updatedAt: NOW,
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	};
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

async function readMarketData(harness: ReturnType<typeof createHarness>, workspaceId: string) {
	return harness.call("GET", `/workspaces/${workspaceId}/notebook/market-data`);
}

async function storedSeriesIds(ownerId: string): Promise<string[]> {
	const rows = await env.DB.prepare("SELECT series_id AS id FROM market_series WHERE owner_id = ?")
		.bind(ownerId)
		.all<{ id: string }>();
	return rows.results.map((row) => row.id).sort();
}

describe("notebook market data (ADR-0021)", () => {
	it("answers 404 for a workspace the owner does not have", async () => {
		const harness = createHarness();
		const response = await readMarketData(harness, "ws_missing");
		expect(response.status).toBe(404);
		expect(await errorCode(response)).toBe("NOT_FOUND");
	});

	it("answers series [] for an empty notebook, with an ETag that 304s", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const first = await readMarketData(harness, workspaceId);
		expect(first.status).toBe(200);
		const data = await body(first, homeDataResponseSchema);
		expect(data.series).toEqual([]);
		expect(data.refresh).toEqual({
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: null,
		});
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		const second = await harness.call(
			"GET",
			`/workspaces/${workspaceId}/notebook/market-data`,
			undefined,
			{ "If-None-Match": etag ?? "" },
		);
		expect(second.status).toBe(304);
	});

	it("answers series [] for a notebook without market widgets", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		expect((await saveNotebook(harness, workspaceId, [textWidget("w-1")], 0)).status).toBe(200);
		const data = await body(await readMarketData(harness, workspaceId), homeDataResponseSchema);
		expect(data.series).toEqual([]);
	});

	it("is scoped per owner", async () => {
		const first = createHarness();
		const second = createHarness();
		const workspaceId = await createWorkspace(first);
		const other = await readMarketData(second, workspaceId);
		expect(other.status).toBe(404);
		expect(await errorCode(other)).toBe("NOT_FOUND");
	});

	it("serves this notebook's series after a refresh, and 304s until the next one", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		expect(
			(await saveNotebook(harness, workspaceId, [marketMetric("w-m", "fred:VIXCLS")], 0)).status,
		).toBe(200);

		const before = await body(await readMarketData(harness, workspaceId), homeDataResponseSchema);
		expect(before.series).toHaveLength(1);
		expect(before.series[0]).toMatchObject({
			seriesId: "fred:VIXCLS",
			unavailable: { code: "NEVER_REFRESHED" },
		});
		expect(before.series[0]?.observations).toEqual([]);

		const queued = await harness.call("POST", "/home/refresh", undefined, idempotencyKey());
		expect(queued.status).toBe(202);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		// The dashboard's series come first; the notebook's series follow.
		expect(job.series.map((entry) => entry.seriesId)).toContain("fred:VIXCLS");
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			outcome: "market-refreshed",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			series: [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: {
						title: "VIX",
						unit: "Index",
						frequency: "daily",
						publisher: "Federal Reserve Bank of St. Louis (FRED)",
						sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
					},
					observations: [
						["2026-10-01", 15.2],
						["2026-10-02", 15.8],
					],
					errorCode: null,
				},
			],
		});
		expect(completed.status).toBe(200);

		const after = await readMarketData(harness, workspaceId);
		expect(after.status).toBe(200);
		const data = await body(after, homeDataResponseSchema);
		expect(data.series.find((entry) => entry.seriesId === "fred:VIXCLS")?.observations).toEqual([
			["2026-10-01", 15.2],
			["2026-10-02", 15.8],
		]);
		expect(data.refresh.lastSucceededAt).not.toBeNull();
		const etag = after.headers.get("ETag");
		expect(etag).not.toBeNull();
		const cached = await harness.call(
			"GET",
			`/workspaces/${workspaceId}/notebook/market-data`,
			undefined,
			{ "If-None-Match": etag ?? "" },
		);
		expect(cached.status).toBe(304);
	});

	it("claims notebook series the dashboard does not name, and a Home save keeps them", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const workspaceId = await createWorkspace(harness);
		// Yen per dollar is on no default-dashboard widget.
		expect(
			(await saveNotebook(harness, workspaceId, [marketMetric("w-yen", "fred:DEXJPUS")], 0)).status,
		).toBe(200);

		const queued = await harness.call("POST", "/home/refresh", undefined, idempotencyKey());
		expect(queued.status).toBe(202);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		const ids = job.series.map((entry) => entry.seriesId);
		expect(ids).toContain("fred:VIXCLS");
		expect(ids).toContain("fred:DEXJPUS");
		// Home first: the dashboard's VIX precedes the notebook-only yen.
		expect(ids.indexOf("fred:VIXCLS")).toBeLessThan(ids.indexOf("fred:DEXJPUS"));

		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			outcome: "market-refreshed",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			series: [
				{
					seriesId: "fred:DEXJPUS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: null,
					observations: [],
					errorCode: "SOURCE_NOT_CONFIGURED",
				},
			],
		});
		expect(completed.status).toBe(200);
		// The completion keeps the notebook's series even though the
		// dashboard does not name it.
		expect(await storedSeriesIds(harness.ownerId)).toEqual(["fred:DEXJPUS"]);

		const notebookData = await body(
			await readMarketData(harness, workspaceId),
			homeDataResponseSchema,
		);
		expect(
			notebookData.series.find((entry) => entry.seriesId === "fred:DEXJPUS")?.unavailable,
		).toMatchObject({ code: "SOURCE_NOT_CONFIGURED" });

		// A Home save still deletes nothing the notebook names …
		const dashboard = await harness.call("GET", "/home/dashboard");
		expect(dashboard.status).toBe(200);
		const saved = await harness.call("PUT", "/home/dashboard", {
			dashboard: {
				schemaVersion: 2,
				widgets: [
					{
						type: "market-metric",
						widgetId: "w-1",
						title: "VIX",
						size: "small",
						seriesId: "fred:VIXCLS",
					},
				],
			},
			expectedVersion: 0,
		});
		expect(saved.status).toBe(200);
		expect(await storedSeriesIds(harness.ownerId)).toEqual(["fred:DEXJPUS"]);

		// … but once no notebook names it, the next Home save deletes it.
		expect((await saveNotebook(harness, workspaceId, [textWidget("w-1")], 1)).status).toBe(200);
		const savedAgain = await harness.call("PUT", "/home/dashboard", {
			dashboard: {
				schemaVersion: 2,
				widgets: [
					{
						type: "market-metric",
						widgetId: "w-1",
						title: "VIX",
						size: "small",
						seriesId: "fred:VIXCLS",
					},
				],
			},
			expectedVersion: 1,
		});
		expect(savedAgain.status).toBe(200);
		expect(await storedSeriesIds(harness.ownerId)).toEqual([]);
	});
});
