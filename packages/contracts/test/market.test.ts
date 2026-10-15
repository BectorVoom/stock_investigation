import { applyDashboardEdit } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	claimedJobSchema,
	completeJobRequestSchema,
	DEFAULT_HOME_DASHBOARD,
	formatMarketSeriesId,
	HOME_WIDGET_TYPES,
	type HomeDashboard,
	homeDashboardResponseSchema,
	homeDashboardSchema,
	homeDataResponseSchema,
	jobKindSchema,
	MARKET_LIMITS,
	marketCatalogResponseSchema,
	marketObservationSchema,
	marketProviderIdSchema,
	marketRangeSchema,
	marketSeriesIdSchema,
	marketSeriesSchema,
	marketUnavailable,
	marketUnavailableReason,
	marketUnavailableSchema,
	parseMarketSeriesId,
	putHomeDashboardRequestSchema,
	WIDGET_SIZES,
	WIDGET_TYPE_META,
} from "../src/index.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

const metricWidget = {
	type: "market-metric",
	widgetId: "w-1",
	title: "VIX",
	size: "small",
	seriesId: "fred:VIXCLS",
} as const;

const dashboard = {
	schemaVersion: 2,
	widgets: [metricWidget],
} as const;

describe("market series ids", () => {
	it("accepts FRED and Twelve Data ids and rejects bad ones", () => {
		for (const id of [
			"fred:VIXCLS",
			"fred:DGS10",
			"twelve-data:AAPL",
			"twelve-data:XAU/USD",
			"twelve-data:7203:JPX",
		]) {
			expectAccepted(marketSeriesIdSchema, id);
		}
		for (const id of ["VIXCLS", "fred:", "fred:vix", "nasdaq:AAPL", "twelve-data:", ""]) {
			expectRejected(marketSeriesIdSchema, id);
		}
	});

	it("parses into provider and symbol and formats back", () => {
		expect(parseMarketSeriesId("fred:VIXCLS")).toEqual({ provider: "fred", symbol: "VIXCLS" });
		expect(parseMarketSeriesId("twelve-data:XAU/USD")).toEqual({
			provider: "twelve-data",
			symbol: "XAU/USD",
		});
		expect(parseMarketSeriesId("nope")).toBeNull();
		expect(formatMarketSeriesId("fred", "VIXCLS")).toBe("fred:VIXCLS");
	});

	it("knows the two providers and the ranges", () => {
		expectAccepted(marketProviderIdSchema, "fred");
		expectAccepted(marketProviderIdSchema, "twelve-data");
		expectRejected(marketProviderIdSchema, "bloomberg");
		for (const range of ["1m", "3m", "6m", "1y", "3y", "max"]) {
			expectAccepted(marketRangeSchema, range);
		}
		expectRejected(marketRangeSchema, "1d");
	});
});

describe("market observations and unavailable", () => {
	it("uses the tuple wire format", () => {
		expectAccepted(marketObservationSchema, ["2026-10-01", 12.5]);
		expectRejected(marketObservationSchema, ["2026-10-01", Number.NaN]);
		expectRejected(marketObservationSchema, ["10/01/2026", 12.5]);
	});

	it("pins every code to fixed wording", () => {
		for (const code of [
			"NEVER_REFRESHED",
			"SOURCE_NOT_CONFIGURED",
			"SOURCE_AUTH_FAILED",
			"SERIES_NOT_FOUND",
			"PLAN_NOT_ENTITLED",
			"RATE_LIMITED",
			"NO_DATA",
			"SOURCE_FAILED",
		] as const) {
			const unavailable = marketUnavailable(code);
			expectAccepted(marketUnavailableSchema, unavailable);
			expect(unavailable.reason.length).toBeLessThanOrEqual(300);
		}
		expectRejected(marketUnavailableSchema, { code: "BROKEN", reason: "x" });
		expect(marketUnavailableReason("SOURCE_NOT_CONFIGURED", "fred")).toContain("FRED_API_KEY");
		expect(marketUnavailableReason("SOURCE_NOT_CONFIGURED", "twelve-data")).toContain(
			"TWELVE_DATA_API_KEY",
		);
	});
});

describe("market series", () => {
	const series = {
		seriesId: "fred:VIXCLS",
		provider: "fred",
		symbol: "VIXCLS",
		title: "VIX",
		unit: "Index",
		frequency: "daily",
		publisher: "Federal Reserve Bank of St. Louis (FRED)",
		sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
		lastRefreshedAt: "2026-10-11T00:00:00.000Z",
		retrievedAt: "2026-10-11T00:00:00.000Z",
		unavailable: null,
		observations: [["2026-10-01", 15.2]],
	} as const;

	it("accepts a full series and caps observations at 800", () => {
		expectAccepted(marketSeriesSchema, series);
		expectRejected(
			marketSeriesSchema,
			{ ...series, observations: repeat(["2026-10-01", 1] as unknown as never, 801) },
			["observations"],
		);
	});
});

