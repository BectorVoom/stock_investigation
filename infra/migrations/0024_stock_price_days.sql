-- Every directory stock's daily prices, one request per market and date
-- (ADR-0058 §2), version 24.
--
-- What changes: a new table `stock_price_day` — one row per owner, market
-- and trading date the `stock-prices-sync` job asked a provider for
-- (Massive for US, J-Quants for JP), holding the answer's outcome. No
-- existing table changes.
--
-- Why: the API plans each job's dates with `planSyncDays` (newest first,
-- packages/domain/src/sync/syncDays.ts). A date answered `stored`,
-- `no-trading` or `too-old` is never asked again; one answered
-- `not-yet-available` is asked again from `retry_at`. The bars themselves
-- go to `market_observations` under each stock's existing price series id.
--
-- Invariants, enforced by CHECK constraints:
--   `market` is 'US' or 'JP'; `outcome_code` is one of the four outcomes;
--   `bar_count` is ≥ 0 and positive exactly for a `stored` day;
--   `retry_at` is set exactly for a `not-yet-available` day.
--
-- Read path: `listDays` in packages/adapters/src/sql/stockPrices.ts — the
-- window of one market (at most ~520 weekdays), a primary-key range seek.
-- Write path: a `stock-prices-synced` completion (`stockPriceStatements`,
-- same guarded batch as the job write); a final row is never overwritten.
--
-- Rows touched: none (a new, empty table). The first `stock-prices-sync`
-- of each market fills it.
--
-- Rollback: `DROP TABLE stock_price_day;` loses only the record of which
-- dates were asked; the version-23 code never reads it. The bars the jobs
-- stored stay in `market_observations` under the stocks' series ids.

CREATE TABLE stock_price_day (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    trading_on TEXT NOT NULL,
    outcome_code TEXT NOT NULL
        CHECK (outcome_code IN ('stored', 'no-trading', 'not-yet-available', 'too-old')),
    bar_count INTEGER NOT NULL CHECK (bar_count >= 0 AND ((outcome_code = 'stored') = (bar_count > 0))),
    checked_at TEXT NOT NULL,
    retry_at TEXT CHECK ((outcome_code = 'not-yet-available') = (retry_at IS NOT NULL)),
    PRIMARY KEY (owner_id, market, trading_on)
) WITHOUT ROWID;
