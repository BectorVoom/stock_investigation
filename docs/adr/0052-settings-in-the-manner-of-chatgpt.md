# ADR-0052: Settings shows one category at a time, in the manner of ChatGPT's settings

**Status:** Accepted · **Date:** 2026-11-01 · **Owner request:** "Redesign the
settings page with an interface inspired by chatgpt."

## Context

Settings (`#/settings`) was one long column of five bordered panels — AI
agent, Calendar, Language, Runner credentials, Export and import — each
laid out its own way: labels above controls, a table for credentials, a
checkbox for web access. The AI agent panel alone filled more than a
screen, so the other four were found by scrolling, and `#/settings/agent`
and `#/settings/calendar` had to scroll the page to the right panel.

ChatGPT's settings are a list of categories with icons on the left and one
category on the right, each setting a row — its name and a short
explanation on the left, its control on the right — separated by thin
rules, with switches for on/off choices.

## Decision

### 1. Categories and panes

- Settings is one bordered white card, at most `56rem` wide: the category
  list on the left (`14rem`), one category's pane on the right.
- The categories, in order: **AI agent**, **Calendar**, **Language**,
  **Runner credentials**, **Export and import** — the old panel titles,
  each with a 16 px Bootstrap icon (cpu, calendar, globe, key, database).
- The list is a WAI-ARIA tab list with automatic activation: one tab stop
  (the shown category), ↑ / ↓ and ← / → move to the previous / next
  category and wrap, Home / End jump, and the category focus lands on is
  shown. The shown category has a grey fill (`bg-slate-200`), as ChatGPT's
  does; hover is `bg-slate-100`.
- Below the `md` breakpoint the list is one row above the pane that
  scrolls sideways inside itself; the page never scrolls sideways.
- Each pane is a tab panel holding a labelled region named like the old
  panel (so `getByRole("region", { name: "AI agent" })` still finds it),
  with the category title (`h3`, `text-base`), an optional intro line, a
  hairline, then its rows.

### 2. Every category has its own address

- `#/settings/agent`, `#/settings/calendar`, `#/settings/language`,
  `#/settings/runner` and `#/settings/data`. `#/settings` and any unknown
  category show the AI agent, which most links to Settings are about (the
  owner link in the header, Chat's "Open Settings → AI agent").
- Choosing a category replaces the history entry (as the Stocks page's
  tabs do, ADR-0049 §1): Back leaves Settings instead of walking its
  categories.
- A **link** to `#/settings/agent` still moves focus to the Default
  backend select, and one to `#/settings/calendar` to the Calendar
  heading (ADR-0022). Choosing the same category in the list does not:
  focus stays on the tab, so walking the list with the arrow keys never
  jumps into a form.

### 3. Panes stay mounted once shown

A pane is mounted the first time its category is shown and kept, hidden,
while the page is open. An unsaved AI agent draft survives a look at
another category, and a category that is never opened makes no request
(Runner credentials and Export and import read their lists only when
shown).

### 4. Rows

- One shared row part: the name (a `<label>` for a single control, an
  `h4` for a row that groups several controls), the explanation under it
  in `text-xs` slate-600, and the control in a right-hand column — `16rem`
  for fields (selects, inputs), as wide as needed at the row's end for
  buttons. From `sm` down the control stacks under the name, except a
  switch, which stays at the row's end at every width.
- Anything that needs the pane's width — a one-time token, the issued
  subscription link, error notices, the list of issued credentials —
  sits under its row.
- **AI agent:** Default backend (the availability of each backend as its
  explanation), Model, Effort, Max spend (billing backends only), web
  access as a **switch**, then the cost statement, the blocking problems
  and Save at the pane's end. Settings are still saved with Save: the
  draft is validated as a whole (ADR-0029), so the rows do not save one
  by one as ChatGPT's do.
- **Calendar:** Google Calendar (its state in words beside its actions),
  Calendar file (the `.ics` download), Subscription link (its state and
  secrecy note beside Create / Replace / Revoke; the link shown once
  under the row).
- **Language:** Display language.
- **Runner credentials:** New credential (label, days, Issue; the
  one-time token under it), Issued credentials as a list of rows — label
  and status, then created / expires / last used, with Revoke at the
  row's end — instead of a six-column table.
- **Export and import:** Workspace to export (the select with the JSON
  and Markdown downloads), Import workspace file.

### 5. The switch

An on/off setting is a native checkbox with the `switch` role, laid
transparently over a drawn track: it is named by its row's `<label>`,
toggled by click or Space, and read by assistive technology as a switch
with its state. The track is blue (`blue-700`) when on and slate-500 when
off (4.8:1 against white; a control's edge needs 3:1), the knob moves,
and the focus ring is drawn on the track. Web access is the only switch
today.

## Consequences

- One look shows what Settings holds; each category fits a screen.
- Tests that found the AI agent region at `#/settings` keep working; a
  test that wants another category opens its address or its tab.
  The web access control is found by the `switch` role, not `checkbox`.
- The design checker read `ring-offset-2` as a colour family named
  "offset"; it now knows `offset` is a width.
- The Settings surface has its own section in the design guideline
  (section 15), as the Chat surface has (section 12).
- `tests/ui-review/settingsReview.spec.ts` reviews every category at
  three widths and in Japanese, and checks the layout itself (list left
  of the pane from `md` up, controls right of their names from `sm` up,
  icons never squeezed, the switch's focus ring).
