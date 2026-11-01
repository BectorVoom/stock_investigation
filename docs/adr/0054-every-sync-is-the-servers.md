# ADR-0054: Every sync is the server's; the pages trigger none

Status: accepted, 2026-11-01. Amends ADR-0018 (the automatic Google sync
rule), ADR-0022 (Settings → Calendar's Sync now), ADR-0034 decision 4 (the
stock lists' download on a page visit and "Update stock list"), ADR-0040 §7
(the "All stocks" tab), ADR-0048 §6 and §8 (track, untrack, Sync now, the
default companies), ADR-0049 §2 (the Registered stocks table), ADR-0050 §4
and §5 (the stock lists section, the table's columns) and extends ADR-0051
(server-side sync) to every remaining kind.

**Amended 2026-11-01** at the owner's request ("Please delete リスト：test in
銘柄とリスト."): the Registered stocks table's rows no longer carry the
"In lists: …" (「リスト：…」) line under the name (§5) — a list's tab already
names its list; the Stocks page keeps the line beside the stock's heading
(ADR-0050 §2). Only the SPA changed (`StockTable`, `StockListSection`).

**Extended 2026-11-01** by [ADR-0055](0055-watchlist-stocks-always-have-their-data.md):
the market sync also fetches every Watchlist stock's prices, and the
statements stored for a stock that left the Watchlist stay shown.

## Context

The owner asked (2026-11-01):

> Please delete 次回発表 and 財務諸表 columns . Please delete すべての銘柄 in
> watchlist. Please delete all sync operation by UI.

What existed after ADR-0051: market data and earnings dates were already
synchronised by the server. Four syncs were still started by the browser:

- **financial statements** — Registered stocks' row menu (Sync financials
  now, Sync financial statements, Stop syncing) and the Stocks page's
  Financial statements tab (Sync now, Sync financial statements); the
  claim-time scheduler synced only the companies the owner had tracked
  (at most 20), seeded once with six default companies;
- **the market stock lists** — "Update stock list" and a download queued
  once per visit to Registered stocks when a list was missing or stale;
- **the Google Calendar** — Settings → Calendar's Sync now, and an
  automatic sync the browser queued on Home, Settings and Registered stocks
  whenever the calendar was behind the dates;
- **news feeds** — the Sources page's "Refresh news now" (feeds were
  otherwise fetched only as a side effect of a research run).

Without the Sync buttons nobody could choose which companies' statements
sync. Asked on 2026-11-01, the owner chose:

- the server syncs the financial statements of **every Watchlist stock**;
- the **stock list download, Google Calendar Sync now and Sources "Refresh
  news now"** go too, not only the financial statement buttons;
- with "All stocks" gone, **a stock leaves the Watchlist from the Stocks
  page** ("Remove from Watchlist" beside its heading).

## Decision

All five scheduled kinds of ADR-0051 and the financial statements are
decided at `POST /runner/jobs/claim`, before the candidate scan, so a job
queued there can be handed out by the same claim (no cron, ADR-0004). Every
new timing rule is the Lean-verified `decideSync`
(`formal/ResearchFormal/SyncSchedule.lean`) with its own cadence; no new
domain algorithm was added. Jobs are created outside the owner's hourly
`job-create` allowance and inside the cap of 5 unfinished runs, audited
with actor `scheduler`. `SERVER_DATA_SYNC=off` switches all of it off; the
API test harness keeps it off unless a test opts in (`serverSyncKinds`
narrows it to the kinds a test checks, `equityFollowsWatchlist` turns on
§1 alone).

### 1. Financial statements follow the Watchlist

