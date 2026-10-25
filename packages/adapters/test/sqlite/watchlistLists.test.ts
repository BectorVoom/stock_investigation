import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createWatchlistRepository } from "../../src/sql/repositories.ts";
import { StoredDataError } from "../../src/sql/rows.ts";
import { createWatchlistListRepository } from "../../src/sql/watchlistLists.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * Titled watchlist lists (ADR-0040) on `node:sqlite` against the real
 * migrations (0013): caps inside the INSERTs, idempotent adds, version
 * bumps, ordering, the one-statement member resolution, and the cascade
 * when a stock leaves the watchlist. D1 runs the same SQL text through the
 * API suite.
 */
function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

const OWNER = "owner_1";
const T0 = "2026-10-25T00:00:00.000Z";

function at(seconds: number): string {
	return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

function setup() {
	const db = openMigrated();
	const watchlist = createWatchlistRepository(db);
	const lists = createWatchlistListRepository(db);
	async function watch(stockId: string, seconds = 0) {
		const [market, symbol] = stockId.startsWith("us:")
			? (["US", stockId.slice(3)] as const)
			: (["JP", stockId.slice(3)] as const);
		expect(
			await watchlist.insertStock(
				OWNER,
				{ stockId, market, symbol, name: null, addedAt: at(seconds) },
				50,
			),
		).toBe("added");
	}
	async function list(listId: string, title = listId, seconds = 0) {
		expect(await lists.insertList(OWNER, { listId, title, createdAt: at(seconds) }, 20)).toBe(
			"created",
		);
	}
	return { db, watchlist, lists, watch, list };
}

describe("watchlist list repository (ADR-0040)", () => {
	it("creates empty lists at version 1, in creation order, up to the cap", async () => {
		const { db, lists } = setup();
		try {
			expect(await lists.listLists(OWNER)).toEqual([]);
			expect(
				await lists.insertList(OWNER, { listId: "list_b", title: "Banks", createdAt: at(2) }, 3),
			).toBe("created");
			expect(
				await lists.insertList(OWNER, { listId: "list_a", title: "Chips", createdAt: at(1) }, 3),
			).toBe("created");
			// Same title twice is fine: a list is identified by its id.
			expect(
				await lists.insertList(OWNER, { listId: "list_c", title: "Chips", createdAt: at(3) }, 3),
			).toBe("created");
			expect(
				await lists.insertList(OWNER, { listId: "list_d", title: "Full", createdAt: at(4) }, 3),
			).toBe("full");
			// Another owner has its own cap.
			expect(
				await lists.insertList("owner_2", { listId: "list_d", title: "X", createdAt: at(4) }, 3),
			).toBe("created");
			const stored = await lists.listLists(OWNER);
			expect(stored.map((entry) => entry.listId)).toEqual(["list_a", "list_b", "list_c"]);
			expect(stored[0]).toEqual({
				listId: "list_a",
				title: "Chips",
				version: 1,
				createdAt: at(1),
				updatedAt: at(1),
				stockIds: [],
			});
		} finally {
			db.close();
		}
	});

	it("renames with a version bump; unknown lists are false", async () => {
		const { db, lists, list } = setup();
		try {
			await list("list_a", "Chips");
			expect(await lists.renameList(OWNER, "list_a", "Semis", at(5))).toBe(true);
			expect(await lists.renameList(OWNER, "list_x", "Semis", at(5))).toBe(false);
			expect(await lists.renameList("owner_2", "list_a", "Semis", at(5))).toBe(false);
			expect((await lists.listLists(OWNER))[0]).toMatchObject({
				title: "Semis",
				version: 2,
				updatedAt: at(5),
			});
		} finally {
			db.close();
		}
	});

	it("adds watchlist stocks in order, idempotently, bumping the version once per add", async () => {
		const { db, lists, watch, list } = setup();
		try {
			await watch("us:NVDA");
			await watch("jp:7203");
			await list("list_a");
			expect(await lists.addStock(OWNER, "list_a", "jp:7203", at(1), 12)).toBe("added");
			expect(await lists.addStock(OWNER, "list_a", "us:NVDA", at(2), 12)).toBe("added");
			expect(await lists.addStock(OWNER, "list_a", "jp:7203", at(3), 12)).toBe("already-present");
			const [stored] = await lists.listLists(OWNER);
			expect(stored?.stockIds).toEqual(["jp:7203", "us:NVDA"]);
			// Two adds: version 1 → 3; the idempotent re-add changed nothing.
			expect(stored?.version).toBe(3);
			expect(stored?.updatedAt).toBe(at(2));
		} finally {
			db.close();
		}
	});

	it("refuses a stock off the watchlist, an unknown list and a full list, writing nothing", async () => {
		const { db, lists, watch, list } = setup();
		try {
			await list("list_a");
			await watch("us:AAPL");
			await watch("us:MSFT");
			await watch("us:NVDA");
			expect(await lists.addStock(OWNER, "list_a", "us:TSLA", at(1), 2)).toBe("stock-not-found");
			expect(await lists.addStock(OWNER, "list_x", "us:AAPL", at(1), 2)).toBe("list-not-found");
			expect(await lists.addStock(OWNER, "list_a", "us:AAPL", at(1), 2)).toBe("added");
			expect(await lists.addStock(OWNER, "list_a", "us:MSFT", at(2), 2)).toBe("added");
			expect(await lists.addStock(OWNER, "list_a", "us:NVDA", at(3), 2)).toBe("list-full");
			// An idempotent re-add still succeeds at the cap.
			expect(await lists.addStock(OWNER, "list_a", "us:MSFT", at(3), 2)).toBe("already-present");
			const [stored] = await lists.listLists(OWNER);
			expect(stored?.stockIds).toEqual(["us:AAPL", "us:MSFT"]);
			expect(stored?.version).toBe(3);
			// Owner isolation: another owner's list of the same id is unknown here.
			expect(await lists.addStock("owner_2", "list_a", "us:AAPL", at(4), 2)).toBe("list-not-found");
		} finally {
			db.close();
		}
	});

	it("removes one membership with a version bump", async () => {
		const { db, lists, watch, list } = setup();
		try {
			await watch("us:AAPL");
			await list("list_a");
			await lists.addStock(OWNER, "list_a", "us:AAPL", at(1), 12);
			expect(await lists.removeStock(OWNER, "list_a", "us:MSFT", at(2))).toBe("not-in-list");
			expect(await lists.removeStock(OWNER, "list_x", "us:AAPL", at(2))).toBe("list-not-found");
			expect((await lists.listLists(OWNER))[0]?.version).toBe(2);
			expect(await lists.removeStock(OWNER, "list_a", "us:AAPL", at(3))).toBe("removed");
			expect((await lists.listLists(OWNER))[0]).toMatchObject({
				stockIds: [],
				version: 3,
				updatedAt: at(3),
			});
		} finally {
			db.close();
		}
	});

	it("deletes a list with its memberships in one batch", async () => {
		const { db, lists, watch, list } = setup();
		try {
			await watch("us:AAPL");
			await list("list_a");
			await list("list_b");
			await lists.addStock(OWNER, "list_a", "us:AAPL", at(1), 12);
			await lists.addStock(OWNER, "list_b", "us:AAPL", at(1), 12);
			expect(await lists.deleteList(OWNER, "list_a")).toBe(true);
			expect(await lists.deleteList(OWNER, "list_a")).toBe(false);
			expect((await lists.listLists(OWNER)).map((entry) => entry.listId)).toEqual(["list_b"]);
			const rows = await db
				.prepare("SELECT list_id FROM watchlist_list_stocks WHERE owner_id = ?")
				.bind(OWNER)
				.all();
			expect(rows.results).toEqual([{ list_id: "list_b" }]);
		} finally {
			db.close();
		}
	});

	it("removing a watchlist stock takes it out of every list and bumps those lists only", async () => {
		const { db, watchlist, lists, watch, list } = setup();
		try {
			await watch("us:AAPL");
			await watch("us:MSFT");
			await list("list_a");
			await list("list_b");
			await list("list_c");
			await lists.addStock(OWNER, "list_a", "us:AAPL", at(1), 12);
			await lists.addStock(OWNER, "list_a", "us:MSFT", at(1), 12);
			await lists.addStock(OWNER, "list_b", "us:AAPL", at(1), 12);
			await lists.addStock(OWNER, "list_c", "us:MSFT", at(1), 12);
			expect(await watchlist.removeStock(OWNER, "us:AAPL", at(9))).toBe(true);
			expect(await watchlist.removeStock(OWNER, "us:AAPL", at(9))).toBe(false);
			const stored = await lists.listLists(OWNER);
			expect(
				stored.map(({ listId, stockIds, version, updatedAt }) => ({
					listId,
					stockIds,
					version,
					updatedAt,
				})),
			).toEqual([
				{ listId: "list_a", stockIds: ["us:MSFT"], version: 4, updatedAt: at(9) },
				{ listId: "list_b", stockIds: [], version: 3, updatedAt: at(9) },
				// Never held AAPL: untouched.
				{ listId: "list_c", stockIds: ["us:MSFT"], version: 2, updatedAt: at(1) },
			]);
		} finally {
			db.close();
		}
	});

	it("resolves the requested lists' members in list order with market and symbol", async () => {
		const { db, lists, watch, list } = setup();
		try {
			await watch("us:BRK.B");
			await watch("jp:7203");
			await list("list_a");
			await list("list_b");
			await list("list_empty");
			await lists.addStock(OWNER, "list_a", "jp:7203", at(1), 12);
			await lists.addStock(OWNER, "list_a", "us:BRK.B", at(2), 12);
			await lists.addStock(OWNER, "list_b", "us:BRK.B", at(1), 12);
			expect((await lists.membersOf(OWNER, [])).size).toBe(0);
			const members = await lists.membersOf(OWNER, ["list_a", "list_empty", "list_gone"]);
			expect([...members.keys()].sort()).toEqual(["list_a", "list_empty"]);
			expect(members.get("list_a")).toEqual([
				{ stockId: "jp:7203", market: "JP", symbol: "7203" },
				{ stockId: "us:BRK.B", market: "US", symbol: "BRK.B" },
			]);
			expect(members.get("list_empty")).toEqual([]);
			expect(members.has("list_b")).toBe(false);
			expect((await lists.membersOf("owner_2", ["list_a"])).size).toBe(0);
		} finally {
			db.close();
		}
	});

	it("fails closed on bad stored data", async () => {
		const { db, lists, list } = setup();
		try {
			await list("list_a");
			await db
				.prepare("UPDATE watchlist_lists SET title = ? WHERE owner_id = ?")
				.bind("  padded  ", OWNER)
				.run();
			await expect(lists.listLists(OWNER)).rejects.toBeInstanceOf(StoredDataError);
			await db
				.prepare("UPDATE watchlist_lists SET title = 'Fine' WHERE owner_id = ?")
				.bind(OWNER)
				.run();
			// A membership whose id and watchlist row disagree.
			await db
				.prepare(
					`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
					VALUES (?, 'us:AAPL', 'US', 'MSFT', NULL, ?)`,
				)
				.bind(OWNER, T0)
				.run();
			await db
				.prepare(
					`INSERT INTO watchlist_list_stocks (owner_id, list_id, stock_id, added_at)
					VALUES (?, 'list_a', 'us:AAPL', ?)`,
				)
				.bind(OWNER, T0)
				.run();
			await expect(lists.membersOf(OWNER, ["list_a"])).rejects.toBeInstanceOf(StoredDataError);
			await db
				.prepare("UPDATE watchlist_list_stocks SET stock_id = 'not a stock' WHERE owner_id = ?")
				.bind(OWNER)
				.run();
			await expect(lists.listLists(OWNER)).rejects.toBeInstanceOf(StoredDataError);
		} finally {
			db.close();
		}
	});
});
