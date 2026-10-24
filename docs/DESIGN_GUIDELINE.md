# Design guideline

Normative. Every UI change follows this document; the conformance test
(`tests/architecture/designGuideline.test.ts`) enforces the checkable part,
and `docs/ENGINEERING_DESIGN_RULES.md` rule UI-011 makes it a release gate.
What the test cannot check is listed in section 11 and remains a review item.

## 1. Principles

1. **Evidence before decoration.** Every number, claim and chart element shows
   its source, unit and as-of date, or states why it is unavailable; nothing
   is styled to look more certain than its evidence (DATA-001, UI-007).
   Consequence: no new visual treatment may hide provenance or basis markers.
2. **State is always stated.** Loading, empty, error and unavailable are
   designed states with explicit text, never a blank area (DATA-011).
   Consequence: every async view renders `Loading` / `Empty` / `ErrorNotice`
   (or the registry `CannotRender` / `DataUnavailable` / `EmptyState` /
   `Unavailable` parts) for each state it can be in.
3. **Status is never colour alone.** Every status colour is accompanied by a
   text label or an icon with text (e.g. the claim badges carry ✓/✕/≠ plus a
   word). Consequence: a colour-coded element without adjacent text fails review.
4. **Dense but legible.** One owner, one screen, research-grade information
   density; secondary information shrinks to `text-xs` / `text-2xs`, never
   below the caption size, and never lighter than slate-600. Consequence: no
   new type size and no lighter secondary text.
5. **The same thing looks the same everywhere.** Page sections, notices,
   fields, badges and tables come from the shared parts, not from hand-written
   class strings. Consequence: a repeated pattern earns a shared part instead
   of a third copy.
6. **Plain text for anything a model or a web page wrote.** Agent output,
   article excerpts and feed content render as text, never as markup
   (UI-005, SEC-001). Consequence: no new HTML rendering path for untrusted
   content.

## 2. Colour roles

| Role | Tailwind family | Used for |
|---|---|---|
| Neutral | slate | Body text, borders, panel surfaces, inactive states |
| Interactive / current selection / focus | blue | Links, primary buttons, selected conversation / row / component, focus ring |
| Error and destructive | red | Errors, failure codes, verification issues, destructive buttons |
| Warning, unverified, stale | amber | Offline/queued notices, unverified listings and notes, missing as-of dates, withheld series |
| Success, verified, supported | emerald | Saved confirmations, verified listings, supported claims, successful imports |
| Change direction | emerald / red / slate | A market change's text: rising `text-emerald-700`, falling `text-red-700`, unchanged `text-slate-700` (the Apple Stocks convention). One map, `CHANGE_TONES` in `components/ui.tsx`, used by every change line, change cell, the chart viewer's summary, statistics and crosshair readout. The ▲/▼/▬ mark and word (or the sign in table cells) stay: colour is never the only cue |
| Surface | white | Panel and card backgrounds (`bg-white`); app background is `bg-slate-100`, tinted notice backgrounds are the 50 step |
| Surface fills (Chat) | slate-100/200/300, blue-100, red-100/200 | Borderless Chat fills: grey run/result cards (`bg-slate-100`) and menus/dialog/composer on white; default buttons (`bg-slate-200`, `hover:bg-slate-300`) on white and on grey cards; blue source cards and citation chips (`bg-blue-100`, chip `hover:bg-blue-200`); destructive buttons (`bg-red-100`, `hover:bg-red-200`); approval form (grey `bg-slate-200`) on its grey run card |

No other family. In particular there is no gray/green/yellow/purple/orange;
white and black exist only as bare utilities (`bg-white`, `text-white`) for
surfaces and inverse text, never with a shade number.

Text contrast: body text is slate-900 on white or slate-50; secondary text is
never lighter than slate-600; coloured text on a tinted background uses the
800/900 step on the 50 step (e.g. `text-amber-900` on `bg-amber-50`).
Target: WCAG AA, 4.5:1 for text. Measured against the Tailwind v4 palette, the
allowed foreground/background pairs all pass with margin:

| Foreground on background | Ratio |
|---|---|
| slate-900 on white / slate-50 | 17.8 / 17.1 |
| slate-700 on white | 10.3 |
| slate-600 on white | 7.6 |
| white on blue-700 (primary button, active nav) | 6.8 |
| blue-800 on white (links) | 8.8 |
| blue-900 on blue-50, red-900 on red-50, amber-900 on amber-50, emerald-900 on emerald-50 | 9.5 / 9.2 / 8.8 / 9.2 |
| amber-950 on amber-50 | 14.5 |
| slate-900 on slate-200 (default buttons, suggestion chips) | 14.5 |
| slate-900 on blue-100 (source card body) | 14.6 |
| amber-950 on slate-200 (approval title on its grey form) | 12.2 |
| slate-700 on slate-100 (run card progress, result labels) | 9.5 |
| blue-900 on blue-100 (citation chips, source card titles) | 8.5 |
| red-900 on red-100 (destructive buttons) | 8.2 |
| blue-800 on blue-100 (source card link) | 7.1 |
| slate-600 on slate-100 (result type labels) | 6.9 |
| emerald-700 on white / slate-50 / slate-100 (rising change) | 5.4 / 5.1 / 4.9 |
| red-700 on white / slate-50 / slate-100 (falling change) | 6.4 / 6.1 / 5.9 |

For comparison, `text-slate-400` on white is 2.6:1 and `text-slate-300` is
1.5:1, which is why section 4 of the test forbids them. Any pair not in this
table needs its ratio checked before use.

## 3. Typography

| Utility | Size / line height | Used for |
|---|---|---|
| `text-lg` | 1.125rem | Page title (`PageHeader` `h2`) |
| `text-base` | 1rem | App name (`h1`), dialog/drawer titles, conversation title |
| `text-sm` | 0.875rem | Section headings (`h3`), body text, table text |
| `text-xs` | 0.75rem | Secondary text, labels, table captions, form help |
| `text-2xs` | 0.6875rem / 1rem | Captions: timestamps, provenance lines, badge text, field hints |

`text-2xs` is the ONE named caption size, defined in `apps/web/src/styles.css`
as `--text-2xs: 0.6875rem` with `--text-2xs--line-height: 1rem`. Arbitrary
sizes (`text-[…]`) are not allowed: every former `text-[11px]` is `text-2xs`.
Monospace (`font-mono`) is for identifiers, codes and tickers (run ids, error
codes, token display, `ownerId`, tickers) — never for prose. Tabular numerals
(`tabular-nums`) are for columns of numbers.

