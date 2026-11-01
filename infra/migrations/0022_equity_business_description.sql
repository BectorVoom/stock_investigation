-- Business descriptions from annual filings (ADR-0053), version 22.
--
-- What changes: one new owner-scoped table, `equity_business_description`.
-- No existing table, column, index or row is touched.
--
-- Why: the Stocks page's Company tab shows what the company does — the
-- "Item 1. Business" section of its newest 10-K (SEC) or the 事業の内容
-- section of its newest annual securities report (EDINET) — read by the
-- `financial-sync` runner job beside the annual facts.
--
-- Rows touched: none. The migration only creates an empty table; the first
-- rows arrive with the next `financial-synced` completion of each tracked
-- company (every claim asks for a description while none is stored).
--
-- Write path: a `financial-synced` runner completion, committed in the
-- job's guarded batch (`packages/adapters/src/sql/unitOfWork.ts`). Read
-- path: the Stocks page's profile read, `GET /api/v1/stocks/:stockId`
-- (`packages/adapters/src/sql/equitySync.ts`).
--
-- equity_business_description — one row per company: the newest annual
--   report's business section as paragraphs (`paragraphs_json`, validated
--   with zod on write and read), or `not-found` when that report has no
--   section the runner could read (so it is not read again). A completion
--   replaces the row only with a report at least as new (period end, then
--   filing date, then document id). Untracking keeps the row.
--
-- Rollback: `DROP TABLE equity_business_description;` loses only text the
-- next syncs read again (docs/database/operations.md).

CREATE TABLE equity_business_description (
    owner_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    source_document_id TEXT NOT NULL CHECK (length(source_document_id) BETWEEN 1 AND 40),
    form TEXT NOT NULL CHECK (form IN ('10-K', 'securities-report')),
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
