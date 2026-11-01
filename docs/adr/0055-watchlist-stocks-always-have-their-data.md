# ADR-0055: Every Watchlist stock always has its prices, statements and company information

Status: accepted, 2026-11-01. Extends ADR-0051 (which series the market
sync fetches) and ADR-0054 §1 (financial statements follow the Watchlist);
amends ADR-0049 §4 (the Chart tab's empty state) and §5 (the Financial
statements tab of a stock that is not synced, and its sync status line,
§4 below).

**Amended 2026-11-02** by [ADR-0058](0058-every-stock-is-synced.md): the
empty states this record gave the Stocks page ("…every Watchlist stock…",
"Add … to the Watchlist to see its prices") are replaced — every listed
stock is synced, so a stock with nothing stored says its data is on the
way and re-reads while shown, whether or not it is on the Watchlist; stored
statements of an untracked company stay shown (§3 stands).

**Superseded in part 2026-11-02** by [ADR-0058](0058-every-stock-is-synced.md) §2:
§1 no longer holds — the market sync's tracked series lose their Watchlist
part, and Twelve Data fetches no directory stock's series at all; every
directory stock's daily bars come from `stock-prices-sync` (Massive,
J-Quants), and the series clean-up never deletes them.

## Context

The owner asked (2026-11-01):

> Please ensure that users can view stock prices, financial statements, and
> company information at all times.

What the Stocks page could show, per tab, before this decision:

| Tab | Stored for | Gap |
|---|---|---|
| Chart (prices) | stocks a Home or Notebook widget shows (`ownerSeries`) | a Watchlist stock without a widget had no prices: "No prices are stored for … Prices are downloaded for stocks shown on Home or in a notebook." |
| Financial statements | every Watchlist stock (ADR-0054 §1) | a stock that left the Watchlist kept its statements in the database, but the tab hid them (`GET /equities/companies` lists tracked companies only) |
| Company | the stock list for every listed stock; the business description for Watchlist stocks (ADR-0053), kept after untracking | none |

Asked on 2026-11-01, the owner chose **Watchlist stocks**: the server
downloads every Watchlist stock's prices too, statements already stored
stay visible after a stock leaves the Watchlist, and no page triggers a
download (ADR-0049's "stored data only" and ADR-0054 stand). A stock found
by search but not added still says to add it. The other option — the
server fetching any stock the owner opens — was not chosen.

Measuring the change found a defect that more series would have made
common: a `market-refresh` completion carries every series it fetched in
one request, and a full history is 800 observations a series. The default
Home's 13 series plus 50 Watchlist stocks make a 1.13 MB body (a full sync
of the old cap of 60 series was already 1.07 MB), over the API's 1 MB
request limit (`MAX_REQUEST_BODY_BYTES`), so the completion would have been
refused with `PAYLOAD_TOO_LARGE` and the data never stored.

## Decision

### 1. The market sync fetches every Watchlist stock's prices

`ownerSeries` (`packages/application/src/pageSeries.ts`, the one helper the
claim, the completion, the schedule and every series clean-up use) adds
the Watchlist stocks' price series (`stockPriceSeriesId`, in Watchlist
order) after the pages' series:

