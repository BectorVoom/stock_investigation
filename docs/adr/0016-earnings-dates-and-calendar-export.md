# ADR-0016: Earnings dates and calendar export (watchlist + FR-018)

**Status:** Accepted · **Date:** 2026-10-13

## Context

The owner asked for a stock watch/watchlist page and, for the registered
stocks, a settlement-of-accounts (earnings announcement) calendar on Home
that integrates with calendars such as Google Calendar. Like market numbers
(FR-017, ADR-0014), an earnings date shown in the app must come from a
licensed source fetched on request — never a guess — with an explicit
"unavailable (reason)" when the source has nothing.

## Decision

**Earnings dates come from Finnhub (US listings, keyed) and JPX's published
announcement schedule (Japanese listings, no key).** Twelve Data is NOT used
for earnings: checked live on 2026-10-13 with the owner's free key,
`/earnings` answers only for trial symbols and returns no upcoming dates,
and `/earnings_calendar` is paid-only.

**Calendar integration is three mechanisms, no Google OAuth / Calendar API:**
an `.ics` download, per-date "Add to Google Calendar" / "Add to Outlook"
links, and a secret-token subscription feed URL
(`GET /api/v1/calendar-feed/:token/earnings.ics`, outside the owner session
because calendar apps send no cookie or CSRF header).

**Finnhub (exercised live on 2026-10-13 with the owner's free-plan key: the
calendar for `AAPL`, `MSFT`, `NVDA` and an unknown symbol, `profile2` for
`AAPL` and an unknown symbol, header authentication, the `x-ratelimit-limit:
60` response header and HTTP 401 `{"error":"Invalid API key"}` for an invalid
key; `hour` arrived as `"amc"` or the empty string; the 403 and 429 mappings
remain documentation-derived).**
`GET https://finnhub.io/api/v1/calendar/earnings?from=<ISO>&to=<ISO>&symbol=<S>`
answers `{ "earningsCalendar": [ { "date", "hour" (bmo/amc/dmh), "quarter",
"year", "symbol", … } ] }` (Finnhub docs, read 2026-10-13); only those five
fields are used, estimates are never stored or shown. An empty array is
`NO_SCHEDULED_DATE`. When the stock's name is not yet stored,
`GET /api/v1/stock/profile2?symbol=<S>` resolves it (`{}` without a ticker
is `SYMBOL_NOT_FOUND`). Authentication is the header
`X-Finnhub-Token: <FINNHUB_API_KEY>` — the safe fetcher's fixed header
allowlist grew by exactly this one name with the same "first request only,
never follows a redirect" rule as `Authorization`
(`packages/adapters/src/worker/safeFetchCore.ts`); the host is pinned to
`finnhub.io` and the key never enters a URL. Error mapping: 401 →
`SOURCE_AUTH_FAILED`, 403 → `PLAN_NOT_ENTITLED`, 429 → `RATE_LIMITED`,
anything else → `SOURCE_FAILED`; response text is never stored, shown or
logged. `FINNHUB_API_KEY` lives in `apps/runner/.env` (commented line in
`.env.example`); without it the runner warns once
(`earnings_source_disabled`) and US stocks report `SOURCE_NOT_CONFIGURED`.
Pacing (API-007): Finnhub's free plan documents 60 calls/minute; the runner
paces 30 request starts per 60 s through the generalised rate-window pacer
(one window per provider, shared across jobs), counting 1–2 requests per
stock (`needName`).

**JPX (exercised live on 2026-10-13).** The Japanese index page
(`https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html`;
the English page carries no file links) links one workbook per
quarter-/year-end month (`…/kessan09_1009.xlsx`, `_MMDD` the update date;
two listed that day). Only hrefs matching
`^/listing/event-schedules/financial-announcement/[A-Za-z0-9_-]+/kessan[0-9]{2}_[0-9]{4}\.xlsx$`
on `www.jpx.co.jp` are accepted, de-duplicated, at most 6. A workbook is
~235 kB zipped; inside, `xl/worksheets/sheet1.xml` (~1.35 MB) and
`xl/sharedStrings.xml` (~220 kB). Rows 1–4 are titles, row 5 is the header,
data starts at row 6 (~2,900 rows): column A holds an Excel serial or
`未定_Undecided`, B the code (numeric `7203`, or a string such as `130A`),
D the issue name (may trail spaces), E the fiscal year-end serial, I the
English quarter label. Columns are located by header-row text (the English
halves), never by fixed letters; a missing required header fails the whole
workbook closed (`SOURCE_FAILED`).

