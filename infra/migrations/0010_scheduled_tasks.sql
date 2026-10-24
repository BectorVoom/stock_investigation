-- Scheduled tasks (ADR-0033), version 10.
-- One row per task per owner. A task owns one conversation (`workspace_id`,
-- created in the same batch); deleting that conversation deletes its tasks
-- in the delete batch of `packages/adapters/src/sql/unitOfWork.ts`, set-based
-- like every other table (no table here relies on FK enforcement).
-- `schedule_json` holds the validated `TaskSchedule`; `markets_json` the
-- markets array; `spend_consent_json` the consent or NULL. Stored JSON is
-- validated against the shared contracts on write and on read. Timestamps
-- are ISO-8601 UTC text, so text order is time order.
--
-- One secondary index: the due scan every runner claim runs
-- (`WHERE owner_id = ? AND next_run_at <= ?`; `next_run_at` is NULL unless
-- the task is active, so paused and completed tasks are not in the range).
-- Everything else is read by the primary key (ADR-0008: on D1 every index
-- entry is an extra billed row write).
--
-- Rollback: `DELETE FROM scheduled_tasks; DROP INDEX scheduled_tasks_due;
-- DROP TABLE scheduled_tasks;` restores the version-9 schema (remove any
-- `scheduled-tasks` widgets from Home and notebook bodies first: the
-- version-9 code cannot read that widget type). The conversations the tasks
-- created stay as ordinary conversations.
-- Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

CREATE TABLE IF NOT EXISTS scheduled_tasks (
	owner_id TEXT NOT NULL,
	task_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	title TEXT NOT NULL,
	question TEXT NOT NULL,
	horizon_years INTEGER NOT NULL,
	markets_json TEXT NOT NULL,
	schedule_json TEXT NOT NULL,
	time_zone TEXT NOT NULL,
	spend_consent_json TEXT,
	-- 'active' | 'paused' | 'completed'
	status TEXT NOT NULL,
	next_run_at TEXT,
	last_run_id TEXT,
	-- The slot the last run was queued for; NULL for a "Run now".
	last_slot_at TEXT,
	last_queued_at TEXT,
	last_skip_code TEXT,
	last_skip_slot_at TEXT,
	last_skip_at TEXT,
	-- Monotonic; every write is compare-and-set on it.
	version INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, task_id)
);

CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks (owner_id, next_run_at);
