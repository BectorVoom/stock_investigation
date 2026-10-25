import type { HomeDashboard } from "@research/contracts";
import { describe, expect, it, vi } from "vitest";
import { createHomeService, type HomeDataDigest, homeDataDigestEtag } from "../src/home.ts";
import type {
	AuditLog,
	HomeDashboardRepository,
	JobRepository,
	MarketRepository,
	NotebookRepository,
	StoredMarketObservation,
	StoredMarketSeries,
} from "../src/ports.ts";
import { fixedClock, recordsWith } from "./support.ts";

const OWNER = "owner_1";

function stubJobs(): JobRepository {
	const unused = (): never => {
		throw new Error("not used by the home service");
	};
	return {
		insert: unused,
		findByIdempotencyKey: unused,
		get: unused,
		list: unused,
		findLatestResearchRequest: unused,
		listClaimCandidates: unused,
		write: unused,
		writeWithEvents: unused,
		listProgress: unused,
		findActiveByKind: async () => null,
		findActiveNotebookAssist: async () => null,
		findLatestSuccessAtByKind: async () => null,
		findLatestFailureByKind: async () => null,
		findLatestFailedByKind: async () => null,
		countUnfinished: async () => 0,
	};
}

const AUDIT: AuditLog = { record: async () => {} };

const NOTEBOOKS: NotebookRepository = {
	get: async () => null,
	put: async () => "written",
	getRevision: async () => null,
	listTurns: async () => [],
	listMarketSeriesIds: async () => [],
	listWatchlistListIds: async () => [],
};

function serviceWith(dashboard: HomeDashboardRepository, market: MarketRepository) {
	return createHomeService({
		dashboard,
		market,
		jobs: stubJobs(),
		notebooks: NOTEBOOKS,
		watchlistLists: { membersOf: async () => new Map() },
		clock: fixedClock().clock,
		audit: AUDIT,
		records: recordsWith(),
	});
}

const VIX_META: StoredMarketSeries = {
	seriesId: "fred:VIXCLS",
	provider: "fred",
	symbol: "VIXCLS",
	title: "CBOE Volatility Index: VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis (FRED)",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
	lastRefreshedAt: "2026-10-11T00:00:00.000Z",
	retrievedAt: "2026-10-11T00:00:00.000Z",
	unavailableCode: null,
	unavailableUpstreamStatus: null,
};

function dashboardOf(widgets: HomeDashboard["widgets"]): HomeDashboardRepository {
	return {
		get: async () => ({
			dashboard: { schemaVersion: 2 as const, widgets },
			version: 1,
			updatedAt: null,
		}),
		put: async () => "written" as const,
		reset: async () => ({
			dashboard: { schemaVersion: 2 as const, widgets },
			version: 2,
			updatedAt: "2026-10-12T12:00:00.000Z",
		}),
	};
}

function marketOf(overrides?: Partial<MarketRepository>): MarketRepository {
	return {
		getSeriesMeta: async () => [],
		getRefreshState: async () => new Map(),
		getObservations: async () => [],
		deleteSeriesNotIn: async () => 0,
		...overrides,
	};
}

import type { UseCaseResult } from "../src/errors.ts";

/** Unwraps an ok Result or throws the failure code (tests fail on unexpected errors). */
function unwrapOk<T>(result: UseCaseResult<T>): T {
	if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
	return result.value;
}

