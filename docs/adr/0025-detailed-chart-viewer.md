# ADR-0025: Detailed chart viewer for price widgets

**Status:** Accepted · **Date:** 2026-10-16

## Context

The owner asked (2026-10-16): "When a user clicks on a price data widget,
allow them to view and analyze the chart in detail, just like in a typical
financial platform. Also, provide flexible controls for adjusting the
chart's time range and intervals with precision."

The widgets are glanceable by design (DESIGN_GUIDELINE §14, Apple HIG): a
widget offers simple functionality, reserves complexity for the app, and a
tap opens the app at the right place. Today a price widget has no such
place: the line chart offers six fixed ranges and nothing else.

What the data allows (and so bounds this decision):

- Every series is a list of `[observedOn, value]` tuples, newest last, at the
  provider's native frequency (`MarketSeries.frequency`: daily … annual).
  Twelve Data series are **daily closes**; there is no intraday data, no
  open/high/low per day and no volume. Intervals finer than a day are
  therefore not offered, and candles are not drawn (a candle built from
  closes would invent an open/high/low the source never reported).
- A page holds at most the newest `MARKET_LIMITS.maxObservationsPerResponse`
  (800) observations per series. The viewer works on exactly the data the
  page already holds: no new endpoint, no new request, no new provider
  call.

## Decision

### Where it opens

A **Chart viewer**: a large modal sheet (`sl-dialog`, class `chart-viewer`)
over the current page — Home or the Notebook alike, since both render the
same widget components (ADR-0024). It is the "app" the widget's tap opens.

Entry points (each a native `<button type="button">`, keyboard reachable,
accessible name computed from its content: a visually hidden `Open chart: `
prefix followed by the visible text — the values, the row name and symbol,
the plot's own image name — so the name contains what the button shows, WCAG
2.5.3; no `aria-label` replaces it, and the content is phrasing only):

| Widget | What opens it | Series shown |
|---|---|---|
| `line-chart` | the plot area (the `ChartFrame` is wrapped in the button; hover readout keeps working) | all the widget's series |
| `market-metric` | the value block (value, change lines, sparkline) | the widget's series |
| `stock-table` | each row's name cell | that row's series |
| `indicator-table` | each row's name cell, opening at the row's Trend range (1Y daily/weekly, 5Y monthly, Max coarser — ADR-0044 §1) | that row's series |

A press that turns into a drag never opens it, nor does a mouse press that
moves 4 px or more before its release (selecting the symbol's text); a touch
or pen tap that drifts a few px still opens (touch selects no text, and a
real touch drag produces no click). The slop rule is mouse-only by choice: a
pen can drag-select text in some desktop browsers, and a pen press that
selected text may then still open the viewer — accepted, since a pen tap's
natural drift would otherwise be lost. A keyboard activation always opens. Each
opener is at least 24 × 24 px and 44 × 44 px under a coarse pointer
(`pointer-coarse:min-h-11 pointer-coarse:min-w-11`, DESIGN_GUIDELINE §14). The grip, actions menu, Range select and data-table
disclosure keep their own behaviour. The viewer opens only for series with at
least one observation; once open it stays open until closed — a reload that
drops the observations shows its "unavailable" state, and data returning
later never reopens a closed viewer. It never changes the widget or the
dashboard: nothing it does is saved.

Sizing: full screen below `40rem` wide (HIG full-screen modal on iPhone);
above it the sheet fills the viewport minus a `1rem` margin on every side.
`Escape` and the dialog's close button close it; focus returns to the button
that opened it (the entry point passes the clicked button, since Safari and
Firefox on macOS never focus a button on a mouse click). If a reload replaced
that button while the viewer was open, focus goes to the widget's new opener
with the same `data-chart-opener` key, else to the widget's focusable body —
never to `<body>`. Focus return is captured once, at the press, and handed
to the viewer, so a reload that replaces the opener while the chunk is still
downloading changes nothing. While the viewer's chunk downloads, "Loading
chart…" (a `status`) shows at a fixed place at the top of the viewport —
where the sheet will appear, in a portal on `<body>`, so it is in view
whatever part of a tall widget was pressed (a notice after the line chart's
legend, readout and data table was off screen at 720 px); if the download
fails (offline, or an old chunk hash after a new release) or the viewer
fails to render, the same place shows an `alert` — "The chart viewer could
not be loaded." with Try again (imports the chunk again) and Close (focus
back to the opener) — focus moves to Try again, pressing the opener again
also imports again, and the page and its other widgets stay as they were.
At most one viewer exists: opening one while another is still downloading
or open supersedes the earlier one (its widget's open state is closed
without moving focus), so two widgets pressed during one download never
stack two modal dialogs. Body scroll is locked while it is open (Shoelace does this).

### Layout (top to bottom)

1. **Header** — series name(s); for each series the latest value with unit
   and as-of date; the change over the visible window (▲/▼/▬ plus a word,
   absolute and percent — never colour alone).
