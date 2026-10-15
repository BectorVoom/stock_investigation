import { env } from "cloudflare:test";
import {
	completeJobResponseSchema,
	homeDashboardResponseSchema,
	homeDataResponseSchema,
	marketCatalogResponseSchema,
	researchRunResponseSchema,
} from "@research/contracts";
import { TERMINAL_JOB_STATES } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	CLAIM_BODY,
	claim,
	createHarness,
	createWorkspace,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	TO_PUBLISHING,
	USAGE,
} from "./helpers.ts";

const VIX_META = {
	title: "VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis (FRED)",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
} as const;

const metricWidget = (widgetId: string, seriesId = "fred:VIXCLS") => ({
	type: "market-metric",
	widgetId,
	title: `Widget ${widgetId}`,
	size: "small",
	seriesId,
});

const dashboardWith = (widgets: readonly unknown[]) => ({ schemaVersion: 2, widgets });

function marketCompletion(
	lease: { leaseGeneration: number },
	series: readonly {
		readonly seriesId: string;
		readonly fetchedAt: string;
		readonly meta: typeof VIX_META | null;
		readonly observations: readonly (readonly [string, number])[];
		readonly errorCode:
			| "NEVER_REFRESHED"
			| "SOURCE_NOT_CONFIGURED"
			| "SOURCE_AUTH_FAILED"
			| "SERIES_NOT_FOUND"
			| "PLAN_NOT_ENTITLED"
			| "RATE_LIMITED"
			| "NO_DATA"
			| "SOURCE_FAILED"
			| null;
	}[],
) {
	return {
		outcome: "market-refreshed",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		series: series.map((entry) => ({ ...entry, observations: [...entry.observations] })),
	};
}

async function refresh(harness: ReturnType<typeof createHarness>): Promise<string> {
	const response = await harness.call("POST", "/home/refresh", undefined, idempotencyKey());
	expect(response.status).toBe(202);
	return (await body(response, researchRunResponseSchema)).run.runId;
}

async function observationCount(ownerId: string): Promise<number> {
	const rows = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM market_observations WHERE owner_id = ?",
	)
		.bind(ownerId)
		.all<{ n: number }>();
	return rows.results[0]?.n ?? -1;
}

