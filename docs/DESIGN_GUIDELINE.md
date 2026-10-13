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
| Surface | white | Panel and card backgrounds (`bg-white`); app background is `bg-slate-100`, tinted notice backgrounds are the 50 step |
| Surface fills (Chat) | slate-100/200/300, blue-100, red-100/200 | Borderless Chat fills: grey run/canvas cards (`bg-slate-100`) and menus/dialog/composer on white; default buttons (`bg-slate-200`, `hover:bg-slate-300`) on white and on grey cards; blue source cards and citation chips (`bg-blue-100`, chip `hover:bg-blue-200`); destructive buttons (`bg-red-100`, `hover:bg-red-200`); approval form (grey `bg-slate-200`) on its grey run card |

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
| slate-700 on slate-100 (run card progress, canvas labels) | 9.5 |
| blue-900 on blue-100 (citation chips, source card titles) | 8.5 |
| red-900 on red-100 (destructive buttons) | 8.2 |
| blue-800 on blue-100 (source card link) | 7.1 |
| slate-600 on slate-100 (canvas type labels) | 6.9 |

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
  uses `rounded-2xl` and `rounded-full` exactly as stated there, and widget
  frames on Home (section 13) use `rounded-2xl` exactly as stated there. No other
  `rounded-*` step.
- Background tone, not shadows or outlines, separates the Chat page's panels,
  cards, buttons, chips, menus and dialog from their surfaces (section 5):
  white panels on the grey page, light grey (`bg-slate-100`) run and canvas
  cards on white, grey (`bg-slate-200`, `hover:bg-slate-300`) default buttons
  on white and on grey cards, blue (`bg-blue-700`) primary buttons, light red
  (`bg-red-100`, `hover:bg-red-200`) destructive buttons, blue-tinted
  (`bg-blue-100`, `hover:bg-blue-200`) citation chips and source cards,
  grey (`bg-slate-100`) menus, dialog and composer box. No `shadow-*` and no
  `style=` attribute anywhere in UI source. Everything else keeps its hairline:
  table cell rules, text inputs/selects/checkboxes, badges, the header's
  bottom rule, notices and dashed empty states stay bordered, and Sources and
  Settings keep every border they have. Home widget frames, table rules and
  provenance dividers are `slate-200` hairlines with no shadow (section 13).

## 5. Layout

