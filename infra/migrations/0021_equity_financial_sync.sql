-- Annual financial statements synchronised from SEC EDGAR and EDINET
-- (ADR-0048), version 21.
--
-- What changes: seven new owner-scoped tables and their five secondary
-- indexes (two of them unique). No existing table, column, index or row is
-- touched.
--
-- Why: replaces the owner's manual normalized-file import (ADR-0041) as the
-- only way financial data enters the database. The import's `equity_*`
-- ledger tables (migrations 0014/0015) are NOT dropped or changed here: an
-- installation that imported files keeps those rows untouched (export them
-- with `wrangler d1 export` before removing them through a separate
-- administrative operation). No code reads or writes them any more.
--
-- Rows touched: none. The migration only creates empty tables; the first
-- rows arrive when the API adds the owner's default companies.
--
-- Write path: a `financial-synced` runner completion, committed in the
-- job's guarded batch (`packages/adapters/src/sql/unitOfWork.ts`), never a
-- page or widget request. Read path: the statement, metric, revision and
-- company reads of the Equities page and the financial widgets
-- (`packages/adapters/src/sql/equitySync.ts`).
--
-- equity_company — one row per company the owner tracks (or tracked):
--   the listing (market, symbol) it was added by and, once the first sync
--   resolved it, the issuer's source identity (SEC CIK / EDINET code),
--   which is the durable identity (docs/NAMING_CONVENTIONS.md: never the
--   ticker). Untracking sets `tracked = 0` and keeps every stored filing,
--   fact and value (historical data is removed only by a separate
--   administrative operation).
--
-- equity_report_filing — one row per annual filing seen (10-K, 10-K/A,
--   有価証券報告書 and its 訂正). Immutable once its facts are recorded,
--   except `facts_status`, which moves only pending → extracted|unavailable.
--   `filing_id` = '<companyId>:<provider>:<sourceDocumentId>' (SEC
--   accession, EDINET docID — permanent public identifiers): per company,
--   because SEC co-registrants share one accession across issuers.
--
-- equity_reported_fact — the as-filed history: every annual fact of every
--   filing, as the source reported it (sign not applied). Insert-only
--   (`INSERT … ON CONFLICT DO NOTHING`): a later filing that restates a year
--   adds its own rows beside the earlier ones, so previously reported values
--   and their filings are never overwritten. `fiscal_year` is derived by the
--   API from `period_end` (`fiscalYearOfPeriodEnd`). `metric_code` is the
--   normalized metric the concept maps to (NULL when unmapped) — denormalized
--   so a metric-year's facts are one index range.
--
-- equity_metric_value — the current authoritative value per company,
--   fiscal year and metric (the latest filing's best-ranked concept,
--   `selectMetricValue`), or an explicit unavailable reason. A projection of
--   equity_reported_fact, recomputed by a sync only for the metric-years its
--   new facts touch and written only when the selection changed
--   (`ON CONFLICT … DO UPDATE … WHERE` the stored row differs). Widgets read
--   this table only. The key is (owner, company, fiscal_year, metric): every
--   read is "the newest N years, then those years' metrics", so years
--   first lets the year list come straight off the key (below).
--
-- equity_sync_state — one row per company: schedule (`next_due_at`), the
--   last check / success, the last failure (stable code + the provider's HTTP
--   status unchanged, ADR-0037), EDINET's scan phase, and `data_updated_at`
--   (the last time equity_metric_value changed: the read ETag).
--
-- equity_edinet_scanned_day — the EDINET dates fully listed for a company
--   (`edinetScanPlan` never plans them again).
--
-- equity_sync_meta — one row per owner: when the proof-of-concept companies
--   were first added, so removing one is not undone by the next claim.
--
-- Indexes (docs/DATABASE_CONVENTIONS.md §8; on D1 every index entry is a
-- billed row write, so only access paths a read uses). EXPLAIN QUERY PLAN
-- and timings of the queries in packages/adapters/src/sql/equitySync.ts on
-- node:sqlite, one owner with 40 companies x 25 fiscal years x 3 filings x
-- 120 facts (360,000 facts, 30,000 metric values); the plans are pinned in
-- packages/adapters/test/sqlite/canonicalSchema.test.ts:
--   uq_equity_company__owner_id_market_symbol
--       the listing is unique; track / findByListing: one covering seek.
--   uq_equity_company__owner_id_provider_source_company_id
--       partial (source_company_id IS NOT NULL): one company per resolved
--       issuer; findBySourceId: one covering seek.
--   idx_equity_report_filing__owner_id_company_id_filed_on_filing_id
--       a company's filings newest first (claimContext: the index scanned
--       backwards, no temporary sort) and the company list's filing count
--       (a covering range). Every column is immutable after insert.
--   idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal
--       partial (metric_code IS NOT NULL), and covering: an entry of a
--       WITHOUT ROWID index carries the primary key, so value_decimal is
--       the only other column the reads need. Without statistics the
--       planner prices `owner_id = ?` on the primary key at a few rows, so
--       with the four-column index it still read every fact of the owner:
--         revisions (one metric-year)   21.5 ms -> 0.024 ms
--         factsOfKeys (90 keys)          96 ms  -> 0.15 ms
--       (factsOfKeys also needs its CROSS JOIN: with a plain JOIN the
--       planner scanned the keys innermost, 33 ms with this index; with
--       CROSS JOIN but no value_decimal, 393 ms.) Immutable, and unmapped
--       facts (about half) cost no index write.
--   idx_equity_sync_state__owner_id_next_due_at
--       partial (next_due_at IS NOT NULL): the due company of every runner
--       claim (`probe`), in (next_due_at, company_id) order from the index:
--       1 row read instead of every state row of the owner plus a
--       temporary sort (0.010 -> 0.003 ms at 40 companies). Rewritten once
--       per sync, against a probe at every claim.
--   equity_metric_value: no secondary index. Its key is (owner, company,
--       fiscal_year, metric): the newest-years read of every statement and
--       metric request (valueYears) and the company list's latest year
--       walk it backwards and stop early (valueYears 0.083 -> 0.031 ms and
--       no temporary B-trees, company list 1.09 -> 0.11 ms, against the
--       metric-first key), and the per-year / per-(year, metric) reads are
--       key seeks.
--   Kept as is: the company list sorts its few dozen rows (ORDER BY
--   tracked_at, market DESC, symbol) in a temporary B-tree; an index on
--   tracked_at would be rewritten on every re-track for no gain.

