# ADR-0057: The chart viewer spaces bars by trading day (no weekend gaps)

Status: accepted, 2026-11-01. Amends ADR-0025 (the viewer's time axis was
proportional to calendar days) and ADR-0056 §6 (candle spacing).

## Context

The owner asked (2026-11-01), after candlesticks arrived (ADR-0056):

> Please remove weekend gaps like SBI chart.

The viewer placed every bar at its calendar day: `xForDay` was linear in
the day number, so each weekend left a two-day hole between Friday's and
Monday's candles (a holiday one more), and a daily chart looked ragged.
SBI Securities' charts space bars evenly in trading order: Monday's candle
follows Friday's directly, and the date axis labels the bars.

## Decision

### 1. One trading-day axis (`packages/domain/src/market/tradingAxis.ts`)

The axis days are the bar days at the current interval, ascending and
distinct (`unionBarDays` over every shown series, memoized per interval as
today). A day's **position** is its index among them; a day between two
bar days lies between their positions in proportion to the calendar days
(Saturday after Friday = 4 and before Monday = 5 is 4 + 1/3); before the
first and after the last bar day the neighbouring gap's slope continues.
`axisPosition(days, day)` and its exact inverse `axisDay(days, position)`
are total, continuous and strictly increasing; bar days land on the
integers 0 … n − 1. The Lean model proves these properties and its vectors
check the TypeScript (exact rationals).

### 2. The chart draws in positions

`buildDetailChartModel` maps days through the axis before the linear pixel
scale: lines, candles, volume bars, moving averages, last-value markers,
the crosshair and the nearest-bar search all use it, in Line and in
Candlestick, for one series or several (a union day that one series lacks
still has its slot). Bars are one position apart, so candle bodies take
their width from the position spacing. Date ticks are chosen as before but
placed through the axis; a tick on a day without a bar moves to the next
bar day in the window, and ticks never overlap.

### 3. Gestures move by bars

The window stays a pair of calendar days (presets, From/To, clamping and
the two-bar rule are unchanged). Pointer and keyboard map through the axis
instead of days per pixel, and pan and zoom work in **bar indices** of the
shown axis, through the same Lean-verified `panWindow` and `zoomWindow`
over the index range `[0, n − 1]` (minimum span: two bars):

- A drag accumulates its distance in bars and moves **both** window edges
  by the same whole number of bars (each edge snapped to its nearest bar
  on the first move). The window therefore always holds the same number of
  bars, so the scale never changes under the finger and the bar under it
  stays under it — a pan that moved both edges by the same calendar days
  would gain or lose bars whenever one edge crossed a weekend or a holiday
  and the other did not. The resolved interval is held from the drag's
  first move to its end, so Auto cannot switch the bars mid-drag.
- Shift+←/→ pans a tenth of the visible bars the same way.
- A zoom (wheel, pinch, +/−) scales the window in bars around the bar
  under the pointer (or the crosshair's), which keeps its place on screen.
  A zoom too small to move a whole bar (a slow trackpad frame) is carried
  into the next one instead of being lost.

### 4. What stays

The navigator's overview stays proportional to calendar days (it shows the
whole history, where gaps are invisible); its window rectangle still marks
the same days. Weekly and coarser intervals were already nearly even; they
follow the same axis. A series with missing stretches (a provider gap)
closes up too — the date labels show the jump.

## Consequences

- Daily charts are continuous like SBI's; a 1M window shows about 21 evenly
  spaced bars.
- Pixel x is no longer linear in days; anything that converted pixels to
  days by proportion now goes through the axis.
