-- =============================================================================
-- Research workspace: canonical database schema (SQLite dialect: Cloudflare D1
-- and node:sqlite, ADR-0008).
--
-- This file is the COMPLETE CURRENT SCHEMA. Running it once against an EMPTY
-- database initializes a fresh database; nothing else is needed. It is never
-- run against a database that already has tables (every statement is a plain
-- CREATE, so it fails instead of touching existing data).
--
-- Existing databases are upgraded by the numbered migrations in
-- `infra/migrations/`, never by this file. Both paths must produce the same
-- schema: `packages/adapters/test/sqlite/canonicalSchema.test.ts` compares
-- them object by object. A schema change therefore lands in BOTH places:
-- a new migration, and the matching edit here, plus the table's definition
-- document in docs/database/tables/ (checked by tableDocs.test.ts).
--
-- Conventions (docs/database/conventions.md):
--   * tables, columns: snake_case; every key starts with owner_id (API-004)
--   * timestamps: ISO-8601 UTC text (`_at`); calendar dates: YYYY-MM-DD (`_on`)
--   * indexes: idx_<table>__<column1>_<column2>; unique: uq_<table>__<columns>
--   * columns added by a later migration stay at the end of their table, in
--     migration order, so both paths produce the same column order
--
-- Sections, in dependency order:
--   1. Sources and articles          9. Stock directory
--   2. Conversations (workspaces)   10. Owner settings and runner
--   3. Research jobs                11. Audit and rate limits
--   4. Research results             12. Equities library
--   5. Notebooks                    13. Financial statements (SEC, J-Quants)
--   6. Home and market data         14. Materials (metals)
--   7. Watchlist and calendar       15. Reference data
--   8. Scheduled tasks
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Sources and articles
-- -----------------------------------------------------------------------------

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
    last_error_upstream_status INTEGER,
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

-- The article list: newest first, keyset-paged on (retrieved_at, article_id),
-- optionally filtered by source. Scanned backwards, so both ORDER BY terms
-- come from the index (no temporary sort).
CREATE INDEX idx_articles__owner_id_retrieved_at_article_id
    ON articles (owner_id, retrieved_at, article_id);


-- -----------------------------------------------------------------------------
-- 2. Conversations (workspaces)
-- -----------------------------------------------------------------------------

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

-- One run's chat message (idempotent notebook-assist replays).
CREATE INDEX idx_chat_messages__owner_id_workspace_id_run_id
    ON chat_messages (owner_id, workspace_id, run_id);

-- Which runs (or imports) contributed records to a workspace; drives export.
CREATE TABLE workspace_runs (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, workspace_id, run_id)
);


-- -----------------------------------------------------------------------------
-- 3. Research jobs
-- -----------------------------------------------------------------------------

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
    -- `seq` of the owner message that asked the run's question (0003).
    context_anchor_seq INTEGER,
    -- Most frequent tool error code when every tool call failed (0004).
    failure_detail TEXT,
    -- External service's answer status beside failure_code (0012, ADR-0037).
    failure_upstream_status INTEGER,
    PRIMARY KEY (owner_id, run_id),
    UNIQUE (owner_id, idempotency_key)
);

-- Active-job count and the runner's claim scan (state filters).
CREATE INDEX idx_research_jobs__owner_id_state_created_at
    ON research_jobs (owner_id, state, created_at);
-- Jobs of one conversation, newest first.
CREATE INDEX idx_research_jobs__owner_id_workspace_id_created_at_run_id
    ON research_jobs (owner_id, workspace_id, created_at, run_id);
-- Latest job of one kind (market, earnings, calendar, directory refreshes).
-- Every column is immutable after insert: one index write per job.
CREATE INDEX idx_research_jobs__owner_id_kind_created_at_run_id
    ON research_jobs (owner_id, kind, created_at, run_id);

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

CREATE INDEX idx_job_transitions__owner_id_run_id_transition_id
    ON job_transitions (owner_id, run_id, transition_id);

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


-- -----------------------------------------------------------------------------
-- 4. Research results
-- -----------------------------------------------------------------------------

CREATE TABLE evidence (
    owner_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY (owner_id, evidence_id)
);

CREATE INDEX idx_evidence__owner_id_run_id
    ON evidence (owner_id, run_id);

CREATE TABLE claims (
    owner_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY (owner_id, claim_id)
);

CREATE INDEX idx_claims__owner_id_run_id
    ON claims (owner_id, run_id);

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

CREATE INDEX idx_claim_evidence__owner_id_evidence_id
    ON claim_evidence (owner_id, evidence_id);

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

CREATE INDEX idx_research_records__owner_id_run_id_record_type_ordinal
    ON research_records (owner_id, run_id, record_type, ordinal);

CREATE TABLE datasets (
    owner_id TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    run_id TEXT,
    workspace_id TEXT,
    body_json TEXT NOT NULL,
    PRIMARY KEY (owner_id, dataset_id)
);

CREATE INDEX idx_datasets__owner_id_workspace_id
    ON datasets (owner_id, workspace_id);


-- -----------------------------------------------------------------------------
-- 5. Notebooks (ADR-0020)
-- -----------------------------------------------------------------------------

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

