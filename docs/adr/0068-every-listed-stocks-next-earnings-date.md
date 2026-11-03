# ADR-0068: Every listed stock's next earnings date

Status: accepted, 2026-11-03. Extends ADR-0067 (the next earnings date on
the Financial statements tab) and amends ADR-0058 ("earnings dates stay
Watchlist-only"). Follows ADR-0051 and ADR-0054 (the server syncs at claim
time) and ADR-0058 (every listed stock is synced).

## Context

ADR-0067 put the next earnings date (次回決算発表日) at the top of the
Financial statements tab, from the stock's Watchlist entry; any other stock
said to add it to the Watchlist. On 2026-11-03 the owner asked for the next
date of non-Watchlist stocks too.

The Watchlist's dates are fetched one stock at a time (`earnings-refresh`:
Finnhub's calendar with `symbol`, 1–2 requests a stock; JPX's workbooks
filtered by code) and feed the Google Calendar and the `.ics` exports. One
request per stock does not scale to the ~7,700 US stocks of the stock list:
about four hours a pass at the runner's 30 Finnhub requests a minute, while
the runner runs one job at a time.

Measured live on 2026-11-03: Finnhub's earnings calendar asked WITHOUT a
symbol lists every company in the window, months ahead too, and stops at
exactly 1,500 rows; a 7-day window hit the cap, single days held 467 and
567 rows. JPX's workbooks, which the Watchlist refresh already downloads,
list every company whose quarter or year ended in a listed month.

## Decision

1. **A market's whole calendar.** A new server-queued job kind,
   `earnings-calendar-sync`, one per market (`{ market }` request, at most
   one active per market), fetches the market's whole earnings calendar for
   the Watchlist's window, [today, today + 185 days] (UTC):
   - US: Finnhub's calendar without `symbol`, in consecutive 7-day windows;
     a week whose answer holds 1,500 rows is asked again day by day, and a
     day still capped is kept and reported in `truncatedDates`. About 30–40
     requests a pass, through the same `finnhub` pacer window.
   - JP: every row of the JPX workbooks the Watchlist refresh downloads,
     through the same source object, so a sync after a refresh costs no
     request.
   - Symbols in the stock list's form (`BH.A` → `BH-A`); one row per stock
     and period (the first wins). Any failed request fails the whole sync
     (`failed` with an `EARNINGS_UNAVAILABLE_CODES` code and the provider's
     status); nothing partial is stored.
2. **Schedule.** At claim time (`materializeDue`), per market whose stock
   list is stored: at once when no calendar is stored, again once it is 24
   hours old, 30 minutes after a sync that did not complete (`decideSync`
   with the calendar as one item, so no Lean change).
3. **Storage.** Migration 0031: `stock_earnings_calendar` (one row per
   stock and period) and `stock_earnings_calendar_market` (when, which
   window, how many rows, the truncated days). A completion replaces the
   market's rows in its guarded batch, inserting only symbols of the owner's
   stock list. These rows feed no calendar export: the Google Calendar and
   the `.ics` files stay Watchlist-only (`earnings_events`).
4. **Read.** `GET /api/v1/stocks/:stockId` gains `earningsCalendar`: the
   market's source (publisher, link), when it was stored, and the stock's
   events from today (at most 8, soonest first, undated last); null when the
   market's calendar was never stored. The Financial statements tab already
   reads the profile, so no request is added.
5. **The line.** `nextEarnings` takes the Watchlist entry first (its own
   fetch, per stock), then the market calendar: a Watchlist stock whose own
   fetch has no date is filled in by the calendar, and the calendar never
   overrides a Watchlist date. With neither: "not fetched yet", or "none
   listed" once the market's calendar is stored. The "add it to the
   Watchlist" sentence of ADR-0067 is gone.

The window walk (7-day windows, capped weeks by day) is a fetch strategy in
the adapters, like the per-stock walk it sits beside, not a domain
algorithm: both runners replay it from shared vectors instead of a Lean
model.

## Consequences

- Every listed US and JP stock shows its next earnings date once the
  market's first sync completes (seconds after the stock list is stored).
- About 30–40 more Finnhub requests a day, under the same 30-a-minute
  pacer; a day with more than 1,500 announcements would miss some (reported
  per day; the busiest day seen had 567).
- Finnhub's free plan documents no cap and only "1 month of historical
  earnings and new updates"; the cap is observed, and future dates are
  served today. A change there shows as fewer dates, never wrong ones.
- A completion carries at most 60,000 rows (`maxEvents`); rows past it
  would be dropped without a mark. A busy US half-year is about 24,000, so
  the bound is headroom, not a planned cut.
- A JP stock appears only while JPX lists its period (the workbooks of the
  months whose quarters ended recently), as the Watchlist's JP dates do.

## Verification

- `packages/adapters/test/finance/earningsCalendar.test.ts` (the walk, the
  cap split, symbol mapping, failures; JPX rows),
  `packages/adapters/test/sqlite/earningsCalendar.test.ts` (storage on a
  migrated and a schema-built database), `apps/api/test/earningsCalendar.test.ts`
  (schedule → claim → completion → profile on D1 and `node:sqlite`),
  `packages/application/test/stockPages.test.ts`,
  `apps/web/test/nextEarnings.test.ts`, `apps/web/test/stocksFinancials.test.tsx`.
- Shared vectors for the contract, the Finnhub walk, the JPX rows and the
  job, replayed by the Rust runner.
- `bun run bench`: parsing a 24,000-row US completion (3.5 MB) 34 ms,
  storing it into an 11,000-stock list 58 ms.
- The Finnhub document's live example and verification log (2026-11-03).
