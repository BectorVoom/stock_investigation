-- Annual financial statements synchronised from SEC EDGAR and EDINET
-- (ADR-0045), version 20.
--
-- Replaces the owner's manual normalized-file import (ADR-0041) as the only
-- way financial data enters the database. The import's `equity_*` ledger
-- tables (migrations 0014/0015) are NOT dropped or changed here: an
-- installation that imported files keeps those rows untouched (export them
-- with `wrangler d1 export` before removing them through a separate
-- administrative operation). No code reads or writes them any more.
--
-- Write path: a `financial-synced` runner completion, committed in the
-- job's guarded batch (`packages/adapters/src/sql/unitOfWork.ts`), never a
-- page or widget request. Read path: the statement, metric, revision and
-- company reads of the Equities page and the financial widgets.
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
--   `filing_id` = '<provider>:<sourceDocumentId>' (SEC accession, EDINET
--   docID); both are permanent public identifiers.
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
--   metric and fiscal year (the latest filing's best-ranked concept,
--   `selectMetricValue`), or an explicit unavailable reason. A projection of
--   equity_reported_fact, recomputed by a sync only for the metric-years its
--   new facts touch and written only when the selection changed
--   (`ON CONFLICT … DO UPDATE … WHERE` the stored row differs). Widgets read
--   this table only.
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
-- Indexes follow the reads (ADR-0008: on D1 every index entry is a billed
-- row write, so only access paths that a read uses):
--   * statements / metric series: equity_metric_value primary key prefix
--     (owner, company, metric, fiscal_year) — one range per metric;
--   * revisions and projection recompute: equity_reported_fact_by_metric_year;
--   * filings of a company newest first: equity_report_filing_by_company;
--   * scheduler: equity_sync_state_by_due.
--
-- Rollback: `wrangler d1 export` first (docs/OPERATIONS.md), then
-- DELETE FROM job_transitions WHERE run_id IN (SELECT run_id FROM
-- research_jobs WHERE kind = 'financial-sync'); DELETE FROM research_jobs
-- WHERE kind = 'financial-sync'; and DROP the seven tables below. The
-- version-19 code cannot read the `financial-sync` job kind.

CREATE TABLE IF NOT EXISTS equity_company (
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

CREATE UNIQUE INDEX IF NOT EXISTS equity_company_unique_listing
	ON equity_company (owner_id, market, symbol);
CREATE UNIQUE INDEX IF NOT EXISTS equity_company_unique_source
	ON equity_company (owner_id, provider, source_company_id)
	WHERE source_company_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS equity_report_filing (
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

CREATE INDEX IF NOT EXISTS equity_report_filing_by_company
	ON equity_report_filing (owner_id, company_id, filed_on DESC, filing_id DESC);

CREATE TABLE IF NOT EXISTS equity_reported_fact (
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

CREATE INDEX IF NOT EXISTS equity_reported_fact_by_metric_year
	ON equity_reported_fact (owner_id, company_id, metric_code, fiscal_year)
	WHERE metric_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS equity_metric_value (
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
	PRIMARY KEY (owner_id, company_id, metric_code, fiscal_year),
	CHECK (
		(value_decimal IS NULL AND unavailable_reason IS NOT NULL AND filing_id IS NULL)
		OR (value_decimal IS NOT NULL AND unavailable_reason IS NULL AND filing_id IS NOT NULL
			AND currency IS NOT NULL)
	),
	FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
		ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS equity_sync_state (
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

CREATE INDEX IF NOT EXISTS equity_sync_state_by_due
	ON equity_sync_state (owner_id, next_due_at)
	WHERE next_due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS equity_edinet_scanned_day (
	owner_id TEXT NOT NULL,
	company_id TEXT NOT NULL,
	scanned_on TEXT NOT NULL,
	PRIMARY KEY (owner_id, company_id, scanned_on),
	FOREIGN KEY (owner_id, company_id) REFERENCES equity_company (owner_id, company_id)
		ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS equity_sync_meta (
	owner_id TEXT NOT NULL PRIMARY KEY,
	defaults_added_at TEXT NOT NULL
) WITHOUT ROWID;