-- A conversation's notebook turns, newest first.
CREATE INDEX idx_notebook_turns__owner_id_workspace_id_created_at_run_id
    ON notebook_turns (owner_id, workspace_id, created_at, run_id);


-- -----------------------------------------------------------------------------
-- 6. Home and market data (FR-017, ADR-0044)
-- -----------------------------------------------------------------------------

CREATE TABLE home_dashboards (
    owner_id TEXT NOT NULL PRIMARY KEY,
    dashboard_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE market_series (
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
    unavailable_upstream_status INTEGER,
    -- API time of the last full history fetch (0019, ADR-0044).
    history_checked_at TEXT,
    PRIMARY KEY (owner_id, series_id)
);

-- WITHOUT ROWID: the primary key is the table, so a series' history is one
-- contiguous key range.
CREATE TABLE market_observations (
    owner_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    observed_on TEXT NOT NULL,
    value REAL NOT NULL,
    -- The day's bar beside the close in `value` (0023, ADR-0056): the three
    -- prices are set together or NULL together; volume needs them and is ≥ 0.
    open_value REAL,
    high_value REAL,
    low_value REAL CHECK (
        (open_value IS NULL AND high_value IS NULL AND low_value IS NULL)
        OR (open_value IS NOT NULL AND high_value IS NOT NULL AND low_value IS NOT NULL)
    ),
    volume REAL CHECK (volume IS NULL OR (volume >= 0 AND low_value IS NOT NULL)),
    PRIMARY KEY (owner_id, series_id, observed_on)
) WITHOUT ROWID;

-- One market's trading dates a `stock-prices-sync` asked for (0024,
-- ADR-0058 §2): a row without `retry_at` is final, one with it is asked
-- again from it (`not-yet-available`; `no-trading` until a newer day is
-- stored; `stored` while it was within `settleDays`, once more). The day
-- plan reads one market's window as a primary-key range.
CREATE TABLE stock_price_day (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    trading_on TEXT NOT NULL,
    outcome_code TEXT NOT NULL
        CHECK (outcome_code IN ('stored', 'no-trading', 'not-yet-available', 'too-old')),
    bar_count INTEGER NOT NULL CHECK (bar_count >= 0 AND ((outcome_code = 'stored') = (bar_count > 0))),
    checked_at TEXT NOT NULL,
    retry_at TEXT CHECK (
        (outcome_code <> 'not-yet-available' OR retry_at IS NOT NULL)
        AND (outcome_code <> 'too-old' OR retry_at IS NULL)
    ),
    PRIMARY KEY (owner_id, market, trading_on)
) WITHOUT ROWID;

-- A directory stock whose whole-window history is pending (0024, ADR-0058
-- §2): it owes a refetch after a split the job could not refetch within its
-- cap, and/or its last history answer was `unavailable` and it is backed
-- off until `retry_at`. Any stored history deletes the row. One market's
-- rows are a key range (a few hundred at most, no index).
CREATE TABLE stock_price_history (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL,
    refetch_requested_at TEXT,
    retry_at TEXT CHECK (refetch_requested_at IS NOT NULL OR retry_at IS NOT NULL),
    PRIMARY KEY (owner_id, market, symbol)
) WITHOUT ROWID;

-- Per market: the newest day the runner's split check covered completely
-- (0024, ADR-0058 §2), the claim's `adjustmentsSince`. Only moves forward.
CREATE TABLE stock_price_market (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    split_checked_on TEXT NOT NULL,
    PRIMARY KEY (owner_id, market)
) WITHOUT ROWID;

-- One market's earnings calendar (0032, ADR-0068): every announcement in
-- the window of the owner's stock-list stocks — Finnhub without a symbol
-- (US), every JPX workbook row (JP). Replaced all at once per market by an
-- `earnings-calendar-synced` completion; `announcement_date` NULL is
-- undecided (JPX 未定). Feeds no calendar export (`earnings_events` does).
-- One stock's rows are a primary-key range.
CREATE TABLE stock_earnings_calendar (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL,
    period_key TEXT NOT NULL,
    announcement_date TEXT,
    fiscal_period_label TEXT NOT NULL,
    fiscal_period_end TEXT,
    timing TEXT NOT NULL
        CHECK (timing IN ('before-open', 'after-close', 'during-session', 'unknown')),
    PRIMARY KEY (owner_id, market, symbol, period_key)
) WITHOUT ROWID;

-- Per market: when its earnings calendar was last stored and for which
-- window (0032, ADR-0068); `truncated_dates` lists the days whose answer
-- still hit Finnhub's row cap (a JSON array of dates).
CREATE TABLE stock_earnings_calendar_market (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    synced_at TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL CHECK (from_date <= to_date),
    event_count INTEGER NOT NULL CHECK (event_count >= 0),
    truncated_dates TEXT NOT NULL CHECK (json_valid(truncated_dates) AND json_type(truncated_dates) = 'array'),
    PRIMARY KEY (owner_id, market)
) WITHOUT ROWID;


-- -----------------------------------------------------------------------------
-- 7. Watchlist and calendar (FR-018, FR-019, ADR-0040)
-- -----------------------------------------------------------------------------