## 4. Spacing, radius, borders, elevation

- Inside a panel: `p-2` for cards and controls, `p-3` for panels, `p-4` only
  for the records drawer.
- Between panels and page blocks: `space-y-3` at page level, `space-y-2`
  inside a panel, `space-y-1` / `space-y-0.5` inside lists.
- Between a label and its control: adjacent (no gap); help text follows the
  control with `mt-0.5` / `mt-1`.
- Gaps in rows and toolbars: `gap-1` for badge groups and button rows,
  `gap-2` for form rows and headers.
- One corner radius: bare `rounded` on every box, button, input and badge;
  `rounded-full` is additionally permitted for the full-width "New chat" pill
  button, citation chips and round icon-only buttons (send, copy, activity
  dots, collapsed-rail actions, Home icon buttons). The chat surface (section 12) additionally
  uses `rounded-2xl` and `rounded-full` exactly as stated there. Widget
  frames on Home (section 13) use the package stylesheet's 1rem radius
  (`--wg-radius` in `packages/widget-grid/src/solid/styles.css`), never a
  Tailwind `rounded-*` class. No other `rounded-*` step.
- Background tone, not shadows or outlines, separates the Chat page's panels,
  cards, buttons, chips, menus and dialog from their surfaces (section 5):
  white panels on the grey page, light grey (`bg-slate-100`) run and
  result-preview cards on white, grey (`bg-slate-200`, `hover:bg-slate-300`) default buttons
  on white and on grey cards, blue (`bg-blue-700`) primary buttons, light red
  (`bg-red-100`, `hover:bg-red-200`) destructive buttons, blue-tinted
  (`bg-blue-100`, `hover:bg-blue-200`) citation chips and source cards,
  grey (`bg-slate-100`) menus, dialog and composer box. No `shadow-*` and no
  `style=` attribute anywhere in UI source. Everything else keeps its hairline:
  table cell rules, text inputs/selects/checkboxes, badges, the header's
  bottom rule, notices and dashed empty states stay bordered, and Sources and
  Settings keep every border they have. Home widget frames are a 1 px border
  in `--wg-border` (mapped to `slate-200` in `apps/web/src/styles.css`) with
  no shadow (section 13); table rules and provenance dividers stay `slate-200`
  hairlines with no shadow.

## 5. Layout

- Page frame: the `App` header (app name `h1`, view navigation, session
  summary) then `PageHeader` (page title `h2` plus the
  purpose sentence from `PAGES`; the Chat page shows the title only), then content at most `110rem` wide
  (`max-w-[110rem]`, `px-4`).
- The panel (`PANEL`: white, bordered, `p-3`) is the unit of a page; related
  controls live in one panel, unrelated ones in separate panels. On the Chat
  page the three panels use their own shared constant instead (`CHAT_PANEL`:
  white, `p-3`, no outline — plain white rounded blocks on the grey page
  background, including the collapsed rails and the welcome panel), each
  with a small header holding its title and a collapse/expand button
  (`PanelHeader` in `components/ui.tsx`).
- One column by default; three columns from the large breakpoint: Chat uses
  the Chats rail plus Chat and Notebook in one grid whose template follows
  the workspace state — Chat-first `lg:grid-cols-[minmax(14rem,18rem)_minmax(0,3fr)_minmax(0,1fr)]`
  (Chats, Chat, Notebook), Notebook-first the `1fr`/`3fr` pair reversed —
  with a short `grid-template-columns` transition disabled under
  `prefers-reduced-motion`; a collapsed panel shrinks its column to a
  narrow rail (`3rem`), and a collapsed panel mounts none of its heavy
  content. Switching states changes only the template: both panels stay
  mounted in the same DOM order.
- Chat layout: chats navigation on the left, the open conversation (thread
  with its result previews, question form, run status) and the Notebook side
  by side; the
  evidence drawer and the delete-chat confirmation overlay with focus trapped
  and returned on close. Below the large breakpoint the page scrolls as a
  normal document, the chats history is a collapsed `Chats (<n>)` disclosure
  (open when empty), a two-tab switch (`Chat` / `Notebook` with tab semantics,
  the two workspace states) shows one of the two at a time, and the composer stays `sticky` at the
  bottom over its own opaque background (`bg-slate-100` on the page,
  `bg-white` inside the centre panel).

## 6. Components

