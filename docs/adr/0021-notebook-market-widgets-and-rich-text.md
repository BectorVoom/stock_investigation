# ADR-0021: Home widgets in the Notebook, rich text, untitled frames

**Status:** Accepted · **Date:** 2026-10-15

## Context

The owner asked (2026-10-15) for five Notebook changes: vertical scrolling
through all widgets; a fix for the notebook assistant failing to make "a
chart of gold prices over the past year"; no title at the top of each
widget; every Home widget type usable in the Notebook, reusing the shared
widget code; and a Notion-like rich-text Text widget.

The assistant failure has one root cause: the notebook assistant (ADR-0020)
has no tools, no network and no evidence, and its only chart type carries
its own numbers. Asked for market data it can only invent numbers or write a
placeholder (on 2026-10-14 "Please create chart for import car." produced a
"placeholder" line chart), or emit a long invented series that fails
validation. In Chat-first with nothing selected the composer sends to
Research, which cannot create widgets at all.

## Decision

### Market widgets: Home's types, live data, one schema

The notebook gains Home's five widget types: `market-metric` (Home's
`metric`, renamed because the notebook's own `metric` is a static number),
`line-chart`, `stock-table`, `indicator-table`, `earnings-calendar`. Their
fields are exactly Home's (`HOME_WIDGET_CONFIG_SHAPES` in contracts, from
which `homeWidgetSchema` is now built too). They carry no numbers: they name
market series and render live data through the same Home widget components
(`apps/web/src/home/widgetRegistry.tsx`), converted with
`notebookWidgetAsHomeWidget` / `homeWidgetAsNotebookWidget`.

- A notebook names at most `MARKET_LIMITS.maxSeries` (30) distinct series
  (`TOO_MANY_SERIES` in `notebookCapacityProblem`).
- Market refresh fetches the union of the Home dashboard's series and every
  notebook's market series, Home first, at most
  `MARKET_LIMITS.maxTrackedSeries` (60). A Home save keeps stored series a
  notebook still names. The notebook's series are read from the stored
  notebook bodies (SQLite `json_each`), so there is no second copy to keep
  in sync.
- `GET /workspaces/:id/notebook/market-data` returns the notebook's series
  in the Home data shape (`homeDataResponseSchema`, ETag like `/home/data`).
  The client queues the existing market refresh once when a series was never
  refreshed.

### The notebook assistant uses market widgets for market data

The prompt lists the market catalog (series id, label, category) and the
market widget types, and states a rule: numbers in `chart`, `metric` and
`table` widgets come only from the owner's instruction, the notebook or the
conversation; market prices and indicators use a market widget with a
series id; when no series fits, the reply says so instead of inventing
data. "A chart of gold prices over the past year" becomes `add line-chart
{ seriesIds: ["twelve-data:XAU/USD"], range: "1y" }`. Without the provider
key the widget shows Home's "not configured" reason, as Home does.

While the owner has not chosen a target by hand, the composer switches to
the Notebook target when the instruction names the notebook or a widget.

### Rich text is a Markdown subset

A `text` widget's `text` is Markdown in the subset `NOTEBOOK_TEXT_MARKDOWN`
(contracts) documents: headings, bold, italic, strike, inline code, http(s)
and mailto links, bullet, numbered and to-do lists, quotes, code blocks,
dividers. The assistant writes it natively; old plain text renders as before
(a single newline is a line break). The widget is edited in place, Notion
style (Markdown shortcuts, a "/" block menu, a selection toolbar with link
editing, ⌘B/⌘I/⌘K), and renders without `innerHTML` from a parser that
shows anything outside the subset as literal text.

### Untitled frames

`WidgetFrame` takes `titleHidden`: the title stays the accessible name of
the frame and its body; the header shrinks to the grip, select toggle and
actions, overlaid at the top and revealed on hover, focus and selection in
the quiet variant. The Notebook hides titles; Home keeps them (its metric
titles name the series). Titles stay in the data: chat change cards,
selection chips and dialogs still use them.

### Scrolling

The Notebook panel's widget list scrolls inside the panel below its fixed
header and toolbar. Drag and drop auto-scrolls the nearest scrollable
ancestor of the grid, not only the window.

## Consequences

- No migration: notebook bodies already hold JSON.
- New route `GET /workspaces/:id/notebook/market-data`.
- Market data still needs `FRED_API_KEY` / `TWELVE_DATA_API_KEY`; notebook
  market widgets show the same configured/unavailable states as Home.
