-- External-service answer status (docs/rule/error_handling.md §4a,
-- ADR-0037), version 11.
--
-- When an external service (a feed host, a data provider, Google, a model
-- provider's API, a tool's site) causes a failure, the status it answered
-- with is stored beside our own failure code, exactly as received: a
-- provider's 404 stays 404 and Anthropic's 529 stays 529. NULL when no
-- external answer caused the failure (a timeout, a refused connection, our
-- own validation) and on every row written before this version. A number
-- only: provider text is never stored (SEC-010).
--
-- research_jobs.failure_upstream_status       beside failure_code
-- news_sources.last_error_upstream_status     beside last_error_code
-- market_series.unavailable_upstream_status   beside unavailable_code
-- watchlist_stocks.unavailable_upstream_status beside unavailable_code
-- google_calendar_links.last_failure_upstream_status beside last_failure_code
--
-- Rollback: `ALTER TABLE <table> DROP COLUMN <column>` for each of the five
-- restores the version-10 schema (SQLite >= 3.35); the version-10 code never
-- reads these columns. Preceded by `wrangler d1 export` (see
-- docs/OPERATIONS.md).

ALTER TABLE research_jobs ADD COLUMN failure_upstream_status INTEGER;
ALTER TABLE news_sources ADD COLUMN last_error_upstream_status INTEGER;
ALTER TABLE market_series ADD COLUMN unavailable_upstream_status INTEGER;
ALTER TABLE watchlist_stocks ADD COLUMN unavailable_upstream_status INTEGER;
ALTER TABLE google_calendar_links ADD COLUMN last_failure_upstream_status INTEGER;
