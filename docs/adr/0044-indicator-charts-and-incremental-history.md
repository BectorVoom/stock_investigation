# ADR-0044: Indicator charts and incremental history refresh

Status: accepted, 2026-10-31.

## Context

The owner asked (2026-10-31):

> Please enable indicator widgets to display historical data in charts as
> well. As with other data, all indicator data must be accessed through the
> database. Additionally, since historical stock and indicator data rarely
> changes, implement incremental updates that fetch and store only new or
> modified data instead of re-fetching the entire dataset. Ensure that
> widgets always display the latest available data. Clarify the incremental
> update behavior. Specify database access for historical stock data.

What existed:

- The **Indicator table** showed numbers only. The Stock table, Metric and
  Line chart widgets open the detailed chart viewer (ADR-0025); indicator
  rows did not, and the table drew no history at all.
- A refresh already asked a provider only for dates from the newest stored
  date minus 45 days, and the upsert rewrote only changed values. But a
  change **older than those 45 days** never reached the database: a stock
  split re-adjusts every earlier close, and statistics agencies revise
  monthly figures months or years back (a 45-day window holds one or two
  monthly observations). A point the provider withdrew inside the window was
  never deleted either.
- Home refreshed stale data (older than 30 minutes) once per page load. The
  Notebook refreshed only series that had never been fetched, so a Notebook
  could show day-old prices without asking. A page left open never checked
  again.

## Decision

### 1. Indicator charts

The Indicator table shows history in two ways, both drawn only from the
stored observations the page already has (ADR-0043):

- A **Trend** column: a sparkline per row (decorative, `aria-hidden`, like
  the Metric widget's: green when the range ends above its start, red when
  below, dotted start line) with the range it covers written beside it.
- Each row's **name cell opens the detailed chart viewer** for that row's
  series, exactly like a Stock table row (ADR-0025: a native button named
  "Open chart: " plus the visible name and symbol; no button for a series
  without observations).

The range follows the series' native frequency, so a monthly indicator does
not open on twelve points: daily and weekly series use 1 year, monthly 5
years, quarterly, annual and unknown the whole stored history (`max`). The
Trend column and the viewer's first range are the same. The Trend column
shows only in Large frames (`@2xl`, 42rem): a Medium table with it needed
697 px in a 582 px frame and cut off the Source column. A screen reader hears
the direction over the range ("up over 5 years"); a row without values shows
a dash read as "unavailable", never a bare range label.

### 2. Database access for historical market data

Historical stock prices and indicators (`fred:` and `twelve-data:` series)
reach a widget only through the database:

```text
provider (FRED, Twelve Data)
   ↓ HTTPS, runner only (owner's keys; pacing per provider)
runner  ── market-refresh completion (POST /runner/jobs/:id/complete) ──→ API
   ↓ one compare-and-set batch per completion (lease-guarded)
market_series (meta, last_refreshed_at, history_checked_at)
market_observations (owner, series, date → value), ≤ 1,500 newest per series
   ↓ MarketRepository.getObservations (newest ≤ 800 per series, ascending)
GET /home/data · GET /workspaces/:id/notebook/market-data
   ↓
widgets, sparklines, Trend column, detailed chart viewer
```

- Only the API writes these tables, and only from a lease-guarded
  completion. The runner never reads or writes the database; the browser
  never talks to a provider.
- The page reads the newest `MARKET_LIMITS.maxObservationsPerResponse`
  (800) observations per series; the database keeps up to
  `maxStoredObservations` (1,500). The chart viewer and the Trend column
  work on exactly what the page read — no new endpoint, no provider call.
- Imported material series (`materials:`, ADR-0042) are database-only and
  never fetched.

### 3. Incremental refresh

The rule is the pure domain module `packages/domain/src/market/historyRefresh.ts`
(mirrored in `crates/research-domain`, modelled in Lean,
`formal/ResearchFormal/HistoryRefresh.lean`):

**The claim (API).** For each claimed series the API sends, besides the
existing `latestObservedOn`:

- `anchor`: the stored observation `HISTORY_OVERLAP_OBSERVATIONS` (32)
  places back from the newest — the oldest stored one when fewer are
  stored — as `{ observedOn, value }`; null when nothing is stored.
- `fullCheck`: true when the series has an anchor and its last full fetch
  (`market_series.history_checked_at`) is missing or at least
  `HISTORY_FULL_CHECK_DAYS` (7) days old.

