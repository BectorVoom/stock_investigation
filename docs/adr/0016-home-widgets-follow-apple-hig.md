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
`auto-rows-[15rem]` and a 16 px gap (the HIG standard margin), in normal row
flow so visual order equals DOM order (not `grid-flow-dense`). Sizes are
defined in one table (`HOME_SIZE_SPAN` in `homeModel.ts`, static class
strings so Tailwind sees them): Small 1 × 1 (15rem), Medium 2 × 2 (31rem),
Large full width × 2 at `lg` (4 columns) and 2 × 2 below it (31rem).
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
  390 × 844; 240 px small, 496 px medium/large; no horizontal overflow at
  390 px), the icon-only buttons (no visible text on any `main` button
  while header navigation keeps text) and the in-frame scrolling
  (keyboard-focusable, labelled, article box unchanged while the body
  scrolls).

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
