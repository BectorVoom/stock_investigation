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
  `rounded-full` is additionally permitted for pill badges (currently unused).
  The chat surface (section 12) additionally uses `rounded-2xl` and
  `rounded-full` exactly as stated there. No other `rounded-*` step.
- Borders, not shadows: separation is a `border-slate-200/300` hairline
  (dashed for empty states and unstated-basis markers). No `shadow-*` and no
  `style=` attribute anywhere in UI source.

## 5. Layout

- Page frame: the `App` header (app name `h1`, view navigation, session
  summary, instrument disclaimer) then `PageHeader` (page title `h2` plus the
  purpose sentence from `PAGES`), then content at most `110rem` wide
  (`max-w-[110rem]`, `px-4`).
- The panel (`PANEL`: white, bordered, `p-3`) is the unit of a page; related
  controls live in one panel, unrelated ones in separate panels.
- One column by default; two columns from the large breakpoint: Chat uses
  `lg:grid-cols-[minmax(16rem,20rem)_1fr]` (history plus open conversation),
  the canvas component grid uses `xl:grid-cols-2` when the layout says two
  columns.
- Chat layout: conversation history navigation on the left, the open
  conversation (thread, question form, run status) on the right; the evidence
  drawer overlays from the right (`fixed inset-y-0 right-0`, `max-w-3xl`).
  Below the large breakpoint the page scrolls as a normal document, the
  history is a collapsed `Conversations (<n>)` disclosure (open when empty),
  and the composer stays `sticky` at the bottom over its own opaque
  `bg-slate-100` background.

## 6. Components

| Part | Use | Variants | Implemented by |
|---|---|---|---|
| Page header | Every page starts with it: title `h2` + purpose | — | `PageHeader` in `components/ui.tsx` |
| Panel section | A labelled `<section>` in a panel with its `h3` heading; optional header actions (reload, version line) | — | `Section` in `components/ui.tsx` |
| Headings | Page sections `h3`, nested headings `h4`/`h5` (section 7) | — | `HEADING` class in `components/ui.tsx` |
| Buttons | Default action; the one primary action per form; destructive actions | default / primary / danger | `BUTTON` / `BUTTON_PRIMARY` / `BUTTON_DANGER` in `components/ui.tsx`; one `BUTTON_PRIMARY` per form |
| Text input / select / textarea | With a `LABEL`, optional hint | — | `INPUT` / `LABEL` in `components/ui.tsx` |
| Field | Label + control + help text, owning the `for`/`id` link | with / without hint | `Field` in `components/ui.tsx` (used by `TextField`, `NumberField`, the conversation form) |
| Field help and problem lists | Hint under the control; blocking problems in a list the submit button points at via `aria-describedby` | — | `Field` hint; `ul[aria-label="Before you can …"]` |
| Notices | Announced status text (`<output>`, implicit `status` role) | info (slate) / warning (amber) / error (red) / success (emerald) | `Notice` in `components/ui.tsx`; API failures use `ErrorNotice` with the stable error code |
| Loading / empty / error states | The three states of any remote resource; empty collections; inline missing values | — | `Loading` / `RemoteView` / `Empty` / `ErrorNotice` in `components/ui.tsx`; `CannotRender` / `DataUnavailable` / `EmptyState` / `Unavailable` in `@research/ui-registry` |
| Status badges | Claim type and verification status; run state chips — always symbol plus word | type (slate) / supported (emerald) / unsupported (red) / conflicting (amber) | `ClaimTypeBadge` / `ClaimStatusBadge` in `@research/ui-registry`; run chips in `RunStatusPanel` reuse the same tones |
| Tables | Semantic tables with `<caption>`, scope attributes and right-aligned numerals; dataset tables double as every chart's data-table twin | — | `DatasetTable` in `@research/ui-registry` |
| Links | External links open in a new tab and state where they go | safe (https) / unavailable-with-note | `SafeLink` / `SourceCitation` / `SourceList` in `@research/ui-registry`; the only way a URL from data becomes an anchor |
| Dialogs / drawers | The evidence drawer; approval and creation forms | — | `RecordsDrawer` (modal `dialog`, labelled by its heading, `Close records` button, focus trapped while open and returned on close); `ApprovalForm`; dialog state stays local (UI-003). The drawer opens over a semi-transparent slate backdrop (`bg-slate-900/50`) that closes it on click, as does Escape. |
| Message thread | The centred conversation column on the Chat page | — | `Conversation` in `chat/Conversation.tsx` (`ol[aria-label="Messages"]`, `max-w-3xl`) |
| Owner bubble | Right-aligned owner message | — | `OwnerMessage` in `chat/Conversation.tsx` (`rounded-2xl`, `bg-blue-700`, `text-white`) |
| Assistant message | Left-aligned answer with claims, copy and evidence actions | — | `AssistantMessage` in `chat/Conversation.tsx` (no box; claims with numbered citation chips plus an `N sources` row; `Copy answer` / `Evidence`) |
| Run card | Inline agent activity after its question | always visible and compact, no disclosure | `RunCard` in `chat/RunCard.tsx` (state badge with `data-run-state`, latest progress line, `Stop`, `role="alert"` failure line, `Retry run`, `Evidence`, approval form) |
| Citation chip | Numbered evidence reference after a claim sentence | `button` named `Source N: title` (`rounded-full`, blue tones; inverse when its card is open) | `CitationChip` in `chat/Citations.tsx` (per-answer numbering in `chat/citationModel.ts`) |
| Source card | Hover/focus/click detail for one cited source | card floating below its claim (anchored to the claim, never wider than it; border, no shadow): number, title, publisher or host, published date when known, cited passage clamped to four lines, relation word when not support, `Open source` | `SourceCard` in `chat/Citations.tsx` (pinned on click, `Escape`/outside click closes, one open per answer) |
| Suggestion chips | Starter questions on an empty conversation | — | `SUGGESTIONS` in `chat/suggestions.ts`, rendered by `Conversation` (`rounded-2xl`) |
| Research composer | The one rounded question input pinned to the bottom | idle / sending | `Composer` in `chat/Composer.tsx` (`rounded-2xl` container, `rounded-full` send button) |
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
  and WebKit's is below 24 px without the minimum.

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
per section 12); secondary text lighter than slate-600;
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
one rounded input pinned to the bottom.

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
