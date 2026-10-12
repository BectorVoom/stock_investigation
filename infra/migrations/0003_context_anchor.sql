-- Stable conversation-context anchor, version 3.
-- `context_anchor_seq` is the `seq` of the owner message that asked a run's
-- question. Claims read the bounded context from BEFORE that sequence number,
-- so later messages can never push the question out of the window and a retry
-- inherits the same anchor as the run it retries. NULL for news-ingest jobs
-- (no workspace, no context) and for rows written before this migration: those
-- claims get an empty context (fail closed, ARCH-017).
--
-- Rollback: `ALTER TABLE research_jobs DROP COLUMN context_anchor_seq`
-- restores the version-2 schema (SQLite supports DROP COLUMN); rows written
-- while the column existed lose their anchors and fall back to empty context.
-- Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

ALTER TABLE research_jobs ADD COLUMN context_anchor_seq INTEGER;
