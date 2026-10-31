# External API: Twelve Data

## 1. Overview

| Property | Value |
|---|---|
| Provider | Twelve Data |
| Purpose | Daily closes of stocks, currency pairs and precious metals (`twelve-data:AAPL`, `twelve-data:USD/JPY`, `twelve-data:XAU/USD`) for the Home and Notebook series, table and chart widgets and the Watchlist prices widget (FR-017, [ADR-0014](../../adr/0014-market-data-sources.md), [ADR-0040](../../adr/0040-watchlist-lists-and-prices-widget.md)), refreshed incrementally ([ADR-0044](../../adr/0044-indicator-charts-and-incremental-history.md)). |
| Hosts | `api.twelvedata.com` |
| Endpoints | `GET /time_series` — daily OHLC(V) bars of one symbol |
| Authentication | Header `Authorization: apikey <key>` (Twelve Data's recommended method; the key never enters the URL); env variable `TWELVE_DATA_API_KEY` in `apps/runner/.env`. Without it the runner logs `market_source_disabled` once and every Twelve Data series is `SOURCE_NOT_CONFIGURED`. |
| Configuration | In `apps/runner/.env` (`apps/runner/src/config.ts`, `crates/research-runner/src/config.rs`): `TWELVE_DATA_REQUESTS_PER_MINUTE`, request starts per minute, integer 1–600, default 8; `TWELVE_DATA_DAILY_LIMIT`, request starts per UTC day, integer 0–1,000,000, default 800 (the Basic plan), 0 for a paid plan (no daily limit). |
| Usage Limits | Basic (free) plan: 8 API credits per minute, 800 per day ([pricing](https://twelvedata.com/pricing)); `/time_series` costs 1 credit per symbol. The [terms](https://twelvedata.com/terms) allow internal use only (ADR-0014). Ours: a sliding window of `TWELVE_DATA_REQUESTS_PER_MINUTE` starts per 60 s under the pacer key `twelve-data`, 1 grant per request; a daily budget of `TWELVE_DATA_DAILY_LIMIT` starts per UTC day (default 800, the Basic plan; 0 for a paid plan, which has no daily limit); at most 60 tracked series per job; no cache. Twelve Data's daily quota "resets to 800 at midnight UTC (00:00:00)" and "paid plans have no daily limits" ([Credits](https://support.twelvedata.com/en/articles/5615854-credits)). |
| Called By | Rust runner (default) and TypeScript runner (rollback), `market-refresh` jobs only (queued by `POST /home/refresh`, scope `all` or `unrefreshed`, and by the Home / Notebook staleness re-check). |
| Code | `crates/research-finance/src/twelve_data.rs`, `crates/research-finance/src/market_fetch.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-finance/src/jobs.rs`, `packages/adapters/src/finance/twelveDataSeries.ts`, `packages/adapters/src/finance/marketFetch.ts`, `apps/runner/src/marketPacing.ts`, `apps/runner/src/jobExecution.ts`, `packages/adapters/src/sql/unitOfWork.ts` |
| Official Documentation | [API reference: Authentication, Errors, Time series](https://twelvedata.com/docs), [pricing and plan limits](https://twelvedata.com/pricing) |
| Last Verified | 2026-10-31, live (section 7) |

For each claimed Twelve Data series (`twelve-data:<symbol>[:<exchange>]`) a `market-refresh` job waits for 1 pacer grant (refused at once, without sending, when the day's budget is spent) and asks `GET /time_series` for daily bars — from the stored anchor's date when the claim carries one (a window), otherwise the newest 800. When a window does not reproduce the anchor, a second paced request asks for the newest 800 in the same job (ADR-0044). The daily closes and a title and unit derived from `meta` go into the `market-refreshed` completion, which the API Worker stores in `market_series` and `market_observations`; a failure stores only its code and Twelve Data's status. `https://twelvedata.com/` is never requested: it is stored as the attribution link (section 6).

## 2. Input Parameters

The fetch core sets `Accept` and `User-Agent` on every hop, redirect hops included, and `Authorization` on the first request only (`packages/adapters/src/worker/safeFetchCore.ts`, `crates/research-net/src/core.rs`); the transport adds `Accept-Encoding: gzip` to every request it sends (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`). A redirect hop must stay on `api.twelvedata.com`.

### GET /time_series

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `symbol` | query | string | Yes | — ; we send the symbol without its `:<exchange>` suffix | Ticker (`AAPL`), or a pair `BASE/QUOTE` (`USD/JPY`, `XAU/USD`; `/` is sent as `%2F`) | The instrument. |
| `exchange` | query | string | No | Twelve Data: none; we send it only when the series id has a non-empty `:<exchange>` suffix | Exchange name, e.g. `JPX`, `NASDAQ` | Narrows the instrument to one venue (`twelve-data:7203:JPX`). |
| `interval` | query | string | Yes | — ; we send `1day` | `1min` … `1month` | One bar per day. |
| `outputsize` | query | integer | No | Twelve Data: 30 without date parameters, the maximum with them; we send `800` (`MARKET_LIMITS.maxObservationsPerResponse`) | 1–5000 | Most bars returned (the newest). |
| `start_date` | query | string | No | Twelve Data: none; we send it only for a window fetch | `YYYY-MM-DD` (Twelve Data also accepts a time); sent only when it is a real calendar date | The stored anchor's date (the 32nd newest stored observation), inclusive (observed) and without extra overlap (ADR-0044). Interpreted in the exchange's time zone for stocks, UTC for forex. |
| `Authorization` | header | string | Yes | — ; we send `apikey <TWELVE_DATA_API_KEY>` | Printable ASCII, ≤ 300 characters | The owner's key. Sent on the first request only, never on a redirect hop. |
| `Accept` | header | string | No | We send `application/json` | Printable ASCII | JSON is the default `format`. |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` | Printable ASCII | The runner's fixed identification (`DEFAULT_USER_AGENT`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | Twelve Data answers gzip; encoded bytes are counted against the size cap. |

## 3. Output Parameters

### GET /time_series

`application/json; charset=utf-8`, one object. The `meta` fields differ by instrument type: stocks carry `currency` and `exchange`; currency pairs and metals carry `currency_base` and `currency_quote` instead. All prices are decimal strings.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.meta` | object | No | No | Yes | Request and instrument information; absent → `SOURCE_FAILED`. |
| `$.meta.symbol` | string | No | No | Yes | Symbol as Twelve Data names it; empty → `SOURCE_FAILED`. |
| `$.meta.interval` | string | No | No | No | `1day`. |
| `$.meta.currency` | string | No | Yes | Yes | Trading currency (stocks); absent for pairs and metals. A non-string value → `SOURCE_FAILED`. |
| `$.meta.exchange_timezone` | string | No | Yes | No | Exchange time zone (stocks). |
| `$.meta.exchange` | string | No | Yes | Yes | Exchange name (stocks). A non-string value → `SOURCE_FAILED`. |
| `$.meta.mic_code` | string | No | Yes | No | ISO 10383 MIC (stocks). |
| `$.meta.currency_base` | string | No | Yes | No | Base currency or metal name, e.g. `Gold Spot` (pairs and metals). |
| `$.meta.currency_quote` | string | No | Yes | No | Quote currency name, e.g. `US Dollar` (pairs and metals). |
| `$.meta.type` | string | No | No | No | Asset class, e.g. `Common Stock`, `Physical Currency`, `Precious Metal`. |
| `$.values` | array | No | No | Yes | Bars, newest first. Empty → `NO_DATA`; an element whose `datetime` or `close` is not a string → `SOURCE_FAILED`. |
| `$.values[].datetime` | string | No | No | Yes | Bar date, `YYYY-MM-DD` for `1day` (local exchange time); only the first 10 characters are used. Metals and pairs have weekend bars. |
| `$.values[].open` | string | No | No | No | Opening price. |
| `$.values[].high` | string | No | No | No | High. |
| `$.values[].low` | string | No | No | No | Low. |
| `$.values[].close` | string | No | No | Yes | Closing price, the stored value. |
| `$.values[].volume` | string | No | Yes | No | Volume, "for applicable instruments" (stocks; absent for pairs and metals). |
| `$.status` | string | No | No | No | `ok`. |

Response headers `Api-Credits-Used`, `Api-Credits-Left` and `Api-Credits-Request` (observed, not documented in the reference) are not read.

## 4. Error Handling

### HTTP status codes

Twelve Data's error codes mirror HTTP statuses, and live answers carry the matching HTTP status (401 and 404 observed). Our code maps the HTTP status of a non-2xx answer without reading its body; it maps the JSON `code` of a 2xx answer whose body is an error object (`{code, message, status: "error"}`), since the error format is the same on any status. Either number travels unchanged as `upstreamStatus` when it is 100–599 ([error handling §4a](../../rule/error_handling.md)); the message is never read.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | Invalid or incorrect parameter | Fails the series; Twelve Data's status kept | `SOURCE_FAILED` |
| 401 | Invalid or missing API key (also the `demo` key) | Fails the series | `SOURCE_AUTH_FAILED` |
| 403 | Plan lacks the resource | Fails the series | `PLAN_NOT_ENTITLED` |
| 404 | Data not found (e.g. `7203` on `JPX` with the Basic plan) | Fails the series | `SERIES_NOT_FOUND` |
| 429 | Per-minute or daily credits used up | Fails the series; no pause beyond the pacer | `RATE_LIMITED` |
| — (our budget) | Our own count of the UTC day's requests reached `TWELVE_DATA_DAILY_LIMIT` | Fails the series without sending; no `upstreamStatus` (Twelve Data answered nothing, §4a) | `RATE_LIMITED` |
| 414, 500, any other | Parameter array too long, server error | Fails the series | `SOURCE_FAILED` |
| 200 with an unexpected shape, unusable `meta`, or no readable bar | — | Fails the series, no status | `SOURCE_FAILED` or `NO_DATA` |
| — | Timeout, network error, body over 1,000,000 bytes, redirect off `api.twelvedata.com` | Fails the series, no status | `SOURCE_FAILED` |

### Provider error codes and body

`{"code": <number>, "message": "<text>", "status": "error"}`, sometimes with a `meta` object echoing the request (observed on 404). Codes: 400, 401, 403, 404, 414, 429, 500 ([Errors](https://twelvedata.com/docs)). A body is treated as an error only when `code` is a finite number, `message` a string and `status` the string `error`.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s for the whole request (connection, redirects, body), no separate connect timeout; body cap 1,000,000 bytes (encoded and decoded); at most 5 redirects, each on `api.twelvedata.com`, without the `Authorization` header. | `packages/adapters/src/finance/twelveDataSeries.ts`, `crates/research-finance/src/market_fetch.rs`, `crates/research-net/src/core.rs` |
| Retries | None per request. Transport only: both runners try up to 3 validated resolved addresses in turn when a connection cannot be made (`MAX_CONNECT_ATTEMPTS`); the Rust runner also re-sends a GET once on a fresh connection when an idle pooled connection turns out closed before answering. The TypeScript runner opens a fresh connection per request, so it has no such resend. A failed series is retried by the next refresh. | `packages/adapters/src/node/index.ts`, `crates/research-net/src/transport.rs`, `crates/research-net/src/pinned.rs` |
| Rate limit | No response header is read. Sliding window of `TWELVE_DATA_REQUESTS_PER_MINUTE` (default 8) starts per 60 s, shared across jobs for the runner's lifetime; a request that does not fit waits. Daily budget (`TWELVE_DATA_DAILY_LIMIT`, default 800, 0 = none; `marketDailyBudgets` / `market_daily_budgets`): that many request starts per UTC day, counted from 00:00 UTC; when spent, each further series fails at once as `RATE_LIMITED` with no upstream status, without being sent or waiting, until the UTC date changes. The count is in memory only: a runner restart starts it at 0, and requests made with the same key elsewhere are not seen, so Twelve Data may still answer 429 first. A 429 fails only that series. | `apps/runner/src/marketPacing.ts`, `apps/runner/src/main.ts`, `crates/research-finance/src/pacing.rs`, `crates/research-runner/src/composition.rs` |
| Cache | None. | `packages/adapters/src/finance/twelveDataSeries.ts` |
| Fallback | A failed series keeps its stored metadata and observations; Home and the Notebook show them with the code's fixed reason (`MARKET_UNAVAILABLE_REASONS`). A new series that fails gets a placeholder row (title = symbol). | `packages/contracts/src/market.ts`, `packages/adapters/src/sql/unitOfWork.ts` |

## 5. Examples

### GET /time_series

Full request (no anchor, or the weekly full check):

```http
GET /time_series?symbol=AAPL&interval=1day&outputsize=800 HTTP/1.1
Host: api.twelvedata.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Authorization: apikey <TWELVE_DATA_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Api-Credits-Left: 7
Api-Credits-Request: 1
Api-Credits-Used: 1
Content-Encoding: gzip
```

<!-- example: twelve-data-time-series-aapl-full -->
```json
{
  "meta": {
    "symbol": "AAPL",
    "interval": "1day",
    "currency": "USD",
    "exchange_timezone": "America/New_York",
    "exchange": "NASDAQ",
    "mic_code": "XNGS",
    "type": "Common Stock"
  },
  "values": [
    {
      "datetime": "2026-10-30",
      "open": "348.32501",
      "high": "349.19000",
      "low": "334.35001",
      "close": "344.79001",
      "volume": "67797500"
    },
    {
      "datetime": "2026-10-29",
      "open": "348",
      "high": "351.42999",
      "low": "347.29999",
      "close": "348.91000",
      "volume": "42582100"
    },
    {
      "datetime": "2023-08-24",
      "open": "180.67000",
      "high": "181.10001",
      "low": "176.0099945",
      "close": "176.38000",
      "volume": "54945800"
    }
  ],
  "status": "ok"
}
```

Verified: live, 2026-10-31, curl with the runner's headers. Captured over HTTP/1.1 and HTTP/2 with identical bodies; status line and headers from the HTTP/1.1 capture, other headers omitted. 3 of 800 bars kept (the two newest and the oldest); pretty-printed.

Window request (the claim's anchor is 2026-10-26):

```http
GET /time_series?symbol=AAPL&interval=1day&outputsize=800&start_date=2026-10-26 HTTP/1.1
Host: api.twelvedata.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Authorization: apikey <TWELVE_DATA_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Api-Credits-Left: 7
Api-Credits-Request: 1
Api-Credits-Used: 1
Content-Encoding: gzip
```

<!-- example: twelve-data-time-series-aapl-window -->
```json
{
  "meta": {
    "symbol": "AAPL",
    "interval": "1day",
    "currency": "USD",
    "exchange_timezone": "America/New_York",
    "exchange": "NASDAQ",
    "mic_code": "XNGS",
    "type": "Common Stock"
  },
  "values": [
    {
      "datetime": "2026-10-30",
      "open": "348.32501",
      "high": "349.19000",
      "low": "334.35001",
      "close": "344.79001",
      "volume": "67797500"
    },
    {
      "datetime": "2026-10-29",
      "open": "348",
      "high": "351.42999",
      "low": "347.29999",
      "close": "348.91000",
      "volume": "42582100"
    },
    {
      "datetime": "2026-10-28",
      "open": "346.92001",
      "high": "347.17999",
      "low": "343.51999",
      "close": "343.82999",
      "volume": "35714300"
    },
    {
      "datetime": "2026-10-27",
      "open": "343.17001",
      "high": "347.78000",
      "low": "342.39001",
      "close": "347.10001",
      "volume": "39984400"
    },
    {
      "datetime": "2026-10-26",
      "open": "343.92001",
      "high": "347.089996",
      "low": "341.029999",
      "close": "343.91000",
      "volume": "42743600"
    }
  ],
  "status": "ok"
}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1 and HTTP/2, identical bodies; status line and headers from the HTTP/1.1 capture, other headers omitted. Complete body, pretty-printed.

Metal window request (`twelve-data:XAU/USD`, anchor 2026-10-27):

```http
GET /time_series?symbol=XAU%2FUSD&interval=1day&outputsize=800&start_date=2026-10-27 HTTP/1.1
Host: api.twelvedata.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Authorization: apikey <TWELVE_DATA_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/2 200
content-type: application/json; charset=utf-8
api-credits-left: 5
api-credits-request: 1
api-credits-used: 3
```

<!-- example: twelve-data-time-series-xauusd-window -->
```json
{
  "meta": {
    "symbol": "XAU/USD",
    "interval": "1day",
    "currency_base": "Gold Spot",
    "currency_quote": "US Dollar",
    "type": "Precious Metal"
  },
  "values": [
    {
      "datetime": "2026-10-31",
      "open": "3882.74902",
      "high": "3887.26919",
      "low": "3872.06691",
      "close": "3875.39858"
    },
    {
      "datetime": "2026-10-30",
      "open": "4022.29768",
      "high": "4030.79528",
      "low": "3871.18522",
      "close": "3883.58851"
    },
    {
      "datetime": "2026-10-29",
      "open": "4068.98744",
      "high": "4081.96587",
      "low": "4006.15472",
      "close": "4022.11919"
    },
    {
      "datetime": "2026-10-28",
      "open": "4061.9842",
      "high": "4070.81167",
      "low": "4028.01402",
      "close": "4070.20751"
    },
    {
      "datetime": "2026-10-27",
      "open": "4013.56827",
      "high": "4065.53645",
      "low": "3988.99039",
      "close": "4062.2879"
    }
  ],
  "status": "ok"
}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/2 (curl also reported `x-content-encoding-over-network: gzip`). Status line and headers as captured, other headers omitted; a later HTTP/1.1 capture differed in the still-open 2026-10-31 bar, so this one is kept. Complete body, pretty-printed; 2026-10-31 is a Saturday bar.

### Error response

Japanese listing on the Basic plan (`twelve-data:7203:JPX`, request `GET /time_series?symbol=7203&exchange=JPX&interval=1day&outputsize=800`):

```http
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Api-Credits-Left: 5
Api-Credits-Request: 1
Api-Credits-Used: 3
Content-Encoding: gzip
```

<!-- example: twelve-data-error-not-found -->
```json
{"code":404,"message":"Data not found","status":"error","meta":{"symbol":"7203","interval":"1day","exchange":"JPX"}}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1 (identical body over HTTP/2). Status line and headers as captured, other headers omitted; complete body, verbatim; identical to `packages/adapters/test/finance/fixtures/twelvedata-key-symbol_7203_exchange_JPX.json`.

Invalid key:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Content-Length: 291
```

<!-- example: twelve-data-error-bad-key -->
```json
{"code":401,"message":"**apikey** parameter is incorrect or not specified. You can get your free API key instantly following this link: https://twelvedata.com/pricing. If you believe that everything is correct, you can contact us at https://twelvedata.com/contact/customer","status":"error"}
```

Verified: live, 2026-10-31, curl `GET /time_series?symbol=AAPL&interval=1day&outputsize=800` with `Authorization: apikey` and an invented 32-character key, over HTTP/1.1 (identical body over HTTP/2). Status line and headers as captured, other headers omitted; complete body, verbatim; identical to `packages/adapters/test/finance/fixtures/twelvedata-error-badkey.json`.

## 6. Data Mapping

Rust types: `MarketSeriesMeta`, `MarketUnavailableCode` in `crates/research-contracts/src/market.rs`. The completion entry is `market-refreshed` in `packages/contracts/src/jobs.ts`; the API Worker stores it with `marketStatements` in `packages/adapters/src/sql/unitOfWork.ts`.

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.meta.symbol`, `$.meta.exchange`, `$.meta.currency` | With a non-blank `currency` (stocks): `<symbol> (<exchange trimmed>)`, or `<symbol>` when the exchange is blank or absent. Otherwise (pairs, metals): `<symbol>`. Must be 1–200 characters | `MarketSeriesMeta.title` (`packages/contracts/src/market.ts`) | [`market_series.title`](../../database/tables/market_series.md) |
| `$.meta.currency`, `$.meta.symbol` | Stocks: the currency trimmed (`USD`). Pairs and metals: `<QUOTE> per <BASE>` from the symbol's two halves, `XAU` read as `XAU (troy ounce of gold)` and `XAG` as `XAG (troy ounce of silver)` (`USD per XAU (troy ounce of gold)`, `JPY per USD`). No currency and no `/` → `SOURCE_FAILED`. Must be 1–80 characters | `MarketSeriesMeta.unit` | [`market_series.unit`](../../database/tables/market_series.md) |
| (constant) | `daily` (we always ask `interval=1day`) | `MarketSeriesMeta.frequency` | [`market_series.frequency`](../../database/tables/market_series.md) |
| (constant) | `Twelve Data` (`TWELVE_DATA_PUBLISHER`) | `MarketSeriesMeta.publisher` | [`market_series.publisher`](../../database/tables/market_series.md) |
| (constant) | `https://twelvedata.com/` (`TWELVE_DATA_SOURCE_URL`) — an attribution link, never fetched | `MarketSeriesMeta.sourceUrl` | [`market_series.source_url`](../../database/tables/market_series.md); also for a failed first fetch |
| `$.values[].datetime` | First 10 characters, kept only when a real `YYYY-MM-DD` date (no time-zone conversion); ascending, one row per date (the first wins), newest 800 | `MarketObservationTuple[0]` (`packages/contracts/src/market.ts`) | [`market_observations.observed_on`](../../database/tables/market_observations.md) |
| `$.values[].close` | Blank skipped; JavaScript `Number` semantics (Rust `string_to_number`), finite only; no rounding. No readable bar → `NO_DATA` | `MarketObservationTuple[1]` | [`market_observations.value`](../../database/tables/market_observations.md) (upserted only when changed; rows from the write's `replaceFrom` on that the answer lacks are deleted; newest 1,500 kept) |
| (runner clock) | Time the series' fetch started, ISO-8601 UTC | `fetchedAt` | [`market_series.last_refreshed_at`](../../database/tables/market_series.md), and `retrieved_at` on success |
| (history decision) | `window` or `full`, decided by the domain rule from the anchor (`packages/domain/src/market/historyRefresh.ts`, `crates/research-domain/src/market/history_refresh.rs`) | `history` | [`market_series.history_checked_at`](../../database/tables/market_series.md) (set on a `full` write) |
| HTTP status / JSON `code` | Our code from section 4; the number unchanged when 100–599 | `errorCode`, `upstreamStatus` | [`market_series.unavailable_code`](../../database/tables/market_series.md), [`market_series.unavailable_upstream_status`](../../database/tables/market_series.md) |

## 7. Maintenance

### Known differences between the runners

None in requests, parsing or mapping: both split the symbol at the last `:`, send the same parameters in the same order, recognise the same error object, require the same `meta` and bar field types and build the same title and unit. Transport only: both try up to 3 resolved addresses per request; the Rust runner reuses pooled HTTP/1.1 connections and re-sends a GET once on a fresh connection when a pooled one closes before answering (`crates/research-net/src/pinned.rs`), while the TypeScript runner opens a fresh connection per request (`packages/adapters/src/node/pinnedConnect.ts`) and never re-sends.

### Open issues

None.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-12 | live | Fixtures `twelvedata-timeseries-*.json`, `twelvedata-key-symbol_*.json` and `twelvedata-error-*.json` recorded with a Basic key; header authentication | Runner adapter work (FR-017) |
| 2026-10-31 | live | `GET /time_series` with the runner's exact URLs and headers over HTTP/2 and HTTP/1.1: AAPL full (800 bars) and window (`start_date` inclusive), XAU/USD window (weekend bar, no `volume`), 404 for `7203` on `JPX`, 401 for an invalid key. Errors arrive with the matching HTTP status. Fixture shapes unchanged; both error bodies identical to the fixtures. | Claude (ADR-0047 documentation) |
| 2026-10-31 | spec | Parameters, `outputsize` default and range, `meta` and `values` fields, error codes and format, authentication methods, Basic plan limits against Twelve Data's reference and pricing pages | Claude (ADR-0047 documentation) |
| 2026-10-31 | spec | Daily quota reset time and plan scope against the support article [Credits](https://support.twelvedata.com/en/articles/5615854-credits): Basic resets to 800 at 00:00:00 UTC; paid plans have no daily limit. Basis of the runner's daily budget. | Claude (external API defect fixes) |
