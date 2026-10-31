/**
 * Titled watchlist lists (ADR-0040): tables `watchlist_lists` and
 * `watchlist_list_stocks` of migration 0013. Rows are decoded through the
 * shared contracts on read (a bad stored title, id or member fails closed
 * with `StoredDataError`), and every rule that interleaved requests could
 * break — the list cap, the per-list cap, "the stock is on the watchlist" —
 * lives inside the writing statement itself.
 */
import type {
	StoredWatchlistList,
	WatchlistListAddOutcome,
	WatchlistListMember,
	WatchlistListRemoveOutcome,
	WatchlistListRepository,
} from "@research/application";
import {
	formatStockId,
	idSchema,
	isoDateTimeSchema,
	WATCHLIST_LISTS_LIMITS,
	watchlistListTitleSchema,
	watchlistStockIdSchema,
	watchMarketSchema,
} from "@research/contracts";
import { z } from "zod";
import type { SqlDatabase } from "./database.ts";
import { decode, StoredDataError } from "./rows.ts";

const LISTS = "watchlist_lists";
const MEMBERS = "watchlist_list_stocks";

/**
 * A stored title must already be the trimmed text the API accepted: the
 * schema's `trim` would otherwise silently repair a row, so the stored text
 * is compared with what the schema makes of it.
 */
const storedTitleSchema = z
	.string()
	.refine((title) => watchlistListTitleSchema.safeParse(title).data === title, {
		message: "invalid stored list title",
	});

/** One row of the list read: the list, plus one member (or none: an empty list). */
const listRowSchema = z.object({
	list_id: idSchema,
	title: storedTitleSchema,
	version: z.number().int().min(1),
	created_at: isoDateTimeSchema,
	updated_at: isoDateTimeSchema,
	stock_id: watchlistStockIdSchema.nullable(),
});

/** One requested list with one member resolved through `watchlist_stocks` (or none). */
const memberRowSchema = z.object({
	list_id: idSchema,
	stock_id: watchlistStockIdSchema.nullable(),
	market: watchMarketSchema.nullable(),
	symbol: z.string().nullable(),
});

/**
 * The guard every membership INSERT carries (bind order: owner, list,
 * stock, max): the list exists, the stock is on the watchlist and the list
 * has room. Written once so the version bump and the INSERT of one add test
 * exactly the same thing.
 */
const MEMBER_INSERT_GUARD = `EXISTS (
		SELECT 1
		FROM watchlist_lists AS wl_guard
		WHERE wl_guard.owner_id = ?1 AND wl_guard.list_id = ?2
	)
	AND EXISTS (
		SELECT 1
		FROM watchlist_stocks AS ws_guard
		WHERE ws_guard.owner_id = ?1 AND ws_guard.stock_id = ?3
	)
	AND (
		SELECT count(*)
		FROM watchlist_list_stocks AS wls_guard
		WHERE wls_guard.owner_id = ?1 AND wls_guard.list_id = ?2
	) < ?4`;

const addProbeSchema = z.object({
	list_found: z.number().nullable(),
	stock_found: z.number().nullable(),
	member_found: z.number().nullable(),
});

