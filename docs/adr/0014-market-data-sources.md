# ADR-0014: Market-data vendors for the Home dashboard (FRED + Twelve Data)

**Status:** Accepted · **Date:** 2026-10-13

## Context

The Home dashboard (FR-017) must show real market numbers — prices, yields,
economic indicators — with unit, as-of date and source link, or an explicit
"unavailable (reason)". Nothing may be fabricated, so every displayed number
needs a licensed source fetched on request. The architecture keeps vendors
behind source-neutral ports and marks uncovered metrics unavailable
(section 13, "Market data vendors" — this ADR resolves that item). The owner
decided the data comes from two official keyed APIs fetched by the local
runner, never by the browser.

## Decision

**Two vendors, each where it is authoritative.** FRED
(`https://api.stlouisfed.org`) covers US official series (VIX, Treasury
yields, CPI, unemployment, GDP, S&P 500, …). Twelve Data
(`https://api.twelvedata.com`) covers listed equities (AAPL, MSFT, NVDA),
gold (`XAU/USD`) and FX (`EUR/USD`, `USD/JPY`). The curated catalog
(`packages/application/src/marketCatalog.ts`) holds only id, label, category
and a one-line description — units and values always come from the provider
at refresh time.

**Keys live in the runner environment only** (`FRED_API_KEY`,
`TWELVE_DATA_API_KEY` in `apps/runner/.env`, commented lines in
`apps/runner/.env.example`). The runner warns once per missing key
(`market_source_disabled`) and that provider's series report
`SOURCE_NOT_CONFIGURED` — never an estimate. Keys never reach a log line, an
error message, stored data or the browser.

**Twelve Data authenticates with the `Authorization: apikey <KEY>` header**
(verified live on 2026-10-12 with a free-plan key). The safe fetcher grew a
fixed allowlist of one extra header name rather than putting the key in the
URL; the `Authorization` value is attached to the first request only and
**never follows a redirect** (`safeFetchCore.ts`). FRED's key travels in its
`api_key` query parameter because that API's own design requires it.

**FRED shape.** `GET /fred/series` yields title, `units`,
`frequency_short` and seasonal adjustment; `GET /fred/series/observations`
yields `{ date, value }` where `"."` means "no value" and is skipped, never
turned into 0. Unit is FRED `units` plus `", seasonally adjusted"` for
SA/SAAR series. Publisher is `"Federal Reserve Bank of St. Louis (FRED)"`,
source URL `https://fred.stlouisfed.org/series/<ID>`. Incremental refreshes
ask for `observation_start = since − 45 days` to pick up revisions. HTTP 400
bodies mentioning `api_key` map to `SOURCE_AUTH_FAILED`, bodies about
`series_id` to `SERIES_NOT_FOUND`, HTTP 429 to `RATE_LIMITED`, anything else
to `SOURCE_FAILED`.

**Twelve Data shape.** `GET /time_series?symbol=<S>[&exchange=<X>]&interval=1day`
answers `{ meta, values[] { datetime, close, … }, status: "ok" }`; the value
is the daily bar's `close`. Stocks map `meta.currency` to the unit and title
`"<symbol> (<exchange>)"`; currency/metal pairs title the symbol with unit
`"<QUOTE> per <BASE>"` (`XAU/USD` → `"USD per XAU (troy ounce of gold)"` —
XAU is by definition one troy ounce; XAG likewise, other pairs plain).
Error JSON `{ code, message, status: "error" }` with any HTTP status maps
401 → `SOURCE_AUTH_FAILED`, 404/400 → `SERIES_NOT_FOUND`, 403 →
`PLAN_NOT_ENTITLED`, 429 → `RATE_LIMITED`, else `SOURCE_FAILED`; empty
`values` → `NO_DATA`. The fixed `SERIES_NOT_FOUND` reason says the provider
has no data for the symbol *on the configured plan*. Publisher is
`"Twelve Data"`, source URL `https://twelvedata.com/`.

**Pacing (API-007).** Twelve Data's free plan allows 8 requests per minute,
so the runner paces Twelve Data requests through `rateWindowPermit` with an
injected clock and sleep (default 8 per 60 s, override
`TWELVE_DATA_REQUESTS_PER_MINUTE`, integer 1..600); FRED is paced at 100 per
60 s the same way. Pacing is per request, not per series: each source
declares its requests per fetched series (FRED 2 — metadata + observations,
Twelve Data 1) and the pacer takes that many grants, so two back-to-back
30-series refreshes cannot send 120 requests against FRED's stated 100/min.
The pacer is built once in the composition root, so back-to-back refreshes
share one window per provider. The bound is proved in
Lean (`formal/ResearchFormal/RateWindow.lean`).

**Storage bounds.** At most 30 distinct series per dashboard, 800
observations per series per completion and per API response, 1,500 stored per
series (one pruning statement scoped to the completion's series).
Observation writes are set-based (`json_each` upserts that skip unchanged
rows); the observations upsert is chunked so no bound parameter nears D1's
~2 MB string limit (≤ 4,000 points per chunk, worst case 6 chunks); the
worst-case query count of a full completion is stated in a code comment and
kept under the ~50-query D1 free ceiling. A failed series keeps its stored
observations and records only the failure code and attempt time. A completion
stores only series on the owner's current dashboard (others are dropped and
counted in the audit detail); saving a dashboard deletes stored series and
observations it no longer references.

