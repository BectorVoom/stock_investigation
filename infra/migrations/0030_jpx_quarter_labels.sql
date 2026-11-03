-- Japanese earnings periods labelled like US ones, version 30.
--
-- What changes: no table or column. The stored display labels of Japanese
-- (JPX) earnings events in `earnings_events.fiscal_period_label` are
-- rewritten from JPX's English words to Finnhub's form: `First quarter`,
-- `Second quarter`, `Third quarter` and `Full year` (compared trimmed and
-- case-insensitively) become `Q1`-`Q4` followed by the year of
-- `fiscal_period_end` (`Second quarter` with 2027-03-31 -> `Q2 2027`).
--
-- Why: the owner asked for one label style ("Please use like Q1 2027").
-- Since 2026-11-03 both parsers write the new labels
-- (`jpxFiscalPeriodLabel` / `jpx_fiscal_period_label`); this migration
-- converts the rows stored before that, so they read alike at once instead
-- of after the next earnings sync.
--
-- Rows touched: only `jp:` stocks' rows with a fiscal period end and one of
-- the four labels. `period_key` (the event's identity and its calendar UID)
-- is untouched, so Google Calendar updates its events in place.
--
-- Rollback: none needed for an older release (the label is free text). To
-- restore JPX's words: UPDATE earnings_events SET fiscal_period_label =
-- CASE substr(fiscal_period_label, 1, 2) WHEN 'Q1' THEN 'First quarter'
-- WHEN 'Q2' THEN 'Second quarter' WHEN 'Q3' THEN 'Third quarter'
-- ELSE 'Full year' END WHERE stock_id LIKE 'jp:%' AND fiscal_period_label
-- GLOB 'Q[1-4] [0-9][0-9][0-9][0-9]';
UPDATE earnings_events
SET fiscal_period_label = 'Q' || CASE lower(trim(fiscal_period_label))
        WHEN 'first quarter' THEN '1'
        WHEN 'second quarter' THEN '2'
        WHEN 'third quarter' THEN '3'
        ELSE '4'
    END || ' ' || substr(fiscal_period_end, 1, 4)
WHERE stock_id LIKE 'jp:%'
    AND fiscal_period_end IS NOT NULL
    AND lower(trim(fiscal_period_label)) IN ('first quarter', 'second quarter', 'third quarter', 'full year');
