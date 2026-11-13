-- Screening on the synced annual metrics, version 36.
--
-- What changes: `equity_metric_value` gains `value_real`, the `value_decimal`
-- of a value row as an IEEE-754 double (NULL when there is no value, or the
-- decimal is not finite), and
-- `idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real`,
-- a partial covering index on (owner_id, metric_code, fiscal_year, value_real).
--
-- Why: stock screening — filter and sort every listed company on one metric
-- of one fiscal year. `value_decimal` is exact decimal text, so a range or
-- sort on it scans every row of the owner and sorts in a temporary B-tree
-- (40.31 ms at 11,400 companies x 6 fiscal years x 14 metrics, 750,400
-- rows, node:sqlite, plan:
-- `SEARCH emv USING PRIMARY KEY (owner_id=?) | USE TEMP B-TREE FOR ORDER BY`).
-- With `value_real` and the index the same read is a covering range scan,
-- ordered by value_real then company_id (a backwards index scan, no temporary
-- sort): 0.05 ms
-- (`SEARCH emv USING COVERING INDEX idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real (... value_real>? AND value_real<?)`).
-- The exact decimal text stays the stored value for display and audit;
-- `value_real` is never shown.
--
-- Invariants: `value_real` is derived from `value_decimal` by the one writer
-- of the table (the `financial-synced` completion writes both from the same
-- selection, and this migration backfills the rows already stored). Values
-- beyond double range store NULL and are skipped by the index and by
-- screening; every stored value is far below that. Magnitudes above 2^53
-- round to the nearest double, which is fine for filtering and sorting;
-- equality and ordering among distinct finite doubles are exact. Rows
-- without a value (`value_decimal IS NULL`) have `value_real` NULL, and so
-- does a stored value that is not finite.
--
-- Absolute metrics are in the filing's reporting currency: a screening on
-- them compares amounts within one currency (filter or group by `currency`,
-- or screen one market at a time). Ratios (ROE, margins, growth) are
-- quotients of two same-currency values and cancel the currency; they are
-- computed from the stored values, never stored.
--
-- Read path: none yet — the Stocks pages and the financial widgets read the
-- primary key unchanged. The screening read (one metric, one fiscal year,
-- range on `value_real`, `ORDER BY value_real DESC, company_id DESC`) is
-- what the index serves; `company_id DESC` is the backwards index scan's
-- order, so no temporary sort.
--
-- Rows touched: the backfill below rewrites every row with a value (505 ms
-- at 750,400 rows, node:sqlite), then nothing until the next completion.
--
-- Rollback: `DROP INDEX
-- idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real`;
-- then `ALTER TABLE equity_metric_value DROP COLUMN value_real` (SQLite
-- 3.35+; the version-36 code never names the column when writing, so an
-- older release reads the rest unchanged).
ALTER TABLE equity_metric_value ADD COLUMN value_real REAL;

UPDATE equity_metric_value
SET value_real = CAST(value_decimal AS REAL)
WHERE value_decimal IS NOT NULL
	AND abs(CAST(value_decimal AS REAL)) <= 1.7976931348623157e308;

CREATE INDEX idx_equity_metric_value__owner_id_metric_code_fiscal_year_value_real
	ON equity_metric_value (owner_id, metric_code, fiscal_year, value_real)
	WHERE value_real IS NOT NULL;