- At most every 5 s per owner (its own `SyncCheckGate`),
  `equitySync.materializeDue` reconciles the tracked companies with the
  Watchlist before it picks the company due first: every Watchlist stock
  not tracked is tracked (a new listing inserted, an untracked one
  re-tracked — both due now), every tracked company no longer on the
  Watchlist is untracked; its filings, facts and values stay and come back
  at once if the stock is added again. The company's name comes from the
  stored stock list (Japanese for JP), else the Watchlist's name. Audits
  `equity.track`, `equity.retrack`, `equity.untrack` with actor
  `scheduler`. A reconcile failure never fails the claim
  (`equity_sync_scheduler_failed`).
- The cap `EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies` is the Watchlist's
  own (`WATCHLIST_LIMITS.maxStocks`, 50).
- The default companies (`EQUITY_DEFAULT_STOCK_IDS`, the
  `EQUITY_DEFAULT_COMPANIES` binding) are gone; the companies are the
  owner's Watchlist. `equity_sync_meta` is no longer read or written (kept,
  no migration). `sync_requested_at` is written only by the reconcile's
  track and re-track; a re-track during the company's job takes the old
  "Sync now" place in the job-end schedule (ADR-0048 §6).
- Removed: `POST /api/v1/equities/companies` (track),
  `DELETE /api/v1/equities/companies/:companyId` (untrack),
  `POST /api/v1/equities/companies/:companyId/sync` (Sync now), the use
  cases behind them, `trackEquityCompanyRequestSchema` and the error codes
  `EQUITY_COMPANY_ALREADY_TRACKED` / `EQUITY_COMPANY_LIMIT_REACHED` (also
  in the Rust contracts and the vectors). The reads stay.

### 2. The market stock lists

Per market (US, JP), `stock-directory-refresh`: a missing list (no entries)
downloads at once, a stored one once it is `staleAfterDays` (7) old, and a
download that did not complete is tried again an hour later — so a
`DIRECTORY_NOT_CONFIGURED` failure costs one quick failing job an hour
until `apps/runner/.env` is fixed, never a loop. A fresh list skips the job
reads. `findLatestByKind` takes the market scope (like `findActiveByKind`).
Audit `run.sync_stock_directory`. Removed:
`POST /api/v1/watchlist/directory/refresh`,
`StockDirectoryService.queueRefresh` and the refresh request/response
schemas.

### 3. The Google Calendar

A `google-calendar` job with action `sync` is queued when the calendar is
connected (status `connected`), no Google step and no earnings sync is
active (the dates may still change), and the desired events' digest
differs from the stored `syncedDigest`. As a `decideSync` item that was
never refreshed: 15 s after the last Google step (so the first sync
follows a connect within seconds), and 30 minutes (`SYNC_RETRY_MS`) after
a step that did not complete or after a recorded failure. ADR-0018's
"after a failure, wait for the owner" needed Sync now, which is gone, so
the server retries a failed sync of a connected calendar itself; a failure
that needs the owner's consent leaves the link `needs-reconnect`, which is
never looked at until the owner reconnects. The gate also remembers the
digest each automatic sync was queued for; the same digest again waits 30
minutes, so a step that cannot bring the calendar in line never loops
(losing the memory costs one more attempt). Audit
`run.sync_google_calendar`. `POST /api/v1/google-calendar/sync` is
removed; connect and disconnect stay.

### 4. News feeds

A `news-ingest` job over the active (not paused) sources: at once when a
source was never fetched (a new subscription), and all of them once the
oldest fetch is 30 minutes old; 30 minutes after a job that did not
complete. A failed fetch still stamps its source, so a broken feed is tried
again with the others, not in a loop. While every source was fetched
recently the job reads are skipped. Audit `run.sync_news`. Research runs
still fetch the feeds as before. Removed: `POST /api/v1/sources/refresh`
and `runs.createIngest`. Known race: `news-ingest` has no one-active-job
guard on insert, so two claims checking at the same moment (two isolates)
could rarely both queue one; the second ingest finds nothing new.

