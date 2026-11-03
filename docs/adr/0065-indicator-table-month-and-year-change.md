# ADR-0065: The indicator table's 前月比 and 前年比

Status: accepted, 2026-11-03. Changes the indicator table of ADR-0044 §1;
the Metric (市場の数値), Stock table and Watchlist prices widgets are
unchanged.

## Context

On 2026-11-03 the owner asked the 指標 widget (the indicator table, 指標表)
to say 前年比 instead of 1年前比, then 前月比 instead of 前回比.

前回比 compared the latest value with the previous observation. For a
monthly series (CPI, unemployment) that is last month, but for a daily
series (VIX, Treasury yields) it is the previous day, so renaming it alone
would have called a 1-day change 前月比. The owner chose to compare with the
value a calendar month earlier, the way the 1-year change already compared
with the value a calendar year earlier.

## Decision

1. The indicator table's columns are 指標 · 最新値 · 時点 · 前月値 · 前月比 ·
   前年比 · 推移 · 出典 (English: Indicator · Latest value · As of · 1 month
   earlier · 1-month change · 1-year change · Trend · Source).
2. 前月比 compares the latest observation with the base: the newest earlier
   observation dated on or before the mark, the latest date one calendar
   month back with the day clamped (31 March → 28/29 February). 前月値 is
   the base's value. A base more than 15 days before the mark gives no value
   (「1か月前付近の観測値なし」): a quarterly series has no month-ago value.
   A monthly series dated on the same day of each month gets the same
   numbers as before.
3. 前年比 is the same computation one calendar year back with 45 days'
   tolerance, unchanged in behaviour. Both are `changeOverMonths`
   (`packages/domain/src/market/changes.ts`), named `changeOverOneMonth` and
   `changeOverOneYear`.
4. The English label of 前年比 stays "1-year change". The Metric widget,
   which often shows a stock price, keeps 前回比 (the previous
   observation) beside 前年比. So do the price tables. (Superseded for the
   Metric widget by ADR-0069: it shows 前月比 too; the price tables now say
   前日比.)

## Verification

`formal/ResearchFormal/PeriodChange.lean` models the base selection over
day numbers, with `subMonthsDay` from the chart-window model as the month
step. It proves:

- the latest observation is the last one;
- the base is on or before the mark, within the tolerance, and is the newest
  such earlier observation in a date-ascending series;
- there is no base exactly when every earlier observation is after the mark;
- a previous observation inside the window is the base.

`formal/Export.lean` writes 3,120 `periodChange` vectors, which
`tests/formal/periodChange.conformance.test.ts` replays through real ISO
dates. The arithmetic is covered by unit tests.

## Consequences

- A daily row's 前月比 and 前月値 now describe a month, not a day. A row
  whose history is shorter than a month shows 「取得できません（履歴が不足）」
  in both cells.
- A quarterly or annual row has no 前月比.
