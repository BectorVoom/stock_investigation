-- Watchlist stocks and earnings-announcement calendar (FR-018), version 7.
-- One watchlist row per stock per owner (insertion order is kept through
-- `added_at`; the API returns stocks in the order they were added); one
-- earnings-event row per fiscal period per stock (replaced set-based on every
-- successful refresh); one calendar-feed row per owner holding only the
-- SHA-256 of the subscription token (the token itself is never stored, like
-- runner credentials in ADR-0002).
-- Timestamps are ISO-8601 UTC text. Stored symbols and dates are validated
-- against the shared contracts on write and on read.
--
-- No secondary indexes: every access path is covered by a primary key
-- (`earnings_events` is WITHOUT ROWID, so its primary key IS the table;
-- `calendar_feeds` is looked up by `owner_id` or by its UNIQUE `token_hash`,
-- which SQLite serves from the automatic unique index), and on D1 every
-- index entry is an extra billed row write.
--
-- Rollback: `DELETE FROM earnings_events; DELETE FROM watchlist_stocks;
-- DELETE FROM calendar_feeds; DELETE FROM job_transitions WHERE run_id IN
-- (SELECT run_id FROM research_jobs WHERE kind = 'earnings-refresh');
-- DELETE FROM research_jobs WHERE kind = 'earnings-refresh';
-- DROP TABLE earnings_events; DROP TABLE watchlist_stocks;
-- DROP TABLE calendar_feeds;` restores the version-6 schema (the version-6
-- code cannot read the `earnings-refresh` kind, so its job rows go too).
-- Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

CREATE TABLE IF NOT EXISTS watchlist_stocks (
	owner_id TEXT NOT NULL,
	stock_id TEXT NOT NULL,
	market TEXT NOT NULL,
	symbol TEXT NOT NULL,
	name TEXT,
	added_at TEXT NOT NULL,
	last_refreshed_at TEXT,
	retrieved_at TEXT,
	unavailable_code TEXT,
	PRIMARY KEY (owner_id, stock_id)
);

CREATE TABLE IF NOT EXISTS earnings_events (
	owner_id TEXT NOT NULL,
	stock_id TEXT NOT NULL,
	period_key TEXT NOT NULL,
	announcement_date TEXT,
	fiscal_period_label TEXT NOT NULL,
	fiscal_period_end TEXT,
	timing TEXT NOT NULL,
	PRIMARY KEY (owner_id, stock_id, period_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS calendar_feeds (
	owner_id TEXT NOT NULL PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
);
