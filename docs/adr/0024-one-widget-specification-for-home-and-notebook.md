# ADR-0024: One widget specification for Home and the Notebook

**Status:** Accepted · **Date:** 2026-10-15

## Context

The owner asked (2026-10-15) to "unify the widget specifications across the
Chat and Home pages", and chose the scope and direction: type names and
catalog, title rule and sizes, frame and actions menu, and edit dialogs are
all the same; where the pages disagree, the Notebook's spec (ADR-0020,
ADR-0021, ADR-0023) wins. The same day the owner asked to remove the remove
confirmation dialog: Remove acts at once on both pages, Undo restores.

Before this decision the two pages had grown two specs over one package
(`@research/widget-grid`, ADR-0019):

| | Home | Notebook |
|---|---|---|
| Types | 5 market types; `metric` = live series | 10 types; `metric` = static number, `market-metric` = live series |
| Title | 1–80 characters | 1–120 characters |
| Menu | Edit widget, Move, Remove widget | Edit…, Size, Cut, Copy, Paste after, Duplicate, Move, Ask AI, Go to source, Remove |
| Selection, clipboard, undo | none | selection toolbar, cut/copy/paste, Undo |
| Add | one dialog with a type select | `+` menu listing every type |
| Edit | `WidgetDialog` | `NotebookEditor` / `NotebookMarketDialog` |
| Agent types | MCP table of 5 types | notebook assistant table of 10 types |

## Decision

### One catalog, one core

`packages/contracts/src/widgets.ts` holds the one widget specification:

- `WIDGET_TYPES`: `text`, `metric` (static), `chart`, `table`, `research`,
  `market-metric`, `line-chart`, `stock-table`, `indicator-table`,
  `earnings-calendar` — the Notebook's names. Home's live `metric` is now
  `market-metric` everywhere.
- `WIDGET_CONTENT_SHAPES`: the type-specific fields of each type, and
  `WIDGET_TYPE_META`: label, description, default size and allowed sizes —
  one table for both pages' UI, the MCP agent types and the notebook
  assistant.
- `widgetCoreSchema`: `widgetId`, `title` (trimmed, 1–120 characters),
  `size` (`small` / `medium` / `large`) plus the content of one type, with the
  same refinements (a table row has one cell per column; a widget never
  repeats a series).
- `HOME_WIDGET_TYPES` is every type except `research`: a research widget
  shows a canvas component of one conversation, and Home has no
  conversation. The Notebook takes every type.

A Home widget (`HomeWidget`) is a widget core; a notebook widget is a widget
core plus the server-stamped metadata it already had (`createdAt`,
`updatedAt`, `revision`, `origin`). There is no conversion between the two
any more (`notebookWidgetAsHomeWidget` / `homeWidgetAsNotebookWidget` are
gone); copying a widget from one page to the other is copying its core.

### What stays page-specific, and why

- **Capacity.** Home holds at most 24 widgets (the bound the Lean
  `Dashboard` model proves its id structure against); a notebook holds 200.
  Both name at most 30 distinct market series and hold at most 850 KB of
  widget content (`WIDGET_LIMITS.maxContentBytes`, one rule:
  `widgetContentBytes`), so any widget fits on either page.
- **Look.** Home keeps visible titles (its metric titles name the series),
  bordered frames and viewport-sized columns; the Notebook keeps untitled,
  quiet frames in container-sized columns (ADR-0021).
- **Actions only a conversation has.** "Ask AI" and "Go to source" are
  Notebook-only; Home's "Refresh market data" and "Reset to default
  arrangement" are Home-only.
- **Undo depth.** The Notebook's Undo restores server-kept revisions
  (ADR-0020). Home's Undo restores the bodies kept in this browser session
  (at most 20), saved with the same compare-and-set as any Home edit; a
  reload clears it. No new table.

### One frame menu, one add menu, one set of dialogs

Both pages build their widget menu with one function
(`apps/web/src/widgets/widgetActions.ts`): Edit…, Size: Small / Medium /
Large, Cut, Copy, Paste after, Duplicate, Move earlier, Move later, the
page's own items, Remove. Remove acts at once with no dialog. Both pages
have the selection toolbar (Duplicate, Cut, Copy, Remove, Clear; the
Notebook adds Ask AI), the header `+` menu listing every type the page
takes, Paste widgets and Undo, and the keyboard shortcuts of ADR-0023.

The clipboard is one store for both pages: a widget copied on Home pastes in
a notebook and back. A research widget pastes only into its own
conversation's notebook (unchanged), never into Home.

Bodies render through one `WidgetBody` (`apps/web/src/widgets/`): the rich
Text widget, the static metric, chart and table, the research component, and
the live market widgets through the market components. Editing opens one
`WidgetEditor`: the market form (series, range, days ahead) for market types,
the content editor for the others. Adding a static type adds a starter and
opens its editor; adding a market type opens the market form first, as in
the Notebook.

### Stored data

`homeDashboardSchema` is `schemaVersion: 2`. A stored version-1 dashboard is
read through `storedHomeDashboardSchema`, which upgrades it on read (each
`metric` becomes `market-metric`; everything else is unchanged and already
valid), so no migration runs and the next save writes version 2. The API
accepts only version 2. Notebook bodies are unchanged: they already used
these names.

### Agent layer

The MCP Home server describes every Home type from the same tables
(`WIDGET_TYPE_META`, the JSON Schema of `WIDGET_CONTENT_SHAPES`), exactly
as the notebook assistant does; the series help stays with the market types.

## Consequences

- Home gains Text, Metric, Chart and Table widgets, the size menu,
  duplicate, cut/copy/paste, selection and Undo; it loses the type select in
  its add dialog (the `+` menu replaces it).
- The Home `metric` type name is gone from the API: an MCP client or script
  that sends `type: "metric"` for a live series must send `market-metric`.
  A stored version-1 dashboard still loads.
- Home menu labels follow the Notebook's ("Edit…", "Remove"); specs and the
  UI review use the new names.
- The Lean `Dashboard` model is unchanged: it abstracts widget content and
  the Home bound stays 24.
