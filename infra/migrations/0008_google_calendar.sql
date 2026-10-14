-- Google Calendar sync link (FR-019 section 2.5), version 8.
-- One row per owner holding the sync state. There is deliberately NO token
-- column — ever: the refresh token lives only in the runner-side 0600 file
-- beside `runner-credential.json`, and only the authorization URL (client
-- id, redirect port, state, PKCE challenge — none of them a credential)
-- ever reaches this table, as `pending_auth_url` while connecting.
--
-- Columns: `status` is one of disconnected | connecting | connected |
-- needs-reconnect; `connect_from` remembers the status a connect run
-- started from so a failed/cancelled/lease-expired connect restores it;
-- `pending_auth_url` is the sign-in URL, only while connecting;
-- `synced_digest` is the SHA-256 of the desired set the last sync applied;
-- `last_inserted/updated/deleted/unchanged` are its counts;
-- `last_failure_code/at` carry a stable GOOGLE_* code, never provider text.
-- Timestamps are ISO-8601 UTC text.
--
-- No secondary indexes: every access path is by `owner_id` (ADR-0008: on D1
-- every index entry is an extra billed row write).
--
-- Rollback: `DELETE FROM job_transitions WHERE run_id IN
-- (SELECT run_id FROM research_jobs WHERE kind = 'google-calendar');
-- DELETE FROM research_jobs WHERE kind = 'google-calendar';
-- DROP TABLE google_calendar_links;` restores the version-7 schema.
-- Preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

CREATE TABLE IF NOT EXISTS google_calendar_links (
	owner_id TEXT NOT NULL PRIMARY KEY,
	status TEXT NOT NULL,
	connect_from TEXT,
	pending_auth_url TEXT,
	calendar_id TEXT,
	connected_at TEXT,
	last_synced_at TEXT,
	synced_digest TEXT,
	last_inserted INTEGER,
	last_updated INTEGER,
	last_deleted INTEGER,
	last_unchanged INTEGER,
	last_failure_code TEXT,
	last_failure_at TEXT,
	updated_at TEXT NOT NULL
);
