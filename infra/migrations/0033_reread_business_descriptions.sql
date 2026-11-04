-- Business descriptions read again, version 33.
--
-- What changes: no table or column. Every stored `not-found` business
-- description of a 10-K or 20-F in `equity_business_description` is
-- deleted, and its company's equity sync is due now
-- (`equity_sync_state.next_due_at`), so the next `financial-sync` job of
-- that company reads its newest annual report again (ADR-0053 §3a).
--
-- Why: until 2026-11-04 the reader lost Item 1 of most such reports. The
-- HTML converter started a page without a main element at its only `<h1>`,
-- which in a 10-K often heads the exhibit index at the end (EOG Resources:
-- 1,294 blocks dropped), and headings such as "Items 1. and 2. Business and
-- Properties." (Freeport-McMoRan), "Item 1. *Business*", "Item 1." split
-- from "Business", "Item 4. Information On Our Company" and documents over
-- 16 MB were not read. 913 reports were stored as `not-found`; on a sample
-- of 40 of them the fixed reader finds the section in 36. `not-found` is
-- stored like a success and a report is not downloaded again until a newer
-- one is filed, so without this migration they would stay `not-found`
-- until next year's report.
--
-- Rows touched: `not-found` rows of form 10-K or 20-F (a 40-F is never
-- downloaded, so its rows stay), and the sync state of their companies
-- (a scheduled sync only made earlier, never later; an unscheduled one is
-- left alone). One SEC request per company follows.
--
-- Rollback: none needed for an older release (it reads the same tables). A
-- re-read that still finds nothing is stored as `not-found` again.
UPDATE equity_sync_state
SET next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (owner_id, company_id) IN (
        SELECT ebd.owner_id, ebd.company_id
        FROM equity_business_description AS ebd
        WHERE ebd.status = 'not-found'
            AND ebd.form IN ('10-K', '20-F')
    )
    AND next_due_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

DELETE FROM equity_business_description
WHERE status = 'not-found'
    AND form IN ('10-K', '20-F');