CREATE TABLE watchlist_stocks (
    owner_id TEXT NOT NULL,
    stock_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    added_at TEXT NOT NULL,
    last_refreshed_at TEXT,
    retrieved_at TEXT,
    unavailable_code TEXT,
    unavailable_upstream_status INTEGER,
    PRIMARY KEY (owner_id, stock_id)
);

CREATE TABLE earnings_events (
    owner_id TEXT NOT NULL,
    stock_id TEXT NOT NULL,
    period_key TEXT NOT NULL,
    announcement_date TEXT,
    fiscal_period_label TEXT NOT NULL,
    fiscal_period_end TEXT,
    timing TEXT NOT NULL,
    PRIMARY KEY (owner_id, stock_id, period_key)
) WITHOUT ROWID;

-- Only the SHA-256 of the subscription token is stored.
CREATE TABLE calendar_feeds (
    owner_id TEXT NOT NULL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

-- Google Calendar sync state. There is deliberately NO token column.
CREATE TABLE google_calendar_links (
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
    updated_at TEXT NOT NULL,
    last_failure_upstream_status INTEGER
);

CREATE TABLE watchlist_lists (
    owner_id TEXT NOT NULL,
    list_id TEXT NOT NULL,
    title TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, list_id)
);

CREATE TABLE watchlist_list_stocks (
    owner_id TEXT NOT NULL,
    list_id TEXT NOT NULL,
    stock_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, list_id, stock_id)
) WITHOUT ROWID;


-- -----------------------------------------------------------------------------
-- 8. Scheduled tasks (ADR-0033)
-- -----------------------------------------------------------------------------

CREATE TABLE scheduled_tasks (
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

-- The due scan every runner claim runs: a range on next_run_at (NULL unless
-- the task is active), ordered by (next_run_at, task_id).
CREATE INDEX idx_scheduled_tasks__owner_id_next_run_at_task_id
    ON scheduled_tasks (owner_id, next_run_at, task_id);


-- -----------------------------------------------------------------------------
-- 9. Stock directory (ADR-0034) and company profiles (ADR-0059 §3, migration 0027)
-- -----------------------------------------------------------------------------

-- WITHOUT ROWID: a search reads the owner's rows as one contiguous key range.
CREATE TABLE stock_directory (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    local_name TEXT,
    listing TEXT NOT NULL,
    symbol_key TEXT NOT NULL,
    name_key TEXT NOT NULL,
    local_name_key TEXT NOT NULL,
    search_key TEXT NOT NULL,
    PRIMARY KEY (owner_id, market, symbol)
) WITHOUT ROWID;

CREATE TABLE stock_directory_meta (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL,
    entry_count INTEGER NOT NULL,
    as_of TEXT,
    retrieved_at TEXT NOT NULL,
    fold_version INTEGER NOT NULL,
    PRIMARY KEY (owner_id, market)
) WITHOUT ROWID;

-- A Japanese stock's company profile from J-Quants' Listed Issue Master
-- (ADR-0059 §3): written only by a JP `stock-directory-refreshed`
-- completion (the market's rows replaced, symbols of the stored list only),
-- read by the Stocks page's Company tab with one key seek. No foreign key:
-- the directory's rows are replaced on every refresh.
CREATE TABLE stock_company_profile (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market = 'JP'),
    symbol TEXT NOT NULL CHECK (length(symbol) = 4),
    name_en TEXT CHECK (name_en IS NULL OR length(name_en) BETWEEN 1 AND 200),
    sector17_code TEXT NOT NULL CHECK (length(sector17_code) BETWEEN 1 AND 8),
    sector17_name TEXT NOT NULL CHECK (length(sector17_name) BETWEEN 1 AND 200),
    sector33_code TEXT NOT NULL CHECK (length(sector33_code) BETWEEN 1 AND 8),
    sector33_name TEXT NOT NULL CHECK (length(sector33_name) BETWEEN 1 AND 200),
    scale_category TEXT CHECK (scale_category IS NULL OR length(scale_category) BETWEEN 1 AND 200),
    market_segment_code TEXT NOT NULL CHECK (length(market_segment_code) BETWEEN 1 AND 8),
    market_segment_name TEXT NOT NULL CHECK (length(market_segment_name) BETWEEN 1 AND 200),
    -- The day J-Quants states the issue's information for (`Date`).
    as_of TEXT NOT NULL CHECK (length(as_of) = 10),
    -- When the runner fetched the master (the completion's `fetchedAt`).
    retrieved_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, market, symbol)
) WITHOUT ROWID;

-- An AI-written company summary (ADR-0060): the description and the
-- investment themes the owner's AI agent wrote for a Watchlist stock, in
-- English and Japanese, written by a `company-summarized` completion and
-- read by the Stocks page's Company tab with one key seek. `queued_at` is
-- set when the server queues the stock's summary job, so a stock whose job
-- fails is queued again a day later at the earliest. No foreign key: a
-- summary stays when its stock leaves the Watchlist or the directory.
CREATE TABLE stock_company_summary (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 16),
    -- When the server last queued a summary job for the stock.
    queued_at TEXT NOT NULL,
    description_en TEXT CHECK (description_en IS NULL OR length(description_en) BETWEEN 1 AND 1000),
    description_ja TEXT CHECK (description_ja IS NULL OR length(description_ja) BETWEEN 1 AND 1000),
    -- `[{"en": "...", "ja": "..."}, ...]`, 1 to 8 themes.
    themes_json TEXT CHECK (themes_json IS NULL OR json_valid(themes_json)),
    agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 2 AND 32),
    model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 100),
    -- When the completion that wrote the summary was stored; NULL before the first one.
    generated_at TEXT,
    -- The company overview (0029, ADR-0064): the evidenced entry, the facts
    -- the server filled in, the numbered references and who wrote it when;
    -- stored whole or not at all, its JSON shape checked on read.
    overview_json TEXT CHECK (
        overview_json IS NULL OR (json_valid(overview_json) AND length(overview_json) <= 60000)
    ),
    overview_facts_json TEXT CHECK (
        overview_facts_json IS NULL OR (json_valid(overview_facts_json) AND length(overview_facts_json) <= 4000)
    ),
    overview_references_json TEXT CHECK (
        overview_references_json IS NULL
        OR (json_valid(overview_references_json) AND length(overview_references_json) <= 16000)
    ),
    overview_agent_id TEXT CHECK (
        overview_agent_id IS NULL OR length(overview_agent_id) BETWEEN 2 AND 32
    ),
    overview_model TEXT CHECK (
        overview_model IS NULL OR length(overview_model) BETWEEN 1 AND 100
    ),
    overview_generated_at TEXT CHECK (
        (overview_json IS NULL) = (overview_generated_at IS NULL)
        AND (overview_facts_json IS NULL) = (overview_generated_at IS NULL)
        AND (overview_references_json IS NULL) = (overview_generated_at IS NULL)
        AND (overview_agent_id IS NULL) = (overview_generated_at IS NULL)
        AND (overview_model IS NULL OR overview_generated_at IS NOT NULL)
    ),
    -- The themes the Company tab shows, as `[en, ja]` pairs (0030, ADR-0066):
    -- the overview's when one is stored, else the summary's; NULL with
    -- neither. Derived by the two triggers below, never written by the app;
    -- the theme search reads it.
    theme_names TEXT CHECK (
        theme_names IS NULL OR (json_valid(theme_names) AND length(theme_names) <= 4000)
    ),
    CHECK (
        (description_en IS NULL) = (generated_at IS NULL)
        AND (description_ja IS NULL) = (generated_at IS NULL)
        AND (themes_json IS NULL) = (generated_at IS NULL)
        AND (agent_id IS NULL) = (generated_at IS NULL)
        AND (model IS NULL OR generated_at IS NOT NULL)
    ),
    PRIMARY KEY (owner_id, market, symbol)
) WITHOUT ROWID;

