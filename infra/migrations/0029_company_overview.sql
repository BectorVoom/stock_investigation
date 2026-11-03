-- Company overview with evidence and references (ADR-0064), version 29.
--
-- What changes: `stock_company_summary` gains six nullable columns holding
-- the company overview (事業概要): `overview_json` (the entry — 【特色】
-- 【事業内容】【連結事業】【海外】【テーマ】 and the stated 会社概要 facts, every
-- field with its evidence), `overview_facts_json` (the listing, sector,
-- fiscal year end and annual figures the server filled in, with the
-- sources they cite), `overview_references_json` (the numbered sources),
-- `overview_agent_id`, `overview_model` and `overview_generated_at`.
--
-- Why: the owner asked for a company description with evidence and
-- references, laid out like a 会社四季報 entry (ADR-0064). It sits beside the
-- ADR-0060 summary, which stays as the fallback while no overview is stored.
--
-- Invariants, enforced by column CHECK constraints (SQLite accepts a CHECK
-- in `ALTER TABLE ... ADD COLUMN` and tests it against the existing rows,
-- which all hold NULL, so no table rebuild is needed): each JSON column is
-- valid JSON within its size bound; the overview is stored whole or not at
-- all (on `overview_generated_at`, the last column, so the constraint can
-- name the others). The JSON's shape is checked by the contract on read
-- (`companyOverviewViewSchema`).
--
-- Rows touched: none (the new columns start NULL).
--
-- Write path: the overview writer (for now the PoC script
-- `scripts/poc/companyDescription/run.ts --store`), an upsert that leaves
-- the ADR-0060 columns as they are. Read path: `get` in
-- `packages/adapters/src/sql/companySummary.ts`, the same primary-key seek
-- as the summary (`GET /api/v1/stocks/:stockId`, `overview`).
--
-- Rollback: `ALTER TABLE stock_company_summary DROP COLUMN` overview_generated_at,
-- overview_model, overview_agent_id, overview_references_json,
-- overview_facts_json, overview_json in that order (a column named by
-- another column's CHECK cannot be dropped first), losing only the stored
-- overviews. The version-28 code names its columns and never reads these,
-- so it also runs against a version-29 database.

ALTER TABLE stock_company_summary ADD COLUMN overview_json TEXT CHECK (
    overview_json IS NULL OR (json_valid(overview_json) AND length(overview_json) <= 60000)
);
ALTER TABLE stock_company_summary ADD COLUMN overview_facts_json TEXT CHECK (
    overview_facts_json IS NULL OR (json_valid(overview_facts_json) AND length(overview_facts_json) <= 4000)
);
ALTER TABLE stock_company_summary ADD COLUMN overview_references_json TEXT CHECK (
    overview_references_json IS NULL
    OR (json_valid(overview_references_json) AND length(overview_references_json) <= 16000)
);
ALTER TABLE stock_company_summary ADD COLUMN overview_agent_id TEXT CHECK (
    overview_agent_id IS NULL OR length(overview_agent_id) BETWEEN 2 AND 32
);
ALTER TABLE stock_company_summary ADD COLUMN overview_model TEXT CHECK (
    overview_model IS NULL OR length(overview_model) BETWEEN 1 AND 100
);
ALTER TABLE stock_company_summary ADD COLUMN overview_generated_at TEXT CHECK (
    (overview_json IS NULL) = (overview_generated_at IS NULL)
    AND (overview_facts_json IS NULL) = (overview_generated_at IS NULL)
    AND (overview_references_json IS NULL) = (overview_generated_at IS NULL)
    AND (overview_agent_id IS NULL) = (overview_generated_at IS NULL)
    AND (overview_model IS NULL OR overview_generated_at IS NOT NULL)
);
