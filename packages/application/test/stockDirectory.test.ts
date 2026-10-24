import type { WatchMarket } from "@research/contracts";
import { foldStockSearchText } from "@research/domain";
import { describe, expect, it } from "vitest";
import type {
	AuditEntry,
	EnqueueResult,
	JobKindScope,
	JobRecord,
	JobRepository,
	StoredStockDirectoryEntry,
	StoredWatchlistStock,
} from "../src/ports.ts";
import { createStockDirectoryService, stockDirectoryRows } from "../src/stockDirectory.ts";
import { fixedClock, inMemoryStockDirectory } from "./support.ts";

const OWNER = "owner_1";

const ROWS: readonly StoredStockDirectoryEntry[] = [
	{ market: "US", symbol: "AAPL", name: "Apple Inc.", localName: null, listing: "nasdaq" },
	{ market: "US", symbol: "APP", name: "AppLovin Corp", localName: null, listing: "nasdaq" },
	{ market: "US", symbol: "TM", name: "Toyota Motor Corp/", localName: null, listing: "nyse" },
	{
		market: "JP",
		symbol: "7203",
		name: "TOYOTA MOTOR CORPORATION",
		localName: "トヨタ自動車",
		listing: "tse-prime",
	},
];

interface StoredJob {
	readonly job: JobRecord;
	readonly key: string;
	readonly fingerprint: string;
}

/**
 * Just enough of the jobs table for the directory service: inserts with
 * keys and fingerprints, and the by-kind lookups narrowed by market the way
 * the SQL narrows them (on the stored request's market).
 */
function inMemoryJobs() {
	const stored: StoredJob[] = [];
	const inScope = (job: JobRecord, scope: JobKindScope | undefined) =>
		scope === undefined ||
		(job.request !== null && "market" in job.request && job.request.market === scope.market);
	const unused = (): never => {
		throw new Error("not used by the stock directory service");
	};
	const jobs: JobRepository = {
		async insert(job, key, fingerprint): Promise<EnqueueResult> {
			const existing = stored.find((entry) => entry.key === key);
			if (existing !== undefined) {
				return {
					kind: "existing",
					job: existing.job,
					sameRequest: existing.fingerprint === fingerprint,
				};
			}
			stored.push({ job, key, fingerprint });
			return { kind: "inserted" };
		},
		async findByIdempotencyKey(_ownerId, key) {
			const existing = stored.find((entry) => entry.key === key);
			return existing === undefined
				? null
				: { job: existing.job, requestFingerprint: existing.fingerprint };
		},
		get: unused,
		list: unused,
		findLatestResearchRequest: unused,
		listClaimCandidates: unused,
		write: unused,
		writeWithEvents: unused,
		listProgress: unused,
		async findActiveByKind(_ownerId, kind, scope) {
			const active = stored
				.map((entry) => entry.job)
				.filter(
					(job) =>
						job.kind === kind &&
						["pending", "claimed", "publishing"].includes(job.state) &&
						inScope(job, scope),
				);
			return active[active.length - 1] ?? null;
		},
		findActiveNotebookAssist: unused,
		findLatestSuccessAtByKind: unused,
		async findLatestFailureByKind(_ownerId, kind, scope) {
			const failed = stored
				.map((entry) => entry.job)
				.filter((job) => job.kind === kind && job.state === "failed" && inScope(job, scope));
			const last = failed[failed.length - 1];
			return last === undefined
				? null
				: { state: last.state, failureCode: last.failureCode, at: last.updatedAt };
		},
	};
	return {
		jobs,
		stored,
		/** Ends a stored run, as a completion would. */
		finish(runId: string, state: "completed" | "failed", failureCode: string | null) {
			const index = stored.findIndex((entry) => entry.job.runId === runId);
			const entry = stored[index];
			if (entry === undefined) throw new Error("no such run");
			stored[index] = { ...entry, job: { ...entry.job, state, failureCode } };
		},
	};
}

function serviceWith(
	options: {
		readonly watched?: readonly StoredWatchlistStock[];
		readonly allowed?: () => boolean;
	} = {},
) {
	const jobs = inMemoryJobs();
	const audits: AuditEntry[] = [];
	let counter = 0;
	const service = createStockDirectoryService({
		stockDirectory: inMemoryStockDirectory(ROWS, [
			{
				market: "JP",
				entryCount: 3707,
				asOf: "2026-09-30",
				retrievedAt: "2026-10-01T00:00:00.000Z",
			},
		]),
		watchlist: { listStocks: async () => options.watched ?? [] },
		jobs: jobs.jobs,
		clock: fixedClock().clock,
		ids: {
			newId: (prefix) => {
				counter += 1;
				return `${prefix}_${counter}`;
			},
		},
		rateLimiter: { consume: async () => options.allowed?.() ?? true },
		audit: {
			record: async (entry) => {
				audits.push(entry);
			},
		},
	});
	return { service, jobs, audits };
}

function watched(market: WatchMarket, symbol: string): StoredWatchlistStock {
	return {
		stockId: `${market.toLowerCase()}:${symbol}`,
		market,
		symbol,
		name: null,
		addedAt: "2026-10-01T00:00:00.000Z",
		lastRefreshedAt: null,
		retrievedAt: null,
		unavailableCode: null,
	};
}

