import type { WatchMarket } from "@research/contracts";
import { foldStockSearchText, STOCK_SEARCH_FOLD_VERSION } from "@research/domain";
import { describe, expect, it } from "vitest";
import type {
	AuditEntry,
	EnqueueResult,
	JobKindScope,
	JobRecord,
	JobRepository,
	StockDirectoryRekey,
	StoredStockDirectoryEntry,
	StoredWatchlistStock,
} from "../src/ports.ts";
import { createStockDirectoryService, stockDirectoryRows } from "../src/stockDirectory.ts";
import { fixedClock, inMemoryStockDirectory } from "./support.ts";

const OWNER = "owner_1";
const UNFINISHED: readonly string[] = ["pending", "claimed", "publishing"];

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
					(job) => job.kind === kind && UNFINISHED.includes(job.state) && inScope(job, scope),
				);
			return active[active.length - 1] ?? null;
		},
		findActiveNotebookAssist: unused,
		findLatestFailureByKind: unused,
		async findLatestSuccessAtByKind(_ownerId, kind, scope) {
			return newest(kind, "completed", scope)?.updatedAt ?? null;
		},
		async findLatestFailedByKind(_ownerId, kind, scope) {
			const last = newest(kind, "failed", scope);
			return last === undefined ? null : { failureCode: last.failureCode, at: last.updatedAt };
		},
		async countUnfinished() {
			return stored.filter((entry) => UNFINISHED.includes(entry.job.state)).length + others;
		},
	};
	function newest(kind: string, state: string, scope: JobKindScope | undefined) {
		return stored
			.map((entry) => entry.job)
			.filter((job) => job.kind === kind && job.state === state && inScope(job, scope))
			.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
			.at(-1);
	}
	/** Unfinished jobs of other kinds, for the capacity check. */
	let others = 0;
	return {
		jobs,
		stored,
		/** Ends a stored run at the API time `at`, as a completion would. */
		finish(
			runId: string,
			state: "completed" | "failed" | "cancelled",
			failureCode: string | null,
			at = "2026-10-11T00:00:00.000Z",
		) {
			const index = stored.findIndex((entry) => entry.job.runId === runId);
			const entry = stored[index];
			if (entry === undefined) throw new Error("no such run");
			stored[index] = { ...entry, job: { ...entry.job, state, failureCode, updatedAt: at } };
		},
		setOtherUnfinished(count: number) {
			others = count;
		},
	};
}

