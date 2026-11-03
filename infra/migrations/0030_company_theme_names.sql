-- Searchable theme names (ADR-0066), version 30.
--
-- What changes: `stock_company_summary` gains `theme_names`, the themes
-- the Company tab shows as a JSON array of `[en, ja]` pairs — the company
-- overview's 【テーマ】 (`overview_json` → `$.themes[*].label`) when an
-- overview is stored, else the AI-written summary's themes (`themes_json`)
-- — and two triggers that keep it in step whenever a row is inserted or
-- either source column changes, whoever writes it.
--
-- Why: the owner asked for a theme column that a theme search uses
-- (`GET /api/v1/stocks/theme-search?q=`). The themes lived only inside the
-- two JSON documents, where a search would match reasons and quotes too.
--
-- Invariants: `theme_names` is NULL exactly when neither source is stored,
-- else valid JSON (CHECK, within 4,000 characters: at most 8 themes of 40
-- characters per language). It is derived, never written by the app.
--
-- Rows touched: every row with a stored summary or overview, once, by the
-- backfill below (the same expression the triggers use).
--
-- Read path: `searchThemes` in `packages/adapters/src/sql/companySummary.ts`,
-- `instr(lower(theme_names), ?)` over the owner's rows (the primary key's
-- `owner_id` prefix; one row per stock ever queued for a summary).
--
-- Rollback: `DROP TRIGGER stock_company_summary_theme_names_update`,
-- `DROP TRIGGER stock_company_summary_theme_names_insert`, then
-- `ALTER TABLE stock_company_summary DROP COLUMN theme_names`. The
-- version-29 code names its columns and never reads this one.

ALTER TABLE stock_company_summary ADD COLUMN theme_names TEXT CHECK (
    theme_names IS NULL OR (json_valid(theme_names) AND length(theme_names) <= 4000)
);

UPDATE stock_company_summary
SET theme_names = CASE
    WHEN stock_company_summary.overview_json IS NOT NULL THEN (
        SELECT json_group_array(json_array(json_extract(t.value, '$.label.en'), json_extract(t.value, '$.label.ja')))
        FROM json_each(stock_company_summary.overview_json, '$.themes') AS t
    )
    WHEN stock_company_summary.themes_json IS NOT NULL THEN (
        SELECT json_group_array(json_array(json_extract(t.value, '$.en'), json_extract(t.value, '$.ja')))
        FROM json_each(stock_company_summary.themes_json) AS t
    )
END;

CREATE TRIGGER stock_company_summary_theme_names_insert AFTER INSERT ON stock_company_summary
BEGIN
    UPDATE stock_company_summary
    SET theme_names = CASE
        WHEN stock_company_summary.overview_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.label.en'), json_extract(t.value, '$.label.ja')))
            FROM json_each(stock_company_summary.overview_json, '$.themes') AS t
        )
        WHEN stock_company_summary.themes_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.en'), json_extract(t.value, '$.ja')))
            FROM json_each(stock_company_summary.themes_json) AS t
        )
    END
    WHERE owner_id = NEW.owner_id AND market = NEW.market AND symbol = NEW.symbol;
END;

CREATE TRIGGER stock_company_summary_theme_names_update AFTER UPDATE OF themes_json, overview_json ON stock_company_summary
BEGIN
    UPDATE stock_company_summary
    SET theme_names = CASE
        WHEN stock_company_summary.overview_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.label.en'), json_extract(t.value, '$.label.ja')))
            FROM json_each(stock_company_summary.overview_json, '$.themes') AS t
        )
        WHEN stock_company_summary.themes_json IS NOT NULL THEN (
            SELECT json_group_array(json_array(json_extract(t.value, '$.en'), json_extract(t.value, '$.ja')))
            FROM json_each(stock_company_summary.themes_json) AS t
        )
    END
    WHERE owner_id = NEW.owner_id AND market = NEW.market AND symbol = NEW.symbol;
END;