| Part | Use | Variants | Implemented by |
|---|---|---|---|
| Page header | Every page starts with it: title `h2` + purpose (Chat: title only) | — | `PageHeader` in `components/ui.tsx` |
| Panel section | A labelled `<section>` in a panel with its `h3` heading; optional header actions (reload, version line) | — | `Section` in `components/ui.tsx` |
| Headings | Page sections `h3`, nested headings `h4`/`h5` (section 7) | — | `HEADING` class in `components/ui.tsx` |
| Buttons | Default action; the one primary action per form; destructive actions | default (grey fill `bg-slate-200`, darker `hover:bg-slate-300`, no border) / primary (solid `bg-blue-700`, no border) / danger (light red fill `bg-red-100` with red text, stronger `hover:bg-red-200`, no border) | `BUTTON` / `BUTTON_PRIMARY` / `BUTTON_DANGER` in `components/ui.tsx`; one `BUTTON_PRIMARY` per form; every button keeps its `:focus-visible` ring and 24 px floor (`min-h-6`); disabled states read through fill and cursor, never a border |
| Icon button | The one icon-only button part on Home (toolbar, widget headers, dialog footers, Home `ErrorNotice` retries): round, borderless, 16 px inline glyph, no visible text | plain (transparent, `text-slate-700`, `hover:bg-slate-200`, pressed `active:bg-slate-300`) / primary (solid `bg-blue-700`, white glyph, `hover:bg-blue-800`) / danger (light red fill `bg-red-100` with red text, `hover:bg-red-200`) | `IconButton` in `components/ui.tsx` (glyph as inline `<svg aria-hidden="true">`, Bootstrap Icons paths, same pattern as `PanelCollapseButton`); the accessible name is the former visible text exactly, with the same words in the `title` tooltip; 28 px hit area (`min-h-7 min-w-7`), 44 px on coarse pointers (`pointer-coarse:`), at least 4 px between neighbours (`gap-1`); disabled reads through `opacity-50` and cursor, never a border |
| Text input / select / textarea | With a `LABEL`, optional hint | — | `INPUT` / `LABEL` in `components/ui.tsx` |
| Field | Label + control + help text, owning the `for`/`id` link | with / without hint | `Field` in `components/ui.tsx` (used by `TextField`, `NumberField`, the conversation form) |
| Field help and problem lists | Hint under the control; blocking problems in a list the submit button points at via `aria-describedby` | — | `Field` hint; `ul[aria-label="Before you can …"]` |
| Notices | Announced status text (`<output>`, implicit `status` role) | info (slate) / warning (amber) / error (red) / success (emerald) | `Notice` in `components/ui.tsx`; API failures use `ErrorNotice` with the stable error code |
| Loading / empty / error states | The three states of any remote resource; empty collections; inline missing values | — | `Loading` / `RemoteView` / `Empty` / `ErrorNotice` in `components/ui.tsx`; `CannotRender` / `DataUnavailable` / `EmptyState` / `Unavailable` in `@research/ui-registry` |
| Status badges | Claim type and verification status; run state chips — always symbol plus word | type (slate) / supported (emerald) / unsupported (red) / conflicting (amber) | `ClaimTypeBadge` / `ClaimStatusBadge` in `@research/ui-registry`; run chips in `RunStatusPanel` reuse the same tones |
| Tables | Semantic tables with `<caption>`, scope attributes and right-aligned numerals; dataset tables double as every chart's data-table twin | — | `DatasetTable` in `@research/ui-registry` |
| Links | External links open in a new tab and state where they go | safe (https) / unavailable-with-note | `SafeLink` / `SourceCitation` (records drawer) / `SourceList` (the shared `N sources` disclosure) in `@research/ui-registry`; the only way a URL from data becomes an anchor |
| Dialogs / drawers | The evidence drawer; approval and creation forms; the delete-chat confirmation | — | `RecordsDrawer` (modal `dialog`, labelled by its heading, `Close records` button, focus trapped while open and returned on close); `ApprovalForm`; `ConfirmDialog` in `components/ui.tsx` (native `dialog`, `bg-slate-100` fill with no outline, labelled by its heading, `Cancel` focused on open, Escape/Cancel closes and returns focus to the explicit opener, failures stay in the dialog via `ErrorNotice`); dialog state stays local (UI-003). The drawer opens over a semi-transparent slate backdrop (`bg-slate-900/50`) that closes it on click, as does Escape. |
| Panel header | The small header of each Chat page panel: `h3` title plus count and an icon-only collapse/expand button | expanded / collapsed rail | `PanelHeader` in `components/ui.tsx` (one shared `PanelCollapseButton` for all four buttons: side-panel glyph with no visible text, accessible collapse/expand name, `aria-expanded`, same words in the `title` tooltip, filled borderless button tone, visible focus ring, 24 px floor; the divider side mirrors for the left and right panels; collapsed panels render only the rail) |
| Chats panel | Past chats (title-only rows) and the full-width pill "New chat" button | panel / rail (icon-only new-chat action); disclosure below `lg` (compact button) | `ChatsPanel` in `chat/ChatsPanel.tsx` (borderless `CHAT_PANEL` surface; `nav[aria-label="Chats"]`, `Chats (<n>)` disclosure, `NewChatButton` pill/compact/icon variants, all borderless grey fills) |
| Notebook panel | The widgets of the open conversation with the notebook assistant one instruction away | dominant / secondary panel / rail; tab below `lg` | `NotebookPanel` in `notebook/NotebookPanel.tsx` inside a borderless `CHAT_PANEL` container (`div[data-panel="notebook"]`; not mounted when its rail shows). The host's header actions hold the workspace focus control and, while secondary, the collapse button. |
| Focus control | The manual Chat-first ↔ Notebook-first switch in both panels' headers | Chat-first / Notebook-first | `ModeSwitch` in `chat/ModeSwitch.tsx` (two icon-only buttons, "Focus Chat" / "Focus Notebook", accessible names with the same words in the `title` tooltip, `aria-pressed` on the active state) |
| Chat / Notebook tabs | The narrow-screen switch showing one state at a time | Chat / Notebook | `role="tablist"` with `role="tab"` (`aria-selected`, `aria-controls`) and `role="tabpanel"`; arrows move between tabs; the selected tab is the workspace state |
| Action menu | Row actions for one chat ("More actions for <title>") | closed / open | `ActionMenu` in `components/ui.tsx` (borderless filled kebab button; `bg-slate-100` menu surface with no outline, items darken to `bg-slate-200` on hover; button with `aria-haspopup="menu"` and `aria-expanded`; menu-button keyboard pattern: Enter/Space/ArrowDown opens, arrows/Home/End move, Escape closes and returns focus, click outside closes; `role="menu"` / `role="menuitem"`). The open menu renders in a portal on `<body>` at a fixed position computed from its button (`placeActionMenu`: below-end or above-start, flipping sides when it does not fit, clamped 8 px inside the viewport, following scrolls and resizes), so no overflow container — the Notebook's narrow scrolling panel — clips it; Tab returns focus to the button. Not for use inside a modal `<dialog>` |
| Rename input | The in-place chat title editor in the Chats list (the open conversation header has no Rename button; renaming lives in each row's "More actions" menu) | — | `RenameInput` in `chat/ChatsPanel.tsx` (text input holding the current title, `maxLength={300}`; Enter/blur saves, Escape cancels, empty/unchanged sends nothing; failures via `ErrorNotice` with the old title kept) |
| Message thread | The centred conversation column on the Chat page | — | `Conversation` in `chat/Conversation.tsx` (`ol[aria-label="Messages"]`, `max-w-3xl`) |
| Owner bubble | Right-aligned owner message | — | `OwnerMessage` in `chat/Conversation.tsx` (`rounded-2xl`, `bg-blue-700`, `text-white`) |
| Assistant message | Left-aligned answer with claims, copy and evidence actions | — | `AssistantMessage` in `chat/Conversation.tsx` (no box; claims with numbered citation chips plus an `N sources` row; `Copy answer` / `Evidence`) |
| Run card | Inline agent activity after its question | compact, no disclosure; hidden once the run is completed | `RunCard` in `chat/RunCard.tsx` (light grey `bg-slate-100` fill, no outline; `data-run-state`; a state badge for every state except completed and failed, latest progress line, `Stop`, `role="alert"` failure line, `Retry run`, approval form on a darker grey `bg-slate-200` fill with no outline; no `Evidence` button — the records drawer opens from the answer) |
| Citation chip | Numbered evidence reference after a claim sentence or a result finding | `button` named `Source N: title` (grey-blue fill `bg-blue-100`, darker `hover:bg-blue-200`, no border; solid `bg-blue-700` with white text when its card is open) | `CitationChip` in `@research/ui-registry` (`parts/citations.tsx`, per-scope numbering in `citationModel.ts`): one shared part used by chat answers and every result component |
| Source card | Hover/focus/click detail for one cited source | card floating below its anchor (anchored to the claim or finding, never wider than it; blue-tinted `bg-blue-100` fill that reads against both the white thread and the grey result cards, no border, no shadow): number, title, publisher or host, published, retrieved and data-as-of dates each labelled, cited passage clamped to four lines, relation word when not support, `Open source` | `SourceCard` in `@research/ui-registry` (`parts/citations.tsx`): one shared part used by chat and results — pinned on click, `Escape`/outside click closes, one open per answer or component; the passage is the claim link's quote in chat and the stored excerpt in a result, the relation word is chat-only |
| Suggestion chips | Starter questions on an empty conversation: above the composer below `lg`, centred below it at `lg` and up | — | `SUGGESTIONS` in `chat/suggestions.ts`, rendered by `Conversation` (`rounded-2xl`, grey `bg-slate-200` fill with no outline, darker `hover:bg-slate-300`) |
| Research composer | The one rounded question input: pinned to the bottom, except centred with the greeting and suggestions on an empty conversation at `lg` and up | idle / sending | `Composer` in `chat/Composer.tsx` (`rounded-2xl` grey `bg-slate-100` container with no outline, white textarea inside, `rounded-full` send button; focus ring stays via `focus-within:ring-2`). Its leading round + (`ActionMenu` with `iconTrigger` "Choose mode", `placement="above-start"`, `checked` radio items Research / Notebook, ADR-0023) picks the mode; a non-default mode shows as a removable chip beside it |
| Widget frame | One widget of any type (ADR-0024): title `h3` (visually hidden on every page: the frame's accessible name), one actions button, scrolling body, provenance footer for market widgets | small 1 × 1 / medium 2 × 2 / large full width × 2 (section 13) | `WidgetFrame` in `@research/widget-grid` (`packages/widget-grid/src/solid/WidgetFrame.tsx`, styled by `packages/widget-grid/src/solid/styles.css`): a native `article` labelled by its title (white surface, 1 px border in `--wg-border` mapped to `slate-200` in `apps/web/src/styles.css`, no shadow, 1rem radius, 1rem padding) holding a single header strip (leading grip glyph + title + one `IconButton`; the whole strip is the drag handle) and a scrollable body group (`tabindex="0"`, labelled by the title) that scrolls inside the frame. Both pages put the shared board's `ActionsMenu` (`createWidgetBoard` in `widgets/widgetBoard.tsx`) in the frame's actions slot and render the body through the shared `WidgetBody` (`widgets/WidgetBody.tsx`). Provenance is rendered by each widget at the end of its own output (`WidgetProvenance`), never as a frame prop: prop elements snapshot once while children stay live |
| Widget actions | Per-widget Edit… / Size: Small, Medium, Large / Cut / Copy / Paste after / Duplicate / Move earlier / Move later / the page's own items (Notebook: Ask AI, Go to source) / Remove — the same on Home and in the Notebook (ADR-0024, `createWidgetBoard` in `widgets/widgetBoard.tsx`) | enabled / disabled at the ends and at the current size, and all disabled while a save is in flight | Shared `ActionMenu` in `components/ui.tsx` with an icon-button trigger (icon-only `IconButton` named "`<title>` actions" with `aria-haspopup="menu"` / `aria-expanded` and `data-widget-actions`; `role="menu"` / `role="menuitem"` with the menu-button keyboard pattern — Enter/Space/ArrowDown opens, arrows skip disabled items, Home/End jump, Escape closes and returns focus, click outside closes; `Tab` closes); text items with leading icons — pencil, scissors (Cut), copy (Copy), clipboard (Paste after), plus-square (Duplicate), left/right arrows, trash (ADR-0023, ADR-0024). Remove acts at once on both pages, with no confirmation dialog (owner's instruction of 2026-10-15): like Cut, it is one save that Undo restores, announced in the polite live region ("Removed 1 widget. Undo restores it."). Home's Undo restores the bodies kept in this visit; the Notebook's the server-kept revisions. Only the notebook assistant's proposed removals ask first, in its chat turn card (ADR-0020). The Chats rows use the same part with its default filled trigger and text-only items |
| Widget dialog | Add / edit a live market widget (title, size, series, range, days ahead), the same on both pages; the type is chosen in the + menu first and named in the heading ("Add line chart widget"). Content widgets (Text, Metric, Chart, Table, Research result) edit in `ContentWidgetEditor` (`widgets/ContentWidgetEditor.tsx`, a native dialog). Home's reset confirmation is `ResetDialog` (`home/ResetDialog.tsx`) | add / edit / confirm-reset | `MarketWidgetDialog` in `widgets/MarketWidgetDialog.tsx` (`sl-dialog`, labelled by its heading, focus in on open and returned to the explicit opener on close; icon-only `IconButton` footer buttons whose names are the former labels; the heading still says in words what the buttons do; the Size control names Small / Medium / Large with the shapes — "1 × 1", "2 × 2", "full width × 2" — in its help text) |
| Widget controls | Selects, inputs and loading blocks on Home (buttons are the native `IconButton`, menus are native) | — | `sl-select` + `sl-option` / `sl-input` / `sl-skeleton` (cherry-picked modules only, Home chunk only); every control carries `size="small"` and is mapped in `styles.css` onto INPUT / LABEL (0.875rem control text, 0.75rem medium slate-700 labels); controls carry their own `label` prop instead of `Field` |
| Market tables | Price and indicator tables inside a widget card | — | Semantic `<table>` with `<caption>` and scope attributes in `home/widgets/` (Shoelace has no table component); one shared class set consistent with `DatasetTable` |
| Disclosure summary | The marker of every expandable `<summary>`: an explicit chevron (inline `<svg aria-hidden="true">`) pointing right when closed, down when open | closed / open | `DisclosureSummary` in `components/ui.tsx` (parent `<details>` carries `group`; chevron rotates with `group-open:rotate-90`, `motion-safe:` transition, `min-h-6`) |
| Earnings calendar widget | The Home widget over the watchlist's earnings dates: a glanceable month grid plus a short next list (section 14) | grid + next list / no announcement in range / empty watchlist | `EarningsMonthCalendar` in `home/widgets/EarningsMonthCalendar.tsx` (semantic `<table>` with `<caption>`, day numbers with a dot marker plus the count past one, today emphasised, announcement days as links to the Watchlist page) composed by `EarningsCalendarWidget` in `home/widgets/EarningsCalendarWidget.tsx` with the "Next" list (at most 3, date + symbol + name + fiscal period, no per-row links), one status line ("Connect it in Settings" while Google is not connected), "Refresh earnings dates" and the "Open Watchlist" link, one no-upcoming sentence linking to the Watchlist page, and one short provenance line; per-date calendar links live in the Watchlist table, the `.ics` download, feed and Google card in Settings → Calendar, never in the widget |
| Registered stocks table | The Watchlist page table: one row per registered stock with its next announcement | dated next announcement / undecided / unavailable / passed dates | `WatchlistView` in `watchlist/WatchlistView.tsx` (semantic `<table>` with `<caption>` and scopes: symbol `font-mono`, company name or "unavailable (not retrieved yet)", market, next date with fiscal period and timing, further dates in a disclosure, as-of date, source `SafeLink`, per-row "unavailable (reason)", `Remove` with `ConfirmDialog`; passed stored dates are stated as text with no date and no calendar links) |
| Add-a-stock form | The Watchlist's search over every US and Japanese listed stock (ADR-0033), the "Selected: …" line, an "Enter a symbol instead" disclosure (market select + symbol input, for adding before any list is downloaded), "Add stock", and one status line per stock list with its source and "Update stock list" | nothing picked / hit picked / symbol typed / problems listed; lists: downloaded / not downloaded yet / updating / failed (fixed sentence per code) | `WatchlistView` (`StockSearchBox`, a `<details>` with `DisclosureSummary` holding the shared `Select` + `INPUT`, `BUTTON_PRIMARY`; `ul[aria-label="Before you can add this stock"]` the submit points at via `aria-describedby`; picking only fills the form — the owner presses "Add stock"; editing the search text clears the pick and any hand-typed symbol; `output[data-field="selected-stock"]`; `output[data-field="add-target"]` beside the button ("To add: MSFT (US)", which the button's `aria-describedby` names) whenever a symbol is set; list lines in `[data-field="directory-status"]` with `SafeLink` sources and a `BUTTON` "Update stock list") |
| Search combobox | Type-to-find with a popup list of hits (the add-a-stock search) | closed / open with an active option / no match / searching / failed | `StockSearchBox` in `watchlist/StockSearchBox.tsx`: WAI-ARIA 1.2 combobox (`input[role="combobox"]`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`) with a leading magnifier glyph, over a `role="listbox"` popup on the white menu surface (1 px `slate-200` border, no shadow) whose `role="option"` rows (24 px floor) show the symbol (`font-mono`), the name in the UI language with the other language's name secondary, and market · listing; the active option and hover darken to `bg-slate-200`; a hit already registered says "Added" and carries `aria-disabled`. Focus never leaves the input: ↓/↑ open and move (wrapping), Enter picks the active option (with none it submits the form only while a hit is picked), Escape closes then clears, a click picks (`mousedown` keeps focus); keys an IME is composing with (`isComposing` or `keyCode` 229, like the composer) are left to the IME. While the next search runs the previous hits stay listed and the active option, remembered by its stock, stays active when the new answer still lists it. A polite `<output>` under the input states searching / N results / no match / only one market searched (the other list not downloaded yet) / no list yet / failure. Requests: 150 ms debounce, a newer keystroke aborts the one in flight, stale answers are dropped, and the same text after a failure is sent again (`createStockSearch`) |
| Calendar settings section | Settings → Calendar (ADR-0022): the Google Calendar card, the `.ics` download and the subscription link block over the Watchlist's dates | loading / load error with retry / loaded (download disabled with its reason on an empty watchlist) | `CalendarSettingsSection` in `settings/CalendarSettingsSection.tsx` (the shared `Section` titled "Calendar", an intro sentence linking to the Watchlist, `GoogleCalendarCard` from `settings/GoogleCalendarCard.tsx`, text buttons like the rest of Settings; `#/settings/calendar` scrolls to and focuses its heading) |
| Subscription link block | The secret-token calendar feed: create shown once, replace/revoke with confirmation | no link / shown once / existing link | `CalendarSettingsSection` (read-only field with Copy button and "will not be shown again" text on issue; created date with "Replace link" and "Revoke link" confirmations when a feed exists; the secrecy + localhost/HTTPS reachability note always visible) |

## 7. Heading structure

`h1` is the app name and lives only in `App.tsx`. `h2` is the page title and
lives only in `PageHeader` (`components/ui.tsx`). Page sections are `h3`
under the page's `h2`; nested headings step down without skipping (`h4`,
then `h5` for doubly-nested headings such as the source-preview sample list).
No skipped levels on any page.

