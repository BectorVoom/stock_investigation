# Pages

The SPA is split into four pages by user action (MECE): every action lives on
exactly one page, and every primary journey step has a page. A "chat" and a
"workspace" are the same stored thing (one conversation + one canvas); the UI
says "chat" for a conversation everywhere.

Routes: `#/home` (default), `#/chat` and `#/chat/<workspaceId>`, `#/sources`,
`#/settings`. The old `#/canvas`, `#/canvas/<workspaceId>`,
`#/workspace/<workspaceId>` and `#/workspace` hashes open the Chat page for
that conversation so old bookmarks keep working. `#/settings/agent`
scrolls the AI agent section into view and moves focus to its Default backend
select, so a notice in Chat can link straight to the control that fixes it.
An empty or unknown hash opens Home.

Page layout (frame, panels, headings, shared parts) follows
[docs/DESIGN_GUIDELINE.md](DESIGN_GUIDELINE.md).

## Home — `#/home`

**Purpose**

Check market prices, charts and economic indicators at a glance on widgets you arrange.

**User actions**

- Add a widget.
- Edit a widget (title, series, range, size).
- Move a widget earlier/later.
- Drag a widget to a new position (the header strip is the handle; Move
  earlier/later in the menu is the keyboard and assistive-technology path,
  announced with the position; the page auto-scrolls while the pointer rests
  near the top or bottom edge of the viewport; the pointer engine lives in
  `apps/web/src/home/widgetDrag.ts`).
- Remove a widget.
- Reset to the default arrangement.
- Queue a market-data refresh for the local runner.

Every action is an icon-only button (accessible name and tooltip carry the
former label); the per-widget actions open a text menu with leading icons.

**Shows**

- The arranged widgets (metric, line-chart, stock-table, indicator-table):
  latest values with unit, as-of date, change and source link, or
  "unavailable (reason)" when a series has no usable data. Widgets come in
  three fixed sizes on equal grid cells with a fixed row height — Small
  1 × 1 (17rem, 272 px), Medium 2 × 2 (35rem, 560 px), Large full width × 2
  (35rem, 560 px) — as white cards with a faint
  hairline on the grey page; a body taller than its frame scrolls inside
  the frame. Every widget header is a drag handle (grip, title, actions);
  a completed move is announced with its new position.
- The earnings-calendar widget, when arranged: the upcoming dated announcements
  within its days-ahead window with per-date calendar links, a "Refresh earnings
  dates" button beside the `.ics` download, a "Fetching earnings dates…" status
  while a run is active, "Earnings dates have not been fetched yet." when a stock
  was never looked up ("No announcement in the next N days." only when every
  stock was refreshed), and the count of stocks with no upcoming date with reasons.
- The market-data refresh status: last successful refresh time, the active
  run id and state while refreshing ("pending" polls slowly until the local
  runner claims it), or the last failure with its stable code beside the last
  success; a note that the refresh waits for the local runner when it is
  queued but nothing executes it.
- The FRED attribution line whenever a FRED series is shown.

**Not here**

- Asking questions, reading answers, run progress or evidence records — see Chat
  (`#/chat`). No question form, no run controls and no message list live here.
- Research tables, charts or reports — see Chat (`#/chat`, Canvas panel).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Watchlist — `#/watchlist`

**Purpose**

Register the stocks you follow and keep their earnings announcement dates in your calendar.

**User actions**

- Add a stock (a US listing or a Japanese listing). The add queues an
  earnings-date refresh itself, so the dates arrive without a further click;
  when a refresh is already running, one follow-up is queued when it ends with
  a stock still never refreshed.
- Remove a stock, with confirmation.
- Queue an earnings-date refresh for the local runner (manual button; opening
  the page with dates never fetched or more than a day old queues one refresh,
  once per visit).
- Download the earnings calendar file (.ics).
- Add one announcement date to Google Calendar or Outlook.
- Create, replace or revoke the calendar subscription link.

**Shows**

- The registered stocks: symbol, company name (or "unavailable (not retrieved yet)"),
  market, the next announcement date with fiscal period and timing, further dates in a
  disclosure, "date undecided" stated as text, the retrieved date, the source link, a
  per-row "unavailable (reason)" when there is no date, and a Remove action.
- The earnings-date refresh status: last successful refresh time, the active run id and
  state while refreshing, or the last failure with its stable code beside the last
  success; a note that the refresh waits for the local runner when it is queued but
  nothing executes it. A queued notice ("…are being fetched…", "…was queued") clears
  when the run ends; the status line then tells the outcome.
- The calendar section: the `.ics` download and the subscription link block (created
  date, replace and revoke with confirmation; the link is shown once and is a secret).

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or watching runs — see Chat (`#/chat`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).

## Chat — `#/chat`

**Purpose**

Ask research questions and read the answers, with their sources and run progress.

**User actions**

- Start a new chat with the full-width "New chat" pill button (no title is asked; the server
  names it "New chat" and renames it from its first question).
- Open a past chat from the Chats list.
- Rename a chat from its list row ("More actions" menu) or delete it with
  confirmation.
- Collapse or expand the Chats and Canvas panels with their icon-only
  side-panel buttons; switch Chat/Canvas tabs on narrow screens.
- Load earlier messages.
- Write and submit a question (agent choices are not made here — they are chosen once in Settings → AI agent).
- Watch a run's progress.
- Cancel, retry or approve a run.
- Copy an answer.
- Open the evidence records of a run.
- Select an item inside a canvas component (e.g. a table row).

