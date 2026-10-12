-- Run failure detail, version 4.
-- A short stable code (e.g. TIMEOUT) carried alongside `failure_code` when
-- every executed tool call of a run failed (`ALL_TOOL_CALLS_FAILED`). Null
-- otherwise. Never free text from a tool: only the most frequent tool error
-- code, truncated like `failure_code`.
--
-- Rollback: `ALTER TABLE research_jobs DROP COLUMN failure_detail` restores
-- the version-3 schema (SQLite ≥ 3.35). Preceded by `wrangler d1 export`
-- (see docs/OPERATIONS.md).

ALTER TABLE research_jobs ADD COLUMN failure_detail TEXT;