Registry renderers (`packages/ui-registry/src/renderers/`, `charts/ChartFrame`,
`parts/`) are exempt from the page outline: a component is rendered inside an
`article` with no knowledge of its host page, so its title is `h3` and its
subsections are `h4` as component-scoped headings (e.g. `SourceList`'s
"Sources" `h4`). They were reviewed for this guideline and use no `h1`/`h2`;
the conformance test allowlists no renderer file because none needs one, and
any future `h2` in the registry must add a commented entry to the test's
allowlist.

## 8. Writing

- Sentence case everywhere, including headings and captions.
- Buttons are verbs naming the action ("Start conversation", "Submit question",
  "Refresh news now") — never "OK" or a bare noun.
- Errors say what happened and what to do ("The credential was not issued."
  plus the stable code and message; "Copy this token now. …").
- Numbers always carry a unit and an as-of date ("42 shares", "as of
  2026-01-15"); counts say what was counted ("3 messages", "Attempt 1 of 3").
- Unavailable is "unavailable (reason)" — "N/A — reason not stated" at worst —
  never a blank and never zero (DATA-011).
- No investment-advice wording: reports carry their disclaimer.

## 9. Accessibility

- Visible focus on every control (`:focus-visible` blue outline in
  `styles.css`); never remove it.
- Every input has a label (`Field` owns the `for`/`id` link); every group has
  a name (`aria-label` on sections, fieldsets with `legend`, tables with
  `<caption>`).
- Regions are labelled (`aria-label` on nav, notebook, conversation, drawer);
  the open conversation and focused component use `aria-current`.
- Status changes are announced: notices are `<output>` (implicit `status`
  role), load failures are `role="alert"`, retry buttons keep the name
  "Try again".
- Everything is keyboard reachable: native buttons, links, inputs, `summary`
  disclosure elements; no pointer-only hover content (chart readouts have a
  data-table twin).
- Never rely on colour: status always pairs colour with text or a symbol
  (principle 3).
- Target size: every button, `summary` and stand-alone link is at least
  24 px tall (`min-h-6`); links inside running text are exempt. Form controls
  meet the same floor through the shared `INPUT` class (`min-h-6`): engines
  render native controls (notably `<select>`) at different natural heights,
  and WebKit's is below 24 px without the minimum. On Home every icon-only
  button is at least 28 × 28 px (`min-h-7 min-w-7`) and 44 × 44 px on coarse
  pointers (`pointer-coarse:`), with at least 4 px between neighbours.

## 9a. Supported platforms

- Supported browsers: the current and the previous major version of Chrome
  (and Edge), Firefox and Safari on desktop. The technical floor is what the
  bundled Tailwind CSS v4 itself requires (Chrome 111, Firefox 128,
  Safari 16.4): the app cannot support less than its CSS framework does, and
  Vite's `build.target` is pinned to exactly that floor.
- Modern CSS with limited support is used only with a fallback or not at
  all: the composer grows through `field-sizing: content` where the engine
  implements it and through the script fallback in `chat/autogrow.ts` where
  it does not (checked with `CSS.supports("field-sizing", "content")`).
- Engine behaviour differences are fixed in the application code, never by
  special-casing a test: Safari does not move focus to a clicked button, so
  the records drawer is given its opener explicitly (the click event's
  `currentTarget`) instead of reading `document.activeElement`; clipboard
  failure always surfaces as the labelled "Copy failed" state, never as an
  unhandled rejection.
- The browser E2E suite (`bun run test:e2e`) runs once per engine —
  Playwright Chromium (Chrome channel), Firefox and WebKit — and the
  scripted UI review (`bun run review:ui`, `REVIEW_BROWSER=`) is read in all
  three before a UI change is called done. Playwright's WebKit build is the
  engine Safari uses, not Safari.app itself.

## 10. Charts

The palette in `packages/ui-registry/src/charts/chartMath.ts`
(`SERIES_COLORS`, `CHART_INK`) is the only chart palette; its values never
change without re-validating adjacent-pair separation. Series identity is
never colour alone: every chart ships a `ChartLegend` and a data-table twin.
Axis titles carry units, ticks are formatted with `formatAxisTick`, and every
chart states its units and as-of dates (UI-007) plus a basis note when any
plotted value is not a sourced measurement. Light theme only (known
limitation, stated in `chartMath.ts`); no inline `style=` (CSP
`style-src 'self'`) — SVG colours arrive via `fill`/`stroke` attributes bound
to the palette constants. A Notebook (and Home) `chart` widget draws through
the same shared plot as a Chat preview (`LinePlot` / `BarPlot` in
`@research/ui-registry`: same viewBox, plot area, ticks, axis titles, marks,
colours, legend and readout); its optional `xLabel` / `yLabel` are the axis
titles kept from the Chat component it was saved from, and its optional
`xKind` (`text` / `number` / `date`, absent is `text`) keeps date/number x
positioning for line charts. A chart component is saved as a `chart` widget
only when the conversion is lossless (otherwise a `research` widget, identical
by construction); candlestick charts always save as `research`. It renders
inside the registry's `ChartShell` with the heading hidden, and carries its
numbers' provenance (ADR-0026), so its basis note, data-table markers,
citations and Sources list read exactly as the Chat chart's.

## 11. How this is enforced

`tests/architecture/designGuideline.test.ts` scans every `.ts`/`.tsx` file
under `apps/web/src`, `packages/ui-registry/src` and `packages/widget-grid/src`
and fails with file, line
and offending token on: a non-guideline colour family; an arbitrary font size
or colour; a hex literal outside `chartMath.ts`; an inline `style=`; a radius
other than `rounded`/`rounded-full` (plus `rounded-2xl` in `apps/web/src/chat/`
per section 12); secondary text lighter than slate-600;
an `h1` outside `App.tsx` or an `h2` outside `components/ui.tsx`. The package
stylesheet (`packages/widget-grid/src/solid/styles.css`, `wg-` classes themed
by `--wg-*` custom properties mapped in `apps/web/src/styles.css`) carries the
grid look, and `packages/widget-grid/test/solid/stylesMetrics.test.ts` fails
when the stylesheet disagrees with `core/sizes.ts`. The test
carries its own self-test (synthetic strings violating each rule) so a
checker that can never fail cannot pass silently.

What the test cannot check remains a review item: that the same thing uses
the same part (no third copy), that every async state is designed, that
status is never colour alone, that numbers carry units and as-of dates, that
writing follows section 8, that focus stays visible and regions labelled, and
that new chart colours enter only through `chartMath.ts`.

## 12. Chat surface

The Chat page reproduces the look and interaction of CopilotKit's
`CopilotChat` without the library (this app is SolidJS): a centred message
column that fills the height of the page, right-aligned owner bubbles,
left-aligned assistant text, inline agent activity, starter suggestions and
one rounded input pinned to the bottom — except on an empty conversation at
`lg` and up, where the greeting, the input and the suggestions form one
vertically centred group in the middle of the panel.

- Message bubbles, the input container and suggestion chips use the large
  radius (`rounded-2xl`); icon-only buttons (send, copy) and activity dots are
  round (`rounded-full`); nothing else uses them.
- The thread column is `48rem` wide (`max-w-3xl`); owner bubbles take at most
  ~80% of it.
- Owner bubbles use the interactive colour with white text (`bg-blue-700`,
  `text-white`; 6.8:1, white on blue-700).
- Motion is limited to the activity indicator (three dots) and the sending
  spinner, both with a `motion-safe:` animation class so reduced-motion users
  get a static indicator.

## 13. Home surface

The Home page (`apps/web/src/home/`) is the one place a third-party UI kit
appears: `@shoelace-style/shoelace` (npm, bundled — no CDN) supplies the
widget dialogs, selects, inputs and skeletons. It is loaded lazily with the Home view so the other
pages do not pay for it, and only the used component modules are imported —
never the whole library. Widget frames, menus and buttons are native
elements in the app style (ADR-0017), not kit parts. If a Shoelace component cannot work under the
Content-Security-Policy, that component is replaced by a native element styled
the app's way; the policy itself is never relaxed (see ADR-0015).

- What Shoelace is used for: dialogs and form controls
  only (`sl-dialog`, `sl-select` + `sl-option`, `sl-input`, `sl-skeleton`;
  `sl-icon` serves their internal icons). Widget frames are the package's
  `WidgetFrame` (`packages/widget-grid/src/solid/WidgetFrame.tsx`, styled by
  `packages/widget-grid/src/solid/styles.css`): native `article` elements
  (white surface on the grey page, 1 px border in `--wg-border` mapped to
  `slate-200` in `apps/web/src/styles.css`, no shadow, no header divider,
  1rem radius, 1rem padding); per-widget
  actions are a native menu behind one icon-only `IconButton`; every other
  button on Home is the same shared `IconButton` part. Tables stay semantic
  `<table>` elements in the frame body because
  Shoelace has no table component; charts stay the registry SVG primitives
  (`ChartFrame`, `ChartLegend`, palette, scales, ticks) with a native
  data-table twin.
- Token mapping (`apps/web/src/styles.css`, `html:root` so it wins over the
  lazily loaded Shoelace stylesheet): primary → the blue scale, neutral →
  slate, success → emerald, warning → amber (already), danger → red (already);
  every `--sl-border-radius-*` is `0.25rem` (bare `rounded`); every
  `--sl-shadow-*` is `none` (borders, not shadows); the app font; the
  `--sl-focus-ring-*` matches the `:focus-visible` rule. Every value
  references the app's own theme variables — no invented hex.
- Icons: the `system` and `default` libraries are registered to same-origin
  SVG files shipped in the web build (`apps/web/public/icons/`, MIT —
  Bootstrap Icons via Shoelace), because the built-in `data:` resolver is
  `fetch()`ed and `connect-src 'self'` blocks it. Every icon in the system
  library is shipped (all 18: `caret`, `check`, `chevron-down`,
  `chevron-left`, `chevron-right`, `copy`, `eye`, `eye-slash`, `eyedropper`,
  `grip-vertical`, `indeterminate`, `person-fill`, `play-fill`, `pause-fill`,
  `radio`, `star-fill`, `x-lg`, `x-circle-fill`), so every icon a used
  component can request resolves — `chevron-down`
  (sl-select), `x-lg` (sl-dialog close). An E2E test opens the dialog, a
  select and a widget menu and asserts every `/icons/*.svg` request answers
  200 as SVG and no `sl-icon` is left without an `<svg>`. The app's own
  icon-only buttons do not use `sl-icon`: their glyphs are inline SVGs
  (Bootstrap Icons paths) in the shared `IconButton` part.
- Widget grid (`@research/widget-grid`): equal cells with a fixed row height —
  2 columns, 4 from `min-width: 64rem`, `17rem` rows and a `1rem` gap (the HIG
  standard margin), in normal row flow so visual order equals DOM order. Three
  fixed sizes from one table (`WIDGET_SIZE_SPANS` in `core/sizes.ts`, stated
  again in the package stylesheet `src/solid/styles.css` and tied by
  `test/solid/stylesMetrics.test.ts`): Small 1 × 1 (17rem tall, 272 px),
  Medium 2 × 2 (35rem, 560 px), Large full width × 2 at the wide breakpoint
  (4 columns) and 2 × 2 below it (35rem, 560 px). The stylesheet (`wg-`
  classes, themed by `--wg-*` custom properties mapped to the app theme in
  `apps/web/src/styles.css`) carries the grid, the frame, the header strip,
  the body and the placeholder; `HomeView` uses its grid class for the
  loading skeletons too.
  Every widget of a size has exactly the same width and height as every
  other of that size on the same screen. The frame fills its cell (`h-full`)
  and never grows with content: the header strip stays fixed while the body
  below it scrolls inside the frame (`overflow-y-auto`, keyboard-focusable
  and labelled by the widget title); tables keep their own horizontal
  scroll. Loading skeletons use the same grid and cell height so the page
  does not jump. No page-level
  horizontal overflow at 390 px; tables scroll inside their card.
- Untitled frames (`WidgetFrame titleHidden`, ADR-0021): no widget shows a
  title — Home, the Notebook and the chat's result previews alike (owner's
  instruction of 2026-10-15, ADR-0024). The title stays the frame's
  accessible name (visually hidden) and the body starts at the top of the
  frame; a body says what it shows on its own (a market metric names its
  series above the value, charts carry a legend, tables a caption and row
  headers). The
  controls gather in a compact cluster straddling the frame's top edge at the
  right, like the badge of an iOS widget in edit mode — the grip (28 px hit
  target; a click that is not a drag selects) and the actions button, on the
  frame surface with a hairline border — over the border and padding, never
  over content (the scroller keeps 0.75rem of top padding so the first row's
  cluster is not clipped); revealed on hover, focus and
  selection like the quiet header (opacity only, never on reduced motion,
  always shown without hover). The select toggle stays in the tab order but
  shows only on keyboard focus or when selected. While a Text widget is
  edited the cluster steps aside entirely, as Notion hides block handles
  while typing.
