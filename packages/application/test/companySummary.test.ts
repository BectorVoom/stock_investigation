import {
	type AgentSettings,
	type CompleteJobRequest,
	DEFAULT_AGENT_SETTINGS,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	type CompanySummaryDeps,
	type CompanySummarySchedule,
	createCompanySummaryService,
	dueSummaryStock,
	type JobRecord,
	type StoredWatchlistStock,
	scheduledJobRecord,
} from "../src/index.ts";
import { fixedClock, inMemoryStockDirectory } from "./support.ts";

const OWNER = "owner_1";
const NOW = "2026-11-02T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function stock(market: "US" | "JP", symbol: string): StoredWatchlistStock {
	return {
		stockId: `${market.toLowerCase()}:${symbol}`,
		market,
		symbol,
		name: null,
		addedAt: "2026-10-01T00:00:00.000Z",
		lastRefreshedAt: null,
		retrievedAt: null,
		unavailableCode: null,
		unavailableUpstreamStatus: null,
	};
}

const AAPL = stock("US", "AAPL");
const TOYOTA = stock("JP", "7203");

function row(
	target: StoredWatchlistStock,
	queuedAgoMs: number,
	generatedAgoMs: number | null,
): CompanySummarySchedule {
	return {
		market: target.market,
		symbol: target.symbol,
		queuedAt: new Date(NOW_MS - queuedAgoMs).toISOString(),
		generatedAt: generatedAgoMs === null ? null : new Date(NOW_MS - generatedAgoMs).toISOString(),
	};
}

describe("dueSummaryStock", () => {
	it("picks the first Watchlist stock with no row", () => {
		expect(dueSummaryStock([AAPL, TOYOTA], [], NOW_MS)).toBe(AAPL);
		expect(dueSummaryStock([AAPL, TOYOTA], [row(AAPL, 2 * HOUR, HOUR)], NOW_MS)).toBe(TOYOTA);
	});

	it("waits a day after a queue that wrote nothing, then tries again", () => {
		expect(dueSummaryStock([AAPL], [row(AAPL, 23 * HOUR, null)], NOW_MS)).toBeNull();
		expect(dueSummaryStock([AAPL], [row(AAPL, 24 * HOUR, null)], NOW_MS)).toBe(AAPL);
	});

	it("writes a stored summary again after 90 days", () => {
		expect(dueSummaryStock([AAPL], [row(AAPL, 89 * DAY, 89 * DAY)], NOW_MS)).toBeNull();
		expect(dueSummaryStock([AAPL], [row(AAPL, 90 * DAY, 90 * DAY)], NOW_MS)).toBe(AAPL);
	});
});

const SETTINGS: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, defaultAgentId: "claude-code" };

function harness(options: {
	readonly settings?: AgentSettings | null;
	readonly stocks?: readonly StoredWatchlistStock[];
	readonly schedule?: CompanySummarySchedule[];
	readonly insert?: "inserted" | "kind-active";
}) {
	const { clock } = fixedClock(NOW);
	const inserted: JobRecord[] = [];
	const queued: string[] = [];
	const audits: string[] = [];
	let runs = 0;
	const deps: CompanySummaryDeps = {
		summaries: {
			get: async () => ({ summary: null, overview: null }),
			listSchedule: async () => options.schedule ?? [],
			markQueued: async (_owner, market, symbol, at) => {
				queued.push(`${market}:${symbol}@${at}`);
			},
			searchThemes: async () => [],
		},
		watchlist: { listStocks: async () => options.stocks ?? [AAPL] },
		settings: {
			getAgentSettings: async () =>
				options.settings === null
					? null
					: { settings: options.settings ?? SETTINGS, updatedAt: NOW },
		},
		stockDirectory: inMemoryStockDirectory(
			[
				{ market: "US", symbol: "AAPL", name: "Apple Inc.", localName: null, listing: "nasdaq" },
				{
					market: "JP",
					symbol: "7203",
					name: "TOYOTA MOTOR",
					localName: "トヨタ自動車",
					listing: "tse-prime",
				},
			],
			[],
			[
				{
					symbol: "7203",
					nameEn: "TOYOTA MOTOR CORPORATION",
					sector17Code: "6",
					sector17Name: "自動車・輸送機",
					sector33Code: "3700",
					sector33Name: "輸送用機器",
					scaleCategory: "TOPIX Core30",
					marketSegmentCode: "0111",
					marketSegmentName: "プライム",
					asOf: "2026-08-10",
					retrievedAt: NOW,
				},
			],
		),
		equitySync: { businessByListing: async () => null },
		jobs: {
			insert: async (job) => {
				if ((options.insert ?? "inserted") === "kind-active") return { kind: "kind-active", job };
				inserted.push(job);
				return { kind: "inserted" };
			},
		},
		ids: {
			newId: (prefix) => {
				runs += 1;
				return `${prefix}_${runs}`;
			},
		},
		clock,
		audit: {
			record: async (entry) => {
				audits.push(`${entry.action} ${entry.detail}`);
			},
		},
		log: () => {},
		gate: { take: () => true },
		enabled: true,
	};
	return { service: createCompanySummaryService(deps), inserted, queued, audits };
}

