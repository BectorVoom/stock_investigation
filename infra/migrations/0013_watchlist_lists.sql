-- Titled watchlist lists (ADR-0040), version 13.
-- One row per list per owner; one membership row per stock per list. Every
-- member is a watchlist stock: removing a stock from the watchlist deletes
-- its memberships in the same batch (and bumps those lists' versions), and
-- deleting a list deletes its memberships in the same batch — set-based like
-- every other table (no table here relies on FK enforcement).
-- `version` is monotonic per list and bumped by every change to it (rename,
-- a stock added or removed); the `/watchlist` ETag covers it. Lists are
-- listed in creation order (`created_at`, then `list_id`), members in the
-- order they were added (`added_at`, then `stock_id`). Timestamps are
-- ISO-8601 UTC text, so text order is time order. Stored titles and ids are
-- validated against the shared contracts on write and on read.
--
-- No secondary indexes: every access path is the owner's whole set (at most
-- 20 lists × 12 stocks) or a primary-key prefix. Removing a stock from the
-- watchlist finds its memberships by `(owner_id, …, stock_id)` over that
-- small owner range. On D1 every index entry is an extra billed row write
-- (ADR-0008).
--
-- Rollback: `DELETE FROM watchlist_list_stocks; DELETE FROM watchlist_lists;
-- DROP TABLE watchlist_list_stocks; DROP TABLE watchlist_lists;` restores the
-- version-12 schema (remove any `watchlist-prices` widgets from Home and
-- notebook bodies first: the version-12 code cannot read that widget type).
-- The watchlist stocks themselves are untouched.
-- Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

CREATE TABLE IF NOT EXISTS watchlist_lists (
	owner_id TEXT NOT NULL,
	list_id TEXT NOT NULL,
	title TEXT NOT NULL,
	version INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, list_id)
);

CREATE TABLE IF NOT EXISTS watchlist_list_stocks (
	owner_id TEXT NOT NULL,
	list_id TEXT NOT NULL,
	stock_id TEXT NOT NULL,
	added_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, list_id, stock_id)
) WITHOUT ROWID;
