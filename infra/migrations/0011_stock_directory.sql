-- Stock directory (ADR-0034), version 10: every exchange-listed US and
-- Japanese stock, downloaded by the runner one market per job and searched
-- from the Watchlist's add-a-stock form.
--
-- `stock_directory` holds one row per listed stock per owner and market. A
-- `stock-directory-refreshed` completion replaces ONE market's rows all or
-- nothing, in the same guarded batch as its job write
-- (`packages/adapters/src/sql/unitOfWork.ts`). The `*_key` columns are the
-- folded search keys computed in TypeScript at insert
-- (`stockSearchKeys` / `stockSearchHaystack` in `packages/domain`) — never
-- in SQL, so the SQL ranking and the domain reference read the same keys:
-- `search_key` is the haystack every query term must be a substring of;
-- `symbol_key`, `name_key` and `local_name_key` decide the prefix tiers.
-- `local_name` is the Japanese name of a JP listing (NULL for US rows;
-- `local_name_key` is then '').
--
-- `stock_directory_meta` holds one row per owner and market: how many rows
-- are stored, the date the source says its list is effective (JPX; NULL for
-- SEC), when the stored list was downloaded, and `fold_version` — the
-- `STOCK_SEARCH_FOLD_VERSION` the market's keys were computed with. A search
-- that finds a different version re-keys that market's rows in TypeScript
-- before answering, so a changed fold never leaves stale keys behind. A
-- market without a meta row was never downloaded.
--
-- WITHOUT ROWID: the primary key (owner, market, symbol) IS the table, so a
-- search reads the owner's rows as one contiguous range of the B-tree
-- instead of an index range plus a rowid lookup per row (measured in
-- `apps/api/test/stockDirectory.test.ts`). No secondary indexes: every
-- access path is a primary-key prefix (ADR-0008: on D1 every index entry is
-- an extra billed row write, and a refresh writes thousands of rows).
--
-- Rollback: `DELETE FROM job_transitions WHERE run_id IN
-- (SELECT run_id FROM research_jobs WHERE kind = 'stock-directory-refresh');
-- DELETE FROM research_jobs WHERE kind = 'stock-directory-refresh';
-- DROP TABLE stock_directory; DROP TABLE stock_directory_meta;` restores the
-- version-9 schema (the version-9 code cannot read the
-- `stock-directory-refresh` kind, so its job rows go too).
-- Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

CREATE TABLE IF NOT EXISTS stock_directory (
	owner_id TEXT NOT NULL,
	market TEXT NOT NULL,
	symbol TEXT NOT NULL,
	name TEXT NOT NULL,
	local_name TEXT,
	listing TEXT NOT NULL,
	symbol_key TEXT NOT NULL,
	name_key TEXT NOT NULL,
	local_name_key TEXT NOT NULL,
	search_key TEXT NOT NULL,
	PRIMARY KEY (owner_id, market, symbol)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stock_directory_meta (
	owner_id TEXT NOT NULL,
	market TEXT NOT NULL,
	entry_count INTEGER NOT NULL,
	as_of TEXT,
	retrieved_at TEXT NOT NULL,
	fold_version INTEGER NOT NULL,
	PRIMARY KEY (owner_id, market)
) WITHOUT ROWID;
