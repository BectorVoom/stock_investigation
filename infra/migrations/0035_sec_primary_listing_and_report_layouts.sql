-- Retry identity conflicts with the primary-listing-aware runners. No schema change.
-- Existing histories remain under their original listing. CIK handover is fenced
-- and atomic when the main listing's financial-sync completes.
UPDATE equity_sync_state
SET next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE failure_code = 'FINANCIAL_IDENTITY_CONFLICT'
    AND next_due_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND (owner_id, company_id) IN (
        SELECT eco.owner_id, eco.company_id
        FROM equity_company AS eco
        WHERE eco.provider = 'sec'
    );

-- Annual-report layouts have new section headings. Re-read only failed 10-Ks.
UPDATE equity_sync_state
SET next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (owner_id, company_id) IN (
        SELECT ebd.owner_id, ebd.company_id
        FROM equity_business_description AS ebd
        WHERE ebd.status = 'not-found' AND ebd.form = '10-K'
    )
    AND next_due_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

DELETE FROM equity_business_description
WHERE status = 'not-found' AND form = '10-K';
