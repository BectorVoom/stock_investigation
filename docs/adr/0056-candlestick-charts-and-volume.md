# ADR-0056: Candlestick charts and volume from stored daily bars

Status: accepted, 2026-11-01. Extends ADR-0025 (the detailed chart viewer:
a chart type control and a volume panel), ADR-0044 (what a stored
observation holds) and ADR-0055 §2 (the completion body limit); amends
ADR-0049 §4 (the Stocks page's Chart tab opens in candlesticks).

## Context

The owner asked (2026-11-01):

> Please add candle chart in chart. User can change chart mode. Please refer
> SBI chart.

SBI Securities' charts (HYPER SBI, the US-stock app) draw candlesticks
(ローソク足) by default, can switch to a line (ライン) and other types, show
traded volume (出来高) as bars under the price chart sharing its time axis,
and overlay moving averages.

What the app had: the viewer (ADR-0025) draws one line per series through
the closes. `resampleSeries` already builds open/high/low/close bars, but
from closes only — a daily bar is open = high = low = close, so a daily
candle would be a flat dash. The database stores one value per day
(`market_observations.value`), and the wire observation is
`[observedOn, value]`. Yet the Twelve Data `time_series` answer the runners
already request carries `open`, `high`, `low`, `close` and (for stocks)
`volume` on every row; the runners kept `close` and dropped the rest. FRED
and the materials series report one value a period and have no bar.

Asked on 2026-11-01, the owner chose:

- **Store the real bars** (not candles built from closes only): keep open,
  high, low and volume from the same Twelve Data answer — no extra request.
- **Chart types: Candlestick and Line** (not OHLC bars, not Heikin-Ashi).
- **A volume panel** under the price chart.
- **The app's colours**: green up, red down — the ▲/▼ change colours used
  everywhere else, not the Japanese red-up convention.

## Decision

### 1. The wire observation may carry the day's bar

`marketObservationSchema` becomes `[observedOn, value]` or
`[observedOn, value, [open, high, low, volume]]` (TS
`packages/contracts/src/market.ts`, Rust `research-contracts`
`MarketObservation`/`MarketBar`). With a bar, `value` is the close. Every
number is finite; `volume` is a number ≥ 0 or `null` (Twelve Data gives
none for currency and metal pairs). A bar must be consistent with its
close — `low ≤ open, close ≤ high` (`isConsistentBar`) — or the
observation is refused. A missing bar is omitted, never sent as `null`, so
readers that unpack `[observedOn, value]` are unchanged.

### 2. The runners keep Twelve Data's bar

Both runners (Rust `research-finance` `twelve_data.rs`, the TS rollback
`packages/adapters/src/finance/twelveDataSeries.ts`) read `open`, `high`,
`low` and `volume` beside `close`. A row whose close is unreadable is
skipped, as before. A row whose open, high or low is missing, empty or
unreadable, or whose bar is not consistent with the close, keeps its close
and drops its bar; an unreadable or negative volume becomes `null`. The
ADR-0044 anchor check still compares closes only. FRED and materials
observations never carry a bar.

### 3. The database stores the bar beside the value

`market_observations` gains `open_value`, `high_value`, `low_value` and
`volume` (all `REAL`, nullable; migration `0023`). The three prices are
null together or set together, and `volume` is null without them. Every
write path (window and full history writes, ADR-0044) stores the bar the
answer carried, replacing what was stored for that day. The migration
also clears `history_checked_at` of every Twelve Data series, so the next
market sync fetches each one in full (one request a series, as every sync
already makes — no extra credits) and the stored history gains its bars
within one sync. Observations older than the provider's newest 800 may
stay close-only.

### 4. Every read carries the stored bar

Every response that carries a series' observations (Home, the Notebook,
`GET /stocks/:stockId/prices`) sends the bar of each day that has one.
The `market-refresh` completion's worst case grows with the bars:
`MAX_RUNNER_COMPLETION_BODY_BYTES` is raised to the measured worst case
(every tracked series, 800 observations each, the longest numbers), with
the test that measures it updated (TS and Rust).

### 5. Resampling aggregates bars

`resampleSeries` (`packages/domain/src/market/chartWindow.ts`) takes each
point's bar: a daily bar is the provider's; a weekly or coarser bar opens
at its first point's open, closes at its last close, and spans the
highest high and lowest low of its points; its volume is the sum of
theirs, or null when any has none. A point without a usable bar counts as
open = high = low = its close; `ChartBar.fromBars` says whether every
point of the bar had one. The Lean model (`formal/ResearchFormal/
ChartWindow.lean`) and its conformance vectors follow: bars stay within
their bounds (low ≤ open, close ≤ high) and the volume is the sum.

### 6. The viewer's chart type control

The viewer's display controls gain **Chart type** (チャートの種類):
**Line** (ライン) and **Candlestick** (ローソク足), a Shoelace select beside
Interval. Candlestick is offered when exactly one series is shown and it
has at least one bar; otherwise its option is disabled with the reason in
its text, as Log is ("Candlestick — one series only", "Candlestick — no
open/high/low from this source"). The Stocks page's Chart tab opens in
Candlestick when it is offered; the dialog opened from a widget opens in
Line, like the widget it came from. Nothing is saved (ADR-0025).

A candle's body runs from open to close and its wick from low to high. Up
(close > open) is green `#047857` and down (close < open) red `#b91c1c` —
the `CHANGE_TONES` emerald-700 and red-700 of the ▲/▼ text — and an
unchanged bar slate `#334155`, drawn as a line. The body is at least 1 px
high and 70 % of the bar spacing wide, at most 12 px; below 3 px of
spacing only the wick is drawn. Interval (Auto included), range, zoom,
pan, the navigator, Log/Linear, value/percent (candles rebased with the
same base as the line) and the moving averages work as in Line. When a
visible bar is not `fromBars`, a note under the chart says its open, high
and low are not known. Colour is never alone: the readout names the
direction and gives open, high, low, close and volume.

### 7. The volume panel

When one series is shown and a visible bar has a volume, a volume panel is
drawn under the price plot in the same SVG (about a fifth of the chart's
height, its own right-hand axis with compact numbers), in both chart
types, sharing the time axis, the crosshair and the gestures. Each bar is
coloured by its direction like the candles. A day without a volume has no
volume bar. The crosshair readout and the data-table twin add open, high,
low, close and volume when the series has bars.

### 8. Performance

Candles, wicks and volume bars are drawn as a few `path` elements (one per
colour and part), never one element per bar, built from the binary-searched
visible slice like the lines (ADR-0025 performance). `bun run bench` gains
a candle-and-volume case with a budget.

## Consequences

- A Twelve Data series' stored and sent observations are about three
  times larger; completions are larger and the completion limit grows.
- After the first sync following the migration, every Watchlist stock
  and every Twelve Data widget series has real daily bars.
- FRED and materials series are lines only; their Candlestick option says
  why.
- OHLC bars, Heikin-Ashi and the Japanese red-up colours were not chosen.
