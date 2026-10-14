-- Notebook of one conversation (ADR-0020), version 9.
-- One current row per workspace (compare-and-set on version); the last 20
-- bodies per workspace for undo; one row per assistant turn for the chat
-- card. Timestamps are ISO-8601 UTC text. Stored bodies are validated
-- against the shared notebook contracts on write and on read; an unreadable
-- body is reported as STORED_NOTEBOOK_UNREADABLE, never silently replaced.
--
-- Deleting a conversation deletes its notebook, revisions and turns: the
-- delete path in `packages/adapters/src/sql/unitOfWork.ts` removes them in
-- the same guarded batch as everything else it owns (set-based, like the
-- other tables — no table in this schema relies on FK enforcement).
--
-- Also adds an index for looking up one run's chat message (idempotent
-- `notebook-assist` replays answer with the same owner message).
--
-- No secondary indexes beyond the two access paths below: every other read
-- is by the primary key (ADR-0008: on D1 every index entry is an extra
-- billed row write).
--
-- Rollback: `DELETE FROM notebook_turns;
-- DELETE FROM workspace_notebook_revisions; DELETE FROM workspace_notebooks;
-- DROP TABLE notebook_turns; DROP TABLE workspace_notebook_revisions;
-- DROP TABLE workspace_notebooks; DROP INDEX chat_messages_by_run;`
-- restores the version-8 schema.
-- Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

CREATE TABLE workspace_notebooks (
	owner_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	body_json TEXT NOT NULL,
	-- Monotonic; all writes are compare-and-set on it.
	version INTEGER NOT NULL,
	-- Id of the write that produced this row version; lets the revision and
	-- prune statements of the same batch be conditional on "my compare-and-set
	-- won", so a lost race writes nothing at all.
	last_mutation_id TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, workspace_id)
);

CREATE TABLE workspace_notebook_revisions (
	owner_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	body_json TEXT NOT NULL,
	PRIMARY KEY (owner_id, workspace_id, version)
);

CREATE TABLE notebook_turns (
	owner_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	base_version INTEGER NOT NULL,
	applied_version INTEGER,
	body_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, run_id)
);
CREATE INDEX notebook_turns_by_workspace ON notebook_turns (owner_id, workspace_id, created_at);

CREATE INDEX chat_messages_by_run ON chat_messages (owner_id, workspace_id, run_id);
