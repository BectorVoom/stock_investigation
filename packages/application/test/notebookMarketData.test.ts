/**
 * Notebook market data (ADR-0021): the refresh union, Home saves keeping
 * notebook series, and the per-notebook market-data use case. Fake
 * repositories stand in for SQL; the SQL itself is covered by the adapter
 * and API suites.
 */
import type { HomeDashboard, NotebookWidget } from "@research/contracts";
import { MARKET_LIMITS } from "@research/contracts";
import { emptyWorkspaceState } from "@research/domain";
import { describe, expect, it, vi } from "vitest";
import type { UseCaseResult } from "../src/errors.ts";
import { createHomeService } from "../src/home.ts";
import { unionSeriesIds } from "../src/marketData.ts";
import { createNotebookService } from "../src/notebook/notebook.ts";
import type {
	AuditLog,
	HomeDashboardRepository,
	JobRepository,
	MarketRepository,
	NotebookRepository,
	StoredMarketSeries,
} from "../src/ports.ts";
import { fixedClock } from "./support.ts";

const OWNER = "owner_1";
const WORKSPACE = "ws_1";
const NOW = "2026-10-14T00:00:00.000Z";

function unwrap<T>(result: UseCaseResult<T>): T {
	if (!result.ok)
		throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

function expectFail<T>(result: UseCaseResult<T>, code: string): void {
	if (result.ok) throw new Error(`expected failure ${code}, got success`);
	expect(result.error.code).toBe(code);
}

function meta() {
	return {
		createdAt: NOW,
		updatedAt: NOW,
		revision: 1,
		origin: { kind: "owner" as const, messageId: null, runId: null, componentId: null },
	};
}

function marketMetric(widgetId: string, seriesId: string): NotebookWidget {
	return {
		widgetId,
		type: "market-metric",
		title: `Metric ${widgetId}`,
		size: "small",
		seriesId,
		...meta(),
	};
}

function lineChart(widgetId: string, seriesIds: string[]): NotebookWidget {
	return {
		widgetId,
		type: "line-chart",
		title: `Chart ${widgetId}`,
		size: "medium",
		seriesIds: [...seriesIds],
		range: "1y",
		...meta(),
	};
}

function textWidget(widgetId: string): NotebookWidget {
	return {
		widgetId,
		type: "text",
		title: `Notes ${widgetId}`,
		size: "medium",
		text: "hello",
		...meta(),
	};
}

function stubJobs(): JobRepository {
	const unused = (): never => {
		throw new Error("not used here");
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
	};
}

const AUDIT: AuditLog = { record: async () => {} };

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
};

describe("market refresh union (ADR-0021)", () => {
	it("claims the dashboard series first, then the notebooks' series, de-duplicated", () => {
		expect(unionSeriesIds(["fred:A", "fred:B"], ["fred:B", "fred:C"], 60)).toEqual([
			"fred:A",
			"fred:B",
			"fred:C",
		]);
	});

	it("caps the union at maxTrackedSeries, dashboard first", () => {
		const dashboard = Array.from({ length: 30 }, (_, index) => `fred:D${index}`);
		const notebooks = Array.from({ length: 60 }, (_, index) => `fred:N${index}`);
		const union = unionSeriesIds(dashboard, notebooks);
		expect(union).toHaveLength(MARKET_LIMITS.maxTrackedSeries);
		expect(union.slice(0, 30)).toEqual(dashboard);
		expect(union.slice(30)).toEqual(notebooks.slice(0, 30));
	});

	it("an empty dashboard still claims the notebooks' series", () => {
		expect(unionSeriesIds([], ["fred:A"])).toEqual(["fred:A"]);
		expect(unionSeriesIds(["fred:A"], [])).toEqual(["fred:A"]);
	});
});

describe("home saves keep notebook series (ADR-0021)", () => {
	function homeWith(notebookIds: readonly string[], deleted: { keep: readonly string[] | null }) {
		const dashboard: HomeDashboardRepository = {
			get: async () => ({
				dashboard: {
					schemaVersion: 2 as const,
					widgets: [
						{
							type: "market-metric",
							widgetId: "w-vix",
							title: "VIX",
							size: "small",
							seriesId: "fred:VIXCLS",
						},
					],
				},
				version: 1,
				updatedAt: null,
			}),
			put: async () => "written" as const,
			reset: async () => {
				throw new Error("not used here");
			},
		};
		const market: MarketRepository = {
			getSeriesMeta: async () => [],
			getLatestObservedOn: async () => new Map(),
			getObservations: async () => [],
			deleteSeriesNotIn: async (_owner, keep) => {
				deleted.keep = [...keep];
				return 0;
			},
		};
		const notebooks: NotebookRepository = {
			get: async () => null,
			put: async () => "written" as const,
			getRevision: async () => null,
			listTurns: async () => [],
			listMarketSeriesIds: async () => [...notebookIds],
		};
		return createHomeService({
			dashboard,
			market,
			jobs: stubJobs(),
			notebooks,
			clock: fixedClock().clock,
			audit: AUDIT,
		});
	}

	it("putDashboard keeps a series a notebook names and deletes one nobody names", async () => {
		const deleted: { keep: readonly string[] | null } = { keep: null };
		const service = homeWith(["twelve-data:EXTRA"], deleted);
		const dashboard: HomeDashboard = {
			schemaVersion: 2,
			widgets: [
				{
					type: "market-metric",
					widgetId: "w-vix",
					title: "VIX",
					size: "small",
					seriesId: "fred:VIXCLS",
				},
			],
		};
		const saved = unwrap(await service.putDashboard(OWNER, dashboard, 1));
		expect(saved.version).toBe(1);
		expect(deleted.keep).not.toBeNull();
		// The dashboard's own series and the notebook's series are kept; the
		// old series nobody names is absent from the keep list, so it is deleted.
		expect([...(deleted.keep ?? [])].sort()).toEqual(["fred:VIXCLS", "twelve-data:EXTRA"]);
	});
});

