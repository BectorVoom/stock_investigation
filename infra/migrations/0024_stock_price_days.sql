-- Every directory stock's daily prices, one request per market and date
-- (ADR-0058 §2), version 24.
--
-- What changes: three new tables. No existing table changes.
--   `stock_price_day` — one row per owner, market and trading date the
--   `stock-prices-sync` job asked a provider for (Massive for US, J-Quants
--   for JP), holding the answer's outcome and, while the day is not final,
--   when it is asked again.
--   `stock_price_history` — one row per directory stock whose whole-window
--   history is pending: it owes a refetch after a split the job could not
--   refetch within its `maxHistoriesPerJob` cap, and/or its last history
--   answer was `unavailable` and it is backed off.
--   `stock_price_market` — one row per market: the newest day the runner's
--   split check covered completely.
--
-- Why: the API plans each job's dates with `planSyncDays` (newest first,
-- packages/domain/src/sync/syncDays.ts). A day row without `retry_at` is
-- final and never asked again; one with `retry_at` is asked again from it:
--   `not-yet-available` always;
--   `no-trading` until the market has a stored day newer than it (proof
--   the provider has data past that date — else a provider outage would
--   lose the day for good);
--   `stored` while the day was at most `STOCK_PRICE_LIMITS.settleDays` old
--   when fetched (late corrections), once more after it settles.
-- The bars themselves go to `market_observations` under each stock's
-- existing price series id.
--
-- Splits make the older stored bars inconsistent (both providers adjust as
-- of the request). The claim's `adjustmentsSince` is the market's
-- `split_checked_on`, so days stored by a job whose split check did not
-- cover them are checked again by the next job. A split stock the job did
-- not refetch owes a refetch, planned before every stock that has no
-- series yet (oldest request first); any stored history clears it. A stock
-- answered `unavailable` is skipped by both history rules until its
-- `retry_at`, so one stuck stock cannot starve the stocks behind it.
--
-- Invariants, enforced by CHECK constraints:
--   `market` is 'US' or 'JP'; `outcome_code` is one of the four outcomes;
--   `bar_count` is ≥ 0 and positive exactly for a `stored` day;
--   a `not-yet-available` day has a `retry_at`, a `too-old` day none;
--   a `stock_price_history` row has a reason (a refetch request or a
--   back-off).
--
-- Read path (packages/adapters/src/sql/stockPrices.ts): `listDays` — one
-- market's window (at most ~520 weekdays), a primary-key range seek;
-- `listRefetchSymbols` / `listUnfilledSymbols` — one market's history rows
-- (a key range, at most a few hundred rows, no index) and per directory row
-- one key seek; `getSplitCheckedOn` — one key.
-- Write path: a `stock-prices-synced` completion (`stockPriceStatements`,
-- same guarded batch as the job write); a final day row is never
-- overwritten, a refetch keeps its first request time, the split watermark
-- only moves forward.
--
-- Rows touched: none (new, empty tables). The first `stock-prices-sync`
-- of each market fills them.
--
-- Rollback: `DROP TABLE stock_price_market; DROP TABLE stock_price_history;
-- DROP TABLE stock_price_day;` loses only the sync bookkeeping (which dates
-- were asked, which stocks owe a refetch or are backed off, how far splits
-- were checked); the version-23 code reads none of it. The bars the jobs
-- stored stay in `market_observations` under the stocks' series ids.

CREATE TABLE stock_price_day (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    trading_on TEXT NOT NULL,
    outcome_code TEXT NOT NULL
        CHECK (outcome_code IN ('stored', 'no-trading', 'not-yet-available', 'too-old')),
    bar_count INTEGER NOT NULL CHECK (bar_count >= 0 AND ((outcome_code = 'stored') = (bar_count > 0))),
    checked_at TEXT NOT NULL,
    retry_at TEXT CHECK (
        (outcome_code <> 'not-yet-available' OR retry_at IS NOT NULL)
        AND (outcome_code <> 'too-old' OR retry_at IS NULL)
    ),
    PRIMARY KEY (owner_id, market, trading_on)
) WITHOUT ROWID;

CREATE TABLE stock_price_history (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL,
    refetch_requested_at TEXT,
    retry_at TEXT CHECK (refetch_requested_at IS NOT NULL OR retry_at IS NOT NULL),
    PRIMARY KEY (owner_id, market, symbol)
) WITHOUT ROWID;

CREATE TABLE stock_price_market (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    split_checked_on TEXT NOT NULL,
    PRIMARY KEY (owner_id, market)
) WITHOUT ROWID;
