# External API: FRED

## 1. Overview

| Property | Value |
|---|---|
| Provider | Federal Reserve Bank of St. Louis (Federal Reserve Economic Data, FRED) |
| Purpose | Economic indicator series (VIX, Treasury yields, CPI, …) for the Home and Notebook series, table and chart widgets (FR-017, [ADR-0014](../../adr/0014-market-data-sources.md)), refreshed incrementally ([ADR-0044](../../adr/0044-indicator-charts-and-incremental-history.md)). |
| Hosts | `api.stlouisfed.org` |
| Endpoints | `GET /fred/series` — a series' title, units, frequency and seasonal adjustment; `GET /fred/series/observations` — the series' dated values |
| Authentication | API key in the query parameter `api_key` (FRED offers no header scheme); env variable `FRED_API_KEY` in `apps/runner/.env`. Without it the runner logs `market_source_disabled` once and every FRED series is `SOURCE_NOT_CONFIGURED`. |
| Configuration | None. |
| Usage Limits | FRED: up to 120 requests per minute, then HTTP 429; ignoring throttling can cause a temporary block ([errors page](https://fred.stlouisfed.org/docs/api/fred/errors.html)); use is subject to the [API terms of use](https://fred.stlouisfed.org/docs/api/terms_of_use.html) (attribution notice, no implied endorsement, third-party copyrighted series for personal use; how the app complies is in ADR-0014). Ours: a sliding window of 100 request starts per 60 s under the pacer key `fred`, one grant per request actually sent (2 for a series whose metadata is not cached, 1 when it is); at most 60 tracked series per job (`MARKET_LIMITS.maxTrackedSeries`); metadata cached 24 h. |
| Called By | Rust runner (default) and TypeScript runner (rollback), `market-refresh` jobs only (queued by `POST /home/refresh`, scope `all` or `unrefreshed`, and by the Home / Notebook staleness re-check). |
| Code | `crates/research-finance/src/fred.rs`, `crates/research-finance/src/market_fetch.rs`, `crates/research-finance/src/bounded_cache.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-finance/src/jobs.rs`, `packages/adapters/src/finance/fredSeries.ts`, `packages/adapters/src/finance/marketFetch.ts`, `packages/adapters/src/finance/boundedCache.ts`, `apps/runner/src/marketPacing.ts`, `apps/runner/src/jobExecution.ts`, `packages/adapters/src/sql/unitOfWork.ts` |
| Official Documentation | [fred/series](https://fred.stlouisfed.org/docs/api/fred/series.html), [fred/series/observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [errors](https://fred.stlouisfed.org/docs/api/fred/errors.html), [API keys](https://fred.stlouisfed.org/docs/api/api_key.html), [terms of use](https://fred.stlouisfed.org/docs/api/terms_of_use.html) |
| Last Verified | 2026-10-31, live (section 7) |

For each claimed FRED series (`fred:<SERIES_ID>`) a `market-refresh` job asks `GET /fred/series` for the metadata unless a validated copy younger than 24 h is cached, then `GET /fred/series/observations`, each request waiting for its own pacer grant just before it is sent, for the newest values — from the stored anchor's date when the claim carries one (a window), otherwise the full history (capped at 800). When a window does not reproduce the anchor, a second paced round (metadata then cached, so one request) asks for the full history in the same job (ADR-0044). The metadata and observations go into the `market-refreshed` completion, which the API Worker stores in `market_series` and `market_observations`; a failure stores only its code and FRED's status. The public page `https://fred.stlouisfed.org/series/<SERIES_ID>` is never requested: it is stored as the series' source link (section 6). `packages/adapters/src/finance/marketData.ts` and `crates/research-finance/src/market_data.rs` hold source-neutral share-price, short-interest and margin-balance ports with unconfigured implementations only; they call nothing.

## 2. Input Parameters

Both endpoints are sent through the runner's safe fetcher with these headers. The fetch core sets `Accept` and `User-Agent` on every hop, redirect hops included (`packages/adapters/src/worker/safeFetchCore.ts`, `crates/research-net/src/core.rs`); the transport adds `Accept-Encoding: gzip` to every request it sends (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`). FRED takes no credential header: the key is the `api_key` query parameter of the URL we build, and a redirect hop requests the server's `Location`, which must stay on `api.stlouisfed.org`.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Accept` | header | string | No | We send `application/json` | Printable ASCII | Asks for JSON; FRED decides the format from `file_type`. |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` | Printable ASCII, ≤ 300 characters | The runner's fixed identification (`DEFAULT_USER_AGENT`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | FRED answers gzip; encoded bytes are counted against the size cap. |

### GET /fred/series

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `series_id` | query | string | Yes | — ; we send the claim's symbol | FRED series id, 25 or fewer alphanumeric characters (FRED's error text) | The series, the part of `fred:<SERIES_ID>` after the provider. |
| `file_type` | query | string | No | FRED: `xml`; we send `json` | `xml`, `json` | Response format. |
| `api_key` | query | string | Yes | — ; we send `FRED_API_KEY` | 32 lower-case alphanumeric characters | The owner's registered key. Last parameter of the URL; never logged (failures carry fixed wording only). |

### GET /fred/series/observations

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `series_id` | query | string | Yes | — ; we send the claim's symbol | As above | The series. |
| `file_type` | query | string | No | FRED: `xml`; we send `json` | `xml`, `json`, `xlsx`, `csv` | Response format. |
| `sort_order` | query | string | No | FRED: `asc`; we send `desc` | `asc`, `desc` | Newest first, so `limit` keeps the newest values. |
| `limit` | query | integer | No | FRED: `100000`; we send `800` (`MARKET_LIMITS.maxObservationsPerResponse`) | 1–100000 | Most observations returned. |
| `observation_start` | query | string | No | FRED: `1776-07-04` (earliest); we send it only for a window fetch | `YYYY-MM-DD`; sent only when it is a real calendar date | The stored anchor's date (the 32nd newest stored observation), inclusive and without extra overlap (ADR-0044). Omitted for a full fetch. |
| `api_key` | query | string | Yes | — ; we send `FRED_API_KEY` | As above | Last parameter of the URL. |

## 3. Output Parameters

### GET /fred/series

`application/json; charset=UTF-8`, one object. With `file_type=json` FRED escapes `/` as `\/` inside strings.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.realtime_start` | string | No | No | No | Start of the real-time period, `YYYY-MM-DD`. |
| `$.realtime_end` | string | No | No | No | End of the real-time period. |
| `$.seriess` | array | No | No | Yes | The matching series; FRED returns one. An empty array is `SERIES_NOT_FOUND`; any element lacking one of the five string fields below is `SOURCE_FAILED`. Only the first element is used. |
| `$.seriess[].id` | string | No | No | Yes | Series id; builds the source link. |
| `$.seriess[].realtime_start` | string | No | No | No | Real-time period start. |
| `$.seriess[].realtime_end` | string | No | No | No | Real-time period end. |
| `$.seriess[].title` | string | No | No | Yes | Series title. |
| `$.seriess[].observation_start` | string | No | No | No | First observation date. |
| `$.seriess[].observation_end` | string | No | No | No | Last observation date. |
| `$.seriess[].frequency` | string | No | No | No | Frequency text, e.g. `Daily, Close`. |
| `$.seriess[].frequency_short` | string | No | No | Yes | `D`, `W`, `BW`, `M`, `Q`, `SA` or `A`. |
| `$.seriess[].units` | string | No | No | Yes | Unit text, e.g. `Index 1982-1984=100`. |
| `$.seriess[].units_short` | string | No | No | No | Abbreviated unit. |
| `$.seriess[].seasonal_adjustment` | string | No | No | No | Seasonal adjustment text. |
| `$.seriess[].seasonal_adjustment_short` | string | No | No | Yes | `NSA`, `SA`, `SAAR`, … |
| `$.seriess[].last_updated` | string | No | No | No | Last update time, `YYYY-MM-DD HH:MM:SS±HH`. |
| `$.seriess[].popularity` | number | No | No | No | Popularity rank 0–100. |
| `$.seriess[].notes` | string | No | Yes | No | Free-text notes; FRED's reference shows it but does not document whether it is always present. |

### GET /fred/series/observations

`application/json; charset=UTF-8`, one object.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.realtime_start` | string | No | No | No | Real-time period start. |
| `$.realtime_end` | string | No | No | No | Real-time period end. |
| `$.observation_start` | string | No | No | No | Echo of `observation_start`, `1600-01-01` when omitted (observed). |
| `$.observation_end` | string | No | No | No | `9999-12-31` (we never send it). |
| `$.units` | string | No | No | No | Transformation, `lin` (levels). |
| `$.output_type` | integer | No | No | No | `1`. |
| `$.file_type` | string | No | No | No | `json`. |
| `$.order_by` | string | No | No | No | `observation_date`. |
| `$.sort_order` | string | No | No | No | Echo of `sort_order`. |
| `$.count` | integer | No | No | No | Observations matching the query before `limit`. |
| `$.offset` | integer | No | No | No | `0`. |
| `$.limit` | integer | No | No | No | Echo of `limit`. |
| `$.observations` | array | No | No | Yes | Observations, newest first. An element whose `date` or `value` is not a string makes the answer `SOURCE_FAILED`. |
| `$.observations[].realtime_start` | string | No | No | No | Real-time period start. |
| `$.observations[].realtime_end` | string | No | No | No | Real-time period end. |
| `$.observations[].date` | string | No | No | Yes | Observation date, `YYYY-MM-DD`; a row whose date is not a real calendar date is skipped. |
| `$.observations[].value` | string | No | No | Yes | Decimal number as text, or `.` for "no value on this date" (holidays; observed, not in FRED's reference). `.`, empty and non-finite values are skipped, never stored as 0. |

## 4. Error Handling

### HTTP status codes

FRED's [errors page](https://fred.stlouisfed.org/docs/api/fred/errors.html) lists 400, 404, 423, 429 and 500. The fetch reads the error body (`includeErrorBody` / `include_error_body`) so the message can pick the code; the message itself is matched locally and never stored, shown or logged. Every code below carries FRED's HTTP status unchanged as `upstreamStatus` ([error handling §4a](../../rule/error_handling.md)).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | Message contains `api_key` (unregistered or missing key) | Fails the series; stores code and status | `SOURCE_AUTH_FAILED` |
| 400 | Message contains `series_id` or `does not exist` (malformed id, unknown series) | Fails the series | `SERIES_NOT_FOUND` |
| 400 | Any other message, or a body that is not FRED's error JSON | Fails the series | `SOURCE_FAILED` |
| 429 | More than 120 requests per minute | Fails the series (the body is not consulted) | `RATE_LIMITED` |
| 404, 423, 500, other non-2xx | Not found, locked, server error | Same message matching as 400; otherwise | `SOURCE_FAILED` (or the code its body selects) |
| 200 with `{error_code, error_message}` | Not observed; mapped defensively | The message picks the code; `error_code` is used as the status when it is 100–599 | as for 400 |
| 200 with an unexpected shape | — | Fails the series, no status | `SOURCE_FAILED` |
| — | Timeout, network error, body over 1,000,000 bytes, redirect off `api.stlouisfed.org` | Fails the series, no status | `SOURCE_FAILED` |

### Provider error codes and body

Error answers are JSON `{"error_code": <HTTP status>, "error_message": "<text>"}`. The messages observed live are `Bad Request.  The series does not exist.`, `Bad Request.  Invalid value for variable series_id.  …` and `Bad Request.  The value for variable api_key is not registered.  …`. Nothing but the substring tests above depends on their wording.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s for the whole request (connection, redirects, body), no separate connect timeout; body cap 1,000,000 bytes (encoded and decoded); at most 5 redirects, each of which must stay on `api.stlouisfed.org`. | `packages/adapters/src/finance/fredSeries.ts`, `crates/research-finance/src/market_fetch.rs`, `crates/research-net/src/core.rs` |
| Retries | None per request. Transport only: both runners try up to 3 validated resolved addresses in turn when a connection cannot be made (`MAX_CONNECT_ATTEMPTS`); the Rust runner also re-sends a GET once on a fresh connection when an idle pooled connection turns out closed before answering. The TypeScript runner opens a fresh connection per request, so it has no such resend. A failed series is retried by the next refresh. | `packages/adapters/src/node/index.ts`, `crates/research-net/src/transport.rs`, `crates/research-net/src/pinned.rs` |
| Rate limit | No response header is read. Sliding window of 100 starts per 60 s (`fred`), shared across jobs for the runner's lifetime; the adapter asks the job's admission hook (`beforeRequest` / `before_request`) immediately before each request it sends, so a cached metadata answer costs no grant; a request that does not fit waits, and a job stopped while waiting sends nothing. A 429 fails only that series. | `apps/runner/src/marketPacing.ts`, `apps/runner/src/jobExecution.ts`, `packages/adapters/src/finance/fredSeries.ts`, `crates/research-finance/src/pacing.rs`, `crates/research-finance/src/jobs.rs` |
| Cache | Validated metadata per series id for 24 h, at most 256 entries, per runner process; failures are not cached. Observations are never cached (the incremental window keeps them small). | `packages/adapters/src/finance/boundedCache.ts`, `crates/research-finance/src/bounded_cache.rs` |
| Fallback | A failed series keeps its stored metadata and observations; Home and the Notebook show them with the code's fixed reason (`MARKET_UNAVAILABLE_REASONS`). A new series that fails gets a placeholder row (title = series id). | `packages/contracts/src/market.ts`, `packages/adapters/src/sql/unitOfWork.ts` |

## 5. Examples

### GET /fred/series

Request:

```http
GET /fred/series?series_id=VIXCLS&file_type=json&api_key=<FRED_API_KEY> HTTP/1.1
Host: api.stlouisfed.org
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
Content-Length: 374
Content-Encoding: gzip
```

<!-- example: fred-series-vixcls -->
```json
{
  "realtime_start": "2026-10-30",
  "realtime_end": "2026-10-30",
  "seriess": [
    {
      "id": "VIXCLS",
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "title": "CBOE Volatility Index: VIX",
      "observation_start": "1990-01-02",
      "observation_end": "2026-10-29",
      "frequency": "Daily, Close",
      "frequency_short": "D",
      "units": "Index",
      "units_short": "Index",
      "seasonal_adjustment": "Not Seasonally Adjusted",
      "seasonal_adjustment_short": "NSA",
      "last_updated": "2026-10-30 08:37:33-05",
      "popularity": 86,
      "notes": "VIX measures market expectation of near term volatility conveyed by stock index option prices. Copyright, 2016, Chicago Board Options Exchange, Inc. Reprinted with permission."
    }
  ]
}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1. Complete body, pretty-printed; status line and headers as captured for this request, other headers omitted (`Content-Length` is the gzip size).

### GET /fred/series/observations

Window request (the claim's anchor is 2026-09-15):

```http
GET /fred/series/observations?series_id=VIXCLS&file_type=json&sort_order=desc&limit=800&observation_start=2026-09-15&api_key=<FRED_API_KEY> HTTP/1.1
Host: api.stlouisfed.org
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
Content-Length: 408
Content-Encoding: gzip
```

<!-- example: fred-observations-window -->
```json
{
  "realtime_start": "2026-10-30",
  "realtime_end": "2026-10-30",
  "observation_start": "2026-09-15",
  "observation_end": "9999-12-31",
  "units": "lin",
  "output_type": 1,
  "file_type": "json",
  "order_by": "observation_date",
  "sort_order": "desc",
  "count": 33,
  "offset": 0,
  "limit": 800,
  "observations": [
    {
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "date": "2026-10-29",
      "value": "17.2"
    },
    {
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "date": "2026-10-28",
      "value": "16.91"
    },
    {
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "date": "2026-09-15",
      "value": "17.2"
    }
  ]
}
```

Verified: live, 2026-10-31, curl with the runner's headers. Captured over HTTP/1.1 and HTTP/2 with identical bodies; status line and headers from the HTTP/1.1 capture, other headers omitted. 3 of 33 observations kept (the two newest and the anchor row); pretty-printed.

Full request (no anchor, or the weekly full check):

```http
GET /fred/series/observations?series_id=VIXCLS&file_type=json&sort_order=desc&limit=800&api_key=<FRED_API_KEY> HTTP/1.1
Host: api.stlouisfed.org
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
Content-Length: 5057
Content-Encoding: gzip
```

<!-- example: fred-observations-full -->
```json
{
  "realtime_start": "2026-10-30",
  "realtime_end": "2026-10-30",
  "observation_start": "1600-01-01",
  "observation_end": "9999-12-31",
  "units": "lin",
  "output_type": 1,
  "file_type": "json",
  "order_by": "observation_date",
  "sort_order": "desc",
  "count": 9608,
  "offset": 0,
  "limit": 800,
  "observations": [
    {
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "date": "2026-10-29",
      "value": "17.2"
    },
    {
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "date": "2026-10-28",
      "value": "16.91"
    },
    {
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "date": "2026-04-03",
      "value": "."
    },
    {
      "realtime_start": "2026-10-30",
      "realtime_end": "2026-10-30",
      "date": "2023-10-06",
      "value": "17.45"
    }
  ]
}
```

Verified: live, 2026-10-31, curl with the runner's headers. Captured over HTTP/1.1 and HTTP/2 with identical bodies; status line and headers from the HTTP/1.1 capture, other headers omitted. 4 of 800 observations kept (the two newest, the first `.` row and the oldest); pretty-printed.

### Error response

Unknown series:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=UTF-8
Content-Length: 77
```

<!-- example: fred-error-not-found -->
```json
{"error_code":400,"error_message":"Bad Request.  The series does not exist."}
```

Verified: live, 2026-10-31, curl `GET /fred/series?series_id=NOSUCHSERIES123&file_type=json&api_key=<FRED_API_KEY>` with the runner's headers over HTTP/1.1. Status line and headers as captured, other headers omitted; complete body, verbatim; identical to `packages/adapters/test/finance/fixtures/fred-series-notfound.json`. The malformed-id answer ("Invalid value for variable series_id", captured 2026-10-12) is `fixtures/fred-series-invalid-id.json`.

Unregistered key:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=UTF-8
Content-Length: 183
```

<!-- example: fred-error-bad-key -->
```json
{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered.  Read https:\/\/fred.stlouisfed.org\/docs\/api\/api_key.html for more information."}
```

Verified: live, 2026-10-31, curl `GET /fred/series?series_id=VIXCLS&file_type=json` with an invented 32-character key and the runner's headers over HTTP/1.1 (identical body over HTTP/2). Status line and headers as captured, other headers omitted; complete body, verbatim; identical to `packages/adapters/test/finance/fixtures/fred-series-badkey.json`.

## 6. Data Mapping

Rust types: `MarketSeriesMeta`, `MarketUnavailableCode` in `crates/research-contracts/src/market.rs`. The completion entry is `market-refreshed` in `packages/contracts/src/jobs.ts`; the API Worker stores it with `marketStatements` in `packages/adapters/src/sql/unitOfWork.ts`.

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.seriess[0].title` | Trimmed; empty → `SOURCE_FAILED`; longer than 200 UTF-16 units → the first 199 units (never splitting a character) plus `…` (domain `truncateText` / `truncate_text`) | `MarketSeriesMeta.title` (`packages/contracts/src/market.ts`) | [`market_series.title`](../../database/tables/market_series.md) |
| `$.seriess[0].units`, `$.seriess[0].seasonal_adjustment_short` | Units trimmed; `, seasonally adjusted` appended when the adjustment is `SA` or `SAAR`; a unit that would exceed 80 UTF-16 units is shortened with `…` like the title, before the appended mark (so the mark is kept); empty → `SOURCE_FAILED` | `MarketSeriesMeta.unit` | [`market_series.unit`](../../database/tables/market_series.md) |
| `$.seriess[0].frequency_short` | `D` → `daily`; `W`, `BW` → `weekly`; `M` → `monthly`; `Q` → `quarterly`; `A` → `annual`; anything else (`SA`) → `unknown` | `MarketSeriesMeta.frequency` | [`market_series.frequency`](../../database/tables/market_series.md) |
| (constant) | `Federal Reserve Bank of St. Louis (FRED)` (`FRED_PUBLISHER`) | `MarketSeriesMeta.publisher` | [`market_series.publisher`](../../database/tables/market_series.md) |
| `$.seriess[0].id` | `https://fred.stlouisfed.org/series/<id>` — a link the owner may open, never fetched | `MarketSeriesMeta.sourceUrl` | [`market_series.source_url`](../../database/tables/market_series.md); a failed first fetch stores the same link built from the claimed symbol |
| `$.observations[].date` | Kept only when a real `YYYY-MM-DD` date; ascending, one row per date (the first wins), newest 800 | `MarketObservationTuple[0]` (`packages/contracts/src/market.ts`) | [`market_observations.observed_on`](../../database/tables/market_observations.md) |
| `$.observations[].value` | Trimmed; `.` and empty skipped; JavaScript `Number` semantics (Rust `string_to_number`), finite only; no unit or rounding change | `MarketObservationTuple[1]` | [`market_observations.value`](../../database/tables/market_observations.md) (upserted only when changed; rows from the write's `replaceFrom` on that the answer lacks are deleted; newest 1,500 kept) |
| (runner clock) | Time the series' fetch started, ISO-8601 UTC | `fetchedAt` | [`market_series.last_refreshed_at`](../../database/tables/market_series.md), and `retrieved_at` on success |
| (history decision) | `window` or `full`, decided by the domain rule from the anchor (`packages/domain/src/market/historyRefresh.ts`, `crates/research-domain/src/market/history_refresh.rs`) | `history` | [`market_series.history_checked_at`](../../database/tables/market_series.md) (set on a `full` write) |
| HTTP status / `error_code` | Our code from section 4; the status unchanged when 100–599 | `errorCode`, `upstreamStatus` | [`market_series.unavailable_code`](../../database/tables/market_series.md), [`market_series.unavailable_upstream_status`](../../database/tables/market_series.md) |

## 7. Maintenance

### Known differences between the runners

None in requests, parsing or mapping: both build the same URL with the same parameter order, match the error message case-insensitively on the same substrings, require the same field types, and keep the same 24 h metadata cache and pacing. Transport only: both try up to 3 resolved addresses per request; the Rust runner reuses pooled HTTP/1.1 connections and re-sends a GET once on a fresh connection when a pooled one closes before answering (`crates/research-net/src/pinned.rs`), while the TypeScript runner opens a fresh connection per request (`packages/adapters/src/node/pinnedConnect.ts`) and never re-sends.

### Open issues

- Our pacing allows 100 requests per minute (`FRED_RATE_LIMIT`) while FRED publishes 120: a deliberate margin (the code comments said "FRED allows 100" until 2026-10-31).

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-12 | live | Fixtures `fred-series-VIXCLS.json`, `fred-observations-VIXCLS.json`, `fred-observations-CPIAUCSL.json`, `fred-series-badkey.json`, `fred-series-notfound.json` recorded | Runner adapter work (FR-017) |
| 2026-10-31 | live | Both endpoints with the runner's exact URLs and headers over HTTP/1.1 and HTTP/2: series metadata (VIXCLS, CPIAUCSL), observations full and window (`observation_start` inclusive), `.` values, 400 for an unknown series and an unregistered key. Fixture shapes unchanged; bad-key body identical. | Claude (ADR-0047 documentation) |
| 2026-10-31 | spec | Parameters, defaults, response fields, error statuses and the 120/min limit against FRED's reference pages | Claude (ADR-0047 documentation) |
| 2026-10-31 | fixture | `fred-series-notfound.json` now holds the live unknown-series body of section 5; the malformed-id body it held moved to `fred-series-invalid-id.json`; both tested (`fredSeries.test.ts`, vectors `finance/fred.json`) | Claude (external API defect fixes) |
