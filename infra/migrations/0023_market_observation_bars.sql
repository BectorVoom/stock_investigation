-- Daily bars beside market observations (ADR-0056), version 23.
--
-- What changes: `market_observations` gains four nullable REAL columns,
-- `open_value`, `high_value`, `low_value` and `volume` — the day's open,
-- high, low and traded volume beside `value`, which stays the close. Every
-- Twelve Data series' `market_series.history_checked_at` is cleared.
--
-- Why: the chart viewer draws candlesticks and a volume panel (ADR-0056).
-- Twelve Data's `time_series` answer the runners already request carries
-- open, high, low and volume on every row; the runners now keep them and
-- the API stores them. FRED and materials series have no bar.
--
-- Invariants, enforced by column CHECK constraints (SQLite accepts a CHECK
-- in `ALTER TABLE ... ADD COLUMN` and tests it against the existing rows,
-- which all hold NULL, so no table rebuild is needed):
--   the three prices are NULL together or set together (on `low_value`, the
--   last price column, so the constraint can name all three);
--   `volume` is NULL or ≥ 0, and NULL when there are no prices.
-- Not enforced here: `low ≤ open, close ≤ high`. The contract refuses an
-- inconsistent bar at the API boundary (`isConsistentBar`), and a CHECK
-- failure would roll back the whole completion batch over a comparison of
-- re-parsed floating-point text.
--
-- Rows touched: no observation row (the new columns start NULL). Every
-- `market_series` row of provider `twelve-data` gets
-- `history_checked_at = NULL`, so its next market sync is a full fetch (one
-- request a series, as every sync already makes — no extra credits) and the
-- stored history gains its bars within one sync. Observations older than
-- the provider's newest 800 stay close-only.
--
-- Write path: a `market-refresh` completion (`marketStatements` in
-- `packages/adapters/src/sql/unitOfWork.ts`). Read path: `getObservations`
-- in `packages/adapters/src/sql/repositories.ts` (Home, the notebooks and
-- `GET /api/v1/stocks/:stockId/prices`).
--
-- Rollback: restore the pre-migration backup (`wrangler d1 export`, see
-- docs/database/operations.md), or `ALTER TABLE market_observations DROP
-- COLUMN` volume, low_value, high_value, open_value in that order (a column
-- named by another column's CHECK cannot be dropped first), losing only
-- bars the next full syncs store again. The version-22 code names its
-- columns and never reads these, so it also runs against a version-23
-- database, but its upsert would leave a stored bar beside a revised close:
-- drop the columns when a rollback is meant to last.

ALTER TABLE market_observations ADD COLUMN open_value REAL;
ALTER TABLE market_observations ADD COLUMN high_value REAL;
ALTER TABLE market_observations ADD COLUMN low_value REAL CHECK (
    (open_value IS NULL AND high_value IS NULL AND low_value IS NULL)
    OR (open_value IS NOT NULL AND high_value IS NOT NULL AND low_value IS NOT NULL)
);
ALTER TABLE market_observations ADD COLUMN volume REAL CHECK (
    volume IS NULL OR (volume >= 0 AND low_value IS NOT NULL)
);

UPDATE market_series SET history_checked_at = NULL WHERE provider = 'twelve-data';
