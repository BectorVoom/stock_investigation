-- Research workspace schema, version 1.
-- Every table carries owner_id and every query filters on it (API-004), even
-- though V1 has a single owner. Timestamps are ISO-8601 UTC text. JSON columns
-- are validated against the shared contracts on write and on read.
--
-- Rollback: this is the initial migration; restore is "drop the database and
-- re-apply", preceded by `wrangler d1 export` (see docs/OPERATIONS.md).

CREATE TABLE news_sources (
	owner_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	canonical_url TEXT NOT NULL,
	source_type TEXT NOT NULL,
	title TEXT NOT NULL,
	publisher TEXT NOT NULL,
	license_policy TEXT NOT NULL,
	trust_classification TEXT NOT NULL,
	feed_status TEXT NOT NULL,
	last_fetched_at TEXT,
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, source_id),
	UNIQUE (owner_id, canonical_url)
);

CREATE TABLE articles (
	owner_id TEXT NOT NULL,
	article_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	canonical_url TEXT NOT NULL,
	publisher TEXT NOT NULL,
	title TEXT NOT NULL,
	published_at TEXT,
	retrieved_at TEXT NOT NULL,
	content_fingerprint TEXT NOT NULL,
	excerpt TEXT,
	PRIMARY KEY (owner_id, article_id),
	-- FR-003: one canonical article per URL and per content fingerprint.
	UNIQUE (owner_id, canonical_url),
	UNIQUE (owner_id, content_fingerprint)
);
CREATE INDEX articles_by_source ON articles (owner_id, source_id, retrieved_at DESC, article_id);
CREATE INDEX articles_by_retrieval ON articles (owner_id, retrieved_at DESC, article_id);

CREATE TABLE workspaces (
	owner_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	title TEXT NOT NULL,
	-- Monotonic; all writes are compare-and-set on it.
	version INTEGER NOT NULL,
	state_json TEXT NOT NULL,
	-- Id of the write that produced this row version; lets batched statements
	-- be made conditional on "my compare-and-set won".
	last_mutation_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, workspace_id)
);

CREATE TABLE workspace_commands (
	owner_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	command_id TEXT NOT NULL,
	-- Workspace version produced by applying the command.
	version INTEGER NOT NULL,
	command_json TEXT NOT NULL,
	origin TEXT NOT NULL,
	applied_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, workspace_id, command_id),
	UNIQUE (owner_id, workspace_id, version)
);

CREATE TABLE chat_messages (
	owner_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	run_id TEXT,
	claim_ids_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, message_id),
	UNIQUE (owner_id, workspace_id, seq)
);

CREATE TABLE research_jobs (
	owner_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	state TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	request_fingerprint TEXT NOT NULL,
	request_json TEXT,
	workspace_id TEXT,
	usage_json TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	max_attempts INTEGER NOT NULL,
	lease_generation INTEGER NOT NULL,
	lease_owner_id TEXT,
	lease_expires_at TEXT,
	last_event_seq INTEGER NOT NULL,
	cancel_requested INTEGER NOT NULL,
	failure_code TEXT,
	approval_request_json TEXT,
	retry_of_run_id TEXT,
	verification_status TEXT,
	provider_model TEXT,
	provider_session_ref TEXT,
	completed_generation INTEGER,
	-- Agent, prompt and tool versions and data cut-off of the published result (AGT-010).
	provenance_json TEXT,
	version INTEGER NOT NULL,
	last_mutation_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, run_id),
	UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX research_jobs_by_state ON research_jobs (owner_id, state, created_at);
CREATE INDEX research_jobs_by_workspace ON research_jobs (owner_id, workspace_id, created_at DESC);

-- Append-only audit trail of state transitions (section 6.3).
CREATE TABLE job_transitions (
	transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
	owner_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	from_state TEXT NOT NULL,
	to_state TEXT NOT NULL,
	lease_generation INTEGER NOT NULL,
	actor TEXT NOT NULL,
	reason TEXT NOT NULL,
	at TEXT NOT NULL
);
CREATE INDEX job_transitions_by_run ON job_transitions (owner_id, run_id, transition_id);

CREATE TABLE job_events (
	owner_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	lease_generation INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	text TEXT NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (owner_id, run_id, lease_generation, seq)
);

CREATE TABLE evidence (
	owner_id TEXT NOT NULL,
	evidence_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	body_json TEXT NOT NULL,
	PRIMARY KEY (owner_id, evidence_id)
);
CREATE INDEX evidence_by_run ON evidence (owner_id, run_id);

CREATE TABLE claims (
	owner_id TEXT NOT NULL,
	claim_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	status TEXT NOT NULL,
	body_json TEXT NOT NULL,
	PRIMARY KEY (owner_id, claim_id)
);
CREATE INDEX claims_by_run ON claims (owner_id, run_id);

-- Claim -> evidence edges, kept relational so "which claims rest on this
-- source" and referential checks do not require scanning JSON.
CREATE TABLE claim_evidence (
	owner_id TEXT NOT NULL,
	claim_id TEXT NOT NULL,
	evidence_id TEXT NOT NULL,
	relation TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	PRIMARY KEY (owner_id, claim_id, ordinal)
);
CREATE INDEX claim_evidence_by_evidence ON claim_evidence (owner_id, evidence_id);

-- Immutable, append-only typed research records (scenarios, securities,
-- supplier links, financial/position observations, filings, pricing power).
CREATE TABLE research_records (
	owner_id TEXT NOT NULL,
	record_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	record_type TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	body_json TEXT NOT NULL,
	PRIMARY KEY (owner_id, record_id)
);
CREATE INDEX research_records_by_run ON research_records (owner_id, run_id, record_type, ordinal);

CREATE TABLE datasets (
	owner_id TEXT NOT NULL,
	dataset_id TEXT NOT NULL,
	run_id TEXT,
	workspace_id TEXT,
	body_json TEXT NOT NULL,
	PRIMARY KEY (owner_id, dataset_id)
);
CREATE INDEX datasets_by_workspace ON datasets (owner_id, workspace_id);

CREATE TABLE approved_assets (
	owner_id TEXT NOT NULL,
	asset_id TEXT NOT NULL,
	body_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, asset_id)
);

-- Only a SHA-256 of the bearer token is stored (SEC-005).
CREATE TABLE runner_credentials (
	owner_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	label TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	revoked_at TEXT,
	last_used_at TEXT,
	PRIMARY KEY (owner_id, credential_id)
);

CREATE TABLE runner_status (
	owner_id TEXT PRIMARY KEY,
	last_seen_at TEXT NOT NULL,
	runner_version TEXT NOT NULL,
	agents_json TEXT NOT NULL
);

CREATE TABLE rate_limits (
	owner_id TEXT NOT NULL,
	bucket TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (owner_id, bucket, window_start)
);

CREATE TABLE audit_log (
	audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
	owner_id TEXT NOT NULL,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	resource TEXT NOT NULL,
	detail TEXT NOT NULL,
	at TEXT NOT NULL
);
CREATE INDEX audit_log_by_owner ON audit_log (owner_id, audit_id DESC);

-- Which runs (or imports) contributed records to a workspace; drives export.
CREATE TABLE workspace_runs (
	owner_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	PRIMARY KEY (owner_id, workspace_id, run_id)
);
