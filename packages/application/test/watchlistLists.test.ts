import { type HomeDashboard, watchlistResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import type { UseCaseResult } from "../src/errors.ts";
import type {
	AuditEntry,
	JobRepository,
	StoredWatchlistList,
	StoredWatchlistStock,
	WatchlistListRepository,
	WatchlistRepository,
} from "../src/ports.ts";
import {
	createWatchlistService,
	type WatchlistDigest,
	watchlistDigestEtag,
} from "../src/watchlist.ts";
import { fixedClock } from "./support.ts";

/**
 * The watchlist service's list use cases (ADR-0040 §1–2) over in-memory
 * repositories that keep the same rules as the SQL ones (caps, "the stock is
 * on the watchlist", version bumps, the removal cascade). The SQL itself is
 * pinned by the adapters' SQLite suite and the API's D1 suite.
 */

const OWNER = "owner_1";

function unwrap<T>(result: UseCaseResult<T>): T {
	if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
	return result.value;
}

function failure<T>(result: UseCaseResult<T>) {
	if (result.ok) throw new Error("expected a failure");
	return result.error;
}

function stubJobs(): JobRepository {
	const unused = (): never => {
		throw new Error("not used by the list use cases");
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

interface MutableList {
	listId: string;
	title: string;
	version: number;
	createdAt: string;
	updatedAt: string;
	stockIds: string[];
}

function harness(
	options: {
		readonly maxStocks?: number;
		readonly homeWidgets?: HomeDashboard["widgets"] | "unreadable";
	} = {},
) {
	const time = fixedClock("2026-10-25T00:00:00.000Z");
	const stocks: StoredWatchlistStock[] = [];
	const lists: MutableList[] = [];
	const audits: AuditEntry[] = [];
	const deletions: (readonly string[])[] = [];
	const writes = { watchlistInserts: 0, listAdds: 0 };
	let nextId = 0;
	const watchlist: WatchlistRepository = {
		listStocks: async () => [...stocks],
		getStock: async (_owner, stockId) => stocks.find((s) => s.stockId === stockId) ?? null,
		countStocks: async () => stocks.length,
		async insertStock(_owner, stock, maxStocks) {
			writes.watchlistInserts += 1;
			if (stocks.some((s) => s.stockId === stock.stockId)) return "already-present";
			if (stocks.length >= Math.min(maxStocks, options.maxStocks ?? maxStocks)) return "full";
			stocks.push({
				...stock,
				lastRefreshedAt: null,
				retrievedAt: null,
				unavailableCode: null,
				unavailableUpstreamStatus: null,
			});
			return "added";
		},
		async removeStock(_owner, stockId, now) {
			const index = stocks.findIndex((s) => s.stockId === stockId);
			if (index < 0) return false;
			stocks.splice(index, 1);
			for (const list of lists) {
				if (!list.stockIds.includes(stockId)) continue;
				list.stockIds = list.stockIds.filter((id) => id !== stockId);
				list.version += 1;
				list.updatedAt = now;
			}
			return true;
		},
	};
	const toStored = (list: MutableList): StoredWatchlistList => ({
		...list,
		stockIds: [...list.stockIds],
	});
	const listRepository: WatchlistListRepository = {
		listLists: async () => lists.map(toStored),
		async insertList(_owner, list, maxLists) {
			if (lists.length >= maxLists) return "full";
			lists.push({ ...list, version: 1, updatedAt: list.createdAt, stockIds: [] });
			return "created";
		},
		async renameList(_owner, listId, title, now) {
			const list = lists.find((l) => l.listId === listId);
			if (list === undefined) return false;
			Object.assign(list, { title, version: list.version + 1, updatedAt: now });
			return true;
		},
		async deleteList(_owner, listId) {
			const index = lists.findIndex((l) => l.listId === listId);
			if (index < 0) return false;
			lists.splice(index, 1);
			return true;
		},
		async addStock(_owner, listId, stockId, now, max) {
			writes.listAdds += 1;
			const list = lists.find((l) => l.listId === listId);
			if (list === undefined) return "list-not-found";
			if (list.stockIds.includes(stockId)) return "already-present";
			if (!stocks.some((s) => s.stockId === stockId)) return "stock-not-found";
			if (list.stockIds.length >= max) return "list-full";
			Object.assign(list, {
				stockIds: [...list.stockIds, stockId],
				version: list.version + 1,
				updatedAt: now,
			});
			return "added";
		},
		async removeStock(_owner, listId, stockId, now) {
			const list = lists.find((l) => l.listId === listId);
			if (list === undefined) return "list-not-found";
			if (!list.stockIds.includes(stockId)) return "not-in-list";
			Object.assign(list, {
				stockIds: list.stockIds.filter((id) => id !== stockId),
				version: list.version + 1,
				updatedAt: now,
			});
			return "removed";
		},
		async membersOf(_owner, listIds) {
			const out = new Map<string, { stockId: string; market: "US" | "JP"; symbol: string }[]>();
			for (const list of lists) {
				if (!listIds.includes(list.listId)) continue;
				out.set(
					list.listId,
					list.stockIds.flatMap((stockId) => {
						const stock = stocks.find((s) => s.stockId === stockId);
						return stock === undefined
							? []
							: [{ stockId, market: stock.market, symbol: stock.symbol }];
					}),
				);
			}
			return out;
		},
	};
	const service = createWatchlistService({
		watchlist,
		watchlistLists: listRepository,
		homeDashboard: {
			get: async () =>
				options.homeWidgets === undefined
					? null
					: options.homeWidgets === "unreadable"
						? "unreadable"
						: {
								dashboard: { schemaVersion: 2, widgets: options.homeWidgets },
								version: 1,
								updatedAt: null,
							},
		},
		notebooks: { listMarketSeriesIds: async () => [], listWatchlistListIds: async () => [] },
		market: {
			deleteSeriesNotIn: async (_owner, keep) => {
				deletions.push([...keep]);
				return 0;
			},
		},
		earnings: { getEvents: async () => [] },
		calendarFeed: {
			get: async () => null,
			put: async () => {},
			revoke: async () => false,
			findOwnerByTokenHash: async () => null,
		},
		googleCalendar: {
			get: async () => null,
			setConnecting: async () => {},
			setPendingAuthUrl: async () => {},
			apply: async () => {},
		},
		stockDirectory: { getEntry: async () => null },
		jobs: stubJobs(),
		clock: time.clock,
		ids: {
			newId: (prefix) => {
				nextId += 1;
				return `${prefix}_${nextId}`;
			},
		},
		secrets: { newSecret: () => "s".repeat(43) },
		hasher: { sha256Hex: async (text) => `hash:${text.length}` },
		rateLimiter: { consume: async () => true },
		audit: {
			record: async (entry) => {
				audits.push(entry);
			},
		},
	});
	return { service, time, stocks, lists, audits, deletions, writes };
}

async function digestEtag(service: ReturnType<typeof harness>["service"]): Promise<string> {
	const digest: WatchlistDigest = unwrap(await service.getDigest(OWNER));
	return watchlistDigestEtag(digest);
}

describe("watchlist lists (ADR-0040)", () => {
	it("creates an empty list, answers it in the response and audits without the title", async () => {
		const h = harness();
		const created = unwrap(await h.service.createList(OWNER, { title: "  Semiconductors " }));
		expect(watchlistResponseSchema.parse(created).lists).toEqual([
			{
				listId: "list_1",
				title: "Semiconductors",
				stockIds: [],
				version: 1,
				createdAt: "2026-10-25T00:00:00.000Z",
				updatedAt: "2026-10-25T00:00:00.000Z",
			},
		]);
		expect(h.audits).toEqual([
			expect.objectContaining({ action: "watchlist.list.create", resource: "list_1", detail: "" }),
		]);
		expect(JSON.stringify(h.audits)).not.toContain("Semiconductors");
	});

	it("refuses a bad title and the 21st list with stable reasons", async () => {
		const h = harness();
		expect(failure(await h.service.createList(OWNER, { title: "   " })).code).toBe(
			"VALIDATION_FAILED",
		);
		for (let index = 0; index < 20; index += 1) {
			unwrap(await h.service.createList(OWNER, { title: `List ${index}` }));
		}
		expect(failure(await h.service.createList(OWNER, { title: "One more" }))).toMatchObject({
			code: "VALIDATION_FAILED",
			detail: "WATCHLIST_LISTS_FULL",
		});
		expect(h.lists).toHaveLength(20);
	});

	it("renames and deletes lists; unknown or malformed ids are NOT_FOUND", async () => {
		const h = harness();
		unwrap(await h.service.createList(OWNER, { title: "Chips" }));
		const renamed = unwrap(await h.service.renameList(OWNER, "list_1", { title: "Semis" }));
		expect(renamed.lists[0]).toMatchObject({ title: "Semis", version: 2 });
		expect(failure(await h.service.renameList(OWNER, "list_9", { title: "X" })).code).toBe(
			"NOT_FOUND",
		);
		expect(failure(await h.service.renameList(OWNER, "bad id", { title: "X" })).code).toBe(
			"NOT_FOUND",
		);
		expect(failure(await h.service.renameList(OWNER, "list_1", { title: "" })).code).toBe(
			"VALIDATION_FAILED",
		);
		expect(unwrap(await h.service.deleteList(OWNER, "list_1")).lists).toEqual([]);
		expect(failure(await h.service.deleteList(OWNER, "list_1")).code).toBe("NOT_FOUND");
		expect(h.audits.map((entry) => entry.action)).toEqual([
			"watchlist.list.create",
			"watchlist.list.rename",
			"watchlist.list.delete",
		]);
		// Deleting a list cleans up the series nothing tracks any more.
		expect(h.deletions).toHaveLength(1);
	});

	it("adds a stock not yet watched to the watchlist first, then to the list", async () => {
		const h = harness();
		unwrap(await h.service.createList(OWNER, { title: "Chips" }));
		const added = unwrap(
			await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: " nvda " }),
		);
		expect(added.stocks.map((stock) => stock.stockId)).toEqual(["us:NVDA"]);
		expect(added.lists[0]).toMatchObject({ stockIds: ["us:NVDA"], version: 2 });
		expect(h.audits.map(({ action, resource, detail }) => ({ action, resource, detail }))).toEqual([
			{ action: "watchlist.list.create", resource: "list_1", detail: "" },
			{ action: "watchlist.stock.add", resource: "us:NVDA", detail: "market=US" },
			{ action: "watchlist.list.stock.add", resource: "list_1", detail: "stock=us:NVDA" },
		]);
		// Again: idempotent, nothing written, no audit.
		const again = unwrap(
			await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "NVDA" }),
		);
		expect(again.lists[0]).toMatchObject({ stockIds: ["us:NVDA"], version: 2 });
		expect(h.audits).toHaveLength(3);
	});

	it("adds an already-watched stock without a second watchlist audit", async () => {
		const h = harness();
		unwrap(await h.service.addStock(OWNER, { market: "JP", symbol: "7203" }));
		unwrap(await h.service.createList(OWNER, { title: "Japan" }));
		unwrap(await h.service.addListStock(OWNER, "list_1", { market: "JP", symbol: "7203" }));
		expect(h.audits.filter((entry) => entry.action === "watchlist.stock.add")).toHaveLength(1);
		expect(h.stocks).toHaveLength(1);
	});

	it("checks the list before touching the watchlist", async () => {
		const h = harness();
		expect(
			failure(await h.service.addListStock(OWNER, "list_9", { market: "US", symbol: "AAPL" })).code,
		).toBe("NOT_FOUND");
		unwrap(await h.service.createList(OWNER, { title: "Full" }));
		for (const symbol of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]) {
			unwrap(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol }));
		}
		const inserts = h.writes.watchlistInserts;
		expect(
			failure(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "M" })),
		).toMatchObject({ code: "VALIDATION_FAILED", detail: "WATCHLIST_LIST_FULL" });
		// Neither failure touched the watchlist.
		expect(h.writes.watchlistInserts).toBe(inserts);
		expect(h.stocks.map((stock) => stock.symbol)).not.toContain("M");
		expect(
			failure(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "7203" })).code,
		).toBe("VALIDATION_FAILED");
	});

	it("answers WATCHLIST_FULL and adds nothing when the watchlist is full", async () => {
		const h = harness({ maxStocks: 1 });
		unwrap(await h.service.addStock(OWNER, { market: "US", symbol: "AAPL" }));
		unwrap(await h.service.createList(OWNER, { title: "Chips" }));
		expect(
			failure(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "NVDA" })),
		).toMatchObject({ code: "VALIDATION_FAILED", detail: "WATCHLIST_FULL" });
		expect(h.lists[0]?.stockIds).toEqual([]);
		expect(h.writes.listAdds).toBe(0);
		// A watched stock still goes into the list.
		unwrap(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "AAPL" }));
		expect(h.lists[0]?.stockIds).toEqual(["us:AAPL"]);
	});

	it("removes a stock from a list, keeping it watched, and cleans up its series", async () => {
		const h = harness({
			homeWidgets: [
				{ type: "watchlist-prices", widgetId: "w-1", title: "C", size: "medium", listId: "list_1" },
			],
		});
		unwrap(await h.service.createList(OWNER, { title: "Chips" }));
		unwrap(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "NVDA" }));
		unwrap(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "AMD" }));
		const removed = unwrap(await h.service.removeListStock(OWNER, "list_1", "us:NVDA"));
		expect(removed.lists[0]).toMatchObject({ stockIds: ["us:AMD"], version: 4 });
		expect(removed.stocks.map((stock) => stock.stockId)).toEqual(["us:NVDA", "us:AMD"]);
		// Home still shows the list, so AMD's series is kept and NVDA's is not.
		expect(h.deletions).toEqual([["twelve-data:AMD"]]);
		expect(failure(await h.service.removeListStock(OWNER, "list_1", "us:NVDA")).code).toBe(
			"NOT_FOUND",
		);
		expect(failure(await h.service.removeListStock(OWNER, "list_9", "us:AMD")).code).toBe(
			"NOT_FOUND",
		);
		expect(failure(await h.service.removeListStock(OWNER, "list_1", "nope")).code).toBe(
			"NOT_FOUND",
		);
		expect(h.audits.at(-1)).toMatchObject({
			action: "watchlist.list.stock.remove",
			resource: "list_1",
			detail: "stock=us:NVDA",
		});
	});

	it("removing a watched stock takes it out of its lists and cleans up its series", async () => {
		const h = harness();
		unwrap(await h.service.createList(OWNER, { title: "Chips" }));
		unwrap(await h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "NVDA" }));
		const removed = unwrap(await h.service.removeStock(OWNER, "us:NVDA"));
		expect(removed.stocks).toEqual([]);
		expect(removed.lists[0]).toMatchObject({ stockIds: [], version: 3 });
		expect(h.deletions).toHaveLength(1);
	});

	it("skips the series clean-up while the stored dashboard is unreadable", async () => {
		const h = harness({ homeWidgets: "unreadable" });
		unwrap(await h.service.createList(OWNER, { title: "Chips" }));
		unwrap(await h.service.deleteList(OWNER, "list_1"));
		expect(h.deletions).toEqual([]);
	});

	it("leaves out a member the same response does not hold (a read between two writes)", async () => {
		const h = harness();
		unwrap(await h.service.createList(OWNER, { title: "Chips" }));
		// As if a concurrent add landed between the stock read and the list read.
		h.lists[0]?.stockIds.push("us:NVDA");
		const response = unwrap(await h.service.getWatchlist(OWNER));
		expect(watchlistResponseSchema.parse(response).lists[0]?.stockIds).toEqual([]);
	});

	it("changes the ETag on every list change", async () => {
		const h = harness();
		const seen = new Set([await digestEtag(h.service)]);
		const steps = [
			() => h.service.createList(OWNER, { title: "Chips" }),
			() => h.service.addListStock(OWNER, "list_1", { market: "US", symbol: "NVDA" }),
			() => h.service.renameList(OWNER, "list_1", { title: "Semis" }),
			() => h.service.removeListStock(OWNER, "list_1", "us:NVDA"),
			() => h.service.deleteList(OWNER, "list_1"),
		];
		for (const step of steps) {
			unwrap(await step());
			const etag = await digestEtag(h.service);
			expect(seen.has(etag)).toBe(false);
			seen.add(etag);
		}
	});
});