describe("stockDirectoryRows (ADR-0033)", () => {
	it("stores the domain's folded keys and haystack with each row", () => {
		const [us, jp] = [
			...stockDirectoryRows("US", [
				{ symbol: "BRK.B", name: "Berkshire  Hathaway", listing: "nyse" },
			]),
			...stockDirectoryRows("JP", [
				{ symbol: "2501", name: "Sapporo", localName: "ｻｯﾎﾟﾛ", listing: "tse-prime" },
			]),
		];
		expect(us).toEqual({
			market: "US",
			symbol: "BRK.B",
			name: "Berkshire  Hathaway",
			localName: null,
			listing: "nyse",
			symbolKey: "brk.b",
			nameKey: "berkshire hathaway",
			localNameKey: "",
			searchKey: "brk.b\nberkshire hathaway\n",
		});
		expect(jp?.localNameKey).toBe(foldStockSearchText("ｻｯﾎﾟﾛ"));
		expect(jp?.localNameKey).toBe("サッポロ");
		expect(jp?.searchKey).toBe("2501\nsapporo\nサッポロ");
	});
});

describe("stock directory service (ADR-0033)", () => {
	it("searches with the reference ranking and marks watched stocks", async () => {
		const { service } = serviceWith({ watched: [watched("US", "AAPL")] });
		const result = await service.search(OWNER, { q: "app", limit: 10 });
		if (!result.ok) throw new Error("search failed");
		expect(result.value.hits).toEqual([
			{
				stockId: "us:APP",
				market: "US",
				symbol: "APP",
				name: "AppLovin Corp",
				localName: null,
				listing: "nasdaq",
				registered: false,
			},
			{
				stockId: "us:AAPL",
				market: "US",
				symbol: "AAPL",
				name: "Apple Inc.",
				localName: null,
				listing: "nasdaq",
				registered: true,
			},
		]);
		const jp = await service.search(OWNER, { q: "とよた", market: "JP", limit: 10 });
		if (!jp.ok) throw new Error("search failed");
		expect(jp.value.hits.map((hit) => hit.stockId)).toEqual(["jp:7203"]);
	});

	it("reports US then JP with each market's stored list and runs", async () => {
		const { service } = serviceWith();
		const queued = await service.queueRefresh(OWNER, { markets: ["JP"] }, "key-00000001");
		if (!queued.ok) throw new Error("queue failed");
		const status = await service.getStatus(OWNER);
		if (!status.ok) throw new Error("status failed");
		expect(status.value.markets.map((market) => market.market)).toEqual(["US", "JP"]);
		expect(status.value.markets[0]).toMatchObject({
			sourceId: "sec",
			entryCount: 0,
			asOf: null,
			retrievedAt: null,
			activeRunId: null,
		});
		expect(status.value.markets[1]).toMatchObject({
			sourceId: "jpx",
			entryCount: 3707,
			asOf: "2026-09-30",
			retrievedAt: "2026-10-01T00:00:00.000Z",
			activeRunId: queued.value.runs[0]?.runId,
			activeRunState: "pending",
			lastFailure: null,
		});
	});

	it("queues one job per market under per-market keys, reusing active runs", async () => {
		const { service, jobs, audits } = serviceWith();
		const first = await service.queueRefresh(OWNER, { markets: ["US", "JP"] }, "key-00000001");
		if (!first.ok) throw new Error("queue failed");
		expect(first.value.runs).toEqual([
			{ market: "US", runId: "run_1" },
			{ market: "JP", runId: "run_2" },
		]);
		expect(jobs.stored.map((entry) => [entry.key, entry.fingerprint, entry.job.request])).toEqual([
			["key-00000001:US", "stock-directory-refresh:JP,US", { market: "US" }],
			["key-00000001:JP", "stock-directory-refresh:JP,US", { market: "JP" }],
		]);
		expect(audits.map((audit) => audit.detail)).toEqual([
			"kind=stock-directory-refresh market=US",
			"kind=stock-directory-refresh market=JP",
		]);
		const again = await service.queueRefresh(OWNER, { markets: ["JP"] }, "key-00000002");
		expect(again.ok && again.value.runs).toEqual([{ market: "JP", runId: "run_2" }]);
		expect(jobs.stored).toHaveLength(2);
	});

	it("replays a finished key and refuses it for another market set", async () => {
		const { service, jobs } = serviceWith();
		const first = await service.queueRefresh(OWNER, { markets: ["US"] }, "key-00000001");
		if (!first.ok) throw new Error("queue failed");
		jobs.finish("run_1", "failed", "DIRECTORY_SOURCE_FAILED");
		const replay = await service.queueRefresh(OWNER, { markets: ["US"] }, "key-00000001");
		expect(replay.ok && replay.value.runs).toEqual([{ market: "US", runId: "run_1" }]);
		const reused = await service.queueRefresh(OWNER, { markets: ["JP", "US"] }, "key-00000001");
		expect(!reused.ok && reused.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
		const status = await service.getStatus(OWNER);
		expect(status.ok && status.value.markets[0]?.lastFailure).toMatchObject({
			state: "failed",
			code: "DIRECTORY_SOURCE_FAILED",
		});
		expect(status.ok && status.value.markets[1]?.lastFailure).toBeNull();
	});

	it("stops at the hourly allowance and keeps the markets already queued", async () => {
		let left = 1;
		const { service, jobs } = serviceWith({
			allowed: () => {
				left -= 1;
				return left >= 0;
			},
		});
		const result = await service.queueRefresh(OWNER, { markets: ["US", "JP"] }, "key-00000001");
		expect(!result.ok && result.error.code).toBe("RATE_LIMITED");
		expect(jobs.stored.map((entry) => entry.key)).toEqual(["key-00000001:US"]);
	});
});