2. **Range bar** — preset buttons (a native button group, `aria-pressed`):
   `1W 1M 3M 6M YTD 1Y 3Y 5Y Max`; then **From** and **To** native
   `<input type="date">` bounded by the data's first and last date (the
   precise control: any day), and **Reset** (back to the opening preset).
   Presets that the data cannot fill (window start before the first
   observation) still work and show from the first observation; `Max` is
   all held data. Selecting a preset sets From/To; editing From/To clears the
   pressed preset. An invalid custom range (From after To) is refused with an
   inline message and nothing changes.
3. **Controls bar** —
   - **Interval**: `Auto`, `Daily`, `Weekly`, `Monthly`, `Quarterly`,
     `Yearly`. Intervals finer than a series' native frequency are disabled,
     with the reason in the option text ("Daily — source is monthly").
     `Auto` picks the finest allowed interval that keeps the visible bars at
     or below one bar per 3 px of plot width; the chosen interval is named
     beside the select ("Auto · Weekly"), while the option itself always
     reads "Auto" (Shoelace's closed select does not refresh its label when
     an option's text changes in place).
   - **Scale**: `Linear` / `Log`. Log is disabled (with the reason) when any
     visible value is ≤ 0.
   - **Values**: `Value` / `% change` (each series rebased to 0 % at the
     first visible bar; a zero base shows "unavailable (zero base)").
   - **Moving averages**: `MA 20`, `MA 50`, `MA 200` toggles — simple moving
     averages over the selected interval's bars, computed over all held data
     so the first visible bars already have a value. Enabled when the chart
     shows exactly one series (with more, the reason is stated).
4. **Main chart** — fills the remaining height (at least `16rem`). The SVG's
   viewBox follows the container's pixel size (ResizeObserver), so text never
   scales. Value axis on the **right** (the financial-platform convention),
   date axis below with ticks on calendar boundaries picked for the span and
   the measured width — days (`Oct 16`), week Mondays (`Oct 13`), month
   starts (`Aug`, with the year added at January and at the first tick:
   `Jan 2026`), quarter and half-year starts, year starts every 1, 2, 5, 10,
   20, 50 … years (`2026`, `1970 1980 …`) — keeping the finest step whose
   labels stay distinct and clear each other, so a tick always marks its
   boundary's time-proportional x instead of an arbitrary bar. A window that
   crosses a calendar year names the year on its first tick and at every
   year change (`Oct 19, 2025` … `Jan 4, 2026` for day ticks), in every
   fallback too — never a lone year-less date. One
   line per series from the shared palette (`SERIES_COLORS`); moving averages are thinner dashed lines with
   their own legend entries. Each series' last visible value is marked on
   the value axis. A crosshair (vertical and horizontal line) follows the
   pointer with the date under the date axis and the value at the value axis,
   and a readout line above the chart: date, each series' value with unit,
   and the change against the previous bar (absolute and percent).
5. **Navigator** — a short overview of all held data under the main chart
   with the visible window as a highlighted rectangle and two handles: drag
   the window to pan, drag a handle to resize, press outside the window to
   centre the window there.
6. **Statistics for the visible window** — a table, one row per series:
   Open (first), Close (last), Change, % change, High (with date), Low (with
   date), Average, Max drawdown, Bars.
7. **Data table twin** (`<details>`) of the visible bars at the chosen
   interval (rows built only while it is open), plus legend, unit, as-of date and source link (UI-007; the
   shared provenance line). When a series holds exactly 800 observations a
   note says the viewer shows the newest 800 held observations.

### Interaction (main chart)

- Wheel or trackpad scroll zooms around the pointer; pinch (ctrl+wheel)
  likewise. The zoom follows the wheel distance: the deltas of one frame are
  summed in pixels (lines and pages converted) and zoom by
  `exp(distance × ln 1.15 / 100)` — 15 % per 100 px mouse notch — clamped to
  2× per frame, so a trackpad's many small deltas never zoom 15 % each. Drag
  pans by the plot width (the data under the finger moves with it), and only
  the primary pointer pans, so a second finger never makes the chart jump;
  double-click returns to the pressed preset (or the opening one).
- Keyboard: the chart is focusable (`tabindex="0"`, `role="group"`,
  `aria-roledescription="interactive chart"`, instructions in
  `aria-describedby`). `←`/`→` move the crosshair one bar, `Shift`+`←`/`→`
  pan by a tenth of the window, `+`/`-` zoom in/out around the crosshair (or
  the centre; the crosshair is held as a day, so every step anchors on it and
  the readout stays while the day is visible; a zoom whose Auto interval
  coarsens widens the window's end to the bar of the crosshair day's bucket
  — a weekly bar is dated at its week's last observation, after a window
  that ended on the crosshair day — so the crosshair never vanishes at the
  right edge), `Home`/`End` jump to the first/last visible bar, `0` resets.
  A visually hidden polite live region announces the readout after a
  keyboard move.
- The window is clamped to the held data and never narrower than two bars of
  the current interval (or the whole data when it is shorter).
- Pointer and wheel updates are coalesced to one per animation frame, on
  separate schedulers for the crosshair, the drag pan and the wheel zoom, so
  a hover in the same frame never drops a zoom.

### Algorithms (pure, in `packages/domain/src/market/chartWindow.ts`)

Dates are handled as integer day numbers (days since 1970-01-01, UTC civil
calendar, the same arithmetic as `subtractMonths`) — no `Date.now()`, no
time zones. Fallible functions return `Result` (ADR-0007).

- `resampleSeries(points, interval)` — buckets ascending points by calendar
  period (week = ISO week, Monday start; month; quarter; year); one bar per
  non-empty bucket: `observedOn` = the bucket's last date, `close` = its last
  value, `open` = first value, `high`/`low` = max/min, `count`. `daily` is the
  identity (one bar per point, so duplicate input dates intentionally yield
  duplicate bar days). Output dates are nondecreasing for `daily` and
  strictly ascending for every bucketed interval.
- `autoInterval(spanDays, nativeFrequency, maxBars)`.
- `presetWindow(preset, firstDay, lastDay)` → `Result<{ from, to }>` (YTD = 1 January
  of the last date's year; 1W = 7 days; months/years by calendar months,
  clamping the day like `subtractMonths`). Years 0000–0099 use explicit
  civil-date arithmetic (no `Date.UTC` remap).
- `clampWindow(window, extent, minSpan)`, `panWindow(window, delta, extent)`,
  `zoomWindow(window, anchor, factor, extent, minSpan)` — integer days,
  each returning `Result` and rejecting non-finite day coordinates with
  `NON_FINITE_DAY` instead of propagating NaN; the result always lies within
  the extent with `from ≤ to`; a pan keeps the span; a zoom with a valid
  positive finite factor keeps the (extent-clamped) anchor day inside the
  result, while a non-positive or non-finite factor falls back to clamping
  the input window with `minSpan`; an overflowing zoom-out target saturates
  to the extent length.
- `visibleSlice(bars, window)` — binary search on the ascending dates
  (indices `[start, end)`), never a filter over all bars.
- `movingAverage(values, period)` — same length; `null` for the first
  `period − 1` entries; a running sum (O(n)).
- `windowStats(bars)` — open, close, change, percent change (null for a zero
  base), high/low with their dates, average, max drawdown (percent, null when
  a running peak is ≤ 0), bar count.
- `rebasePercent(values, base)`.

### Performance

Resampling and the union of bar days run once per (series, interval) over
all held data and moving averages once per (series, interval, period); a
window change only re-slices by binary search (the two-bar minimum included)
and rebuilds paths for the visible bars plus one bar either side — the
moving averages are copied and rebased for that slice only, the navigator's
overview line is memoized apart from its O(1) window rectangle, and the
data-table twin builds rows only while open (updating them in place). With more visible bars than plot pixels the path is decimated to the
min and max per pixel column (the extremes are always drawn). `bun run bench`
gains cases for resampling, moving averages, window stats and path building
over 4 × 1,500 points, each with a budget, and per-window-change cases
(two-bar check, navigator rectangle, a 1-month model with three moving
averages) over 4 × 800 and 4 × 20,000 bars sharing one budget, so work
proportional to the held bars fails there.

### Formal verification

`formal/ResearchFormal/ChartWindow.lean` models, over integer days and
natural-number values: the bucket fold of `resampleSeries` (output days
nondecreasing for `daily`, strictly ascending for bucketed intervals; every
bar equals the fold of its own run, so its close is the last value of its
own bucket, tied by bar identity and by output position
(`resample_close_last`, `resample_indexed_close`); bar
count ≤ input length and = 0 only for empty input; `low ≤ open, close ≤
high`), the window functions (result within the extent, `from ≤ to`, pan
preserves the span when the extent is wide enough, zoom with a valid factor
keeps the extent-clamped anchor inside while an invalid factor falls back to
clamping the input window, `zoomWindow_invalid_clamp`/`zoomWindow_within`),
`visibleSlice` (exactly the bars whose dates lie in the window), and the
moving average's null prefix and length. Non-finite day coordinates are
rejected at the TypeScript boundary (`NON_FINITE_DAY`) before reaching the
integer model. `formal/Export.lean` exports
vectors; `tests/formal/chartWindow.conformance.test.ts` replays them
(including a direct `bar.day` assertion so a day shift cannot pass).
Floating-point values (averages, percents, drawdown) are covered by unit and
property tests, not Lean.

## Consequences

- One more Home/Notebook surface. The viewer is its own lazy chunk
  (`ChartViewer-*.js`, 36.04 kB / 11.61 kB gzip in the 2026-10-17 build),
  loaded on the first press of an opener; only the openers stay in the main
  chunk (554.12 kB / 157.66 kB gzip, against 577.54 kB / 163.88 kB with the
  viewer statically imported). Shoelace's `sl-dialog` is already loaded with
  the widgets. Re-measure as DESIGN_GUIDELINE §13 asks.
- The viewer is honest about the data: no intraday intervals, no candles, no
  volume, at most 800 observations per series. Adding a deeper history or
  intraday bars would need a new provider request and storage budget
  (ADR-0010) and a new decision.
- Not in scope: drawing tools, saving viewer settings, deep links to the
  viewer, comparing series not in the widget, export.