describe("home dashboard", () => {
	it("accepts the default dashboard", () => {
		const parsed = expectAccepted(homeDashboardSchema, DEFAULT_HOME_DASHBOARD);
		expect(parsed.widgets).toHaveLength(7);
	});

	it("rejects duplicate widget ids, too many widgets and too many series", () => {
		expectRejected(
			homeDashboardSchema,
			{ schemaVersion: 2, widgets: [metricWidget, metricWidget] },
			["widgets"],
		);
		expectRejected(
			homeDashboardSchema,
			{
				schemaVersion: 2,
				widgets: repeat({ ...metricWidget, widgetId: "w", seriesId: "fred:VIXCLS" }, 25).map(
					(widget, index) => ({ ...widget, widgetId: `w-${index}` }),
				),
			},
			["widgets"],
		);
		const wide = {
			schemaVersion: 2,
			widgets: Array.from({ length: 3 }, (_, index) => ({
				type: "indicator-table",
				widgetId: `w-${index}`,
				title: `Table ${index}`,
				size: "large",
				seriesIds: Array.from({ length: 12 }, (_, cell) => `fred:A${index}${cell}`),
			})),
		};
		// 36 distinct series > 30.
		expectRejected(homeDashboardSchema, wide, ["widgets"]);
	});

	it("rejects bad series ids and duplicate series inside one widget", () => {
		expectRejected(
			homeDashboardSchema,
			{ schemaVersion: 2, widgets: [{ ...metricWidget, seriesId: "nope" }] },
			["widgets"],
		);
		expectRejected(
			homeDashboardSchema,
			{
				schemaVersion: 2,
				widgets: [
					{
						type: "line-chart",
						widgetId: "w-1",
						title: "Dup",
						size: "medium",
						seriesIds: ["fred:VIXCLS", "fred:VIXCLS"],
						range: "1y",
					},
				],
			},
			["widgets"],
		);
	});

	it("enforces widget title length", () => {
		expectRejected(
			homeDashboardSchema,
			{ schemaVersion: 2, widgets: [{ ...metricWidget, title: "" }] },
			["widgets"],
		);
		expectRejected(
			homeDashboardSchema,
			{ schemaVersion: 2, widgets: [{ ...metricWidget, title: "x".repeat(121) }] },
			["widgets"],
		);
		// One title rule for every widget on every page (ADR-0024): 120 characters.
		expectAccepted(homeDashboardSchema, {
			schemaVersion: 2,
			widgets: [{ ...metricWidget, title: "x".repeat(120) }],
		});
	});

	it("edits a HomeDashboard through the domain editor with its own widget type", () => {
		// The web calls applyDashboardEdit and PUTs the result: the edited
		// dashboard must already be a HomeDashboard, with no cast or re-parse.
		const removed = applyDashboardEdit(DEFAULT_HOME_DASHBOARD, {
			kind: "remove",
			widgetId: "w-vix",
		});
		if (!removed.ok) throw new Error("expected the edit to apply");
		const dashboard: HomeDashboard = removed.value;
		expect(dashboard.widgets.map((widget) => widget.widgetId)).not.toContain("w-vix");
		expectAccepted(homeDashboardSchema, dashboard);
	});

	it("checks the API shapes", () => {
		expectAccepted(homeDashboardResponseSchema, {
			dashboard,
			version: 0,
			updatedAt: null,
			origin: "defaults",
		});
		expectAccepted(putHomeDashboardRequestSchema, { dashboard, expectedVersion: 0 });
		expectAccepted(homeDataResponseSchema, {
			series: [],
			refresh: {
				activeRunId: null,
				activeRunState: null,
				lastSucceededAt: null,
				lastFailure: null,
			},
		});
		expectAccepted(homeDataResponseSchema, {
			series: [],
			refresh: {
				activeRunId: "run_1",
				activeRunState: "pending",
				lastSucceededAt: "2026-10-11T00:00:00.000Z",
				lastFailure: { state: "failed", code: "SOURCE_FAILED", at: "2026-10-12T12:00:00.000Z" },
			},
		});
		expectAccepted(marketCatalogResponseSchema, {
			entries: [
				{
					seriesId: "fred:VIXCLS",
					label: "VIX Index",
					category: "volatility",
					description: "A description.",
				},
			],
		});
		expect(marketCatalogResponseSchema.parse({ entries: [] }).entries).toEqual([]);
		expect(MARKET_LIMITS.maxWidgets).toBe(24);
		expect(without(metricWidget, "title")).toBeDefined();
	});
});