**Shows**

- Three panels side by side at `lg` and up (Chats, Chat, Canvas as plain
  white rounded blocks on the grey page background with no outlines, each
  with a small header holding the title and an icon-only collapse/expand
  button; Chats and Canvas collapse to narrow rails); a single column below
  `lg` (the Chats history stays a disclosure, and Chat/Canvas tabs show one at
  a time). Chat and Canvas of the open conversation share one session: no
  duplicated polling, and a poll that changes nothing re-renders neither.
- The Chats list (newest activity first): one title-only row per chat; the open
  chat is marked with `aria-current="page"`; every row has a "More actions"
  menu (Rename, Delete); the full-width "New chat" pill button sits at the top.
- The open chat's title (renaming lives in each Chats row's "More actions"
  menu, not in this header); a welcome with the same "New chat" action when
  there are no chats.
- The message thread with numbered citation chips and a source popover, newest
  first paging through "Load earlier messages": owner messages as
  right-aligned bubbles, assistant answers as plain text with "Copy answer"
  and "Evidence" actions, each research run as an inline card directly after
  the owner message whose `runId` matches it (a state badge for every state
  except completed and failed, latest progress, `Stop`, a failure reason,
  `Retry`, the approval form; no "Run details" and no "Evidence" button on
  the card — the records drawer opens from the "Evidence" action under an
  answer; a completed run's card is hidden, since its answer follows), and
  unmatched unfinished or failed runs grouped under "Earlier runs".
- An empty conversation greets ("What would you like to research?") with starter
  suggestions that fill the question input without sending. At `lg` and up the
  greeting, the question form and the suggestions form one vertically centred
  group; below `lg` the form stays pinned to the viewport bottom.
- The question form (question, horizon, markets and the one-time spend consent,
  with a read-only agent summary and no "Limits and cost" disclosure) and the
  evidence records drawer for one run, session notices and load errors.
- The Canvas panel: the stored tables, charts and reports of the open
  conversation in `layout.order` through the registry, always in one column
  (the stored `layout.columns` value is preserved but never switches the
  grid); each component is just its rendered content — no toolbar, id, type
  label or count, and no owner-side move/focus/remove controls (the agent
  arranges the canvas; a component it focuses is marked by a ring);
  cited sources appear as numbered chips opening a source card, with one
  compact `N sources` disclosure per component; a short empty state when
  there are none. A collapsed Canvas panel mounts none of it.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Sources — `#/sources`

**Purpose**

Choose which news sources research may read.

**User actions**

- Preview a feed or site URL (site and feed metadata, safety/licensing check).
- Subscribe to a previewed source with a license policy and trust classification.
- Pause, resume or remove a subscribed source.
- Browse the recommended catalog, preview an entry and subscribe to it.
- Queue a news refresh for the local runner.
- Browse recent articles.

**Shows**

- The source preview, subscribed sources, recommended sources and recent articles.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or watching runs — see Chat (`#/chat`).
- Inspecting produced tables and charts — see Chat (`#/chat`, Canvas panel).
- Runner credentials or export — see Settings (`#/settings`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Settings — `#/settings`

**Purpose**

Configure how the workspace runs: the AI agent, the runner and data export.

**User actions**

- Choose the default AI backend, its model from a list, effort, per-question limits and web access.
- View the session (owner id, sign-in method).
- Issue a runner credential and copy the one-time token; revoke a credential.
- Export a workspace as JSON or Markdown; import a workspace file and open it.

**Shows**

- The AI agent defaults, session, runner credentials (never tokens except once at issue),
  export/import.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or reading answers — see Chat (`#/chat`).
- Produced tables and charts — see Chat (`#/chat`, Canvas panel).
- Subscribing to news — see Sources (`#/sources`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Journeys to pages

| Journey (ARCHITECTURE_AND_REQUIREMENTS.md section 2) | Page |
|---|---|
| 1. Configure sources | Sources |
| 2. Ask a research question | Chat |
| 3. Inspect evidence | Chat (evidence records drawer) |
| 4. Map suppliers | Chat (records and report/table components) |
| 5. Inspect positions and investors | Chat (records and financial components) |
| 6. Manipulate research UI | Chat (Canvas panel: select items; arranging and removing are agent-driven since 2026-10-13) |
| 7. Continue without local compute | Chat (browse chats, queue while offline; browse findings) |
| 8. Check market prices at a glance | Home (arrange widgets, queue a market-data refresh) |
| 9. Track earnings announcement dates | Watchlist (register stocks — each add queues its own earnings-date refresh — export the calendar) and Home (earnings-calendar widget with its own refresh button) |

## How the split was checked

Each user action above appears under exactly one page (exclusive), and every
journey step maps to a page (exhaustive). Dialogs such as the records drawer
and the delete-chat confirmation belong to the page that opens them (Chat);
the widget dialog belongs to Home.
Web tests assert the Chat page shape (three panels with collapse, Canvas not
mounted when collapsed, one shared session, Chat/Canvas tabs below `lg`),
that Home has no composer, message list, run status or canvas region,
the old `#/canvas/<workspaceId>`, `#/canvas`, `#/workspace/<workspaceId>`
and `#/workspace` URLs open the Chat page, that the Watchlist page adds a
stock and shows its refresh status, and
`tests/architecture/pagesDoc.test.ts` fails if this document drifts from
`apps/web/src/pages.ts` (titles, routes, purpose sentences).
