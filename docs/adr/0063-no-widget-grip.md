# ADR-0063: Widgets have no grip

Status: accepted, 2026-11-03. Amends ADR-0062 (the grip was a second drag
handle beside the top edge), ADR-0021 and ADR-0024 (the grip in the
untitled frame's control cluster).

## Context

After ADR-0062 made a widget's whole top edge a drag handle, the owner
asked (2026-11-03): "Please delete upper left button." Asked which one, the
owner chose the grip (⣿), the left of the two controls in each widget's
top-right cluster; the right one is the actions menu (⋯).

## Decision

1. `WidgetFrame` renders no grip glyph: a titled header holds the title and
   the host's actions, an untitled frame's cluster holds the actions alone.
   The `.wg-grip` styles are removed.
2. Dragging is unchanged otherwise: in an untitled frame (every frame on
   Home and in the Notebook) the full-width top-edge strip (ADR-0062) is the
   drag handle, with the grab cursor as its affordance; in a titled frame
   the header strip still is.
3. Move earlier / Move later in each widget's menu stays the keyboard and
   assistive-technology path, so removing the grip loses no access.

## Consequences

- One control less on every widget: the cluster on the top-right edge is
  the ⋯ button only.
- Without hover (touch) there is no visible drag affordance; the top band
  is 28 px tall there (ADR-0062) and the menu's Move items remain.
- Tests and specs that pressed `.wg-grip` press `.wg-drag-strip` instead.