describe("home dashboard (FR-017)", () => {
	it("returns the defaults before any save", async () => {
		const harness = createHarness();
		const response = await body(
			await harness.call("GET", "/home/dashboard"),
			homeDashboardResponseSchema,
		);
		expect(response.origin).toBe("defaults");
		expect(response.version).toBe(0);
		expect(response.updatedAt).toBeNull();
		expect(response.dashboard.widgets).toHaveLength(7);
	});

	it("saves a dashboard and reports the saved copy", async () => {
		const harness = createHarness();
		const dashboard = dashboardWith([metricWidget("w-1"), metricWidget("w-2", "fred:DGS10")]);
		const saved = await body(
			await harness.call("PUT", "/home/dashboard", { dashboard, expectedVersion: 0 }),
			homeDashboardResponseSchema,
		);
		expect(saved.origin).toBe("saved");
		expect(saved.version).toBe(1);
		expect(saved.dashboard).toEqual(dashboard);
		const reread = await body(
			await harness.call("GET", "/home/dashboard"),
			homeDashboardResponseSchema,
		);
		expect(reread).toEqual({ ...saved, dashboard });
	});

	it("rejects a stale version with a stable conflict code", async () => {
		const harness = createHarness();
		const dashboard = dashboardWith([metricWidget("w-1")]);
		await harness.call("PUT", "/home/dashboard", { dashboard, expectedVersion: 0 });
		const conflict = await harness.call("PUT", "/home/dashboard", {
			dashboard,
			expectedVersion: 0,
		});
		expect(conflict.status).toBe(409);
		expect(await errorCode(conflict)).toBe("VERSION_CONFLICT");
	});

	it("rejects invalid dashboards", async () => {
		const harness = createHarness();
		// Too many widgets (25 > 24).
		const many = dashboardWith(
			Array.from({ length: 25 }, (_, index) => metricWidget(`w-${index}`)),
		);
		expect(
			(await harness.call("PUT", "/home/dashboard", { dashboard: many, expectedVersion: 0 }))
				.status,
		).toBe(400);
		// Too many distinct series (3 x 12 = 36 > 30).
		const wide = dashboardWith(
			Array.from({ length: 3 }, (_, table) => ({
				type: "indicator-table",
				widgetId: `w-${table}`,
				title: `Table ${table}`,
				size: "large",
				seriesIds: Array.from({ length: 12 }, (_, cell) => `fred:A${table}${cell}`),
			})),
		);
		const wideResponse = await harness.call("PUT", "/home/dashboard", {
			dashboard: wide,
			expectedVersion: 0,
		});
		expect(wideResponse.status).toBe(400);
		expect(await errorCode(wideResponse)).toBe("VALIDATION_FAILED");
		// Bad series id.
		const badId = await harness.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([metricWidget("w-1", "nope")]),
			expectedVersion: 0,
		});
		expect(badId.status).toBe(400);
		// Duplicate series inside one widget.
		const dup = await harness.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([
				{
					type: "line-chart",
					widgetId: "w-1",
					title: "Dup",
					size: "medium",
					seriesIds: ["fred:VIXCLS", "fred:VIXCLS"],
					range: "1y",
				},
			]),
			expectedVersion: 0,
		});
		expect(dup.status).toBe(400);
		// Duplicate widget ids.
		const dupIds = await harness.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([metricWidget("w-1"), metricWidget("w-1", "fred:DGS10")]),
			expectedVersion: 0,
		});
		expect(dupIds.status).toBe(400);
	});

	it("scopes dashboards per owner and defends writes with CSRF", async () => {
		const first = createHarness();
		const second = createHarness();
		await first.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([metricWidget("w-1")]),
			expectedVersion: 0,
		});
		const other = await body(
			await second.call("GET", "/home/dashboard"),
			homeDashboardResponseSchema,
		);
		expect(other.origin).toBe("defaults");
		const csrf = await first.raw("PUT", "/home/dashboard", {
			body: { dashboard: dashboardWith([metricWidget("w-1")]), expectedVersion: 1 },
			headers: { Origin: "http://localhost" },
		});
		expect(csrf.status).toBe(403);
		expect(await errorCode(csrf)).toBe("CSRF_REJECTED");
	});

	it("records an audit row with ids only", async () => {
		const harness = createHarness();
		await harness.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([metricWidget("w-1")]),
			expectedVersion: 0,
		});
		const rows = await env.DB.prepare(
			"SELECT action, detail FROM audit_log WHERE owner_id = ? AND action = ?",
		)
			.bind(harness.ownerId, "home.dashboard.update")
			.all<{ action: string; detail: string }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]?.detail).toBe("widgets=1");
	});

	it("V2: an unreadable stored dashboard fails closed, and reset is the way out", async () => {
		const harness = createHarness();
		await env.DB.prepare(
			"INSERT INTO home_dashboards (owner_id, dashboard_json, version, updated_at) VALUES (?, ?, 1, ?)",
		)
			.bind(harness.ownerId, "{not json", harness.time.clock.nowIso())
			.run();
		const failed = await harness.call("GET", "/home/dashboard");
		expect(failed.status).toBe(500);
		expect(await errorCode(failed)).toBe("STORED_DASHBOARD_UNREADABLE");
		const dataFailed = await harness.call("GET", "/home/data");
		expect(dataFailed.status).toBe(500);
		expect(await errorCode(dataFailed)).toBe("STORED_DASHBOARD_UNREADABLE");
		// Reset needs no expectedVersion: it replaces the stored document.
		const reset = await body(
			await harness.call("POST", "/home/dashboard/reset"),
			homeDashboardResponseSchema,
		);
		expect(reset.origin).toBe("saved");
		expect(reset.dashboard.widgets).toHaveLength(7);
		const reread = await body(
			await harness.call("GET", "/home/dashboard"),
			homeDashboardResponseSchema,
		);
		expect(reread.dashboard).toEqual(reset.dashboard);
		expect(reread.version).toBe(reset.version);
	});
});

