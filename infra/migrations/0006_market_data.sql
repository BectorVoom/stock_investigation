-- Market data for the Home dashboard (FR-017), version 6.
-- One dashboard row per owner (compare-and-set on version); one metadata row
-- per series; observations keyed by (owner, series, date) so refreshes upsert.
-- Timestamps are ISO-8601 UTC text. Stored dashboard JSON is validated against
-- the shared contracts on write and on read.
--
-- No secondary indexes: each table's primary key already covers its access
-- path (market_observations is WITHOUT ROWID, so its primary key IS the
-- table), and on D1 every index entry is an extra billed row write.
--
-- Rollback: `DELETE FROM market_observations; DELETE FROM market_series;
-- DELETE FROM home_dashboards; DROP TABLE market_observations;
-- DROP TABLE market_series; DROP TABLE home_dashboards;` restores the version-5
-- schema. Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).
--
-- IF NOT EXISTS is deliberate: until the merge of 2026-10-13 this file was
-- named `0005_market_data.sql`. A development database that applied it under
-- that name sees this one as new, and must pass it without an error and
-- without touching the tables it already has.

CREATE TABLE IF NOT EXISTS home_dashboards (
	owner_id TEXT NOT NULL PRIMARY KEY,
	dashboard_json TEXT NOT NULL,
	version INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_series (
	owner_id TEXT NOT NULL,
	series_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	symbol TEXT NOT NULL,
	title TEXT NOT NULL,
	unit TEXT NOT NULL,
	frequency TEXT NOT NULL,
	publisher TEXT NOT NULL,
	source_url TEXT NOT NULL,
	last_refreshed_at TEXT,
	retrieved_at TEXT,
	unavailable_code TEXT,
	PRIMARY KEY (owner_id, series_id)
);

CREATE TABLE IF NOT EXISTS market_observations (
	owner_id TEXT NOT NULL,
	series_id TEXT NOT NULL,
	observed_on TEXT NOT NULL,
	value REAL NOT NULL,
	PRIMARY KEY (owner_id, series_id, observed_on)
) WITHOUT ROWID;
