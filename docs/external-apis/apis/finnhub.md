# External API: Finnhub

## 1. Overview

| Property | Value |
|---|---|
| Provider | Finnhub Stock API (Finnhub.io) |
| Purpose | Upcoming earnings announcement dates of the US stocks on the Watchlist, and their company names when none is stored (FR-018, [ADR-0016](../../adr/0016-earnings-dates-and-calendar-export.md)); and the whole US earnings calendar — every company announcing in the window — for the Stocks page's next earnings date of every listed stock ([ADR-0068](../../adr/0068-every-listed-stocks-next-earnings-date.md)). Japanese stocks use JPX instead. |
| Hosts | `finnhub.io` |
| Endpoints | `GET /api/v1/stock/profile2` — company profile (name, ticker); `GET /api/v1/calendar/earnings` — earnings releases of one symbol, or of every company, in a date window |
| Authentication | Header `X-Finnhub-Token: <key>` (Finnhub also accepts a `token` query parameter, which we never use, so the key never enters a URL); env variable `FINNHUB_API_KEY` in `apps/runner/.env`. Without it the runner logs `earnings_source_disabled` once and every US stock is `SOURCE_NOT_CONFIGURED`. |
| Configuration | None. |
| Usage Limits | Free plan: 60 calls per minute (Finnhub's pricing page; the live `X-Ratelimit-Limit: 60` header agrees), plus a 30 calls per second cap on every plan and HTTP 429 when exceeded ([Rate limits](https://finnhub.io/docs/api/rate-limit)). The free tier of the earnings calendar covers "1 month of historical earnings and new updates" ([swagger](https://finnhub.io/static/swagger.json)); we ask only for future dates. Ours: a sliding window of 30 request starts per 60 s under the pacer key `finnhub`, one grant per request; at most 50 stocks per job (`EARNINGS_LIMITS.maxStocks`), 1–2 requests each; the whole-market calendar costs one request per 7-day window plus one per day of a week that hit the row cap (about 30–40 a day); no cache. An answer without `symbol` stops at 1,500 rows (observed 2026-11-03: a 7-day window answered exactly 1,500, one busy day 567); Finnhub documents no cap. |
| Called By | Rust runner (default) and TypeScript runner (rollback): `earnings-refresh` jobs, which the API queues at claim time (ADR-0051): every 24 hours, a new stock within seconds, failed fetches after 30 minutes; and `earnings-calendar-sync` jobs of the US market (ADR-0068): every 24 hours once the US stock list is stored, a failed sync after 30 minutes. |
| Code | `crates/research-finance/src/finnhub.rs`, `crates/research-finance/src/market_fetch.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-finance/src/jobs.rs`, `packages/adapters/src/finance/finnhubEarnings.ts`, `packages/adapters/src/finance/marketFetch.ts`, `apps/runner/src/marketPacing.ts`, `apps/runner/src/jobExecution.ts`, `packages/adapters/src/sql/unitOfWork.ts` |
| Official Documentation | [Authentication, Rate limits, Earnings Calendar, Company Profile 2](https://finnhub.io/docs/api), machine-readable [swagger.json](https://finnhub.io/static/swagger.json) (definitions `EarningsCalendar`, `EarningRelease`, `CompanyProfile2`), [pricing](https://finnhub.io/pricing) |
| Last Verified | 2026-11-03, live (section 7) |

An `earnings-refresh` claim carries the window `[today, today + 185 days]` (UTC dates from the API's clock, `WATCHLIST_LIMITS.horizonDays`) and each stock with its stored name. The runner handles the US stocks one after another: when the stock has no stored name it first asks `GET /api/v1/stock/profile2` (an unknown symbol ends there as `SYMBOL_NOT_FOUND`), then `GET /api/v1/calendar/earnings` for the window; each request first takes one pacer grant. The dates, fiscal periods and timing go into the `earnings-refreshed` completion, which the API Worker stores in `earnings_events` and `watchlist_stocks`; a failure stores only its code and Finnhub's status. The estimates and actuals in the calendar are parsed away and never stored or shown.

An `earnings-calendar-sync` claim of the US market carries the same window and no stocks. The runner cuts it into 7-day windows and asks `GET /api/v1/calendar/earnings` without `symbol` for each (one pacer grant each); when a week's answer holds 1,500 rows it is set aside and each day of that week is asked instead, and a day that still holds 1,500 rows is kept and reported in `truncatedDates`. Any failed request fails the whole calendar. The rows go into the `earnings-calendar-synced` completion, which replaces the market's rows in [`stock_earnings_calendar`](../../database/tables/stock_earnings_calendar.md), keeping only stocks of the owner's US stock list.

## 2. Input Parameters

Both endpoints are sent through the runner's safe fetcher with these headers. The fetch core sets `Accept` and `User-Agent` on every hop, redirect hops included, and `X-Finnhub-Token` on the first request only (`packages/adapters/src/worker/safeFetchCore.ts`, `crates/research-net/src/core.rs`); the transport adds `Accept-Encoding: gzip` to every request it sends (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`). A redirect hop must stay on `finnhub.io`.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `X-Finnhub-Token` | header | string | Yes | — ; we send `FINNHUB_API_KEY` | Printable ASCII, ≤ 300 characters | The owner's key. Sent on the first request only, never on a redirect hop. |
| `Accept` | header | string | No | We send `application/json` | Printable ASCII | Finnhub answers JSON. |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` | Printable ASCII | The runner's fixed identification (`DEFAULT_USER_AGENT`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | Finnhub answers gzip; encoded bytes are counted against the size cap. |

### GET /api/v1/stock/profile2

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `symbol` | query | string | Yes (one of `symbol`, `isin`, `cusip`; we send `symbol`) | — ; we send the watchlist symbol | US symbol: 1–10 upper-case letters, digits, `.` or `-`, starting with a letter (`watchlist_stocks.symbol`) | The company. |

### GET /api/v1/calendar/earnings

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `from` | query | string | No (we always send it) | — ; we send the claim's `fromDate` (today, UTC) | `YYYY-MM-DD` | Window start, inclusive. |
| `to` | query | string | No (we always send it) | — ; we send the claim's `toDate` (today + 185 days) | `YYYY-MM-DD` | Window end, inclusive. |
| `symbol` | query | string | No | All symbols; we send the watchlist symbol for `earnings-refresh`, and none for `earnings-calendar-sync` | As above | Restricts the calendar to one company; without it every company in the window is listed, at most 1,500 rows (observed). `international` is never sent (Finnhub default `false`). |

## 3. Output Parameters

### GET /api/v1/stock/profile2

`application/json; charset=utf-8`, one object; `{}` for an unknown symbol (observed). Fields beyond the swagger definition `CompanyProfile2` were observed live and are listed as such.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$` | object | No | No | Yes | Not an object → `SOURCE_FAILED`. |
| `$.ticker` | string | No | Yes | Yes | Ticker on the listed exchange. Absent → `SYMBOL_NOT_FOUND`; not a string (including `null`) → `SOURCE_FAILED`. |
| `$.name` | string | No | Yes | Yes | Company name. Not a string (including `null`) → `SOURCE_FAILED`. |
| `$.country` | string | No | Yes | No | Headquarters country. |
| `$.currency` | string | No | Yes | No | Filing currency. |
| `$.estimateCurrency` | string | No | Yes | No | Estimate currency (observed; not in the swagger). |
| `$.exchange` | string | No | Yes | No | Listed exchange. |
| `$.ipo` | string | No | Yes | No | IPO date, `YYYY-MM-DD`. |
| `$.marketCapitalization` | number | No | Yes | No | Market capitalisation (millions). |
| `$.logo` | string | No | Yes | No | Logo URL. |
| `$.shareOutstanding` | number | No | Yes | No | Shares outstanding (millions). |
| `$.finnhubIndustry` | string | No | Yes | No | Finnhub industry. |
| `$.phone` | string | No | Yes | No | Phone number. |
| `$.weburl` | string | No | Yes | No | Company website. |
| `$.floatingShare` | number | No | Yes | No | Floating shares (observed; not in the swagger). |

### GET /api/v1/calendar/earnings

`application/json; charset=utf-8`, one object; `{"earningsCalendar":[]}` when nothing is listed (observed). Rows come newest first (observed); the code sorts them itself. Without `symbol`, at most 1,500 rows, sorted by symbol rather than by date (observed 2026-11-03: a capped 7-day answer listed symbols from `AAON` on and lacked the window's later dates for symbols past its last row).

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.earningsCalendar` | array | No | No | Yes | Earnings releases. Absent or not an array → `SOURCE_FAILED`. |
| `$.earningsCalendar[].symbol` | string | Yes | Yes | Yes | Symbol; a row for another symbol is skipped. Not a string or `null` → `SOURCE_FAILED`. Without `symbol`: share classes are written with a dot (`BH.A`, observed). |
| `$.earningsCalendar[].date` | string | No | No | Yes | Announcement date, `YYYY-MM-DD`. Not a string → `SOURCE_FAILED`; not a real date or outside `[from, to]` → row skipped. |
| `$.earningsCalendar[].hour` | string | Yes | Yes | Yes | `bmo` (before market open), `amc` (after market close), `dmh` (during market hours), or `""` when not announced (observed). |
| `$.earningsCalendar[].quarter` | integer | Yes | Yes | Yes | Fiscal quarter. Not a number or `null` → `SOURCE_FAILED`; missing, `null`, non-integer or outside 1–4 → row skipped. |
| `$.earningsCalendar[].year` | integer | Yes | Yes | Yes | Fiscal year. As `quarter`, without the range check. |
| `$.earningsCalendar[].epsEstimate` | number | Yes | Yes | No | EPS estimate (non-GAAP). |
| `$.earningsCalendar[].epsActual` | number | Yes | Yes | No | EPS actual; `null` before the release. |
| `$.earningsCalendar[].revenueEstimate` | number | Yes | Yes | No | Revenue estimate. |
| `$.earningsCalendar[].revenueActual` | number | Yes | Yes | No | Revenue actual; `null` before the release. |

Response headers `X-Ratelimit-Limit`, `X-Ratelimit-Remaining` and `X-Ratelimit-Reset` (observed on both endpoints) are not read.

## 4. Error Handling

### HTTP status codes

The code maps the HTTP status of a non-2xx answer without reading its body. The status travels unchanged as `upstreamStatus` ([error handling §4a](../../rule/error_handling.md)); a failure on the profile request ends the stock without a calendar request.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 401 | Invalid or missing key | Fails the stock | `SOURCE_AUTH_FAILED` |
| 403 | Endpoint or data not in the plan | Fails the stock | `PLAN_NOT_ENTITLED` |
| 429 | Plan limit or 30 calls/s exceeded | Fails the stock; no pause beyond the pacer | `RATE_LIMITED` |
| Any other non-2xx | — | Fails the stock | `SOURCE_FAILED` |
| 200 `{}` from `profile2` | Unknown symbol | Fails the stock, no status | `SYMBOL_NOT_FOUND` |
| 200 calendar with no usable row in the window | Nothing scheduled | A successful retrieval: the stored events are cleared, the name (if fetched) kept | `NO_SCHEDULED_DATE` |
| 200 with an unexpected shape | — | Fails the stock, no status | `SOURCE_FAILED` |
| — | Timeout, network error, body over 1,000,000 bytes, redirect off `finnhub.io`, job stopped while waiting for the pacer | Fails the stock, no status | `SOURCE_FAILED` |

### Provider error codes and body

Errors are plain HTTP statuses with a JSON body `{"error": "<text>"}` (observed: `{"error":"Invalid API key"}` with 401). The body is not read.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s for the whole request (connection, redirects, body), no separate connect timeout; body cap 1,000,000 bytes (encoded and decoded); at most 5 redirects, each on `finnhub.io`, without the `X-Finnhub-Token` header. | `packages/adapters/src/finance/finnhubEarnings.ts`, `crates/research-finance/src/market_fetch.rs`, `crates/research-net/src/core.rs` |
| Retries | None per request. Transport only: both runners try up to 3 validated resolved addresses in turn when a connection cannot be made (`MAX_CONNECT_ATTEMPTS`); the Rust runner also re-sends a GET once on a fresh connection when an idle pooled connection turns out closed before answering. The TypeScript runner opens a fresh connection per request, so it has no such resend. A failed stock is retried by the next refresh. | `packages/adapters/src/node/index.ts`, `crates/research-net/src/transport.rs`, `crates/research-net/src/pinned.rs` |
| Rate limit | No response header is read. Each request takes one grant from a sliding window of 30 starts per 60 s (`finnhub`, half the free plan's 60), shared across jobs for the runner's lifetime; a request that does not fit waits, and a job stopped while waiting sends nothing more. A 429 fails only that stock. | `apps/runner/src/marketPacing.ts`, `crates/research-finance/src/pacing.rs` |
| Cache | None. A stored company name skips the profile request. | `packages/adapters/src/finance/finnhubEarnings.ts` |
| Fallback | A failed stock keeps its stored events, name and success stamp; the Watchlist shows them with the code's fixed reason. | `packages/adapters/src/sql/unitOfWork.ts` |

## 5. Examples

### GET /api/v1/stock/profile2

Request:

```http
GET /api/v1/stock/profile2?symbol=AAPL HTTP/1.1
Host: finnhub.io
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
X-Finnhub-Token: <FINNHUB_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Ratelimit-Limit: 60
X-Ratelimit-Remaining: 59
X-Ratelimit-Reset: 1793423648
Content-Encoding: gzip
```

<!-- example: finnhub-profile2-aapl -->
```json
{
  "ticker": "AAPL",
  "name": "Apple Inc.",
  "country": "US",
  "currency": "USD",
  "estimateCurrency": "USD",
  "exchange": "NASDAQ NMS - GLOBAL MARKET",
  "ipo": "1980-12-12",
  "marketCapitalization": 5029592.198492898,
  "logo": "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AAPL.png",
  "shareOutstanding": 14594.18,
  "finnhubIndustry": "Technology",
  "phone": "14089961010",
  "weburl": "https://www.apple.com/",
  "floatingShare": 14352.36
}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1 and HTTP/2, identical bodies; status line and headers from the HTTP/1.1 capture of this request, other headers omitted. Complete body, pretty-printed.

Unknown symbol (`GET /api/v1/stock/profile2?symbol=ZZZZQ`):

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 2
X-Ratelimit-Limit: 60
X-Ratelimit-Remaining: 58
X-Ratelimit-Reset: 1793423648
```

<!-- example: finnhub-profile2-unknown -->
```json
{}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1 and HTTP/2, identical bodies; status line and headers from the HTTP/1.1 capture, other headers omitted. Complete body.

### GET /api/v1/calendar/earnings

Request:

```http
GET /api/v1/calendar/earnings?from=2026-10-31&to=2027-05-04&symbol=AAPL HTTP/1.1
Host: finnhub.io
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
X-Finnhub-Token: <FINNHUB_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, curl with the runner's headers.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Ratelimit-Limit: 60
X-Ratelimit-Remaining: 59
X-Ratelimit-Reset: 1793422554
Content-Encoding: gzip
```

<!-- example: finnhub-calendar-aapl -->
```json
{
  "earningsCalendar": [
    {
      "symbol": "AAPL",
      "date": "2027-04-28",
      "hour": "",
      "quarter": 2,
      "year": 2027,
      "epsEstimate": 2.2866,
      "epsActual": null,
      "revenueEstimate": 127095153972,
      "revenueActual": null
    },
    {
      "symbol": "AAPL",
      "date": "2027-01-27",
      "hour": "",
      "quarter": 1,
      "year": 2027,
      "epsEstimate": 2.9468,
      "epsActual": null,
      "revenueEstimate": 155961268080,
      "revenueActual": null
    },
    {
      "symbol": "AAPL",
      "date": "2026-11-02",
      "hour": "amc",
      "quarter": 4,
      "year": 2026,
      "epsEstimate": 2.0221,
      "epsActual": null,
      "revenueEstimate": 115496910249,
      "revenueActual": null
    }
  ]
}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1 and HTTP/2, identical bodies; status line and headers from the HTTP/1.1 capture, other headers omitted. Complete body, pretty-printed.

Every company on one day (`earnings-calendar-sync`, a day of a week that hit the row cap; here a quiet Sunday): `GET /api/v1/calendar/earnings?from=2026-11-08&to=2026-11-08`, the headers above:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Ratelimit-Limit: 60
X-Ratelimit-Remaining: 59
X-Ratelimit-Reset: 1793691019
Content-Encoding: gzip
```

<!-- example: finnhub-calendar-all-companies -->
```json
{"earningsCalendar":[{"symbol":"RDNT","date":"2026-11-08","hour":"","quarter":3,"year":2026,"epsEstimate":0.2142,"epsActual":null,"revenueEstimate":657521722,"revenueActual":null}]}
```

Verified: live, 2026-11-03, curl with the runner's headers over HTTP/1.1; status line and headers as captured, other headers omitted. Complete body, verbatim. The same request for `2026-11-03`–`2026-11-09` answered exactly 1,500 rows; for `2026-11-05` alone 567 (90,496 bytes), for `2026-11-04` 467.

Nothing listed (`GET /api/v1/calendar/earnings?from=2026-10-31&to=2027-05-04&symbol=ZZZZQ`):

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 23
X-Ratelimit-Limit: 60
X-Ratelimit-Remaining: 59
X-Ratelimit-Reset: 1793423648
```

<!-- example: finnhub-calendar-empty -->
```json
{"earningsCalendar":[]}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1 and HTTP/2, identical bodies; status line and headers from the HTTP/1.1 capture, other headers omitted. Complete body, verbatim.

### Error response

Invalid key (the calendar request above with an invented 40-character key):

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Content-Length: 27
```

```json
{"error":"Invalid API key"}
```

Verified: live, 2026-10-31, curl with the runner's headers over HTTP/1.1 (401 over HTTP/2 too). Status line and headers as captured, other headers omitted; complete body, verbatim.

## 6. Data Mapping

Rust types: `EarningsEvent`, `EarningsTiming`, `EarningsUnavailableCode` in `crates/research-contracts/src/watchlist.rs`. The completion entry is `earnings-refreshed` in `packages/contracts/src/jobs.ts`; the API Worker stores it in `packages/adapters/src/sql/unitOfWork.ts`. Publisher `Finnhub` and link `https://finnhub.io/` are fixed per source (`EARNINGS_SOURCE_INFO`, [`earnings_sources`](../../database/tables/earnings_sources.md)), not taken from a response.

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.name` (profile2) | Trimmed; empty or longer than 200 UTF-16 units (`EARNINGS_COMPANY_NAME_MAX`) → `null` (the refresh still succeeds) | `EarningsCalendarResult.name` → completion `name` (`packages/contracts/src/jobs.ts`) | [`watchlist_stocks.name`](../../database/tables/watchlist_stocks.md) (`coalesce`: a `null` keeps the stored name) |
| `$.ticker` (profile2) | Presence only: absent → `SYMBOL_NOT_FOUND` | — | Not stored |
| `$.earningsCalendar[].date` | Kept when a real date inside `[from, to]`; ascending (stable: rows of one date keep Finnhub's order); at most 8 events per stock (`maxEventsPerStock`) | `EarningsEvent.announcementDate` (`packages/contracts/src/watchlist.ts`) | [`earnings_events.announcement_date`](../../database/tables/earnings_events.md) |
| `$.earningsCalendar[].year`, `$.earningsCalendar[].quarter` | `<year>-q<quarter>` (`2026-q4`) | `EarningsEvent.periodKey` | [`earnings_events.period_key`](../../database/tables/earnings_events.md) |
| `$.earningsCalendar[].year`, `$.earningsCalendar[].quarter` | `Q<quarter> <year>` (`Q4 2026`) — Finnhub's fiscal year and quarter, not calendar ones | `EarningsEvent.fiscalPeriodLabel` | [`earnings_events.fiscal_period_label`](../../database/tables/earnings_events.md) |
| (none) | Always `null`: Finnhub gives no period end | `EarningsEvent.fiscalPeriodEnd` | [`earnings_events.fiscal_period_end`](../../database/tables/earnings_events.md) |
| `$.earningsCalendar[].hour` | `bmo` → `before-open`, `amc` → `after-close`, `dmh` → `during-session`, anything else (`""`, `null`, absent) → `unknown` | `EarningsEvent.timing` | [`earnings_events.timing`](../../database/tables/earnings_events.md) |
| `$.earningsCalendar[].symbol` | `earnings-refresh`: row filter only. `earnings-calendar-sync`: trimmed, `.` → `-` (`BH.A` → `BH-A`, the stock list's form); not `^[A-Z0-9][A-Z0-9.-]{0,15}$` → row skipped | `EarningsCalendarEvent.symbol` (`packages/contracts/src/earningsCalendar.ts`) | [`stock_earnings_calendar.symbol`](../../database/tables/stock_earnings_calendar.md) (only symbols of the owner's US stock list) |
| (runner clock) | Time the source batch started, ISO-8601 UTC | `fetchedAt` | [`watchlist_stocks.last_refreshed_at`](../../database/tables/watchlist_stocks.md), and `retrieved_at` on success or `NO_SCHEDULED_DATE` |
| HTTP status | Our code from section 4; the status unchanged | `errorCode`, `upstreamStatus` | [`watchlist_stocks.unavailable_code`](../../database/tables/watchlist_stocks.md), [`watchlist_stocks.unavailable_upstream_status`](../../database/tables/watchlist_stocks.md) |

A successful stock (dated or `NO_SCHEDULED_DATE`) replaces all its stored events; a failed one keeps them.

For `earnings-calendar-sync` the date, period and timing map as above into [`stock_earnings_calendar`](../../database/tables/stock_earnings_calendar.md) (one row per stock and period: the first row of the walk wins); a successful completion replaces the market's rows and [`stock_earnings_calendar_market`](../../database/tables/stock_earnings_calendar_market.md); a failed one stores nothing (the job keeps its code and Finnhub's status).

## 7. Maintenance

### Known differences between the runners

None in requests, parsing or mapping: both send the same URLs and headers, validate the same field types, filter and label rows alike, sort events by date with a stable sort (rows of one date keep Finnhub's order; vectors `finance/finnhub.json` pin it) and cut to 8 events. Transport only: both try up to 3 resolved addresses per request, while only the Rust runner reuses pooled HTTP/1.1 connections and re-sends a GET once on a fresh connection when a pooled one closes before answering (`crates/research-net/src/pinned.rs`); the TypeScript runner opens a fresh connection per request (`packages/adapters/src/node/pinnedConnect.ts`) and never re-sends.

### Open issues

- The free-plan limit (60 calls per minute) is published on Finnhub's pricing page, which renders only in a browser; it was confirmed through the live `X-Ratelimit-Limit` header, not the page text.
- 403 and 429 mappings follow Finnhub's documentation and have not been observed live.
- The 1,500-row cap of an answer without `symbol` is observed, not documented; a day with more announcements would lose some (reported in `truncatedDates`). The busiest day seen had 567.
- `packages/adapters/test/finance/finnhubEarnings.test.ts` uses bodies written from the documentation; the live answers in section 5 additionally show `hour: ""`, a name with a trailing period (`Apple Inc.`) and profile fields outside the swagger definition.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-13 | live | Calendar and profile shapes, header authentication, `{}` profile and empty calendar of an unknown symbol, 401 for an invalid key (`earningsLive.test.ts`) | Runner adapter work (FR-018) |
| 2026-10-31 | live | Both endpoints with the runner's exact URLs and headers over HTTP/2 and HTTP/1.1: AAPL profile, AAPL and MSFT calendars for `[2026-10-31, 2027-05-04]`, unknown symbol (`{}`, empty calendar), 401 `{"error":"Invalid API key"}`, rate-limit headers | Claude (ADR-0047 documentation) |
| 2026-10-31 | spec | Parameters, response definitions (`EarningRelease`, `CompanyProfile2`), `hour` values, authentication, 429 and the 30 calls/s cap against Finnhub's swagger.json | Claude (ADR-0047 documentation) |
| 2026-11-03 | live | The calendar without `symbol`: a 7-day window (exactly 1,500 rows, symbol order), single days (467, 567 and 1 rows), a window three months ahead (dates months out are listed), `BH.A`-style class symbols; the runner's headers over HTTP/1.1 | Claude (ADR-0068) |
