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
  source and as-of per cell, the same `sourceIds`, and every cited record
  present in the conversation. Otherwise the chart stays a `research` widget.
  Candlestick charts stay `research` (candles are not a line).
- **Editing:** the content editor keeps a point's provenance only while its
  label and value are unchanged; an edited or new point has none (and is
  marked so), and copies no longer cited are dropped.
- **AI agents never add provenance.** The record check proves a copy is real,
  not that a number came from it, so an agent could otherwise attach a real
  citation to a number it made up. For the notebook assistant (runner
  pre-check and API apply, `applyNotebookCommands`) and the Home MCP server
  (before its PUT), every chart point an agent writes with a basis, source or
  as-of date must already be on the page, identical, and every chart
  `sourceIds` entry must already be cited there (`chartProvenanceAddedTo`);
  copies a changed series no longer cites are dropped
  (`pruneUncitedChartSources`). The assistant's prompt shows a chart's
  citations but not the evidence copies and says not to add provenance.

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
  copies. Pasting such a chart elsewhere is refused only if its records are
  gone from the owner's store.