describe("home catalog and data", () => {
	it("serves the curated catalog", async () => {
		const harness = createHarness();
		const catalog = await body(
			await harness.call("GET", "/home/catalog"),
			marketCatalogResponseSchema,
		);
		const ids = catalog.entries.map((entry) => entry.seriesId);
		for (const expected of [
			"fred:VIXCLS",
			"fred:DGS10",
			"fred:SP500",
			"twelve-data:XAU/USD",
			"twelve-data:AAPL",
		]) {
			expect(ids).toContain(expected);
		}
	});

	it("reports never-refreshed series before any refresh", async () => {
		const harness = createHarness();
		const data = await body(await harness.call("GET", "/home/data"), homeDataResponseSchema);
		expect(data.series.length).toBeGreaterThan(0);
		for (const entry of data.series) {
			expect(entry.observations).toEqual([]);
			expect(entry.unavailable?.code).toBe("NEVER_REFRESHED");
		}
		expect(data.refresh).toEqual({
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: null,
		});
	});

	it("answers 304 when the data is unchanged", async () => {
		const harness = createHarness();
		const first = await harness.call("GET", "/home/data");
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		const second = await harness.call("GET", "/home/data", undefined, {
			"If-None-Match": etag ?? "",
		});
		expect(second.status).toBe(304);
	});
});