CREATE TRIGGER stock_company_summary_theme_names_insert AFTER INSERT ON stock_company_summary
BEGIN
    UPDATE stock_company_summary
    SET theme_names = CASE
        WHEN stock_company_summary.overview_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.label.en'), json_extract(t.value, '$.label.ja')))
            FROM json_each(stock_company_summary.overview_json, '$.themes') AS t
        )
        WHEN stock_company_summary.themes_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.en'), json_extract(t.value, '$.ja')))
            FROM json_each(stock_company_summary.themes_json) AS t
        )
    END
    WHERE owner_id = NEW.owner_id AND market = NEW.market AND symbol = NEW.symbol;
END;

CREATE TRIGGER stock_company_summary_theme_names_update AFTER UPDATE OF themes_json, overview_json ON stock_company_summary
BEGIN
    UPDATE stock_company_summary
    SET theme_names = CASE
        WHEN stock_company_summary.overview_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.label.en'), json_extract(t.value, '$.label.ja')))
            FROM json_each(stock_company_summary.overview_json, '$.themes') AS t
        )
        WHEN stock_company_summary.themes_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.en'), json_extract(t.value, '$.ja')))
            FROM json_each(stock_company_summary.themes_json) AS t
        )
    END
    WHERE owner_id = NEW.owner_id AND market = NEW.market AND symbol = NEW.symbol;
END;


-- -----------------------------------------------------------------------------
-- 10. Owner settings and runner
-- -----------------------------------------------------------------------------

