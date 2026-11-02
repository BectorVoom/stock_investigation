-- AI-written company summaries (ADR-0060), version 28.
--
-- What changes:
--   `stock_company_summary` — new: the description and investment themes
--   the owner's AI agent wrote for a stock, in English and Japanese,
--   primary key (owner_id, market, symbol), with `queued_at` (when the
--   server last queued the stock's `company-summary` job).
--
-- Why: the Stocks page's Company tab had no description of a Japanese
-- company (J-Quants has no business text, ADR-0059) and no investment
-- themes for any company; the owner asked for both. The server queues one
-- `company-summary` job at a time for a Watchlist stock with no summary,
-- or one older than 90 days, when an AI agent is chosen in Settings.
--
-- Rows touched: none (a new, empty table). Jobs of the new kind are rows of
-- `research_jobs`, whose `kind` column has no CHECK.
--
-- Read path: `GET /api/v1/stocks/:stockId` (`summary`), one key seek; the
-- claim's schedule reads the owner's rows (one per Watchlist stock at most).
-- Write path: the scheduler sets `queued_at` when it queues a job; a
-- `company-summarized` completion writes the summary in the job's guarded
-- batch.
--
-- Indexes (docs/database/conventions.md §8): none besides the primary key.
--
-- Rollback (docs/database/operations.md): `DROP TABLE stock_company_summary;`
-- and delete the `company-summary` jobs (`DELETE FROM research_jobs WHERE
-- kind = 'company-summary';` with their transitions and events) before
-- running a build older than this migration.

-- An AI-written company summary (ADR-0060): the description and the
-- investment themes the owner's AI agent wrote for a Watchlist stock, in
-- English and Japanese, written by a `company-summarized` completion and
-- read by the Stocks page's Company tab with one key seek. `queued_at` is
-- set when the server queues the stock's summary job, so a stock whose job
-- fails is queued again a day later at the earliest. No foreign key: a
-- summary stays when its stock leaves the Watchlist or the directory.
CREATE TABLE stock_company_summary (
    owner_id TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('US', 'JP')),
    symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 16),
    -- When the server last queued a summary job for the stock.
    queued_at TEXT NOT NULL,
    description_en TEXT CHECK (description_en IS NULL OR length(description_en) BETWEEN 1 AND 1000),
    description_ja TEXT CHECK (description_ja IS NULL OR length(description_ja) BETWEEN 1 AND 1000),
    -- `[{"en": "...", "ja": "..."}, ...]`, 1 to 8 themes.
    themes_json TEXT CHECK (themes_json IS NULL OR json_valid(themes_json)),
    agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 2 AND 32),
    model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 100),
    -- When the completion that wrote the summary was stored; NULL before the first one.
    generated_at TEXT,
    CHECK (
        (description_en IS NULL) = (generated_at IS NULL)
        AND (description_ja IS NULL) = (generated_at IS NULL)
        AND (themes_json IS NULL) = (generated_at IS NULL)
        AND (agent_id IS NULL) = (generated_at IS NULL)
        AND (model IS NULL OR generated_at IS NOT NULL)
    ),
    PRIMARY KEY (owner_id, market, symbol)
) WITHOUT ROWID;