- **tracked** = Home's page series, then the notebooks' (together at most
  `MARKET_LIMITS.maxPageTrackedSeries`, 60, as before), then every
  Watchlist stock's, de-duplicated. `MARKET_LIMITS.maxTrackedSeries`
  becomes 60 + `WATCHLIST_LIMITS.maxStocks` (50) = **110**, so the
  Watchlist part always fits (TS and Rust contracts; the claim's and the
  completion's series arrays are bounded by it).
- **keep** adds the Watchlist series, so a Home save, a list change or a
  list deletion never deletes a Watchlist stock's prices. Removing a stock
  from the Watchlist deletes its series unless a page still shows it (the
  ADR-0040 clean-up, unchanged).
- The schedule's market decision shares the claim's single Watchlist read
  (`watchlistReadOnce`) with the earnings and Google decisions.

Nothing else changes: the Lean-verified `decideSync` and
`marketSyncIntervalMs` already count every tracked series, so a stock just
added is fetched within seconds of the next claim ("new items") and the
interval stretches to keep Twelve Data inside 600 requests a day — the
default Home (4 Twelve Data series) and 50 US stocks make 54 Twelve Data
series, a full sync every 129.6 minutes. The runner, the claim payload and
the completion handling are unchanged; both runners already pace Twelve
Data at 8 requests a minute.

### 2. A job completion may be up to 4 MB

`MAX_RUNNER_COMPLETION_BODY_BYTES` (4,000,000; TS and Rust contracts) is
the body limit of `POST /api/v1/runner/jobs/:id/complete` alone; every
other route keeps `MAX_REQUEST_BODY_BYTES` (1 MB). The largest market
completion the contract accepts — 110 series × 800 observations with
17-digit values and the longest metadata — is 3.83 MB (pinned by a
contract test). The writes were already chunked (ADR-0044 S5).
(Limit superseded by ADR-0056 §4: 14,000,000 bytes, since every
observation may carry its daily bar.)

### 3. The pages

- **Chart tab**: without stored prices, a Watchlist stock says "No prices
  are stored for AAPL yet. The server downloads the daily closes of every
  Watchlist stock; they appear here after its next sync." and re-reads its
  prices sooner (`createIdleReread`: 5 s, doubling to the tab's usual
  5-minute re-check) until they arrive; any other stock says "No prices
  are stored for AAPL. The server downloads the daily closes of every
  Watchlist stock. Add AAPL to the Watchlist to see its prices." The
  "Open Home" link is gone (Home's widgets no longer decide).
- **Financial statements tab**: `GET /api/v1/stocks/:stockId` also answers
  `company` — the listing's stored company with its sync state, tracked or
  not (null when none is stored; one more key read when one is). A stock
  without a synced company whose stored company has a fiscal year or a
  filing on record shows those statements and filings, headed "These
  statements were stored while this stock was on the Watchlist and are no
  longer updated. Add it to the Watchlist to sync them again." (on the
  Watchlist again, before the reconcile resumes the sync: "These statements
  were stored earlier. The server syncs them again when the local runner
  next takes work."). Without stored statements the ADR-0054 messages
  stand. The financial widgets already show an untracked company's stored
  statements with their own note.
- **Company tab**: unchanged (the listing for every listed stock; a stored
  business description is shown whether or not the company is tracked).

### 4. The Financial statements tab shows no sync status

The owner then asked (2026-11-01), about the line "同期: 同期に失敗 · 確認
3 時間前 / FINANCIAL_SOURCE_NOT_CONFIGURED: 未設定: apps/runner/.env に
EDINET_API_KEY を設定し、ランナーを再起動してください。" on a Japanese stock's tab:

> User can get usually. sync function do not need.

Asked, the owner chose to **remove the sync line**: the tab shows the
statements and filings only — no status ("同期済み · 最終同期 2 時間前"), no
failure code, no failure text (the missing `EDINET_API_KEY` included). The
server still syncs in the background, the companies list is still polled
faster while a sync runs (so new statements appear), and a failed sync is
still logged by the runner and stored with the company (the API's
`sync` field is unchanged). The words only that line used are removed:
`SyncLine`, `syncStatusText`, `syncFailureText`, `syncInProgress`,
`relativeTime`, the status / phase / failure messages of
`equities.messages.ts`, `syncFailureCodes.ts` and the page's clock.

Consequence: a sync that cannot run (a missing key, a refused request) is
no longer visible on any page — the operator finds it in the runner's log
(`financial_sync_*` events) and in OPERATIONS.md.

### 5. The pages only show what the server stored

The owner then said (2026-11-01):

> User can get usually 事業内容 and 財務諸表. Sync do not need.
>
> Please make the server fetch data independently, store it in the
> database, and display the stored data on the page. Do not use user
> actions as a trigger for fetching stock- or index-related data.

Checked against the code: every job that fetches stock or index data
(`market-refresh`, `earnings-refresh`, `financial-sync` — which also reads
the business description — `stock-directory-refresh`, `news-ingest`) is
queued only by the server's claim-time schedulers (`dataSync.ts`,
`equitySync.ts`); no page, API route or MCP tool queues one, and every
page reads stored rows only. The Watchlist says which stocks the server
keeps; when to fetch is the server's decision.

The pages no longer speak of syncing: every sentence of the Financial
statements and Company tabs, the Chart tab and the financial widgets says
what is stored and that the server fetches it by itself ("No financial
statements are stored for this stock yet. The server fetches them by
itself; they appear here once stored." / 「この銘柄の財務諸表はまだ保存されて
いません。サーバーが自動で取得し、保存されるとここに表示されます。」), with no
instruction to make a fetch happen. Google Calendar's wording is unchanged
(it writes dates out to the owner's calendar; it fetches no stock data).

Not changed, recorded: a **research run** (a question asked in Chat, or a
scheduled task) lets the agent call live research tools —
`finance.sec_company_financials`, `filings.sec_13f_holdings`,
`positions.us_short_interest`, `positions.jp_margin_balance`, `news.*`,
`web.*` — which fetch from SEC and other sources while the run answers,
without storing them as the pages' data, and the run also fetches the
owner's news feeds, whose articles the News tab shows (ADR-0054 §4). That
is the one place a user action still makes stock-related requests.

## Consequences

- With the runner running, every Watchlist stock has its daily closes, its
  annual statements and its business description, whether or not a widget
  shows it; a stock that leaves the Watchlist keeps its statements and
  description on the page (not updated) and loses its prices unless a page
  shows them.
- **Japanese stocks' prices**: Twelve Data's Basic (free) plan answers 404
  "Data not found" for JPX listings (verified 2026-10-31,
  [twelve-data.md](../external-apis/apis/twelve-data.md)), so a Japanese
  Watchlist stock's Chart tab states the provider's reason until the plan
  covers JPX. Each such series still costs one Twelve Data request per full
  sync. A Japanese price source is not part of this decision.
- Request volume: up to 50 more Twelve Data series. The daily budget holds
  by construction; each series is fetched less often as the Watchlist
  grows (110 Twelve Data series: every 4.4 hours — daily closes change once
  a day). A first sync of a full Watchlist takes about 7 minutes at 8
  requests a minute.
- Database: up to 50 × 1,500 more rows in `market_observations`; no schema
  change.
- Rollback: restore the previous release (`bun run prod:rollback`). The
  older API tracks fewer series again; Watchlist series it no longer
  tracks are deleted at its next series clean-up.
- Not done: the Rust API port (`api/axum`, not on main) does not have this
  change.