CREATE TABLE owner_settings (
    owner_id TEXT NOT NULL PRIMARY KEY,
    agent_settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
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


-- -----------------------------------------------------------------------------
-- 11. Audit and rate limits
-- -----------------------------------------------------------------------------

CREATE TABLE rate_limits (
    owner_id TEXT NOT NULL,
    bucket TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (owner_id, bucket, window_start)
);

-- Append-only; the application only writes it. No secondary index: an
-- operator's forensic read walks audit_id (the rowid) backwards.
CREATE TABLE audit_log (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    detail TEXT NOT NULL,
    at TEXT NOT NULL
);


-- -----------------------------------------------------------------------------
-- 12. Equities library (docs/database/libraries/equities.md, docs/database/naming.md)
--
-- Exact values stay in validated record JSON as canonical decimal strings.
-- Relational projections enforce owner/entity references and index reads.
-- Every key and foreign key starts with owner_id; foreign keys are enforced
-- (`PRAGMA foreign_keys = ON` on every connection).
--
-- These are the ADR-0041 owner-import tables. Since ADR-0048 (section 13)
-- no code reads or writes them; an installation's imported rows are kept.
-- -----------------------------------------------------------------------------

CREATE TABLE equity_import (
    owner_id TEXT NOT NULL,
    import_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    committed_at TEXT NOT NULL,
    commit_sequence INTEGER NOT NULL CHECK (commit_sequence > 0),
    coverage_note TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    record_count INTEGER NOT NULL CHECK (record_count BETWEEN 1 AND 2000),
    PRIMARY KEY (owner_id, import_id),
    UNIQUE (owner_id, commit_sequence),
    UNIQUE (owner_id, idempotency_key)
) WITHOUT ROWID;

-- Import history: newest first, keyset-paged on (committed_at, import_id).
CREATE INDEX idx_equity_import__owner_id_committed_at_import_id
    ON equity_import (owner_id, committed_at DESC, import_id DESC);

CREATE TABLE equity_record (
    owner_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('issuer','identifier','security','listing','source','document','filing','statement','metric','fact','price','action','fx','guidance')),
    import_id TEXT NOT NULL,
    body_json TEXT NOT NULL CHECK (json_valid(body_json)),
    PRIMARY KEY (owner_id, record_id),
    UNIQUE (owner_id, record_type, record_id),
    FOREIGN KEY (owner_id, import_id) REFERENCES equity_import(owner_id, import_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE equity_issuer (
    owner_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    legal_name TEXT NOT NULL,
    local_name TEXT,
    PRIMARY KEY (owner_id, issuer_id),
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE equity_data_source (
    owner_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_id),
    FOREIGN KEY (owner_id, source_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE equity_source_document (
    owner_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    published_at TEXT,
    retrieved_at TEXT NOT NULL,
    -- A source's own record-update instant (0015): canonical UTC milliseconds,
    -- exactly 24 ASCII characters; NULL when unknown (no fabricated backfill).
    materials_source_updated_at TEXT
    CHECK (
        materials_source_updated_at IS NULL OR (
            typeof(materials_source_updated_at) = 'text'
            AND length(materials_source_updated_at) = 24
            AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') = materials_source_updated_at
        )
    ),
    PRIMARY KEY (owner_id, source_document_id),
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_id) REFERENCES equity_data_source(owner_id, source_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE equity_issuer_identifier (
    owner_id TEXT NOT NULL,
    identifier_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    scheme TEXT NOT NULL,
    value TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, identifier_id),
    FOREIGN KEY (owner_id, identifier_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT
) WITHOUT ROWID;

-- Import guard: one issuer per (scheme, value).
CREATE INDEX idx_equity_issuer_identifier__owner_id_scheme_value
    ON equity_issuer_identifier (owner_id, scheme, value);

CREATE TABLE equity_security (
    owner_id TEXT NOT NULL,
    security_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, security_id),
    FOREIGN KEY (owner_id, security_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_equity_security__owner_id_issuer_id_security_id
    ON equity_security (owner_id, issuer_id, security_id);

CREATE TABLE equity_listing (
    owner_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    security_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('JP','US')),
    venue_mic TEXT NOT NULL,
    symbol TEXT NOT NULL,
    listed_on TEXT,
    delisted_on TEXT,
    PRIMARY KEY (owner_id, listing_id),
    FOREIGN KEY (owner_id, listing_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, security_id) REFERENCES equity_security(owner_id, security_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_equity_listing__owner_id_security_id_listing_id
    ON equity_listing (owner_id, security_id, listing_id);
-- Import guard: overlapping listings of one (venue, symbol).
CREATE INDEX idx_equity_listing__owner_id_venue_mic_symbol
    ON equity_listing (owner_id, venue_mic, symbol);

CREATE TABLE equity_filing (
    owner_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    public_available_at TEXT,
    amendment_of_filing_id TEXT,
    PRIMARY KEY (owner_id, filing_id),
    UNIQUE (owner_id, issuer_id, filing_id),
    FOREIGN KEY (owner_id, filing_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id, amendment_of_filing_id) REFERENCES equity_filing(owner_id, issuer_id, filing_id) ON DELETE RESTRICT,
    CHECK (amendment_of_filing_id IS NULL OR amendment_of_filing_id <> filing_id)
) WITHOUT ROWID;

-- An issuer's filings by public availability (point-in-time fact reads).
CREATE INDEX idx_equity_filing__owner_id_issuer_id_public_available_at_filing_id
    ON equity_filing (owner_id, issuer_id, public_available_at, filing_id);

CREATE TABLE equity_statement (
    owner_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    period_end TEXT NOT NULL,
    PRIMARY KEY (owner_id, statement_id),
    FOREIGN KEY (owner_id, statement_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, filing_id) REFERENCES equity_filing(owner_id, filing_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_equity_statement__owner_id_filing_id_statement_id
    ON equity_statement (owner_id, filing_id, statement_id);

CREATE TABLE equity_metric_definition (
    owner_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    metric_code TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    PRIMARY KEY (owner_id, metric_definition_id),
    UNIQUE (owner_id, metric_code, version),
    FOREIGN KEY (owner_id, metric_definition_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE equity_financial_fact (
    owner_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, fact_id),
    FOREIGN KEY (owner_id, fact_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, statement_id) REFERENCES equity_statement(owner_id, statement_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, metric_definition_id) REFERENCES equity_metric_definition(owner_id, metric_definition_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_equity_financial_fact__owner_id_statement_id_fact_id
    ON equity_financial_fact (owner_id, statement_id, fact_id);

CREATE TABLE equity_price_bar (
    owner_id TEXT NOT NULL,
    price_bar_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    trading_on TEXT NOT NULL,
    supersedes_price_bar_id TEXT,
    PRIMARY KEY (owner_id, price_bar_id),
    UNIQUE (owner_id, listing_id, price_bar_id),
    FOREIGN KEY (owner_id, price_bar_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, listing_id) REFERENCES equity_listing(owner_id, listing_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, listing_id, supersedes_price_bar_id) REFERENCES equity_price_bar(owner_id, listing_id, price_bar_id) ON DELETE RESTRICT,
    CHECK (supersedes_price_bar_id IS NULL OR supersedes_price_bar_id <> price_bar_id)
) WITHOUT ROWID;

-- A listing's price history in trading-date order.
CREATE INDEX idx_equity_price_bar__owner_id_listing_id_trading_on_price_bar_id
    ON equity_price_bar (owner_id, listing_id, trading_on, price_bar_id);

CREATE TABLE equity_corporate_action (
    owner_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    security_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    effective_on TEXT NOT NULL,
    supersedes_action_id TEXT,
    PRIMARY KEY (owner_id, action_id),
    UNIQUE (owner_id, security_id, action_id),
    FOREIGN KEY (owner_id, action_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, security_id) REFERENCES equity_security(owner_id, security_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, security_id, supersedes_action_id) REFERENCES equity_corporate_action(owner_id, security_id, action_id) ON DELETE RESTRICT,
    CHECK (supersedes_action_id IS NULL OR supersedes_action_id <> action_id)
) WITHOUT ROWID;

-- A security's corporate actions in effective-date order.
CREATE INDEX idx_equity_corporate_action__owner_id_security_id_effective_on_action_id
    ON equity_corporate_action (owner_id, security_id, effective_on, action_id);

CREATE TABLE equity_fx_observation (
    owner_id TEXT NOT NULL,
    fx_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, fx_id),
    FOREIGN KEY (owner_id, fx_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT
) WITHOUT ROWID;

-- An issuer's guidance is read through UNIQUE (owner_id, issuer_id,
-- guidance_id); no separate index.
CREATE TABLE equity_guidance_observation (
    owner_id TEXT NOT NULL,
    guidance_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    supersedes_guidance_id TEXT,
    PRIMARY KEY (owner_id, guidance_id),
    UNIQUE (owner_id, issuer_id, guidance_id),
    FOREIGN KEY (owner_id, guidance_id) REFERENCES equity_record(owner_id, record_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id) REFERENCES equity_issuer(owner_id, issuer_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, source_document_id) REFERENCES equity_source_document(owner_id, source_document_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, metric_definition_id) REFERENCES equity_metric_definition(owner_id, metric_definition_id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_id, issuer_id, supersedes_guidance_id) REFERENCES equity_guidance_observation(owner_id, issuer_id, guidance_id) ON DELETE RESTRICT,
    CHECK (supersedes_guidance_id IS NULL OR supersedes_guidance_id <> guidance_id)
) WITHOUT ROWID;


-- -----------------------------------------------------------------------------
-- 13. Financial statements synced from SEC and J-Quants (ADR-0048, migration
--     0021; business descriptions ADR-0053, migration 0022; every directory
--     stock tracked ADR-0058, migration 0026; Japanese statements from
--     J-Quants, EDINET removed ADR-0059, migration 0027)
--
-- The comment blocks of infra/migrations/0021_equity_financial_sync.sql,
-- 0026_edinet_document_index.sql and 0027_jquants_financials.sql are
-- normative. Written only by a `financial-synced` runner completion in the
-- job's guarded batch (plus the claim-time directory reconcile on
-- equity_company and equity_sync_state); read by the Stocks page and the
-- financial widgets (packages/adapters/src/sql/equitySync.ts). Section 12's
-- import tables are no longer read or written.
-- -----------------------------------------------------------------------------

-- One row per company the owner tracks (or tracked). The source identity
-- (SEC CIK / J-Quants 5-character issue code), once resolved, is the durable
-- identity; the listing is how it was added.
CREATE TABLE equity_company (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 16),
    provider TEXT NOT NULL CHECK (provider IN ('sec', 'jquants')),
    source_company_id TEXT,
    name TEXT,
    fiscal_year_end TEXT,
    tracked INTEGER NOT NULL DEFAULT 1 CHECK (tracked IN (0, 1)),
    tracked_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, company_id),
    CHECK ((market = 'US') = (provider = 'sec'))
) WITHOUT ROWID;

-- One company per listing: track and findByListing seek it.
CREATE UNIQUE INDEX uq_equity_company__owner_id_market_symbol
    ON equity_company (owner_id, market, symbol);
-- One company per resolved issuer: findBySourceId seeks it.
CREATE UNIQUE INDEX uq_equity_company__owner_id_provider_source_company_id
    ON equity_company (owner_id, provider, source_company_id)
    WHERE source_company_id IS NOT NULL;

-- Every annual filing seen. Immutable except facts_status (pending ->
-- extracted | unavailable, with fact_count, primary_scope and the standard
-- it found). The projection reads only facts of a filing's primary_scope.
CREATE TABLE equity_report_filing (
    owner_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('sec', 'jquants')),
    source_document_id TEXT NOT NULL,
    form TEXT NOT NULL
        CHECK (form IN (
            '10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A',
            'earnings-report', 'amended-earnings-report'
        )),
    filed_on TEXT NOT NULL,
    submitted_at TEXT,
    period_start TEXT,
    period_end TEXT NOT NULL,
    accounting_standard TEXT CHECK (accounting_standard IN ('US-GAAP', 'JGAAP', 'IFRS')),
    amends_source_document_id TEXT,
    source_url TEXT NOT NULL,
    facts_status TEXT NOT NULL CHECK (facts_status IN ('pending', 'extracted', 'unavailable')),
    fact_count INTEGER NOT NULL DEFAULT 0 CHECK (fact_count >= 0),
    -- The scope of the statements the filing's values come from: consolidated
    -- when it reports any consolidated fact, else separate; set with its facts.
    primary_scope TEXT CHECK (primary_scope IN ('consolidated', 'separate')),
    first_seen_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, filing_id),
    CHECK ((facts_status = 'extracted') = (primary_scope IS NOT NULL)),
    FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

-- A company's filings newest first (claimContext: scanned backwards, no
-- temporary sort) and the company list's filing count. Immutable columns.
CREATE INDEX idx_equity_report_filing__owner_id_company_id_filed_on_filing_id
    ON equity_report_filing (owner_id, company_id, filed_on, filing_id);

-- The as-filed history: insert-only, a restatement adds rows beside the
-- earlier ones. metric_code is denormalized (NULL when unmapped) so a
-- metric-year's facts are one index range.
CREATE TABLE equity_reported_fact (
    owner_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    concept TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('consolidated', 'separate')),
    period_type TEXT NOT NULL CHECK (period_type IN ('duration', 'instant')),
    -- '' for an instant: part of the key, so it cannot be NULL.
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    unit TEXT NOT NULL,
    company_id TEXT NOT NULL,
    fiscal_year INTEGER NOT NULL,
    metric_code TEXT,
    value_decimal TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    -- value_decimal is part of the key: a filing that reports one key with two
    -- values keeps both (the selection then says `ambiguous`), while an exact
    -- repeat still collapses.
    PRIMARY KEY (
        owner_id, filing_id, concept, scope, period_type, period_start, period_end, unit,
        value_decimal
    ),
    CHECK ((period_type = 'instant') = (period_start = '')),
    FOREIGN KEY (owner_id, filing_id) REFERENCES equity_report_filing (owner_id, filing_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

-- A metric-year's facts: revisions, and factsOfKeys (one seek per touched
-- key). Covering — every entry carries the primary key, value_decimal
-- included — because without statistics
-- the planner prefers the key's owner_id prefix (every fact of the owner)
-- over a non-covering index. Unmapped facts are not indexed.
CREATE INDEX idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal
    ON equity_reported_fact (owner_id, company_id, metric_code, fiscal_year, value_decimal)
    WHERE metric_code IS NOT NULL;

-- The current authoritative value per company, fiscal year and metric, or
-- why it is unavailable; what the widgets read. Keyed years first: the
-- newest-years read (valueYears) and the company list's latest year walk
-- the key backwards; the per-year and per-metric reads are key seeks. No
-- secondary index.
CREATE TABLE equity_metric_value (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    metric_code TEXT NOT NULL,
    fiscal_year INTEGER NOT NULL,
    value_decimal TEXT,
    currency TEXT,
    unavailable_reason TEXT,
    filing_id TEXT,
    concept TEXT,
    scope TEXT CHECK (scope IN ('consolidated', 'separate')),
    period_start TEXT,
    period_end TEXT,
    derived INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0, 1)),
    reported_value_count INTEGER NOT NULL DEFAULT 0 CHECK (reported_value_count >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, company_id, fiscal_year, metric_code),
    CHECK (
        (value_decimal IS NULL AND unavailable_reason IS NOT NULL AND filing_id IS NULL)
        OR (value_decimal IS NOT NULL AND unavailable_reason IS NULL AND filing_id IS NOT NULL
            AND currency IS NOT NULL)
    ),
    FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

-- One row per company: schedule, last check / success / failure (stable
-- code + the provider's HTTP status, ADR-0037), and data_updated_at (the
-- read ETag).
CREATE TABLE equity_sync_state (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    next_due_at TEXT,
    -- The owner's last "Sync now" (or re-track) that asked for a sync no
    -- queued job serves yet; a job's end keeps it when it is newer than the
    -- job, however the job was created.
    sync_requested_at TEXT,
    last_checked_at TEXT,
    last_succeeded_at TEXT,
    failure_code TEXT,
    failure_upstream_status INTEGER,
    failure_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    -- The last completion said `more`: run again at once, SEC with fullCheck.
    more_pending INTEGER NOT NULL DEFAULT 0 CHECK (more_pending IN (0, 1)),
    data_updated_at TEXT,
    PRIMARY KEY (owner_id, company_id),
    FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

-- The due company of every runner claim (probe): a range on next_due_at,
-- in (next_due_at, company_id) order (company_id is the key every entry
-- carries). Rewritten once per sync.
CREATE INDEX idx_equity_sync_state__owner_id_next_due_at
    ON equity_sync_state (owner_id, next_due_at)
    WHERE next_due_at IS NOT NULL;

-- The never-checked due company of every runner claim (probe, ADR-0058 §3):
-- served before the refresh range above, in (next_due_at, company_id)
-- order. Partial: a company leaves it with its first check (migration 0026).
CREATE INDEX idx_equity_sync_state__owner_id_last_checked_at_next_due_at
    ON equity_sync_state (owner_id, last_checked_at, next_due_at)
    WHERE last_checked_at IS NULL AND next_due_at IS NOT NULL;

-- When the default companies were added, so removing one is not undone.
CREATE TABLE equity_sync_meta (
    owner_id TEXT NOT NULL PRIMARY KEY,
    defaults_added_at TEXT NOT NULL
) WITHOUT ROWID;

-- The newest annual report's business section (ADR-0053; US only since
-- ADR-0059): paragraphs as validated JSON, or not-found so the same report
-- is not read again. Replaced only by a report at least as new; kept after
-- untracking.
CREATE TABLE equity_business_description (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL CHECK (length(source_document_id) BETWEEN 1 AND 40),
    form TEXT NOT NULL CHECK (form IN ('10-K', '20-F', '40-F')),
    filed_on TEXT NOT NULL,
    period_end TEXT NOT NULL,
    source_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('extracted', 'not-found')),
    paragraphs_json TEXT NOT NULL CHECK (json_valid(paragraphs_json) AND length(paragraphs_json) <= 200000),
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, company_id),
    FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;


-- -----------------------------------------------------------------------------
-- 14. Materials (docs/database/libraries/materials.md)
--
-- Immutable, bounded owner-imported physical-material snapshots. No seed data.
-- Product/grade/basis and source identity are preserved in validated body_json.
-- -----------------------------------------------------------------------------

CREATE TABLE metal_series (
    owner_id TEXT NOT NULL,
    series_id TEXT NOT NULL CHECK (series_id GLOB 'materials:*' AND length(series_id) BETWEEN 11 AND 35),
    body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(body_json) <= 750000 AND json_extract(body_json, '$.seriesId') = series_id),
    committed_at TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    material TEXT NOT NULL,
    product TEXT NOT NULL,
    grade TEXT NOT NULL,
    basis TEXT NOT NULL,
    source_id TEXT NOT NULL,
    unit TEXT NOT NULL,
    frequency TEXT NOT NULL,
    publisher TEXT NOT NULL,
    source_url TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, series_id)
) WITHOUT ROWID;

CREATE TABLE metal_observation (
    owner_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    observed_on TEXT NOT NULL CHECK (length(observed_on) = 10),
    value_decimal TEXT NOT NULL CHECK (length(value_decimal) BETWEEN 1 AND 132),
    materials_source_updated_at TEXT CHECK (
        materials_source_updated_at IS NULL OR (
            typeof(materials_source_updated_at) = 'text'
            AND length(materials_source_updated_at) = 24
            AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') = materials_source_updated_at
        )
    ),
    PRIMARY KEY (owner_id, series_id, observed_on),
    FOREIGN KEY (owner_id, series_id) REFERENCES metal_series(owner_id, series_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER metal_series_immutable_update BEFORE UPDATE ON metal_series
BEGIN
    SELECT RAISE(ABORT, 'material series is immutable; import a new version');
END;

CREATE TRIGGER metal_series_immutable_delete BEFORE DELETE ON metal_series
BEGIN
    SELECT RAISE(ABORT, 'material series is immutable');
END;

CREATE TRIGGER metal_observation_immutable_update BEFORE UPDATE ON metal_observation
BEGIN
    SELECT RAISE(ABORT, 'material observations are immutable');
END;

CREATE TRIGGER metal_observation_immutable_delete BEFORE DELETE ON metal_observation
BEGIN
    SELECT RAISE(ABORT, 'material observations are immutable');
END;


-- -----------------------------------------------------------------------------
-- 15. Reference data
-- -----------------------------------------------------------------------------

-- Metadata displayed by earnings widgets (0018).
CREATE TABLE earnings_sources (
    market TEXT NOT NULL PRIMARY KEY CHECK (market IN ('US', 'JP')),
    source TEXT NOT NULL CHECK (source IN ('finnhub', 'jpx')),
    publisher TEXT NOT NULL,
    source_url TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO earnings_sources (market, source, publisher, source_url)
VALUES
    ('US', 'finnhub', 'Finnhub', 'https://finnhub.io/'),
    ('JP', 'jpx', 'Japan Exchange Group (JPX)', 'https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html');