const AVAILABLE = new Set(["claude-code"]);

describe("the company summary schedule (ADR-0060)", () => {
	it("queues the due stock with the agent saved in Settings and records the queue time", async () => {
		const { service, inserted, queued, audits } = harness({});
		await service.materializeDue(OWNER, AVAILABLE);
		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.kind).toBe("company-summary");
		expect(inserted[0]?.request).toEqual({
			stockId: "us:AAPL",
			agent: { agentId: "claude-code", model: null, effort: "medium" },
		});
		expect(queued).toEqual([`US:AAPL@${NOW}`]);
		expect(audits).toEqual(["run.company_summary stock=us:AAPL agent=claude-code"]);
	});

	it("queues nothing without a chosen agent, an available one, or a required model", async () => {
		for (const settings of [
			null,
			DEFAULT_AGENT_SETTINGS,
			{ ...DEFAULT_AGENT_SETTINGS, defaultAgentId: "opencode" },
		]) {
			const { service, inserted } = harness({ settings });
			await service.materializeDue(OWNER, new Set(["claude-code", "opencode"]));
			expect(inserted).toEqual([]);
		}
		const { service, inserted } = harness({});
		await service.materializeDue(OWNER, new Set(["opencode"]));
		expect(inserted).toEqual([]);
	});

	it("leaves the queue time alone when a summary job is already unfinished", async () => {
		const { service, queued } = harness({ insert: "kind-active" });
		await service.materializeDue(OWNER, AVAILABLE);
		expect(queued).toEqual([]);
	});

	it("gives a Japanese stock's claim its names, listing and J-Quants sectors", async () => {
		const { service } = harness({});
		const job = scheduledJobRecord({
			ownerId: OWNER,
			kind: "company-summary",
			request: {
				stockId: "jp:7203",
				agent: { agentId: "claude-code", model: null, effort: "medium" },
			},
			runId: "run_1",
			at: NOW,
		});
		const claim = await service.prepareClaim(OWNER, job);
		expect(claim).toEqual({
			ok: true,
			value: {
				stockId: "jp:7203",
				agent: { agentId: "claude-code", model: null, effort: "medium" },
				facts: {
					name: "TOYOTA MOTOR",
					localName: "トヨタ自動車",
					listing: "tse-prime",
					sector: "輸送用機器 (自動車・輸送機)",
					businessExcerpt: null,
				},
			},
		});
	});

	it("stores a completion only for the stock the job was queued for", async () => {
		const { service } = harness({});
		const job = scheduledJobRecord({
			ownerId: OWNER,
			kind: "company-summary",
			request: {
				stockId: "us:AAPL",
				agent: { agentId: "claude-code", model: "opus", effort: "high" },
			},
			runId: "run_1",
			at: NOW,
		});
		const completion: Extract<CompleteJobRequest, { outcome: "company-summarized" }> = {
			outcome: "company-summarized",
			leaseGeneration: 1,
			usage: {
				agentSteps: 1,
				toolCalls: 0,
				inputBytes: 0,
				knownCostUsd: 0,
				hasUnmeteredUsage: true,
			},
			stockId: "us:AAPL",
			summary: {
				description: { en: "Apple makes phones.", ja: "Appleはスマートフォンを作ります。" },
				themes: [{ en: "Smartphones", ja: "スマートフォン" }],
			},
		};
		expect(service.completionEffects(job, completion)).toEqual({
			ok: true,
			value: {
				market: "US",
				symbol: "AAPL",
				summary: completion.summary,
				agentId: "claude-code",
				model: "opus",
				generatedAt: NOW,
			},
		});
		const other = service.completionEffects(job, { ...completion, stockId: "us:MSFT" });
		expect(other.ok).toBe(false);
	});
});
