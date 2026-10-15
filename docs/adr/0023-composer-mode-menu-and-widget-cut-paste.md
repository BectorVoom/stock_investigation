# ADR-0023: The composer's modes live in a + menu; Notebook widgets cut, copy and paste

**Status:** Accepted · **Date:** 2026-10-15 · Amends ADR-0020 and ADR-0021
(the composer's target control) and the Notebook panel's widget actions.

## Context

The owner asked (2026-10-15): "On the Chat page, update the chat input
interface to work like ChatGPT: Research and Notebook modes should appear in
a menu when the plus (+) button is clicked, allowing users to select and
switch between modes. Remove the existing dedicated Research and Notebook
buttons. Additionally, add cut-and-paste support for widgets."

Until now the composer opened with a "Composer target" fieldset of two
pressed-state buttons, Research and Notebook, above the input bar. The
Notebook panel's widgets could be duplicated, moved and removed, but there
was no way to take a widget out of one place and put it somewhere else —
in particular into another chat's notebook.

## Decision

### The composer's mode menu

- **The two buttons are removed.** The input bar (the rounded field holding
  the textarea and the send button) gains a round **+** button at its
  leading edge, as in ChatGPT. Its accessible name and tooltip are
  "Choose mode"; it is a menu button (`aria-haspopup="menu"`,
  `aria-expanded`).
- **The menu** ("Composer mode") lists the two modes as `menuitemradio`
  items with `aria-checked`: **Research** (search glyph) and **Notebook**
  (journal glyph); the current one carries a trailing check mark. The menu
  opens upward and aligns with the + button's leading edge (the composer
  sits at the bottom of the page). Keyboard behaviour is the shared
  `ActionMenu`'s (Enter/Space/ArrowDown open, arrows move, Escape closes and
  returns focus). Choosing a mode closes the menu and puts focus in the
  textarea, so the owner can type at once.
- **The chosen mode shows as a chip** beside the + button only when it is
  not the default, as ChatGPT shows a chosen tool: Research is the default
  and shows no chip (the placeholder "Ask a research question…" says it);
  Notebook shows a "Notebook" chip whose × button ("Leave Notebook mode")
  returns to Research. The automatic routing of ADR-0021 (a draft that names
  the notebook goes to the notebook assistant until the owner chooses by
  hand) is unchanged; the chip makes that routing visible.
- Everything else about the composer is unchanged: the form's name
  ("Research composer" / "Notebook composer"), the selected-widget chips,
  the placeholder, the send button and the problems lists.
- `ActionMenu` gains two opt-in props used here: items may carry
  `checked` (they then render as `menuitemradio` with `aria-checked` and a
  trailing check), and the menu may open `placement: "above-start"`.
  Existing menus are unchanged.

### Cut, copy and paste of Notebook widgets

- **One widget clipboard for the app**, separate from the system clipboard
  (`apps/web/src/notebook/widgetClipboard.ts`). It holds the widgets' cores
  and origins plus the workspace they came from. It is kept in memory and in
  `localStorage` (parsed with the contract schemas on read, empty when absent
  or invalid; storage failures are ignored), so a widget cut in one chat can
  be pasted into another chat, after a reload or in another tab. The system
  clipboard is not used: browsers only allow plain text and HTML there, and
  a widget is structured data the server validates.
- **Cut** copies the widgets to the clipboard and removes them in one owner
  edit — no confirmation, because the Notebook's Undo restores them and the
  clipboard still holds them. **Copy** only fills the clipboard. **Paste**
  inserts every clipboard widget, under fresh ids and in clipboard order,
  after the last selected widget (or at the end when nothing is selected),
  as one owner edit; the pasted widgets become the selection. The clipboard
  is not emptied by a paste, so the same widgets can be pasted again.
- **Where it lives:** each widget's actions menu has Cut, Copy and
  "Paste after" (disabled while the clipboard is empty); the selection
  toolbar has Cut and Copy; the Notebook header has a Paste button
  (disabled while the clipboard is empty). With focus in the Notebook panel
  but not in a text field, the rich-text editor, a dialog or a menu,
  ⌘X / ⌘C / ⌘V (Ctrl on other systems) act on the selected widgets; ⌘C and
  ⌘X leave a non-empty text selection to the browser.
- **Pasting into another chat:** origins point at messages of the source
  chat, so a widget pasted elsewhere becomes owner-made. A `research` widget
  shows a research component of its own chat, so it is pasted only into that
  chat; elsewhere it is skipped and a notice says so. Within the same chat
  the original origin is kept (cut + paste is a move).
- A paste that would exceed the notebook's widget limit is refused whole by
  the existing capacity rule, with its notice. Every result is announced in
  a polite live region ("Cut 2 widgets.", "Copied 1 widget.",
  "Pasted 2 widgets.").
- No API, contract schema, migration or runner change: paste is an ordinary
  notebook save (`PUT /api/v1/workspaces/{id}/notebook`), validated by the
  server like any other.

## Consequences

- The composer is one line tall until the owner opens the menu, and the mode
  control sits where ChatGPT owners expect it. The mode is one click further
  away than before; the chip keeps a non-default mode visible.
- Home widgets keep Duplicate only; cut and paste are Notebook features.
- The widget actions menu grew three items, which exposed an older defect:
  in the narrow Chat-first Notebook panel the menu was clipped (the widget
  grid's `container-type` makes it the containing block, and the panel's
  scroll container cut the menu off). `ActionMenu` now renders the open menu
  in a portal on `<body>` at a fixed position computed from its button and
  clamped to the viewport (`placeActionMenu`), so it is never clipped. In
  the Notebook, Duplicate takes a plus-square glyph, since Copy now uses the
  copy glyph beside it.
- Tests: `apps/web/test/chat/composerTarget.test.tsx`, `chat.test.tsx`,
  `Composer.test.tsx`; E2E `tests/e2e/composerModeMenu.spec.ts` (new),
  `notebookAssistantGold.spec.ts`; the live spec
  `tests/real/notebook.live.spec.ts`. Cut/paste: unit tests for the
  clipboard and the paste model, E2E `tests/e2e/notebookClipboard.spec.ts`
  (new).
