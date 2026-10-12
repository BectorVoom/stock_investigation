-- AI agent settings, version 2.
-- One row per owner: the stored agent defaults for new questions (section 10).
-- Timestamps are ISO-8601 UTC text. The JSON column is validated against the
-- shared contracts on write and on read.
--
-- Rollback: `DELETE FROM owner_settings` removes the feature's rows; dropping
-- the table restores the version-1 schema. Preceded by `wrangler d1 export`
-- (see docs/OPERATIONS.md).

CREATE TABLE owner_settings (
	owner_id TEXT NOT NULL PRIMARY KEY,
	agent_settings_json TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