describe("market refresh (FR-017)", () => {
	it("de-duplicates: one active run per owner", async () => {
		const harness = createHarness();
		const first = await refresh(harness);
		const second = await refresh(harness);
		expect(second).toBe(first);
	});

	it("S1: two concurrent creations with different keys yield a single active job", async () => {
		const harness = createHarness();
		// Issued together: without the INSERT-level guard both would pass the
		// active-run check before either inserts. Runs on both persistence
		// drivers (workers D1 + api-sqlite projects run this same file).
		const [first, second] = await Promise.all([
			harness.call("POST", "/home/refresh", undefined, idempotencyKey()),
			harness.call("POST", "/home/refresh", undefined, idempotencyKey()),
		]);
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		const firstRun = (await body(first, researchRunResponseSchema)).run.runId;
		const secondRun = (await body(second, researchRunResponseSchema)).run.runId;
		expect(secondRun).toBe(firstRun);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = 'market-refresh'",
		)
			.bind(harness.ownerId)
			.all<{ n: number }>();
		expect(rows.results[0]?.n).toBe(1);
	});

	it("S1: retrying a failed market run while another is active maps to the active run", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const runId = await refresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		// Fail the run without retry allowance left is awkward; instead fail a
		// first run, queue a second, then retry the first: the retry must not
		// create a third job.
		await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "failed",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			failureCode: "SOURCE_FAILED",
			retryable: false,
		});
		const second = await refresh(harness);
		const retried = await harness.call(
			"POST",
			`/research-runs/${runId}/retry`,
			undefined,
			idempotencyKey(),
		);
		expect(retried.status).toBe(202);
		expect((await body(retried, researchRunResponseSchema)).run.runId).toBe(second);
		const rows = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = 'market-refresh' AND state NOT IN (${TERMINAL_JOB_STATES.map((state) => `'${state}'`).join(", ")})`,
		)
			.bind(harness.ownerId)
			.all<{ n: number }>();
		expect(rows.results[0]?.n).toBe(1);
	});

	it("claims the dashboard series with their stored watermarks", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const runId = await refresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh" || job.runId !== runId) {
			throw new Error("expected the market-refresh job");
		}
		const ids = job.series.map((entry) => entry.seriesId);
		expect(ids).toContain("fred:VIXCLS");
		expect(ids).toContain("twelve-data:AAPL");
		for (const entry of job.series) {
			expect(entry.latestObservedOn).toBeNull();
		}
	});

	it("runs claim -> complete -> data end to end", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const runId = await refresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "market-refreshed",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			series: [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: { ...VIX_META },
					observations: [
						["2026-10-01", 15.2],
						["2026-10-02", 15.8],
					],
					errorCode: null,
				},
				{
					seriesId: "twelve-data:AAPL",
					fetchedAt: harness.time.clock.nowIso(),
					meta: null,
					observations: [],
					errorCode: "SOURCE_NOT_CONFIGURED",
				},
			],
		});
		expect(completed.status).toBe(200);
		expect((await body(completed, completeJobResponseSchema)).replayed).toBe(false);
		const data = await body(await harness.call("GET", "/home/data"), homeDataResponseSchema);
		const vix = data.series.find((entry) => entry.seriesId === "fred:VIXCLS");
		expect(vix?.observations).toEqual([
			["2026-10-01", 15.2],
			["2026-10-02", 15.8],
		]);
		expect(vix?.unavailable).toBeNull();
		expect(vix?.unit).toBe("Index");
		const aapl = data.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		expect(aapl?.observations).toEqual([]);
		expect(aapl?.unavailable?.code).toBe("SOURCE_NOT_CONFIGURED");
		expect(data.refresh.activeRunId).toBeNull();
		expect(data.refresh.lastSucceededAt).not.toBeNull();
		expect(data.refresh.lastFailure).toBeNull();
	});

	it("S4a: a completion stores only the current dashboard's series, counting the rest", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const runId = await refresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		expect(job.series.map((entry) => entry.seriesId)).toContain("fred:VIXCLS");
		// The owner removes VIXCLS while the refresh is running.
		const kept = await harness.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([metricWidget("w-aapl", "twelve-data:AAPL")]),
			expectedVersion: 0,
		});
		expect(kept.status).toBe(200);
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${runId}/complete`, {
			...marketCompletion(job, [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: { ...VIX_META },
					observations: [["2026-10-01", 15.2]],
					errorCode: null,
				},
				{
					seriesId: "twelve-data:AAPL",
					fetchedAt: harness.time.clock.nowIso(),
					meta: null,
					observations: [],
					errorCode: "SOURCE_NOT_CONFIGURED",
				},
			]),
		});
		expect(completed.status).toBe(200);
		const stored = await env.DB.prepare(
			"SELECT series_id AS id FROM market_series WHERE owner_id = ?",
		)
			.bind(harness.ownerId)
			.all<{ id: string }>();
		expect(stored.results.map((row) => row.id).sort()).toEqual(["twelve-data:AAPL"]);
		const audits = await env.DB.prepare(
			"SELECT reason FROM job_transitions WHERE owner_id = ? AND run_id = ? AND to_state = 'completed'",
		)
			.bind(harness.ownerId, runId)
			.all<{ reason: string }>();
		expect(audits.results.map((row) => row.reason).join(" ")).toContain(
			"dropped 1 off-dashboard series",
		);
	});

	it("reports the stored watermark on the next claim", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await refresh(harness);
		const first = await claim(harness, token);
		if (first?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		await advanceToPublishing(harness, token, first);
		await harness.runner(token, `/jobs/${first.runId}/complete`, {
			outcome: "market-refreshed",
			leaseGeneration: first.leaseGeneration,
			usage: USAGE,
			series: [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: { ...VIX_META },
					observations: [["2026-10-02", 15.8]],
					errorCode: null,
				},
			],
		});
		await refresh(harness);
		const second = await claim(harness, token);
		if (second?.kind !== "market-refresh") throw new Error("expected the second job");
		expect(second.series.find((entry) => entry.seriesId === "fred:VIXCLS")?.latestObservedOn).toBe(
			"2026-10-02",
		);
	});

	it("rejects a stale generation and replays a duplicate completion", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const runId = await refresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		await advanceToPublishing(harness, token, job);
		const stale = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "market-refreshed",
			leaseGeneration: job.leaseGeneration + 1,
			usage: USAGE,
			series: [],
		});
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("STALE_LEASE");
		const payload = marketCompletion(job, [
			{
				seriesId: "fred:VIXCLS",
				fetchedAt: harness.time.clock.nowIso(),
				meta: { ...VIX_META },
				observations: [["2026-10-02", 15.8]],
				errorCode: null,
			},
		]);
		const first = await harness.runner(token, `/jobs/${runId}/complete`, payload);
		expect((await body(first, completeJobResponseSchema)).replayed).toBe(false);
		const replay = await harness.runner(token, `/jobs/${runId}/complete`, payload);
		expect((await body(replay, completeJobResponseSchema)).replayed).toBe(true);
		const data = await body(await harness.call("GET", "/home/data"), homeDataResponseSchema);
		expect(
			data.series.find((entry) => entry.seriesId === "fred:VIXCLS")?.observations,
		).toHaveLength(1);
	});

	it("rejects an outcome that does not match the job kind", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const runId = await refresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		const wrong = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "ingested",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			articles: [],
			sourceReports: [],
		});
		expect(wrong.status).toBe(400);
		expect(await errorCode(wrong)).toBe("VALIDATION_FAILED");
		// And a market outcome on a research run is rejected the same way.
		const workspaceId = await createWorkspace(harness);
		const research = await claim(harness, token);
		expect(research).toBeNull();
		const queued = await harness.call(
			"POST",
			"/research-runs",
			{
				workspaceId,
				question: "Which products will see demand growth?",
				agentId: "claude-code",
				model: null,
				effort: "medium",
				horizonYears: 4,
				markets: ["JP", "US"],
				budget: {
					maxAgentSteps: 6,
					maxToolCalls: 20,
					maxWallClockMs: 600_000,
					maxInputBytes: 400_000,
					maxSpendUsd: null,
				},
				webAccess: "off",
			},
			idempotencyKey(),
		);
		expect(queued.status).toBe(202);
		// The market job is still claimed by this runner's earlier claim; finish it first.
		await advanceToPublishing(harness, token, job);
		await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			marketCompletion(job, [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: { ...VIX_META },
					observations: [],
					errorCode: "NO_DATA",
				},
			]),
		);
		const researchJob = await claim(harness, token);
		if (researchJob?.kind !== "research") throw new Error("expected the research job");
		const mismatch = await harness.runner(token, `/jobs/${researchJob.runId}/complete`, {
			outcome: "market-refreshed",
			leaseGeneration: researchJob.leaseGeneration,
			usage: USAGE,
			series: [],
		});
		expect(mismatch.status).toBe(400);
		expect(await errorCode(mismatch)).toBe("VALIDATION_FAILED");
	});

	it("keeps old observations when a later refresh fails the series", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await refresh(harness);
		const first = await claim(harness, token);
		if (first?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		await advanceToPublishing(harness, token, first);
		await harness.runner(
			token,
			`/jobs/${first.runId}/complete`,
			marketCompletion(first, [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: { ...VIX_META },
					observations: [
						["2026-10-01", 15.2],
						["2026-10-02", 15.8],
					],
					errorCode: null,
				},
			]),
		);
		await refresh(harness);
		const second = await claim(harness, token);
		if (second?.kind !== "market-refresh") throw new Error("expected the second job");
		await advanceToPublishing(harness, token, second);
		harness.time.advance(1000);
		await harness.runner(
			token,
			`/jobs/${second.runId}/complete`,
			marketCompletion(second, [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: harness.time.clock.nowIso(),
					meta: null,
					observations: [],
					errorCode: "SOURCE_FAILED",
				},
			]),
		);
		const data = await body(await harness.call("GET", "/home/data"), homeDataResponseSchema);
		const vix = data.series.find((entry) => entry.seriesId === "fred:VIXCLS");
		expect(vix?.observations).toEqual([
			["2026-10-01", 15.2],
			["2026-10-02", 15.8],
		]);
		expect(vix?.unavailable?.code).toBe("SOURCE_FAILED");
		expect(vix?.title).toBe("VIX");
	});

	it("prunes stored observations to 1,500 per series", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const day = (offset: number) => {
			const ms = Date.UTC(2020, 0, 1) + offset * 86_400_000;
			return new Date(ms).toISOString().slice(0, 10);
		};
		for (const batch of [0, 1]) {
			await refresh(harness);
			const job = await claim(harness, token);
			if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
			await advanceToPublishing(harness, token, job);
			const observations = Array.from(
				{ length: 800 },
				(_, index) => [day(batch * 800 + index), 100 + index] as [string, number],
			);
			const response = await harness.runner(
				token,
				`/jobs/${job.runId}/complete`,
				marketCompletion(job, [
					{
						seriesId: "fred:VIXCLS",
						fetchedAt: harness.time.clock.nowIso(),
						meta: { ...VIX_META },
						observations,
						errorCode: null,
					},
				]),
			);
			expect(response.status).toBe(200);
		}
		expect(await observationCount(harness.ownerId)).toBe(1500);
		const data = await body(await harness.call("GET", "/home/data"), homeDataResponseSchema);
		const vix = data.series.find((entry) => entry.seriesId === "fred:VIXCLS");
		// The API serves the newest 800; the oldest kept is day 100 of 1,600.
		expect(vix?.observations).toHaveLength(800);
		expect(vix?.observations[0]?.[0]).toBe(day(800));
	});

	it("reads a stored version-1 dashboard as version 2 (ADR-0024), and the next save writes 2", async () => {
		const harness = createHarness();
		await harness.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([metricWidget("w-1")]),
			expectedVersion: 0,
		});
		// The row as a release before ADR-0024 wrote it: `metric` was the live series.
		const legacy = {
			schemaVersion: 1,
			widgets: [
				{ type: "metric", widgetId: "w-1", title: "VIX", size: "small", seriesId: "fred:VIXCLS" },
			],
		};
		await env.DB.prepare("UPDATE home_dashboards SET dashboard_json = ? WHERE owner_id = ?")
			.bind(JSON.stringify(legacy), harness.ownerId)
			.run();
		const read = await body(
			await harness.call("GET", "/home/dashboard"),
			homeDashboardResponseSchema,
		);
		expect(read.dashboard.schemaVersion).toBe(2);
		expect(read.dashboard.widgets[0]?.type).toBe("market-metric");
		const saved = await harness.call("PUT", "/home/dashboard", {
			dashboard: read.dashboard,
			expectedVersion: read.version,
		});
		expect(saved.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT dashboard_json FROM home_dashboards WHERE owner_id = ?",
		)
			.bind(harness.ownerId)
			.first<{ dashboard_json: string }>();
		expect(JSON.parse(row?.dashboard_json ?? "{}")).toMatchObject({ schemaVersion: 2 });
		// A version-1 PUT is refused: only the stored form is upgraded.
		const legacyPut = await harness.call("PUT", "/home/dashboard", {
			dashboard: legacy,
			expectedVersion: read.version + 1,
		});
		expect(legacyPut.status).toBe(400);
	});

	it("fails a stored dashboard that no longer parses instead of replacing it", async () => {
		const harness = createHarness();
		await harness.call("PUT", "/home/dashboard", {
			dashboard: dashboardWith([metricWidget("w-1")]),
			expectedVersion: 0,
		});
		await env.DB.prepare("UPDATE home_dashboards SET dashboard_json = ? WHERE owner_id = ?")
			.bind("not json", harness.ownerId)
			.run();
		// V2 changed the fail-closed code from INTERNAL to the stable
		// STORED_DASHBOARD_UNREADABLE (still 500) with a reset way out.
		const response = await harness.call("GET", "/home/dashboard");
		expect(response.status).toBe(500);
		expect(await errorCode(response)).toBe("STORED_DASHBOARD_UNREADABLE");
	});
});