- Page frame: the `App` header (app name `h1`, view navigation, session
  summary, instrument disclaimer) then `PageHeader` (page title `h2` plus the
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
  `lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(18rem,26rem)]`
  (Chats, Chat, Canvas); a collapsed side panel shrinks its column to a
  narrow rail (`3rem`), and a collapsed panel mounts none of its heavy
  content. The canvas component grid is always one column (`grid-cols-1`);
  the stored `layout.columns` value is preserved but never switches it.
- Chat layout: chats navigation on the left, the open conversation (thread,
  question form, run status) in the centre, the canvas on the right; the
  evidence drawer and the delete-chat confirmation overlay with focus trapped
  and returned on close. Below the large breakpoint the page scrolls as a
  normal document, the chats history is a collapsed `Chats (<n>)` disclosure
  (open when empty), a two-tab switch (`Chat` / `Canvas` with tab semantics)
  shows one of the two at a time, and the composer stays `sticky` at the
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
| Canvas panel | The stored tables, charts and reports of the open conversation, always in one column; each component is a borderless grey card holding only its rendered content | panel / rail; tab below `lg` | `Canvas` in `canvas/Canvas.tsx` inside a borderless `CHAT_PANEL` section (`section[aria-label="Canvas"]`, title only in the header — no component count, short empty state; not mounted when collapsed). Each component card is a light grey (`bg-slate-100`) fill with no outline and no toolbar (no id, type label, move, focus or remove controls: the agent arranges the canvas); a component the agent focused keeps its ring (an outline, so a shape as well as a colour) plus `aria-current`/`data-focused`, with no text label. |
| Chat / Canvas tabs | The narrow-screen switch showing one of the two at a time | Chat / Canvas | `role="tablist"` with `role="tab"` (`aria-selected`, `aria-controls`) and `role="tabpanel"`; arrows move between tabs |
| Action menu | Row actions for one chat ("More actions for <title>") | closed / open | `ActionMenu` in `components/ui.tsx` (borderless filled kebab button; `bg-slate-100` menu surface with no outline, items darken to `bg-slate-200` on hover; button with `aria-haspopup="menu"` and `aria-expanded`; menu-button keyboard pattern: Enter/Space/ArrowDown opens, arrows/Home/End move, Escape closes and returns focus, click outside closes; `role="menu"` / `role="menuitem"`) |
| Rename input | The in-place chat title editor in the Chats list (the open conversation header has no Rename button; renaming lives in each row's "More actions" menu) | — | `RenameInput` in `chat/ChatsPanel.tsx` (text input holding the current title, `maxLength={300}`; Enter/blur saves, Escape cancels, empty/unchanged sends nothing; failures via `ErrorNotice` with the old title kept) |
| Message thread | The centred conversation column on the Chat page | — | `Conversation` in `chat/Conversation.tsx` (`ol[aria-label="Messages"]`, `max-w-3xl`) |
| Owner bubble | Right-aligned owner message | — | `OwnerMessage` in `chat/Conversation.tsx` (`rounded-2xl`, `bg-blue-700`, `text-white`) |
| Assistant message | Left-aligned answer with claims, copy and evidence actions | — | `AssistantMessage` in `chat/Conversation.tsx` (no box; claims with numbered citation chips plus an `N sources` row; `Copy answer` / `Evidence`) |
| Run card | Inline agent activity after its question | compact, no disclosure; hidden once the run is completed | `RunCard` in `chat/RunCard.tsx` (light grey `bg-slate-100` fill, no outline; `data-run-state`; a state badge for every state except completed and failed, latest progress line, `Stop`, `role="alert"` failure line, `Retry run`, approval form on a darker grey `bg-slate-200` fill with no outline; no `Evidence` button — the records drawer opens from the answer) |
| Citation chip | Numbered evidence reference after a claim sentence or a canvas finding | `button` named `Source N: title` (grey-blue fill `bg-blue-100`, darker `hover:bg-blue-200`, no border; solid `bg-blue-700` with white text when its card is open) | `CitationChip` in `@research/ui-registry` (`parts/citations.tsx`, per-scope numbering in `citationModel.ts`): one shared part used by chat answers and every canvas component |
| Source card | Hover/focus/click detail for one cited source | card floating below its anchor (anchored to the claim or finding, never wider than it; blue-tinted `bg-blue-100` fill that reads against both the white thread and the grey canvas cards, no border, no shadow): number, title, publisher or host, published, retrieved and data-as-of dates each labelled, cited passage clamped to four lines, relation word when not support, `Open source` | `SourceCard` in `@research/ui-registry` (`parts/citations.tsx`): one shared part used by chat and canvas — pinned on click, `Escape`/outside click closes, one open per answer or component; the passage is the claim link's quote in chat and the stored excerpt on canvas, the relation word is chat-only |
| Suggestion chips | Starter questions on an empty conversation: above the composer below `lg`, centred below it at `lg` and up | — | `SUGGESTIONS` in `chat/suggestions.ts`, rendered by `Conversation` (`rounded-2xl`, grey `bg-slate-200` fill with no outline, darker `hover:bg-slate-300`) |
| Research composer | The one rounded question input: pinned to the bottom, except centred with the greeting and suggestions on an empty conversation at `lg` and up | idle / sending | `Composer` in `chat/Composer.tsx` (`rounded-2xl` grey `bg-slate-100` container with no outline, white textarea inside, `rounded-full` send button; focus ring stays via `focus-within:ring-2`) |
| Widget frame | One market widget: title `h3`, one actions button, scrolling body, provenance footer | small 1 × 1 / medium 2 × 2 / large full width × 2 (section 13) | `WidgetFrame` in `home/WidgetFrame.tsx`: a native `article` labelled by its title (white, `slate-200` hairline, no shadow, `rounded-2xl`, `p-4`) holding a single header strip (title + one `IconButton`) and a scrollable body group (`tabindex="0"`, labelled by the title) that scrolls inside the frame. Provenance is rendered by each widget at the end of its own output (`WidgetProvenance`), never as a frame prop: prop elements snapshot once while children stay live |
| Widget actions | Per-widget Edit / Move earlier / Move later / Remove | enabled / disabled at the ends, and all disabled while a save is in flight | Native menu in `WidgetFrame` (icon-only `IconButton` trigger named "`<title>` actions" with `aria-haspopup="menu"` / `aria-expanded`; `role="menu"` / `role="menuitem"` with the same values and behaviour as before; text items with leading icons — pencil, left/right arrows, trash) |
| Widget dialog | Add / edit a widget (type, title, size, series, range); reset confirmation | add / edit / confirm-reset | `WidgetDialog` in `home/WidgetDialog.tsx` (`sl-dialog`, labelled by its heading, focus in on open and returned to the explicit opener on close; icon-only `IconButton` footer buttons whose names are the former labels; the heading still says in words what the buttons do; the Size control names Small / Medium / Large with the shapes — "1 × 1", "2 × 2", "full width × 2" — in its help text) |
| Widget controls | Selects, inputs and loading blocks on Home (buttons are the native `IconButton`, menus are native) | — | `sl-select` + `sl-option` / `sl-input` / `sl-skeleton` (cherry-picked modules only, Home chunk only); every control carries `size="small"` and is mapped in `styles.css` onto INPUT / LABEL (0.875rem control text, 0.75rem medium slate-700 labels); controls carry their own `label` prop instead of `Field` |
| Market tables | Price and indicator tables inside a widget card | — | Semantic `<table>` with `<caption>` and scope attributes in `home/widgets/` (Shoelace has no table component); one shared class set consistent with `DatasetTable` |
| Disclosure summary | The marker of every expandable `<summary>`: an explicit chevron (inline `<svg aria-hidden="true">`) pointing right when closed, down when open | closed / open | `DisclosureSummary` in `components/ui.tsx` (parent `<details>` carries `group`; chevron rotates with `group-open:rotate-90`, `motion-safe:` transition, `min-h-6`) |

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
- No investment-advice wording: the header states the instrument "does not
  place trades and is not investment advice", and reports carry their
  disclaimer.

## 9. Accessibility

- Visible focus on every control (`:focus-visible` blue outline in
  `styles.css`); never remove it.
- Every input has a label (`Field` owns the `for`/`id` link); every group has
  a name (`aria-label` on sections, fieldsets with `legend`, tables with
  `<caption>`).
- Regions are labelled (`aria-label` on nav, canvas, conversation, drawer);
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
to the palette constants.

## 11. How this is enforced

`tests/architecture/designGuideline.test.ts` scans every `.ts`/`.tsx` file
under `apps/web/src` and `packages/ui-registry/src` and fails with file, line
and offending token on: a non-guideline colour family; an arbitrary font size
or colour; a hex literal outside `chartMath.ts`; an inline `style=`; a radius
other than `rounded`/`rounded-full` (plus `rounded-2xl` in `apps/web/src/chat/`
per section 12 and for widget frames in `apps/web/src/home/` per section 13); secondary text lighter than slate-600;
an `h1` outside `App.tsx` or an `h2` outside `components/ui.tsx`. The test
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
elements in the app style (ADR-0016), not kit parts. If a Shoelace component cannot work under the
Content-Security-Policy, that component is replaced by a native element styled
the app's way; the policy itself is never relaxed (see ADR-0015).

- What Shoelace is used for: dialogs and form controls
  only (`sl-dialog`, `sl-select` + `sl-option`, `sl-input`, `sl-skeleton`;
  `sl-icon` serves their internal icons). Widget frames are native `article`
  elements (white surface on the grey page, 1 px `slate-200` hairline, no
  shadow, no header divider, `rounded-2xl`, inner padding `p-4`); per-widget
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
- Widget grid: equal cells with a fixed row height —
  `grid-cols-2 lg:grid-cols-4` with `auto-rows-[15rem]` and a 16 px gap
  (the HIG standard margin), in normal row flow so visual order equals DOM
  order. Three fixed sizes from one table (`HOME_SIZE_SPAN` in
  `homeModel.ts`): Small 1 × 1 (15rem tall), Medium 2 × 2 (31rem),
  Large full width × 2 at `lg` (4 columns) and 2 × 2 below it (31rem).
  Every widget of a size has exactly the same width and height as every
  other of that size on the same screen. The frame fills its cell (`h-full`)
  and never grows with content: the header strip stays fixed while the body
  below it scrolls inside the frame (`overflow-y-auto`, keyboard-focusable
  and labelled by the widget title); tables keep their own horizontal
  scroll. Loading skeletons use the same grid and cell height so the page
  does not jump. No page-level
  horizontal overflow at 390 px; tables scroll inside their card.
- States follow principle 2 (`sl-skeleton` blocks plus "Loading" text,
  "unavailable (reason)", `ErrorNotice` with "Try again"); status is never
  colour alone (change marks carry ▲/▼/▬ plus a word); every number shows its
  unit, as-of date and source. The widget dialog's problem list is a neutral
  slate notice ("To add this widget:" / "To save this widget:") while the
  form is pristine and turns red ("Fix before saving:") once any field has
  changed.
- Lazy cost, measured: the Home chunk (`HomeView-*.js` 187.75 kB, 52.17 kB
  gzip, plus `HomeView-*.css` 14.96 kB in the 2026-10-13 production build)
  downloads on the first visit to `#/home` only; re-measure if the kit
  version or the imported set changes (see ADR-0015).
- Zod runs `jitless` in the SPA (`apps/web/src/zodJitless.ts`, imported
  first in `main.tsx`): zod's `new Function` probe is reported as a
  Content-Security-Policy violation by strict engines, and the SPA's small
  payloads never need JIT parsing — at the cost of slower schema parsing in
  the browser. The Worker and Node paths keep their own configuration.