describe("home getData (FR-017)", () => {
	it("fails closed on a stored series id that does not parse, instead of guessing a provider", async () => {
		// Type-valid but schema-invalid: the write path would never store this,
		// so reaching it means the stored row predates (or bypassed) validation.
		const dashboard = dashboardOf([
			{ type: "market-metric", widgetId: "w-bad", title: "Bad", size: "small", seriesId: "nope" },
		]);
		const market = marketOf();
		await expect(serviceWith(dashboard, market).getData(OWNER)).rejects.toThrow(
			"stored market series id failed validation",
		);
	});

	it("maps repository rows straight through in the order the SQL returned them", async () => {
		const dashboard = dashboardOf([
			{
				type: "market-metric",
				widgetId: "w-vix",
				title: "VIX",
				size: "small",
				seriesId: "fred:VIXCLS",
			},
		]);
		const stored: StoredMarketObservation[] = [
			{ seriesId: "fred:VIXCLS", observedOn: "2026-10-01", value: 15.2 },
			{ seriesId: "fred:VIXCLS", observedOn: "2026-10-02", value: 15.8 },
		];
		const getObservations = vi.fn(
			async (
				_ownerId: string,
				_seriesIds: readonly string[],
				_limitPerSeries: number,
			): Promise<readonly StoredMarketObservation[]> => stored,
		);
		const market: MarketRepository = {
			getSeriesMeta: async () => [VIX_META],
			getRefreshState: async () =>
				new Map([
					[
						"fred:VIXCLS",
						{ latestObservedOn: "2026-10-02", lastRefreshedAt: null, unavailableCode: null },
					],
				]),
			getObservations,
			deleteSeriesNotIn: async () => 0,
		};
		const data = unwrapOk(await serviceWith(dashboard, market).getData(OWNER));
		expect(data.series).toHaveLength(1);
		expect(data.series[0]?.observations).toEqual([
			["2026-10-01", 15.2],
			["2026-10-02", 15.8],
		]);
		expect(data.series[0]?.unavailable).toBeNull();
		// Bounded by the shared response limit, not a local number.
		expect(getObservations.mock.calls[0]?.[2]).toBe(800);
	});

	it("shows the catalog label — never the raw symbol — for a series with no provider metadata", async () => {
		// A refresh that failed before any success stores a placeholder row:
		// symbol as title, empty unit/publisher, unknown frequency, a failure
		// code and no retrievedAt (see marketStatements). The placeholder is
		// not provider metadata, so getData serves the catalog label (or the
		// symbol when the catalog has none), keeping the failure code.
		const failedOnly: StoredMarketSeries = {
			seriesId: "fred:CPIAUCSL",
			provider: "fred",
			symbol: "CPIAUCSL",
			title: "CPIAUCSL",
			unit: "",
			frequency: "unknown",
			publisher: "",
			sourceUrl: "https://fred.stlouisfed.org/series/CPIAUCSL",
			lastRefreshedAt: "2026-10-12T12:00:00.000Z",
			retrievedAt: null,
			unavailableCode: "SERIES_NOT_FOUND",
			unavailableUpstreamStatus: 404,
		};
		const unknownSymbol: StoredMarketSeries = {
			...failedOnly,
			seriesId: "fred:ZZZZ9",
			symbol: "ZZZZ9",
			title: "ZZZZ9",
		};
		const dashboard = dashboardOf([
			{
				type: "market-metric",
				widgetId: "w-cpi",
				title: "CPI",
				size: "small",
				seriesId: "fred:CPIAUCSL",
			},
			{
				type: "market-metric",
				widgetId: "w-zzz",
				title: "Zzz",
				size: "small",
				seriesId: "fred:ZZZZ9",
			},
			{
				type: "market-metric",
				widgetId: "w-vix",
				title: "VIX",
				size: "small",
				seriesId: "fred:VIXCLS",
			},
		]);
		const market: MarketRepository = {
			getSeriesMeta: async () => [failedOnly, unknownSymbol, VIX_META],
			getRefreshState: async () => new Map(),
			getObservations: async () => [],
			deleteSeriesNotIn: async () => 0,
		};
		const data = unwrapOk(await serviceWith(dashboard, market).getData(OWNER));
		const cpi = data.series.find((entry) => entry.seriesId === "fred:CPIAUCSL");
		expect(cpi?.title).toBe("US CPI");
		expect(cpi?.unavailable?.code).toBe("SERIES_NOT_FOUND");
		// The provider's own status reaches the view unchanged (§4a).
		expect(cpi?.unavailable?.upstreamStatus).toBe(404);
		const zzz = data.series.find((entry) => entry.seriesId === "fred:ZZZZ9");
		expect(zzz?.title).toBe("ZZZZ9");
		// A series with real provider metadata keeps its provider title.
		const vix = data.series.find((entry) => entry.seriesId === "fred:VIXCLS");
		expect(vix?.title).toBe("CBOE Volatility Index: VIX");
	});

	it("V2: an unreadable stored dashboard fails with the stable code, never the defaults", async () => {
		const dashboard: HomeDashboardRepository = {
			get: async () => "unreadable",
			put: async () => "written" as const,
			reset: async () => {
				throw new Error("reset must not run on a read");
			},
		};
		const got = await serviceWith(dashboard, marketOf()).getDashboard(OWNER);
		if (got.ok) throw new Error("expected STORED_DASHBOARD_UNREADABLE");
		expect(got.error.code).toBe("STORED_DASHBOARD_UNREADABLE");
		const data = await serviceWith(dashboard, marketOf()).getData(OWNER);
		if (data.ok) throw new Error("expected STORED_DASHBOARD_UNREADABLE");
		expect(data.error.code).toBe("STORED_DASHBOARD_UNREADABLE");
	});

	it("V2: reset replaces the stored document without an expectedVersion", async () => {
		let resetWith: HomeDashboard | null = null;
		const dashboard: HomeDashboardRepository = {
			get: async () => "unreadable",
			put: async () => "version-conflict" as const,
			reset: async (_owner, next) => {
				resetWith = next;
				return { dashboard: next, version: 1, updatedAt: "2026-10-12T12:00:00.000Z" };
			},
		};
		const reset = unwrapOk(await serviceWith(dashboard, marketOf()).resetDashboard(OWNER));
		expect(reset.origin).toBe("saved");
		expect(reset.version).toBe(1);
		expect(resetWith).not.toBeNull();
	});

	it("S2: the refresh object tells the last success apart from the last failure", async () => {
		const dashboard = dashboardOf([
			{
				type: "market-metric",
				widgetId: "w-vix",
				title: "VIX",
				size: "small",
				seriesId: "fred:VIXCLS",
			},
		]);
		const jobs: JobRepository = {
			...stubJobs(),
			findActiveByKind: async () => null,
			findActiveNotebookAssist: async () => null,
			findLatestSuccessAtByKind: async () => "2026-10-11T00:00:00.000Z",
			findLatestFailureByKind: async () => ({
				state: "failed",
				failureCode: "RUNNER_ERROR_X",
				failureUpstreamStatus: null,
				at: "2026-10-12T12:00:00.000Z",
			}),
		};
		const service = createHomeService({
			dashboard,
			market: marketOf({ getSeriesMeta: async () => [VIX_META] }),
			jobs,
			notebooks: NOTEBOOKS,
			watchlistLists: { membersOf: async () => new Map() },
			clock: fixedClock().clock,
			audit: AUDIT,
			records: recordsWith(),
		});
		const data = unwrapOk(await service.getData(OWNER));
		expect(data.refresh).toEqual({
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: "2026-10-11T00:00:00.000Z",
			lastFailure: {
				state: "failed",
				code: "RUNNER_ERROR_X",
				upstreamStatus: null,
				at: "2026-10-12T12:00:00.000Z",
			},
		});
	});

	it("S3: the digest ETag moves with run state and per-series stamps, not observations", () => {
		const base: HomeDataDigest = {
			dashboardVersion: 1,
			seriesIds: ["fred:VIXCLS"],
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: null,
			seriesStamps: [
				{
					seriesId: "fred:VIXCLS",
					lastRefreshedAt: "2026-10-11T00:00:00.000Z",
					retrievedAt: "2026-10-11T00:00:00.000Z",
					unavailableCode: null,
					unavailableUpstreamStatus: null,
				},
			],
		};
		const idle = homeDataDigestEtag(base);
		// A pending run changes the tag (V6/V7: queued polls slow, leased fast).
		expect(
			homeDataDigestEtag({ ...base, activeRunId: "run_1", activeRunState: "pending" }),
		).not.toBe(idle);
		// Claimed vs pending changes it too.
		expect(
			homeDataDigestEtag({ ...base, activeRunId: "run_1", activeRunState: "claimed" }),
		).not.toBe(homeDataDigestEtag({ ...base, activeRunId: "run_1", activeRunState: "pending" }));
		// A failure stamp changes it (S2).
		expect(
			homeDataDigestEtag({
				...base,
				lastFailure: {
					state: "failed",
					code: "X",
					upstreamStatus: null,
					at: "2026-10-12T12:00:00.000Z",
				},
			}),
		).not.toBe(idle);
	});

	it("§4a: the digest ETag moves with an upstream status alone, so a changed status is never a 304", () => {
		const stamp = {
			seriesId: "fred:VIXCLS",
			lastRefreshedAt: "2026-10-11T00:00:00.000Z",
			retrievedAt: null,
			unavailableCode: "SOURCE_FAILED",
		};
		const failure = { state: "failed", code: "SOURCE_FAILED", at: "2026-10-12T12:00:00.000Z" };
		const digest = (seriesStatus: number | null, runStatus: number | null): HomeDataDigest => ({
			dashboardVersion: 1,
			seriesIds: ["fred:VIXCLS"],
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: { ...failure, upstreamStatus: runStatus },
			seriesStamps: [{ ...stamp, unavailableUpstreamStatus: seriesStatus }],
		});
		const tags = new Set(
			[digest(null, null), digest(503, null), digest(500, null), digest(null, 503)].map(
				homeDataDigestEtag,
			),
		);
		expect(tags.size).toBe(4);
	});
});