The workbook is untrusted input (SEC-001): a NARROW binary port
(`SafeBinaryFetcher.fetchBytes`, Node safe fetcher only — `SafeFetcher`
itself is not widened) with the same pinning, redirect validation and byte /
time ceilings as `fetchText`; a minimal stored/deflated ZIP reader
(`packages/adapters/src/node/zipReader.ts`, Node-only) with hard ceilings
(archive ≤ 4 MB, each inflated entry ≤ 16 MB via zlib `maxOutputLength`,
only the two named entries ever inflated, ZIP64/encrypted/multi-disk fail
closed); bounded linear XML scanning with no entity expansion (the
`feed/xmlTree.ts` approach), bounded row / shared-string counts, entry names
never used as paths. No XML/xlsx dependency was added.

Mapping: a wanted code with a dated row in `[fromDate, toDate]` is an event;
"Undecided" is an event with `announcementDate: null`; earlier rows are
dropped; name is column D trimmed; `periodKey` is
`"fy" + fiscalYearEnd + "-" + slug(column I)` — dateless, so a rescheduled
announcement keeps its identity and calendar UID. A wanted code in no
workbook is `NO_SCHEDULED_DATE`; index/workbook failure is `SOURCE_FAILED`
for every requested JP stock.

Politeness (JPX terms of use, read 2026-10-13: JPX's copyright, no commercial
collection, no high-load/high-frequency automatic retrieval): fetch only on
an owner-queued refresh; in-process index cache for 30 minutes and parsed
workbooks cached by URL (the file name carries its update date) on the
injected clock; 6 request starts per 60 s; the runner's normal User-Agent.
The data is personal-use, stored per owner, never in workspace export.

**Storage and jobs.** Migration `0007_watchlist_earnings.sql` adds
`watchlist_stocks`, `earnings_events` (`WITHOUT ROWID`, keyed by
owner/stock/period) and `calendar_feeds` (one row per owner: only the
SHA-256 of the `cal_`-prefixed 256-bit token, same treatment as runner
credentials, ADR-0002). Completion writes are set-based (one `json_each`
statement per group — a full 50-stock completion costs at most 4 statements
here, under the ~50-query D1 ceiling). A successful stock REPLACES its
events and sets name (when returned), both stamps, clearing the code — and
`NO_SCHEDULED_DATE` is a successful retrieval that likewise CLEARS the
stored events and sets both stamps (recording the code, optionally with the
name), so stale dates vanish; every other code keeps the stored events and
records only the code and attempt time. The runner executes
`earnings-refresh` like `executeMarketRefresh`, grouping stocks by source so
JPX is one batch; the registry lives in the composition root
(`apps/runner/src/main.ts`). Each HTTP request takes its own pacing grant
through the query's `beforeRequest` hook (never for cache hits that send
nothing).

**Feed secrecy.** The token is returned once (`cal_…`, shown once in the UI
with a Copy button), stored only as SHA-256, rotated/revoked through
audited owner routes. Any feed failure — bad shape, unknown, revoked — is
the SAME `404 NOT_FOUND` body, and any other request under
`/api/v1/calendar-feed/` answers that uniform 404 instead of falling through
to the owner API. The application logs the route pattern (`:token`
unexpanded), never the path — but wrangler's own per-request lines print the
expanded path, so both launch plans run `wrangler dev` with
`--log-level warn`, which drops those lines (and the startup banner) while
the Worker's own `console.error` event lines still reach `server.log`
(`tests/local/calendarFeedServerLog.test.ts` proves the token absent and the
worker lines present). The owner routes never accept the feed token, and the
feed route never serves anything but its owner's calendar.

## Consequences

- Earnings dates are **personal-use vendor data** like market observations:
  stored per owner, not part of workspace export (a directory copy of `data/`
  carries them), never redistributed.