| Kind | Interval | New item | Failed job |
|---|---|---|---|
| `financial-sync` | 24 h per company (ADR-0048 §6) | tracked at the next reconcile, due now | ADR-0048 backoff |
| `stock-directory-refresh` (per market) | 7 days | missing list: 15 s | 1 h |
| `google-calendar` (`sync`) | none (only on a change) | out of sync: 15 s | 30 min (also after a recorded failure or for the same digest) |
| `news-ingest` | 30 min | never-fetched source: 15 s | 30 min |

(`market-refresh` and `earnings-refresh` as ADR-0051.)

### 5. The pages

- **Registered stocks** (`#/registered`): the tabs are the owner's lists
  only — "All stocks" is gone; the first list is selected on arrival and
  after the selected list is deleted. With no list the panel says "No lists
  yet. Make one with New list. Stocks go on the Watchlist from the Stocks
  page." The table has three columns: Symbol (with the name link; its
  "In lists" line was removed later, see the amendment above), Market, Actions (Remove from list). The Next announcement
  (次回発表) and Financials (財務諸表) columns, the row's financials menu,
  the untrack dialog, the track-limit line, the earnings status line and
  "Add to Watchlist" for tracked-only rows are gone; the page reads only
  the watchlist (not `/equities/companies`). The "Market stock lists"
  (銘柄一覧) area was removed by a separate request the same day (ADR-0050
  §4 amendment); that change still downloaded the lists on a page visit,
  which this decision replaces with §2 — no download on a visit. The page
  purpose: "Group the stocks on your Watchlist into lists."
- **Stocks**: "Remove from Watchlist" beside the heading of a stock on the
  Watchlist, confirmed in a dialog that says how many lists it leaves too.
  The Financial statements tab has no Sync now and no Sync financial
  statements; the read-only sync status stays. A stock without a synced
  company says either that the server syncs every Watchlist stock and its
  first sync runs at the runner's next claim, or that it should be added to
  the Watchlist to be synced. The Company tab's Business group (ADR-0053
  §6) says the same of a stock that is not synced — descriptions are read
  for the stocks on the Watchlist — with no control (its "Open Financial
  statements" button led to the removed Sync financial statements).
- **Settings → Calendar**: no Sync now; connect, cancel, disconnect and
  reconnect stay. The card says the server keeps the calendar in step.
- **Sources**: no "Refresh news now"; a line says the server refreshes the
  feeds about every 30 minutes.
- The per-date "Add to Google Calendar" / "Add to Outlook" links lived only
  in the Next announcement column and are removed with it
  (`packages/domain/src/calendar/links.ts`); the `.ics` file and the
  subscription link stay.
- No page queues any job on its own; the browser no longer calls any sync
  endpoint (the client methods are removed).

## Consequences

- Everything stays fresh with no page open while the runner runs. A stock
  added to the Watchlist gets its earnings dates and its financial
  statements without another click; a stock removed stops syncing.
- Request volume: SEC and EDINET now see up to 50 companies (one at a time,
  each once a day) instead of at most 20; EDINET's date lists dominate for
  Japanese stocks (ADR-0048 §6). The stock lists cost two downloads a week;
  the feeds one ingest every 30 minutes; Google one step per change of the
  dates.
- Each claim costs one in-memory check; every 5 s the schedule reads the
  stamps and jobs of each kind (fresh stock lists and feeds skip the job
  reads), and the reconcile reads the Watchlist and the tracked listings.
- An owner who fixes a configuration waits for the retry (stock lists 1 h,
  feeds 30 min, a failed Google sync 30 min) instead of pressing a button;
  a Google failure that needs consent still waits for Reconnect.
- Tests drive the schedule instead of the endpoints (`queueScheduledJob`,
  repository helpers for the equity tests).
- Rollback: restore the previous release (`bun run prod:rollback`). No
  schema change; companies the reconcile untracked keep their data, and
  the old release's track restores them.
- Not done: the Rust API port (`api/axum`, not on main) still has the
  removed endpoints; `equity_sync_meta` is left in the schema unused.