describe("home series of Watchlist lists (ADR-0040 §4)", () => {
	const LIST_MEMBERS = new Map([
		[
			"list_chips",
			[
				{ stockId: "us:NVDA", market: "US", symbol: "NVDA" },
				{ stockId: "jp:7203", market: "JP", symbol: "7203" },
			] as const,
		],
	]);
	const lists = {
		membersOf: async (_owner: string, listIds: readonly string[]) =>
			new Map([...LIST_MEMBERS].filter(([listId]) => listIds.includes(listId))),
	};

	function homeWith(
		widgets: HomeDashboard["widgets"],
		kept: { keep: readonly string[] | null },
		notebookListIds: readonly string[] = [],
	) {
		return createHomeService({
			dashboard: dashboardOf(widgets),
			market: marketOf({
				deleteSeriesNotIn: async (_owner, keep) => {
					kept.keep = [...keep];
					return 0;
				},
			}),
			jobs: stubJobs(),
			notebooks: { ...NOTEBOOKS, listWatchlistListIds: async () => notebookListIds },
			watchlistLists: lists,
			clock: fixedClock().clock,
			audit: AUDIT,
			records: recordsWith(),
		});
	}

	it("serves a list widget's stocks after the named series, and a deleted list adds nothing", async () => {
		const service = homeWith(
			[
				{
					type: "watchlist-prices",
					widgetId: "w-l",
					title: "Chips",
					size: "medium",
					listId: "list_chips",
				},
				{
					type: "watchlist-prices",
					widgetId: "w-gone",
					title: "Gone",
					size: "medium",
					listId: "list_gone",
				},
				{
					type: "market-metric",
					widgetId: "w-v",
					title: "VIX",
					size: "small",
					seriesId: "fred:VIXCLS",
				},
			],
			{ keep: null },
		);
		const digest = unwrapOk(await service.getDataDigest(OWNER));
		expect(digest.seriesIds).toEqual(["fred:VIXCLS", "twelve-data:NVDA", "twelve-data:7203:JPX"]);
		expect(digest.seriesStamps.map((stamp) => stamp.seriesId)).toEqual(digest.seriesIds);
		const data = unwrapOk(await service.getData(OWNER, digest));
		expect(data.series.map((entry) => entry.seriesId)).toEqual(digest.seriesIds);
	});

	it("keeps Home's and the notebooks' list series on a save", async () => {
		const kept: { keep: readonly string[] | null } = { keep: null };
		const service = homeWith([], kept, ["list_chips"]);
		unwrapOk(
			await service.putDashboard(
				OWNER,
				{
					schemaVersion: 2,
					widgets: [
						{
							type: "market-metric",
							widgetId: "w-v",
							title: "VIX",
							size: "small",
							seriesId: "fred:VIXCLS",
						},
					],
				},
				1,
			),
		);
		expect([...(kept.keep ?? [])].sort()).toEqual([
			"fred:VIXCLS",
			"twelve-data:7203:JPX",
			"twelve-data:NVDA",
		]);
	});
});
