-- 10-K business descriptions read again, version 34.
--
-- What changes: no table or column. Every stored `not-found` business
-- description of a 10-K in `equity_business_description` is deleted, and
-- its company's equity sync is due now (`equity_sync_state.next_due_at`),
-- so the next `financial-sync` job of that company reads its newest 10-K
-- again (ADR-0053 §3b).
--
-- Why: after migration 0033, 80 10-Ks were still stored as `not-found`.
-- The reader did not know "Part I. Item 1. Business" (Expedia), "ITEM 1 |
-- Business" (AIG), "Item 1. Description of Business" (World Acceptance)
-- or a 10-K that writes its item numbers only in its table of contents
-- (Morgan Stanley, Cardinal Health). `not-found` is stored like a success
-- and a report is not downloaded again until a newer one is filed.
--
-- Rows touched: `not-found` rows of form 10-K (a 20-F's and a 40-F's stay:
-- nothing changed for them), and the sync state of their companies (a
-- scheduled sync only made earlier, never later; an unscheduled one is
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
            AND ebd.form = '10-K'
    )
    AND next_due_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

DELETE FROM equity_business_description
WHERE status = 'not-found'
    AND form = '10-K';