- Drag and drop (HIG Drag and drop, `@research/widget-grid`): the header is the handle — in an
  untitled frame (every frame today) the grip in the top-right cluster
  (grip glyph in the muted text colour as the visible affordance;
  a press on the actions button never starts a drag). Pointer Events only
  (never the HTML5 API), primary button / one touch / pen, starting after
  4 px of movement so a press-and-release is a plain click. The lifted widget
  follows the pointer with its grab offset at about 90 % opacity above its
  neighbours with the accent-colour 2 px ring (no shadow) and never changes
  size; the target slot shows a same-size dashed placeholder with
  no fill while the others reflow in their real grid positions. Reflow is
  order-based (the widget ends at an index, the rest keep their order —
  never free placement with gaps) with midpoint-plus-ban hysteresis so a
  resting pointer never flip-flops. The drop saves exactly one `reorder`
  edit; an unchanged position saves nothing and the preview stays on screen
  while the save is in flight. `Escape`, `pointercancel` or the window losing
  focus cancels with nothing saved. No drag starts while a save is in flight,
  while loading, or with one widget; while a drag is active and the pointer
  rests within 80 px of the top or bottom edge of the viewport and the page
  can still scroll that way, the page keeps scrolling every frame (faster the
  deeper into the zone the pointer is, at most about 16 px per frame),
  re-evaluating the drop target as content passes under the pointer, until
  the pointer leaves the zone, the page reaches its end, or the drag ends or
  is cancelled. Slot rectangles are cached in page coordinates so scrolling
  never stales the decision. The pointer/DOM engine lives in the package
  (`packages/widget-grid/src/solid/widgetDrag.ts`, `createWidgetDrag`, returning the grid pointerdown
  handler plus dispose); `WidgetGrid` keeps only the wiring. The menu's Move earlier/later is the
  keyboard and assistive-technology path, and one visually hidden polite live
  region announces every completed move (`Moved “<title>” to position <i> of
  <n>.`, clearing first so a repeated sentence announces again).