describe("market claim edge cases", () => {
	it("uses the runner claim body with agents like every other job", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await refresh(harness);
		const response = await harness.runner(token, "/jobs/claim", CLAIM_BODY);
		expect(response.status).toBe(200);
	});

	it("walks state events through the leased states", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await refresh(harness);
		const job = await claim(harness, token);
		if (job === null) throw new Error("expected a job");
		const events = await harness.runner(token, `/jobs/${job.runId}/events`, {
			leaseGeneration: job.leaseGeneration,
			events: TO_PUBLISHING.map((state, index) => ({
				seq: index,
				at: harness.time.clock.nowIso(),
				event: { type: "state", state },
			})),
		});
		expect(events.status).toBe(200);
	});

	it("queues a research run while a market refresh is active", async () => {
		const harness = createHarness();
		await refresh(harness);
		const workspaceId = await createWorkspace(harness);
		const queued = await harness.call(
			"POST",
			"/research-runs",
			{
				workspaceId,
				question: "Which products will see demand growth?",
				agentId: "claude-code",
				model: null,
				effort: "medium",
				horizonYears: 4,
				markets: ["JP", "US"],
				budget: {
					maxAgentSteps: 6,
					maxToolCalls: 20,
					maxWallClockMs: 600_000,
					maxInputBytes: 400_000,
					maxSpendUsd: null,
				},
				webAccess: "off",
			},
			idempotencyKey(),
		);
		expect(queued.status).toBe(202);
	});
});
