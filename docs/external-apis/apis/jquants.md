# External API: J-Quants

## 1. Overview

| Property | Value |
|---|---|
| Provider | JPX Market Innovation & Research (J-Quants, the Japan Exchange Group's official market-data API), API V2 |
| Purpose | (1) Daily bars — split-adjusted close, open, high, low and volume — of every TSE-listed stock in the owner's stock directory, for the Stocks page's Chart tab, the stock widgets on Home and in the Notebook and the chart viewer ([ADR-0058](../../adr/0058-every-stock-is-synced.md) §2). One request by date returns every listed issue's bar of that date (paginated); a request by code fills the history of a stock that has none, or that a split made inconsistent. (2) The annual financial statements of every Japanese directory company: the full-year earnings summaries (決算短信, TDnet XBRL) of one company per `financial-sync` job, stored as as-filed filings and facts behind the Stocks page's Financial statements tab and the financial statement widgets ([ADR-0059](../../adr/0059-japanese-statements-from-jquants.md) §2). (3) Company profiles — English name, 17- and 33-sector, scale category, market segment — of every listed issue, carried by the JP stock-directory refresh and shown on the Stocks page's Company tab (ADR-0059 §3). On the Free plan the data ends about 12 weeks before today. |
| Hosts | `api.jquants.com` |
| Endpoints | `GET /v2/equities/bars/daily` — daily stock prices ("Stock Prices (OHLC)"), asked either by `date` (all issues of one date) or by `code` with `from` / `to` (one issue's window), paginated by `pagination_key`; `GET /v2/fins/summary` — "Financial Data (Summary only)", asked by `code` (every earnings summary of one company in the plan's window), paginated by `pagination_key`; `GET /v2/equities/master` — "Listed Issue Master", asked with no parameters (every listed issue as of the plan's latest date), paginated by `pagination_key` |
| Authentication | Header `x-api-key: <key>` (V2's only scheme; the key never enters a URL or a log line). It is the third and last entry of the fetcher's fixed header allowlist (`SafeFetchOptions.xApiKey`, beside `authorization` and the Finnhub token). Env variable `JQUANTS_API_KEY` in `apps/runner/.env`: 8–200 printable ASCII characters without spaces, checked at start; issued on the J-Quants dashboard's API Keys screen. Without it the runner logs `market_source_disabled` (reason `JQUANTS_API_KEY not set`) once, every JP `stock-prices-sync` job fails `SOURCE_NOT_CONFIGURED` and every JP `financial-sync` job `FINANCIAL_SOURCE_NOT_CONFIGURED`, each without a request, and JP stock-directory refreshes carry `profiles: null` (ADR-0059 §5). |
| Configuration | In `apps/runner/.env` (`apps/runner/src/config.ts`, `crates/research-runner/src/config.rs`): `JQUANTS_REQUESTS_PER_MINUTE`, request starts per minute of the prices and the master, integer 1–600, default 3 (below the Free plan's published 5, which J-Quants did not sustain when measured — see Usage Limits); `JQUANTS_DELAY_DAYS`, how many days the plan is behind, integer 0–365, default 84 (Free: 12 weeks; 0 on a paid plan; the prices only). The earnings summaries' pace is fixed at the endpoint's own 60 a minute (not configurable). |
| Usage Limits | Free plan: 5 requests per minute per account, evaluated in a one-minute sliding window, a `429` counted too, "basic limit values [that] may be adjusted depending on system conditions"; "significantly" exceeding it may block all requests for about 5 minutes ([Rate Limits](https://jpx-jquants.com/en/spec/rate-limits)). Measured on 2026-11-02 (Verification log): 5 back-to-back requests and a sixth 65 s later were answered, the seventh (68.7 s) was refused `429`; evenly spaced at 13 s (5 a minute) the seventh (78 s) was refused too; at one per 20 s, nine requests in 160 s were all answered — the observed limit is about 6 requests per 120 s, not 5 per 60 s. Stock prices: "2 years History [12 weeks delayed]" on Free, 5 / 10 / 20 years on Light / Standard / Premium ([data storage by plan](https://jpx-jquants.com/en/spec/data-spec)); updated daily around 16:30 JST ([update timing](https://jpx-jquants.com/en/spec/data-update)). Ours: `JQUANTS_REQUESTS_PER_MINUTE` request starts per 65 s, evenly spaced (one start per 65 s / the rate: 21.7 s at the default 3), under the pacer key `jquants`, one grant per request and per page; at most 10 dates and 10 requested windows per job (`STOCK_PRICE_LIMITS`), split refetches sharing that cap; at most 20 pages per query; no daily budget; no cache. The master (one request a JP directory refresh, 4,444 records in one page, 1.6 s, measured 2026-11-02) paces under `jquants` too. **Earnings summaries** (`/v2/fins/summary`) have their own limit, 60 requests a minute "regardless of your plan", "evaluated against a dedicated limit separate from the plan limit" ([Rate Limits by Endpoint](https://jpx-jquants.com/en/spec/rate-limits)); measured on 2026-11-02, eight requests in 1.4 s were all answered while the plan limit refused the prices' 7th request within about 120 s. Ours: 60 starts per 65 s, evenly spaced (one per 1,084 ms), under the separate pacer key `jquants-fins`; one request per company (8–13 records, one page, about 0.2 s); "2 years History [12 weeks delayed]" on Free, about two fiscal years of annual figures ([data storage by plan](https://jpx-jquants.com/en/spec/data-spec)). |
| Called By | Rust runner (default) and TypeScript runner (rollback): `stock-prices-sync` jobs of market `JP` (bars), `financial-sync` jobs of provider `jquants` (summaries) and `stock-directory-refresh` jobs of market `JP` (master), all queued by the API at claim time (ADR-0058 §2 "Scheduling", ADR-0058 §3, ADR-0034). The API Worker and the browser never call J-Quants; `https://jpx-jquants.com/` is only stored as the attribution link, and a summary's query URL as its filing's source link (section 6). |
| Code | `crates/research-finance/src/jquants.rs`, `crates/research-finance/src/jquants_financials.rs`, `crates/research-finance/src/stock_prices.rs`, `crates/research-finance/src/pacing.rs`, `packages/adapters/src/finance/jquantsFinancials.ts`, `packages/adapters/src/finance/equitySync.ts`, `packages/contracts/src/equityFinancials.ts`, `packages/contracts/src/stockCompanyProfile.ts`, `packages/domain/src/finance/financialStatements.ts`, `crates/research-contracts/src/stock_prices.rs`, `crates/research-runner/src/config.rs`, `crates/research-net/src/core.rs`, `packages/adapters/src/finance/jquants.ts`, `packages/adapters/src/finance/stockPrices.ts`, `packages/adapters/src/finance/marketFetch.ts`, `packages/adapters/src/worker/safeFetchCore.ts`, `packages/adapters/src/node/pinnedConnect.ts`, `apps/runner/src/jobExecution.ts`, `apps/runner/src/main.ts`, `apps/runner/src/config.ts`, `apps/runner/src/marketPacing.ts`, `packages/contracts/src/stockPrices.ts`, `packages/application/src/stockPrices.ts`, `packages/adapters/src/sql/stockPrices.ts` |
| Official Documentation | [Stock Prices (OHLC) `/equities/bars/daily`](https://jpx-jquants.com/en/spec/eq-bars-daily), [Financial Data (Summary only) `/fins/summary`](https://jpx-jquants.com/en/spec/fin-summary), [Listed Issue Master `/equities/master`](https://jpx-jquants.com/en/spec/eq-master), [Response Status](https://jpx-jquants.com/en/spec/response-status), [Rate Limits](https://jpx-jquants.com/en/spec/rate-limits), [APIs and Data Storage Period by Subscription](https://jpx-jquants.com/en/spec/data-spec), [Update Timing of Provided Data](https://jpx-jquants.com/en/spec/data-update), [Migration from V1 to V2](https://jpx-jquants.com/en/spec/migration-v1-v2), [Quickstart](https://jpx-jquants.com/en/spec/quickstart) |
| Last Verified | 2026-11-02, live (summaries, master, errors, rate limits; Python `urllib` probe with the owner's key) and spec (bars examples) (section 7) |

The API plans each JP job (`planStockPrices`, `packages/application/src/stockPrices.ts`): up to 10 due weekdays of the last 730 days (Asia/Tokyo dates), newest first; only when no day is due, up to 10 directory stocks with no stored price series, each over the whole window; and `adjustmentsSince`, the newest stored day before the job. The runner (`syncStockPrices`, `packages/adapters/src/finance/stockPrices.ts`) reports a day newer than today minus `JQUANTS_DELAY_DAYS` as `not-yet-available` without a request, asks every other day by `date` (all pages), maps each 5-character `Code` to the directory's 4-character code and reports the day's outcome; then fetches each requested stock's window by `code` (its end clamped to today minus the delay); then refetches the window of every code whose record of a stored day newer than `adjustmentsSince` has `AdjFactor ≠ 1` (reason `split`). The `stock-prices-synced` completion goes to the API, which stores the bars of directory stocks only, under each stock's existing price series id (section 6).

A JP company's `financial-sync` claim names its 5-character code and the disclosure numbers (`DiscNo`) of its stored filings (`jquantsSyncRequestSchema`). The runner (`createJquantsFinancialsSource`, `packages/adapters/src/finance/jquantsFinancials.ts`; `crates/research-finance/src/jquants_financials.rs`) asks `GET /v2/fins/summary?code=` (every page), keeps the full-year summaries and turns each one not stored yet into a filing with its facts (`jquantsSummariesToSync`, section 6); the API stores them as as-filed history (ADR-0048 §5). The JP `stock-directory-refresh` job, after the JPX list ([JPX](jpx.md)), asks `GET /v2/equities/master` and sends the profiles of the common stocks (`jquantsMasterToProfiles`) with the list; the API keeps those of directory symbols in `stock_company_profile`.

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

### GET /v2/fins/summary

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `code` | query | string | Yes (we never send `date`) | — ; we send the claim's `code`, the directory symbol with `0` appended (`jquantsIssueCode`: `7974` → `79740`, `130A` → `130A0`) | 5 characters `[0-9][0-9A-Z]{3}0` (the claim's schema); J-Quants accepts 4 or 5 (a 400 otherwise) | Every earnings summary of the issue within the plan's window. |
| `date` | query | string | No | Not sent | — | Disclosure date; the source link of each filing names it (section 6), the request never does. |
| `pagination_key` | query | string | No | Not sent on the first page; then the previous page's `pagination_key`, as given | Opaque | Next page; followed until absent, `null` or empty, at most 20 pages (a 21st → `FINANCIAL_PARSE_FAILED`). |
| `x-api-key`, `Accept`, `User-Agent`, `Accept-Encoding` | header | string | — | As for `/v2/equities/bars/daily` | — | — |

### GET /v2/equities/master

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `code` | query | string | No | Not sent | — | Not used: the refresh wants every issue. |
| `date` | query | string | No | Not sent: J-Quants answers "as of the day when API is executed" (on Free, the newest date of the plan's window, about 12 weeks ago) | — | Not used. |
| `pagination_key` | query | string | No | Not sent on the first page; then the previous page's value | Opaque | Followed until absent, at most 20 pages (more → the profiles are `null`). One page measured. |
| `x-api-key`, `Accept`, `User-Agent`, `Accept-Encoding` | header | string | — | As for `/v2/equities/bars/daily` | — | — |

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

### GET /v2/fins/summary

`application/json`, one object: `data`, an array of one record per disclosure (sorted by `DiscNo`, which "does not guarantee the order of disclosure"), and `pagination_key` when more pages follow. Every item is a string; an item the disclosure does not state is `""`. Monetary items are in yen "regardless of the display unit" of the report. Only the fields below are read; the others (per-share figures, dividends, forecasts, share counts, flags — about 100) are not.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.data` | array | No | No | Yes | Records; `[]` when the issue has no summary in the window (ETFs, REITs without XBRL, unknown codes — measured: `code=99999`). Not an array → `FINANCIAL_PARSE_FAILED`. |
| `$.data[].DocType` | string | No | No | Yes | Type of document. Only `FYFinancialStatements_…` (full-year results: `…_Consolidated_JP`, `…_Consolidated_IFRS`, `…_Consolidated_US`, `…_NonConsolidated_JP`, …) is kept; quarterly (`1Q…`–`3Q…`), `EarnForecastRevision` and `DividendForecastRevision` records carry no annual actuals and are skipped. The suffix after the last `_` names the standard; `_NonConsolidated_` makes the plain items non-consolidated. |
| `$.data[].DiscNo` | string | No | No | Yes | Disclosure number, 14 digits: the filing's permanent id. A correction gets a new number. Not 14 digits → record skipped. |
| `$.data[].DiscDate`, `.DiscTime` | string | No | No | Yes | TDnet disclosure date (`YYYY-MM-DD`) and time (`HH:MM:SS`, seconds always `00`), Japan time. An invalid date → record skipped; a time not `HH:MM:SS` → `submittedAt` null. |
| `$.data[].Code` | string | No | No | No | The 5-character code asked. |
| `$.data[].CurPerType` | string | No | No | No | `1Q`…`FY`; the `DocType` decides. |
| `$.data[].CurPerSt`, `.CurPerEn` | string | No | No | Yes | The period the figures cover (the fiscal year for a full-year record). Not calendar dates, or start after end → record skipped. |
| `$.data[].CurFYSt`, `.CurFYEn` | string | No | No | Yes | The fiscal year; with `CurFYSt` the key that groups a summary with its corrections. Not calendar dates, or start after end → record skipped. |
| `$.data[].Sales`, `.OP`, `.OdP`, `.NP`, `.CFO`, `.CFI`, `.CFF` | string | No | No | Yes | Net sales, operating profit, ordinary profit (JGAAP only; `""` for IFRS and US-GAAP), profit attributable to owners of the parent, the three cash flows, for `CurPerSt`–`CurPerEn`. `""` or not a plain decimal → no fact. |
| `$.data[].TA`, `.Eq`, `.CashEq` | string | No | No | Yes | Total assets, equity, cash and equivalents at `CurPerEn`. |
| `$.data[].NCSales`, `.NCOP`, `.NCOdP`, `.NCNP`, `.NCTA`, `.NCEq` | string | No | No | Yes | The non-consolidated values of a consolidated filer; `""` for a non-consolidated filer (not read for its `_NonConsolidated_` records). |
| `$.pagination_key` | string | No | Yes | Yes | Present when more pages follow. |

### GET /v2/equities/master

`application/json`, one object: `data`, one record per listed issue (common and preferred lines, ETFs, REITs and TOKYO PRO MARKET issues; 4,444 measured), and `pagination_key` when more pages follow. Every item is a string.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.data` | array | No | No | Yes | Records. Not an array → profiles `null` (`PARSE_FAILED`). |
| `$.data[].Date` | string | No | No | Yes | The date the information applies to (`YYYY-MM-DD`; on Free about 12 weeks ago, the same for every record). Not a calendar date → record skipped. |
| `$.data[].Code` | string | No | No | Yes | 5-character issue code; only codes ending in `0` (the common stock) are kept, as the directory symbol (the first four characters). Preferred lines (`25935`) are dropped. |
| `$.data[].CoName` | string | No | No | No | Japanese name (the directory has it from JPX). |
| `$.data[].CoNameEn` | string | No | No | Yes | English name; `""` → `nameEn` null. |
| `$.data[].S17`, `.S17Nm` | string | No | No | Yes | TSE 17-sector code and Japanese name (`99` / `その他` for ETFs and REITs). |
| `$.data[].S33`, `.S33Nm` | string | No | No | Yes | TSE 33-sector code and Japanese name. |
| `$.data[].ScaleCat` | string | No | No | Yes | TOPIX scale category (`TOPIX Core30`, `TOPIX Large70`, `TOPIX Mid400`, `TOPIX Small 1`, `TOPIX Small 2`), `-` when none → null. |
| `$.data[].Mkt`, `.MktNm` | string | No | No | Yes | Market segment code and Japanese name (`0111` プライム, `0112` スタンダード, `0113` グロース, `0105` TOKYO PRO MARKET, `0109` その他). |
| `$.data[].Mrgn`, `.MrgnNm` | string | No | No | No | Margin trading classification. |
| `$.data[].ProdCat` | string | No | No | No | Product category. |
| `$.pagination_key` | string | No | Yes | Yes | Present when more pages follow (none measured). |

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

**Earnings summaries** (`financial-sync`, ADR-0059 §2; `createJquantsFinancialsSource`, the status mapping of `equitySyncFailureOfFetch` with a 400 of its own). The body is not read. The job's failure carries J-Quants' status unchanged.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | A code that is not 4 or 5 characters (measured: `{"message": "'code' must be 4 or 5 characters."}`) — the API never builds one | The job fails, not retried | `FINANCIAL_PARSE_FAILED` |
| 401, 403 | Rejected or expired key, or a plan refusal | The job fails, not retried | `FINANCIAL_ACCESS_DENIED` |
| 429 | Over the endpoint's 60 a minute | The job fails, retryable; the runner holds `jquants-fins` for 120 s | `FINANCIAL_RATE_LIMITED` |
| 404, 500, any other | — | The job fails, retryable | `FINANCIAL_SOURCE_FAILED` |
| 200, `data: []` | No summary of the issue in the window | Success with no filings; the API checks the company again after `notFoundRetryDays` (30) | — |
| 200 with an unexpected shape, more than 20 pages, a body over the cap | — | The job fails, not retried, no status | `FINANCIAL_PARSE_FAILED` |
| — | Timeout, network error, redirect off `api.jquants.com`, the job stopped while waiting for its pacing grant | The job fails, retryable, no status | `FINANCIAL_SOURCE_FAILED` |
| — | `JQUANTS_API_KEY` not set | The job fails before any request | `FINANCIAL_SOURCE_NOT_CONFIGURED` |

**Listed Issue Master** (JP `stock-directory-refresh`, ADR-0059 §3; `createJquantsProfileSource`). A failure never fails the job: the directory is stored, the completion carries `profiles: null` (the stored profiles stay) and the runner logs `company_profiles_failed` with a code — `ACCESS_DENIED` (401, 403), `RATE_LIMITED` (429; `jquants` is held 120 s), `PARSE_FAILED` (an unexpected shape, more than 20 pages, a body over the cap) or `SOURCE_FAILED` (any other status, a transport failure, a stopped job) — and J-Quants' status unchanged. A success logs `company_profiles_fetched` with the profile and request counts.

### Provider error codes and body

`{"message": "<text>"}`, "not guaranteed to always be included". No error codes besides the HTTP status. The 403 causes listed by J-Quants: the invalid-or-expired key message, a plan that does not include the data, and an incorrect URL or HTTP method.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s per request (connection, redirects, body); body cap 8,000,000 bytes per page (also for an error body); at most 5 redirects, each on `api.jquants.com`, without `x-api-key`. The same for all three endpoints (the master's one page measured 1.67 MB). | `packages/adapters/src/finance/jquants.ts`, `packages/adapters/src/finance/jquantsFinancials.ts`, `crates/research-finance/src/jquants.rs`, `crates/research-finance/src/jquants_financials.rs` |
| Retries | None per request, except the one window retry after a 403. Transport only: up to 3 resolved addresses per request; the Rust runner re-sends a GET once when a pooled connection closed before answering. An unanswered day is asked by a later job (`planSyncDays`). | `packages/adapters/src/finance/stockPrices.ts`, `crates/research-net/src/pinned.rs` |
| Rate limit | No header read (J-Quants sends no `Retry-After`). `JQUANTS_REQUESTS_PER_MINUTE` (default 3) starts per 65 s under the pacer key `jquants`, evenly spaced — one start per 65 s / the rate (21,667 ms at 3), never a burst: a minute's requests at once followed by the next minute's were refused well below the published rate (Usage Limits). At the default, any 120 s holds at most 6 starts. The minute is 65 s because J-Quants counts arrivals and we count starts (pooled connections arrive faster than they start). Shared across jobs for the runner's lifetime, in process only (a restarted runner starts with no history and no hold); every page counts; after a `429` the key is held 120 s. Requests are sequential. A 429 ends the job's fetching. | `apps/runner/src/marketPacing.ts`, `apps/runner/src/main.ts`, `crates/research-finance/src/pacing.rs` |
| Rate limit (summaries) | 60 starts per 65 s under `jquants-fins`, one per 1,084 ms (`JQUANTS_FINS_RATE_LIMIT` = `stockPriceRateLimit(60)`), always present, separate from `jquants`; held 120 s after a 429. A company is one request, so about 3,700 Japanese companies take about an hour at this pace. | `apps/runner/src/marketPacing.ts`, `apps/runner/src/jobExecution.ts`, `crates/research-finance/src/pacing.rs` |
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

### GET /v2/fins/summary

Every earnings summary of one company (JT, `2914` in the directory):

```http
GET /v2/fins/summary?code=29140 HTTP/1.1
Host: api.jquants.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
x-api-key: <JQUANTS_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-11-02, Python urllib probe (orchestrator). Query as `createJquantsFinancialsSource` builds it.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: jquants-fins-summary -->
```json
{
  "data": [
    {
      "DiscDate": "2024-10-31",
      "DiscTime": "15:00:00",
      "Code": "29140",
      "DiscNo": "20241030505788",
      "DocType": "3QFinancialStatements_Consolidated_IFRS",
      "CurPerType": "3Q",
      "CurPerSt": "2024-01-01",
      "CurPerEn": "2024-09-30",
      "CurFYSt": "2024-01-01",
      "CurFYEn": "2024-12-31",
      "Sales": "2393278000000",
      "OP": "636629000000",
      "OdP": "",
      "NP": "442414000000",
      "TA": "6946032000000",
      "Eq": "3972067000000",
      "CashEq": "794847000000",
      "CFO": "392015000000",
      "CFI": "-142640000000",
      "CFF": "-439420000000",
      "NCSales": "",
      "NCOP": "",
      "NCOdP": "",
      "NCNP": "",
      "NCTA": "",
      "NCEq": ""
    },
    {
      "DiscDate": "2025-02-13",
      "DiscTime": "15:30:00",
      "Code": "29140",
      "DiscNo": "20250212569311",
      "DocType": "FYFinancialStatements_Consolidated_IFRS",
      "CurPerType": "FY",
      "CurPerSt": "2024-01-01",
      "CurPerEn": "2024-12-31",
      "CurFYSt": "2024-01-01",
      "CurFYEn": "2024-12-31",
      "Sales": "3149759000000",
      "OP": "697203000000",
      "OdP": "",
      "NP": "463369000000",
      "TA": "8281118000000",
      "Eq": "4132856000000",
      "CashEq": "1084567000000",
      "CFO": "630011000000",
      "CFI": "-439766000000",
      "CFF": "-94906000000",
      "NCSales": "530247000000",
      "NCOP": "-6076000000",
      "NCOdP": "404377000000",
      "NCNP": "404849000000",
      "NCTA": "2303789000000",
      "NCEq": "1214895000000"
    },
    {
      "DiscDate": "2025-03-10",
      "DiscTime": "15:30:00",
      "Code": "29140",
      "DiscNo": "20250310590632",
      "DocType": "FYFinancialStatements_Consolidated_IFRS",
      "CurPerType": "FY",
      "CurPerSt": "2024-01-01",
      "CurPerEn": "2024-12-31",
      "CurFYSt": "2024-01-01",
      "CurFYEn": "2024-12-31",
      "Sales": "3149759000000",
      "OP": "323461000000",
      "OdP": "",
      "NP": "179240000000",
      "TA": "8370732000000",
      "Eq": "3848727000000",
      "CashEq": "1084567000000",
      "CFO": "630011000000",
      "CFI": "-439766000000",
      "CFF": "-94906000000",
      "NCSales": "530247000000",
      "NCOP": "-6076000000",
      "NCOdP": "404377000000",
      "NCNP": "404849000000",
      "NCTA": "2303789000000",
      "NCEq": "1214895000000"
    }
  ]
}
```

Verified: live, 2026-11-02, Python urllib probe (orchestrator). Trimmed: the first 3 of the answer's 9 records (one page, no `pagination_key`), each to the fields the runner reads; every other field omitted. The 3Q summary is skipped; the FY2024 summary of 2025-02-13 and its correction of 2025-03-10 (operating profit 697,203,000,000 → 323,461,000,000 yen) become an `earnings-report` and an `amended-earnings-report`.

No summary for the code (an ETF, a REIT without XBRL, an unknown code):

```http
GET /v2/fins/summary?code=99999 HTTP/1.1
Host: api.jquants.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
x-api-key: <JQUANTS_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-11-02, Python urllib probe (orchestrator).

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: jquants-fins-summary-empty -->
```json
{
  "data": []
}
```

Verified: live, 2026-11-02, Python urllib probe (orchestrator). Complete answer.

### GET /v2/equities/master

Every listed issue, as of the plan's latest date:

```http
GET /v2/equities/master HTTP/1.1
Host: api.jquants.com
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
x-api-key: <JQUANTS_API_KEY>
Accept-Encoding: gzip
```

Verified: live, 2026-11-02, Python urllib probe (orchestrator). No query, as `createJquantsProfileSource` builds it.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: jquants-equities-master -->
```json
{
  "data": [
    {
      "Date": "2026-08-10",
      "Code": "72030",
      "CoName": "トヨタ自動車",
      "CoNameEn": "TOYOTA MOTOR CORPORATION",
      "S17": "6",
      "S17Nm": "自動車・輸送機",
      "S33": "3700",
      "S33Nm": "輸送用機器",
      "ScaleCat": "TOPIX Core30",
      "Mkt": "0111",
      "MktNm": "プライム",
      "Mrgn": "2",
      "MrgnNm": "貸借",
      "ProdCat": "011"
    },
    {
      "Date": "2026-08-10",
      "Code": "130A0",
      "CoName": "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
      "CoNameEn": "Veritas In Silico Inc.",
      "S17": "5",
      "S17Nm": "医薬品",
      "S33": "3250",
      "S33Nm": "医薬品",
      "ScaleCat": "-",
      "Mkt": "0113",
      "MktNm": "グロース",
      "Mrgn": "1",
      "MrgnNm": "信用",
      "ProdCat": "011"
    },
    {
      "Date": "2026-08-10",
      "Code": "25935",
      "CoName": "伊藤園（優先株式）",
      "CoNameEn": "ITO EN,LTD. (shares of preferred stock)",
      "S17": "1",
      "S17Nm": "食品",
      "S33": "3050",
      "S33Nm": "食料品",
      "ScaleCat": "-",
      "Mkt": "0111",
      "MktNm": "プライム",
      "Mrgn": "2",
      "MrgnNm": "貸借",
      "ProdCat": "011"
    }
  ]
}
```

Verified: live, 2026-11-02, Python urllib probe (orchestrator). Trimmed: 3 of the 4,444 records (one page, no `pagination_key`), verbatim — Toyota, Veritas In Silico (a letter in its code, scale category `-`) and ITO EN's preferred line (`25935`, dropped).

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

A summaries code that is not 4 or 5 characters (`GET /v2/fins/summary?code=abc`; the API never sends one):

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

<!-- example: jquants-error-invalid-code -->
```json
{
  "message": "'code' must be 4 or 5 characters."
}
```

Verified: live, 2026-11-02, Python urllib probe (orchestrator). Complete body.

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

**Earnings summaries → statements** (ADR-0059 §2). Contract: `financial-synced` (`equitySyncCompletionShape`, `packages/contracts/src/equityFinancials.ts`; Rust `crates/research-contracts/src/equity_financials.rs`); the runner's pure `jquantsSummariesToSync` (`packages/adapters/src/finance/jquantsFinancials.ts`, mirrored by `crates/research-finance/src/jquants_financials.rs`, conformance vectors `vectors/finance/jquants_financials.json`). The API stores it as for SEC (`packages/application/src/equitySync.ts`, `packages/adapters/src/sql/equitySync.ts`).

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| (the records) | Kept: `DocType` starting `FYFinancialStatements_` with a 14-digit `DiscNo` and calendar dates (section 3). Ordered by (`DiscDate`, `DiscTime`, `DiscNo`) as text. The first of a fiscal year (`CurFYSt`, `CurFYEn`) is an `earnings-report`; each later one an `amended-earnings-report` amending the record before it — a correction, which J-Quants marks no other way ("sort the records for the same issue and the same accounting period by disclosure date and time"). Decided over every kept record, stored ones included; a record whose `DiscNo` the claim lists in `knownDisclosures` (or that appeared earlier in the answer) gives no filing | `EquityFilingResult.form`, `.amendsSourceDocumentId` | [`equity_report_filing`](../../database/tables/equity_report_filing.md) `form`, `amends_source_document_id` |
| `DiscNo` | As is | `sourceDocumentId` | `equity_report_filing.source_document_id` |
| `DiscDate` | As is | `filedOn` | `equity_report_filing.filed_on` |
| `DiscDate` + `DiscTime` | Asia/Tokyo (UTC+9) → UTC ISO-8601 with milliseconds (`2025-02-13` `15:30:00` → `2025-02-13T06:30:00.000Z`); a time not `HH:MM:SS` → null | `submittedAt` | `equity_report_filing.submitted_at` |
| `CurFYSt`, `CurFYEn` | As is | `periodStart`, `periodEnd` | `equity_report_filing` `period_start`, `period_end` |
| `DocType` suffix | `_JP` → `JGAAP`, `_IFRS` → `IFRS`, `_US` → `US-GAAP`, any other (e.g. `_JMIS`) → null | `accountingStandard` | `equity_report_filing.accounting_standard` |
| `Code`, `DiscDate` | `https://api.jquants.com/v2/fins/summary?code=<code>&date=<DiscDate>` — the query that answers the record (J-Quants keeps no public document page; opening it needs the key) | `sourceUrl` | `equity_report_filing.source_url` |
| — | `extracted` (the answer holds the figures) | `factsStatus` | `equity_report_filing` |
| `Sales`, `OP`, `OdP`, `NP`, `CFO`, `CFI`, `CFF` | One fact per stated item: concept `jquants:<Item>`, unit `JPY`, duration `CurPerSt`–`CurPerEn`. Value: a plain decimal (`[+-]?digits[.digits]`), a leading `+` and leading zeros dropped, trailing fractional zeros dropped, `-0` → `0`; `""` or anything else → no fact. Scope `consolidated`, or `separate` in a `_NonConsolidated_` record | `EquityExtractedFact` | [`equity_reported_fact`](../../database/tables/equity_reported_fact.md) |
| `TA`, `Eq`, `CashEq` | As above, instant at `CurPerEn` | `EquityExtractedFact` | `equity_reported_fact` |
| `NCSales`, `NCOP`, `NCOdP`, `NCNP`, `NCTA`, `NCEq` | Of a consolidated record only: the same concept without `NC` (`NCSales` → `jquants:Sales`), scope `separate`, period as its plain item | `EquityExtractedFact` | `equity_reported_fact` |
| (the facts) | Canonical order (`compareFacts`); the completion caps keep the newest filings (`fitCompletionCaps`: 60 filings, 3,000 facts), `more` when any was cut | `filings`, `more` | — |
| `Code`, newest `CurFYEn` | `sourceCompanyId` = the asked code, `name` null, `fiscalYearEnd` = `MM-DD` of the greatest `CurFYEn` of the kept records; the identity is null when there is none | `identity` | [`equity_company`](../../database/tables/equity_company.md) `source_company_id`, `fiscal_year_end` |

The metrics read the facts through `EQUITY_CONCEPT_MAPPINGS` (provider `jquants`, reviewed for `JGAAP`, `IFRS` and `US-GAAP`; `packages/domain/src/finance/financialStatements.ts`): revenue `jquants:Sales`, operating income `jquants:OP`, ordinary income `jquants:OdP` (JGAAP only), profit attributable to owners `jquants:NP`, total assets `jquants:TA`, total equity `jquants:Eq`, cash and cash equivalents `jquants:CashEq`, the three cash flows `jquants:CFO` / `CFI` / `CFF`, into [`equity_metric_value`](../../database/tables/equity_metric_value.md). Gross profit, total liabilities and capital expenditures are `not-reported` for J-Quants filings and free cash flow `not-derivable`: the summaries have no such items. A J-Quants completion carries no business description.

**Listed Issue Master → company profiles** (ADR-0059 §3). Contract: `stockCompanyProfileSchema` (`packages/contracts/src/stockCompanyProfile.ts`; Rust `crates/research-contracts/src/stock_company_profile.rs`) in the JP `stock-directory-refreshed` completion's `profiles`; the runner's pure `jquantsMasterToProfiles` (vectors `vectors/finance/jquants_profiles.json`). A record is skipped when it is not an object, lacks a field below, or its profile does not pass the schema (an empty required value, a malformed code or date); of a symbol seen twice the first valid record is kept. Values are copied as J-Quants states them. The API replaces the market's rows with them, keeping directory symbols only (a null `profiles` keeps the stored rows).

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `Code` | Kept only when 5 characters ending in `0`; the first four | `symbol` | [`stock_company_profile`](../../database/tables/stock_company_profile.md) `symbol` |
| `CoNameEn` | `""` → null | `nameEn` | `stock_company_profile` |
| `S17`, `S17Nm` | As is | `sector17Code`, `sector17Name` | `stock_company_profile` |
| `S33`, `S33Nm` | As is | `sector33Code`, `sector33Name` | `stock_company_profile` |
| `ScaleCat` | `-` → null | `scaleCategory` | `stock_company_profile` |
| `Mkt`, `MktNm` | As is | `marketSegmentCode`, `marketSegmentName` | `stock_company_profile` |
| `Date` | Must be a calendar date | `asOf` | `stock_company_profile` |
| — | The completion's `fetchedAt` | — | `stock_company_profile.retrieved_at` |

The unadjusted items (`O H L C Vo`) are not stored: the adjusted series keeps a stock's chart continuous across splits, and a later split rewrites the stored window.

## 7. Maintenance

### Known differences between the runners

None intended: the Rust runner (`crates/research-finance/src/jquants.rs`, `crates/research-finance/src/stock_prices.rs`) mirrors the TypeScript query order, code mapping, Tokyo dates, delay rule, bar checks, page cap and status mapping, including the case-insensitive "api key" test on a 403 body; `crates/research-finance/src/jquants_financials.rs` mirrors `jquantsSummariesToSync`, `jquantsMasterToProfiles` and the summaries' status mapping (conformance vectors `vectors/finance/jquants_financials.json`, `jquants_profiles.json`, `equity_sync_sources.json`, `equity_sync_jobs.json`). Transport only, as for every provider: the Rust runner reuses pooled connections and may re-send a GET once; the TypeScript runner opens a fresh connection per request.

### Open issues

- The bars examples in section 5 are `spec`; only the date query's answer shape (about 4,400 records, no `pagination_key`, for one date) and the rate limit were observed live (Verification log). The summaries and master examples are live.
- Summaries: a correction is recognised only as a later full-year record of the same (`CurFYSt`, `CurFYEn`); J-Quants has no correction flag. A change of fiscal year end gives a new fiscal year, not a correction. A summary disclosed with a non-XBRL PDF only is not in the API.
- Summaries are earnings summaries (決算短信), not the audited annual securities report; Free keeps about two fiscal years. Gross profit, liabilities and capital expenditure are not among the items.
- The summaries' own 60-a-minute limit was observed only as far as 8 requests in 1.4 s; a 429 holds `jquants-fins` 120 s.
- The master's English names, sectors and segments are as of the plan's latest date (about 12 weeks ago on Free); a newly listed issue has no profile until it appears there.
- The Free plan's rate limit is lower than published (about 6 requests per 120 s, measured 2026-11-02) and "may be adjusted": if J-Quants changes it, `JQUANTS_REQUESTS_PER_MINUTE` follows (a 429 still ends the job, holds the key 120 s and loses nothing — the unanswered days are planned again).
- The answer of the Free plan for a date or window outside its storage period (12 weeks to 2 years 12 weeks ago) is not observed: a 403 (handled by the day-age rule) or an empty `data` (a day more than the delay + 3 days old would then be recorded `no-trading`, not `too-old`; both are final).
- The Free plan's exact delay: J-Quants says "12 weeks delayed"; `JQUANTS_DELAY_DAYS` 84 assumes calendar days counted from today in Tokyo. A day just inside the edge may be answered empty and retried as `not-yet-available` until it settles.
- The 403 split between a key problem and a plan refusal relies on the documented message text containing "api key"; a 403 without a body is treated as a plan refusal.
- J-Quants documents status 210 (No Content (Partial)) for some other APIs; if this endpoint ever sends it without a `data` array, the job fails `SOURCE_FAILED`.
- J-Quants recommends its bulk file download for daily bars of thousands of issues; the date query (one request per day, paginated) stays within the documented API use.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-11-02 | spec | `GET /v2/equities/bars/daily` against the Stock Prices (OHLC) reference (parameters, `x-api-key`, combinations, data items, null and Premium-only rules, sample), Response Status (codes, 403 causes, empty answer, error body), Rate Limits (Free 5 per minute, sliding window, no `Retry-After`), data storage by plan (Free: 2 years, 12 weeks delayed), update timing (16:30) and the V1-to-V2 migration (endpoint, header). Section 5 bodies parsed by `packages/adapters/test/finance/jquantsDocExamples.test.ts`. | W1 / Claude (ADR-0058 documentation) |
| 2026-11-02 | live | `GET /v2/fins/summary?code=` for 7203 (IFRS), 1301 (JGAAP), 2914 (IFRS, with a correction), 4385 (IFRS, with an `EarnForecastRevision`), 6758 (IFRS), 7974 (JGAAP), 8306 (JGAAP bank, no `OP`), 8604 (US-GAAP), 9984 (IFRS, with a correction): one page each, 8–13 records, about 0.2 s; `code=99999` → `{"data": []}`; `code=abc` → 400 `{"message": "'code' must be 4 or 5 characters."}`; `?date=2026-05-14` → 758 records incl. `FYFinancialStatements_NonConsolidated_JP`. Eight summaries requests in 1.4 s were all answered (the endpoint's own limit). `GET /v2/equities/master` (no parameters) → 4,444 records in one page (1.67 MB, 1.6 s), all dated 2026-08-10; 7 non-`0` codes (preferred lines); `ScaleCat` `-` on 2,807. Section 5 summaries, master and invalid-code examples trimmed from these answers; parsed by `packages/adapters/test/finance/jquantsDocExamples.test.ts`. | Orchestrator (Python `urllib` probe) / W2 (ADR-0059 documentation) |
| 2026-11-02 | live | Rate limit of the Free plan with the owner's key, `GET /v2/equities/bars/daily?date=` (2025 dates) from a Python `urllib` probe while the runner sent nothing: bursts of 5 then one per 65 s → 429 on the 7th request at 68.7 s; one per 13 s → 429 on the 7th at 78 s; one per 20 s → 9 of 9 answered `200`. Each date answered in one page (4,404–4,413 records, no `pagination_key`), 2.2–3.6 s per request; the 429 body is `{"message": "Rate limit exceeded. Please try again later."}`. The runner's jobs at 5 a minute had ended `rate-limited` on almost every job (dev runner log, 00:33–02:33 UTC). Default lowered to 3 a minute, evenly spaced. | Claude (rate-limit fix) |