describe("home widget type metadata", () => {
	it("covers every widget type with a label, a description, a valid default size and all sizes", () => {
		// ADR-0024: Home takes every type of the one specification but `research`.
		expect([...HOME_WIDGET_TYPES].sort()).toEqual([
			"chart",
			"earnings-calendar",
			"indicator-table",
			"line-chart",
			"market-metric",
			"metric",
			"stock-table",
			"table",
			"text",
		]);
		expect([...WIDGET_SIZES].sort()).toEqual(["large", "medium", "small"]);
		for (const type of HOME_WIDGET_TYPES) {
			const meta = WIDGET_TYPE_META[type];
			expect(meta.label.trim().length).toBeGreaterThan(0);
			expect(meta.description.trim().length).toBeGreaterThan(0);
			expect(WIDGET_SIZES).toContain(meta.defaultSize);
			expect([...meta.sizes].sort()).toEqual(["large", "medium", "small"]);
		}
	});
});

describe("market-refresh jobs", () => {
	it("knows the market-refresh kind", () => {
		expectAccepted(jobKindSchema, "market-refresh");
		expectRejected(jobKindSchema, "shell");
	});

	it("claims a market-refresh job with its series", () => {
		expectAccepted(claimedJobSchema, {
			kind: "market-refresh",
			runId: "run_1",
			leaseGeneration: 1,
			leaseExpiresAt: "2026-10-11T00:01:30.000Z",
			attempt: 1,
			heartbeatIntervalMs: 20_000,
			sources: [],
			series: [{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-01" }],
		});
		expectRejected(claimedJobSchema, {
			kind: "market-refresh",
			runId: "run_1",
			leaseGeneration: 1,
			leaseExpiresAt: "2026-10-11T00:01:30.000Z",
			attempt: 1,
			heartbeatIntervalMs: 20_000,
			sources: [],
			// ADR-0021: the claim carries the dashboard union notebooks'
			// series, at most maxTrackedSeries (60).
			series: repeat({ seriesId: "fred:VIXCLS", latestObservedOn: null }, 61),
		});
		expectAccepted(claimedJobSchema, {
			kind: "market-refresh",
			runId: "run_1",
			leaseGeneration: 1,
			leaseExpiresAt: "2026-10-11T00:01:30.000Z",
			attempt: 1,
			heartbeatIntervalMs: 20_000,
			sources: [],
			series: repeat({ seriesId: "fred:VIXCLS", latestObservedOn: null }, 60),
		});
	});

	it("completes with market-refreshed: meta xor error, errors carry no observations", () => {
		const base = {
			outcome: "market-refreshed",
			leaseGeneration: 1,
			usage: {
				agentSteps: 0,
				toolCalls: 0,
				inputBytes: 0,
				knownCostUsd: 0,
				hasUnmeteredUsage: false,
			},
		} as const;
		expectAccepted(completeJobRequestSchema, {
			...base,
			series: [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: "2026-10-11T00:00:00.000Z",
					meta: {
						title: "VIX",
						unit: "Index",
						frequency: "daily",
						publisher: "Federal Reserve Bank of St. Louis (FRED)",
						sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
					},
					observations: [["2026-10-01", 15.2]],
					errorCode: null,
				},
				{
					seriesId: "twelve-data:AAPL",
					fetchedAt: "2026-10-11T00:00:00.000Z",
					meta: null,
					observations: [],
					errorCode: "SOURCE_NOT_CONFIGURED",
				},
			],
		});
		// Meta and error together are rejected.
		expectRejected(completeJobRequestSchema, {
			...base,
			series: [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: "2026-10-11T00:00:00.000Z",
					meta: {
						title: "VIX",
						unit: "Index",
						frequency: "daily",
						publisher: "P",
						sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
					},
					observations: [],
					errorCode: "SOURCE_FAILED",
				},
			],
		});
		// An errored series with observations is rejected.
		expectRejected(completeJobRequestSchema, {
			...base,
			series: [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: "2026-10-11T00:00:00.000Z",
					meta: null,
					observations: [["2026-10-01", 15.2]],
					errorCode: "SOURCE_FAILED",
				},
			],
		});
		// More than 800 observations in one completion is rejected.
		expectRejected(completeJobRequestSchema, {
			...base,
			series: [
				{
					seriesId: "fred:VIXCLS",
					fetchedAt: "2026-10-11T00:00:00.000Z",
					meta: {
						title: "VIX",
						unit: "Index",
						frequency: "daily",
						publisher: "P",
						sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
					},
					observations: repeat(["2026-10-01", 1] as unknown as never, 801),
					errorCode: null,
				},
			],
		});
		// More than 60 series in one completion is rejected (ADR-0021).
		const failedSeries = {
			seriesId: "fred:VIXCLS",
			fetchedAt: "2026-10-11T00:00:00.000Z",
			meta: null,
			observations: [],
			errorCode: "SOURCE_NOT_CONFIGURED",
		} as const;
		expectRejected(completeJobRequestSchema, {
			...base,
			series: repeat(failedSeries, 61),
		});
		expectAccepted(completeJobRequestSchema, {
			...base,
			series: repeat(failedSeries, 60),
		});
	});
});
