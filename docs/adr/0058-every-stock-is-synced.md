# ADR-0058: Every listed stock is synced, never-stored stocks first

Status: accepted, 2026-11-02. Supersedes ADR-0054 §1 (financial statements
follow the Watchlist) and ADR-0055 §1 (the market sync fetches every
Watchlist stock's closes); amends ADR-0051 (which series the market sync
fetches), ADR-0048 §3 (EDINET discovery per company) and ADR-0053 (the
business description of 10-K filers only).

## Context

The owner asked (2026-11-02), after Netflix and the Rio Tinto ADR showed
empty tabs on the Stocks page because neither was on the Watchlist:

> Update all stocks on the server regardless of user actions or watchlist
> status. Please prioritize stocks that are not yet stored in the database.

"All stocks" is the stock directory (ADR-0034): every exchange-listed US
stock in SEC's ticker list (7,682 on 2026-11-01) and every Japanese stock
in JPX's list (3,700). What each tab needs, and why the existing sync could
not deliver it:

| Data | Today | Limit at 11,400 stocks |
|---|---|---|
| Daily prices | Twelve Data, one request per stock, Watchlist + page series only (≤ 110) | Basic plan: 800 requests a day → one pass over the US stocks every ~13 days; no Japanese listing at all (404) |
| Financial statements | SEC / EDINET, one company per job, Watchlist only (≤ 50) | EDINET discovery scans the day lists per company (~3,700 jobs a day in steady state, 1–2 M scanned-day rows) |
| Business description | 10-K Item 1 / 有価証券報告書 | 20-F and 40-F filers (foreign ADRs: Rio Tinto, BHP, Toyota, Sony) have none; their statements are IFRS, which the SEC importer does not read |

Asked on 2026-11-02, the owner chose (AskUserQuestion):

- **US prices: Massive** (formerly Polygon.io), free Basic plan — the
  grouped-daily endpoint returns every US stock's bar for one date in one
  request; 5 requests a minute, end-of-day, two years of history, terms
  for personal non-business use.