- A refresh costs provider requests: 1–2 per US stock (Finnhub), one JPX
  batch per refresh (index + ≤ 6 workbooks, mostly cache-served). No money
  on the free plans; quota instead (see `docs/OPERATIONS.md`).
- `server.log` no longer carries wrangler's per-request lines or its startup
  banner in either environment (stated in `docs/OPERATIONS.md`); readiness
  and failure detection never depended on them.
- The `.ics` is deterministic (ARCH-011): `DTSTAMP` is the stock's
  `retrievedAt`, so the same stored data yields byte-identical output.
- Undecided announcements never enter the calendar (no date to put on it);
  the page states them as text.
- On a deployed Worker the feed path needs a Cloudflare Access bypass (like
  the runner path): calendar apps cannot present Access JWTs
  (`docs/OPERATIONS.md`).

## Alternatives considered (deliberately not done)

- **Twelve Data for earnings.** Rejected on the live check above: trial
  symbols only, no upcoming dates, calendar endpoint paid-only.
- **Google OAuth / Calendar API.** Rejected: the three mechanisms need no
  consent screen, no stored Google credential and no extra egress host, and
  the `.ics` + per-date links work everywhere including offline.
- **Scraping company IR pages.** Rejected: against publisher restrictions
  and brittle beside Finnhub's API and JPX's published schedule.
- **A paid earnings vendor.** Rejected on the V1 budget constraint; the
  source registry admits one later without touching the calendar UI or the
  job contract.
- **Widening `SafeFetcher` for workbooks.** Rejected (ARCH-007): the binary
  port is narrow, Node-only, and the runner is its only caller.

## Rollback

- Operational: delete `FINNHUB_API_KEY` from `apps/runner/.env` and restart
  the runner — US stocks become `SOURCE_NOT_CONFIGURED`; stored dates stay
  readable until later refreshes replace them. Revoke the subscription link
  on the Watchlist page (or delete the owner's `calendar_feeds` row) — the
  old URL answers 404 at once.
- Schema: migration `0007_watchlist_earnings.sql` carries its inverse in its
  header comment (`DELETE` + `DROP TABLE` after a `wrangler d1 export`
  rehearsal on a copy); code rollback to a pre-watchlist release leaves the
  three tables unused but harmless.
- Contract: the `earnings-refresh` job kind and `earnings-refreshed` outcome
  are additive to the claim/complete unions; removing them is a major
  contract version, not a silent change.

## Addendum (2026-10-13): automatic refresh when dates were never fetched or are older than 24 h

Adding a stock on the Watchlist page left its dates unfetched until the owner
found and clicked "Refresh earnings dates", and Home offered no way to fetch
them at all — so the calendar widget read "No announcement in the next 90
days." for stocks that were simply never looked up. The views now mirror
Home's market-data pattern (`needsAutoRefresh` / `maybeAutoRefresh` /
`maybeFollowUpRefresh`): a successful add queues an earnings refresh itself
(when a run is already active, one follow-up is queued when that run ends
with a stock still never refreshed — a run still pending at the add claims
the current watchlist, the new stock included, so then nothing more is
queued); opening the Watchlist page or Home (with a calendar widget) with
dates never fetched or more than a day old queues one refresh, announced in
the notice; the Home widget has its own "Refresh earnings dates" button and a
"Fetching earnings dates…" status, says "Earnings dates have not been fetched
yet." until every stock was looked up once, and a queued notice clears when
the run ends. Each automatic trigger fires at most once per view mount (load
rule) or once per ended run preceded by an add (follow-up); a failed queue is
reported, never retried. Both views share one queue factory
(`apps/web/src/watchlist/earningsRefreshQueue.ts`) holding the
idempotency-key rule, and one reason function
(`earningsAutoRefreshReason`, `EARNINGS_AUTO_REFRESH_STALE_MS` = 24 h) with
its announce texts.

This stays within JPX's "no high-frequency automatic retrieval" ask: nothing
is fetched unless the owner has a view open, at most one refresh per mount
plus at most one follow-up per add-during-run, and the runner still caches
the index page 30 minutes and each parsed workbook by URL, pacing 6 request
starts per 60 s.
