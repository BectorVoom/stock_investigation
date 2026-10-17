# ADR-0026: Chart widgets carry their provenance

**Status:** Accepted · **Date:** 2026-10-17

## Context

The owner reported (2026-10-17): "The same graph is displayed inconsistently
between Chat and Notebook." The first fix (ADR-0024 amendment of the same day)
made the Notebook `chart` widget draw through the registry's shared plot, so
the marks, axes, legend and readout match. An independent review then found
what still differed: every number in a research dataset either cites a source
(with an as-of date) or declares itself an `assumption` or a `derived` value —
the contract rejects a bare number (hard gate 6) — and Chat shows that
provenance: a basis note ("Not sourced measurements: 3 assumptions …"), a
marker on each such cell of the data table, citation numbers and a Sources
list. "Add to Notebook" copied only the numbers, so the owner's own example
(Bear / Base / Bull growth, all assumptions) showed in the Notebook as plain
figures with no warning.

Asked whether a chart saved from Chat should stay a `research` widget (exact,
but not editable and not portable to Home or other chats) or become a chart
widget that carries its provenance, the owner chose the latter.

## Decision

**A `chart` widget carries the provenance of its numbers.**

- A point is `{ x, y, basis?, sourceId?, asOf? }` with the dataset cell's
  rules: `basis` is `"assumption"` or `"derived"`; a point with a `sourceId`
  must have an `asOf`. A point with neither is shown as a number whose basis
  is not stated — marked, never passed off as a measurement.
- The widget may carry `sourceIds` (the chart's own citations, as a research
  component's `sourceIds`) and `sources`: a copy of every evidence record the
  chart cites (points and `sourceIds`), at most `WIDGET_LIMITS.maxChartSources`.
  Every cited id has exactly one copy and no copy is uncited (schema rule), so
  the widget renders the same anywhere — Home, another chat — without the
  conversation that produced it.
- **The Notebook and Home draw a `chart` widget through the registry's
  `ChartShell`** with the shared `LinePlot` / `BarPlot` (ADR-0024 amendment):
  the same notices, basis note, data table with markers and citations, and
  Sources list as Chat. Only the heading is hidden (ADR-0024: no widget shows
  a title; the frame's accessible name is the title).
- **Copies are checked against the owner's records.** A source copy is only
  accepted when it equals the owner's stored evidence record with that id, so
  no client or agent can attach a made-up source to a number. The API checks
  on every notebook save, on the notebook assistant's completed turn and on
  every Home dashboard save; it looks up (in one batched query) only the
  copies that are not already, unchanged, in the stored version. A mismatch is
  refused with `INVALID_NOTEBOOK` (a notebook save, or the assistant's turn as
  its failure) or `VALIDATION_FAILED` (a Home save) and one sentence naming
  the chart (`packages/application/src/chartSources.ts`).
- **"Add to Notebook"** converts a line or bar chart only when the conversion
  is lossless — now including provenance: the same rows, values, basis,
  source and as-of per cell, the same `sourceIds`, every cited record present
  in the conversation, and no empty cell with a stated reason (a widget point
  cannot carry "not disclosed in the 10-K", which Chat's data table shows).
  Otherwise the chart stays a `research` widget. Candlestick charts stay
  `research` (candles are not a line).
- **Editing:** the content editor keeps a point's provenance only while the
  chart's unit and the point's series, label and value are unchanged; an
  edited or new point has none (and is marked so), the chart's own
  `sourceIds` go once no such point remains, and copies no longer cited are
  dropped.
- **AI agents keep only the provenance they carried over unchanged.** The
  record check proves a copy is real, not that a number came from it, so
  what the notebook assistant (`applyNotebookCommands`, runner pre-check and
  API apply) or the Home MCP server (before its PUT) writes is normalised by
  `withEarnedChartProvenance`: a point keeps its basis, source and as-of date
  only in the same widget, the same series and the same meaning (unit, both
  axis titles and the x kind; not the hidden title), with the same label
  (occurrence) and value — or when the whole chart is an unchanged copy
  of one on the page (a duplicate). The chart's own `sourceIds` stay only
  while such a point remains; copies nobody cites go. Everything else is
  written without provenance ("basis not stated") rather than refused, so a
  turn that changes a chart's numbers or unit still succeeds. An agent's
  draft is reconciled first (`reconcileChartDraft`: a citation without a copy
  loses its source, an uncited copy goes). The assistant's prompt shows a
  chart's citations but not the evidence copies and says not to add
  provenance.
- **Deleting a conversation keeps the evidence chart copies cite** on Home
  and in every other notebook (one set-based query,
  `listChartEvidenceIds`), so Undo, Reset-Undo and cut-and-paste of such a
  chart keep passing the record check.

## Consequences

- Owner-made and assistant-made charts (no provenance) now show the basis
  note "Not sourced measurements: N values with no stated basis" and a marker
  per cell, as any registry chart with such numbers does. This is hard gate 6
  applied to every chart, not a new rule.
- A chart widget can grow by up to `maxChartSources` evidence copies (each
  under ~1.5 KB); `WIDGET_LIMITS.maxContentBytes` still bounds a page.
- Chart widgets saved before this decision have no provenance and render as
  "basis not stated"; re-adding the chart from Chat brings its provenance.
- Deleting a conversation never breaks a saved chart: it renders from its
  copies, and the records they cite are kept while a chart on Home or in
  another notebook carries a copy. One order still fails: remove a sourced
  chart from Home, delete its conversation, then Undo — the records went with
  the conversation, so the restoring save is refused with a sentence saying
  so; add the chart again from another conversation that cites them.
- The Notebook chart's data table labels its columns with the series names
  and the chart's unit, and its x column with the x-axis title; a Chat
  table uses the dataset's column labels and units, which may be worded
  differently. The cells, markers and citations are the same.
