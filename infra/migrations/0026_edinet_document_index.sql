-- One shared index of EDINET annual securities reports; every directory
-- stock tracked (ADR-0058 §3, §4), version 26.
--
-- What changes: two new owner-scoped tables, `edinet_index_day` and
-- `edinet_document_index`, with one secondary index; one new partial index
-- on `equity_sync_state`; the table `equity_edinet_scanned_day` is dropped.
-- No other table, column or row is touched.
--
-- Why: EDINET has no per-company search, so until now every Japanese
-- company's `financial-sync` job listed EDINET's day lists itself (the
-- per-company scan, `equity_edinet_scanned_day`): with every directory
-- stock tracked that is about 3,700 jobs a day and 1–2 million scanned-day
-- rows. A new `edinet-index` job lists each day once for every company and
-- stores its annual reports (docTypeCode 120 and 130 with a securities
-- code); a Japanese company's sync downloads only the reports the index
-- names for its code. The due-company probe now serves never-checked
-- companies before every company being refreshed.
--
-- edinet_index_day — one row per EDINET day listed in full: the plan
--   (`planSyncDays`) never asks for it again. Only days before today in
--   Japan are stored (a day's list is final once it is over there).
--
-- edinet_document_index — one row per annual report a listed day holds
--   (insert-only). `period_start` / `period_end` are null on an amendment
--   (130): EDINET states no period on its row (API spec §3-1-2-2 *3).
--
-- Indexes (docs/database/conventions.md §8), measured with EXPLAIN QUERY
-- PLAN on node:sqlite at 11,400 companies (7,700 US, 3,700 JP) and 30,000
-- indexed reports; the plans are pinned in
-- packages/adapters/test/sqlite/canonicalSchema.test.ts:
--   idx_edinet_document_index__owner_id_sec_code_submitted_at
--       a Japanese company's indexed reports in submission order (the
--       claim context; the tracking batch's "has an indexed report" test):
--       one range seek instead of every report of the owner. Immutable
--       columns: one index write per report.
--   idx_equity_sync_state__owner_id_last_checked_at_next_due_at
--       partial (last_checked_at IS NULL AND next_due_at IS NOT NULL): the
--       never-checked due company of every runner claim, in (next_due_at,
--       company_id) order, before the refresh range of
--       idx_equity_sync_state__owner_id_next_due_at. Only never-checked
--       rows are entries: a company leaves it with its first check.
--   edinet_index_day: no secondary index; the plan reads the owner's days
--       as one primary-key range.
--
-- Rows touched: every `equity_edinet_scanned_day` row is deleted with its
-- table (the per-company scan's checkpoints; the shared index replaces
-- them). Stored filings, facts and values are untouched: a report already
-- stored is not downloaded again (the claim names only unstored reports).
-- `equity_sync_state.edinet_phase` stays: it now says `not-found` (the
-- index holds no report of the company) or `idle`; rows written before
-- keep their scan phase until the company's next check.
--
-- Write path: an `edinet-indexed` runner completion, committed in the
-- job's guarded batch (`packages/adapters/src/sql/edinetIndex.ts`). Read
-- path: the `edinet-index` plan and the `financial-sync` claim context
-- (`packages/adapters/src/sql/edinetIndex.ts`, `equitySync.ts`).
--
-- Rollback: `wrangler d1 export` first (docs/database/operations.md), then
-- DELETE FROM job_events / job_transitions / research_jobs of kind
-- 'edinet-index'; DROP the two new tables and the new index; recreate
-- `equity_edinet_scanned_day` as migration 0021 defines it (empty: the
-- version-25 code scans again from discovery, re-listing days it had
-- listed). The version-25 code cannot read the `edinet-index` job kind.

CREATE TABLE edinet_index_day (
    owner_id TEXT NOT NULL,
    listed_on TEXT NOT NULL CHECK (length(listed_on) = 10),
    checked_at TEXT NOT NULL,
    document_count INTEGER NOT NULL CHECK (document_count >= 0),
    PRIMARY KEY (owner_id, listed_on)
) WITHOUT ROWID;

CREATE TABLE edinet_document_index (
    owner_id TEXT NOT NULL,
    doc_id TEXT NOT NULL CHECK (length(doc_id) = 8),
    sec_code TEXT NOT NULL CHECK (length(sec_code) = 5),
    edinet_code TEXT NOT NULL CHECK (length(edinet_code) = 6),
    filer_name TEXT NOT NULL CHECK (length(filer_name) BETWEEN 1 AND 200),
    doc_type_code TEXT NOT NULL CHECK (doc_type_code IN ('120', '130')),
    period_start TEXT,
    period_end TEXT,
    submitted_at TEXT NOT NULL,
    parent_doc_id TEXT,
    listed_on TEXT NOT NULL,
    PRIMARY KEY (owner_id, doc_id),
    CHECK (doc_type_code = '130' OR period_end IS NOT NULL),
    FOREIGN KEY (owner_id, listed_on) REFERENCES edinet_index_day (owner_id, listed_on)
        ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_edinet_document_index__owner_id_sec_code_submitted_at
    ON edinet_document_index (owner_id, sec_code, submitted_at);

CREATE INDEX idx_equity_sync_state__owner_id_last_checked_at_next_due_at
    ON equity_sync_state (owner_id, last_checked_at, next_due_at)
    WHERE last_checked_at IS NULL AND next_due_at IS NOT NULL;

DROP TABLE equity_edinet_scanned_day;