describe("notebook market data (ADR-0021)", () => {
	function notebookService(
		widgets: readonly NotebookWidget[] | "unreadable",
		marketOverrides?: Partial<MarketRepository>,
	) {
		const notebooks: NotebookRepository = {
			get: async () =>
				widgets === "unreadable"
					? "unreadable"
					: { notebook: { widgets: [...widgets] }, version: 2, updatedAt: NOW },
			put: async () => "written" as const,
			getRevision: async () => null,
			listTurns: async () => [],
			listMarketSeriesIds: async () => [],
		};
		const market: MarketRepository = {
			getSeriesMeta: async () => [],
			getLatestObservedOn: async () => new Map(),
			getObservations: async () => [],
			deleteSeriesNotIn: async () => 0,
			...marketOverrides,
		};
		return createNotebookService({
			notebooks,
			workspaces: {
				list: async () => [],
				get: async (ownerId, workspaceId) =>
					ownerId === OWNER && workspaceId === WORKSPACE
						? {
								summary: {
									workspaceId: WORKSPACE,
									title: "Chat",
									version: 1,
									createdAt: NOW,
									updatedAt: NOW,
								},
								state: emptyWorkspaceState(WORKSPACE),
							}
						: null,
				insert: async () => {},
				rename: async () => null,
				listRecords: async () => [],
				findCommand: async () => null,
				write: async () => "written" as const,
				listCommandsAfter: async () => [],
			},
			jobs: stubJobs(),
			chat: {
				list: async () => [],
				findByRunId: async () => null,
				listConversations: async () => [],
			},
			settings: {
				getAgentSettings: async () => null,
				putAgentSettings: async () => {},
			},
			market,
			unitOfWork: {
				enqueueResearch: async () => ({ kind: "at-capacity" }) as const,
				commitCompletion: async () => ({ kind: "job-conflict" }) as const,
				importWorkspace: async () => {},
				deleteWorkspace: async () => "deleted" as const,
			},
			clock: fixedClock().clock,
			ids: { newId: (prefix) => `${prefix}_1` },
			hasher: { sha256Hex: async () => "hash" },
			rateLimiter: { consume: async () => true },
			audit: AUDIT,
		});
	}

	it("returns this notebook's series with metadata and observations, in Home shape", async () => {
		const getObservations = vi.fn(
			async (
				_owner: string,
				_ids: readonly string[],
				_limit: number,
			): Promise<readonly { seriesId: string; observedOn: string; value: number }[]> => [
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-01", value: 15.2 },
				{ seriesId: "fred:VIXCLS", observedOn: "2026-10-02", value: 15.8 },
			],
		);
		const service = notebookService([marketMetric("w-m", "fred:VIXCLS")], {
			getSeriesMeta: async () => [VIX_META],
			getObservations,
		});
		const data = unwrap(await service.getNotebookMarketData(OWNER, WORKSPACE));
		expect(data.series).toHaveLength(1);
		expect(data.series[0]).toMatchObject({
			seriesId: "fred:VIXCLS",
			provider: "fred",
			unavailable: null,
		});
		expect(data.series[0]?.observations).toEqual([
			["2026-10-01", 15.2],
			["2026-10-02", 15.8],
		]);
		expect(data.refresh).toEqual({
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: null,
		});
		expect(getObservations.mock.calls[0]?.[2]).toBe(800);
	});

	it("collects the distinct series of several market widgets, widget order kept", async () => {
		const seen: { ids: readonly string[] | null } = { ids: null };
		const service = notebookService(
			[
				lineChart("w-l", ["fred:VIXCLS", "fred:DGS10"]),
				marketMetric("w-m", "fred:VIXCLS"),
				textWidget("w-t"),
			],
			{
				getSeriesMeta: async (_owner, ids) => {
					seen.ids = [...ids];
					return [];
				},
			},
		);
		const digest = unwrap(await service.getNotebookMarketDataDigest(OWNER, WORKSPACE));
		expect([...digest.seriesIds]).toEqual(["fred:VIXCLS", "fred:DGS10"]);
		expect(seen.ids).toEqual(["fred:VIXCLS", "fred:DGS10"]);
		const data = unwrap(await service.getNotebookMarketData(OWNER, WORKSPACE, digest));
		expect(data.series.map((entry) => entry.seriesId)).toEqual(["fred:VIXCLS", "fred:DGS10"]);
	});

	it("answers series [] for a notebook without market widgets", async () => {
		const service = notebookService([textWidget("w-t")]);
		const digest = unwrap(await service.getNotebookMarketDataDigest(OWNER, WORKSPACE));
		expect(digest.seriesIds).toEqual([]);
		const data = unwrap(await service.getNotebookMarketData(OWNER, WORKSPACE, digest));
		expect(data.series).toEqual([]);
	});

	it("answers NOT_FOUND for a workspace the owner does not have", async () => {
		const service = notebookService([textWidget("w-t")]);
		expectFail(await service.getNotebookMarketData(OWNER, "ws_missing"), "NOT_FOUND");
		expectFail(await service.getNotebookMarketDataDigest(OWNER, "ws_missing"), "NOT_FOUND");
	});

	it("answers the existing unreadable error when the notebook cannot be read", async () => {
		const service = notebookService("unreadable");
		expectFail(await service.getNotebookMarketData(OWNER, WORKSPACE), "STORED_NOTEBOOK_UNREADABLE");
	});
});
