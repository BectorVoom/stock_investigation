# External API: Massive

## 1. Overview

| Property | Value |
|---|---|
| Provider | Massive (formerly Polygon.io) |
| Purpose | Daily bars — close, open, high, low and volume — of every exchange-listed US stock in the owner's stock directory, for the Stocks page's Chart tab, the stock widgets on Home and in the Notebook and the chart viewer ([ADR-0058](../../adr/0058-every-stock-is-synced.md) §2). One grouped request returns every US stock's bar of one trading date; per-stock range requests fill the history of a stock that has none, or that a split made inconsistent. |
| Hosts | `api.massive.com` |
| Endpoints | `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` — every US stock's split-adjusted daily bar of one date ("Daily Market Summary"); `GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}` — one stock's daily bars over a date range ("Custom Bars"), paginated by `next_url`; `GET /stocks/v1/splits` — split events by execution date ("Splits", the current endpoint; `/v3/reference/splits` is the deprecated one) |
| Authentication | Header `Authorization: Bearer <key>` (Massive's header method; the `apiKey` query parameter is never used, so the key never enters a URL or a log line). Env variable `MASSIVE_API_KEY` in `apps/runner/.env`: 8–200 printable ASCII characters without spaces, checked at start. Without it the runner logs `market_source_disabled` (reason `MASSIVE_API_KEY not set`) once and every US `stock-prices-sync` job fails `SOURCE_NOT_CONFIGURED` without a request. |
| Configuration | `MASSIVE_REQUESTS_PER_MINUTE` in `apps/runner/.env` (`apps/runner/src/config.ts`, `crates/research-runner/src/config.rs`): request starts per minute, integer 1–600, default 5 (the Basic plan). |
| Usage Limits | Stocks Basic (free): "5 API Calls / Minute", end-of-day data, 2 years of history ([pricing](https://massive.com/pricing); plan tables on each endpoint page); every endpoint used here is "Included in all Stocks plans". The Basic plan's terms are for personal, non-business use (ADR-0058). Ours: a window of `MASSIVE_REQUESTS_PER_MINUTE` request starts per 60 s under the pacer key `massive`, one grant per request and per followed page; at most `STOCK_PRICE_LIMITS.maxDaysPerJob` (10) dates and `maxHistoriesPerJob` (10) requested windows per job, plus split refetches sharing that cap; at most 5 pages per range or split listing; no daily budget; no cache. |
| Called By | Rust runner (default) and TypeScript runner (rollback), `stock-prices-sync` jobs of market `US` only, which the API queues at claim time (ADR-0058 §2 "Scheduling"). The API Worker and the browser never call Massive; `https://massive.com/` is only stored as the attribution link (section 6). |
| Code | `crates/research-finance/src/massive.rs`, `crates/research-finance/src/stock_prices.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-contracts/src/stock_prices.rs`, `crates/research-runner/src/config.rs`, `packages/adapters/src/finance/massive.ts`, `packages/adapters/src/finance/stockPrices.ts`, `packages/adapters/src/finance/marketFetch.ts`, `apps/runner/src/jobExecution.ts`, `apps/runner/src/main.ts`, `apps/runner/src/config.ts`, `apps/runner/src/marketPacing.ts`, `packages/contracts/src/stockPrices.ts`, `packages/application/src/stockPrices.ts`, `packages/adapters/src/sql/stockPrices.ts` |
| Official Documentation | [REST Quickstart](https://massive.com/docs/rest/quickstart) (authentication), [Daily Market Summary (OHLC)](https://massive.com/docs/rest/stocks/aggregates/daily-market-summary), [Custom Bars (OHLC)](https://massive.com/docs/rest/stocks/aggregates/custom-bars), [Splits](https://massive.com/docs/rest/stocks/corporate-actions/splits), [pricing](https://massive.com/pricing). Each page has a Markdown form (append `.md`). |
| Last Verified | 2026-11-02, spec; no live call (no `MASSIVE_API_KEY` on this machine) (section 7) |

The API plans each US job (`planStockPrices`, `packages/application/src/stockPrices.ts`): up to 10 due weekdays of the last 730 days, newest first; only when no day is due, up to 10 directory stocks with no stored price series, each over the whole window; and `adjustmentsSince`, the newest stored day before the job. The runner (`syncStockPrices`, `packages/adapters/src/finance/stockPrices.ts`) asks the grouped endpoint once per day, maps each ticker to the directory's form and reports the day's outcome; then fetches each requested stock's range; then, when the job stored a day newer than `adjustmentsSince`, lists the splits executed in between and refetches each split stock's window (reason `split`). The `stock-prices-synced` completion goes to the API, which stores the bars of directory stocks only, under each stock's existing price series id (section 6).

## 2. Input Parameters

The fetch core sets `Accept` and `User-Agent` on every hop, redirect hops included, and `Authorization` on the first request only, never on a redirect hop (`packages/adapters/src/worker/safeFetchCore.ts`, `crates/research-net/src/core.rs`); the transport adds `Accept-Encoding: gzip` (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`). Every request and redirect is pinned to `api.massive.com`; a `next_url` page is a new request (with `Authorization`) and must also be on that host.

### GET /v2/aggs/grouped/locale/us/market/stocks/{date}

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `date` | path | string | Yes | — ; we send one date of the claim | `YYYY-MM-DD`, a weekday the API planned (America/New_York date) | The trading date. |
| `adjusted` | query | boolean | No | Massive: `true`; we send `true` | `true` / `false` | Split-adjusted bars, adjusted as of the request. |
| `Authorization` | header | string | Yes | — ; we send `Bearer <MASSIVE_API_KEY>` | Printable ASCII, ≤ 300 characters | The owner's key. |
| `Accept` | header | string | No | We send `application/json` | Printable ASCII | JSON answer. |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` | Printable ASCII | The runner's fixed identification (`DEFAULT_USER_AGENT`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | Encoded bytes count against the size cap. |

We never send `include_otc` (Massive's default `false`: no OTC securities).

### GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `stocksTicker` | path | string | Yes | — ; the directory symbol in Massive's form (`symbolToMassiveTicker`: `BRK-B` → `BRK.B`, `ABR-PD` → `ABRpD`, `AAC-WT` → `AAC.WS`, `NE-WTA` → `NE.WS.A`, `AAC-UN` → `AAC.U`, `AIIA-RI` → `AIIAr`, `MSGK-WI` → `MSGKw`; plain symbols unchanged) | Case-sensitive ticker; a symbol with no Massive form is reported `not-found` without a request | The stock. |
| `multiplier` | path | integer | Yes | — ; we send `1` | — | One bar per… |
| `timespan` | path | string | Yes | — ; we send `day` | — | …day. |
| `from` | path | string | Yes | — ; the window's start (the claim's `from`, or `windowStart` for a split refetch), or 700 days before today when Massive refused the first start (section 4) | `YYYY-MM-DD` (Massive also accepts a millisecond timestamp; its own `next_url` uses one) | First day, inclusive. |
| `to` | path | string | Yes | — ; the claim's `to` (today in New York), or the newest day the job stored for a split refetch | `YYYY-MM-DD` | Last day, inclusive. |
| `adjusted` | query | boolean | No | Massive: `true`; we send `true` | `true` / `false` | Split-adjusted bars. |
| `sort` | query | string | No | Massive: not stated; we send `asc` | `asc` / `desc` | Oldest first. |
| `limit` | query | integer | No | Massive: 5000; we send `50000` | ≤ 50000 | Base aggregates queried per page; two years of daily bars fit one page. |
| `cursor` | query | string | No | Not sent by us; it is part of Massive's `next_url`, which we request exactly as given | Opaque | Next page. |
| `Authorization`, `Accept`, `User-Agent`, `Accept-Encoding` | header | string | — | As for the grouped endpoint | — | — |

### GET /stocks/v1/splits

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `execution_date.gt` | query | string | No | Massive: none; we send the claim's `adjustmentsSince` | `YYYY-MM-DD` | Splits executed after the newest day stored before this job. |
| `execution_date.lte` | query | string | No | Massive: none; we send the newest day this job stored | `YYYY-MM-DD` | …up to the newest stored day. |
| `limit` | query | integer | No | Massive: 100; we send `5000` | ≤ 5000 | Results per page. |
| `Authorization`, `Accept`, `User-Agent`, `Accept-Encoding` | header | string | — | As for the grouped endpoint | — | — |

Called only when the claim's `adjustmentsSince` is set, the job stored a day after it, nothing ended the job's fetching earlier and `windowStart` is not after that day. Following pages are Massive's `next_url`, requested as given.

## 3. Output Parameters

### GET /v2/aggs/grouped/locale/us/market/stocks/{date}

`application/json`, one object. Numbers are JSON numbers.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.adjusted` | boolean | No | No | No | Whether the answer is split-adjusted. |
| `$.queryCount` | integer | No | No | No | Aggregates used to build the answer. |
| `$.request_id` | string | No | No | No | Request id. The reference's sample shows an object (`{"description", "type"}`) here — a rendering of the schema, kept verbatim in section 5. |
| `$.resultsCount` | integer | No | No | No | Number of results. |
| `$.status` | string | No | No | No | `OK`. |
| `$.results` | array | No | Yes | Yes | One bar per ticker; absent or empty → a day without bars (section 4, outcomes). Any other type → `SOURCE_FAILED`. |
| `$.results[].T` | string | No | No | Yes | Ticker in Massive's (consolidated-tape) form, e.g. `KIMpL`. Absent → row dropped. |
| `$.results[].o` | number | No | No | Yes | Open. |
| `$.results[].h` | number | No | No | Yes | High. |
| `$.results[].l` | number | No | No | Yes | Low. |
| `$.results[].c` | number | No | No | Yes | Close. |
| `$.results[].v` | number | No | No | Yes | Volume; may be fractional (`25933.6` in the sample). |
| `$.results[].vw` | number | No | Yes | No | Volume-weighted average price. |
| `$.results[].t` | integer | No | No | No | Unix ms of the end of the aggregate window (the reference); the request's date is used instead. |
| `$.results[].n` | integer | No | Yes | No | Number of transactions. |
| `$.results[].otc` | boolean | No | Yes | Yes | `true` for an OTC ticker, "left off if false"; `true` → row dropped. |

### GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}

`application/json`, one object.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.ticker` | string | No | No | No | The requested ticker. |
| `$.adjusted` | boolean | No | No | No | Whether split-adjusted. |
| `$.queryCount` | integer | No | No | No | Base aggregates used. |
| `$.request_id` | string | No | No | No | Request id. |
| `$.resultsCount` | integer | No | No | No | Number of results. |
| `$.status` | string | No | No | No | `OK`. |
| `$.next_url` | string | Yes | Yes | Yes | Full URL of the next page, "if present"; absent or `null` → last page. Followed at most to 5 pages in all (a sixth → `SOURCE_FAILED`), each on `api.massive.com`. |
| `$.results` | array | No | Yes | Yes | Bars, ascending; absent or empty → no bars (the history is `not-found`). |
| `$.results[].o`, `.h`, `.l`, `.c` | number | No | No | Yes | Open, high, low, close. |
| `$.results[].v` | number | No | No | Yes | Volume. |
| `$.results[].vw` | number | No | Yes | No | Volume-weighted average price. |
| `$.results[].t` | integer | No | No | Yes | Unix ms of the start of the aggregate window (midnight America/New_York for a daily bar); its New York date is the bar's date. Absent or not finite → row dropped. |
| `$.results[].n` | integer | No | Yes | No | Number of transactions. |
| `$.results[].otc` | boolean | No | Yes | No | OTC flag, "left off if false". |

### GET /stocks/v1/splits

`application/json`, one object.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.request_id` | string | No | No | No | Request id (the reference's sample shows the number `1`). |
| `$.status` | string | No | No | No | `OK`. |
| `$.next_url` | string | Yes | Yes | Yes | Next page, "if present"; followed like the range endpoint's (≤ 5 pages). |
| `$.results` | array | No | Yes | Yes | Split events, newest execution date first by default. |
| `$.results[].ticker` | string | No | No | Yes | Ticker that split, mapped to the directory's form; unmappable → dropped. |
| `$.results[].execution_date` | string | No | No | No | `YYYY-MM-DD` the split takes effect (filtered by the query). |
| `$.results[].adjustment_type` | string | No | No | No | `forward_split`, `reverse_split` or `stock_dividend`; every type triggers a refetch. |
| `$.results[].historical_adjustment_factor` | number | No | No | No | Cumulative factor for historical prices. |
| `$.results[].id` | string | No | No | No | Event id. |
| `$.results[].split_from` | number | No | No | No | Old shares. |
| `$.results[].split_to` | number | No | No | No | New shares. |

## 4. Error Handling

### HTTP status codes

Massive's reference pages publish no status list; our mapping follows the HTTP status only (`massiveProblem` in `packages/adapters/src/finance/massive.ts`). The error body is never read (`includeErrorBody` is off). The status always travels unchanged as `failureUpstreamStatus` or a day's `upstreamStatus` ([error handling §4a](../../rule/error_handling.md), ADR-0037).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 401 | Missing or unknown key | Fails the job at once (any endpoint); not retried | `SOURCE_AUTH_FAILED` |
| 403 | The plan does not cover the request: a date before the day's end on the Basic plan (end-of-day data), or older than its 2 years | Grouped day: a day at most `settleDays` (3) days old is reported `not-yet-available` (asked again after 6 h); more than 365 days old `too-old` (never asked again); otherwise the job fails. Range: retried once from 700 days back when the window started earlier; still refused → that stock is left for a later job, the others go on. Splits: the split check is skipped. | — / `PLAN_NOT_ENTITLED` |
| 404 | Unknown path or ticker | Range: the stock is reported `not-found` (stored as `SERIES_NOT_FOUND`, not asked again by the per-stock rule). Grouped day: ends the fetching like a source failure. Splits: the split check is skipped. | — / `SOURCE_FAILED` |
| 429 | More than the plan's requests per minute | Fetching ends; the days and histories obtained so far are reported; with nothing obtained the job fails, not retried at once (the next job's gap waits it out) | `RATE_LIMITED` |
| 5xx, any other | Server error | Fetching ends; what was obtained is reported; with nothing obtained the job fails, retryable | `SOURCE_FAILED` |
| 200 with an unexpected shape | — | Fetching ends like a source failure (no status) | `SOURCE_FAILED` |
| — | Timeout, network error, body over the cap, redirect or `next_url` off `api.massive.com`, more than 5 pages | Like a source failure, no status | `SOURCE_FAILED` |

**Day outcomes** (ADR-0058 §2): a grouped answer with at least one usable bar is `stored`; an empty one is `no-trading` (a holiday) once the day is more than 3 days old, else `not-yet-available`. A completion the contract would refuse fails the job as `SOURCE_FAILED` (not retryable) and logs `stock_prices_rejected`.

### Provider error codes and body

Not published on the reference pages used. From Polygon.io (Massive's former name), the known shapes are `{"status":"NOT_AUTHORIZED","request_id":"…","message":"…"}` for a plan refusal and `{"status":"ERROR","request_id":"…","error":"Unknown API Key"}` for a bad key (section 5, unverified). Our code reads neither.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s per request (connection, redirects, body); body cap 8,000,000 bytes for a grouped day (≈ 1.5 MB for ~11,000 tickers), 2,000,000 bytes per range or splits page; at most 5 redirects, each on `api.massive.com`, without `Authorization`. | `packages/adapters/src/finance/massive.ts`, `crates/research-finance/src/massive.rs` |
| Retries | None per request, except the one range retry from 700 days back after a 403. Transport only: up to 3 resolved addresses per request (`MAX_CONNECT_ATTEMPTS`); the Rust runner re-sends a GET once when a pooled connection closed before answering. An unanswered day is asked by a later job (`planSyncDays`). | `packages/adapters/src/finance/stockPrices.ts`, `crates/research-net/src/pinned.rs` |
| Rate limit | No header read. A window of `MASSIVE_REQUESTS_PER_MINUTE` (default 5) starts per 60 s under the pacer key `massive`, shared across jobs for the runner's lifetime; every page counts. Requests are sequential. A 429 ends the job's fetching. | `apps/runner/src/marketPacing.ts`, `apps/runner/src/main.ts`, `crates/research-finance/src/pacing.rs` |
| Cache | None. | `packages/adapters/src/finance/massive.ts` |
| Fallback | Stored bars stay; the Stocks page and the widgets show them. A missing key costs one failed job per scheduling gap, not one per stock. | `packages/application/src/stockPrices.ts` |

## 5. Examples

### GET /v2/aggs/grouped/locale/us/market/stocks/{date}

Request (the date of the reference's sample):

```http
GET /v2/aggs/grouped/locale/us/market/stocks/2020-10-14?adjusted=true HTTP/1.1
Host: api.massive.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Authorization: Bearer <MASSIVE_API_KEY>
Accept-Encoding: gzip
```

Verified: spec, 2026-11-02, https://massive.com/docs/rest/stocks/aggregates/daily-market-summary and https://massive.com/docs/rest/quickstart (Bearer header). Path and query as `createMassiveStockPriceSource` builds them.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: massive-grouped-daily -->
```json
{
  "adjusted": true,
  "queryCount": 3,
  "request_id": {
    "description": "A request id assigned by the server.",
    "type": "string"
  },
  "results": [
    {
      "T": "KIMpL",
      "c": 25.9102,
      "h": 26.25,
      "l": 25.91,
      "n": 74,
      "o": 26.07,
      "t": 1602705600000,
      "v": 4369,
      "vw": 26.0407
    },
    {
      "T": "TANH",
      "c": 23.4,
      "h": 24.763,
      "l": 22.65,
      "n": 1096,
      "o": 24.5,
      "t": 1602705600000,
      "v": 25933.6,
      "vw": 23.493
    },
    {
      "T": "VSAT",
      "c": 34.24,
      "h": 35.47,
      "l": 34.21,
      "n": 4966,
      "o": 34.9,
      "t": 1602705600000,
      "v": 312583,
      "vw": 34.4736
    }
  ],
  "resultsCount": 3,
  "status": "OK"
}
```

Verified: spec, 2026-11-02, https://massive.com/docs/rest/stocks/aggregates/daily-market-summary (the page's Sample Response, its `.md` form). Complete sample, verbatim, re-indented; its `request_id` object is as published (section 7). Status line and `Content-Type` are not on the page.

### GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}

Request (a requested window; the dates of the reference's sample):

```http
GET /v2/aggs/ticker/AAPL/range/1/day/2020-01-01/2020-01-10?adjusted=true&sort=asc&limit=50000 HTTP/1.1
Host: api.massive.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Authorization: Bearer <MASSIVE_API_KEY>
Accept-Encoding: gzip
```

Verified: spec, 2026-11-02, https://massive.com/docs/rest/stocks/aggregates/custom-bars. Path and query as `createMassiveStockPriceSource` builds them.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: massive-range-aapl -->
```json
{
  "adjusted": true,
  "next_url": "https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/1578114000000/2020-01-10?cursor=bGltaXQ9MiZzb3J0PWFzYw",
  "queryCount": 2,
  "request_id": "6a7e466379af0a71039d60cc78e72282",
  "results": [
    {
      "c": 75.0875,
      "h": 75.15,
      "l": 73.7975,
      "n": 1,
      "o": 74.06,
      "t": 1577941200000,
      "v": 135647456,
      "vw": 74.6099
    },
    {
      "c": 74.3575,
      "h": 75.145,
      "l": 74.125,
      "n": 1,
      "o": 74.2875,
      "t": 1578027600000,
      "v": 146535512,
      "vw": 74.7026
    }
  ],
  "resultsCount": 2,
  "status": "OK",
  "ticker": "AAPL"
}
```

Verified: spec, 2026-11-02, https://massive.com/docs/rest/stocks/aggregates/custom-bars (Sample Response). Complete sample, verbatim, re-indented. The sample answers a two-bar page (its cursor decodes to `limit=2&sort=asc`), not our `limit=50000`; `t` 1577941200000 is 2020-01-02 00:00 in New York.

Next page (Massive's `next_url`, requested as given):

```http
GET /v2/aggs/ticker/AAPL/range/1/day/1578114000000/2020-01-10?cursor=bGltaXQ9MiZzb3J0PWFzYw HTTP/1.1
Host: api.massive.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Authorization: Bearer <MASSIVE_API_KEY>
Accept-Encoding: gzip
```

Verified: spec, 2026-11-02, https://massive.com/docs/rest/stocks/aggregates/custom-bars (the sample's `next_url`).

### GET /stocks/v1/splits

Request (`adjustmentsSince` 2026-10-23, newest stored day 2026-10-30):

```http
GET /stocks/v1/splits?execution_date.gt=2026-10-23&execution_date.lte=2026-10-30&limit=5000 HTTP/1.1
Host: api.massive.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Authorization: Bearer <MASSIVE_API_KEY>
Accept-Encoding: gzip
```

Verified: spec, 2026-11-02, https://massive.com/docs/rest/stocks/corporate-actions/splits. Query as `createMassiveStockPriceSource` builds it.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: massive-splits -->
```json
{
  "request_id": 1,
  "results": [
    {
      "adjustment_type": "forward_split",
      "execution_date": "2005-02-28",
      "historical_adjustment_factor": 0.017857,
      "id": "E90a77bdf742661741ed7c8fc086415f0457c2816c45899d73aaa88bdc8ff6025",
      "split_from": 1,
      "split_to": 2,
      "ticker": "AAPL"
    }
  ],
  "status": "OK"
}
```

Verified: spec, 2026-11-02, https://massive.com/docs/rest/stocks/corporate-actions/splits (Sample Response). Complete sample, verbatim, re-indented; it is the reference's unfiltered sample (a 2005 split), not the answer to the request above, and its `request_id` is the number `1` where the attribute table says string (section 7).

### Error response

Plan refusal (a date the Basic plan does not cover):

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json
```

```json
{"status":"NOT_AUTHORIZED","request_id":"<redacted>","message":"Attempted to request today's data before end of day. Please upgrade your plan at https://polygon.io/pricing"}
```

Verified: unverified, 2026-11-02, Massive's reference pages publish no error body; shape and message as Polygon.io answered before the rename, from memory, not observed. A live request for today's date with the owner's `MASSIVE_API_KEY` would verify it. Our code reads only the status.

Unknown key:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{"status":"ERROR","request_id":"<redacted>","error":"Unknown API Key"}
```

Verified: unverified, 2026-11-02, Massive's reference pages publish no error body; Polygon.io's known shape, not observed. A live request with an invented key would verify it. Our code reads only the status.

## 6. Data Mapping

Contract types: `StockDayBar`, `StockHistoryBar`, `StockPriceDayResult`, `StockHistoryResult` in `packages/contracts/src/stockPrices.ts` (Rust: `crates/research-contracts/src/stock_prices.rs`); the completion entry is `stock-prices-synced`. The API Worker turns it into writes with `stockPricesEffects` (`packages/application/src/stockPrices.ts`) and `stockPriceStatements` (`packages/adapters/src/sql/stockPrices.ts`), which join every symbol to the market's `stock_directory` rows, so only directory stocks are stored.

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.results[].T` (grouped) | `massiveTickerToSymbol`: `BRK.B` → `BRK-B`, `KIMpL` / `ABRpD` → `KIM-PL` / `ABR-PD`, `DCOMp` → `DCOM-P`, `AAC.WS` → `AAC-WT`, `NE.WS.A` → `NE-WTA`, `AAC.U` → `AAC-UN`, `AIIAr` → `AIIA-RI`, `MSGKw` → `MSGK-WI`; plain `[A-Z0-9]+` unchanged (Nasdaq five-letter forms such as `BRKHU` too); anything else dropped. Symbol-sorted, unique (first wins), at most 15,000 | `StockDayBar[0]` | the series id `twelve-data:<symbol>` (`stockPriceSeriesId`; a legacy namespace, not the source) in [`market_observations.series_id`](../../database/tables/market_observations.md) and [`market_series.series_id`](../../database/tables/market_series.md) |
| (request `date`) grouped; `$.results[].t` range | Grouped: the requested date. Range: the America/New_York date of `t` (`newYorkDate`, US daylight-saving rules), kept within `[from, to]`, ascending, date-unique, newest 600 | `StockPriceDayResult.date`, `StockHistoryBar[0]` | [`market_observations.observed_on`](../../database/tables/market_observations.md); the day also in [`stock_price_day.trading_on`](../../database/tables/stock_price_day.md) |
| `$.results[].c` | JSON number, finite only; no rounding | `StockDayBar[1]`, `StockHistoryBar[1]` | [`market_observations.value`](../../database/tables/market_observations.md) (upserted only when changed) |
| `$.results[].o`, `.h`, `.l` | Finite numbers; the row is dropped unless `low ≤ open, close ≤ high` (`consistentBar`, `isConsistentBar`) | `[2][0..2]` (the bar) | [`market_observations`](../../database/tables/market_observations.md) `open_value`, `high_value`, `low_value` |
| `$.results[].v` | Finite and ≥ 0, else `null` | `[2][3]` | [`market_observations.volume`](../../database/tables/market_observations.md) |
| `$.results[].otc` | `true` → row dropped | — | Not stored |
| `$.results[].ticker` (splits) | `massiveTickerToSymbol`; requested stocks and duplicates skipped; at most `maxHistoriesPerJob` minus the requested windows refetched, the rest counted in `stock_prices_splits_over_cap` | Range refetch with reason `split` over `[windowStart, newest stored day]` | A stored history replaces the stock's rows in its window (rows the answer lacks are deleted) |
| (day answer) | `stored` (≥ 1 bar), `no-trading`, `not-yet-available`, `too-old` (section 4) | `StockPriceDayResult.outcome`, `.upstreamStatus` (a 403's status) | [`stock_price_day`](../../database/tables/stock_price_day.md) `outcome_code`, `bar_count`, `checked_at`, `retry_at` (now + 6 h for `not-yet-available`); the status is not stored |
| (history answer) | No bars or 404 → `not-found` | `StockHistoryResult.outcome` | [`market_series.unavailable_code`](../../database/tables/market_series.md) `SERIES_NOT_FOUND`, only when the stock has no series row yet |
| (constants) | `Massive`, `https://massive.com/` (an attribution link, never fetched), `USD`, `daily`, title `<symbol> (<listing>)` from the directory | `StockPricesEffects` | [`market_series`](../../database/tables/market_series.md) `publisher`, `source_url`, `unit`, `frequency`, `title`; `last_refreshed_at` and `retrieved_at` = the completion's `fetchedAt` (never moved back) |
| HTTP status of a failed job | Our code from section 4; the number unchanged | `failureCode`, `failureUpstreamStatus` | [`research_jobs.failure_code`](../../database/tables/research_jobs.md), [`research_jobs.failure_upstream_status`](../../database/tables/research_jobs.md) |

## 7. Maintenance

### Known differences between the runners

None intended: the Rust runner (`crates/research-finance/src/massive.rs`, `crates/research-finance/src/stock_prices.rs`) mirrors the TypeScript requests, ticker mapping, New York dates, bar checks, page caps and status mapping. Transport only, as for every provider: the Rust runner reuses pooled connections and may re-send a GET once; the TypeScript runner opens a fresh connection per request.

### Open issues

- Live verification waits for the owner's key (`MASSIVE_API_KEY`): every example is `spec` or `unverified`; no request has been sent to Massive.
- The two error bodies in section 5 are `unverified` (Polygon.io's shapes, not published by Massive); our code reads only the status.
- The exact statuses Massive answers on the Basic plan for a date before the day's end and for a date older than 2 years (assumed 403, both handled by the day-age rule), and whether a too-old range is refused (403) or trimmed (200), are not observed.
- The reference's samples are not exactly production: the grouped sample's `request_id` is an object and the splits sample's the number `1`, where the attribute tables say string. Our code reads neither; a live capture should replace both examples.
- The ticker forms Massive uses for rights (`AIIAr`) and when-issued lines (`MSGKw`), and whether the splits listing uses the same forms as the grouped answer, are from the consolidated-tape convention, not observed.
- The ADR's §2 names `GET /v3/reference/splits`; Massive marks it deprecated and the code calls `GET /stocks/v1/splits`.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-11-02 | spec | All three endpoints against Massive's reference pages and their Markdown forms (parameters, defaults, limits, response attributes, samples), Bearer authentication (REST Quickstart), Basic plan limits (pricing: 5 calls per minute; endpoint pages: end-of-day, 2 years). Section 5 samples parsed by `packages/adapters/test/finance/massiveDocExamples.test.ts`. | W1 / Claude (ADR-0058 documentation) |