Counting observations instead of days gives every frequency a useful
overlap: 32 trading days (about six weeks) for a daily price, 32 months for
a monthly indicator, eight years for a quarterly one.

**The fetch (runner).**

| Claim | First request | Answer | Stored as |
|---|---|---|---|
| no anchor | everything (newest 800) | any | `full`, replace everything |
| anchor, `fullCheck` | everything | anchor date with the same value | `full`, replace from the oldest fetched date |
| anchor, `fullCheck` | everything | anchor missing or changed | `full`, replace everything |
| anchor | from the anchor's date | anchor date with the same value | `window`, replace from the anchor's date |
| anchor | from the anchor's date | anchor missing or changed | a second request for everything, then as the two `fullCheck` rows |

"Same value" is exact equality of the stored number and the provider's
number (both come from the same decimal text through the same parse). A
changed anchor therefore means the provider changed history the window does
not cover, and the series is fetched in full in the same job — the widgets
never show re-adjusted recent closes next to unadjusted older ones. The
second request is paced like the first. A window fetch is one request (two
for FRED, which also reads the series metadata, cached 24 h per ADR-0039),
as before; only a detected revision costs one more.

**The write (API).** The completion carries, per successful series,
`history: { mode: "window" | "full", replaceFrom: date | null }`. In one
batch, for that series:

1. rows on or after `replaceFrom` (every row when null) whose date is not
   in the answer are deleted — a withdrawn or superseded point disappears;
2. every answered point is upserted, and a row is rewritten only when its
   value changed (`WHERE excluded.value <> value`) — unchanged history is
   neither re-sent to the database nor rewritten;
3. rows past the newest 1,500 are trimmed, as before;
4. `history_checked_at` is set to the API's own completion time for a
   `full` write (never the runner's clock: the 7-day rule compares it with
   the API's clock).

A completion without `history` (a runner from before this ADR) merges as
before and deletes nothing. `replaceFrom` must be one of the answered dates
(the contract refuses anything else), so a write can only replace what the
answer actually covers, and an empty answer never empties a series.
`mergeHistory` in the domain module is the reference semantics; the SQL is
tested against it.

### 4. Widgets show the newest stored data

- **Home and Notebook use one staleness rule** (`autoRefreshScope`,
  ADR-0039): when a series on the page was refreshed more than 30 minutes ago
  (or never), the page queues a refresh. The Notebook now does this too,
  not only for never-refreshed series.
- **Re-checked while open:** the rule runs again when the page becomes
  visible and every 5 minutes while it stays visible, never while a refresh
  is active. The page asks at most once per stale stamp per 30 minutes:
  only the stale or missing stamps that motivate a refresh are remembered,
  and only once the refresh was actually queued. A series no refresh will
  stamp (past the 60-series claim limit, or a job that failed as a whole)
  therefore costs one refresh per 30 minutes, never a loop. A Notebook panel
  that is not displayed (Chat-first below `lg`) counts as hidden.
  Staleness-driven refreshes are also at least 30 minutes apart per page,
  so a run that outlasts 30 minutes (its first stamps are stale when
  stored) is not followed by another at once; a never-refreshed series
  still asks for itself (`unrefreshed`) immediately.
- While a refresh runs the page polls `/home/data` or `…/notebook/market-data` (conditional, ETag) and
  redraws from the database as soon as the completion is stored. The ETag
  moves with `last_refreshed_at`, which every completion sets, so a window
  write that changed or deleted rows is always re-read.

## Consequences

- Migration `0019_market_history_check.sql` adds the nullable column
  `market_series.history_checked_at`. Existing series have none, so their
  first refresh after the upgrade is a full fetch (same request count, a
  longer answer). Rollback: restore the pre-migration backup; older code
  ignores the column. Restart `bun run dev` / `bun run prod` (the launcher
  applies migrations and rebuilds the runner).
- The claim schema gained required fields and both runners decode claims
  strictly, so the API and runner must be upgraded together — the launcher
  always does. A pre-ADR runner's completion (no `history`) is still
  accepted.
- The provider port takes `from` (the first date to return, inclusive)
  instead of `since` (newest stored date, minus 45 days inside each
  adapter); the 45-day constant is gone from both runners.
- Not done: Twelve Data's `outputsize` caps a window at 800 points. A series
  not refreshed for more than ~800 trading days loses its anchor from the
  answer and is fetched in full, which is the correct outcome. A revision
  that leaves the anchor unchanged and lies older than the window is picked
  up by the next 7-day full check, not at once.
