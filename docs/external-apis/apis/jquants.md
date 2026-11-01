# External API: J-Quants

## 1. Overview

| Property | Value |
|---|---|
| Provider | JPX Market Innovation & Research (J-Quants, the Japan Exchange Group's official market-data API), API V2 |
| Purpose | Daily bars — split-adjusted close, open, high, low and volume — of every TSE-listed stock in the owner's stock directory, for the Stocks page's Chart tab, the stock widgets on Home and in the Notebook and the chart viewer ([ADR-0058](../../adr/0058-every-stock-is-synced.md) §2). One request by date returns every listed issue's bar of that date (paginated); a request by code fills the history of a stock that has none, or that a split made inconsistent. On the Free plan the data ends about 12 weeks before today. |
| Hosts | `api.jquants.com` |
| Endpoints | `GET /v2/equities/bars/daily` — daily stock prices ("Stock Prices (OHLC)"), asked either by `date` (all issues of one date) or by `code` with `from` / `to` (one issue's window), paginated by `pagination_key` |
| Authentication | Header `x-api-key: <key>` (V2's only scheme; the key never enters a URL or a log line). It is the third and last entry of the fetcher's fixed header allowlist (`SafeFetchOptions.xApiKey`, beside `authorization` and the Finnhub token). Env variable `JQUANTS_API_KEY` in `apps/runner/.env`: 8–200 printable ASCII characters without spaces, checked at start; issued on the J-Quants dashboard's API Keys screen. Without it the runner logs `market_source_disabled` (reason `JQUANTS_API_KEY not set`) once and every JP `stock-prices-sync` job fails `SOURCE_NOT_CONFIGURED` without a request. |
| Configuration | In `apps/runner/.env` (`apps/runner/src/config.ts`, `crates/research-runner/src/config.rs`): `JQUANTS_REQUESTS_PER_MINUTE`, request starts per minute, integer 1–600, default 5 (the Free plan); `JQUANTS_DELAY_DAYS`, how many days the plan is behind, integer 0–365, default 84 (Free: 12 weeks; 0 on a paid plan). |
| Usage Limits | Free plan: 5 requests per minute per account, evaluated in a one-minute sliding window, a `429` counted too; "significantly" exceeding it may block all requests for about 5 minutes ([Rate Limits](https://jpx-jquants.com/en/spec/rate-limits)). Stock prices: "2 years History [12 weeks delayed]" on Free, 5 / 10 / 20 years on Light / Standard / Premium ([data storage by plan](https://jpx-jquants.com/en/spec/data-spec)); updated daily around 16:30 JST ([update timing](https://jpx-jquants.com/en/spec/data-update)). Ours: a window of `JQUANTS_REQUESTS_PER_MINUTE` request starts per 60 s under the pacer key `jquants`, one grant per request and per page; at most 10 dates and 10 requested windows per job (`STOCK_PRICE_LIMITS`), split refetches sharing that cap; at most 20 pages per query; no daily budget; no cache. |
| Called By | Rust runner (default) and TypeScript runner (rollback), `stock-prices-sync` jobs of market `JP` only, which the API queues at claim time (ADR-0058 §2 "Scheduling"). The API Worker and the browser never call J-Quants; `https://jpx-jquants.com/` is only stored as the attribution link (section 6). |
| Code | `crates/research-finance/src/jquants.rs`, `crates/research-finance/src/stock_prices.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-contracts/src/stock_prices.rs`, `crates/research-runner/src/config.rs`, `crates/research-net/src/core.rs`, `packages/adapters/src/finance/jquants.ts`, `packages/adapters/src/finance/stockPrices.ts`, `packages/adapters/src/finance/marketFetch.ts`, `packages/adapters/src/worker/safeFetchCore.ts`, `packages/adapters/src/node/pinnedConnect.ts`, `apps/runner/src/jobExecution.ts`, `apps/runner/src/main.ts`, `apps/runner/src/config.ts`, `apps/runner/src/marketPacing.ts`, `packages/contracts/src/stockPrices.ts`, `packages/application/src/stockPrices.ts`, `packages/adapters/src/sql/stockPrices.ts` |
| Official Documentation | [Stock Prices (OHLC) `/equities/bars/daily`](https://jpx-jquants.com/en/spec/eq-bars-daily), [Response Status](https://jpx-jquants.com/en/spec/response-status), [Rate Limits](https://jpx-jquants.com/en/spec/rate-limits), [APIs and Data Storage Period by Subscription](https://jpx-jquants.com/en/spec/data-spec), [Update Timing of Provided Data](https://jpx-jquants.com/en/spec/data-update), [Migration from V1 to V2](https://jpx-jquants.com/en/spec/migration-v1-v2), [Quickstart](https://jpx-jquants.com/en/spec/quickstart) |
| Last Verified | 2026-11-02, spec; no live call (no `JQUANTS_API_KEY` on this machine) (section 7) |

The API plans each JP job (`planStockPrices`, `packages/application/src/stockPrices.ts`): up to 10 due weekdays of the last 730 days (Asia/Tokyo dates), newest first; only when no day is due, up to 10 directory stocks with no stored price series, each over the whole window; and `adjustmentsSince`, the newest stored day before the job. The runner (`syncStockPrices`, `packages/adapters/src/finance/stockPrices.ts`) reports a day newer than today minus `JQUANTS_DELAY_DAYS` as `not-yet-available` without a request, asks every other day by `date` (all pages), maps each 5-character `Code` to the directory's 4-character code and reports the day's outcome; then fetches each requested stock's window by `code` (its end clamped to today minus the delay); then refetches the window of every code whose record of a stored day newer than `adjustmentsSince` has `AdjFactor ≠ 1` (reason `split`). The `stock-prices-synced` completion goes to the API, which stores the bars of directory stocks only, under each stock's existing price series id (section 6).

## 2. Input Parameters

The fetch core sets `Accept` and `User-Agent` on every hop, redirect hops included, and `x-api-key` on the first request only, never on a redirect hop (`packages/adapters/src/worker/safeFetchCore.ts`, `crates/research-net/src/core.rs`); the transport adds `Accept-Encoding: gzip` (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`). Every request and redirect is pinned to `api.jquants.com`. The query is built with `URLSearchParams` in the order shown; each page is a new request with `pagination_key` appended.

### GET /v2/equities/bars/daily

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `date` | query | string | Either `date` or `code` | — ; a day request sends one date of the claim | `YYYY-MM-DD` (J-Quants also accepts `YYYYMMDD`), an Asia/Tokyo weekday not newer than today minus `JQUANTS_DELAY_DAYS` | Every listed issue's prices of that date. Never sent with `code`. |
| `code` | query | string | Either `date` or `code` | — ; a window request sends the directory code with `0` appended (`symbolToJquantsCode`: `1380` → `13800`, `130A` → `130A0`) | 5 characters; a directory symbol that is not 4 characters `[0-9][0-9A-Z]{3}` is reported `not-found` without a request | One issue. The 5-character form names the common stock (a 4-character code also would). |
| `from` | query | string | No | J-Quants: all history; a window request sends the window's start (or, after a 403, 700 days before the window's end when that is inside the window, section 4) | `YYYY-MM-DD` | First day, inclusive. |
| `to` | query | string | No | J-Quants: all history; a window request sends the window's end, clamped to today minus `JQUANTS_DELAY_DAYS` | `YYYY-MM-DD` | Last day, inclusive. A window whose start is after its clamped end is not requested. |
| `pagination_key` | query | string | No | Not sent on the first page; then the previous page's `pagination_key`, as given | Opaque | Next page; followed until absent, `null` or empty, at most 20 pages per query (a 21st → `SOURCE_FAILED`). |
| `x-api-key` | header | string | Yes | — ; we send `<JQUANTS_API_KEY>` | Printable ASCII, ≤ 300 characters | The owner's key. |
| `Accept` | header | string | No | We send `application/json` | Printable ASCII | JSON answer. |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` | Printable ASCII | The runner's fixed identification (`DEFAULT_USER_AGENT`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | Encoded bytes count against the size cap. |

## 3. Output Parameters

### GET /v2/equities/bars/daily

`application/json`, one object: `data`, an array of one record per issue and business day, and `pagination_key` when more pages follow. Prices are JSON numbers in yen; the adjusted items are rounded to one decimal. Every key except the morning and afternoon items is always present, `null` on a day without trades (OHLC, `Vo`, `Va` and the adjusted items null together). The morning (`M*`) and afternoon (`A*`) items are Premium-only: on other plans, ours included, the keys are absent.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.data` | array | No | No | Yes | Records; an empty array when nothing matches ("no error", status 200, no `pagination_key`). Not an array → `SOURCE_FAILED`. |
| `$.data[].Date` | string | No | No | Yes | `YYYY-MM-DD`; not a real date → record dropped. A day request keeps only records of the asked date. |
| `$.data[].Code` | string | No | No | Yes | 5-character issue code (`86970`, `130A0`); one ending in `0` is the directory's 4-character code, any other (a preferred line) is dropped. A window request keeps only records of its code. |
| `$.data[].O`, `.H`, `.L`, `.C` | number | Yes | No | No | Unadjusted open, high, low, close. |
| `$.data[].UL`, `.LL` | string | No | No | No | Upper / lower price-limit flags, `"0"` or `"1"`. |
| `$.data[].Vo` | number | Yes | No | No | Unadjusted volume. |
| `$.data[].Va` | number | Yes | No | No | Trading value (yen). |
| `$.data[].AdjFactor` | number | No | No | Yes | Adjustment factor of that day (`0.5` on the ex-rights date of a 2-for-1 split, else `1`). A finite value ≠ 1 on a stored day newer than `adjustmentsSince` → the code is listed in the completion's `splitSymbols` and its window refetched within the history cap. |
| `$.data[].AdjO`, `.AdjH`, `.AdjL` | number | Yes | No | Yes | Adjusted open, high, low (recalculated retroactively after each corporate action); `null` → no bar. |
| `$.data[].AdjC` | number | Yes | No | Yes | Adjusted close, the stored value; `null` → no bar. |
| `$.data[].AdjVo` | number | Yes | No | Yes | Adjusted volume; `null` or negative → `null` in the bar. |
| `$.data[].MO` … `$.data[].MAdjVo` | number / string | Yes | Yes | No | Morning-session items (`MO MH ML MC MUL MLL MVo MVa MAdjO MAdjH MAdjL MAdjC MAdjVo`); Premium only. |
| `$.data[].AO` … `$.data[].AAdjVo` | number / string | Yes | Yes | No | Afternoon-session items (`AO AH AL AC AUL ALL AVo AVa AAdjO AAdjH AAdjL AAdjC AAdjVo`); Premium only. |
| `$.data[].MktCap` | number | Yes | No | No | Market capitalisation (million yen); scheduled for removal from this API. |
| `$.data[].ExRT` | string | Yes | No | No | Ex-rights type (`1` split, `2` reverse split, `3` rights issue), `null` on other days. |
| `$.pagination_key` | string | No | Yes | Yes | Present when more pages follow; sent back as the next request's `pagination_key`. |

## 4. Error Handling

### HTTP status codes

J-Quants signals errors by HTTP status; the body "may contain" a JSON object with a `message` ([Response Status](https://jpx-jquants.com/en/spec/response-status)). Our mapping is `jquantsProblem` (`packages/adapters/src/finance/jquants.ts`); the body is read (`includeErrorBody`) only for a 403, to tell a key problem from a plan refusal, and never logged, stored or shown. The status always travels unchanged as `failureUpstreamStatus` or a day's `upstreamStatus` ([error handling §4a](../../rule/error_handling.md), ADR-0037).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | Invalid or missing parameters | Fetching ends; what was obtained is reported; with nothing the job fails, retryable | `SOURCE_FAILED` |
| 401 | Not in J-Quants' list | Treated as a rejected key: the job fails at once | `SOURCE_AUTH_FAILED` |
| 403 whose `message` contains "api key" (any case) | "The incoming api key is invalid or expired." | The job fails at once, not retried | `SOURCE_AUTH_FAILED` |
| 403, any other | Data or endpoint outside the plan, or a wrong URL or method | Day request: a day at most `JQUANTS_DELAY_DAYS` + 3 days old is `not-yet-available`, more than `JQUANTS_DELAY_DAYS` + 365 days old `too-old`, otherwise the job fails. Window request: retried once from 700 days before the window's end when that is inside the window (the window reported is the one asked); still refused → the history is reported `unavailable` (no bars; the API backs it off) and the other windows go on. | — / `PLAN_NOT_ENTITLED` |
| 404 | Not in J-Quants' list | Window: the stock is `not-found` (stored as `SERIES_NOT_FOUND`). Day: ends the fetching like a source failure. | — / `SOURCE_FAILED` |
| 429 | Over the plan's requests per minute; no `Retry-After` | Fetching ends; what was obtained is reported; with nothing the job fails, not retried at once. The runner holds `jquants` in its pacer for 120 s after the 429 (in process, both runners), so no request of the next job starts before the about 2 minutes J-Quants asks for. | `RATE_LIMITED` |
| 500, any other | Server error | Like 400; a window request that fails this way is reported `unavailable` before the fetching ends | `SOURCE_FAILED` |
| 200 with an unexpected shape | — (also a `210 No Content (Partial)` without a `data` array, which J-Quants documents for some other APIs) | Like a source failure, no status | `SOURCE_FAILED` |
| — | Timeout, network error, body over the cap, redirect off `api.jquants.com`, more than 20 pages | Like a source failure, no status | `SOURCE_FAILED` |

**Day outcomes** (ADR-0058 §2): a day newer than today minus `JQUANTS_DELAY_DAYS` is `not-yet-available` without a request; a date answer with at least one usable bar is `stored`; an empty one is `no-trading` once the day is more than the delay + 3 days old, else `not-yet-available`. A day is reported only when every page was read. A completion the contract would refuse fails the job as `SOURCE_FAILED` (not retryable) and logs `stock_prices_rejected`.

### Provider error codes and body

`{"message": "<text>"}`, "not guaranteed to always be included". No error codes besides the HTTP status. The 403 causes listed by J-Quants: the invalid-or-expired key message, a plan that does not include the data, and an incorrect URL or HTTP method.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s per request (connection, redirects, body); body cap 8,000,000 bytes per page (also for an error body); at most 5 redirects, each on `api.jquants.com`, without `x-api-key`. | `packages/adapters/src/finance/jquants.ts`, `crates/research-finance/src/jquants.rs` |
| Retries | None per request, except the one window retry after a 403. Transport only: up to 3 resolved addresses per request; the Rust runner re-sends a GET once when a pooled connection closed before answering. An unanswered day is asked by a later job (`planSyncDays`). | `packages/adapters/src/finance/stockPrices.ts`, `crates/research-net/src/pinned.rs` |
| Rate limit | No header read (J-Quants sends no `Retry-After`). A window of `JQUANTS_REQUESTS_PER_MINUTE` (default 5) starts per 65 s under the pacer key `jquants` (J-Quants counts arrivals per minute, we count starts; pooled connections arrive faster than they start, so the window is 5 s longer than J-Quants'), shared across jobs for the runner's lifetime; every page counts; after a `429` the key is held 120 s. Requests are sequential. A 429 ends the job's fetching. | `apps/runner/src/marketPacing.ts`, `apps/runner/src/main.ts`, `crates/research-finance/src/pacing.rs` |
| Cache | None. | `packages/adapters/src/finance/jquants.ts` |
| Fallback | Stored bars stay; the Stocks page says a Japanese stock's prices come from J-Quants Free and end about 12 weeks ago (ADR-0058 §6). | `packages/application/src/stockPrices.ts` |

## 5. Examples

### GET /v2/equities/bars/daily

Day request (all issues of the reference sample's date):

```http
GET /v2/equities/bars/daily?date=2023-03-24 HTTP/1.1
Host: api.jquants.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
x-api-key: <JQUANTS_API_KEY>
Accept-Encoding: gzip
```

Verified: spec, 2026-11-02, https://jpx-jquants.com/en/spec/eq-bars-daily. Query as `createJquantsStockPriceSource` builds it.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: jquants-bars-daily -->
```json
{
    "data": [
        {
            "Date": "2023-03-24",
            "Code": "86970",
            "O": 2047.0,
            "H": 2069.0,
            "L": 2035.0,
            "C": 2045.0,
            "UL": "0",
            "LL": "0",
            "Vo": 2202500.0,
            "Va": 4507051850.0,
            "AdjFactor": 1.0,
            "AdjO": 2047.0,
            "AdjH": 2069.0,
            "AdjL": 2035.0,
            "AdjC": 2045.0,
            "AdjVo": 2202500.0,
            "MO": 2047.0,
            "MH": 2069.0,
            "ML": 2040.0,
            "MC": 2045.5,
            "MUL": "0",
            "MLL": "0",
            "MVo": 1121200.0,
            "MVa": 2297525850.0,
            "MAdjO": 2047.0,
            "MAdjH": 2069.0,
            "MAdjL": 2040.0,
            "MAdjC": 2045.5,
            "MAdjVo": 1121200.0,
            "AO": 2047.0,
            "AH": 2047.0,
            "AL": 2035.0,
            "AC": 2045.0,
            "AUL": "0",
            "ALL": "0",
            "AVo": 1081300.0,
            "AVa": 2209526000.0,
            "AAdjO": 2047.0,
            "AAdjH": 2047.0,
            "AAdjL": 2035.0,
            "AAdjC": 2045.0,
            "AAdjVo": 1081300.0,
            "MktCap": 1083850.0,
            "ExRT": null
        }
    ],
    "pagination_key": "value1.value2."
}
```

Verified: spec, 2026-11-02, https://jpx-jquants.com/en/spec/eq-bars-daily (Response Sample "200:OK"). Complete sample, verbatim. It is a Premium answer: on our Free plan the `M*` and `A*` keys are absent (same page). Status line and `Content-Type` are not on the page.

Next page (the previous page's `pagination_key` appended):

```http
GET /v2/equities/bars/daily?date=2023-03-24&pagination_key=value1.value2. HTTP/1.1
Host: api.jquants.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
x-api-key: <JQUANTS_API_KEY>
Accept-Encoding: gzip
```

Verified: spec, 2026-11-02, https://jpx-jquants.com/en/spec/eq-bars-daily (`pagination_key` parameter and the sample's value).

Window request (one issue, `8697` in the directory):

```http
GET /v2/equities/bars/daily?code=86970&from=2023-03-01&to=2023-03-31 HTTP/1.1
Host: api.jquants.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
x-api-key: <JQUANTS_API_KEY>
Accept-Encoding: gzip
```

Verified: spec, 2026-11-02, https://jpx-jquants.com/en/spec/eq-bars-daily (combination "code ✓, from / to ✓"). Query as `createJquantsStockPriceSource` builds it; the answer has the shape above.

No matching data (a date without trading, or the last answer of a query):

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: jquants-no-data -->
```json
{
  "data": []
}
```

Verified: spec, 2026-11-02, https://jpx-jquants.com/en/spec/response-status ("When No Matching Data Exists"). Complete sample, verbatim.

### Error response

Missing parameters (neither `date` nor `code`):

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

<!-- example: jquants-error-missing-parameter -->
```json
{
  "message": "This API requires at least 1 parameter as follows; date, code"
}
```

Verified: spec, 2026-11-02, https://jpx-jquants.com/en/spec/response-status ("Example Error Message"). Complete sample, verbatim; the page gives the body without its status, which follows from the 400 description ("required parameters are missing").

Invalid or expired key:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json
```

<!-- example: jquants-error-invalid-key -->
```json
{
  "message": "The incoming api key is invalid or expired."
}
```

Verified: spec, 2026-11-02, https://jpx-jquants.com/en/spec/response-status ("Causes of 403 Forbidden": the message, verbatim; the body shape from "Example Error Message"). Not observed live.

## 6. Data Mapping

Contract types: `StockDayBar`, `StockHistoryBar`, `StockPriceDayResult`, `StockHistoryResult` in `packages/contracts/src/stockPrices.ts` (Rust: `crates/research-contracts/src/stock_prices.rs`); the completion entry is `stock-prices-synced`. The API Worker turns it into writes with `stockPricesEffects` (`packages/application/src/stockPrices.ts`) and `stockPriceStatements` (`packages/adapters/src/sql/stockPrices.ts`), which join every symbol to the market's `stock_directory` rows, so only directory stocks are stored.

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.data[].Code` | `jquantsCodeToSymbol`: 5 characters `[0-9][0-9A-Z]{3}0` → the first 4 (`86970` → `8697`, `130A0` → `130A`); anything else dropped. Day bars symbol-sorted, unique (first wins), at most 15,000 | `StockDayBar[0]` | the series id `twelve-data:<code>:JPX` (`stockPriceSeriesId`; a legacy namespace, not the source) in [`market_observations.series_id`](../../database/tables/market_observations.md) and [`market_series.series_id`](../../database/tables/market_series.md) |
| `$.data[].Date` | Kept as given when a real `YYYY-MM-DD` date (an Asia/Tokyo trading date); a day request keeps only the asked date; window bars within `[from, to]`, ascending, date-unique, newest 600 | `StockPriceDayResult.date`, `StockHistoryBar[0]` | [`market_observations.observed_on`](../../database/tables/market_observations.md); the day also in [`stock_price_day.trading_on`](../../database/tables/stock_price_day.md) |
| `$.data[].AdjC` | JSON number, finite only; no rounding beyond J-Quants' one decimal. `null` → no bar | `StockDayBar[1]`, `StockHistoryBar[1]` | [`market_observations.value`](../../database/tables/market_observations.md) (upserted only when changed) |
| `$.data[].AdjO`, `.AdjH`, `.AdjL` | Finite numbers; the record gives no bar unless `low ≤ open, close ≤ high` (`consistentBar`) | `[2][0..2]` (the bar) | [`market_observations`](../../database/tables/market_observations.md) `open_value`, `high_value`, `low_value` |
| `$.data[].AdjVo` | Finite and ≥ 0, else `null` | `[2][3]` | [`market_observations.volume`](../../database/tables/market_observations.md) |
| `$.data[].AdjFactor` | Read before the prices: a record without trades (null prices) still counts. Finite and ≠ 1 on a read day newer than `adjustmentsSince` → the code (as its directory symbol) is a split: de-duplicated, sorted, at most `maxSplitSymbols` (1,000), reported even when a rate limit or failure ended the walk; when the walk did not end early, the window `[windowStart, today − JQUANTS_DELAY_DAYS]` of each not-requested split is refetched (reason `split`), at most `maxHistoriesPerJob` minus the requested windows, the rest counted in `stock_prices_splits_over_cap` | Every one in the completion's `splitSymbols` (refetched or not); a refetch is a `StockHistoryResult` with reason `split`. `splitCheckedThrough` = the newest stored day when every claimed day after `adjustmentsSince` (up to it) was read and the claim was not a full 10 days all after `adjustmentsSince`; else `null` | The API keeps the split stocks it still owes a refetch and asks for them in later jobs, and keeps `splitCheckedThrough` per market as the next claim's `adjustmentsSince`; a stored history replaces the stock's rows in its reported window (rows the answer lacks are deleted) |
| (day answer) | `stored` (≥ 1 bar), `no-trading`, `not-yet-available`, `too-old` (section 4) | `StockPriceDayResult.outcome`, `.upstreamStatus` (a 403's status) | [`stock_price_day`](../../database/tables/stock_price_day.md) `outcome_code`, `bar_count`, `checked_at`, `retry_at` (now + 6 h for `not-yet-available`); the status is not stored |
| (window answer) | No bars or 404 → `not-found`; a window still refused after its retry, or failed by the source → `unavailable` (no bars) | `StockHistoryResult.outcome` | [`market_series.unavailable_code`](../../database/tables/market_series.md) `SERIES_NOT_FOUND`, only when the stock has no series row yet |
| (constants) | `J-Quants`, `https://jpx-jquants.com/` (an attribution link, never fetched), `JPY`, `daily`, title `<code> (JPX)` | `StockPricesEffects` | [`market_series`](../../database/tables/market_series.md) `publisher`, `source_url`, `unit`, `frequency`, `title`; `last_refreshed_at` and `retrieved_at` = the completion's `fetchedAt` (never moved back) |
| HTTP status of a failed job | Our code from section 4; the number unchanged | `failureCode`, `failureUpstreamStatus` | [`research_jobs.failure_code`](../../database/tables/research_jobs.md), [`research_jobs.failure_upstream_status`](../../database/tables/research_jobs.md) |

The unadjusted items (`O H L C Vo`) are not stored: the adjusted series keeps a stock's chart continuous across splits, and a later split rewrites the stored window.

## 7. Maintenance

### Known differences between the runners

None intended: the Rust runner (`crates/research-finance/src/jquants.rs`, `crates/research-finance/src/stock_prices.rs`) mirrors the TypeScript query order, code mapping, Tokyo dates, delay rule, bar checks, page cap and status mapping, including the case-insensitive "api key" test on a 403 body. Transport only, as for every provider: the Rust runner reuses pooled connections and may re-send a GET once; the TypeScript runner opens a fresh connection per request.

### Open issues

- Live verification waits for the owner's key (`JQUANTS_API_KEY`): every example is `spec`; no request has been sent to J-Quants.
- The answer of the Free plan for a date or window outside its storage period (12 weeks to 2 years 12 weeks ago) is not observed: a 403 (handled by the day-age rule) or an empty `data` (a day more than the delay + 3 days old would then be recorded `no-trading`, not `too-old`; both are final).
- The Free plan's exact delay: J-Quants says "12 weeks delayed"; `JQUANTS_DELAY_DAYS` 84 assumes calendar days counted from today in Tokyo. A day just inside the edge may be answered empty and retried as `not-yet-available` until it settles.
- The 403 split between a key problem and a plan refusal relies on the documented message text containing "api key"; a 403 without a body is treated as a plan refusal.
- J-Quants documents status 210 (No Content (Partial)) for some other APIs; if this endpoint ever sends it without a `data` array, the job fails `SOURCE_FAILED`.
- J-Quants recommends its bulk file download for daily bars of thousands of issues; the date query (one request per day, paginated) stays within the documented API use.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-11-02 | spec | `GET /v2/equities/bars/daily` against the Stock Prices (OHLC) reference (parameters, `x-api-key`, combinations, data items, null and Premium-only rules, sample), Response Status (codes, 403 causes, empty answer, error body), Rate Limits (Free 5 per minute, sliding window, no `Retry-After`), data storage by plan (Free: 2 years, 12 weeks delayed), update timing (16:30) and the V1-to-V2 migration (endpoint, header). Section 5 bodies parsed by `packages/adapters/test/finance/jquantsDocExamples.test.ts`. | W1 / Claude (ADR-0058 documentation) |