**Accepted limitations.** Revisions older than the 45-day overlap are never
re-fetched, so a 1-year change can compare a revised latest value against an
unrevised base. The newest Twelve Data daily bar can be an unfinished
session; stock tables keep the "Last close" column and say so beside any
Twelve Data widget.

**What was actually exercised live (2026-10-12, owner's free-plan keys) vs
what is documentation-derived.** Exercised: FRED series metadata +
observations for `VIXCLS` and `CPIAUCSL`; Twelve Data `time_series` for
`AAPL`, `MSFT`, `XAU/USD` (meta type "Precious Metal", daily bars include
weekends), `USD/JPY` and `EUR/USD` with header authentication; `7203` on
`JPX` answering 404 `{"code":404,"message":"Data not found"}` (Japanese
listings are not served on the free plan); the opt-in live smoke test
(`RUN_LIVE_MARKET=1`, `packages/adapters/test/finance/marketLive.test.ts`)
through the real adapters and the real Node safe fetcher for `fred:VIXCLS`
and `twelve-data:AAPL`. Everything else — other catalog series, paid-plan
behaviour, the 403 `PLAN_NOT_ENTITLED` and 429 mappings — is implemented from
vendor documentation or synthetic fixtures and is labelled so in tests.

**Terms notes (read 2026-10-12).** FRED API terms of use
(`https://fred.stlouisfed.org/docs/api/terms_of_use.html`): the app displays
prominently *"This product uses the FRED® API but is not endorsed or
certified by the Federal Reserve Bank of St. Louis."* (a footer line on Home
whenever a FRED series is shown); series whose notes contain "Copyright"
belong to third parties and may be used for personal use only without the
owner's permission (`VIXCLS` is such a series: © Chicago Board Options
Exchange); the terms state no numeric rate limit; the app must not imply
endorsement or replicate FRED's core experience. Twelve Data terms
(`https://twelvedata.com/terms`): access is *"solely for Internal Use"*,
storing data for internal use is permitted, redistribution / display to third
parties needs a paid tier or add-on, and free-tier data must not be used
commercially. Basic (free) plan: 8 API credits per minute and 800 per day
(`https://support.twelvedata.com/en/articles/5194820-api-credits-limits`).

## Consequences

- Market observations are **personal-use data** under both vendors' terms.
  They are stored per owner in D1 and are **not part of workspace export**
  (export/import in `packages/application/src/workspaces.ts` never touches
  the market tables); a directory copy of `data/` carries them, like pages.
- **Japanese share prices are unavailable with the configured free plan**
  (`7203:JPX` → `SERIES_NOT_FOUND` with the plan wording). `NIKKEI225` and
  `DEXJPUS` come from FRED instead.
- **Values are end-of-day / periodic, never real-time.** The newest Twelve
  Data daily bar can be an unfinished session; FRED series arrive at their
  own frequencies (daily to annual).
- A refresh costs provider requests, not money on the free plans: 2 requests
  per FRED series (metadata + observations), 1 per Twelve Data series. The
  default dashboard (9 FRED + 4 Twelve Data series) costs 22 requests; the
  30-series ceiling costs at most 60, paced (see `docs/OPERATIONS.md`).
- Provider message text is untrusted: it is never stored, shown or logged —
  every unavailable code carries our own fixed wording
  (`marketUnavailableReason`).

## Alternatives considered (deliberately not done)

- **One vendor for everything.** Neither vendor covers the other's ground on
  the free plan: FRED has no listed-equities closes, Twelve Data's free plan
  has no Japanese listings and no long US indicator history.
- **Browser-side fetch.** Rejected: API keys would reach the browser bundle,
  and vendor hosts are outside the `connect-src 'self'` policy.
- **Worker-side fetch.** Rejected: runner keys do not belong in the Worker,
  and the runner already owns every other outbound provider call with its
  pinned fetcher.
- **Scraping public quote pages.** Rejected: against publisher restrictions
  (§1) and brittle beside two official APIs.
- **A paid vendor ( Bloomberg-style / Twelve Data paid tier).** Rejected on
  the V1 budget constraint; the ports admit one later without touching the
  Home UI or the job contract.

## Rollback

- Operational: delete a key from `apps/runner/.env` and restart the runner —
  that provider's series become `SOURCE_NOT_CONFIGURED` with the key named;
  stored observations stay readable until pruned by later refreshes.
- Schema: migration `0006_market_data.sql` carries its inverse in its header
  comment (`DELETE` + `DROP TABLE` after a `wrangler d1 export` rehearsal on
  a copy); code rollback to a pre-Home release leaves the three tables
  unused but harmless.
- Contract: the `market-refresh` job kind and `market-refreshed` outcome are
  additive to the claim/complete unions; removing them is a major contract
  version, not a silent change.