function serviceWith(
	options: {
		readonly watched?: readonly StoredWatchlistStock[];
		readonly allowed?: () => boolean;
		readonly jpFoldVersion?: number;
	} = {},
) {
	const jobs = inMemoryJobs();
	const audits: AuditEntry[] = [];
	const rekeys: StockDirectoryRekey[] = [];
	let counter = 0;
	const directory = inMemoryStockDirectory(ROWS, [
		{
			market: "JP",
			entryCount: 3707,
			asOf: "2026-09-30",
			retrievedAt: "2026-10-01T00:00:00.000Z",
			foldVersion: options.jpFoldVersion ?? STOCK_SEARCH_FOLD_VERSION,
		},
	]);
	const service = createStockDirectoryService({
		stockDirectory: {
			...directory,
			storeKeys: async (_ownerId, rekey) => {
				rekeys.push(rekey);
			},
		},
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
	return { service, jobs, audits, rekeys };
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

describe("stockDirectoryRows (ADR-0034)", () => {
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

describe("stock directory service (ADR-0034)", () => {
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

	it("refuses the same key for another market set even while its run is active", async () => {
		const { service, jobs } = serviceWith();
		const first = await service.queueRefresh(OWNER, { markets: ["US"] }, "key-00000001");
		expect(first.ok).toBe(true);
		const reused = await service.queueRefresh(OWNER, { markets: ["US", "JP"] }, "key-00000001");
		expect(!reused.ok && reused.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
		// A key stored for a market the new request does not name counts too.
		const narrowed = await service.queueRefresh(OWNER, { markets: ["JP"] }, "key-00000001");
		expect(!narrowed.ok && narrowed.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
		expect(jobs.stored).toHaveLength(1);
	});

	it("queues nothing when the hourly allowance refuses any market (all or nothing)", async () => {
		let left = 1;
		const { service, jobs } = serviceWith({
			allowed: () => {
				left -= 1;
				return left >= 0;
			},
		});
		const result = await service.queueRefresh(OWNER, { markets: ["US", "JP"] }, "key-00000001");
		expect(!result.ok && result.error.code).toBe("RATE_LIMITED");
		expect(jobs.stored).toEqual([]);
	});

	it("queues nothing when the new runs would pass the unfinished-run cap", async () => {
		const { service, jobs } = serviceWith();
		jobs.setOtherUnfinished(4);
		const both = await service.queueRefresh(OWNER, { markets: ["US", "JP"] }, "key-00000001");
		expect(!both.ok && both.error.code).toBe("RATE_LIMITED");
		expect(jobs.stored).toEqual([]);
		// One new run still fits.
		const one = await service.queueRefresh(OWNER, { markets: ["US"] }, "key-00000002");
		expect(one.ok && one.value.runs.map((run) => run.market)).toEqual(["US"]);
	});

	it("reports a failure only while no later run of the market succeeded; cancels never count", async () => {
		const { service, jobs } = serviceWith();
		const usFailure = async () => {
			const status = await service.getStatus(OWNER);
			if (!status.ok) throw new Error("status failed");
			return status.value.markets[0]?.lastFailure ?? null;
		};
		const queue = async (key: string) => {
			const queued = await service.queueRefresh(OWNER, { markets: ["US"] }, key);
			if (!queued.ok) throw new Error("queue failed");
			return queued.value.runs[0]?.runId ?? "";
		};
		// Failure, then a later success: the stored list is good again.
		jobs.finish(
			await queue("key-00000001"),
			"failed",
			"DIRECTORY_SOURCE_FAILED",
			"2026-10-11T01:00:00.000Z",
		);
		expect(await usFailure()).toEqual({
			state: "failed",
			code: "DIRECTORY_SOURCE_FAILED",
			at: "2026-10-11T01:00:00.000Z",
		});
		jobs.finish(await queue("key-00000002"), "completed", null, "2026-10-11T02:00:00.000Z");
		expect(await usFailure()).toBeNull();
		// Success, then a failure: the failure is current.
		jobs.finish(
			await queue("key-00000003"),
			"failed",
			"DIRECTORY_RATE_LIMITED",
			"2026-10-11T03:00:00.000Z",
		);
		expect(await usFailure()).toMatchObject({ code: "DIRECTORY_RATE_LIMITED" });
		// A later cancel neither counts nor hides that failure.
		jobs.finish(await queue("key-00000004"), "cancelled", null, "2026-10-11T04:00:00.000Z");
		expect(await usFailure()).toMatchObject({
			code: "DIRECTORY_RATE_LIMITED",
			at: "2026-10-11T03:00:00.000Z",
		});
	});

	it("re-keys a searched market stored under another fold version, before searching", async () => {
		const stale = serviceWith({ jpFoldVersion: STOCK_SEARCH_FOLD_VERSION - 1 });
		await stale.service.search(OWNER, { q: "toyota", market: "US", limit: 10 });
		expect(stale.rekeys).toEqual([]);
		await stale.service.search(OWNER, { q: "toyota", limit: 10 });
		expect(stale.rekeys).toHaveLength(1);
		expect(stale.rekeys[0]).toMatchObject({
			market: "JP",
			fromVersion: STOCK_SEARCH_FOLD_VERSION - 1,
			toVersion: STOCK_SEARCH_FOLD_VERSION,
		});
		expect(stale.rekeys[0]?.rows).toEqual([
			{
				...ROWS[3],
				symbolKey: "7203",
				nameKey: "toyota motor corporation",
				localNameKey: "トヨタ自動車",
				searchKey: "7203\ntoyota motor corporation\nトヨタ自動車",
			},
		]);
		const current = serviceWith();
		await current.service.search(OWNER, { q: "toyota", limit: 10 });
		expect(current.rekeys).toEqual([]);
	});
});
