# ADR-0067: Next earnings date on the Financial statements tab

Status: accepted, 2026-11-03. Builds on ADR-0049 (the Stocks page's tabs),
ADR-0051 and ADR-0054 (the server syncs earnings dates for Watchlist
stocks) and ADR-0055 §4 (the Financial statements tab shows no sync status).

## Context

On 2026-11-03 the owner asked for 決算日 on the 財務諸表 tab, then said
they meant the next one: the next earnings announcement. The tab already
showed each fiscal year's period end under its year. The next announcement
dates were stored for Watchlist stocks only, and were shown only by the
Home earnings calendar widget and the calendar exports.

## Decision

1. **Where.** A "Next earnings date" (次回決算発表日) line heads the
   Financial statements tab, above the statement switch, for every stock.
2. **What.** The date with its weekday (`<time datetime>`), the time of day
   when the source states it (寄り付き前 / 大引け後), how many days away
   (本日 / 明日 / あと n 日), the fiscal period it reports with its fiscal
   year when the source states it (JPX: 「対象: Q2 2027（2027年3月期）」;
   Finnhub states none), and the source as a link (Finnhub or JPX).
3. **Which.** `nextEarnings` (`apps/web/src/stocks/nextEarnings.ts`): the
   first event dated on or after today's UTC date (as on the Home earnings
   calendar), else the first undecided one (未定). The contract already
   orders a stock's events dated ascending, then undecided, so this is a
   scan, not a new algorithm: no Lean model.
4. **No date.** The line says why: the stock is not on the Watchlist (add it
   to get its dates), the dates are not fetched yet, the source lists no
   upcoming announcement, or the fetch failed (fixed wording per
   `EarningsUnavailableCode`; provider text is never shown). A stored
   upcoming date still shows after a later fetch failed.
5. **Reads.** None of its own: the page's Watchlist read already carries the
   events (`SelectedStock.watchlist`), and the detail renders only after that
   read settled, so a missing entry means "not on the Watchlist".

`EarningsEvent.fiscalPeriodEnd` and `earnings_events.fiscal_period_end` are
documented as what JPX stores in them: the end of the period's fiscal year,
not of the quarter.

## Consequences

- A stock outside the Watchlist shows no date. Fetching earnings dates for
  every listed stock would follow the statements (ADR-0058) but spends the
  Finnhub budget; it is not done here.
- Labels stored before 97ddb9d8 read as JPX wrote them ("Second quarter")
  until the next earnings sync rewrites them as `Q2 2027`.

## Verification

`apps/web/test/nextEarnings.test.ts` (the selection, by hand-worked dates)
and `apps/web/test/stocksFinancials.test.tsx` (the line in English and
Japanese, undecided, not on the Watchlist, no extra request). Checked in
Chrome on the dev app: KO (Finnhub, 2027年2月8日（月） 大引け後) and 1380 (JPX,
2026年11月13日（金）), no console errors, no overflow at 390 px.
