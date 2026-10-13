# ADR-0016: Home widgets follow Apple's Human Interface Guidelines

**Status:** Accepted · **Date:** 2026-10-13

## Context

The owner asked for the Home page to follow Apple's Human Interface
Guidelines (widgets, buttons, layout, accessibility, icons). The Home grid
grew widgets by content, drew bordered panels and text buttons, and used the
Shoelace kit for frames, menus and buttons (ADR-0015). Dragging widgets is a
separate later task, but the header must already be a single clean strip so
a drag handle can use it.

## Decision

**Three fixed sizes on a grid of equal cells with a fixed row height**
(HIG Widgets: system widgets come in fixed sizes on a grid; "Make each size
distinct"). The grid is `grid-cols-2 lg:grid-cols-4` with
`auto-rows-[17rem]` and a 16 px gap (the HIG standard margin), in normal row
flow so visual order equals DOM order (not `grid-flow-dense`). Sizes are
defined in one table (`HOME_SIZE_SPAN` in `homeModel.ts`, static class
strings so Tailwind sees them): Small 1 × 1 (17rem, 272 px), Medium 2 × 2
(35rem, 560 px),
Large full width × 2 at `lg` (4 columns) and 2 × 2 below it (35rem, 560 px).
Defaults per type fit the shapes: a metric is one number (small), a line
chart needs plot area (medium), a stock table holds a few rows (medium), an
indicator table holds eight columns (large) — the default dashboard already
used those, so no contract changed. The frame fills its cell (`h-full`) and
never grows with content: the header strip stays fixed while the body below
it scrolls inside the frame (`overflow-y-auto`), keyboard-focusable
(`tabindex="0"`, labelled by the widget title) with the `:focus-visible`
ring; tables keep their own horizontal scroll. Padding is 16 px (`p-4`)
with an 8 px header-to-body gap; the size control's help text states each
shape ("1 × 1", "2 × 2", "full width × 2"); loading skeletons use the same
grid and cell height so the page does not jump.

**Minimalist look, barely visible borders.** The widget frame is a native
`article` (white on the grey page, 1 px `slate-200` hairline — the faintest
step that still reads against `bg-slate-100` — no shadow, no header
divider, `rounded-2xl`). `sl-card` was replaced by the native element as the
simpler option: one surface needs no card parts, theming or shadow-DOM
styling. Table rules and the provenance divider are hairlines no darker
than `slate-200`; there are no boxes inside boxes. Text colours and sizes
are unchanged. The toolbar lost its bordered panel (status `<output>` on
the leading side, icon buttons on the trailing side). Form inputs keep
their input border (a control boundary needs 3:1); notices and
`ErrorNotice` keep their tinted, bordered look (they communicate state).

**Icon-only buttons everywhere on Home, never in the app header** (HIG
Buttons / Icons / Accessibility: familiar actions get familiar icons —
`plus` Add, `ellipsis` More, `trash` Delete, `pencil` Rename/edit,
`checkmark` Done, `xmark` Cancel; comfortable hit regions — 28 × 28 pt
macOS, 44 × 44 pt iOS; "Always include a press state"; one or two prominent
buttons per view; never the primary style for a destructive action; every
icon needs an alternative text label; macOS tooltips on hover). One shared
native part, `IconButton` in `components/ui.tsx`: round (`rounded-full`),
borderless, 16 px inline Bootstrap Icons glyph (MIT, same pattern as the
existing `PanelCollapseButton`, so it also works in `ErrorNotice`, which is
not part of the lazy Home chunk), 28 px hit area (44 px on coarse
pointers), 4 px between neighbours, plain / primary / danger tones with
hover and pressed states, `opacity-50` disabled, `:focus-visible` ring. The
accessible name is the former visible text exactly ("Add widget", "Refresh
market data", "Reset to default arrangement", "Try again", "Cancel",
"Reset widgets", "Add widget" / "Save widget", "Add series"; "`<title>`
actions" for widgets), with the same words in the `title` tooltip — so
existing role-and-name tests keep working. `ErrorNotice` grew an opt-in
icon retry; other pages keep the text button. The widget actions menu keeps
text items (a menu is not a button; HIG menus carry text) with leading
icons and unchanged values/behaviour. Dialogs still say in words what the
icon buttons do (headings, the reset sentence); the empty state no longer
names a removed label ("No widgets yet. Use the + button to add one.");
`<summary>` rows and selects are untouched.

## Consequences

- `rounded-2xl` is now allowed under `apps/web/src/home/` as well as
  `apps/web/src/chat/` (guideline sections 4, 11, 13 and the conformance
  test, including its self-test, updated).
- The Shoelace set shrank to `sl-dialog`, `sl-select` + `sl-option`,
  `sl-input`, `sl-skeleton`, `sl-icon` (ADR-0015 updated); the Home chunk
  fell from 230.35 kB (60.09 kB gzip) to **187.75 kB (52.17 kB gzip)**.
- E2E proves the sizes (identical boxes per size at 1440 × 900 and
  390 × 844; 272 px small, 560 px medium/large; no horizontal overflow at
  390 px), the icon-only buttons (no visible text on any `main` button
  while header navigation keeps text) and the in-frame scrolling
  (keyboard-focusable, labelled, article box unchanged while the body
  scrolls).

## Addendum (2026-10-13): drag and drop to reposition widgets

**Status:** Accepted · **Date:** 2026-10-13

### Context

The look task left the header a single clean strip so a drag handle could
use it, and the domain already carries a pure `reorder` edit (the widget
ends at `toIndex` of the result, the others keep their order). The remaining
question was how a drop target is chosen and previewed on a grid of mixed
sizes without flip-flopping, and how keyboard and assistive-technology users
move widgets.

### Decision

**Order-based reflow with a placeholder, not free placement with gaps**
(HIG Drag and drop). The whole header strip (grip glyph, title, actions
button — nothing else) is the handle: `cursor-grab` (`cursor-grabbing`
while dragging), `select-none`, `touch-action: none` on the header so a
touch drag is not taken as a scroll while widget bodies keep scrolling. A
press on the actions button never starts a drag. Pointer Events only (the
HTML5 drag-and-drop API does not work for touch and is unreliable across
shadow DOM in WebKit); primary button / one touch / pen; the drag starts
after 4 px of movement so press-and-release is a plain click. The lifted
widget follows the pointer with its grab offset at about 90 % opacity above
its neighbours with the blue focus-colour ring instead of a shadow (the
guideline forbids shadows) and never changes size. The slot it would take is
a same-size dashed `slate-300` placeholder with no fill while the others move
out of the way immediately in their real grid positions. The preview uses
CSS `order` set through the CSSOM (real DOM order changes only on commit),
so widget subtrees keep their state, and pointer moves coalesce on
`requestAnimationFrame` with slot rectangles re-read only on reorder. The
drop commits exactly one `reorder` edit through `saveEdit` (nothing is saved
when the position did not change); the preview stays on screen while the
save is in flight, and a failed or conflicting save restores the server
order with the existing notice. `Escape`, `pointercancel` or the window
losing focus cancels with the widget returning and nothing saved. No drag
starts while a save is in flight, while loading, or with one widget; the
page auto-scrolls near the viewport edges; reflow animates for at most
200 ms under `motion-safe:` only.

**Stability rule with hysteresis** (`apps/web/src/home/dragModel.ts`, pure,
O(n) per move): the target changes only when the pointer crosses the
midpoint of another slot in the direction of travel (dot of
pointer-minus-hover-center with hover-minus-dragged-center greater than
zero), and the slot just vacated stays banned until the pointer leaves it.

**The menu is the alternative without dragging** (HIG Accessibility): Move
earlier/later stay exactly as they are — the keyboard and
assistive-technology path — and one visually hidden polite live region
announces every completed move, dragged or from the menu (`Moved “<title>”
to position <i> of <n>.`).

**Undo is not offered: dragging back is the reversal.** A dropped reorder is
one saved arrangement like any other menu move; moving the widget back (by
drag or by menu) restores the earlier order, so no separate undo stack is
kept.

## Addendum (2026-10-14): scroll-correct slots, continuous edge auto-scroll, engine extraction

- **The engine lives in `apps/web/src/home/widgetDrag.ts`.** `HomeView.tsx`
  no longer holds pointer/DOM code: `createWidgetDrag({ getGrid, getWidgets,
  canStart, onDrop })` owns the state, the listeners, the CSSOM writes and
  the cleanup, and returns the grid `pointerdown` handler plus
  `dispose`/`clearPreview`/`cancel`. `HomeView` keeps only the wiring (what
  may start a drag, what a drop saves, keeping the preview on screen until
  the save settles). `dragModel.ts` stays pure.
- **Slots are page coordinates.** Slot rectangles are cached as
  `getBoundingClientRect` plus the scroll offset at measure time and the
  pointer is converted to page coordinates on every evaluation, so any
  scrolling during a drag (edge auto-scroll, wheel, trackpad, scrollbar)
  never stales the decision. A `scroll` listener schedules a re-evaluation
  frame; at most one slot re-read happens per frame, only when the target
  changed.
- **Edge auto-scroll is continuous.** While a drag is active and the pointer
  rests within 80 px of the top or bottom viewport edge and the page can
  still scroll that way, every frame scrolls by an amount proportional to
  how deep into the zone the pointer is (capped at about 16 px) and
  re-evaluates the drop target as content passes under the pointer. It stops
  when the pointer leaves the zone, the page reaches its end, or the drag
  ends or is cancelled.
- **A repeated move announces again.** The polite live region clears its
  text before setting the new sentence (on a later task), so moving a widget
  to the same position number again still announces.

### Alternatives considered (deliberately not done)

- **Free placement with gaps.** Rejected: visual order must equal DOM order
  (as with the rejected `grid-flow-dense`), so every position is an index,
  never a gap.
- **HTML5 drag-and-drop API.** Rejected: no touch support and unreliable
  across shadow DOM in WebKit.
- **A separate undo for drags.** Rejected: dragging back is the reversal;
  the arrangement is saved state, not an edit history.

## Alternatives considered (deliberately not done)

- **Shoelace `sl-icon-button` for the icon buttons.** Rejected: its icons
  must ship as same-origin files and register like the existing ones, and
  `ErrorNotice` (app-wide, outside the lazy chunk) would still need a
  native solution — one shared native part covers both.
- **Keeping `sl-card` and styling it through parts/tokens.** Rejected as
  the more complex option: the native article needs no shadow-DOM styling
  and reads exactly like the design (one surface, one hairline).
- **`grid-flow-dense` to pack mixed sizes.** Rejected: visual order must
  equal DOM order.
