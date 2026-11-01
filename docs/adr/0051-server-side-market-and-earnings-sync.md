# ADR-0051: Market data and earnings dates are synchronised by the server

Status: accepted, 2026-11-01. Supersedes ADR-0039 §1–2 (the refresh
endpoints and who asks for what) and ADR-0044 §4 (the pages' staleness
re-check). ADR-0039 §3–6 (runner caches) and the rest of ADR-0044 stand.

**Amended 2026-11-01**: extended by
[ADR-0054](0054-every-sync-is-the-servers.md): the same claim-time schedule
also keeps the stock lists, the Google Calendar and the news feeds, and the
financial-statement companies follow the Watchlist; no page triggers any
sync.

## Context

The owner asked (2026-11-01):

> Modify the system architecture to perform server-side synchronization of
> stock and index data and store it in the database, instead of triggering
> synchronization from the user side.

What existed: the data already lived in the database (ADR-0043) and only
the runner contacted FRED, Twelve Data, Finnhub and JPX (ADR-0005). But
**the browser decided when**: Home and the Notebook queued a
`market-refresh` (`POST /home/refresh`) on load, when the page became
visible, every 5 minutes while visible when a stamp was older than 30
minutes, after a widget or series was added and after a run that left one
unrefreshed; Registered stocks and the earnings calendar queued an
`earnings-refresh` (`POST /watchlist/refresh`) once per visit when dates
were older than 24 hours and after a stock was added; both had a Refresh
button. With no page open nothing was synchronised, and each page carried
its own copy of the staleness bookkeeping.

Asked on 2026-11-01, the owner chose:

- the server synchronises **market series** (stock prices, indexes, FRED
  indicators, Watchlist prices) **and earnings dates**;
- the **Refresh buttons are removed**: pages only read the database;
- market data every **30 minutes around the clock, the interval stretched
  so Twelve Data's daily limit holds**; earnings dates every **24 hours**.

## Decision

### 1. Claim-time scheduling, no cron

The app has no cron (ADR-0004; local-first, ADR-0006): background work is a
job a runner claims. As for scheduled tasks (ADR-0033 §2) and financial
statements (ADR-0048 §6), `POST /runner/jobs/claim` first runs the data
sync scheduler (`createDataSyncService`, `packages/application/src/dataSync.ts`),
which may queue one `market-refresh` and one `earnings-refresh` job; the
same claim can then hand it out. The runner, the claim payload, the
completion and the tables are unchanged — it is the job the removed
endpoints queued. Nothing syncs while no runner polls, which is also when
nothing could fetch.

