# ADR-0062: Drag a widget by its top edge

Status: accepted, 2026-11-03. Amends ADR-0021 (untitled frames: the grip
was the only drag handle) and ADR-0024 (drag and drop in the shared widget
specification).

## Context

The owner asked (2026-11-03): "Please add drag widget function. User can
hold top area widget." Home and the Notebook show every widget untitled
(ADR-0021, ADR-0024), so a frame's header is a small cluster on its
top-right edge and the 28 px grip in it was the only place a drag could
start. Everywhere else on the widget, a press went to the content.

## Decision

1. **The top edge is a drag handle.** An untitled frame renders a
   `.wg-drag-strip` (`data-widget-drag-handle`, `aria-hidden`) over its
   empty top padding, the full width of the frame. A press there that moves
   4 px lifts the widget exactly like the grip: the same drag engine, the
   same placeholder, reflow, auto-scroll, Escape and drop.
2. **Never over content.** The strip covers only the 1rem padding above the
   body, and sits under the control cluster (z-index 1), whose grip and
   actions button keep their own presses. It shows the grab cursor and is
   never a text selection or a page scroll (`touch-action: none`).
3. **Easy to hold on touch.** On `pointer: coarse` devices the frame's top
   padding and the strip grow to 28 px (the grip's target), so the band is
   comfortably holdable and still never covers content.
4. **Out of the way while editing.** Like the cluster, the strip is hidden
   while a Text widget is being edited, so a press above the text never
   lifts the widget mid-edit.
5. **Keyboard unchanged.** The strip is pointer-only; Move earlier / Move
   later in each widget's menu stays the keyboard and assistive-technology
   path.

## Consequences

- On touch screens every untitled widget's content starts 12 px lower.
- Titled frames are unchanged: their header strip already spans the top.
- Verified in Chromium against the development server: the element under
  the top band is the strip (grab cursor); dragging it onto the next widget
  reorders and saves; under touch emulation the padding and strip are 28 px.
