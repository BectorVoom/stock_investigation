# ADR-0061: Widgets cannot be selected

Status: accepted, 2026-11-03. Amends ADR-0020 (the assistant's explicit
selection target), ADR-0021 (header-click selection on untitled frames),
ADR-0023 (selection toolbar and ⌘X / ⌘C on selected widgets) and ADR-0024
(selection in the shared widget specification).

## Context

The owner asked (2026-11-02): "Remove the left button of the two buttons in
the upper-right corner of the widget, along with all associated
functionality." The two buttons were the select toggle (a check-circle) and
the actions menu (⋯). The toggle was one of four ways into widget
selection, which also drove a selection toolbar, keyboard shortcuts, the
composer's "Selected widgets" chips, the Notebook's Ask AI items and the
notebook assistant's `selectedWidgetIds` context. Asked how far the removal
should go, the owner chose to remove it end to end, server and runners
included.

## Decision

1. **No selection in the UI.** A widget header holds only the grip and the
   page's actions slot. `@research/widget-grid`'s `WidgetFrame` has no
   `selected` / `onSelectChange` props, no `data-widget-selected`, no
   `.wg-select-toggle` and no `--wg-selected`; a header click that is not a
   drag does nothing. The selection toolbar, the Escape-to-clear key and
   ⌘X / ⌘C on selected widgets are gone. Cut, Copy, Duplicate and Remove act
   on one widget through its ⋯ menu; Paste after pastes after that widget,
   and the header's Paste widgets button and ⌘V paste at the end.
2. **No Ask AI.** The Notebook's ⋯ Ask AI item and the toolbar's "Ask AI
   about the selected widgets" are removed, with the composer's "Selected
   widgets" chips and its "About the whole notebook" note. The composer
   targets the notebook assistant in Notebook-first, when chosen in its +
   menu, or when the draft names the notebook (unchanged).
3. **No selection on the wire.** `selectedWidgetIds` leaves the assist
   request (`POST …/notebook/assist`, refused with `VALIDATION_FAILED` if
   sent), the stored job request, the `notebook-assist` claim and both
   runners (TypeScript and Rust). `NOTEBOOK_LIMITS.maxSelectedWidgets` and
   the `INVALID_NOTEBOOK_SELECTION` error code are removed; nothing sends
   that code any more, so no code is renamed (API-008).
4. **Every widget travels.** The assistant's prompt always shows every
   widget with its bodies cut to the preview limits, as many as fit the
   80 000-byte widget budget, the rest as summary lines. Its context line is
   now `Notebook context: …`; the shared prompt template (`prompt-parts.json`)
   is split there. When the instruction says "this", "these" or "it" without
   naming a widget, the model is told to ask which widget is meant. The
   scripted test agent targets the widgets whose titles the instruction
   names.
5. **Queued jobs keep running.** A `notebook-assist` job stored before this
   change still holds `selectedWidgetIds`; the stored-request schema drops
   it on read, so such a job is claimed and runs normally.

## Consequences

- The fail-closed prompt budget (`NOTEBOOK_PROMPT_TOO_LARGE`) stays, but
  widget content can no longer reach it; its tests drive it with an
  instruction over the API's own limit.
- The server and both runners change together. A runner built before this
  change rejects the new claim (it requires the field), and the new runners
  reject an old server's claim (an unknown field), so a deployment updates
  them together, as the local launcher already does.
- An idempotency key reused across this change no longer matches its stored
  fingerprint (the fingerprint no longer includes the selection), so a
  replay of an assist request sent before the change is refused as
  `IDEMPOTENCY_KEY_REUSED` instead of replayed.
- The conformance vectors (`vectors/notebook/`, `vectors/contracts/`,
  `vectors/runner/out/complete-notebook-assisted.json`) are regenerated.