export function createWatchlistListRepository(db: SqlDatabase): WatchlistListRepository {
	return {
		async listLists(ownerId) {
			// One statement: every list with its members, lists in creation
			// order and members in the order they were added. At most
			// maxLists × maxStocksPerList rows (both caps live in the INSERTs).
			const { results } = await db
				.prepare(
					`SELECT wl.list_id, wl.title, wl.version, wl.created_at, wl.updated_at, wls.stock_id
					FROM watchlist_lists AS wl
					LEFT JOIN watchlist_list_stocks AS wls
						ON wls.owner_id = wl.owner_id AND wls.list_id = wl.list_id
					WHERE wl.owner_id = ?
					ORDER BY wl.created_at, wl.list_id, wls.added_at, wls.stock_id`,
				)
				.bind(ownerId)
				.all();
			const lists: StoredWatchlistList[] = [];
			let current: { list: StoredWatchlistList; stockIds: string[] } | null = null;
			for (const row of results) {
				const r = decode(LISTS, listRowSchema, row);
				if (current === null || current.list.listId !== r.list_id) {
					const stockIds: string[] = [];
					current = {
						list: {
							listId: r.list_id,
							title: r.title,
							version: r.version,
							createdAt: r.created_at,
							updatedAt: r.updated_at,
							stockIds,
						},
						stockIds,
					};
					lists.push(current.list);
				}
				if (r.stock_id !== null) current.stockIds.push(r.stock_id);
			}
			if (lists.length > WATCHLIST_LISTS_LIMITS.maxLists) {
				throw new StoredDataError(LISTS, "more lists than the cap");
			}
			for (const list of lists) {
				if (list.stockIds.length > WATCHLIST_LISTS_LIMITS.maxStocksPerList) {
					throw new StoredDataError(MEMBERS, "more members than the cap");
				}
			}
			return lists;
		},

		async insertList(ownerId, list, maxLists) {
			const listId = decode(LISTS, idSchema, list.listId);
			const title = decode(LISTS, storedTitleSchema, list.title);
			const createdAt = decode(LISTS, isoDateTimeSchema, list.createdAt);
			// The cap lives in the INSERT's own WHERE clause: two interleaved
			// creates at 19 cannot both write.
			const result = await db
				.prepare(
					`INSERT INTO watchlist_lists (owner_id, list_id, title, version, created_at, updated_at)
					SELECT ?1, ?2, ?3, 1, ?4, ?4
					WHERE (
						SELECT count(*)
						FROM watchlist_lists AS wl_existing
						WHERE wl_existing.owner_id = ?1
					) < ?5`,
				)
				.bind(ownerId, listId, title, createdAt, maxLists)
				.run();
			return result.meta.changes === 1 ? "created" : "full";
		},

		async renameList(ownerId, listId, title, now) {
			const result = await db
				.prepare(
					`UPDATE watchlist_lists
					SET title = ?, version = version + 1, updated_at = ?
					WHERE owner_id = ? AND list_id = ?`,
				)
				.bind(decode(LISTS, storedTitleSchema, title), now, ownerId, listId)
				.run();
			return result.meta.changes === 1;
		},

		async deleteList(ownerId, listId) {
			// The list and its memberships go in one atomic batch: no
			// membership can outlive its list.
			const results = await db.batch([
				db
					.prepare(`DELETE FROM watchlist_list_stocks WHERE owner_id = ? AND list_id = ?`)
					.bind(ownerId, listId),
				db
					.prepare(`DELETE FROM watchlist_lists WHERE owner_id = ? AND list_id = ?`)
					.bind(ownerId, listId),
			]);
			return (results[1]?.meta.changes ?? 0) === 1;
		},

		async addStock(ownerId, listId, stockId, now, maxStocksPerList) {
			// One atomic batch whose two statements test the same guard on
			// the same state: the version is bumped exactly when the
			// membership row is written (the bump also requires the row to be
			// new, which the INSERT's ON CONFLICT expresses).
			const results = await db.batch([
				db
					.prepare(
						`UPDATE watchlist_lists
						SET version = version + 1, updated_at = ?5
						WHERE owner_id = ?1
							AND list_id = ?2
							AND ${MEMBER_INSERT_GUARD}
							AND NOT EXISTS (
								SELECT 1
								FROM watchlist_list_stocks AS wls_member
								WHERE wls_member.owner_id = ?1
									AND wls_member.list_id = ?2
									AND wls_member.stock_id = ?3
							)`,
					)
					.bind(ownerId, listId, stockId, maxStocksPerList, now),
				db
					.prepare(
						`INSERT INTO watchlist_list_stocks (owner_id, list_id, stock_id, added_at)
						SELECT ?1, ?2, ?3, ?5
						WHERE ${MEMBER_INSERT_GUARD}
						ON CONFLICT (owner_id, list_id, stock_id) DO NOTHING`,
					)
					.bind(ownerId, listId, stockId, maxStocksPerList, now),
			]);
			if ((results[1]?.meta.changes ?? 0) === 1) return "added";
			// Nothing was written: one read tells the reasons apart. An
			// existing membership wins over a full list (an idempotent re-add
			// succeeds even at the cap).
			const probe = decode(
				MEMBERS,
				addProbeSchema,
				await db
					.prepare(
						`SELECT
							(
								SELECT 1
								FROM watchlist_lists AS wl
								WHERE wl.owner_id = ?1 AND wl.list_id = ?2
							) AS list_found,
							(
								SELECT 1
								FROM watchlist_stocks AS ws
								WHERE ws.owner_id = ?1 AND ws.stock_id = ?3
							) AS stock_found,
							(
								SELECT 1
								FROM watchlist_list_stocks AS wls
								WHERE wls.owner_id = ?1 AND wls.list_id = ?2 AND wls.stock_id = ?3
							) AS member_found`,
					)
					.bind(ownerId, listId, stockId)
					.first(),
			);
			const outcome: WatchlistListAddOutcome =
				probe.list_found === null
					? "list-not-found"
					: probe.member_found !== null
						? "already-present"
						: probe.stock_found === null
							? "stock-not-found"
							: "list-full";
			return outcome;
		},

		async removeStock(ownerId, listId, stockId, now) {
			// Bump first, guarded by the membership the DELETE then removes:
			// both in one atomic batch, so the version moves exactly when a
			// member leaves.
			const results = await db.batch([
				db
					.prepare(
						`UPDATE watchlist_lists
						SET version = version + 1, updated_at = ?4
						WHERE owner_id = ?1
							AND list_id = ?2
							AND EXISTS (
								SELECT 1
								FROM watchlist_list_stocks AS wls_member
								WHERE wls_member.owner_id = ?1
									AND wls_member.list_id = ?2
									AND wls_member.stock_id = ?3
							)`,
					)
					.bind(ownerId, listId, stockId, now),
				db
					.prepare(
						`DELETE FROM watchlist_list_stocks WHERE owner_id = ? AND list_id = ? AND stock_id = ?`,
					)
					.bind(ownerId, listId, stockId),
			]);
			if ((results[1]?.meta.changes ?? 0) === 1) return "removed";
			const list = await db
				.prepare(`SELECT 1 AS found FROM watchlist_lists WHERE owner_id = ? AND list_id = ?`)
				.bind(ownerId, listId)
				.first();
			const outcome: WatchlistListRemoveOutcome = list === null ? "list-not-found" : "not-in-list";
			return outcome;
		},

		async membersOf(ownerId, listIds) {
			const members = new Map<string, WatchlistListMember[]>();
			if (listIds.length === 0) return members;
			// One statement for every requested list (no N+1). Existing lists
			// start empty, so an empty list maps to [] and an unknown id is
			// absent; each member's market and symbol come from its
			// watchlist row.
			const { results } = await db
				.prepare(
					`SELECT wl.list_id, wls.stock_id, ws.market, ws.symbol
					FROM watchlist_lists AS wl
					LEFT JOIN watchlist_list_stocks AS wls
						ON wls.owner_id = wl.owner_id AND wls.list_id = wl.list_id
					LEFT JOIN watchlist_stocks AS ws
						ON ws.owner_id = wls.owner_id AND ws.stock_id = wls.stock_id
					WHERE wl.owner_id = ?1
						AND wl.list_id IN (SELECT requested.value FROM json_each(?2) AS requested)
					ORDER BY wl.list_id, wls.added_at, wls.stock_id`,
				)
				.bind(ownerId, JSON.stringify(listIds))
				.all();
			for (const row of results) {
				const r = decode(MEMBERS, memberRowSchema, row);
				const entry = members.get(r.list_id) ?? [];
				members.set(r.list_id, entry);
				// No member row: the list exists and is empty.
				if (r.stock_id === null && r.market === null && r.symbol === null) continue;
				// A member must be a whole watchlist row whose id names the same
				// stock (fail closed on anything else).
				if (
					r.stock_id === null ||
					r.market === null ||
					r.symbol === null ||
					formatStockId(r.market, r.symbol) !== r.stock_id
				) {
					throw new StoredDataError(MEMBERS, "stock_id");
				}
				entry.push({ stockId: r.stock_id, market: r.market, symbol: r.symbol });
			}
			return members;
		},
	};
}
