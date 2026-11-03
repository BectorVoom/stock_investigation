-- Every listed stock's upcoming earnings announcements (ADR-0068), version 32.
--
-- What changes: two new tables. `stock_earnings_calendar` holds one
-- market's earnings calendar — every announcement in the window of the
-- owner's stored stock-list stocks — and `stock_earnings_calendar_market`
-- when each market's calendar was last stored and for which window.
--
-- Why: the owner asked for the next earnings date of every stock, not only
-- Watchlist stocks. The Watchlist's dates (`earnings_events`) are fetched
-- one stock at a time and feed the Google Calendar and the `.ics` exports;
-- a market's whole calendar comes from a few requests (Finnhub without a
-- symbol, the JPX workbooks) and feeds no calendar, so it has its own rows.
--
-- Invariants: a market's rows are replaced all at once by an
-- `earnings-calendar-synced` completion, in the batch that upserts the
-- market's row; only symbols of the owner's `stock_directory` for that
-- market are stored. `announcement_date` is NULL for an undecided date.
--
-- Rows touched: none (new tables).
--
-- Read path: one stock's rows are a primary-key range
-- (`owner_id, market, symbol`) read by `GET /api/v1/stocks/:stockId`.
--
-- Rollback: `DROP TABLE stock_earnings_calendar_market`, then
-- `DROP TABLE stock_earnings_calendar`. The version-31 code never reads them.

CREATE TABLE stock_earnings_calendar (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL,
    period_key TEXT NOT NULL,
    announcement_date TEXT,
    fiscal_period_label TEXT NOT NULL,
    fiscal_period_end TEXT,
    timing TEXT NOT NULL
        CHECK (timing IN ('before-open', 'after-close', 'during-session', 'unknown')),
    PRIMARY KEY (owner_id, market, symbol, period_key)
) WITHOUT ROWID;

CREATE TABLE stock_earnings_calendar_market (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    synced_at TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL CHECK (from_date <= to_date),
    event_count INTEGER NOT NULL CHECK (event_count >= 0),
    truncated_dates TEXT NOT NULL CHECK (json_valid(truncated_dates) AND json_type(truncated_dates) = 'array'),
    PRIMARY KEY (owner_id, market)
) WITHOUT ROWID;
