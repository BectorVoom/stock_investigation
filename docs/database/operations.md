# Database operations

How the database is created, upgraded, rolled back and switched to another engine. Where the database files live and how to back them up: [OPERATIONS.md — What is stored where](../OPERATIONS.md#what-is-stored-where) and [Backup and restore](../OPERATIONS.md#backup-and-restore). How to write a migration: [database conventions §3](conventions.md#3-migrations).

## Migrations and rollback

Schema changes are forward-only SQL files in `infra/migrations`; each
production generation carries the copy it was built with and applies exactly
those at start — never the working tree's. The initial migration has no
down-migration: rollback of data is restoring a backup of `data/`, and
rollback of a release is `bun run prod:rollback` (which moves only the
pointer). Starting a generation older than the database refuses with "the
database is newer than this release" naming the unknown applied migrations;
override with `RESEARCH_ALLOW_NEWER_DB=1` only after checking. For later
migrations, write the inverse statements in the migration's header comment
and rehearse them on a copy of `data/` first (API-009).

The complete current schema is also kept in one file, `db/schema.sql`, for
initializing a fresh database; it is never run against an existing one.
Every schema change is a new migration plus the matching edit to
`db/schema.sql`, and a test fails when the two differ
([database conventions](conventions.md)).

Development (`bun run dev`) applies the working tree's migrations at start
and keeps watching `infra/migrations` while it runs: a migration that arrives
with a merge or pull is applied to `data-dev/` within a few seconds, and the
launcher prints `launch: applied new migrations to the running database: …`.
Before this, the API reloaded the new code but not the schema, so new routes
answered 500 (`INTERNAL`) until a restart. If the apply fails, the launcher
prints the failure with the build log path; fix it and restart. Production
never applies a migration late: it serves a pinned generation.

## Migration notes

Operational notes per migration: rollback steps, destructive effects, restarts, what a backup must include. Each migration's header comment remains the authoritative rollback, and the tables are described in [tables/](README.md#tables). Migrations without a note here need nothing beyond the launcher's automatic apply; what they changed is in their header comments and the table documents.

### 0005 — remove approved images (destructive)

Migration `0005_remove_approved_images.sql` (owner's decision of 2026-10-13)
is destructive and one-way: it drops the `approved_assets` table, deleting the
owner's stored image approvals for good — back up `data/` first. Rolling back
to a previous release after this migration has run means running old code
against a newer database: the launcher refuses with "the database is newer
than this release" (override only with `RESEARCH_ALLOW_NEWER_DB=1` after
checking), and even then the old approval endpoints find no table and no rows —
the approvals are gone unless a pre-migration backup is restored. Stored
`image-gallery` components in old workspaces need no restore: the new code
strips them on read (see the migration's header comment).

### 0006 — Home and market data

Migration `0006_market_data.sql` (FR-017) adds [`home_dashboards`](tables/home_dashboards.md), [`market_series`](tables/market_series.md) and [`market_observations`](tables/market_observations.md). Its header comment is the
rollback: after a `wrangler d1 export`, `DELETE` all three tables' rows and
`DROP TABLE` them, restoring the version-5 schema. Migrations apply by name
on every start, so a database from before it gains the Home tables on the next
start with its data intact (`tests/real/homeUpgrade.spec.ts`). Market observations are
personal-use vendor data (ADR-0014): they are not part of workspace
export/import, but a directory copy of `data/` carries them — include that
in what "back up by copying that directory" means.

### 0007 — watchlist and earnings

Migration `0007_watchlist_earnings.sql` (FR-018) adds [`watchlist_stocks`](tables/watchlist_stocks.md), [`earnings_events`](tables/earnings_events.md) and [`calendar_feeds`](tables/calendar_feeds.md) (only the SHA-256 of the subscription token is stored). Its header comment
is the rollback: after a `wrangler d1 export`, `DELETE` the three tables'
rows and `DROP TABLE` them. Earnings dates are personal-use vendor data
(ADR-0016): they are not part of workspace export/import, but a directory
copy of `data/` carries them — include that in what "back up by copying
that directory" means. To revoke a leaked subscription link without the UI:
delete the owner's `calendar_feeds` row (the link answers 404 at once); from
the UI, Settings → calendar → "Replace link" (the old link stops working
immediately) or "Revoke link" (these controls moved from the Watchlist page to
Settings with ADR-0022).

Its tables are created with `IF NOT EXISTS`: before the merge of 2026-10-13
this migration was named `0006_market_data.sql`, and a development database
that applied it under that name must pass it again under the new one without
an error. Such a database keeps the old name in `d1_migrations`; development
starts do not check for unknown names, production starts do (see above).

### 0008 — Google Calendar

Migration `0008_google_calendar.sql` (FR-019) adds [`google_calendar_links`](tables/google_calendar_links.md) (never a token column). Its header comment is the rollback: after a `wrangler
d1 export`, `DELETE` the owner's link row and `DROP TABLE` the table. To
forget the grant without the UI: disconnect in Settings (calendar; on the
Watchlist page before ADR-0022), or delete
the runner-side token file (`<dataDir>/google-token.json`); deleting the
owner's link row alone answers "disconnected" at once but leaves the local
grant file behind, so prefer the page or the file.

### 0009 — notebooks

Migration `0009_notebooks.sql` (ADR-0020) adds [`workspace_notebooks`](tables/workspace_notebooks.md), [`workspace_notebook_revisions`](tables/workspace_notebook_revisions.md) and [`notebook_turns`](tables/notebook_turns.md), plus an index on [`chat_messages`](tables/chat_messages.md) for looking up one run's message (idempotent assist replays). Its header comment is the rollback: after a
`wrangler d1 export`, `DELETE` all three tables' rows and `DROP TABLE` them
(and the index), restoring the version-8 schema. Unlike the canvas, notebooks
are not part of workspace export/import yet (ADR-0020); a directory copy of
`data/` carries them. Sizing: a notebook holds at most 200 widgets and 850 KB
of widget content (under 1 MB with metadata, within D1's 2 MB row limit), so
one conversation's notebook rows stay under about 21 MB (the body plus 20
revisions); ordinary notebooks are a few KB per version.

### 0010 — scheduled tasks

Migration `0010_scheduled_tasks.sql` (ADR-0033) adds [`scheduled_tasks`](tables/scheduled_tasks.md) and the index
`scheduled_tasks_due` (renamed `idx_scheduled_tasks__owner_id_next_run_at_task_id`
by 0020) for the due scan every runner claim runs. Its header
comment is the rollback: remove any `scheduled-tasks` and `task-result`
(ADR-0038) widgets from Home and the notebooks first, then after a `wrangler d1 export`, `DELETE` the rows,
`DROP INDEX` and `DROP TABLE`. The conversations the tasks created stay.
Historical: a `bun run dev` started before the launcher's migration watcher
(2026-10-24) answered 500 on the task routes until it was restarted (or the
migration was applied to `data-dev/d1`); a current launcher applies the
migration within seconds (see "Migrations and rollback" above).

### 0012 — upstream status columns

Migration `0012_upstream_status.sql` (ADR-0037, error-handling rule §4a)
adds one nullable `INTEGER` column beside each stored failure code: the
status the external service that caused the failure answered with, exactly
as received (`research_jobs.failure_upstream_status`,
`news_sources.last_error_upstream_status`,
`market_series.unavailable_upstream_status`,
`watchlist_stocks.unavailable_upstream_status`,
`google_calendar_links.last_failure_upstream_status`). NULL on every row
written before it and whenever no external answer caused the failure (a
timeout, our own refusal); the API returns it as `failureUpstreamStatus`,
`lastErrorUpstreamStatus`, `unavailable.upstreamStatus` and the calendar's
`lastFailure.upstreamStatus`, and a value that is not a 100–599 integer reads
as null rather than failing the list. It is set and cleared together with
the code beside it. Its header comment is the rollback: after a `wrangler d1
export`, `ALTER TABLE … DROP COLUMN` the five columns; the version-10 code
never reads them.

### 0013 — watchlist lists

Migration `0013_watchlist_lists.sql` (ADR-0040) adds [`watchlist_lists`](tables/watchlist_lists.md) and [`watchlist_list_stocks`](tables/watchlist_list_stocks.md). Removing a stock from the watchlist deletes its list memberships in the same batch. Its header comment is the rollback: remove any
`watchlist-prices` widgets from Home and the notebooks first (the version-12
code cannot read that type), then after a `wrangler d1 export`, `DELETE` both
tables' rows and `DROP TABLE` them; the watchlist stocks themselves are
untouched. A `bun run dev` started before the launcher's migration watcher
(2026-10-24) answers 500 on `/watchlist` until it is restarted (or the
migration is applied to `data-dev/d1`); a current launcher applies it within
seconds (see "Migrations and rollback" above).

### 0018 — widget database readback

A running `bun run dev` applies `0018_widget_earnings_sources.sql` within seconds of the update (the launcher's migration watcher); if the apply fails, or the instance predates the watcher (2026-10-24), restart it. Production applies it when the new release generation starts through its supported launcher. The API's own hot reload never applies migrations. The migration adds the provider attribution reference table [`earnings_sources`](tables/earnings_sources.md) and preserves existing watchlist stocks and earnings events. Home's initial arrangement is stored lazily at version zero; saved arrangements are preserved. No manual seeding is required. Restore the pre-upgrade backup for rollback; an older release ignores the additive reference table.

The isolated regression is `bun run test:real widgetDatabaseReal.spec.ts`; it covers fresh and populated schema-17 upgrades and restart persistence. See [the review record](reviews/widget-database-review.md).

### 0020 — index conventions

Migration `0020_index_conventions.sql` changes indexes only (renames to
`idx_<table>__<columns>`, drops four unused or duplicate indexes, adds
`idx_research_jobs__owner_id_kind_created_at_run_id`); no table or row is
touched, and no code reads index names, so the version-19 release runs
unchanged against a version-20 database.

## Switching the database engine

Persistence sits behind two seams, so the database can be switched without touching the application code ([ADR-0008](../adr/0008-switchable-persistence.md)): the `Persistence` ports bundle (what the app depends on) and the narrow `SqlDatabase` driver interface (what the SQL repositories run on). The same API suite passes on D1 and on `node:sqlite`; the latter is the portability proof, not a supported production store. To switch engines: implement `SqlDatabase` for another SQLite-dialect engine (or the `Persistence` ports for a non-SQLite one), add a vitest project like `api-sqlite`, and keep the suite green. Moving existing rows between engines is not covered — export each workspace as JSON and re-import it.
