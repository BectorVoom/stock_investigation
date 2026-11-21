-- Re-extract annual facts using the expanded EPS concept list. Keep the
-- existing facts and current values readable during the ordinary sync.
UPDATE equity_report_filing
SET facts_status = 'pending', primary_scope = NULL
WHERE facts_status = 'extracted';

UPDATE equity_sync_state
SET next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE next_due_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND EXISTS (
        SELECT 1
        FROM equity_report_filing AS erf
        WHERE erf.owner_id = equity_sync_state.owner_id
            AND erf.company_id = equity_sync_state.company_id
            AND erf.facts_status = 'pending'
    );
