-- Japanese financial statements and company profiles from J-Quants; EDINET
-- removed (ADR-0059 §4), version 27.
--
-- What changes:
--   `equity_company`, `equity_report_filing` — rebuilt: `provider` CHECK
--   ('sec', 'jquants'); `equity_report_filing.form` CHECK replaces the
--   EDINET forms 'securities-report' / 'amended-securities-report' with
--   J-Quants' 'earnings-report' / 'amended-earnings-report' (a full-year
--   earnings summary, 決算短信, and a later correction of it).
--   `equity_sync_state` — rebuilt without `edinet_phase` (the shared EDINET
--   index's per-company state; the sync view's `phase` is gone).
--   `equity_business_description` — rebuilt: `form` CHECK without
--   'securities-report' (business descriptions are US only; J-Quants has
--   no business text).
--   `equity_reported_fact`, `equity_metric_value` — rebuilt unchanged (they
--   reference the rebuilt tables, which SQLite cannot drop under them).
--   `stock_company_profile` — new: a Japanese stock's J-Quants company
--   profile (Listed Issue Master), primary key (owner_id, market, symbol).
--   `edinet_document_index`, `edinet_index_day` — dropped with their index.
--   Every index of the rebuilt tables is created again as before.
--
-- Why: the owner cannot get EDINET access; Japanese annual figures now come
-- from the J-Quants earnings summaries (`GET /v2/fins/summary`) the owner's
-- `JQUANTS_API_KEY` already reaches, one query per company, and the
-- Company tab of a Japanese stock shows the J-Quants company profile
-- (`GET /v2/equities/master`, stored by the JP `stock-directory-refresh`
-- job) in place of the 事業の内容. SQLite cannot alter a CHECK, and a
-- parent table cannot be dropped while its children's rows reference it,
-- so the six equity sync tables are rebuilt as migration 0025 did: copy the rows aside, drop the
-- children before their parents, create the tables again as in
-- db/schema.sql, copy the rows back parents first, drop the copies. The
-- migration runs in one transaction; foreign keys stay enforced.
--
-- Rows touched:
--   - Every US row of the six tables is copied out and back unchanged
--     (`equity_sync_state` without `edinet_phase`).
--   - Every Japanese company stays (same `company_id`, listing, tracked
--     flag and `tracked_at`) with provider 'jquants', `source_company_id`
--     NULL (the first J-Quants sync resolves the 5-character issue code),
--     `fiscal_year_end` NULL (the first sync states it) and its name taken
--     again from the stored JP directory (local name, else English name;
--     the EDINET filer name only when the listing left the directory).
--   - Its EDINET filings, their facts, its metric values and its business
--     description are not copied back (deleted): no figure of the new
--     provider is mixed with an EDINET one.
--   - Its sync state is replaced by a never-checked one: no check, success
--     or failure, `consecutive_failures` 0, `more_pending` 0,
--     `sync_requested_at` NULL, `next_due_at` now (a Watchlist stock a day
--     earlier, the head start ADR-0058 §3 gives it; NULL for an untracked
--     company, which is off the schedule), `data_updated_at` now (its
--     values changed: the statement reads' ETag moves). The due probe
--     serves never-checked companies first, so every tracked Japanese
--     company is synced from J-Quants before any company is refreshed.
--   - Jobs of the removed kind `edinet-index` are deleted with their
--     transitions and events. A queued or leased `financial-sync` job of a
--     Japanese company stays: its next claim is a J-Quants claim.
--   - Every `edinet_index_day` and `edinet_document_index` row is deleted
--     with its table.
--
-- Indexes (docs/database/conventions.md §8): unchanged for the rebuilt
-- tables. `stock_company_profile` has none besides its primary key: the
-- Stocks read is one key seek, and a JP completion replaces the market's
-- rows as one key range.
--
-- Read path: `equitySync.ts` (packages/adapters/src/sql) as before, without
-- the EDINET index; `stock_company_profile` by `getCompanyProfile`
-- (packages/adapters/src/sql/repositories.ts) for `GET /api/v1/stocks/:id`.
-- Write path: a `financial-synced` completion as before; a JP
-- `stock-directory-refreshed` completion with `profiles` deletes the
-- market's profile rows and inserts the new ones joined to the stored
-- directory, in the job's guarded batch (`unitOfWork.ts`).
--
-- Rollback: restore the pre-migration backup (`wrangler d1 export`, see
-- docs/database/operations.md); the version-26 code cannot read provider
-- 'jquants' or the earnings-report forms. Without a backup the EDINET data
-- is gone: rebuild the tables the same way with the version-26 definitions
-- (migrations 0025 and 0026), deleting the J-Quants filings, facts and
-- values first and setting the JP companies' provider back to 'edinet';
-- recreate `edinet_index_day` and `edinet_document_index` empty (the
-- `edinet-index` job lists the days again) and drop `stock_company_profile`.

-- The removed job kind, with its transitions and events.
DELETE FROM job_events
WHERE (owner_id, run_id) IN (
    SELECT rj.owner_id, rj.run_id
    FROM research_jobs AS rj
    WHERE rj.kind = 'edinet-index'
);
DELETE FROM job_transitions
WHERE (owner_id, run_id) IN (
    SELECT rj.owner_id, rj.run_id
    FROM research_jobs AS rj
    WHERE rj.kind = 'edinet-index'
);
DELETE FROM research_jobs WHERE kind = 'edinet-index';

-- The shared EDINET index (the child first: its foreign key references the day).
DROP TABLE edinet_document_index;
DROP TABLE edinet_index_day;

-- The equity sync tables, copied aside, then dropped children first.
CREATE TABLE equity_company_0027 AS SELECT * FROM equity_company;
CREATE TABLE equity_report_filing_0027 AS SELECT * FROM equity_report_filing;
CREATE TABLE equity_reported_fact_0027 AS SELECT * FROM equity_reported_fact;
CREATE TABLE equity_metric_value_0027 AS SELECT * FROM equity_metric_value;
CREATE TABLE equity_sync_state_0027 AS SELECT * FROM equity_sync_state;
CREATE TABLE equity_business_description_0027 AS SELECT * FROM equity_business_description;

DROP TABLE equity_reported_fact;
DROP TABLE equity_report_filing;
DROP TABLE equity_metric_value;
DROP TABLE equity_sync_state;
DROP TABLE equity_business_description;
DROP TABLE equity_company;

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

-- Every company; a Japanese one moves to J-Quants with no resolved identity.
INSERT INTO equity_company (
    owner_id, company_id, market, symbol, provider, source_company_id, name, fiscal_year_end,
    tracked, tracked_at
)
SELECT
    eco.owner_id, eco.company_id, eco.market, eco.symbol,
    CASE eco.market WHEN 'JP' THEN 'jquants' ELSE eco.provider END,
    CASE eco.market WHEN 'JP' THEN NULL ELSE eco.source_company_id END,
    CASE eco.market
        WHEN 'JP' THEN coalesce(
            (
                SELECT nullif(substr(trim(coalesce(sd.local_name, sd.name)), 1, 200), '')
                FROM stock_directory AS sd
                WHERE sd.owner_id = eco.owner_id AND sd.market = 'JP' AND sd.symbol = eco.symbol
            ),
            eco.name
        )
        ELSE eco.name
    END,
    CASE eco.market WHEN 'JP' THEN NULL ELSE eco.fiscal_year_end END,
    eco.tracked, eco.tracked_at
FROM equity_company_0027 AS eco;

-- SEC filings only: every EDINET filing is left behind.
INSERT INTO equity_report_filing (
    owner_id, filing_id, company_id, provider, source_document_id, form, filed_on,
    submitted_at, period_start, period_end, accounting_standard, amends_source_document_id,
    source_url, facts_status, fact_count, primary_scope, first_seen_at, recorded_at
)
SELECT
    erf.owner_id, erf.filing_id, erf.company_id, erf.provider, erf.source_document_id,
    erf.form, erf.filed_on, erf.submitted_at, erf.period_start, erf.period_end,
    erf.accounting_standard, erf.amends_source_document_id, erf.source_url,
    erf.facts_status, erf.fact_count, erf.primary_scope, erf.first_seen_at, erf.recorded_at
FROM equity_report_filing_0027 AS erf
WHERE erf.provider = 'sec';

-- The facts of the filings copied back (one primary-key seek each).
INSERT INTO equity_reported_fact (
    owner_id, filing_id, concept, scope, period_type, period_start, period_end, unit,
    company_id, fiscal_year, metric_code, value_decimal, recorded_at
)
SELECT
    erp.owner_id, erp.filing_id, erp.concept, erp.scope, erp.period_type,
    erp.period_start, erp.period_end, erp.unit, erp.company_id, erp.fiscal_year,
    erp.metric_code, erp.value_decimal, erp.recorded_at
FROM equity_reported_fact_0027 AS erp
WHERE EXISTS (
    SELECT 1
    FROM equity_report_filing AS erf
    WHERE erf.owner_id = erp.owner_id AND erf.filing_id = erp.filing_id
);

-- The US companies' values and business descriptions.
INSERT INTO equity_metric_value (
    owner_id, company_id, metric_code, fiscal_year, value_decimal, currency,
    unavailable_reason, filing_id, concept, scope, period_start, period_end, derived,
    reported_value_count, updated_at
)
SELECT
    emv.owner_id, emv.company_id, emv.metric_code, emv.fiscal_year, emv.value_decimal,
    emv.currency, emv.unavailable_reason, emv.filing_id, emv.concept, emv.scope,
    emv.period_start, emv.period_end, emv.derived, emv.reported_value_count, emv.updated_at
FROM equity_metric_value_0027 AS emv
WHERE EXISTS (
    SELECT 1
    FROM equity_company AS eco
    WHERE eco.owner_id = emv.owner_id AND eco.company_id = emv.company_id AND eco.market = 'US'
);

INSERT INTO equity_business_description (
    owner_id, company_id, source_document_id, form, filed_on, period_end, source_url,
    status, paragraphs_json, truncated, fetched_at
)
SELECT
    ebd.owner_id, ebd.company_id, ebd.source_document_id, ebd.form, ebd.filed_on,
    ebd.period_end, ebd.source_url, ebd.status, ebd.paragraphs_json, ebd.truncated,
    ebd.fetched_at
FROM equity_business_description_0027 AS ebd
WHERE EXISTS (
    SELECT 1
    FROM equity_company AS eco
    WHERE eco.owner_id = ebd.owner_id AND eco.company_id = ebd.company_id AND eco.market = 'US'
);

-- The US companies' sync state unchanged (without edinet_phase).
INSERT INTO equity_sync_state (
    owner_id, company_id, next_due_at, sync_requested_at, last_checked_at, last_succeeded_at,
    failure_code, failure_upstream_status, failure_at, consecutive_failures, more_pending,
    data_updated_at
)
SELECT
    ess.owner_id, ess.company_id, ess.next_due_at, ess.sync_requested_at, ess.last_checked_at,
    ess.last_succeeded_at, ess.failure_code, ess.failure_upstream_status, ess.failure_at,
    ess.consecutive_failures, ess.more_pending, ess.data_updated_at
FROM equity_sync_state_0027 AS ess
WHERE EXISTS (
    SELECT 1
    FROM equity_company AS eco
    WHERE eco.owner_id = ess.owner_id AND eco.company_id = ess.company_id AND eco.market = 'US'
);

-- Every Japanese company never checked and due now (a tracked Watchlist
-- stock a day earlier; an untracked company off the schedule).
INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, data_updated_at)
SELECT
    eco.owner_id, eco.company_id,
    CASE
        WHEN eco.tracked = 0 THEN NULL
        WHEN EXISTS (
            SELECT 1
            FROM watchlist_stocks AS ws
            WHERE ws.owner_id = eco.owner_id AND ws.stock_id = 'jp:' || eco.symbol
        ) THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM equity_company AS eco
WHERE eco.market = 'JP';

DROP TABLE equity_reported_fact_0027;
DROP TABLE equity_report_filing_0027;
DROP TABLE equity_metric_value_0027;
DROP TABLE equity_sync_state_0027;
DROP TABLE equity_business_description_0027;
DROP TABLE equity_company_0027;

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