- States follow principle 2 (`sl-skeleton` blocks plus "Loading" text,
  "unavailable (reason)", `ErrorNotice` with "Try again"); status is never
  colour alone (change marks carry ▲/▼/▬ plus a word); every number shows its
  unit, as-of date and source. The widget dialog's problem list is a neutral
  slate notice ("To add this widget:" / "To save this widget:") while the
  form is pristine and turns red ("Fix before saving:") once any field has
  changed.
- Lazy cost, measured: the Home route (`HomeView-*.js` 13.15 kB, 4.70 kB
  gzip in the 2026-10-17 production build) downloads on the first visit to
  `#/home` only. The chart viewer is its own lazy chunk (`ChartViewer-*.js`
  36.04 kB, 11.61 kB gzip), downloaded on the first press of an "Open chart"
  button (its entry points render on every page through the shared
  `WidgetBody`, the viewer only while open); the main chunk (`index-*.js`) is
  554.12 kB, 157.66 kB gzip, down from 577.54 kB / 163.88 kB gzip with the
  viewer statically imported. Splitting it changed nothing about zod: in both
  builds zod lives in a shared chunk (`serializer-*.js` before the split,
  `src-*.js` after) that `index-*.js` imports, so ES module order evaluates it
  before `zodJitless.ts` runs — a pre-existing ordering, not one the split
  introduced (see the next item). Re-measure if the kit version or the
  imported set changes (see ADR-0015 and ADR-0025).