Per owner, the scheduler reads its state at most every
`SYNC_CHECK_PERIOD_MS` (5 s; in memory per Worker isolate, a loss costs
one early read). A scheduler failure never fails the claim: it is logged as
`data_sync_scheduler_failed` (class name only) and decided again at the
next check. The jobs are created outside the owner's hourly `job-create`
allowance (that is for the owner's own questions) but inside the cap of 5
unfinished runs; a refusal for the cap is logged as `data_sync_skipped` and
looked at again a minute later. Audit: `run.sync_market` /
`run.sync_earnings`, actor `scheduler`, detail `scope=… reason=…`.

`SERVER_DATA_SYNC=off` (Worker binding) switches the scheduler off; the API
test harness does so unless a test opts in.

### 2. The rule (`decideSync`, Lean-verified)

`packages/domain/src/market/syncSchedule.ts`, modelled in
`formal/ResearchFormal/SyncSchedule.lean`. Per kind, from the stored
refresh stamps and the last jobs:

1. nothing while a job of the kind is active or nothing is tracked;
2. **everything** (`"all"`) when the oldest stamp is at least the interval
   old, the last job covering everything was created at least the interval
   ago (30 minutes after one that did not complete) and the last job of any
   scope at least 15 s ago;
3. **new items** (`"unrefreshed"`: never refreshed — a widget, list,
   Notebook series or stock just added, also by the Notebook assistant) at
   once: 15 s after the last job (`SYNC_MIN_GAP_MS`), 30 minutes after one
   that did not complete;
4. **failed items** (`"unrefreshed"`: refreshed, but the fetch failed in a
   way that may succeed now) 30 minutes after the last job.

What a narrow job fetches is ADR-0039's rule, unchanged
(`marketSeriesNeedsRefresh`, `earningsStockNeedsRefresh`); a narrow job
that turns out to cover everything is still stored as `"all"` at the claim.
Measuring from a job's *creation* keeps full syncs an interval apart even
when a run outlasts it, and measuring the full sync from the last *full*
job means jobs for new items never postpone it. The proofs: no queue while
active or empty; every queue at least 15 s after the last job (no loop,
whatever the stamps say); full syncs at least `min(interval, retry)` apart;
after a failure at least 30 minutes; and liveness — stale data, a new item
and a failed item each get a job once their waiting time has passed.

| Kind | Interval | New items | Failed items, failed job |
|---|---|---|---|
| `market-refresh` | `max(30 min, 24 h × n / 600)`, n = tracked Twelve Data series | 15 s | 30 min |
| `earnings-refresh` | 24 h | 15 s | 30 min |

**The market interval.** `marketSyncIntervalMs` plans one Twelve Data
request per series per sync within `TWELVE_DATA_SYNC_REQUESTS_PER_DAY`
(600 of the free plan's 800, leaving room for a revision's second request,
ADR-0044, and the research tools): up to 12 series it is 30 minutes, 13
series 31.2, 30 series 72, 60 series 144 minutes. Proved:
`n × day ≤ 600 × interval`. FRED has no daily limit and does not stretch
it. The API cannot see the runner's `TWELVE_DATA_DAILY_LIMIT`, so a paid
plan with many series syncs less often than it could (recorded below).

### 3. The pages only read

- `POST /api/v1/home/refresh` and `POST /api/v1/watchlist/refresh` are
  removed (with `refreshRequestSchema` and the use cases behind them); no
  client, MCP tool or runner used them besides the SPA.
- The Refresh buttons (Home, the earnings calendar on Home and in the
  Notebook, Registered stocks) and every automatic refresh in the SPA are
  gone. The status line stays: syncing, last successful sync, last failure.
- While a page is visible and no run is active it re-reads its data
  conditionally (ETag) every 60 s and when it becomes visible, so a sync the
  server started shows up — sooner (5 s, doubling to 60 s) while it shows
  something the server has not fetched yet, such as a widget or stock just
  added; while a run is active the existing fast poller follows it and
  redraws as soon as the completion is stored. One helper,
  `createIdleReread` (`apps/web/src/lib/polling.ts`), serves Home, the
  Notebook, Registered stocks and Stocks; a hidden page reads nothing.
- Text that told the owner to queue a refresh now says the data appears
  after the next automatic refresh (both languages, and the contracts'
  `NEVER_REFRESHED` reasons).

## Consequences

- Data is fresh with no page open, as long as the runner runs (`bun run
  dev` / `bun run prod` start it). A widget or stock added shows data within
  seconds of the next claim.
- Request volume: with the default dashboard (9 FRED + 4 Twelve Data
  series) a day costs 48 syncs × 13 requests while the runner runs, where
  pages used to ask only while open. Twelve Data stays inside 600 a day by
  construction; FRED (no daily limit) and Finnhub (one sync a day plus
  retries) are far below their per-minute limits.
- Each claim costs one in-memory check; every 5 s, two indexed job reads per
  kind plus the tracked-series reads. No migration: `findLatestByKind` reads
  `idx_research_jobs__owner_id_kind_created_at_run_id`.
- An owner who fixes a missing key waits up to 30 minutes (failed items) for
  the retry, instead of pressing Refresh.
- Rollback: restore the previous release (`bun run prod:rollback`); no data
  changes.
- Not done: the runner's `TWELVE_DATA_DAILY_LIMIT` is not reported to the
  API, so the schedule plans for the free plan; market-hours awareness
  (fewer syncs overnight and at weekends) was offered and not chosen. The
  Rust API port (`api/axum`, not on main) still has the old endpoints.
