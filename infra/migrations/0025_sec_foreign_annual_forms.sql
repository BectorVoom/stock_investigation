-- Annual reports of foreign private issuers (ADR-0058 §5), version 25.
--
-- What changes: two CHECK constraints widen. `equity_report_filing.form`
-- also accepts SEC's Forms 20-F, 20-F/A, 40-F and 40-F/A beside 10-K and
-- 10-K/A; `equity_business_description.form` also accepts 20-F (its Item
-- 4.B "Business Overview" is read) and 40-F (recorded as not found: its
-- description is in an exhibit). No column, index, key or foreign key
-- changes.
--
-- Why: ADRs of foreign issuers (Rio Tinto, BHP, Toyota, Sony) file annual
-- reports on Form 20-F or 40-F, mostly under IFRS; the SEC importer now
-- reads them and the `ifrs-full` taxonomy (`accounting_standard` already
-- allows 'IFRS').
--
-- How: SQLite cannot alter a CHECK, so both tables are rebuilt with every
-- row kept: copy the rows aside, drop the tables (the child
-- `equity_reported_fact`, whose foreign key references
-- `equity_report_filing`, first; it is rebuilt unchanged), create them
-- again as in db/schema.sql with their indexes, copy the rows back, drop the
-- copies. The migration runs in one transaction; foreign keys stay enforced
-- (the parent is dropped only after its child, and its rows are back
-- before the child's). No table has a trigger.
--
-- Rows touched: every row of equity_report_filing, equity_reported_fact and
-- equity_business_description is copied out and back unchanged (same
-- columns, same values). Every existing row satisfies the wider CHECKs.
--
-- Rollback: restore the pre-migration backup (`wrangler d1 export`, see
-- docs/OPERATIONS.md). Without one, and only while no row holds a 20-F or
-- 40-F form: rebuild both tables the same way with the version-24 CHECKs
-- (`form IN ('10-K', '10-K/A', 'securities-report',
-- 'amended-securities-report')` and `form IN ('10-K',
-- 'securities-report')`); delete the rows of a 20-F/40-F filer first (its
-- facts, then its filings, values and description). The version-24 code
-- cannot read such a form.

CREATE TABLE equity_report_filing_0025 AS SELECT * FROM equity_report_filing;
CREATE TABLE equity_reported_fact_0025 AS SELECT * FROM equity_reported_fact;
CREATE TABLE equity_business_description_0025 AS SELECT * FROM equity_business_description;

DROP TABLE equity_reported_fact;
DROP TABLE equity_report_filing;
DROP TABLE equity_business_description;

-- Every annual filing seen. Immutable except facts_status (pending ->
-- extracted | unavailable, with fact_count, primary_scope and the standard
-- it found). The projection reads only facts of a filing's primary_scope.
CREATE TABLE equity_report_filing (
    owner_id TEXT NOT NULL,
    filing_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('sec', 'edinet')),
    source_document_id TEXT NOT NULL,
    form TEXT NOT NULL
        CHECK (form IN (
            '10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A',
            'securities-report', 'amended-securities-report'
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

CREATE INDEX idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal
    ON equity_reported_fact (owner_id, company_id, metric_code, fiscal_year, value_decimal)
    WHERE metric_code IS NOT NULL;

-- The newest annual report's business section (ADR-0053): paragraphs as
-- validated JSON, or not-found so the same report is not read again.
-- Replaced only by a report at least as new; kept after untracking.
CREATE TABLE equity_business_description (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL CHECK (length(source_document_id) BETWEEN 1 AND 40),
    form TEXT NOT NULL CHECK (form IN ('10-K', '20-F', '40-F', 'securities-report')),
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
FROM equity_report_filing_0025 AS erf;

INSERT INTO equity_reported_fact (
    owner_id, filing_id, concept, scope, period_type, period_start, period_end, unit,
    company_id, fiscal_year, metric_code, value_decimal, recorded_at
)
SELECT
    erp.owner_id, erp.filing_id, erp.concept, erp.scope, erp.period_type,
    erp.period_start, erp.period_end, erp.unit, erp.company_id, erp.fiscal_year,
    erp.metric_code, erp.value_decimal, erp.recorded_at
FROM equity_reported_fact_0025 AS erp;

INSERT INTO equity_business_description (
    owner_id, company_id, source_document_id, form, filed_on, period_end, source_url,
    status, paragraphs_json, truncated, fetched_at
)
SELECT
    ebd.owner_id, ebd.company_id, ebd.source_document_id, ebd.form, ebd.filed_on,
    ebd.period_end, ebd.source_url, ebd.status, ebd.paragraphs_json, ebd.truncated,
    ebd.fetched_at
FROM equity_business_description_0025 AS ebd;

DROP TABLE equity_report_filing_0025;
DROP TABLE equity_reported_fact_0025;
DROP TABLE equity_business_description_0025;
