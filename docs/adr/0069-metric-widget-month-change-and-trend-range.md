# ADR-0069: Named comparison periods — 前月比, 前日比 and one trend range

Status: accepted, 2026-11-03. Changes the Metric widget (市場の数値,
`market-metric`) of ADR-0024, §4 of ADR-0065, the Trend range of
ADR-0044 §1, and the change columns of the Stock table and Watchlist prices
widgets (ADR-0040 §5).

## Context

On 2026-11-03 the owner asked to fix the Home 指標 widget's 前回比 ("さっき比
… いつ?": compared with when?) and to make its period consistent. They then
pointed out that the indicator table's 推移 rows read 5年, 最大 and 1年, and
asked once more to fix さっき比: the price tables (銘柄表, ウォッチリストの値動き)
still headed their change columns 前回比 and 前回比（%）.

The two widgets showed periods that were unnamed or that differed:

- The metric widget's 前回比 compared the latest value with the previous
  observation. That was one day for VIX, the 10-year yield, gold and the S&P
  500, but one month for a monthly series such as copper
  (`fred:PCOPPUSDM`), so two widgets side by side meant different things by
  the same word.
- Its sparkline covered the last 3 months, while the chart viewer it opens
  started at 1 year.
- The indicator table's Trend range followed each series' frequency (1 year
  daily and weekly, 5 years monthly, the whole history coarser). One table
  therefore mixed three periods.

ADR-0065 had already given the indicator table 前月比 and 前年比 against the
value a calendar month and a calendar year earlier, for the same reason.

## Decision

1. The metric widget's change lines are 前月比 and 前年比 (English: 1-month
   change, 1-year change), computed exactly like the indicator table's
   (`changeOverOneMonth`, `changeOverOneYear`, ADR-0065 §2–3). A series with
   no value about a month before the latest (under a month of history, or a
   quarterly series) says so: 「取得できません（履歴が不足）」 or
   「1か月前付近の観測値なし」. It never shows a shorter change instead.
2. Every trend line covers the same last year (`TREND_PRESET = "1y"`), the
   period 前年比 compares over, whatever the series' frequency. This applies
   to the metric widget's line and to each indicator table row's 推移. A
   monthly series draws about 13 points, and a quarterly one about 5.
   `indicatorTrendPreset` is removed.
3. The year is named once: the indicator table's header reads
   「推移（1年）」 ("Trend (1 year)") and its rows show no range name. The
   metric widget, which has no header, shows 「1年」 beside its line. Screen
   readers hear the direction over the year ("1年で上昇"). Both widgets draw
   the line with one shared component, `TrendLine`.
4. A metric's value block and a table row's name open the chart viewer at
   1Y, the dates the line covers.
5. The metric widget's as-of date stays in its footer (「時点」), unchanged.
6. The Stock table and Watchlist prices widgets head their change columns
   前日比 and 前日比（%） ("1-day change", "1-day change %"). They still
   compare the latest close with the previous trading day's, which is the
   previous observation of a daily series, with weekends and holidays
   skipped as stock quotes skip them. A weekly, monthly or coarser series
   placed in a Stock table has no previous day, so its cells read
   「取得できません（日次の系列ではありません）」 instead of a longer change
   under that name (`SeriesSummary.dayChange`, error `NOT_DAILY`). No widget
   says 前回比 any more.

## Consequences

- Every market widget on Home and in a Notebook names its periods: 前日比
  on the price tables, 前月比 and 前年比 on the indicator widgets, and 1年 on
  every trend line, whatever the series' frequency.
- A daily series with under a month of stored history shows no 前月比 until
  it has one. The market sync keeps years of history, so this only affects a
  series just added.
- A monthly series' line no longer shows five years. The chart viewer, one
  tap away, still offers 5Y and Max.
- The widget type descriptions (`WIDGET_TYPE_META`, the Japanese catalog)
  now name 前月比, 前年比 and the trend. The 指標表 description, which still
  named the pre-ADR-0065 columns, was corrected at the same time, and the
  notebook prompt vectors were regenerated.

## Verification

- `apps/web/test/home.ja.test.tsx` covers a daily metric (前月比 +0.33
  against the value a month earlier, 「1年」 beside its line) and a monthly
  one (前月比 against the previous month, a line over the same year).
- `apps/web/test/home.test.tsx` covers three days of history, which gives no
  1-month change.
- `apps/web/test/homeModel.test.ts` checks that 前日比 compares a Monday
  with the Friday before and that a non-daily series gets `NOT_DAILY`.
  `home.ja.test.tsx` checks the 前日比 and 前日比（%） headers, and
  `watchlistPricesWidget.test.tsx` checks the English ones.
- `apps/web/test/indicatorTable.test.tsx` checks that every row covers the
  year (366 daily, 13 monthly and 5 quarterly points), that the header names
  it, and that the viewer opens at 1Y.
- The E2E specs `tests/e2e/indicatorHistory.spec.ts` and
  `chartViewer.spec.ts` pass on Chrome.
- The base selection is the Lean-verified `PeriodChange` model of ADR-0065,
  so there is nothing new to prove.