- **Japanese prices: J-Quants Free** (JPX's official API) — the daily-bars
  endpoint returns every TSE stock for one date; 5 requests a minute, two
  years of history, **about 12 weeks behind** (the Free plan's delay; the
  ¥1,650/month Light plan was not chosen).
- **20-F / 40-F and IFRS** support in the SEC importer.

Twelve Data stays for the indices, gold, FX and every other non-stock
series the pages show.

## Decision

### 1. Scope

Every stock in the owner's stock directory has its daily prices, its
annual financial statements and its business description synchronised by
the server — whether or not it is on the Watchlist, a page shows it or the
owner opened it. No page triggers a sync (ADR-0049, ADR-0054 stand). Work
is ordered so that **a stock with nothing stored is served before a stock
whose stored data is only being refreshed**.

Earnings dates stay Watchlist-only: they feed the Watchlist calendar
(ADR-0022, ADR-0054 §3), not the Stocks page.

### 2. Prices: one request per market and date (`stock-prices-sync`)

A new job kind `stock-prices-sync`, one job per market (`US`, `JP`), like
`stock-directory-refresh`. The unit of work is **one trading date of one
market**: one request returns every stock's bar for that date.

| Market | Provider | Request | Window |
|---|---|---|---|
| US | Massive | `GET /v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true` | the last 2 years to today |
| JP | J-Quants | `GET /v2/equities/bars/daily?date=` (paginated) | the plan's window: on Free, 2 years back to about 12 weeks ago |

**Day planning** (`planSyncDays`, packages/domain, Lean-verified — §8):
candidate days are the weekdays of the window, **newest first**; a day
already `stored`, `no-trading` or `too-old` is never asked again; a day
answered `not-yet-available` is asked again after `STOCK_PRICE_LIMITS.retryHours`.
At most `STOCK_PRICE_LIMITS.maxDaysPerJob` days per job. Newest first means
the **first request gives every stock its latest price**; the older days
then fill the history.

**Per-stock history.** Once no day of the window is due, the claim also
names up to `maxHistoriesPerJob` directory stocks whose window history was
**never filled** — no stored price series, or a series created after days
of the window were already stored (it missed them): Watchlist stocks first,
then by symbol. A series counts as filled once `market_series.history_checked_at`
is set (a series created by the day walk before any day of the window was
stored, or a settled history). The runner fetches each named stock's whole
window (Massive `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}`,
J-Quants `?code=&from=&to=`). A stock the provider does not know is stored
as a series with `SERIES_NOT_FOUND` and is not asked again by this rule; a
history answered `unavailable` is backed off for 24 h
(`stock_price_history.retry_at`) so the stocks behind it get their turn.

**Splits.** Both providers return split-adjusted prices, adjusted as of
the request. A split effective after the stored bars makes them
inconsistent, so the claim carries `adjustmentsSince`, the market's split
watermark (`stock_price_market.split_checked_on`: the newest day an earlier
job's split check covered completely; null when never checked): US — the
runner lists Massive's splits executed after it (`GET /stocks/v1/splits`)
and refetches each split stock's window; JP — a fetched day newer than
`adjustmentsSince` whose `AdjFactor ≠ 1` triggers the same refetch for
that code. The completion reports how far its check got
(`splitCheckedThrough`, null when a rate limit ended it); the API moves the
watermark forward to it, never past the claim's window end. Refetches share
`maxHistoriesPerJob` (requested windows first) and are reported with
reason `split`. The completion lists **every** split the job found in
`splitSymbols` (sorted, distinct, ≤ `maxSplitSymbols`), refetched or not —
JP adjustments even when a rate limit ended the walk — and every `split`
history names one of them; the API records each split stock it still owes
a refetch (`stock_price_history.refetch_requested_at`, first request kept)
and plans those windows first in later jobs, so no split is lost to the
cap.

**Day outcomes** the runner reports, and what the API stores in
`stock_price_day`:

| Outcome | Meaning | Asked again |
|---|---|---|
| `stored` | bars returned (any count ≥ 1) | never |
| `no-trading` | no bars for a day old enough to be final (a holiday) | never |
| `not-yet-available` | no bars yet for a recent day, or a day newer than the plan's delay | after `retryHours` |
| `too-old` | before the plan's history | never |

**Storage.** Bars go to `market_observations` under the stock's existing
price series id (`stockPriceSeriesId`: `twelve-data:AAPL`,
`twelve-data:1380:JPX`), so widgets, the chart viewer and the Stocks page
read them unchanged. The id prefix is a legacy namespace, not the source:
`market_series.publisher` and `source_url` name the provider that wrote the
bars (Massive, J-Quants). Only bars of directory stocks are stored (the
API filters; Massive's ticker `BRK.B` is the directory's `BRK-B`;
J-Quants' 5-digit code `13800` is `1380`). A missing `market_series` row is
created with the directory's name and listing. Rewriting the ids to a
provider-neutral form is recorded technical debt (it would rewrite stored
widgets and notebooks).

**Twelve Data no longer fetches stock series.** The `market-refresh` claim
leaves out every series that is a directory stock's price series (US
symbol in the US directory, or a `:JPX` id); ADR-0055 §1's Watchlist part
of `ownerSeries.tracked` is removed. A stock widget on Home therefore shows
the last close, updated once a day after the market's data is published,
not Twelve Data's intraday bar. The series clean-up (`deleteSeriesNotIn`)
never deletes a directory stock's price series.

**Scheduling.** The claim-time schedule (`materializeDue`, ADR-0051)
queues a market's job when no job of that market is active, the market's
directory is stored, `planSyncDays` (or the per-stock rule) has work, and
the last job of that market was created at least `SYNC_MIN_GAP_MS` ago
(`SYNC_RETRY_MS` after one that did not complete).

### 3. Financial statements: every directory stock is tracked

- **Tracking follows the directory, not the Watchlist.** The claim-time
  reconcile tracks directory stocks in batches (`EQUITY_FINANCIAL_LIMITS.trackBatch`
  per check, one `INSERT … SELECT`, Watchlist stocks first) and untracks a
  company whose listing left the directory. Stored statements are kept on
  untrack (ADR-0055 §3). The cap `maxTrackedCompanies` becomes the
  directory's size.
  A re-tracked company that was checked before (its listing left one
  directory download and came back with the next) keeps its cadence — due
  `directorySyncIntervalHours` after its last check, not at once — so a
  short-lived gap in the list does not queue thousands of jobs.
- **Never-checked first.** The due-company probe orders companies never
  checked (`last_checked_at IS NULL`) before every company being refreshed,
  then by `next_due_at`.
- **Cadence.** A Watchlist company is checked every 24 h as before; every
  other company every `EQUITY_FINANCIAL_LIMITS.directorySyncIntervalHours`
  (168 h): annual statements change once a year, and a quiet SEC check is
  one submissions request.
- **Long backoff for answers that will not change**: an identity conflict
  (a second listing of one issuer: GOOG / GOOGL, BRK-A / BRK-B) and a
  company with no annual report (funds, SPACs) are checked again after
  `notFoundRetryDays` (30), not every 24 h.
- **Job rows are kept for 7 days.** Terminal jobs of the server's sync
  kinds (`market-refresh`, `earnings-refresh`, `stock-directory-refresh`,
  `news-ingest`, `google-calendar`, `financial-sync`, `stock-prices-sync`,
  `edinet-index`) older than `SYNC_JOB_RETENTION_DAYS` are deleted with
  their transitions and events, at most once an hour; research and
  notebook runs are never pruned. A first pass over 11,400 companies is
  11,400 jobs.

### 4. EDINET: one shared index of annual reports (`edinet-index`)

EDINET has no per-company search; today each company scans the day lists
itself. Instead, a new job kind `edinet-index` lists **each day once for
every company**: the API plans the days with the same `planSyncDays`
(weekdays, newest first, back `backfillYears`; a day is final once it is
before today in JST), the runner lists each day
(`GET /api/v2/documents.json?date=&type=2`) and returns its annual
securities reports (docTypeCode 120 and 130 with a securities code), and
the API stores them in `edinet_document_index`. A JP company's
`financial-sync` is due when the index holds a report of its securities
code that is not stored yet (or one newer than its business description);
the claim names those reports (`indexedFilings`) and the runner downloads
them. The per-company day scan (`scanDays`, `edinetScanPlan`,
`equity_edinet_scanned_day`) is removed. Without `EDINET_API_KEY` the
index job fails once and is retried after `SYNC_RETRY_MS`; no company job
is queued, so a missing key costs one job, not 3,700.

### 5. 20-F, 40-F and IFRS

- The SEC importer accepts annual reports on Forms 20-F, 20-F/A, 40-F and
  40-F/A beside 10-K and 10-K/A (`EquityReportForm`).
- It reads the `ifrs-full` taxonomy beside `us-gaap`; a filing's accounting
  standard is the taxonomy its facts came from. Reviewed `ifrs-full`
  concept mappings for the SEC provider cover the metrics IFRS has
  (ordinary income is JGAAP only); mappings are per provider, so EDINET's
  IFRS filers (`jpigp_cor`) still read `no-mapping-for-standard` (follow-up).
- The business description of a 20-F is Item 4.B "Business Overview" (or
  Item 4 "Information on the Company") of the primary document. Many
  foreign issuers incorporate it from an annual-report exhibit; then it is
  recorded as not found, as is every 40-F (its description is in the Annual
  Information Form exhibit) — a known limitation.
- Currencies are kept as filed (GBP, AUD, JPY…); nothing is converted.

### 6. Pages

The Stocks page no longer tells the owner to add a stock to the Watchlist
to get its data. A stock with nothing stored yet says its data is on the
way and re-reads while open, like a Watchlist stock did. A Japanese stock's
chart says its prices come from J-Quants Free and end about 12 weeks ago.
Tracked companies no longer add rows to the Stocks list (every directory
stock is tracked).

### 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MASSIVE_API_KEY` | none | Massive key; without it US stock prices are not fetched (`SOURCE_NOT_CONFIGURED`) |
| `MASSIVE_REQUESTS_PER_MINUTE` | 5 | the Basic plan's limit |
| `JQUANTS_API_KEY` | none | J-Quants key (`x-api-key`) |
| `JQUANTS_REQUESTS_PER_MINUTE` | 5 | the Free plan's limit |
| `JQUANTS_DELAY_DAYS` | 84 | the plan's delay (Free: 12 weeks; 0 on a paid plan) |
| `EDINET_API_KEY` | none | unchanged (ADR-0048) |

### 8. Formal verification

`planSyncDays` is modelled in Lean (`formal/ResearchFormal/SyncDays.lean`)
and replayed by conformance vectors: the output is a subset of the
window's weekdays, strictly newest first, holds no final day, no retried
day before its retry time, at most `max` days, and is complete (a due day
is left out only when `max` newer due days were chosen). The IFRS mapping
rule (`hasReviewedMappings` per provider) is updated in
`FinancialStatements.lean`; the removed EDINET scan plan leaves the model.

## Consequences

- One pass: US prices in about 100 minutes (≈ 500 dates at 5 a minute),
  JP prices about the same; US statements in several hours (one company
  per job, ~3–4 SEC requests each); the EDINET index in about 30 minutes
  of listing plus one download per annual report (1 a second).
- Storage grows to roughly 2–3 GB in D1 (≈ 170 KB of statements per US
  company, ≈ 70 B per bar).
- Japanese prices are about 12 weeks old on J-Quants Free.
- Stock widgets update once a day instead of every 30 minutes.
- The runner runs one job at a time; sync jobs are short (≤ 10 dates or one
  company), so a research question waits at most one sync job.
- Three keys are needed for the full result (`MASSIVE_API_KEY`,
  `JQUANTS_API_KEY`, `EDINET_API_KEY`); each missing key stops only its own
  part.