- Zod runs `jitless` in the SPA (`apps/web/src/zodJitless.ts`, imported
  first in `main.tsx`): zod's `new Function` probe is reported as a
  Content-Security-Policy violation by strict engines, and the SPA's small
  payloads never need JIT parsing — at the cost of slower schema parsing in
  the browser. The Worker and Node paths keep their own configuration.
  Known gap (open): the production build puts zod in a shared chunk that the
  entry chunk imports, and an imported chunk evaluates before the importing
  module's own body, so schemas created at module level in that chunk exist
  before `config({ jitless: true })` runs; "imported first" holds for the
  source order, not for the bundled evaluation order.

## 14. Widgets (Apple Human Interface Guidelines)

Widget design guideline (owner's rule of 2026-10-13): the Apple Human
Interface Guidelines for widgets on iOS and macOS. In the HIG's terms a widget
is glanceable and uncluttered; it offers simple, relevant functionality and
reserves complexity for the app; a tap opens the app at the right location (a
deep link); widget layouts stay clear of app-like density; margins stay
standard; targets stay large enough to hit with confidence (44 × 44 pt on
touch); corner radii stay concentric with the container; the system font keeps
a clear hierarchy. Applied to this app's Home:

- "The app" for the earnings dates is the Watchlist page (each stock's row
  with its dates and per-date calendar links) plus Settings → Calendar (the
  `.ics` download, the subscription feed, the Google Calendar card). There is
  no full-page month calendar (ADR-0022): the widget's grid is the calendar.
- The Home `earnings-calendar` widget is glanceable: the month grid (day
  numbers, a dot marker plus the count past one, today emphasised, month
  navigation as two icon buttons), a "Next" list of at most 3 upcoming
  announcements, one status line, and at most two actions (the "Refresh
  earnings dates" icon button, the "Open Watchlist" link). Its buttons are
  the shared icon-only `IconButton` like every Home button (section 13). An
  announcement day is a link to `#/watchlist` — the tap opens the app where
  the dates and their calendar links are — never an in-widget details panel.
- Not in the widget: per-row calendar links (Watchlist table), the `.ics`
  button (Settings → Calendar), the five-column list table, the per-reason
  disclosure (one sentence remains, linking to the Watchlist page), the long
  provenance block (one short line remains).
- Sizing: every interactive target in the widget is at least 44 × 44 CSS px
  under `@media (pointer: coarse)` and at least 24 × 24 otherwise (the shared
  24 px floor of section 9); consistent inner padding with the other Home
  widgets; no nested cards; type stays within the widget's existing sizes.
- All existing widget states stay expressible (loading, load error with retry,
  empty watchlist, not-fetched-yet, fetching).

The other Home widgets (metric, line-chart, stock-table, indicator-table)
follow the same guideline through the Home rework of section 13 (ADR-0017:
fixed sizes, hairlines, icon-only buttons, drag to reposition); their content
— tables, controls and provenance — is as sections 6 and 13 state it.

### Chart viewer (ADR-0025)

"The app" a price widget's tap opens: the line-chart plot, a metric's value
block (value, change lines, sparkline) and each stock-table name cell are
native buttons named by a hidden "Open chart: " plus their visible content
(keyboard reachable, no button chrome — they look like the plot, the values,
the name; WCAG 2.5.3 Label in Name) over the current page, Home or the
Notebook alike; a mouse press that moves 4 px or more (selecting text) never
opens, while a touch or pen tap that drifts a few px does (the slop rule is
mouse-only; a pen that drag-selects text may still open); each opener is at
least 24 × 24 px and 44 × 44 px under a coarse pointer. While its lazy chunk
downloads "Loading chart…" shows at a fixed place at the top of the
viewport (where the sheet will appear, never below a tall widget's content);
a failed download shows there as an alert with Try again (focused) and
Close, and pressing the opener again also retries. At most one viewer
exists: a second open supersedes the first. The viewer is the large modal sheet where the series can
be analysed: range presets plus exact From/To dates, interval / scale /
values controls, moving averages for one series, the main chart with
crosshair and readout, an overview navigator, visible-window statistics and a
data-table twin with provenance. Escape and its close button close it with
focus returned to the opener; a press that turns into a widget drag never
opens it. Nothing it does is saved.
