/**
 * Daily bars through the routes (ADR-0056 §3, §4) on real persistence
 * (workerd D1 and `node:sqlite`): a `market-refreshed` completion stores each
 * observation's `[open, high, low, volume]`, every read that carries the
 * series' observations — `GET /home/data`, a notebook's market data and
 * `GET /stocks/:stockId/prices` — sends it as the third tuple element, a day
 * without one stays `[observedOn, value]` (never a null bar), a bar
 * inconsistent with its close is refused, and a later answer without bars
 * (a runner from before ADR-0056) leaves those days close-only.
 */
import { homeDataResponseSchema, stockPricesResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	claim,
	createHarness,
	createWorkspace,
	errorCode,
	type Harness,
	issueRunnerToken,
	queueRefreshJob,
	USAGE,
} from "./helpers.ts";

const SERIES_ID = "twelve-data:MSFT";
const NOW = "2026-10-14T00:00:00.000Z";

const MSFT_META = {
	title: "Microsoft Corporation",
	unit: "USD",
	frequency: "daily",
	publisher: "Twelve Data",
	sourceUrl: "https://twelvedata.com/",
} as const;

async function trackOnHome(harness: Harness): Promise<void> {
	const saved = await harness.call("PUT", "/home/dashboard", {
		dashboard: {
			schemaVersion: 2,
			widgets: [
				{
					type: "market-metric",
					widgetId: "w-msft",
					title: "Microsoft",
					size: "small",
					seriesId: SERIES_ID,
				},
			],
		},
		expectedVersion: 0,
	});
	expect(saved.status).toBe(200);
}

async function trackInNotebook(harness: Harness): Promise<string> {
	const workspaceId = await createWorkspace(harness);
	const saved = await harness.call("PUT", `/workspaces/${workspaceId}/notebook`, {
		notebook: {
			widgets: [
				{
					widgetId: "w-n",
					type: "market-metric",
					title: "Microsoft",
					size: "small",
					seriesId: SERIES_ID,
					createdAt: NOW,
					updatedAt: NOW,
					revision: 1,
					origin: { kind: "owner", messageId: null, runId: null, componentId: null },
				},
			],
		},
		expectedVersion: 0,
	});
	expect(saved.status).toBe(200);
	return workspaceId;
}

/** Claims a market refresh and completes it with these observations (raw wire tuples). */
async function refresh(
	harness: Harness,
	token: string,
	observations: readonly unknown[],
	history: unknown = { mode: "full", replaceFrom: null },
): Promise<Response> {
	await queueRefreshJob(harness, "market-refresh");
	const job = await claim(harness, token);
	if (job?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
	await advanceToPublishing(harness, token, job);
	return harness.runner(token, `/jobs/${job.runId}/complete`, {
		outcome: "market-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: USAGE,
		series: [
			{
				seriesId: SERIES_ID,
				fetchedAt: harness.time.clock.nowIso(),
				meta: { ...MSFT_META },
				observations,
				errorCode: null,
				history,
			},
		],
	});
}

/** The series' observations exactly as the response body carries them. */
async function rawObservations(response: Response): Promise<unknown> {
	expect(response.status).toBe(200);
	const payload: unknown = await response.json();
	const series =
		typeof payload === "object" && payload !== null && "series" in payload ? payload.series : null;
	const entry = Array.isArray(series)
		? series.find(
				(item: unknown) =>
					typeof item === "object" &&
					item !== null &&
					"seriesId" in item &&
					item.seriesId === SERIES_ID,
			)
		: series;
	return typeof entry === "object" && entry !== null && "observations" in entry
		? entry.observations
		: undefined;
}

const ANSWERED = [
	["2026-10-12", 410.5, [405.25, 412, 404.75, 18_500_000]],
	["2026-10-13", 412, [410.5, 413.5, 409, null]],
	["2026-10-14", 415.25],
] as const;

describe("market observation bars (ADR-0056)", () => {
	it("stores each completion's bars and sends them on Home, the notebook and the Stocks page", async () => {
		const harness = createHarness();
		await trackOnHome(harness);
		const workspaceId = await trackInNotebook(harness);
		const token = await issueRunnerToken(harness);
		expect((await refresh(harness, token, ANSWERED)).status).toBe(200);

		// The raw bodies: a close-only day is a two-element tuple, never a null bar.
		const expected = ANSWERED.map((tuple) => [...tuple]);
		expect(await rawObservations(await harness.call("GET", "/home/data"))).toEqual(expected);
		expect(
			await rawObservations(
				await harness.call("GET", `/workspaces/${workspaceId}/notebook/market-data`),
			),
		).toEqual(expected);
		expect(await rawObservations(await harness.call("GET", "/stocks/us:MSFT/prices"))).toEqual(
			expected,
		);
		// And they parse with the contract schemas the SPA uses.
		const home = await body(await harness.call("GET", "/home/data"), homeDataResponseSchema);
		expect(home.series[0]?.observations[0]).toEqual(ANSWERED[0].map((part) => part));
		const prices = await body(
			await harness.call("GET", "/stocks/us:MSFT/prices"),
			stockPricesResponseSchema,
		);
		expect(prices.series?.observations.at(-1)).toEqual(["2026-10-14", 415.25]);
	});

	it.each([
		// The close 420 is above the bar's high 412.
		["a close above the high", ["2026-10-12", 420, [405, 412, 404, 1]]],
		["a negative volume", ["2026-10-12", 410, [405, 412, 404, -1]]],
		["a bar sent as null", ["2026-10-12", 410, null]],
	])("refuses an observation with %s", async (_, observation) => {
		const harness = createHarness();
		await trackOnHome(harness);
		const token = await issueRunnerToken(harness);
		const refused = await refresh(harness, token, [observation]);
		expect(refused.status).toBe(400);
		expect(await errorCode(refused)).toBe("VALIDATION_FAILED");
	});

	it("replaces a stored bar with the newer answer, close-only when it carries none", async () => {
		const harness = createHarness();
		await trackOnHome(harness);
		const token = await issueRunnerToken(harness);
		expect((await refresh(harness, token, ANSWERED)).status).toBe(200);
		harness.time.advance(60 * 60 * 1000);
		// A runner from before ADR-0056 answers the same days without bars;
		// one day also gets a newer bar from a current runner's answer shape.
		const later = [
			["2026-10-12", 410.5],
			["2026-10-13", 412, [411, 414, 410, 9_000_000]],
			["2026-10-14", 415.25],
		];
		expect(
			(await refresh(harness, token, later, { mode: "window", replaceFrom: "2026-10-12" })).status,
		).toBe(200);
		expect(await rawObservations(await harness.call("GET", "/home/data"))).toEqual(later);
	});
});