-- Rollback: `wrangler d1 export` first (docs/OPERATIONS.md), then
-- DELETE FROM job_transitions WHERE run_id IN (SELECT run_id FROM
-- research_jobs WHERE kind = 'financial-sync'); DELETE FROM research_jobs
-- WHERE kind = 'financial-sync'; and DROP the seven tables below (their
-- indexes go with them). The version-20 code cannot read the
-- `financial-sync` job kind.

CREATE TABLE equity_company (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 16),
    provider TEXT NOT NULL CHECK (provider IN ('sec', 'edinet')),
    source_company_id TEXT,
    name TEXT,
    fiscal_year_end TEXT,
    tracked INTEGER NOT NULL DEFAULT 1 CHECK (tracked IN (0, 1)),
    tracked_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, company_id),
    CHECK ((market = 'US') = (provider = 'sec'))
) WITHOUT ROWID;

CREATE UNIQUE INDEX uq_equity_company__owner_id_market_symbol
    ON equity_company (owner_id, market, symbol);
CREATE UNIQUE INDEX uq_equity_company__owner_id_provider_source_company_id
    ON equity_company (owner_id, provider, source_company_id)
    WHERE source_company_id IS NOT NULL;

CREATE TABLE equity_report_filing (
    owner_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('sec', 'edinet')),
    source_document_id TEXT NOT NULL,
    form TEXT NOT NULL
        CHECK (form IN ('10-K', '10-K/A', 'securities-report', 'amended-securities-report')),
    filed_on TEXT NOT NULL,
    submitted_at TEXT,
    period_start TEXT,
    period_end TEXT NOT NULL,
    accounting_standard TEXT CHECK (accounting_standard IN ('US-GAAP', 'JGAAP', 'IFRS')),
    amends_source_document_id TEXT,
    source_url TEXT NOT NULL,
    facts_status TEXT NOT NULL CHECK (facts_status IN ('pending', 'extracted', 'unavailable')),
    fact_count INTEGER NOT NULL DEFAULT 0 CHECK (fact_count >= 0),
    first_seen_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, filing_id),
    FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_equity_report_filing__owner_id_company_id_filed_on_filing_id
    ON equity_report_filing (owner_id, company_id, filed_on, filing_id);

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
    PRIMARY KEY (owner_id, filing_id, concept, scope, period_type, period_start, period_end, unit),
    CHECK ((period_type = 'instant') = (period_start = '')),
    FOREIGN KEY (owner_id, filing_id) REFERENCES equity_report_filing (owner_id, filing_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal
    ON equity_reported_fact (owner_id, company_id, metric_code, fiscal_year, value_decimal)
    WHERE metric_code IS NOT NULL;

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

CREATE TABLE equity_sync_state (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    next_due_at TEXT,
    last_checked_at TEXT,
    last_succeeded_at TEXT,
    failure_code TEXT,
    failure_upstream_status INTEGER,
    failure_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    -- The last completion said `more`: run again at once, SEC with fullCheck.
    more_pending INTEGER NOT NULL DEFAULT 0 CHECK (more_pending IN (0, 1)),
    edinet_phase TEXT
        CHECK (edinet_phase IN ('discovery', 'backfill', 'forward', 'idle', 'not-found')),
    data_updated_at TEXT,
    PRIMARY KEY (owner_id, company_id),
    FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_equity_sync_state__owner_id_next_due_at
    ON equity_sync_state (owner_id, next_due_at)
    WHERE next_due_at IS NOT NULL;

CREATE TABLE equity_edinet_scanned_day (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    scanned_on TEXT NOT NULL,
    PRIMARY KEY (owner_id, company_id, scanned_on),
    FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
        ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE equity_sync_meta (
    owner_id TEXT NOT NULL PRIMARY KEY,
    defaults_added_at TEXT NOT NULL
) WITHOUT ROWID;
